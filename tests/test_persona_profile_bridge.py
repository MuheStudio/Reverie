"""The new editing RPC is controller-owned and inactive-only under one lock."""
from __future__ import annotations

import asyncio
import hashlib
import json

import pytest

from src.bridge import ws_bridge
from src.kernel.contracts import COMMAND_PAYLOAD_MODELS, CommandEnvelopeV4, MUTATING_COMMAND_NAMES, MVP_EVENT_NAMES, PersonaScopeV4
from src.persona.sillytavern_import import activate_imported_persona, load_imported_persona, parse_sillytavern_json
from src.world_state_store import WorldStateStore
from tests.persona_profile_support import (
    cipher_key, file_snapshot, profile_env, scope_proof, synthetic_card, update_payload,
)


def update(env, payload=None):
    return asyncio.run(ws_bridge.handle_persona_profile_update(payload or update_payload(env), env.endpoint))


def activate_target(env):
    authorization = env.epochs.authorize_update(actor="owner", reason="isolated switch", user_confirmed=True)
    candidate = load_imported_persona(env.persona_dir, env.profile_id)
    env.epochs.activate_update_with_commit(candidate, authorization,
        lambda: activate_imported_persona(env.persona_dir, env.profile_id))
    ws_bridge.bridge_state.persona = candidate


def test_profile_rpc_contracts_are_registered_and_update_is_mutating(profile_env):
    for suffix in ("get", "update"):
        command = "persona:profile:" + suffix
        assert command in COMMAND_PAYLOAD_MODELS
        assert command + ":result" in MVP_EVENT_NAMES
        assert ws_bridge.response_type_for_request(command) == command + ":result"
    assert "persona:profile:update" in MUTATING_COMMAND_NAMES
    assert "persona:profile:get" not in MUTATING_COMMAND_NAMES
    payload = update_payload(profile_env)
    for key in scope_proof():
        payload.pop(key)
    token = profile_env.epochs.token()
    envelope = CommandEnvelopeV4(command="persona:profile:update", payload=payload,
        persona=PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint))
    assert envelope.payload["fields"] == payload["fields"]
    assert "persona:profile:update" not in ws_bridge._PERSONA_SCOPED_COMMANDS
    assert "persona:profile:update" not in ws_bridge._POST_PERSONA_SWITCH_ALLOWED


@pytest.mark.parametrize("authenticated,controller", [(False, True), (True, False)])
def test_both_reads_and_saves_require_authenticated_controller(profile_env, monkeypatch, authenticated, controller):
    env = profile_env
    env.context.authenticated = authenticated
    if not controller:
        monkeypatch.setattr(ws_bridge, "_controller_ws", object())
    before = file_snapshot(env.data_dir)
    read = asyncio.run(ws_bridge.handle_persona_profile_get({"profile_id": env.profile_id}, env.endpoint))
    saved = update(env)
    assert read["code"] == saved["code"] == "forbidden"
    assert read["ok"] is saved["ok"] is False
    assert file_snapshot(env.data_dir) == before


@pytest.mark.parametrize("override,code", [
    ({"identity_change_confirmed": False}, "identity_confirmation_required"),
    ({"identity_change_confirmed": 1}, "identity_confirmation_required"),
    ({"confirmed_profile_id": "different"}, "identity_confirmation_required"),
    ({"actor": "guest"}, "identity_authorization_required"),
    ({"actor": []}, "identity_authorization_required"),
    ({"reason": "短"}, "identity_authorization_required"),
    ({"reason": None}, "identity_authorization_required"),
])
def test_confirmation_and_actor_errors_write_nothing(profile_env, override, code):
    before = file_snapshot(profile_env.data_dir)
    result = update(profile_env, update_payload(profile_env, **override))
    assert (result["ok"], result["code"]) == (False, code)
    assert file_snapshot(profile_env.data_dir) == before


@pytest.mark.parametrize("override", [{"expected_persona_id": "old"}, {"expected_persona_epoch": 0},
    {"expected_persona_epoch": True}, {"expected_persona_epoch": "1"},
    {"expected_persona_fingerprint": "a" * 64}, {"expected_persona_fingerprint": "非ASCII"}])
def test_stale_scope_is_identity_conflict_with_no_files(profile_env, override):
    before = file_snapshot(profile_env.data_dir)
    result = update(profile_env, update_payload(profile_env, **override))
    assert (result["ok"], result["code"]) == (False, "identity_conflict")
    assert file_snapshot(profile_env.data_dir) == before


def test_active_imported_profile_can_be_read_but_never_saved(profile_env):
    env = profile_env
    activate_target(env)
    read = asyncio.run(ws_bridge.handle_persona_profile_get({"profile_id": env.profile_id}, env.endpoint))
    assert read["ok"] is True and read["active"] is True
    before = file_snapshot(env.data_dir)
    result = update(env)
    assert result["code"] == "persona_active" and result["ok"] is False
    assert file_snapshot(env.data_dir) == before


@pytest.mark.parametrize("target,code", [("default", "persona_not_editable"), ("missing", "profile_not_found")])
def test_save_rejects_builtin_and_missing_targets(profile_env, target, code):
    env = profile_env
    activate_target(env)
    before = file_snapshot(env.data_dir)
    payload = update_payload(env, profile_id=target, confirmed_profile_id=target)
    assert update(env, payload)["code"] == code
    assert file_snapshot(env.data_dir) == before


def test_switching_target_active_makes_old_draft_conflict_before_active_error(profile_env):
    env = profile_env
    payload = update_payload(env)
    activate_target(env)
    before = file_snapshot(env.data_dir)
    assert update(env, payload)["code"] == "identity_conflict"
    assert file_snapshot(env.data_dir) == before


