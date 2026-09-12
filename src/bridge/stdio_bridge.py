"""Production Electron-to-Python transport over private framed stdio."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
from typing import Any

from pydantic import ValidationError

from .stdio_transport import read_frame, write_frame
from . import ws_bridge
from ..kernel.contracts import CommandEnvelopeV4, MUTATING_COMMAND_NAMES
from ..kernel.storage import IdempotencyConflict

logger = logging.getLogger("reverie.bridge.stdio")


READY_SCHEMA = "reverie.bridge.stdio.ready.v4"
CONTROL_SCHEMA = "reverie.bridge.stdio.control.v4"
MAX_VALIDATION_ERRORS = 4
MAX_VALIDATION_PART = 120


def _single_line(value: object, limit: int = MAX_VALIDATION_PART) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _validation_diagnostic(error: Exception) -> str:
    """Return bounded metadata only; never include rejected input values."""
    if not isinstance(error, ValidationError):
        return f"{type(error).__name__}:{_single_line(error)}"
    projected: list[str] = []
    for item in error.errors(include_url=False, include_context=False, include_input=False)[
        :MAX_VALIDATION_ERRORS
    ]:
        location = ".".join(_single_line(part, 40) for part in item.get("loc", ()))
        error_type = _single_line(item.get("type", "validation_error"), 60)
        message = _single_line(item.get("msg", "invalid value"))
        projected.append(f"{location or '<root>'}:{error_type}:{message}")
    remainder = max(0, error.error_count() - len(projected))
    if remainder:
        projected.append(f"+{remainder} more")
    return " | ".join(projected)[:600]


class StdioController:
    """WebSocket-shaped endpoint backed by Electron's private stdout pipe."""

    def __init__(self) -> None:
        self._write_lock = asyncio.Lock()
        self.closed = False

    async def send(self, serialized: str) -> None:
        if self.closed:
            raise EOFError("stdio bridge is closed")
        try:
            frame = json.loads(serialized)
        except json.JSONDecodeError as exc:
            raise ValueError("backend emitted invalid JSON") from exc
        if not isinstance(frame, dict):
            raise ValueError("backend frame must be an object")
        await self.write({"kind": "event", "frame": frame})

    async def write(self, payload: dict[str, Any]) -> None:
        async with self._write_lock:
            await asyncio.to_thread(write_frame, sys.stdout.buffer, payload)


def _control_failure(
    request_id: str,
    control_type: str,
    error: Exception,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "kind": "control_result",
        "schema": CONTROL_SCHEMA,
        "requestId": request_id,
        "type": control_type,
        "ok": False,
        "code": str(getattr(error, "code", "") or "REVERIE_CONTROL_REJECTED")[:80],
        "error": "The requested local control operation was rejected",
    }
    retryable = getattr(error, "retryable", None)
    if isinstance(retryable, bool):
        result["retryable"] = retryable
    if control_type == "local_mode:set":
        from src.local_mode import get_local_mode_gate

        snapshot = get_local_mode_gate().snapshot()
        result.update(
            active=snapshot.enabled,
            epoch=snapshot.epoch,
            sessionId=snapshot.session_id or None,
        )
    return result


async def _handle_control(message: dict[str, Any]) -> dict[str, Any]:
    if message.get("schema") != CONTROL_SCHEMA:
        raise ValueError("invalid control schema")
    request_id = str(message.get("requestId") or "")
    control_type = str(message.get("type") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id):
        raise ValueError("invalid requestId")
    allowed_fields = {
        "local_mode:set": {"active", "epoch", "sessionId"},
        "credentials:set": {"credentials"},
        "provider:get": set(),
        "provider:configure": {"llm"},
        "provider:test": {"llm", "credential"},
        "amap:nearby": {"request"},
    }.get(control_type)
    if allowed_fields is None:
        raise ValueError("unsupported control type")
    envelope_fields = {"kind", "schema", "type", "requestId"}
    if set(message) - envelope_fields - allowed_fields:
        raise ValueError("control message has unsupported fields")
    result: dict[str, Any] = {
        "kind": "control_result",
        "schema": CONTROL_SCHEMA,
        "requestId": request_id,
        "type": control_type,
        "ok": True,
    }
    if control_type == "local_mode:set":
        active = message.get("active")
        if not isinstance(active, bool):
            raise ValueError("active must be a boolean")
        epoch = message.get("epoch")
        if not isinstance(epoch, int) or epoch < 0:
            raise ValueError("epoch must be a non-negative integer")
        session_id = str(message.get("sessionId") or "")
        if len(session_id) > 160 or any(ord(char) < 32 for char in session_id):
            raise ValueError("invalid sessionId")
        state = await ws_bridge._apply_local_mode(  # noqa: SLF001
            active,
            epoch=epoch,
            session_id=session_id,
        )
        result.update(
            active=bool(state["enabled"]),
            epoch=int(state["epoch"]),
            sessionId=state.get("session_id") or None,
        )
    elif control_type == "credentials:set":
        credentials = message.get("credentials")
        if (
            not isinstance(credentials, dict)
            or set(credentials) - {"llm"}
        ):
            raise ValueError("credentials payload is invalid")
        result["applied"] = await ws_bridge._apply_runtime_credentials(  # noqa: SLF001
            credentials
        )
    elif control_type == "provider:get":
        result["llm"] = ws_bridge._provider_settings_snapshot()  # noqa: SLF001
    elif control_type == "provider:configure":
        configured = await ws_bridge._configure_runtime_provider(  # noqa: SLF001
            message.get("llm")
        )
        result.update(configured)
    elif control_type == "provider:test":
        tested = await ws_bridge._test_runtime_provider(  # noqa: SLF001
            message.get("llm"),
            message.get("credential"),
        )
        result.update(tested)
    elif control_type == "amap:nearby":
        result.update(await ws_bridge._run_amap_nearby(message.get("request")))  # noqa: SLF001
    return result


