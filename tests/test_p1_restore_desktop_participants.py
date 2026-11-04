from __future__ import annotations

from contextlib import closing
import json
import os

import pytest
from sqlcipher3 import dbapi2 as sqlcipher

from src.backup import BackupRestoreError
from src.storage import encrypted_sqlite
from tests.p1_restore_support import Graph


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setattr(encrypted_sqlite,"_storage_key",bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite,"_encryption_required",True)


def test_real_optional_desktop_participants_use_separate_restore_journal(tmp_path):
    graph = Graph(tmp_path, desktop_extras=True)
    try:
        graph.seed("after")
        graph.social._upsert_character(character_id="synthetic-colleague",name="合成角色",role="观測员",personality="谨慎",speaking_style="简短",source="test")
        graph.thought.import_all({"schema":"reverie.thought_of_you.v1","items":[{
            "id":"synthetic-thought", "title":"合成观测", "summary":"并非真实网络内容", "topic":"astronomy",
            "source_name":"test", "source_url":"https://example.invalid/synthetic", "source_hash":"f"*64,
            "sanitizer_version":"test", "collected_at":1791849600., "share_after":1791849700.,
            "expires_at":1791849800., "status":"saved", "shared_at":None}]})
        expected = {"calendar":graph.world.export_all(), "thought_of_you":graph.thought.export_all(), "social_universe":graph.social.export_all()}
        backup = tmp_path / "desktop.json"; graph.manager.backup_to_file(backup)
        graph.seed("before")
        graph.thought.import_all({"schema":"reverie.thought_of_you.v1","items":[]})
        graph.social.import_all({"schema":"reverie.social_universe.v1","tables":{key:[] for key in expected["social_universe"]["tables"]}})
        assert graph.journal.path != graph.thought._db.path and graph.journal.path != graph.social.path
        result = graph.manager.restore_from_file(backup)
        graph.assert_fixture("after", target_marker=result["operation_id"])
        observed = graph.manager._export_nonmemory_payload()
        for section,value in expected.items(): assert observed[section] == value
        assert graph.journal.pending_restore() is None
    finally:
        graph.close()


def test_partial_write_and_failed_rollback_retains_encrypted_intent(tmp_path, monkeypatch):
    graph = Graph(tmp_path)
    try:
        graph.seed("after"); backup=tmp_path/"after.json";graph.manager.backup_to_file(backup)
        graph.seed("before")
        def fail(_data): raise OSError("synthetic rollback failure")
        monkeypatch.setattr(graph.diary,"replace_all",fail)
        with pytest.raises(BackupRestoreError) as error: graph.manager.restore_from_file(backup)
        assert error.value.code == "BACKUP_RECOVERY_REQUIRED"
        assert graph.manager.recovery_state == "recovery_required"
        assert graph.journal.pending_restore() is not None
        # Memory commit did not happen, but other participants cannot yet be
        # called consistent: keep the recovery intent and explicit write lock.
        assert graph.memory.store.catalog.metadata_get("full_restore_marker") == "fixture-before-marker"
        assert graph.journal.path.read_bytes()[:16] != encrypted_sqlite.SQLITE_HEADER
    finally:
        graph.close()


def test_unsupported_intent_version_cannot_replay_or_checkpoint(tmp_path):
    graph = Graph(tmp_path)
    try:
        graph.seed("before")
        before = graph.manager._snapshot(include_memory=False)
        before["_memory_restore_marker"] = "fixture-before-marker"
        after = {**before, "_memory_restore_marker":"new-target"}
        graph.journal.prepare_restore(before,after,operation_id="new-target")
        with closing(graph.journal._connect()) as connection:
            connection.execute("UPDATE restore_journal SET intent_version=999")
        initial = graph.observable()
        assert graph.manager.recover_interrupted_restore() is False
        assert graph.observable() == initial and graph.manager.recovery_state == "recovery_required"
        with pytest.raises(BackupRestoreError): graph.manager.checkpoint()
    finally:
        graph.close()


def test_wrong_key_does_not_recreate_recovery_journal_or_memory(tmp_path, monkeypatch):
    graph=Graph(tmp_path);graph.seed("before")
    paths=[graph.journal.path,graph.memory.store.catalog.path,graph.kernel.path]
    graph.close(); original={path:path.read_bytes() for path in paths}
    monkeypatch.setattr(encrypted_sqlite,"_storage_key",bytearray(os.urandom(32)))
    with pytest.raises((encrypted_sqlite.EncryptedStorageError, sqlcipher.DatabaseError)):
        Graph(tmp_path)
    assert all(path.read_bytes()==raw for path,raw in original.items())


@pytest.mark.parametrize("damaged", ["entry", "queue", "preferences"])
def test_unreadable_before_snapshot_rejects_without_deleting_originals(tmp_path, damaged):
    graph=Graph(tmp_path)
    try:
        graph.seed("after");backup=tmp_path/"known-good.json";graph.manager.backup_to_file(backup)
        graph.seed("before")
        paths = ([graph.diary.diary_dir/"2026-10-11.json",graph.diary.diary_dir/"2026-10-11.json.bak"]
                 if damaged=="entry" else [graph.diary.missed_file if damaged=="queue" else graph.diary.preferences_file])
        for path in paths: path.write_bytes(b'{broken-synthetic-state')
        database_before={path:path.read_bytes() for path in [graph.kernel.path,graph.memory.store.catalog.path]}
        with pytest.raises(ValueError): graph.manager.restore_from_file(backup)
        assert graph.journal.pending_restore() is None
        assert all(path.read_bytes()==b'{broken-synthetic-state' for path in paths)
        assert all(path.read_bytes()==raw for path,raw in database_before.items())
    finally:
        graph.close()


def test_file_exports_only_unconfirmed_marker_when_locked(tmp_path):
    graph=Graph(tmp_path)
    try:
        graph.seed("before")
        clean=tmp_path/'clean.json';graph.manager.backup_to_file(clean)
        assert 'export_state' not in json.loads(clean.read_text())
        before=graph.manager._snapshot(include_memory=False)
        before['_memory_restore_marker']='fixture-before-marker'
        graph.journal.prepare_restore(before,{**before,'_memory_restore_marker':'unknown-target'},operation_id='unknown-target')
        graph.memory.store.catalog.metadata_set('full_restore_marker','unrecognized-marker')
        assert not graph.manager.recover_interrupted_restore()
        marked=tmp_path/'unconfirmed.json';graph.manager.backup_to_file(marked)
        payload=json.loads(marked.read_text())
        assert next(iter(payload))=='export_state'
        assert payload['export_state']=={'consistency':'unconfirmed','reason':'restore_terminal_unconfirmed'}
        from src.backup_inspection import inspect_backup_file
        with pytest.raises(BackupRestoreError) as error: inspect_backup_file(marked)
        assert error.value.code=='BACKUP_UNCONFIRMED_EXPORT'
    finally:
        graph.close()
