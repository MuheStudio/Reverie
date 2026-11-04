"""Explicit profile clearing keeps blank updates and unrelated stores intact."""

from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.config.settings import FeatureSettings, MemorySettings
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4, UserProfileUpdatePayload
from src.kernel.storage import KernelStore
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona
from src.storage import encrypted_sqlite
from src.user import (
    EmotionalMemory,
    PROFILE_CLEAR_FIELDS,
    ProfileClearValidationError,
    ProfileSnapshotChangedError,
    UserManager,
    UserProfile,
    user_profile_snapshot,
)


UI_VALUES = {
    "name": "合成姓名甲",
    "nickname": "合成昵称乙",
    "birthday": "1995-04-06",
    "identity": "合成研究员身份",
    "schedule": "08:00-22:00",
    "interests": ["合成兴趣丙", "合成兴趣丁"],
    "hobbies": ["合成爱好戊"],
    "favorite_topics": ["合成主题己"],
    "favorite_games": ["合成游戏庚"],
    "favorite_anime": ["合成动漫辛"],
    "age": 31,
}
PERSONA = {"persona_id": "profile_test_persona", "persona_epoch": 7, "persona_fingerprint": "a" * 64}


def seed_user(manager: UserManager) -> dict:
    manager.profile = UserProfile(
        **deepcopy(UI_VALUES),
        important_dates={"纪念日": "2020-05-06"}, sticker_preferences={"joy": 1.5},
        long_term_goals=["保留目标"], habits=["保留习惯"], historical_events=["保留事件"],
        first_seen="2020-01-02T03:04:05", last_seen="2026-10-17T08:09:10", session_count=17,
    )
    manager.emotional_memories = [EmotionalMemory(
        id="em_profile_clear_fixture", date="2026-10-16", summary="保留情感摘要",
        user_message="保留合成关系记录", assistant_reply="保留合成回复",
        emotion_changes={"joy": 3}, dominant_emotions=["joy"], created_at="2026-10-16T09:00:00",
    )]
    manager.save()
    manager._save_emotional_memories()
    return deepcopy(manager.export_all())


def cleared(field: str) -> object:
    if field == "age":
        return None
    return [] if isinstance(UI_VALUES[field], list) else ""


def clear_payload(manager: UserManager, fields: list[str]) -> dict:
    return {"clear_fields": fields, "expected_profile_snapshot": manager.profile_snapshot()}


def attach_bridge(monkeypatch, manager: UserManager, memory) -> None:
    state = ws_bridge.BridgeState()
    state.user_mgr, state.memory = manager, memory
    monkeypatch.setattr(ws_bridge, "bridge_state", state)


@pytest.fixture
def encrypted_runtime(tmp_path, monkeypatch):
    # Real SQLCipher-backed kernel documents and memory catalog, entirely
    # under pytest's temporary root; no model, network, or user store access.
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", None)
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", False)
    monkeypatch.delenv("REVERIE_STORAGE_KEY_FD", raising=False)
    encrypted_sqlite.install_storage_key(bytes(range(32)), require_encryption=True)
    monkeypatch.setattr("src.memory.embedding.get_embedding_model", lambda _name: None)
    kernel = KernelStore(tmp_path / "kernel.sqlite3")
    manager = UserManager(tmp_path / "user", document_store=kernel)
    original = seed_user(manager)
    settings = MemorySettings(
        lancedb_path=str(tmp_path / "vectors"), sqlite_path=str(tmp_path / "memory.sqlite3"),
    )
    memory = MemoryManager(
        default_persona(), settings, feature_settings=FeatureSettings(autonomous_memory_enabled=False),
        defer_startup_writes=True,
    )
    memory.sync_user_profile(manager)
    attach_bridge(monkeypatch, manager, memory)
    yield SimpleNamespace(manager=manager, memory=memory, kernel=kernel, original=original, settings=settings)
    memory.store.close()
    kernel.close()
    encrypted_sqlite.clear_storage_key_for_testing()


