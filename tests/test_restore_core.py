"""Core restore checks use actual SQLCipher journals and memory transactions."""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import threading

import pytest

from src.backup import BackupRestoreError
from src.backup_inspection import inspect_backup_file
from src.persona.persona_card import default_persona
from src.storage import encrypted_sqlite
from src.world_state_store import WorldStateStore
from tests.p1_restore_support import Graph


@pytest.fixture
def cipher_key(monkeypatch):
    monkeypatch.setattr(encrypted_sqlite,"_storage_key",bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite,"_encryption_required",True)
    monkeypatch.delenv("REVERIE_STORAGE_KEY_FD",raising=False)
    monkeypatch.delenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE",raising=False)


def identity():
    envelope = default_persona().identity_envelope
    return {"persona_id":envelope.persona_id,"fingerprint":envelope.fingerprint,"identity_version":envelope.version}


def targets():
    return ({"_memory_restore_marker":"before","secret":"before-private"},
            {"_memory_restore_marker":"after","secret":"after-private"})


def test_journal_requires_existing_key(tmp_path,monkeypatch):
    monkeypatch.setattr(encrypted_sqlite,"_storage_key",None)
    monkeypatch.setattr(encrypted_sqlite,"_encryption_required",False)
    with pytest.raises(encrypted_sqlite.EncryptedStorageError,match="existing"):
        WorldStateStore(tmp_path/"journal.sqlite3",persona_identity=identity())
    assert not list(tmp_path.iterdir())


def test_encrypted_pending_checkpoint_and_conditional_finalize(tmp_path,cipher_key):
    store = WorldStateStore(tmp_path/"journal.sqlite3",persona_identity=identity())
    before,after = targets()
    intent = store.prepare_restore(before,after,operation_id="op-original")
    assert store.path.read_bytes()[:16] != encrypted_sqlite.SQLITE_HEADER
    assert b"before-private" not in store.path.read_bytes()
    with pytest.raises(BackupRestoreError):
        store.checkpoint(before)
    with pytest.raises(BackupRestoreError):
        store.finalize_restore("different-op",intent.intent_version,outcome="after",payload=after)
    with pytest.raises(BackupRestoreError):
        store.prepare_restore(before,after,operation_id="new-op")
    assert store.pending_restore() == intent
    store.finalize_restore(intent.operation_id,intent.intent_version,outcome="after",payload=after)
    assert store.pending_restore() is None
    assert store.load_active() == after
    assert store.confirm_finalized(intent.operation_id,intent.intent_version,outcome="after",payload=after)


def test_persona_binding_and_journal_checksum_fail_closed(tmp_path,cipher_key):
    store = WorldStateStore(tmp_path/"journal.sqlite3",persona_identity=identity())
    before,after = targets()
    store.prepare_restore(before,after)
    foreign = {**identity(),"fingerprint":"foreign-fingerprint"}
    with pytest.raises(BackupRestoreError):
        WorldStateStore(store.path,persona_identity=foreign)
    with closing(store._connect()) as connection:
        connection.execute("UPDATE restore_journal SET after_payload='{}'")
    with pytest.raises(BackupRestoreError,match="checksum"):
        WorldStateStore.peek_pending(store.path)
    with pytest.raises(BackupRestoreError):
        store.checkpoint(before)


def test_readonly_marker_classification_has_three_directions(tmp_path,cipher_key):
    store = WorldStateStore(tmp_path/"journal.sqlite3",persona_identity=identity())
    before,after = targets()
    intent = store.prepare_restore(before,after)
    assert intent.classify_marker("before") == "before"
    assert intent.classify_marker("after") == "after"
    assert intent.classify_marker("foreign") == "unknown"
    assert intent.classify_marker(None) == "unknown"
    assert WorldStateStore.peek_pending(store.path) == intent


def test_rescue_archives_and_replaces_intent_atomically(tmp_path,cipher_key):
    store = WorldStateStore(tmp_path/"journal.sqlite3",persona_identity=identity())
    before,after = targets()
    old = store.prepare_restore(before,after,operation_id="old-op")
    store.stage_memory("old-op",[{"id":"old-target","text":"old private target","layer":"permanent"}])
    def fail(name):
        if name == "rescue_preserved":
            raise OSError("test interruption")
    store._fault_hook = fail
    with pytest.raises(OSError):
        store.prepare_restore(before,{**after,"_memory_restore_marker":"rescue-marker"},operation_id="rescue-op",rescue=True)
    assert store.pending_restore() == old
    with closing(store._connect(read_only=True)) as connection:
        assert connection.execute("SELECT count(*) FROM restore_archives").fetchone()[0] == 0
    store._fault_hook = None
    rescued = store.prepare_restore(before,{**after,"_memory_restore_marker":"rescue-marker"},operation_id="rescue-op",rescue=True)
    assert rescued.operation_id == "rescue-op"
    with closing(store._connect(read_only=True)) as connection:
        assert connection.execute("SELECT operation_id FROM restore_archives").fetchone()[0] == "old-op"
    assert list(store.iter_staged_memory("old-op"))[0]["id"] == "old-target"
    store.discard_staging("old-op")
    assert list(store.iter_staged_memory("old-op"))
    assert b"old private target" not in store.path.read_bytes()


