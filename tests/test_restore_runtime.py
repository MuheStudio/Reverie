"""Restore boundaries exercised through transports and the runtime owner."""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from pathlib import Path
from types import SimpleNamespace
from weakref import WeakSet

import pytest

from src.bridge import stdio_bridge, ws_bridge
from src.chat.session import ChatSession
from src.diary import DiaryEntry, DiaryManager
from src.emotion.system import EmotionSystem
from src.memory.manager import MemoryManager
from src.mvp_runtime import MvpDesktopRuntime, _await_thread_writer
from src.persona.persona_card import default_persona
from src.relationship.tracker import RelationshipTracker
from src.user import UserManager


@pytest.fixture
def bridge(monkeypatch):
    state = ws_bridge.BridgeState()
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_connections", WeakSet())
    monkeypatch.setattr(ws_bridge, "_client_contexts", {})
    monkeypatch.setattr(ws_bridge, "_controller_ws", None)
    monkeypatch.setattr(ws_bridge, "_chat_coordinator", None)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: {
        "persona_id": "restore_test", "persona_epoch": 1, "persona_fingerprint": "f" * 64,
    })
    return state


class Endpoint:
    def __init__(self, frames=()):
        self.frames = list(frames)
        self.sent = []

    async def send(self, serialized):
        self.sent.append(json.loads(serialized))

    async def close(self, **_kwargs):
        pass

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.frames:
            return json.dumps(self.frames.pop(0))
        raise StopAsyncIteration


class PoisonLedger:
    def begin_command(self, *_args):
        raise AssertionError("Rejected restore reached ledger/cache")

    def command(self, *_args):
        raise AssertionError("Rejected restore reached error-settlement ledger")


@pytest.mark.asyncio
async def test_inline_restore_direct_and_dispatch_are_closed_before_managers(bridge, monkeypatch):
    bridge.kernel_store = PoisonLedger()
    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: pytest.fail("manager entered"))
    endpoint = Endpoint()
    direct = await ws_bridge.handle_backup_import({"backup": "malformed"}, endpoint)
    dispatched = await ws_bridge.dispatch_authenticated_message({
        "type": "backup:import", "payload": None, "request_id": "restore_inline_01",
    }, endpoint)
    assert direct["code"] == dispatched["code"] == "BACKUP_RESTORE_DISABLED"
    assert endpoint.sent[-1]["payload"]["code"] == "BACKUP_RESTORE_DISABLED"


@pytest.mark.asyncio
async def test_websocket_inline_restore_never_begins_ledger(bridge, monkeypatch):
    bridge.kernel_store = PoisonLedger()
    async def authenticated(_endpoint):
        return ws_bridge.BridgeClientContext("restore_owner", 4, True, "dream-room", "restore_test")
    monkeypatch.setattr(ws_bridge, "_authenticate_bridge_client", authenticated)
    endpoint = Endpoint([{"type": "backup:import", "payload": None, "request_id": "restore_ws_001"}])
    await ws_bridge.websocket_handler(endpoint)
    assert any(item["payload"].get("code") == "BACKUP_RESTORE_DISABLED" for item in endpoint.sent)


@pytest.mark.asyncio
async def test_stdio_inline_restore_never_begins_ledger(bridge, monkeypatch):
    bridge.kernel_store = PoisonLedger()
    monkeypatch.setenv("REVERIE_BRIDGE_SECRET", "a" * 64)
    messages = iter([{"kind": "renderer_command", "schema": "reverie.command.v4", "envelope": {
        "command": "backup:import", "payload": None, "request_id": "restore_stdio_001",
    }}, None])
    monkeypatch.setattr(stdio_bridge, "read_frame", lambda _stream: next(messages))
    receipts = []
    async def write(_controller, payload):
        receipts.append(payload)
    monkeypatch.setattr(stdio_bridge.StdioController, "write", write)
    await stdio_bridge.start_stdio_bridge()
    ready = next(item for item in receipts if item["kind"] == "ready")
    assert ready["runtimeWritable"] and not ready["writesBlocked"]
    assert any(item.get("frame", {}).get("payload", {}).get("code") == "BACKUP_RESTORE_DISABLED" for item in receipts)


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["chat:send", "memory:store", "user:profile:update", "settings:update"])
async def test_recovery_readlock_precedes_handlers_and_ledger(bridge, monkeypatch, command):
    bridge.recovery_state = "recovery_required"
    bridge.kernel_store = PoisonLedger()
    async def forbidden(*_args):
        pytest.fail("Locked command reached business handler")
    monkeypatch.setitem(ws_bridge._handlers, command, forbidden)
    result = await ws_bridge.dispatch_authenticated_message({
        "type": command, "payload": {}, "request_id": "restore_lock_001",
    }, Endpoint())
    assert result["code"] == "BACKUP_RECOVERY_REQUIRED"
    assert result["writes_blocked"] is True