@pytest.mark.parametrize("field", PROFILE_CLEAR_FIELDS)
def test_each_whitelisted_field_clears_and_persists_without_touching_other_state(tmp_path, field):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    snapshot = manager.profile_snapshot()

    manager.clear_profile_fields([field], expected_profile_snapshot=snapshot)

    expected = deepcopy(original)
    expected["profile"][field] = cleared(field)
    assert manager.export_all() == expected
    assert UserManager(tmp_path).export_all() == expected
    assert manager.profile_snapshot() != snapshot


def test_all_ui_fields_clear_with_original_metadata_and_emotional_history(encrypted_runtime):
    runtime = encrypted_runtime
    result = asyncio.run(ws_bridge.handle_user_profile_update(
        clear_payload(runtime.manager, list(PROFILE_CLEAR_FIELDS)), object(),
    ))

    expected = deepcopy(runtime.original)
    for field in PROFILE_CLEAR_FIELDS:
        expected["profile"][field] = cleared(field)
    assert result["ok"] is True and result["operation"] == "clear"
    assert result["cleared_fields"] == list(PROFILE_CLEAR_FIELDS)
    assert runtime.manager.export_all() == expected
    assert result["profile"] == expected["profile"]
    assert result["emotional_memories"] == expected["emotional_memories"]
    assert result["profile_snapshot"] == runtime.manager.profile_snapshot()
    reopened = UserManager(runtime.manager.data_dir, document_store=runtime.kernel)
    assert reopened.export_all() == expected
    assert runtime.kernel.read_private_document("user_profile") == expected["profile"]
    assert runtime.kernel.path.read_bytes()[:16] != encrypted_sqlite.SQLITE_HEADER
    assert Path(runtime.settings.sqlite_path).read_bytes()[:16] != encrypted_sqlite.SQLITE_HEADER
    assert not (runtime.manager.data_dir / "profile.json").exists()
    assert not (runtime.manager.data_dir / "emotional_memories.json").exists()


def test_snapshot_tracks_only_the_ui_fields_and_survives_restart(tmp_path):
    manager = UserManager(tmp_path)
    seed_user(manager)
    before = manager.profile_snapshot()
    assert re.fullmatch(r"[a-f0-9]{64}", before)
    manager.profile.sticker_preferences["calm"] = 1.2
    manager.profile.historical_events.append("新历史")
    manager.profile.important_dates["新日期"] = "2026-10-18"
    manager.on_session_start()
    manager.emotional_memories[0].summary = "情感摘要更新"
    manager.save()
    manager._save_emotional_memories()
    assert manager.profile_snapshot() == before
    assert UserManager(tmp_path).profile_snapshot() == before
    manager.update_profile({"favorite_topics": ["新的主题"]})
    assert manager.profile_snapshot() != before


@pytest.mark.parametrize("update", [
    {"age": 32}, {"favorite_games": ["另一个游戏"]}, {"favorite_anime": ["另一部动漫"]},
], ids=["age", "favorite-games", "favorite-anime"])
def test_snapshot_covers_each_new_ui_field(tmp_path, update):
    manager = UserManager(tmp_path)
    seed_user(manager)
    before = manager.profile_snapshot()
    manager.update_profile(update)
    assert manager.profile_snapshot() != before
    assert UserManager(tmp_path).profile_snapshot() == manager.profile_snapshot()


