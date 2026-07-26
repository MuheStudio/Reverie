"""Production Electron-to-Python transport over private framed stdio."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
from typing import Any

from .stdio_transport import read_frame, write_frame
from . import ws_bridge
from ..kernel.contracts import CommandEnvelopeV3


READY_SCHEMA = "reverie.bridge.stdio.ready.v3"
CONTROL_SCHEMA = "reverie.bridge.stdio.control.v3"


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
        "error": str(error)[:240],
    }
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
        result["applied"] = await ws_bridge._apply_runtime_credentials(  # noqa: SLF001
            message.get("credentials")
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
    elif control_type in {"backup:file:export", "backup:file:import"}:
        operation = "export" if control_type.endswith(":export") else "import"
        result.update(
            await ws_bridge._run_native_backup(  # noqa: SLF001
                operation,
                message.get("path"),
            )
        )
    elif control_type == "sticker:file:import":
        if os.getenv("REVERIE_BRIDGE_MODE", "").strip() != "1":
            raise PermissionError("native sticker import requires the Electron owner")
        manager = ws_bridge.bridge_state.stickers
        if manager is None:
            raise RuntimeError("sticker module is unavailable")
        raw_path = message.get("path")
        if not isinstance(raw_path, str) or not raw_path or len(raw_path) > 32_767:
            raise ValueError("sticker path is invalid")
        metadata = message.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise ValueError("sticker metadata is invalid")
        item = await asyncio.to_thread(
            manager.collect_from_file,
            raw_path,
            text=str(metadata.get("text") or "")[:120],
            emotions=metadata.get("emotions")
            if isinstance(metadata.get("emotions"), list)
            else None,
            style_tags=metadata.get("styleTags")
            if isinstance(metadata.get("styleTags"), list)
            else None,
        )
        result.update(
            item=item.to_dict(),
            items=[entry.to_dict() for entry in manager.list_items(100)],
        )
    else:
        raise ValueError("unsupported control type")
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
        "protocolVersion": 3,
        "localModeEpoch": gate_snapshot.epoch,
        "localModeSessionId": gate_snapshot.session_id or None,
        "personaId": persona_scope["persona_id"],
        "personaEpoch": persona_scope["persona_epoch"],
        "personaFingerprint": persona_scope["persona_fingerprint"],
        "runtimeDegraded": bool(ws_bridge.bridge_state.runtime_unavailable),
        "runtimeUnavailable": list(ws_bridge.bridge_state.runtime_unavailable),
    }
    await controller.write(ready)

    context = ws_bridge.BridgeClientContext(
        client_id=f"electron_stdio_{os.getpid()}",
        # The renderer still speaks through the temporary V2 projection, but
        # production commands are V3-scoped and must carry a current persona
        # proof before the compatibility dispatcher may invoke a handler.
        protocol_version=3,
        authenticated=True,
        conversation_id="dream-room",
        persona_id=str(persona_scope["persona_id"]),
    )
    ws_bridge._connections.add(controller)  # noqa: SLF001
    ws_bridge._client_contexts[controller] = context  # noqa: SLF001
    ws_bridge._controller_ws = controller  # noqa: SLF001

    proactive_task = asyncio.create_task(ws_bridge._proactive_broadcast_loop())  # noqa: SLF001
    activity_task = asyncio.create_task(ws_bridge._runtime_activity_loop())  # noqa: SLF001
    parent_task = asyncio.create_task(ws_bridge._parent_watch_loop(shutdown_event))  # noqa: SLF001
    if ws_bridge.bridge_state.session is not None:
        await ws_bridge._get_chat_coordinator().resume(  # noqa: SLF001
            client_id=context.client_id,
            conversation_id=context.conversation_id,
            persona_id=context.persona_id,
        )
    try:
        while not shutdown_event.is_set():
            try:
                message = await asyncio.to_thread(read_frame, sys.stdin.buffer)
            except EOFError:
                break
            except Exception as exc:
                await controller.write(
                    {
                        "kind": "fatal_error",
                        "code": "REVERIE_STDIO_FRAME_INVALID",
                        "error": str(exc)[:240],
                    }
                )
                break
            if message is None:
                break
            kind = message.get("kind")
            if kind == "renderer_command":
                if message.get("schema") != "reverie.command.v3":
                    raise ValueError("invalid command envelope schema")
                envelope = CommandEnvelopeV3.model_validate(message.get("envelope"))
                scoped_payload = dict(envelope.payload)
                # The V3 persona proof is authoritative over any values the
                # renderer attempted to place in its compatibility payload.
                scoped_payload.update(
                    expected_persona_id=envelope.persona.persona_id,
                    expected_persona_epoch=envelope.persona.epoch,
                    expected_persona_fingerprint=envelope.persona.fingerprint,
                )
                await ws_bridge.dispatch_authenticated_message(
                    {
                        "type": envelope.command,
                        "payload": scoped_payload,
                        "request_id": envelope.request_id,
                    },
                    controller,
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
        proactive_task.cancel()
        activity_task.cancel()
        parent_task.cancel()
        await asyncio.gather(
            proactive_task,
            activity_task,
            parent_task,
            return_exceptions=True,
        )
        ws_bridge._connections.discard(controller)  # noqa: SLF001
        ws_bridge._client_contexts.pop(controller, None)  # noqa: SLF001
        if ws_bridge._controller_ws is controller:  # noqa: SLF001
            ws_bridge._controller_ws = None  # noqa: SLF001
        if ws_bridge._chat_coordinator is not None:  # noqa: SLF001
            await ws_bridge._chat_coordinator.shutdown()  # noqa: SLF001