@pytest.mark.asyncio
async def test_native_restore_without_coordinator_is_disabled_before_manager(bridge, monkeypatch):
    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: pytest.fail("manager entered"))
    with pytest.raises(ValueError) as caught:
        await ws_bridge._run_native_backup("import", "/missing.json")
    assert caught.value.code == "BACKUP_RESTORE_DISABLED"


@pytest.mark.asyncio
async def test_native_inspection_never_opens_a_manager_or_ledger(bridge, monkeypatch, tmp_path):
    import src.backup_inspection as inspection
    source = tmp_path / "inspect.json"
    source.write_text('{}')
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(ws_bridge, "_local_backup_manager", lambda: pytest.fail("inspection manager entered"))
    bridge.kernel_store = PoisonLedger()
    metadata = {"schema": "reverie.full_local_backup.v3", "schema_version": 3,
                "persona_identity": {"persona_id": "synthetic"}, "memory_count": 12,
                "sha256": "f" * 64, "file_bytes": 2}
    monkeypatch.setattr(inspection, "inspect_backup_file", lambda _path: SimpleNamespace(as_dict=lambda: metadata))
    receipt = await stdio_bridge._handle_control({"kind": "control", "schema": stdio_bridge.CONTROL_SCHEMA,
        "requestId": "restore_inspect_001", "type": "backup:file:inspect", "path": str(source)})
    assert receipt["operation"] == "inspect" and receipt["memory_count"] == 12
    assert str(source) not in json.dumps(receipt)


def test_recovery_receipts_never_expose_private_reason(bridge):
    bridge.recovery_state = "recovery_required"
    bridge.backup_manager = SimpleNamespace(recovery_status=lambda: {
        "state": "recovery_required", "reason": "private-path-canary /private/file.json secret-token-canary",
    })
    error = ValueError("private-exception-canary")
    error.code = "private-code-canary"
    receipt = stdio_bridge._control_failure("restore_fail_001", "backup:file:import", error)
    serialized = json.dumps(receipt)
    assert "canary" not in serialized and "/private" not in serialized
    assert receipt["outcome"] == "unconfirmed" and receipt["writes_blocked"]


def runtime_fixture(bridge):
    runtime = MvpDesktopRuntime.__new__(MvpDesktopRuntime)
    runtime._logger = logging.getLogger("restore.test")
    runtime._closed = False
    runtime._owner_thread = threading.get_ident()
    runtime._restore_lock = asyncio.Lock()
    runtime._restore_generation = 0
    runtime._recovery_state = "clean"
    runtime._recovery_reason = ""
    runtime._tasks = []
    runtime._session = SimpleNamespace(conversation_summary=None)
    runtime._memory = SimpleNamespace(_pending_injection=[])
    runtime._diary = None
    runtime._start_background_tasks = lambda: None
    calls = []
    class Manager:
        def prepare_file(self, path, **kwargs):
            return SimpleNamespace(path=path, options=kwargs)
        def restore_prepared(self, prepared, **kwargs):
            calls.append((threading.get_ident(), prepared.path, prepared.options))
            return {"outcome": "committed"}
        def discard_prepared(self, _prepared):
            pass
        def recovery_status(self):
            return {"recovery_state": "clean", "reason": ""}
    runtime._backup_manager = Manager()
    bridge.backup_manager = runtime._backup_manager
    return runtime, calls