def test_stale_snapshot_rejects_before_any_mutation_or_save(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    seed_user(manager)
    snapshot = manager.profile_snapshot()
    manager.update_profile({"nickname": "后来修改的昵称"})
    before = deepcopy(manager.export_all())
    stored_before = (tmp_path / "profile.json").read_bytes()
    monkeypatch.setattr(manager, "save", lambda: pytest.fail("stale clear attempted to save"))

    with pytest.raises(ProfileSnapshotChangedError):
        manager.clear_profile_fields(["nickname"], expected_profile_snapshot=snapshot)

    assert manager.export_all() == before
    assert (tmp_path / "profile.json").read_bytes() == stored_before


INVALID_CLEAR_REQUESTS = [
    pytest.param({"clear_fields": [], "expected_profile_snapshot": "a" * 64}, id="empty"),
    pytest.param({"clear_fields": ["nickname", "nickname"], "expected_profile_snapshot": "a" * 64}, id="duplicate"),
    pytest.param({"clear_fields": ["important_dates"], "expected_profile_snapshot": "a" * 64}, id="unknown"),
    pytest.param({"clear_fields": list(PROFILE_CLEAR_FIELDS) + ["nickname"], "expected_profile_snapshot": "a" * 64}, id="over-eleven"),
    pytest.param({"clear_fields": ["nickname"]}, id="missing-snapshot"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "A" * 64}, id="uppercase"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 63}, id="short-snapshot"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 65}, id="long-snapshot"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "g" * 64}, id="non-hex"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": None}, id="null-snapshot"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 64, "profile": {}}, id="profile-present"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 64, "profile": None}, id="null-profile-present"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 64, "restore_default": True}, id="restore-true-present"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 64, "restore_default": False}, id="restore-false-present"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 64, "restore_default": None}, id="restore-null-present"),
    pytest.param({"expected_profile_snapshot": "a" * 64, "profile": {}}, id="orphan-snapshot"),
    pytest.param({"clear_fields": None, "expected_profile_snapshot": "a" * 64}, id="null-fields"),
    pytest.param({"clear_fields": "nickname", "expected_profile_snapshot": "a" * 64}, id="non-list"),
    pytest.param({"clear_fields": ["nickname"], "expected_profile_snapshot": "a" * 64, "force": True}, id="unknown-operation-key"),
]


@pytest.mark.parametrize("payload", INVALID_CLEAR_REQUESTS)
def test_invalid_clear_contract_and_direct_bridge_reject_without_writes(tmp_path, monkeypatch, payload):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    attach_bridge(monkeypatch, manager, SimpleNamespace(
        sync_user_profile=lambda _manager: pytest.fail("invalid clear reached sync"),
    ))
    monkeypatch.setattr(manager, "save", lambda: pytest.fail("invalid clear reached save"))
    with pytest.raises(ValidationError):
        UserProfileUpdatePayload.model_validate(payload)

    result = asyncio.run(ws_bridge.handle_user_profile_update(payload, object()))

    assert result["ok"] is False and result["operation"] == "clear"
    assert result["error_code"] == "PROFILE_CLEAR_INVALID"
    assert "cleared_fields" not in result
    assert result["profile_snapshot"] == manager.profile_snapshot()
    assert manager.export_all() == original


@pytest.mark.parametrize("fields", [["nickname"], ["interests"], list(PROFILE_CLEAR_FIELDS)])
def test_clear_envelope_preserves_explicit_fields_without_inserting_conflicting_defaults(fields):
    envelope = CommandEnvelopeV4(
        request_id="profile_clear_contract", idempotency_key="profile_clear_contract",
        command="user:profile:update",
        persona=PersonaScopeV4(persona_id="profile_test_persona", epoch=7, fingerprint="a" * 64),
        payload={"clear_fields": fields, "expected_profile_snapshot": "b" * 64},
    )
    assert envelope.payload == {"clear_fields": fields, "expected_profile_snapshot": "b" * 64}


@pytest.mark.parametrize("fields", [[], ["nickname", "nickname"], ["important_dates"], [1], "nickname"])
def test_manager_also_rejects_invalid_clear_fields_without_partial_mutation(tmp_path, fields):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    with pytest.raises(ProfileClearValidationError):
        manager.clear_profile_fields(fields, expected_profile_snapshot=manager.profile_snapshot())
    assert manager.export_all() == original
    assert UserManager(tmp_path).export_all() == original