@pytest.mark.parametrize("position",["first","middle","last"])
def test_unconfirmed_marker_inspected_anywhere_without_staging(tmp_path,position):
    fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    marker = {"export_state":{"consistency":"unconfirmed","reason":"restore_terminal_unconfirmed"}}
    if position == "first":
        payload = {**marker,**payload}
    elif position == "middle":
        payload = {"schema":payload.pop("schema"),**marker,**payload}
    else:
        payload.update(marker)
    path = tmp_path/"unconfirmed.json"
    path.write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")
    with pytest.raises(BackupRestoreError) as error:
        inspect_backup_file(path)
    assert error.value.code == "BACKUP_UNCONFIRMED_EXPORT"
    assert [p.name for p in tmp_path.iterdir()] == [path.name]


def test_inspection_streams_huge_skipped_value_before_late_marker(tmp_path):
    path = tmp_path/"late.json"
    with path.open("w",encoding="utf-8") as stream:
        stream.write('{"unknown_padding":"')
        for _ in range(5):
            stream.write("x"*(1024*1024))
        stream.write('","export_state":{"consistency":"unconfirmed"}}')
    with pytest.raises(BackupRestoreError) as error:
        inspect_backup_file(path)
    assert error.value.code == "BACKUP_UNCONFIRMED_EXPORT"
    assert len(list(tmp_path.iterdir())) == 1


def test_inspection_rejects_nested_duplicates_and_nonfinite(tmp_path):
    fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
    text = fixture.read_text(encoding="utf-8")
    for corrupt in (text.replace('"joy": 55.0','"joy": 55.0,"joy": 56.0'),
                    text.replace('"joy": 55.0','"joy": NaN')):
        path = tmp_path/"invalid.json"
        path.write_text(corrupt,encoding="utf-8")
        with pytest.raises(BackupRestoreError) as error:
            inspect_backup_file(path)
        assert error.value.code == "BACKUP_INVALID_FORMAT"


@pytest.mark.parametrize("change",[
    {"persona_id":"private-id-canary"*10000},
    {"fingerprint":"private-fingerprint-canary"*10000},
    {"identity_version":2**31},
    {"identity_version":True},
    {"unknown_private_field":"private-content-canary"*10000},
])
def test_inspection_metadata_is_bounded_and_never_echoes_unknown_fields(tmp_path,change):
    fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
    payload = json.loads(fixture.read_text(encoding="utf-8"))
    payload["persona_identity"].update(change)
    path = tmp_path/"metadata.json";path.write_text(json.dumps(payload),encoding="utf-8")
    with pytest.raises(BackupRestoreError) as error:
        inspect_backup_file(path)
    assert error.value.code == "BACKUP_INVALID_FORMAT"
    assert "canary" not in str(error.value)
    valid = inspect_backup_file(fixture).as_dict()
    assert set(valid["persona_identity"]) == {"persona_id","fingerprint","identity_version"}


def test_inspection_rejects_marker_before_parsing_its_unbounded_reason(tmp_path):
    path = tmp_path/"marker.json"
    path.write_text('{"export_state":{"consistency":"unconfirmed","reason":"unterminated')
    with pytest.raises(BackupRestoreError) as error:
        inspect_backup_file(path)
    assert error.value.code == "BACKUP_UNCONFIRMED_EXPORT"


def test_old_v3_fixture_restores_through_encrypted_core(tmp_path,cipher_key):
    graph = Graph(tmp_path/"graph")
    try:
        graph.seed("before")
        fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
        result = graph.manager.restore_from_file(fixture)
        assert result["outcome"] == "committed"
        assert result["memory"] == 2
        assert sorted(row["id"] for row in graph.memory.export_all()) == ["compat-v3-memory-001","compat-v3-memory-002"]
        assert graph.user.profile.nickname == "小星"
        assert graph.emotion.values["joy"] == 55.0
        assert graph.relationship.intimacy == 120
        assert [entry["date"] for entry in graph.diary.export_all()["entries"]] == ["2026-10-12"]
        assert graph.journal.pending_restore() is None
        assert graph.manager.recovery_state == "clean"
    finally:
        graph.close()


