"""Controller, epoch, recovery and command ledger boundaries for batch pinning."""

from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.kernel.command_bus import CommandBus
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
from src.kernel.storage import KernelStore


COMMANDS = [pytest.param("memory:pin_status", id="status"), pytest.param("memory:pin_many", id="many")]


class Controller:
    def __init__(self):
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))


class RecordingMemory:
    def __init__(self):
        self.calls = []
        self.result = None
        self.error = None

    def pin_status(self, memory_ids):
        self.calls.append(("status", list(memory_ids)))
        if self.error is not None:
            raise self.error
        return self.result if self.result is not None else {
            "ok": True, "memory_ids": list(memory_ids),
            "states": [{"memory_id": memory_id, "pinned": False} for memory_id in memory_ids],
            "stale_ids": [], "pinned_total": 0, "pin_limit": 20,
        }

    def pin_confirmed_memories(self, memory_ids, pinned):
        self.calls.append(("write", list(memory_ids), pinned))
        if self.error is not None:
            raise self.error
        return self.result if self.result is not None else {
            "ok": True, "memory_ids": list(memory_ids), "pinned": pinned,
            "changed_ids": list(memory_ids) if pinned else [],
            "unchanged_ids": [] if pinned else list(memory_ids),
            "pinned_total_before": 0, "pinned_total_after": len(memory_ids) if pinned else 0,
            "pin_limit": 20,
        }


@pytest.fixture
def bridge(monkeypatch):
    state = ws_bridge.BridgeState()
    state.memory = RecordingMemory()
    controller = Controller()
    active = {"persona_id": "pin_persona", "persona_epoch": 4, "persona_fingerprint": "a" * 64}
    context = ws_bridge.BridgeClientContext(
        client_id="batch_pin_controller", protocol_version=4, authenticated=True,
        persona_id=active["persona_id"],
    )
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_controller_ws", controller)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {controller: context})
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(active))
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())
    return state, controller, active


def payload(command, active, **changes):
    return {
        "memory_ids": ["fact_2", "fact_1"],
        **({"pinned": True} if command == "memory:pin_many" else {}),
        "expected_persona_id": active["persona_id"],
        "expected_persona_epoch": active["persona_epoch"],
        "expected_persona_fingerprint": active["persona_fingerprint"],
        **changes,
    }


def message(command, active, **changes):
    return {"type": command, "request_id": "batch_pin_request_01",
            "payload": payload(command, active, **changes)}


def direct_handler(command):
    return (ws_bridge.handle_memory_pin_status if command == "memory:pin_status"
            else ws_bridge.handle_memory_pin_many)


def command_envelope(command, active):
    return CommandEnvelopeV4(
        command=command, request_id="batch_pin_request_01", idempotency_key="batch_pin_request_01",
        persona=PersonaScopeV4(persona_id=active["persona_id"], epoch=active["persona_epoch"],
                               fingerprint=active["persona_fingerprint"]),
        payload={"memory_ids": ["fact_2", "fact_1"],
                 **({"pinned": True} if command == "memory:pin_many" else {})},
    )


@pytest.mark.parametrize("command", COMMANDS)
@pytest.mark.parametrize("authenticated,same_controller", [(False, True), (False, False), (True, False)],
                         ids=["unauth-controller", "unauth-observer", "auth-observer"])
def test_both_commands_require_the_authenticated_controller(bridge, command, authenticated, same_controller):
    state, controller, active = bridge
    endpoint = controller if same_controller else Controller()
    ws_bridge._client_contexts[endpoint] = ws_bridge.BridgeClientContext(
        client_id="batch_pin_observer", protocol_version=4, authenticated=authenticated,
    )
    with pytest.raises(PermissionError, match="authenticated controller required"):
        asyncio.run(direct_handler(command)(payload(command, active), endpoint))
    assert state.memory.calls == []


@pytest.mark.parametrize("command", COMMANDS)
@pytest.mark.parametrize("selected", [[], [f"fact_{n}" for n in range(101)], ["fact_1", "fact_1"],
                                      ["bad id"], [True], [123], [b"fact_1"], None, ("fact_1",)],
                         ids=["empty", "over-100", "duplicate", "space", "bool-id", "int-id",
                              "bytes-id", "null-selection", "tuple-selection"])
def test_direct_handlers_revalidate_selection_before_memory_access(bridge, command, selected):
    state, controller, active = bridge
    with pytest.raises(ValidationError):
        asyncio.run(direct_handler(command)(payload(command, active, memory_ids=selected), controller))
    assert state.memory.calls == []


@pytest.mark.parametrize("pinned", [None, 0, 1, 1.0, "true", "false", [], {}],
                         ids=["null", "zero", "one", "float-one", "string-true", "string-false", "list", "object"])