def test_get_blank_update_and_restore_return_backend_snapshots_without_changing_blank_semantics(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    synced = []
    attach_bridge(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda user: synced.append(user)))
    before = asyncio.run(ws_bridge.handle_user_profile_get({}, object()))
    # The canonical envelope fills omitted profile fields with blank defaults.
    payload = UserProfileUpdatePayload.model_validate({"profile": {}}).model_dump(exclude_none=True)
    after = asyncio.run(ws_bridge.handle_user_profile_update(payload, object()))
    assert manager.export_all() == original
    assert after["profile_snapshot"] == before["profile_snapshot"]
    assert "operation" not in after
    restored = asyncio.run(ws_bridge.handle_user_profile_update({"restore_default": True}, object()))
    assert restored["profile"]["nickname"] == "白夜"
    assert restored["profile_snapshot"] == user_profile_snapshot(manager.profile)
    assert len(synced) == 2


def confirm_fact(memory: MemoryManager, text: str, *, permanent: bool = False) -> str:
    digest = hashlib.sha256(text.encode()).hexdigest()
    candidate = memory.store.catalog.create_candidate(
        fact_key="profile-clear-independent:" + digest[:20], proposed_text=text, source_text=text,
        source_type="user_confirmed_statement", source_uri="", source_hash=digest, confidence=1.0,
    )
    memory_id = memory.store.catalog.confirm_candidate(
        candidate["id"], embedding_model_version=memory.store.runtime.model_version,
    )["memory"]["id"]
    if permanent:
        with memory.store.catalog.transaction() as connection:
            connection.execute("UPDATE memory_records SET retention_layer='permanent' WHERE id=?", (memory_id,))
    return memory_id


def test_clear_sync_removes_only_derived_anchors_and_preserves_prefixed_confirmed_ids_after_restart(encrypted_runtime):
    runtime = encrypted_runtime
    manager, memory = runtime.manager, runtime.memory
    interest_fact = next(text for text in manager.profile_facts() if "的兴趣：" in text)
    protected_ids = {
        confirm_fact(memory, interest_fact, permanent=True),
        confirm_fact(memory, "User profile: 独立确认的合成事实"),
        memory.store_fact("用户档案：来源不明的旧合成事实", "permanent", source_type="legacy_local"),
        memory.store_fact("另一个保留的合成事实", "permanent"),
    }
    memory.sync_user_profile(manager)
    protected = {memory_id: deepcopy(memory.store.catalog.get(memory_id)) for memory_id in protected_ids}
    derived_before = {row["id"] for row in memory.store.catalog.all() if row["source_type"] == "user_profile"}

    result = asyncio.run(ws_bridge.handle_user_profile_update(clear_payload(manager, ["nickname", "interests"]), object()))

    assert result["ok"] is True
    assert {memory_id: memory.store.catalog.get(memory_id) for memory_id in protected_ids} == protected
    derived = [row for row in memory.store.catalog.all() if row["source_type"] == "user_profile"]
    assert {row["text"] for row in derived} == set(manager.profile_facts()) - {row["text"] for row in protected.values()}
    assert not derived_before.intersection(row["id"] for row in derived)
    assert all(UI_VALUES["nickname"] not in row["text"] and "合成兴趣丙" not in row["text"] for row in derived)
    reopened_kernel = KernelStore(runtime.kernel.path)
    reopened_user = UserManager(manager.data_dir, document_store=reopened_kernel)
    reopened_memory = MemoryManager(
        default_persona(), runtime.settings, feature_settings=FeatureSettings(autonomous_memory_enabled=False),
        defer_startup_writes=True,
    )
    try:
        assert reopened_memory.sync_user_profile(reopened_user) == 0
        assert {memory_id: reopened_memory.store.catalog.get(memory_id) for memory_id in protected_ids} == protected
        assert reopened_user.profile.nickname == "" and reopened_user.profile.interests == []
    finally:
        reopened_memory.store.close()
        reopened_kernel.close()