@pytest.mark.parametrize("fault",["after_memory_commit","after_finalize_commit"])
def test_exception_after_actual_commit_is_confirmed_readonly(tmp_path,cipher_key,fault):
    target = Graph(tmp_path/"target")
    destination = Graph(tmp_path/"destination")
    try:
        target.seed("after"); destination.seed("before")
        path = tmp_path/"target.json"; target.manager.backup_to_file(path)
        def fail(name):
            if name == fault:
                raise OSError("exception after actual commit")
        destination.manager._fault_hook = fail
        destination.journal._fault_hook = fail
        result = destination.manager.restore_from_file(path)
        assert result["outcome"] == "committed"
        destination.assert_fixture("after",target_marker=result["operation_id"])
        assert destination.journal.pending_restore() is None
    finally:
        target.close(); destination.close()


def test_failed_rescue_before_commit_remains_locked_after_restart(tmp_path,cipher_key):
    target = Graph(tmp_path/"target")
    destination = Graph(tmp_path/"destination")
    try:
        target.seed("after"); destination.seed("before")
        path = tmp_path/"target.json"; target.manager.backup_to_file(path)
        def unknown(name):
            if name == "before_readonly_probe":
                raise OSError("readonly unavailable")
        destination.manager._fault_hook = unknown
        with pytest.raises(BackupRestoreError):
            destination.manager.restore_from_file(path)
        old_operation = destination.journal.pending_restore().operation_id
        destination.memory.store.catalog.metadata_set("full_restore_marker","unknown-marker")
        def fail_before(name):
            if name == "before_memory_commit":
                raise OSError("rescue before commit")
        destination.manager._fault_hook = fail_before
        destination.journal._fault_hook = fail_before
        with pytest.raises(BackupRestoreError):
            destination.manager.restore_from_file(path,rescue=True)
        pending = destination.journal.pending_restore()
        assert pending is not None and pending.operation_id != old_operation
        assert pending.before["_restore_before_confirmed"] is False
        destination.close()
        destination = Graph(tmp_path/"destination")
        assert not destination.manager.recover_interrupted_restore()
        assert destination.manager.recovery_state == "recovery_required"
        assert destination.journal.pending_restore() is not None
        exported = destination.manager.export_payload()
        assert next(iter(exported)) == "export_state"
        assert exported["export_state"] == {"consistency":"unconfirmed","reason":"restore_terminal_unconfirmed"}
    finally:
        target.close(); destination.close()


def test_prepare_validates_before_quiescence_and_does_not_capture_managers(tmp_path,cipher_key,monkeypatch):
    graph = Graph(tmp_path/"graph")
    try:
        graph.seed("before")
        fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
        monkeypatch.setattr(graph.manager,"_snapshot",lambda **kwargs: (_ for _ in ()).throw(AssertionError("no capture during preparation")))
        prepared = graph.manager.prepare_file(fixture)
        assert graph.journal.pending_restore() is None
        assert graph.journal.load_staged_target(prepared.operation_id)[1] == 2
        assert graph.journal.path.read_bytes()[:16] != encrypted_sqlite.SQLITE_HEADER
        graph.manager.discard_prepared(prepared)
        payload = json.loads(fixture.read_text(encoding="utf-8"))
        payload["memory"].append(dict(payload["memory"][0]))
        path = tmp_path/"duplicate.json"; path.write_text(json.dumps(payload),encoding="utf-8")
        with pytest.raises(BackupRestoreError) as error:
            graph.manager.prepare_file(path)
        assert error.value.code == "BACKUP_INVALID_FORMAT"
        assert graph.journal.pending_restore() is None
    finally:
        graph.close()