def test_direct_write_handler_requires_strict_boolean(bridge, pinned):
    state, controller, active = bridge
    with pytest.raises(ValidationError):
        asyncio.run(ws_bridge.handle_memory_pin_many(payload("memory:pin_many", active, pinned=pinned), controller))
    assert state.memory.calls == []


@pytest.mark.parametrize("command", COMMANDS)
def test_direct_handlers_forbid_unexpected_fields(bridge, command):
    state, controller, active = bridge
    with pytest.raises(ValidationError):
        asyncio.run(direct_handler(command)(payload(command, active, confirm=True), controller))
    assert state.memory.calls == []


@pytest.mark.parametrize("command", COMMANDS)
@pytest.mark.parametrize("recovery_state", ["recovering", "recovery_required"], ids=["recovering", "recovery-required"])
def test_recovery_allows_preview_and_blocks_mutation(bridge, command, recovery_state):
    state, controller, active = bridge
    state.recovery_state = recovery_state
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active), controller))
    if command == "memory:pin_status":
        assert result["ok"] is True
        assert state.memory.calls == [("status", ["fact_2", "fact_1"])]
        assert command in ws_bridge._RECOVERY_READ_COMMANDS
    else:
        assert result["ok"] is False and result["code"] == "BACKUP_RECOVERY_REQUIRED"
        assert state.memory.calls == []
        assert command not in ws_bridge._RECOVERY_READ_COMMANDS
    assert controller.sent[0]["type"] == "memory:result"


@pytest.mark.parametrize("recovery_state", ["recovering", "recovery_required"], ids=["recovering", "recovery-required"])
def test_direct_write_handler_keeps_recovery_guard(bridge, recovery_state):
    state, controller, active = bridge
    state.recovery_state = recovery_state
    result = asyncio.run(ws_bridge.handle_memory_pin_many(payload("memory:pin_many", active), controller))
    assert result["ok"] is False and result["code"] == "BACKUP_RECOVERY_REQUIRED"
    assert state.memory.calls == []


@pytest.mark.parametrize("command", COMMANDS)
@pytest.mark.parametrize("proof_change", [
    {"expected_persona_id": "other_persona"}, {"expected_persona_epoch": 3},
    {"expected_persona_fingerprint": "b" * 64}, {"expected_persona_id": ""},
], ids=["persona-id", "epoch", "fingerprint", "missing-id"])
def test_dispatch_rejects_stale_persona_proof(bridge, command, proof_change):
    state, controller, active = bridge
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active, **proof_change), controller))
    assert result["ok"] is False and result["code"] == "stale_persona"
    assert state.memory.calls == []
    assert command in ws_bridge._PERSONA_SCOPED_COMMANDS


@pytest.mark.parametrize("command", COMMANDS)
def test_dispatch_rechecks_persona_after_waiting_for_effect_lock(bridge, command, monkeypatch):
    state, controller, active = bridge

    class SwitchWhileWaiting:
        async def __aenter__(self):
            active["persona_epoch"] += 1

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", SwitchWhileWaiting())
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active), controller))
    assert result["ok"] is False and result["code"] == "stale_persona"
    assert state.memory.calls == []


def test_write_rechecks_recovery_after_waiting_for_effect_lock(bridge, monkeypatch):
    state, controller, active = bridge

    class RecoveryWhileWaiting:
        async def __aenter__(self):
            state.recovery_state = "recovery_required"

        async def __aexit__(self, *_args):
            return False

    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", RecoveryWhileWaiting())
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message("memory:pin_many", active), controller))
    assert result["code"] == "BACKUP_RECOVERY_REQUIRED"
    assert state.memory.calls == []


@pytest.mark.parametrize("command", COMMANDS)
@pytest.mark.parametrize("gate", ["restart", "degraded"], ids=["restart", "degraded"])
def test_runtime_gates_block_both_commands_before_memory_access(bridge, command, gate):
    state, controller, active = bridge
    if gate == "restart":
        state.persona_restart_required = True
        expected_code = "persona_restart_required"
    else:
        state.runtime_unavailable = ["memory"]
        expected_code = "runtime_capability_unavailable"
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active), controller))
    assert result["ok"] is False and result["code"] == expected_code
    assert state.memory.calls == []


@pytest.mark.parametrize("command", COMMANDS)
def test_success_uses_memory_result_with_exact_order_and_fields(bridge, command):
    state, controller, active = bridge
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active), controller))
    assert result["ok"] is True and result["memory_ids"] == ["fact_2", "fact_1"]
    if command == "memory:pin_status":
        assert state.memory.calls == [("status", ["fact_2", "fact_1"])]
        assert set(result) == {"ok", "memory_ids", "states", "stale_ids", "pinned_total", "pin_limit"}
    else:
        assert state.memory.calls == [("write", ["fact_2", "fact_1"], True)]
        assert set(result) == {"ok", "memory_ids", "pinned", "changed_ids", "unchanged_ids",
                               "pinned_total_before", "pinned_total_after", "pin_limit"}
    assert controller.sent == [{"type": "memory:result", "request_id": "batch_pin_request_01", "payload": result}]
    assert ws_bridge.response_type_for_request(command) == "memory:result"