def test_bridge_stale_snapshot_returns_current_bounded_view_and_never_syncs(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    seed_user(manager)
    payload = clear_payload(manager, ["nickname"])
    manager.update_profile({"nickname": "新的昵称"})
    attach_bridge(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda _user: pytest.fail("stale clear synced")))
    result = asyncio.run(ws_bridge.handle_user_profile_update(payload, object()))
    assert result["ok"] is False and result["error_code"] == "PROFILE_SNAPSHOT_CHANGED"
    assert result["profile"]["nickname"] == "新的昵称"
    assert result["profile_snapshot"] == manager.profile_snapshot()
    assert set(result["profile"]) == set(PROFILE_CLEAR_FIELDS)
    assert "cleared_fields" not in result and "emotional_memories" not in result


@pytest.mark.parametrize("stage", ["save-before", "save-after", "sync-before", "sync-after"])
def test_save_or_sync_failure_never_reports_cleared_or_unchanged(encrypted_runtime, monkeypatch, stage):
    runtime = encrypted_runtime
    manager, memory = runtime.manager, runtime.memory
    payload = clear_payload(manager, ["nickname", "interests"])
    original_save, original_sync = manager.save, memory.sync_user_profile
    marker = "RAW_EXCEPTION_PRIVATE_BODY_/private/synthetic-path"

    def fail_save():
        if stage == "save-after":
            original_save()
        raise OSError(marker)

    def fail_sync(user):
        if stage == "sync-after":
            original_sync(user)
        raise RuntimeError(marker)

    if stage.startswith("save"):
        monkeypatch.setattr(manager, "save", fail_save)
    else:
        monkeypatch.setattr(memory, "sync_user_profile", fail_sync)
    result = asyncio.run(ws_bridge.handle_user_profile_update(payload, object()))
    assert result["ok"] is False and result["operation"] == "clear"
    assert result["error_code"] == "PROFILE_CLEAR_UNCONFIRMED"
    assert "cleared_fields" not in result and "unchanged" not in result
    assert result["profile"]["nickname"] == "" and result["profile"]["interests"] == []
    assert result["profile_snapshot"] == manager.profile_snapshot()
    assert marker not in json.dumps(result, ensure_ascii=False)
    assert "emotional_memories" not in result and set(result["profile"]) == set(PROFILE_CLEAR_FIELDS)
    durable = UserManager(manager.data_dir, document_store=runtime.kernel)
    # Injected failures cover both durable outcomes; no rollback is promised.
    assert durable.profile.nickname == (UI_VALUES["nickname"] if stage == "save-before" else "")
    assert durable.emotional_memories[0].to_dict() == runtime.original["emotional_memories"][0]