def test_scope_is_rechecked_after_waiting_for_effect_lock(profile_env):
    env = profile_env
    payload = update_payload(env)
    async def scenario():
        async with ws_bridge._persona_effect_lock:
            pending = asyncio.create_task(ws_bridge.handle_persona_profile_update(payload, env.endpoint))
            await asyncio.sleep(0)
            assert not pending.done()
            activate_target(env)
            before = file_snapshot(env.data_dir)
        result = await pending
        assert result["code"] == "identity_conflict"
        assert file_snapshot(env.data_dir) == before
    asyncio.run(scenario())


def test_success_leaves_runtime_epochs_cache_and_kernel_personas_unchanged(profile_env, monkeypatch):
    from src.kernel.storage import KernelStore
    env = profile_env
    kernel = KernelStore(env.data_dir / "isolated-kernel.sqlite3")
    token = env.epochs.token()
    kernel.activate_persona(PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint),
        identity=env.builtin.identity_envelope.core_identity, identity_version=1, actor="bootstrap", reason="isolated setup")
    monkeypatch.setattr(ws_bridge.bridge_state, "kernel_store", kernel)
    calls = []
    async def forbidden_broadcast(*args, **kwargs):
        calls.append((args, kwargs))
    monkeypatch.setattr(ws_bridge, "broadcast", forbidden_broadcast)
    cache = (env.persona_dir / "active.json").read_bytes()
    old_persona = ws_bridge.bridge_state.persona
    before_rows = [tuple(row) for row in kernel._connection.execute("SELECT * FROM personas ORDER BY persona_id")]
    try:
        result = update(env)
        assert result["ok"] is True and result["active"] is False and "persona_epoch" not in result
        assert env.epochs.token() == token
        assert ws_bridge.bridge_state.model_epoch == 17
        assert ws_bridge.bridge_state.persona is old_persona
        assert (env.persona_dir / "active.json").read_bytes() == cache
        assert [tuple(row) for row in kernel._connection.execute("SELECT * FROM personas ORDER BY persona_id")] == before_rows
        assert calls == []
    finally:
        kernel.close()


@pytest.mark.parametrize("state,code", [("recovering", "BACKUP_RECOVERY_REQUIRED"),
    ("recovery_required", "BACKUP_RECOVERY_REQUIRED"), ("restart", "persona_restart_required")])
def test_recovery_and_restart_gates_reject_without_writes(profile_env, monkeypatch, state, code):
    if state == "restart":
        monkeypatch.setattr(ws_bridge.bridge_state, "persona_restart_required", True)
    else:
        monkeypatch.setattr(ws_bridge.bridge_state, "recovery_state", state)
    before = file_snapshot(profile_env.data_dir)
    result = update(profile_env)
    assert (result["ok"], result["code"]) == (False, code)
    assert file_snapshot(profile_env.data_dir) == before


@pytest.mark.parametrize("state,code", [("recovering", "BACKUP_RECOVERY_REQUIRED"), ("restart", "persona_restart_required")])
def test_recovery_and_restart_are_rechecked_after_lock_wait(profile_env, monkeypatch, state, code):
    env = profile_env
    payload = update_payload(env)
    async def scenario():
        async with ws_bridge._persona_effect_lock:
            pending = asyncio.create_task(ws_bridge.handle_persona_profile_update(payload, env.endpoint))
            await asyncio.sleep(0)
            assert not pending.done()
            name = "persona_restart_required" if state == "restart" else "recovery_state"
            monkeypatch.setattr(ws_bridge.bridge_state, name, True if state == "restart" else state)
            before = file_snapshot(env.data_dir)
        result = await pending
        assert result["code"] == code
        assert file_snapshot(env.data_dir) == before
    asyncio.run(scenario())


def test_pending_noncurrent_restore_is_checked_read_only(profile_env):
    env = profile_env
    identity = env.report.persona.identity_envelope
    journal_path = env.data_dir / "personas" / hashlib.sha256(env.profile_id.encode()).hexdigest() / "restore/restore.sqlite3"
    journal = WorldStateStore(journal_path, persona_identity={"persona_id": identity.persona_id,
        "fingerprint": identity.fingerprint, "identity_version": identity.version})
    journal.prepare_restore({"_memory_restore_marker": "before"}, {"_memory_restore_marker": "after"})
    before = file_snapshot(env.data_dir)
    result = update(env)
    assert (result["ok"], result["code"]) == (False, "restore_pending")
    assert file_snapshot(env.data_dir) == before


def test_unreadable_restore_journal_fails_closed_and_does_not_create_state(profile_env):
    env = profile_env
    state_root = env.data_dir / "personas" / hashlib.sha256(env.profile_id.encode()).hexdigest()
    path = state_root / "restore/restore.sqlite3"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"synthetic invalid encrypted journal")
    before = file_snapshot(env.data_dir)
    assert update(env)["code"] == "restore_pending"
    assert file_snapshot(env.data_dir) == before


def test_import_save_waits_for_same_effect_lock(profile_env):
    env = profile_env
    raw = synthetic_card("另一个合成人格")
    imported = parse_sillytavern_json(raw)
    async def scenario():
        async with ws_bridge._persona_effect_lock:
            pending = asyncio.create_task(ws_bridge.handle_persona_import({"json": raw}, env.endpoint))
            await asyncio.sleep(0)
            assert not pending.done()
            assert not (env.persona_dir / "imported" / imported.card_id).exists()
        result = await pending
        assert result["ok"] is True and result["saved"] is True and result["activated"] is False
    asyncio.run(scenario())