async def start_stdio_bridge() -> None:
    """Run until Electron closes stdin or its owner process exits."""
    secret = os.getenv("REVERIE_BRIDGE_SECRET", "").strip()
    if not (
        re.fullmatch(r"[A-Fa-f0-9]{64}", secret)
        or re.fullmatch(r"[A-Za-z0-9_-]{43}", secret)
    ):
        raise RuntimeError("stdio owner secret must encode exactly 32 random bytes")

    controller = StdioController()
    shutdown_event = asyncio.Event()
    persona_scope = ws_bridge._active_persona_scope()  # noqa: SLF001
    from src.local_mode import get_local_mode_gate

    gate_snapshot = get_local_mode_gate().snapshot()
    ready = {
        "kind": "ready",
        "schema": READY_SCHEMA,
        "transport": "stdio-framed",
        "pid": os.getpid(),
        "secretSha256": hashlib.sha256(secret.encode("utf-8")).hexdigest(),
        "protocolVersion": 4,
        "localModeEpoch": gate_snapshot.epoch,
        "localModeSessionId": gate_snapshot.session_id or None,
        "personaId": persona_scope["persona_id"],
        "personaEpoch": persona_scope["persona_epoch"],
        "personaFingerprint": persona_scope["persona_fingerprint"],
        "runtimeDegraded": bool(ws_bridge.bridge_state.runtime_unavailable),
        "runtimeUnavailable": list(ws_bridge.bridge_state.runtime_unavailable),
        "modelEpoch": int(getattr(ws_bridge.bridge_state, "model_epoch", 0) or 0),
        "personaRestartRequired": bool(ws_bridge.bridge_state.persona_restart_required),
    }
    await controller.write(ready)

    context = ws_bridge.BridgeClientContext(
        client_id=f"electron_stdio_{os.getpid()}",
        # The renderer receives a compatibility event projection, while every
        # production command is a strict V4 envelope with a host-owned proof.
        protocol_version=4,
        authenticated=True,
        conversation_id="dream-room",
        persona_id=str(persona_scope["persona_id"]),
    )
    ws_bridge._connections.add(controller)  # noqa: SLF001
    ws_bridge._client_contexts[controller] = context  # noqa: SLF001
    ws_bridge._controller_ws = controller  # noqa: SLF001

    parent_task = asyncio.create_task(ws_bridge._parent_watch_loop(shutdown_event))  # noqa: SLF001
    activity_task = asyncio.create_task(ws_bridge._runtime_activity_loop())  # noqa: SLF001
    proactive_task = asyncio.create_task(ws_bridge._proactive_broadcast_loop())  # noqa: SLF001
    try:
        await ws_bridge.send_to_frontend(
            controller,
            ws_bridge.MsgType.RUNTIME_ACTIVITY,
            ws_bridge._runtime_activity_payload(),  # noqa: SLF001
        )
        if ws_bridge.bridge_state.session is not None:
            await ws_bridge._get_chat_coordinator().resume(  # noqa: SLF001
                client_id=context.client_id,
                conversation_id=context.conversation_id,
                persona_id=context.persona_id,
            )
        while not shutdown_event.is_set():
            try:
                message = await asyncio.to_thread(read_frame, sys.stdin.buffer)
            except EOFError:
                break
            except Exception as exc:
                del exc
                await controller.write(
                    {
                        "kind": "fatal_error",
                        "code": "REVERIE_STDIO_FRAME_INVALID",
                        "error": "The private bridge received an invalid frame",
                    }
                )
                break
            if message is None:
                break
            kind = message.get("kind")
            if kind == "renderer_command":
                try:
                    if message.get("schema") != "reverie.command.v4":
                        raise ValueError("invalid command envelope schema")
                    envelope = CommandEnvelopeV4.model_validate(message.get("envelope"))
                except Exception as exc:
                    logger.warning(
                        "Renderer command rejected: %s",
                        _validation_diagnostic(exc),
                    )
                    await controller.write(
                        {
                            "kind": "fatal_error",
                            "code": "REVERIE_COMMAND_REJECTED",
                            "error": "The private bridge rejected an invalid command",
                        }
                    )
                    break
                scoped_payload = dict(envelope.payload)
                # The V4 persona proof is authoritative over any values the
                # renderer attempted to place in its compatibility payload.
                scoped_payload.update(
                    expected_persona_id=envelope.persona.persona_id,
                    expected_persona_epoch=envelope.persona.epoch,
                    expected_persona_fingerprint=envelope.persona.fingerprint,
                )
                store = ws_bridge.bridge_state.kernel_store
                if envelope.command in MUTATING_COMMAND_NAMES and store is not None:
                    try:
                        existing = store.begin_command(envelope)
                    except IdempotencyConflict:
                        await ws_bridge.send_to_frontend(
                            controller,
                            ws_bridge.MsgType.ERROR,
                            {
                                "message": "Duplicate command identity was rejected",
                                "code": "idempotency_conflict",
                            },
                            request_id=envelope.request_id,
                        )
                        continue
                    if existing.state == "committed":
                        await ws_bridge.send_to_frontend(
                            controller,
                            ws_bridge.response_type_for_request(envelope.command),
                            existing.result,
                            request_id=envelope.request_id,
                        )
                        continue
                    if existing.state in {"failed", "outcome_unknown"}:
                        await ws_bridge.send_to_frontend(
                            controller,
                            ws_bridge.MsgType.ERROR,
                            {
                                "message": "The previous command did not complete safely",
                                "code": "command_terminal",
                            },
                            request_id=envelope.request_id,
                        )
                        continue
                is_mutating = (
                    envelope.command in MUTATING_COMMAND_NAMES
                    and store is not None
                )
                result = await ws_bridge.dispatch_authenticated_message(
                    {
                        "type": envelope.command,
                        "payload": scoped_payload,
                        "request_id": envelope.request_id,
                    },
                    controller,
                    emit_result=not is_mutating,
                )
                if is_mutating and result is not None:
                    try:
                        committed = store.commit_command_result(envelope, result)
                    except Exception:
                        try:
                            store.fail_command(
                                envelope.request_id,
                                error_code="TRANSPORT_COMMIT_FAILED",
                            )
                        except Exception:
                            pass
                        await ws_bridge.send_to_frontend(
                            controller,
                            ws_bridge.MsgType.ERROR,
                            {
                                "message": "The command result could not be committed safely",
                                "code": "storage_unavailable",
                            },
                            request_id=envelope.request_id,
                        )
                    else:
                        await ws_bridge.send_to_frontend(
                            controller,
                            ws_bridge.response_type_for_request(envelope.command),
                            committed.result,
                            request_id=envelope.request_id,
                        )
                continue
            if kind == "control":
                request_id = str(message.get("requestId") or "")
                control_type = str(message.get("type") or "")
                try:
                    response = await _handle_control(message)
                except Exception as exc:
                    response = _control_failure(request_id, control_type, exc)
                await controller.write(response)
                continue
            await controller.write(
                {
                    "kind": "fatal_error",
                    "code": "REVERIE_STDIO_MESSAGE_INVALID",
                    "error": "unsupported stdio message kind",
                }
            )
            break
    finally:
        controller.closed = True
        shutdown_event.set()
        parent_task.cancel()
        activity_task.cancel()
        proactive_task.cancel()
        await asyncio.gather(
            parent_task,
            activity_task,
            proactive_task,
            return_exceptions=True,
        )
        ws_bridge._connections.discard(controller)  # noqa: SLF001
        ws_bridge._client_contexts.pop(controller, None)  # noqa: SLF001
        if ws_bridge._controller_ws is controller:  # noqa: SLF001
            ws_bridge._controller_ws = None  # noqa: SLF001
        if ws_bridge._chat_coordinator is not None:  # noqa: SLF001
            await ws_bridge._chat_coordinator.shutdown()  # noqa: SLF001