def test_unavailable_sync_is_a_known_rejection_before_clear(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    attach_bridge(monkeypatch, manager, None)
    result = asyncio.run(ws_bridge.handle_user_profile_update(clear_payload(manager, ["nickname"]), object()))
    assert result["ok"] is False and result["error_code"] == "PROFILE_CLEAR_UNAVAILABLE"
    assert manager.export_all() == original


def test_unavailable_clear_method_is_a_known_rejection_before_sync(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    attach_bridge(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda _user: pytest.fail("unavailable clear synced")))
    payload = clear_payload(manager, ["nickname"])
    monkeypatch.setattr(manager, "clear_profile_fields", None)
    result = asyncio.run(ws_bridge.handle_user_profile_update(payload, object()))
    assert result["ok"] is False and result["error_code"] == "PROFILE_CLEAR_UNAVAILABLE"
    assert manager.export_all() == original


def test_snapshot_responses_support_historical_profile_objects_with_only_to_dict(monkeypatch):
    profile = SimpleNamespace(to_dict=lambda: {"nickname": "旧接口合成昵称"})
    manager = SimpleNamespace(
        profile=profile, get_recent_emotional_memories=lambda _limit: [],
        update_profile=lambda _data: profile,
    )
    attach_bridge(monkeypatch, manager, None)
    before = asyncio.run(ws_bridge.handle_user_profile_get({}, object()))
    after = asyncio.run(ws_bridge.handle_user_profile_update({"profile": {}}, object()))
    assert before["profile"] == after["profile"] == profile.to_dict()
    assert before["profile_snapshot"] == after["profile_snapshot"]
    assert re.fullmatch(r"[a-f0-9]{64}", before["profile_snapshot"])


def test_failed_receipt_snapshot_read_does_not_leak_or_turn_partial_clear_into_success(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    seed_user(manager)
    attach_bridge(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda _user: None))

    def unavailable_snapshot(_profile):
        raise OSError("PRIVATE_SNAPSHOT_FAILURE_/private/synthetic")

    payload = clear_payload(manager, ["nickname"])
    monkeypatch.setattr(ws_bridge, "user_profile_snapshot", unavailable_snapshot)
    result = asyncio.run(ws_bridge.handle_user_profile_update(payload, object()))
    assert result["ok"] is False and result["error_code"] == "PROFILE_CLEAR_UNCONFIRMED"
    assert "cleared_fields" not in result and "profile_snapshot" not in result
    assert "PRIVATE_SNAPSHOT_FAILURE" not in json.dumps(result)
    assert UserManager(tmp_path).profile.nickname == ""


def test_failure_receipt_is_bounded_even_for_oversized_existing_profile(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    seed_user(manager)
    manager.profile.nickname = "长" * 1000
    manager.profile.identity = "身" * 3000
    manager.profile.interests = ["兴" * 1000] * 100
    attach_bridge(monkeypatch, manager, None)
    result = asyncio.run(ws_bridge.handle_user_profile_update(clear_payload(manager, ["nickname"]), object()))
    assert len(result["profile"]["nickname"]) == 80
    assert len(result["profile"]["identity"]) == 500
    assert len(result["profile"]["interests"]) == 50
    assert all(len(item) == 160 for item in result["profile"]["interests"])
    assert result["profile_snapshot"] == manager.profile_snapshot()


def dispatch_clear(monkeypatch, manager: UserManager, memory, *, stale_persona=False, race=False):
    attach_bridge(monkeypatch, manager, memory)
    endpoint = object()
    monkeypatch.setattr(ws_bridge, "_client_contexts", {endpoint: ws_bridge.BridgeClientContext(
        client_id="profile_controller", protocol_version=4, authenticated=True,
    )})
    active = dict(PERSONA)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(active))
    payload = clear_payload(manager, ["nickname"])
    payload.update({"expected_" + key: value for key, value in PERSONA.items()})
    if stale_persona:
        payload["expected_persona_epoch"] -= 1

    async def scenario():
        lock = asyncio.Lock()
        monkeypatch.setattr(ws_bridge, "_persona_effect_lock", lock)
        if race:
            await lock.acquire()
        task = asyncio.create_task(ws_bridge.dispatch_authenticated_message({
            "type": "user:profile:update", "request_id": "profile_clear_guard", "payload": payload,
        }, endpoint, emit_result=False))
        if race:
            await asyncio.sleep(0)
            active["persona_epoch"] += 1
            lock.release()
        return await task

    return asyncio.run(scenario())


@pytest.mark.parametrize("race", [False, True])
def test_clear_keeps_existing_persona_proof_and_in_lock_epoch_recheck(tmp_path, monkeypatch, race):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    result = dispatch_clear(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda _user: pytest.fail("stale persona synced")),
                            stale_persona=not race, race=race)
    assert result["ok"] is False and result["code"] == "stale_persona"
    assert manager.export_all() == original


def test_clear_through_guarded_dispatch_succeeds_with_current_persona(tmp_path, monkeypatch):
    manager = UserManager(tmp_path)
    seed_user(manager)
    synced = []
    result = dispatch_clear(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda user: synced.append(user)))
    assert result["ok"] is True and result["cleared_fields"] == ["nickname"]
    assert manager.profile.nickname == "" and synced == [manager]
    assert ws_bridge.MsgType.USER_PROFILE_GET in ws_bridge._PERSONA_SCOPED_COMMANDS


