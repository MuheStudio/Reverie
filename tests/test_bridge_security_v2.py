from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os

import pytest
import websockets

from src.bridge import ws_bridge
from src.config import usage_policy
from src.local_mode import LocalModeGate


class CoordinatorStub:
    def __init__(self) -> None:
        self.resumes: list[dict] = []

    async def resume(self, **scope) -> None:
        self.resumes.append(scope)


class CapturingEndpoint:
    def __init__(self) -> None:
        self.frames: list[dict] = []

    async def send(self, serialized: str) -> None:
        self.frames.append(json.loads(serialized))


def auth(secret: str, *, client_id: str = "desktop_controller_01") -> str:
    return json.dumps(
        {
            "type": "bridge:auth",
            "payload": {
                "secret": secret,
                "client_id": client_id,
                "protocolVersion": 4,
                "conversation_id": "conversation_a",
                "persona_id": "default",
            },
        }
    )


@pytest.mark.asyncio
async def test_bridge_rejects_business_frame_before_authentication(monkeypatch) -> None:
    secret = "A" * 43
    monkeypatch.setattr(ws_bridge, "_bridge_secret_value", secret)
    stub = CoordinatorStub()
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: stub)
    async with websockets.serve(
        ws_bridge.websocket_handler,
        "127.0.0.1",
        0,
        origins=ws_bridge._allowed_bridge_origins(),
        compression=None,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        async with websockets.connect(
            f"ws://127.0.0.1:{port}",
            origin="reverie-desktop",
        ) as client:
            await client.send(json.dumps({"type": "chat:send", "payload": {"text": "付费请求"}}))
            with pytest.raises(websockets.ConnectionClosed) as closed:
                await client.recv()
            assert closed.value.code == 4401
    assert stub.resumes == []


@pytest.mark.asyncio
async def test_bridge_authenticates_one_controller_and_rejects_second(monkeypatch) -> None:
    secret = "B" * 43
    monkeypatch.setattr(ws_bridge, "_bridge_secret_value", secret)
    stub = CoordinatorStub()
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: stub)
    ws_bridge._connections.clear()
    ws_bridge._client_contexts.clear()
    monkeypatch.setattr(ws_bridge, "_controller_ws", None)
    async with websockets.serve(
        ws_bridge.websocket_handler,
        "127.0.0.1",
        0,
        origins=ws_bridge._allowed_bridge_origins(),
        compression=None,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        first = await websockets.connect(f"ws://127.0.0.1:{port}", origin="reverie-desktop")
        await first.send(auth(secret))
        auth_ok = json.loads(await first.recv())
        assert auth_ok["type"] == "bridge:auth_ok"
        assert auth_ok["payload"]["protocol_version"] == 4
        runtime = json.loads(await first.recv())
        assert runtime["type"] == ws_bridge.MsgType.RUNTIME_ACTIVITY

        second = await websockets.connect(f"ws://127.0.0.1:{port}", origin="reverie-desktop")
        await second.send(auth(secret, client_id="desktop_controller_02"))
        with pytest.raises(websockets.ConnectionClosed) as closed:
            await second.recv()
        assert closed.value.code == 4009
        await second.close()
        await first.close()
    # Authentication must not revive or redispatch any old paid operation when
    # no active backend session exists.
    assert stub.resumes == []


@pytest.mark.asyncio
async def test_direct_response_echoes_only_its_valid_request_id(monkeypatch) -> None:
    secret = "R" * 43
    monkeypatch.setattr(ws_bridge, "_bridge_secret_value", secret)
    stub = CoordinatorStub()
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: stub)
    ws_bridge._connections.clear()
    ws_bridge._client_contexts.clear()
    monkeypatch.setattr(ws_bridge, "_controller_ws", None)
    monkeypatch.setattr(
        ws_bridge,
        "_active_persona_scope",
        lambda: {
            "persona_id": "persona_test",
            "persona_epoch": 1,
            "persona_fingerprint": "a" * 64,
        },
    )

    async def echo(_payload, _ws):
        return {"value": "alpha"}

    monkeypatch.setitem(ws_bridge._handlers, ws_bridge.MsgType.EMOTION_GET, echo)
    async with websockets.serve(
        ws_bridge.websocket_handler,
        "127.0.0.1",
        0,
        origins=ws_bridge._allowed_bridge_origins(),
        compression=None,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        async with websockets.connect(
            f"ws://127.0.0.1:{port}",
            origin="reverie-desktop",
        ) as client:
            await client.send(auth(secret))
            assert json.loads(await client.recv())["type"] == "bridge:auth_ok"
            assert json.loads(await client.recv())["type"] == ws_bridge.MsgType.RUNTIME_ACTIVITY

            await client.send(json.dumps({
                "type": ws_bridge.MsgType.EMOTION_GET,
                "request_id": "request_alpha_01",
                "payload": {},
            }))
            response = json.loads(await client.recv())
            assert response == {
                "type": ws_bridge.MsgType.EMOTION_UPDATE,
                "request_id": "request_alpha_01",
                "payload": {"value": "alpha"},
            }

            await client.send(json.dumps({
                "type": ws_bridge.MsgType.EMOTION_GET,
                "request_id": "../invalid",
                "payload": {},
            }))
            error = json.loads(await client.recv())
            assert error["type"] == ws_bridge.MsgType.ERROR
            assert "request_id" not in error
            assert error["payload"]["message"] == "The command was rejected"


@pytest.mark.asyncio
async def test_production_dispatch_rejects_stale_persona_before_module_handler(
    monkeypatch,
) -> None:
    endpoint = CapturingEndpoint()
    context = ws_bridge.BridgeClientContext(
        client_id="electron_stdio_test",
        protocol_version=4,
        authenticated=True,
    )
    monkeypatch.setitem(ws_bridge._client_contexts, endpoint, context)
    monkeypatch.setattr(
        ws_bridge,
        "_active_persona_scope",
        lambda: {
            "persona_id": "persona-current",
            "persona_epoch": 9,
            "persona_fingerprint": "a" * 64,
        },
    )
    called = 0

    async def game_get(_payload, _endpoint):
        nonlocal called
        called += 1
        return {"ok": True}

    monkeypatch.setitem(ws_bridge._handlers, ws_bridge.MsgType.GAME_STATE_GET, game_get)
    await ws_bridge.dispatch_authenticated_message(
        {
            "type": ws_bridge.MsgType.GAME_STATE_GET,
            "request_id": "request_scope_01",
            "payload": {
                "game_id": "gomoku",
                "expected_persona_id": "persona-old",
                "expected_persona_epoch": 8,
                "expected_persona_fingerprint": "b" * 64,
            },
        },
        endpoint,
    )
    assert called == 0
    assert endpoint.frames[-1]["payload"]["code"] == "stale_persona"

    await ws_bridge.dispatch_authenticated_message(
        {
            "type": ws_bridge.MsgType.GAME_STATE_GET,
            "request_id": "request_scope_02",
            "payload": {
                "game_id": "gomoku",
                "expected_persona_id": "persona-current",
                "expected_persona_epoch": 9,
                "expected_persona_fingerprint": "a" * 64,
            },
        },
        endpoint,
    )
    assert called == 1
    assert endpoint.frames[-1]["payload"]["ok"] is True


@pytest.mark.asyncio
async def test_bridge_origin_allowlist_rejects_web_page(monkeypatch) -> None:
    monkeypatch.setattr(ws_bridge, "_bridge_secret_value", "C" * 43)
    async with websockets.serve(
        ws_bridge.websocket_handler,
        "127.0.0.1",
        0,
        origins=ws_bridge._allowed_bridge_origins(),
        compression=None,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        with pytest.raises(websockets.InvalidStatus):
            await websockets.connect(f"ws://127.0.0.1:{port}", origin="https://attacker.example")


def test_bridge_origin_allowlist_drops_legacy_file_and_null_origins() -> None:
    origins = ws_bridge._allowed_bridge_origins()
    assert "file://" not in origins
    assert "null" not in origins
    assert "reverie-app://app" in origins
    assert "reverie-desktop" in origins
    assert "http://localhost:5173" in origins
    assert "http://127.0.0.1:5173" in origins
    # Originless connections stay gated behind the explicit opt-in flag.
    assert None not in origins


@pytest.mark.asyncio
async def test_bridge_origin_allowlist_rejects_null_and_file_origins(monkeypatch) -> None:
    monkeypatch.setattr(ws_bridge, "_bridge_secret_value", "C" * 43)
    async with websockets.serve(
        ws_bridge.websocket_handler,
        "127.0.0.1",
        0,
        origins=ws_bridge._allowed_bridge_origins(),
        compression=None,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        for forged in ("null", "file://"):
            with pytest.raises(websockets.InvalidStatus):
                await websockets.connect(f"ws://127.0.0.1:{port}", origin=forged)


def test_local_mode_epoch_replay_is_idempotent_and_stale_update_is_rejected() -> None:
    gate = LocalModeGate(desktop=True)
    first = gate.set(True, session_id="focus-a", epoch=7)
    replay = gate.set(True, session_id="focus-a", epoch=7)
    assert first == replay
    with pytest.raises(ValueError, match="stale"):
        gate.set(False, session_id="", epoch=6)
    with pytest.raises(ValueError, match="conflicting"):
        gate.set(False, session_id="", epoch=7)
    assert gate.snapshot().enabled is True


def test_chat_scope_never_treats_missing_identity_or_model_fields_as_wildcards(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        ws_bridge,
        "_active_persona_scope",
        lambda: {
            "persona_id": "persona-a",
            "persona_epoch": 7,
            "persona_fingerprint": "persona-fingerprint-a",
        },
    )
    monkeypatch.setattr(ws_bridge, "_model_fingerprint", lambda: "model-fingerprint-a")
    monkeypatch.setattr(ws_bridge.bridge_state, "model_epoch", 3)
    valid = {
        "persona_id": "persona-a",
        "persona_epoch": 7,
        "persona_fingerprint": "persona-fingerprint-a",
        "model_epoch": 3,
        "model_fingerprint": "model-fingerprint-a",
    }

    assert ws_bridge._chat_scope_is_current(valid) is True
    for field in valid:
        incomplete = dict(valid)
        incomplete.pop(field)
        assert ws_bridge._chat_scope_is_current(incomplete) is False


@pytest.mark.asyncio
async def test_private_stdin_control_emits_correlated_ack(monkeypatch, capsys) -> None:
    command = {
        "schema": "reverie.bridge.control.v1",
        "type": "local_mode:set",
        "requestId": "control_request_01",
        "active": True,
        "epoch": 9,
        "sessionId": "focus-session-a",
    }
    monkeypatch.setattr(ws_bridge.sys, "stdin", io.StringIO(json.dumps(command) + "\n"))

    async def apply(active: bool, *, epoch: int, session_id: str) -> dict:
        return {
            "ok": True,
            "enabled": active,
            "epoch": epoch,
            "session_id": session_id,
        }

    monkeypatch.setattr(ws_bridge, "_apply_local_mode", apply)
    await ws_bridge._bridge_control_loop()
    output = capsys.readouterr().out.strip()
    assert output.startswith("REVERIE_BRIDGE_CONTROL ")
    ack = json.loads(output.removeprefix("REVERIE_BRIDGE_CONTROL "))
    assert ack == {
        "schema": "reverie.bridge.control.ack.v1",
        "requestId": "control_request_01",
        "active": True,
        "epoch": 9,
        "sessionId": "focus-session-a",
        "ok": True,
    }


@pytest.mark.asyncio
async def test_bridge_ready_line_matches_electron_contract(monkeypatch, capsys) -> None:
    secret = "D" * 43
    monkeypatch.setenv("REVERIE_BRIDGE_SECRET", secret)
    monkeypatch.setattr(ws_bridge.sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(ws_bridge, "_chat_coordinator", None)

    task = asyncio.create_task(ws_bridge.start_bridge(host="127.0.0.1", port=0))
    await asyncio.sleep(0.08)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("REVERIE_BRIDGE_READY ")]
    assert len(lines) == 1
    ready = json.loads(lines[0].removeprefix("REVERIE_BRIDGE_READY "))
    assert ready["schema"] == "reverie.bridge.ready.v1"
    assert ready["host"] == "127.0.0.1"
    assert 0 < ready["port"] <= 65535
    assert ready["secretSha256"] == hashlib.sha256(secret.encode()).hexdigest()
    assert ready["protocolVersion"] == 4


@pytest.mark.asyncio
async def test_bridge_refuses_non_loopback_listener(monkeypatch) -> None:
    monkeypatch.setenv("REVERIE_BRIDGE_SECRET", "E" * 43)
    with pytest.raises(RuntimeError, match="loopback"):
        await ws_bridge.start_bridge(host="0.0.0.0", port=0)


def test_parent_liveness_probe_handles_current_and_missing_processes() -> None:
    assert ws_bridge._parent_process_is_alive(os.getpid()) is True
    assert ws_bridge._parent_process_is_alive(2_147_483_647) is False


@pytest.mark.asyncio
async def test_parent_watch_requests_shutdown_when_electron_owner_dies(monkeypatch) -> None:
    monkeypatch.setenv("REVERIE_PARENT_PID", "424242")
    monkeypatch.setattr(ws_bridge, "_parent_process_is_alive", lambda _pid: False)
    shutdown = asyncio.Event()
    await ws_bridge._parent_watch_loop(shutdown)
    assert shutdown.is_set()


@pytest.mark.asyncio
async def test_desktop_control_pipe_eof_requests_shutdown(monkeypatch) -> None:
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(ws_bridge.sys, "stdin", io.StringIO(""))
    shutdown = asyncio.Event()
    await ws_bridge._bridge_control_loop(shutdown)
    assert shutdown.is_set()


@pytest.mark.asyncio
async def test_ai_usage_grant_requires_current_disclosure_and_explicit_cost_ack(monkeypatch) -> None:
    class PolicyStub:
        def __init__(self) -> None:
            self.granted: list[str] = []

        def snapshot(self) -> dict:
            return {
                feature: {
                    "enabled": feature in self.granted,
                    "api_cost_acknowledged": feature in self.granted,
                    "effective": feature in self.granted,
                    "description": description,
                }
                for feature, description in usage_policy.FEATURE_DESCRIPTIONS.items()
            }

        def grant(self, feature: str) -> None:
            self.granted.append(feature)

        def revoke(self, feature: str) -> int:
            self.granted = [value for value in self.granted if value != feature]
            return 1

    policy = PolicyStub()
    monkeypatch.setattr(usage_policy, "get_usage_policy", lambda: policy)
    ws = object()
    context = ws_bridge.BridgeClientContext("desktop_policy", 2, authenticated=True)
    monkeypatch.setitem(ws_bridge._client_contexts, ws, context)
    monkeypatch.setattr(ws_bridge, "_controller_ws", ws)
    snapshot = await ws_bridge.handle_ai_usage_get({}, ws)
    item = snapshot["features"]["semantic_verification"]

    with pytest.raises(ValueError, match="acknowledgement"):
        await ws_bridge.handle_ai_usage_grant(
            {
                "feature": "semantic_verification",
                "consent_digest": item["consent_digest"],
            },
            ws,
        )
    with pytest.raises(ValueError, match="disclosure"):
        await ws_bridge.handle_ai_usage_grant(
            {
                "feature": "semantic_verification",
                "consent_digest": "0" * 64,
                "api_cost_acknowledged": True,
                "user_confirmed": True,
            },
            ws,
        )

    granted = await ws_bridge.handle_ai_usage_grant(
        {
            "feature": "semantic_verification",
            "consent_digest": item["consent_digest"],
            "api_cost_acknowledged": True,
            "user_confirmed": True,
        },
        ws,
    )
    assert granted["features"]["semantic_verification"]["enabled"] is True
    revoked = await ws_bridge.handle_ai_usage_revoke(
        {"feature": "semantic_verification"},
        ws,
    )
    assert revoked["features"]["semantic_verification"]["enabled"] is False
    assert revoked["cancelled_in_flight"] == 1