@pytest.mark.parametrize("invalid",["thought_status","social_foreign_key","calendar_year"])
def test_desktop_participant_constraints_fail_during_preparation(tmp_path,cipher_key,monkeypatch,invalid):
    graph = Graph(tmp_path/"graph",desktop_extras=True)
    try:
        graph.seed("before")
        payload = graph.manager.export_payload()
        if invalid == "thought_status":
            payload["thought_of_you"]["items"] = [{"id":"bad-status","title":"synthetic","summary":"synthetic",
                "topic":"test","source_name":"test","source_url":"https://example.invalid/", "source_hash":"f"*64,
                "sanitizer_version":"test","collected_at":1.,"share_after":2.,"expires_at":3.,"status":"pending","shared_at":None}]
        elif invalid == "social_foreign_key":
            payload["social_universe"]["tables"]["social_group_members"] = [
                {"thread_id":"absent-thread","character_id":"absent-character","position":0}]
        else:
            payload["calendar"]["years"] = {"invalid-year":{}}
        path = tmp_path/"bad-participant.json";path.write_text(json.dumps(payload),encoding="utf-8")
        initial = graph.observable()
        monkeypatch.setattr(graph.manager,"_snapshot",lambda **kwargs: (_ for _ in ()).throw(AssertionError("no capture before valid preparation")))
        with pytest.raises(BackupRestoreError) as error:
            graph.manager.prepare_file(path)
        assert error.value.code == "BACKUP_INVALID_FORMAT"
        assert graph.journal.pending_restore() is None
        assert graph.observable() == initial
    finally:
        graph.close()


def test_owner_thread_restore_is_enforced(tmp_path,cipher_key):
    graph = Graph(tmp_path/"graph")
    failures = []
    try:
        def wrong_thread():
            try:
                graph.manager.checkpoint()
            except Exception as exc:
                failures.append(exc)
        worker = threading.Thread(target=wrong_thread); worker.start(); worker.join()
        assert len(failures) == 1 and "owner thread" in str(failures[0])
    finally:
        graph.close()


def test_midstream_exception_closes_stage_cursor_before_rollback(tmp_path,cipher_key,monkeypatch):
    graph = Graph(tmp_path/"graph")
    try:
        graph.seed("before")
        fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
        def fail_midstream(records,**_kwargs):
            assert next(records)["id"] == "compat-v3-memory-001"
            raise OSError("synthetic midstream read failure")
        monkeypatch.setattr(graph.memory,"import_stream",fail_midstream)
        with pytest.raises(BackupRestoreError) as error:
            graph.manager.restore_from_file(fixture)
        assert error.value.code == "BACKUP_ROLLED_BACK"
        graph.assert_fixture("before")
        assert graph.manager.recovery_state == "clean"
        assert graph.journal.pending_restore() is None
        with closing(graph.journal._connect(read_only=True)) as connection:
            assert connection.execute("SELECT count(*) FROM restore_staging").fetchone()[0] == 0
    finally:
        graph.close()


def test_partial_old_v3_cannot_rescue_unconfirmed_optional_state(tmp_path,cipher_key,monkeypatch):
    graph = Graph(tmp_path/"graph",desktop_extras=True)
    try:
        graph.seed("before")
        before = graph.manager._snapshot(include_memory=False)
        before["_memory_restore_marker"] = "fixture-before-marker"
        after = {**before,"_memory_restore_marker":"unconfirmed-target-marker"}
        pending = graph.journal.prepare_restore(before,after,operation_id="unconfirmed-target-marker")
        graph.memory.store.catalog.metadata_set("full_restore_marker","foreign-marker")
        assert not graph.manager.recover_interrupted_restore()
        fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
        monkeypatch.setattr(graph.journal,"stage_memory",lambda *_args,**_kwargs: (_ for _ in ()).throw(AssertionError("incomplete rescue must not stage")))
        with pytest.raises(BackupRestoreError) as error:
            graph.manager.restore_from_file(fixture,rescue=True)
        assert error.value.code == "BACKUP_INVALID_FORMAT"
        assert graph.journal.pending_restore() == pending
        assert graph.manager.recovery_state == "recovery_required"
        with closing(graph.journal._connect(read_only=True)) as connection:
            assert connection.execute("SELECT count(*) FROM restore_archives").fetchone()[0] == 0
            assert connection.execute("SELECT count(*) FROM restore_staging").fetchone()[0] == 0
    finally:
        graph.close()


def test_complete_restore_refuses_memory_merge_before_staging(tmp_path,cipher_key,monkeypatch):
    graph = Graph(tmp_path/"graph")
    try:
        graph.seed("before")
        fixture = Path(__file__).parent/"fixtures/p1_restore_same_identity_v3.json"
        monkeypatch.setattr(graph.journal,"stage_memory",lambda *_args,**_kwargs: (_ for _ in ()).throw(AssertionError("merge must not stage")))
        with pytest.raises(BackupRestoreError) as error:
            graph.manager.restore_from_file(fixture,replace_memory=False)
        assert error.value.code == "BACKUP_INVALID_FORMAT"
        graph.assert_fixture("before")
        assert graph.journal.pending_restore() is None
    finally:
        graph.close()