@pytest.mark.parametrize("pinned", [True, False], ids=["pin", "unpin"])
def test_write_passes_exact_target_boolean_to_manager(bridge, pinned):
    state, controller, active = bridge
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message("memory:pin_many", active, pinned=pinned), controller))
    assert result["pinned"] is pinned
    assert state.memory.calls == [("write", ["fact_2", "fact_1"], pinned)]


@pytest.mark.parametrize("error_code", ["stale_selection", "pin_limit_exceeded"], ids=["stale-selection", "pin-limit"])
def test_prewrite_rejections_pass_through_without_success_fields(bridge, error_code):
    state, controller, active = bridge
    state.memory.result = {"ok": False, "error_code": error_code, "error": "Synthetic prewrite rejection"}
    if error_code == "stale_selection":
        state.memory.result["stale_ids"] = ["fact_1"]
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message("memory:pin_many", active), controller))
    assert result == state.memory.result
    assert not {"memory_ids", "pinned", "changed_ids", "unchanged_ids",
                "pinned_total_before", "pinned_total_after"}.intersection(result)
    assert controller.sent[0]["type"] == "memory:result"


@pytest.mark.parametrize("command", COMMANDS)
def test_unavailable_memory_returns_explicit_rejection(bridge, command):
    state, controller, active = bridge
    state.memory = None
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active), controller))
    assert result == {"ok": False, "error_code": "memory_unavailable", "error": "Memory system is not initialized"}
    assert controller.sent[0]["type"] == "memory:result"


@pytest.mark.parametrize("command", COMMANDS)
def test_storage_exception_does_not_become_safe_no_change_response(bridge, command):
    state, controller, active = bridge
    state.memory.error = OSError("Synthetic storage acknowledgement failure")
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(command, active), controller))
    assert result is None
    assert controller.sent == [{"type": "error", "request_id": "batch_pin_request_01", "payload": {"message": "内部错误"}}]


def test_mutation_idempotency_survives_kernel_restart_without_reapplying(bridge, tmp_path):
    state, controller, active = bridge
    path = tmp_path / "pin-kernel.sqlite3"
    command = command_envelope("memory:pin_many", active)

    async def handler(_command):
        return await ws_bridge.handle_memory_pin_many(payload("memory:pin_many", active), controller)

    store = KernelStore(path)
    try:
        bus = CommandBus(store)
        bus.register("memory:pin_many", handler)
        first = asyncio.run(bus.dispatch(command))
        replay = asyncio.run(bus.dispatch(command))
        assert first.ok is True and replay.ok is True and first.data == replay.data
        conflicting = command.model_copy(update={"payload": {"memory_ids": ["fact_2", "fact_1"], "pinned": False}})
        rejected = asyncio.run(bus.dispatch(conflicting))
        assert rejected.ok is False and rejected.error.code == "CONFLICT"
        assert store.command(command.request_id).state == "committed"
        assert state.memory.calls == [("write", ["fact_2", "fact_1"], True)]
    finally:
        store.close()
    reopened = KernelStore(path)
    try:
        bus = CommandBus(reopened)
        bus.register("memory:pin_many", handler)
        replay = asyncio.run(bus.dispatch(command))
        assert replay.ok is True and replay.data == first.data
        assert state.memory.calls == [("write", ["fact_2", "fact_1"], True)]
    finally:
        reopened.close()


def test_unknown_mutation_outcome_is_terminal_and_cannot_replay(bridge, tmp_path):
    state, controller, active = bridge
    state.memory.error = OSError("Synthetic storage acknowledgement failure")
    store = KernelStore(tmp_path / "pin-unknown-kernel.sqlite3")
    command = command_envelope("memory:pin_many", active)

    async def handler(_command):
        return await ws_bridge.handle_memory_pin_many(payload("memory:pin_many", active), controller)

    try:
        bus = CommandBus(store)
        bus.register("memory:pin_many", handler)
        first = asyncio.run(bus.dispatch(command))
        replay = asyncio.run(bus.dispatch(command))
        assert first.ok is False and replay.ok is False
        assert store.command(command.request_id).state in {"failed", "outcome_unknown"}
        assert first.data is None and replay.data is None
        assert state.memory.calls == [("write", ["fact_2", "fact_1"], True)]
    finally:
        store.close()