@pytest.mark.asyncio
async def test_restore_awaits_underlying_thread_writer_before_owner_thread_apply(bridge, monkeypatch, tmp_path):
    runtime, calls = runtime_fixture(bridge)
    import src.backup_inspection as inspection
    monkeypatch.setattr(inspection, "inspect_backup_file", lambda _path: SimpleNamespace(sha256="f" * 64, file_bytes=12))
    started, release, completed = threading.Event(), threading.Event(), threading.Event()
    def writer():
        started.set()
        release.wait(3)
        completed.set()
    worker = asyncio.create_task(_await_thread_writer(writer))
    runtime._tasks.append(worker)
    while not started.is_set():
        await asyncio.sleep(0.001)
    restore = asyncio.create_task(runtime.restore_file(tmp_path / "backup.json"))
    try:
        while runtime._recovery_state != "recovering":
            await asyncio.sleep(0.001)
        await asyncio.sleep(0.01)
        assert calls == [] and not completed.is_set()
        assert ws_bridge.recovery_status_payload()["writes_blocked"]
        release.set()
        result = await restore
        assert result["outcome"] == "committed" and completed.is_set()
        assert calls[0][0] == threading.get_ident()
        assert calls[0][2]["expected_sha256"] == "f" * 64
        assert runtime._session.restore_generation == 1
    finally:
        release.set()
        await asyncio.gather(worker, restore, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("locks", [False, True])
async def test_prepare_failure_quiesces_only_when_core_locks(bridge, monkeypatch, tmp_path, locks):
    runtime, calls = runtime_fixture(bridge)
    from src.backup_inspection import BackupRestoreError
    import src.backup_inspection as inspection
    monkeypatch.setattr(inspection, "inspect_backup_file", lambda _path: SimpleNamespace(sha256="f" * 64, file_bytes=12))
    state = "clean"
    def prepare(*_args, **_kwargs):
        nonlocal state
        state = "recovery_required" if locks else "clean"
        raise BackupRestoreError("synthetic rejection", code="BACKUP_RECOVERY_REQUIRED" if locks else "BACKUP_INVALID_FORMAT")
    runtime._backup_manager.prepare_file = prepare
    runtime._backup_manager.recovery_status = lambda: {"state": state, "reason": ""}
    writer = asyncio.create_task(asyncio.sleep(60))
    runtime._tasks = [writer]
    try:
        with pytest.raises(BackupRestoreError):
            await runtime.restore_file(tmp_path / "bad.json")
        assert calls == []
        assert writer.cancelled() is locks
        assert runtime._restore_generation == (1 if locks else 0)
        assert runtime._recovery_state == ("recovery_required" if locks else "clean")
        if locks:
            with pytest.raises(RuntimeError, match="blocks runtime writes"):
                runtime.require_writable()
        else:
            assert runtime._tasks == [writer]
    finally:
        writer.cancel()
        await asyncio.gather(writer, return_exceptions=True)


@pytest.mark.asyncio
async def test_late_deferred_commit_cannot_write_after_restore_generation_changed():
    session = ChatSession.__new__(ChatSession)
    session._committed_request_ids = set()
    session.restore_generation = 2
    session.require_runtime_writable = lambda: None
    with pytest.raises(RuntimeError, match="before restore"):
        await session.commit_exchange(request_id="late_restore_001", user_message="synthetic", result={
            "reply": "synthetic", "_commit_context": {"request_id": "late_restore_001", "restore_generation": 1},
        })


@pytest.mark.asyncio
async def test_wrong_thread_restore_rejects_before_inspection(bridge, monkeypatch, tmp_path):
    runtime, calls = runtime_fixture(bridge)
    import src.backup_inspection as inspection
    monkeypatch.setattr(inspection, "inspect_backup_file", lambda _path: pytest.fail("wrong-thread inspection entered"))
    with pytest.raises(ValueError) as caught:
        await asyncio.to_thread(lambda: asyncio.run(runtime.restore_file(tmp_path / "restore.json")))
    assert caught.value.code == "BACKUP_RESTORE_DISABLED" and calls == []


@pytest.mark.asyncio
async def test_locked_shutdown_does_not_project_user_state(bridge):
    runtime, _calls = runtime_fixture(bridge)
    runtime._recovery_state = "recovery_required"
    runtime._user_manager = SimpleNamespace(save=lambda: pytest.fail("locked exit wrote profile"))
    class Session:
        async def close(self):
            pass
    runtime._session = Session()
    runtime._memory = SimpleNamespace(store=SimpleNamespace(close=lambda: None))
    await runtime.close()


@pytest.mark.asyncio
async def test_shutdown_prevents_a_deferred_startup_replay_from_starting(bridge):
    runtime, _calls = runtime_fixture(bridge)
    runtime._closed = True
    runtime._startup_recovery_pending = True
    runtime._startup_recovery_scheduled = False
    runtime._backup_manager.recover_interrupted_restore = lambda: pytest.fail("closed startup replay entered")
    runtime.start_startup_recovery()
    await runtime._recover_startup()
    assert runtime._tasks == [] and not runtime._startup_recovery_scheduled


def test_deferred_load_does_not_project_user_relationship_or_carryover(tmp_path):
    class Documents:
        def read_private_document(self, _name):
            return None
        def write_private_document(self, *_args):
            pytest.fail("Load-only constructor wrote a projection")
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    profile = user_dir / "profile.json"
    profile.write_text('{"name":"synthetic","session_count":4}')
    emotion_file = tmp_path / "emotion.json"
    emotion_file.write_text('{"values":{"joy":22},"last_updated":"2000-01-01T00:00:00"}')
    relationship_file = tmp_path / "relationship.json"
    relationship_file.write_text('{"intimacy":321}')
    documents = Documents()
    user = UserManager(user_dir, document_store=documents, defer_startup_writes=True)
    emotion = EmotionSystem(state_path=emotion_file, document_store=documents, defer_startup_writes=True)
    relationship = RelationshipTracker(state_path=relationship_file, document_store=documents, defer_startup_writes=True)
    assert user.profile.session_count == 4 and profile.exists()
    assert emotion._last_updated == "2000-01-01T00:00:00" and emotion_file.exists()
    assert relationship.intimacy == 321 and relationship_file.exists()


@pytest.mark.parametrize("deferred", [True, False])
def test_malformed_legacy_emotional_memories_are_untouched_during_load_only(tmp_path, deferred):
    filepath = tmp_path / "emotional_memories.json"
    original = b'{"memories": [synthetic malformed legacy bytes'
    filepath.write_bytes(original)
    manager = UserManager(tmp_path, defer_startup_writes=deferred)
    assert manager.emotional_memories == []
    quarantined = list(tmp_path.glob("emotional_memories.corrupt-*.json"))
    if deferred:
        assert filepath.read_bytes() == original and quarantined == []
        assert list(tmp_path.iterdir()) == [filepath]
    else:
        assert not filepath.exists() and len(quarantined) == 1
        assert quarantined[0].read_bytes() == original


def test_calendar_load_only_does_not_seed_merge_or_repair(tmp_path):
    from src.world import WorldClock
    calendar_dir = tmp_path / "existing"
    calendar_dir.mkdir()
    calendar = calendar_dir / "holidays.json"
    initial = '{"years":{"2020":{"holidays":{"2020-01-01":"synthetic"},"adjusted_workdays":{}}}}'
    calendar.write_text(initial)
    clock = WorldClock(data_dir=calendar_dir, defer_startup_writes=True)
    assert set(clock.export_all()["years"]) == {"2020"}
    assert calendar.read_text() == initial
    missing_dir = tmp_path / "missing"
    empty = WorldClock(data_dir=missing_dir, defer_startup_writes=True)
    assert empty.export_all()["years"] == {} and not missing_dir.exists()
    calendar.write_text("invalid synthetic calendar")
    with pytest.raises(ValueError, match="could not be read"):
        WorldClock(data_dir=calendar_dir, defer_startup_writes=True)
    assert calendar.read_text() == "invalid synthetic calendar"


@pytest.mark.parametrize("pending", [False, True])
def test_tui_bootstrap_probes_legacy_plaintext_intent_without_writing(tmp_path, monkeypatch, pending):
    import sqlite3
    from src.main import _startup_restore_pending
    from src.storage import encrypted_sqlite

    monkeypatch.setattr(encrypted_sqlite, "_storage_key", None)
    legacy = tmp_path / "legacy-world.sqlite3"
    with sqlite3.connect(legacy) as connection:
        connection.execute("CREATE TABLE restore_journal(singleton INTEGER PRIMARY KEY, private_payload TEXT)")
        if pending:
            connection.execute("INSERT INTO restore_journal VALUES(1, 'synthetic private payload')")
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir() if path.is_file()}
    assert _startup_restore_pending(tmp_path / "persona", desktop_bridge=False, legacy_paths=(legacy,)) is pending
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir() if path.is_file()} == before
    assert not (tmp_path / "persona").exists()


