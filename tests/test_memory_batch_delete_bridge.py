"""Controller, persona and recovery barriers for memory:delete_many."""

import asyncio
import json

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge


class Controller:
    def __init__(self):
        self.sent = []

    async def send(self, message):
        self.sent.append(json.loads(message))


class RecordingMemory:
    def __init__(self, result=None):
        self.calls = []
        self.result = result

    def delete_confirmed_memories(self, memory_ids):
        self.calls.append(list(memory_ids))
        return self.result if self.result is not None else {
            "ok": True, "deleted_ids": list(memory_ids), "purged_revisions": len(memory_ids),
        }


@pytest.fixture
def bridge(monkeypatch):
    state = ws_bridge.BridgeState()
    controller = Controller()
    state.memory = RecordingMemory()
    active = {"persona_id": "batch_persona", "persona_epoch": 4, "persona_fingerprint": "a" * 64}
    context = ws_bridge.BridgeClientContext(
        client_id="batch_delete_controller", protocol_version=4, authenticated=True,
        persona_id=active["persona_id"],
    )
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_controller_ws", controller)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {controller: context})
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(active))
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())
    return state, controller, active


def message(active, *, memory_ids=None, **proof_changes):
    return {
        "type": "memory:delete_many",
        "request_id": "batch_delete_request_01",
        "payload": {
            "memory_ids": ["fact_2", "fact_1"] if memory_ids is None else memory_ids,
            "expected_persona_id": active["persona_id"],
            "expected_persona_epoch": active["persona_epoch"],
            "expected_persona_fingerprint": active["persona_fingerprint"],
            **proof_changes,
        },
    }


@pytest.mark.parametrize("authenticated,same_controller", [
    (False, True), (False, False), (True, False),
])
def test_batch_requires_the_same_authenticated_controller(bridge, authenticated, same_controller):
    state, controller, _active = bridge
    target = controller if same_controller else Controller()
    ws_bridge._client_contexts[target] = ws_bridge.BridgeClientContext(
        client_id="batch_delete_observer", protocol_version=4, authenticated=authenticated,
    )
    with pytest.raises(PermissionError, match="authenticated controller required"):
        asyncio.run(ws_bridge.handle_memory_delete_many({"memory_ids": ["fact_1"]}, target))
    assert state.memory.calls == []


@pytest.mark.parametrize("payload", [
    {"memory_ids": []},
    {"memory_ids": [f"fact_{number}" for number in range(101)]},
    {"memory_ids": ["fact_1", "fact_1"]},
    {"memory_ids": ["bad id"]},
    {"memory_ids": ["fact_1"], "confirm": True},
])
def test_direct_handler_revalidates_batch_payload_before_mutation(bridge, payload):
    state, controller, _active = bridge
    with pytest.raises(ValidationError):
        asyncio.run(ws_bridge.handle_memory_delete_many(payload, controller))
    assert state.memory.calls == []


@pytest.mark.parametrize("recovery_state", ["recovering", "recovery_required"])
def test_recovery_read_only_blocks_batch_before_memory_calls(bridge, recovery_state):
    state, controller, active = bridge
    state.recovery_state = recovery_state
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(active), controller))
    assert result["ok"] is False
    assert result["code"] == "BACKUP_RECOVERY_REQUIRED"
    assert state.memory.calls == []
    assert controller.sent[0]["type"] == "memory:result"
    assert "memory:delete_many" not in ws_bridge._RECOVERY_READ_COMMANDS


@pytest.mark.parametrize("changed_proof", [
    {"expected_persona_id": "other_persona"},
    {"expected_persona_epoch": 3},
    {"expected_persona_fingerprint": "b" * 64},
    {"expected_persona_id": ""},
])
def test_dispatch_rejects_stale_persona_before_batch_handler(bridge, changed_proof):
    state, controller, active = bridge
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(
        message(active, **changed_proof), controller,
    ))
    assert result["ok"] is False and result["code"] == "stale_persona"
    assert state.memory.calls == []
    assert "memory:delete_many" in ws_bridge._PERSONA_SCOPED_COMMANDS


def test_batch_success_uses_memory_result_and_preserves_requested_id_order(bridge):
    state, controller, active = bridge
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(active), controller))
    assert state.memory.calls == [["fact_2", "fact_1"]]
    assert result == {"ok": True, "deleted_ids": ["fact_2", "fact_1"], "purged_revisions": 2}
    assert controller.sent == [{
        "type": "memory:result", "request_id": "batch_delete_request_01", "payload": result,
    }]


def test_stale_selection_result_passes_through_without_partial_success(bridge):
    state, controller, active = bridge
    state.memory.result = {
        "ok": False, "error_code": "stale_selection", "stale_ids": ["fact_1"],
        "error": "Selected memories changed; no memories were deleted",
    }
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(active), controller))
    assert result == state.memory.result
    assert "deleted_ids" not in controller.sent[0]["payload"]
    assert controller.sent[0]["type"] == "memory:result"


def test_missing_memory_system_returns_an_explicit_rejection(bridge):
    state, controller, active = bridge
    state.memory = None
    result = asyncio.run(ws_bridge.dispatch_authenticated_message(message(active), controller))
    assert result["ok"] is False and result["error_code"] == "memory_unavailable"
    assert controller.sent[0]["type"] == "memory:result"
