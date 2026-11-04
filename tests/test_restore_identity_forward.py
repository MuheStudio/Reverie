"""Only a clean, strictly newer identity may advance an existing journal."""
from __future__ import annotations

from contextlib import closing
import json
from types import SimpleNamespace

import pytest

from src.backup import BACKUP_SCHEMA, LocalBackupManager
from src.backup_inspection import BackupRestoreError
from src.persona.persona_card import Persona, default_persona
from src.world_state_store import WorldStateStore
from tests.persona_profile_support import cipher_key


def identity(version=2, fingerprint="a" * 64, persona_id="isolated-persona"):
    return {"persona_id": persona_id, "fingerprint": fingerprint, "identity_version": version}


def recorded(store):
    with closing(store._connect(read_only=True)) as connection:
        return json.loads(connection.execute("SELECT identity FROM recovery_identity WHERE singleton=1").fetchone()[0])


def test_clean_higher_version_advances_identity_and_appends_audit_atomically(tmp_path, cipher_key):
    before, after = identity(), identity(3, "b" * 64)
    old = WorldStateStore(tmp_path / "journal.sqlite3", persona_identity=before)
    old.checkpoint({"synthetic": "preserved"})
    new = WorldStateStore(old.path, persona_identity=after)
    assert recorded(new) == after and new.persona_identity == after
    assert new.pending_restore() is None
    assert new.load_active() == {"synthetic": "preserved"}
    new.checkpoint({"synthetic": "new write"})
    assert new.load_active() == {"synthetic": "new write"}
    with closing(new._connect(read_only=True)) as connection:
        rows = connection.execute("SELECT * FROM recovery_identity_advances ORDER BY sequence").fetchall()
    assert len(rows) == 1
    assert json.loads(rows[0]["previous_identity"]) == before
    assert json.loads(rows[0]["current_identity"]) == after
    assert rows[0]["advanced_at"]
    WorldStateStore(old.path, persona_identity=after)
    with closing(new._connect(read_only=True)) as connection:
        assert connection.execute("SELECT COUNT(*) FROM recovery_identity_advances").fetchone()[0] == 1


@pytest.mark.parametrize("target,pending", [(identity(3, "b" * 64, "foreign"), False),
    (identity(2, "b" * 64), False), (identity(1, "b" * 64), False),
    (identity(3, "b" * 64), True)])
def test_rejected_bind_never_updates_identity_or_creates_forward_table(tmp_path, cipher_key, target, pending):
    store = WorldStateStore(tmp_path / "journal.sqlite3", persona_identity=identity())
    if pending:
        store.prepare_restore({"_memory_restore_marker": "before"}, {"_memory_restore_marker": "after"})
    original_bytes = store.path.read_bytes()
    with pytest.raises(BackupRestoreError) as error:
        WorldStateStore(store.path, persona_identity=target)
    assert error.value.code == "BACKUP_RECOVERY_REQUIRED"
    assert store.path.read_bytes() == original_bytes
    assert recorded(store) == identity()
    with closing(store._connect(read_only=True)) as connection:
        assert connection.execute("SELECT 1 FROM sqlite_master WHERE name='recovery_identity_advances'").fetchone() is None


def test_corrupt_pending_intent_cannot_be_bypassed_by_forward_version(tmp_path, cipher_key):
    store = WorldStateStore(tmp_path / "journal.sqlite3", persona_identity=identity())
    store.prepare_restore({"_memory_restore_marker": "before"}, {"_memory_restore_marker": "after"})
    with closing(store._connect()) as connection:
        connection.execute("UPDATE restore_journal SET after_payload='{}'")
    before = store.path.read_bytes()
    with pytest.raises(BackupRestoreError) as error:
        WorldStateStore(store.path, persona_identity=identity(3, "b" * 64))
    assert error.value.code == "BACKUP_RECOVERY_REQUIRED"
    assert store.path.read_bytes() == before


def test_forward_update_and_audit_roll_back_together_on_failure(tmp_path, cipher_key):
    store = WorldStateStore(tmp_path / "journal.sqlite3", persona_identity=identity())
    def fail(stage):
        if stage == "identity_advanced":
            raise OSError("isolated failure before commit")
    store._fault_hook = fail
    with pytest.raises(OSError):
        store.bind_identity(identity(3, "b" * 64))
    assert store.persona_identity == identity() and recorded(store) == identity()
    with closing(store._connect(read_only=True)) as connection:
        assert connection.execute("SELECT 1 FROM sqlite_master WHERE name='recovery_identity_advances'").fetchone() is None


def test_forward_journal_does_not_relax_exported_backup_identity(tmp_path, cipher_key):
    original = default_persona()
    old = original.identity_envelope
    data = original.to_dict()
    data["identity"]["identity_version"] = old.version + 1
    data["backstory"] += "隔离升版。"
    updated = Persona(**data)
    new = updated.seal_identity()
    journal = WorldStateStore(tmp_path / "journal.sqlite3", persona_identity={
        "persona_id": old.persona_id, "fingerprint": old.fingerprint, "identity_version": old.version})
    journal.bind_identity({"persona_id": new.persona_id, "fingerprint": new.fingerprint, "identity_version": new.version})
    manager = LocalBackupManager(memory=SimpleNamespace(persona=updated), emotion=None,
        relationship=None, diary=None, user_manager=None, state_store=journal)
    assert manager.recovery_status()["state"] == "clean"
    payload = {"schema": BACKUP_SCHEMA, "memory": [], "emotion": {}, "relationship": {},
        "user": {}, "diary": {}, "persona_identity": {
            "persona_id": old.persona_id, "fingerprint": old.fingerprint, "identity_version": old.version}}
    with pytest.raises(BackupRestoreError) as error:
        manager._validate_payload(payload)
    assert error.value.code == "BACKUP_PERSONA_MISMATCH"


def test_pending_intent_identity_stays_exact_after_any_forward_record(tmp_path, cipher_key):
    store = WorldStateStore(tmp_path / "journal.sqlite3", persona_identity=identity())
    newer = identity(3, "b" * 64)
    store.bind_identity(newer)
    store.prepare_restore({"_memory_restore_marker": "before"}, {"_memory_restore_marker": "after"})
    with closing(store._connect()) as connection:
        connection.execute("UPDATE restore_journal SET persona_identity=?", (json.dumps(identity()),))
    with pytest.raises(BackupRestoreError) as error:
        store.pending_restore()
    assert error.value.code == "BACKUP_RECOVERY_REQUIRED"