def test_tui_bootstrap_refuses_new_journal_without_existing_key(tmp_path, monkeypatch):
    import sqlite3
    from src.main import _startup_restore_pending
    from src.storage import encrypted_sqlite

    monkeypatch.setattr(encrypted_sqlite, "_storage_key", None)
    persona_root = tmp_path / "persona"
    journal = persona_root / "restore" / "restore.sqlite3"
    journal.parent.mkdir(parents=True)
    with sqlite3.connect(journal) as connection:
        connection.execute("CREATE TABLE restore_journal(singleton INTEGER PRIMARY KEY)")
    before = journal.read_bytes()
    assert _startup_restore_pending(persona_root, desktop_bridge=False, legacy_paths=())
    assert journal.read_bytes() == before


def test_unchanged_profile_sync_keeps_existing_ids():
    memory = MemoryManager.__new__(MemoryManager)
    memory.state_scope = None
    row = {"id": "restored_profile_id", "text": "用户档案：名称synthetic"}
    memory.layers = SimpleNamespace(get_permanent_memories=lambda: [row["text"]])
    memory.store = SimpleNamespace(list_by_layer=lambda _layer: [row],
                                   replace_permanent_profile_facts=lambda *_args, **_kwargs: pytest.fail("unchanged IDs replaced"))
    assert memory.sync_user_profile(SimpleNamespace(profile_facts=lambda: [row["text"]])) == 0