@pytest.mark.parametrize("guard,expected_code", [
    ("recovery", "BACKUP_RECOVERY_REQUIRED"),
    ("restart", "persona_restart_required"),
    ("degraded", "runtime_capability_unavailable"),
])
def test_clear_does_not_bypass_existing_runtime_guards(tmp_path, monkeypatch, guard, expected_code):
    manager = UserManager(tmp_path)
    original = seed_user(manager)
    attach_bridge(monkeypatch, manager, SimpleNamespace(sync_user_profile=lambda _user: pytest.fail("blocked clear synced")))
    if guard == "recovery":
        ws_bridge.bridge_state.recovery_state = "recovery_required"
    elif guard == "restart":
        ws_bridge.bridge_state.persona_restart_required = True
    else:
        ws_bridge.bridge_state.runtime_unavailable = ("memory",)
    result = asyncio.run(ws_bridge.dispatch_authenticated_message({
        "type": "user:profile:update", "request_id": "profile_guard_unchanged",
        "payload": clear_payload(manager, ["nickname"]),
    }, object(), emit_result=False))
    assert result["ok"] is False and result["code"] == expected_code
    assert manager.export_all() == original


@pytest.mark.parametrize("value, stored", [
    (18, 18), (120, 120), ("45", 45), (17, 31), (121, 31), (0, 31), (-3, 31), (True, 31), ("abc", 31), (None, 31),
], ids=["minimum", "maximum", "numeric-text", "below", "above", "zero", "negative", "boolean", "text", "null"])
def test_age_writes_accept_only_the_protocol_range(tmp_path, value, stored):
    manager = UserManager(tmp_path)
    seed_user(manager)
    manager.update_profile({"age": value})
    assert manager.profile.age == stored
    assert UserManager(tmp_path).profile.age == stored


@pytest.mark.parametrize("message, stored", [("我今年17岁", 31), ("我今年130岁", 31), ("我今年40岁", 40)],
                         ids=["minor", "above-range", "in-range"])
def test_chat_extracted_age_uses_the_same_range(tmp_path, message, stored):
    manager = UserManager(tmp_path)
    seed_user(manager)
    manager.update_profile(manager.extract_profile_updates(message))
    assert manager.profile.age == stored


def test_existing_out_of_range_age_is_kept_until_the_owner_clears_it(tmp_path):
    manager = UserManager(tmp_path)
    seed_user(manager)
    manager.profile.age = 17
    manager.save()
    reopened = UserManager(tmp_path)
    assert reopened.profile.age == 17
    reopened.update_profile({"nickname": "另一个昵称"})
    assert reopened.profile.age == 17
    reopened.clear_profile_fields(["age"], expected_profile_snapshot=reopened.profile_snapshot())
    assert UserManager(tmp_path).profile.age is None


def test_clearing_new_fields_removes_only_their_derived_facts(encrypted_runtime):
    runtime = encrypted_runtime
    manager, memory = runtime.manager, runtime.memory
    derived = lambda: {row["text"] for row in memory.store.catalog.all() if row["source_type"] == "user_profile"}
    before = derived()
    for marker in ("合成游戏庚", "合成动漫辛", "31 岁"):
        assert any(marker in text for text in before)

    result = asyncio.run(ws_bridge.handle_user_profile_update(
        clear_payload(manager, ["favorite_games", "favorite_anime", "age"]), object(),
    ))

    assert result["ok"] is True and result["cleared_fields"] == ["favorite_games", "favorite_anime", "age"]
    assert result["profile"]["age"] is None
    assert result["profile"]["favorite_games"] == [] and result["profile"]["favorite_anime"] == []
    after = derived()
    assert after == set(manager.profile_facts())
    assert not any(marker in text for text in after for marker in ("合成游戏庚", "合成动漫辛", "31 岁"))
    assert any("合成兴趣丙" in text for text in after)
