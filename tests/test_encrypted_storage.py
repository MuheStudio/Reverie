from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3

import pytest

from src.kernel.storage import KernelStore
from src.emotion.system import EmotionSystem
from src.relationship.tracker import RelationshipTracker
from src.memory.catalog import MemoryCatalog
from src.memory.sqlite_vec_index import SQLiteVecIndex
from src.user import UserManager
from src.storage import encrypted_sqlite
from src.storage.encrypted_sqlite import (
    SQLITE_HEADER,
    EncryptedStorageError,
    clear_storage_key_for_testing,
    connect_database,
    ensure_encrypted_database,
    initialize_storage_from_environment,
    install_storage_key,
)


@pytest.fixture(autouse=True)
def _isolated_storage_key(monkeypatch):
    clear_storage_key_for_testing()
    monkeypatch.delenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE", raising=False)
    monkeypatch.delenv("REVERIE_STORAGE_KEY_FD", raising=False)
    yield
    clear_storage_key_for_testing()


def _create_plaintext(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
    connection.executemany(
        "INSERT INTO facts(value) VALUES (?)",
        [("alpha",), ("中文记忆",), ("omega",)],
    )
    connection.execute("PRAGMA user_version=7")
    connection.commit()
    connection.close()


def test_bootstrap_reads_exact_key_from_pipe_and_removes_descriptor_environment(
    monkeypatch,
    tmp_path: Path,
) -> None:
    read_fd, write_fd = os.pipe()
    key = os.urandom(32)
    os.write(write_fd, key)
    os.close(write_fd)
    monkeypatch.setenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE", "1")
    monkeypatch.setenv("REVERIE_STORAGE_KEY_FD", str(read_fd))

    assert initialize_storage_from_environment() is True
    assert "REVERIE_STORAGE_KEY_FD" not in os.environ
    database = tmp_path / "bootstrapped.db"
    connection = connect_database(database)
    connection.execute("CREATE TABLE proof(value TEXT)")
    connection.commit()
    connection.close()
    assert database.read_bytes()[:16] != SQLITE_HEADER


def test_required_encryption_without_bootstrap_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE", "1")
    with pytest.raises(EncryptedStorageError, match="bootstrap pipe is missing"):
        initialize_storage_from_environment()


def test_plaintext_database_is_exported_to_sqlcipher_without_losing_rows(
    tmp_path: Path,
) -> None:
    database = tmp_path / "memory.db"
    _create_plaintext(database)
    key = os.urandom(32)

    ensure_encrypted_database(database, key)

    assert database.read_bytes()[:16] != SQLITE_HEADER
    install_storage_key(key)
    connection = connect_database(database, read_only=True)
    rows = connection.execute("SELECT value FROM facts ORDER BY id").fetchall()
    assert [tuple(row) for row in rows] == [
        ("alpha",),
        ("中文记忆",),
        ("omega",),
    ]
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 7
    connection.close()
    assert not list(tmp_path.glob(".*migration*"))
    assert not list(tmp_path.glob(".*migrating*"))


def test_leftover_delete_journal_opens_verify_read_write(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database = tmp_path / "kernel.sqlite3"
    key = os.urandom(32)
    install_storage_key(key)
    connection = connect_database(database)
    connection.execute("CREATE TABLE facts(value TEXT NOT NULL)")
    connection.execute("INSERT INTO facts VALUES ('sealed')")
    connection.commit()
    connection.close()
    journal = Path(f"{database}-journal")
    journal.write_bytes(b"\x00" * 512)
    assert encrypted_sqlite._has_write_sidecar(database) is True

    opened: dict[str, bool] = {}
    original = encrypted_sqlite._open_encrypted

    def wrapped(*args, **kwargs):
        opened["read_only"] = bool(kwargs.get("read_only"))
        # Drop the synthetic sidecar before the real open so garbage bytes
        # cannot poison SQLCipher recovery; the assertion is the open mode.
        journal.unlink(missing_ok=True)
        return original(*args, **kwargs)

    monkeypatch.setattr(encrypted_sqlite, "_open_encrypted", wrapped)
    encrypted_sqlite._verify_encrypted_database(database, key)
    assert opened.get("read_only") is False

    connection = connect_database(database, read_only=True)
    assert connection.execute("SELECT value FROM facts").fetchone()[0] == "sealed"
    connection.close()


def test_wrong_key_never_recreates_or_overwrites_encrypted_database(tmp_path: Path) -> None:
    database = tmp_path / "kernel.db"
    key = os.urandom(32)
    install_storage_key(key)
    connection = connect_database(database)
    connection.execute("CREATE TABLE identity(value TEXT)")
    connection.execute("INSERT INTO identity VALUES ('sealed')")
    connection.commit()
    connection.close()
    original = database.read_bytes()

    clear_storage_key_for_testing()
    install_storage_key(os.urandom(32))
    with pytest.raises(Exception):
        connect_database(database)
    assert database.read_bytes() == original


def test_unsafe_sidecar_rolls_back_to_the_complete_plaintext_source(tmp_path: Path) -> None:
    database = tmp_path / "sidecar.db"
    _create_plaintext(database)
    hostile_sidecar = Path(f"{database}-shm")
    hostile_sidecar.mkdir()
    key = os.urandom(32)

    with pytest.raises(EncryptedStorageError, match="unsafe migration artifact"):
        ensure_encrypted_database(database, key)

    assert database.read_bytes()[:16] == SQLITE_HEADER
    connection = sqlite3.connect(database)
    assert connection.execute("SELECT count(*) FROM facts").fetchone()[0] == 3
    connection.close()
    hostile_sidecar.rmdir()
    ensure_encrypted_database(database, key)
    assert database.read_bytes()[:16] != SQLITE_HEADER


def test_kernel_memory_and_sqlite_vec_share_the_encrypted_connection_policy(
    tmp_path: Path,
) -> None:
    install_storage_key(os.urandom(32))
    kernel_path = tmp_path / "kernel.sqlite3"
    kernel = KernelStore(kernel_path)
    assert kernel.integrity_check() == "ok"
    kernel.close()

    memory_path = tmp_path / "metadata.db"
    catalog = MemoryCatalog(memory_path)
    vector = SQLiteVecIndex(
        memory_path,
        model_version="test:encrypted",
        dimensions=3,
        quantization="float32",
        partitioning=False,
    )
    assert vector.extension_version
    vector.close()
    catalog.close()
    assert kernel_path.read_bytes()[:16] != SQLITE_HEADER
    assert memory_path.read_bytes()[:16] != SQLITE_HEADER


def test_legacy_user_profile_moves_into_the_encrypted_kernel_and_plaintext_is_removed(
    tmp_path: Path,
) -> None:
    install_storage_key(os.urandom(32))
    user_dir = tmp_path / "user"
    user_dir.mkdir()
    profile_path = user_dir / "profile.json"
    profile_path.write_text(
        json.dumps({"nickname": "小星", "age": 23}, ensure_ascii=False),
        encoding="utf-8",
    )
    kernel_path = tmp_path / "kernel.sqlite3"
    kernel = KernelStore(kernel_path)

    user = UserManager(user_dir, document_store=kernel)

    assert user.profile.nickname == "小星"
    assert user.profile.age == 23
    assert profile_path.exists() is False
    assert kernel.read_private_document("user_profile")["nickname"] == "小星"
    user.update_profile({"nickname": "新昵称"})
    reopened = UserManager(user_dir, document_store=kernel)
    assert reopened.profile.nickname == "新昵称"
    kernel.close()
    assert kernel_path.read_bytes()[:16] != SQLITE_HEADER


def test_mvp_persona_state_moves_into_encrypted_kernel_and_plaintext_is_removed(
    tmp_path: Path,
) -> None:
    install_storage_key(os.urandom(32))
    emotion_path = tmp_path / "emotion.json"
    relationship_path = tmp_path / "relationship.json"
    emotion_path.write_text(
        json.dumps(
            {
                "values": {"joy": 77},
                "baseline": {},
                "last_updated": "",
                "enabled": True,
                "carryover_days": 3,
                "inertia_factor": 0.15,
            }
        ),
        encoding="utf-8",
    )
    relationship_path.write_text(
        json.dumps({"intimacy": 720, "interaction_count": 9}),
        encoding="utf-8",
    )
    kernel_path = tmp_path / "kernel.sqlite3"
    kernel = KernelStore(kernel_path)

    emotion = EmotionSystem(state_path=emotion_path, document_store=kernel)
    relationship = RelationshipTracker(
        state_path=relationship_path,
        document_store=kernel,
    )

    assert emotion.values["joy"] == 77
    assert relationship.intimacy == 720
    assert emotion_path.exists() is False
    assert relationship_path.exists() is False
    assert kernel.read_private_document("persona_emotion_state") is not None
    assert kernel.read_private_document("persona_relationship_state") is not None

    reopened_emotion = EmotionSystem(document_store=kernel)
    reopened_relationship = RelationshipTracker(document_store=kernel)
    assert reopened_emotion.values["joy"] == 77
    assert reopened_relationship.intimacy == 720
    kernel.close()
    assert kernel_path.read_bytes()[:16] != SQLITE_HEADER


@pytest.mark.parametrize(
    "stage",
    ["after_plaintext_backup", "after_encrypted_replace"],
)
def test_interrupted_plaintext_migration_recovers_without_orphan_plaintext(
    tmp_path: Path,
    stage: str,
) -> None:
    database = tmp_path / "recover.db"
    _create_plaintext(database)
    key = os.urandom(32)

    def crash(current: str) -> None:
        if current == stage:
            raise SystemExit("simulated process loss")

    with pytest.raises(SystemExit):
        ensure_encrypted_database(database, key, fault_injector=crash)

    ensure_encrypted_database(database, key)
    install_storage_key(key)
    connection = connect_database(database, read_only=True)
    assert connection.execute("SELECT count(*) FROM facts").fetchone()[0] == 3
    connection.close()
    assert database.read_bytes()[:16] != SQLITE_HEADER
    assert not list(tmp_path.glob(".*plaintext-migration-backup"))
    assert not list(tmp_path.glob(".*sqlcipher-migrating"))