def test_complete_diary_replay_deletes_extras_and_persists_preferences(tmp_path):
    persona = default_persona()
    diary = DiaryManager(persona, diary_dir=tmp_path)
    old = DiaryEntry(date="2026-10-01", title="old", content="synthetic", mood="neutral", emotions={})
    new = DiaryEntry(date="2026-10-02", title="new", content="synthetic", mood="neutral", emotions={})
    diary.save_entry(old)
    diary.save_entry(old)
    key_file = tmp_path / "keys" / "diary_key.json"
    key_before = key_file.read_bytes()
    snapshot = {"entries": [new.to_dict()], "missed": ["2026-10-03"],
                "external_highlights": {"2026-10-03": ["synthetic"]},
                "privacy_enabled": False, "peek_enabled": False}
    assert diary.replace_all(snapshot) == 1
    assert diary.replace_all(snapshot) == 1
    assert not (tmp_path / "2026-10-01.json").exists()
    assert not (tmp_path / "2026-10-01.json.bak").exists()
    assert not (tmp_path / "2026-10-02.json.bak").exists()
    assert key_file.read_bytes() == key_before
    reopened = DiaryManager(persona, diary_dir=tmp_path, read_only_crypto=True)
    assert reopened.export_all() == snapshot


def test_strict_diary_snapshot_refuses_unreadable_dates_without_mutating_files(tmp_path):
    diary = DiaryManager(default_persona(), diary_dir=tmp_path)
    entry = DiaryEntry(date="2026-10-01", title="synthetic", content="synthetic", mood="neutral", emotions={})
    diary.save_entry(entry)
    primary = tmp_path / "2026-10-01.json"
    secondary = tmp_path / "2026-10-01.json.bak"
    primary.write_bytes(b"synthetic corrupt primary")
    secondary.write_bytes(b"synthetic corrupt secondary")
    original = {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    assert diary.export_all()["entries"] == []  # Established export projection remains unchanged.
    with pytest.raises(ValueError, match="unreadable"):
        diary.export_for_restore()
    assert {path.relative_to(tmp_path): path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()} == original


@pytest.mark.parametrize("filename,payload", [
    ("missed_queue.json", '{"missed": ["2026-02-31"]}'),
    ("external_highlights.json", '{"2026-10-01": "invalid list"}'),
    ("preferences.json", '{"privacy_enabled": "invalid boolean", "peek_enabled": true}'),
])
def test_strict_diary_snapshot_refuses_malformed_auxiliary_state(tmp_path, filename, payload):
    diary = DiaryManager(default_persona(), diary_dir=tmp_path)
    path = tmp_path / filename
    path.write_text(payload)
    before = path.read_bytes()
    with pytest.raises(ValueError):
        diary.export_for_restore()
    assert path.read_bytes() == before and list(tmp_path.iterdir()) == [path]


def test_strict_diary_snapshot_refuses_missing_key_without_generating_one(tmp_path):
    diary = DiaryManager(default_persona(), diary_dir=tmp_path)
    entry = DiaryEntry(date="2026-10-01", title="synthetic", content="synthetic", mood="neutral", emotions={})
    (tmp_path / "2026-10-01.json").write_text(json.dumps(entry.to_dict()))
    with pytest.raises(ValueError, match="existing encryption key"):
        diary.export_for_restore()
    assert not (tmp_path / "keys").exists()


@pytest.mark.parametrize("date", ["2026-02-31", "2026-10-01/extra", "../2026-10-01"])
def test_diary_replay_validates_every_date_before_writing(tmp_path, date):
    diary = DiaryManager(default_persona(), diary_dir=tmp_path)
    with pytest.raises(ValueError):
        diary.replace_all({"entries": [{"date": date}]})
    assert list(tmp_path.iterdir()) == []
