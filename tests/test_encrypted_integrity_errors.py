"""Constraint violations on encrypted connections are recognized like plaintext ones.

sqlcipher3 has its own DB-API exception classes. A clause naming only
sqlite3.IntegrityError let an encrypted constraint violation escape, which made
memory fold-job deduplication fail on the second mount of the same persona.
"""

from __future__ import annotations

import os
from pathlib import Path
import sqlite3

import pytest

from src.memory.catalog import MemoryCatalog
from src.memory.fold_worker import FoldWorker
from src.storage.encrypted_sqlite import (
    SQLITE_HEADER,
    clear_storage_key_for_testing,
    install_storage_key,
    integrity_errors,
)


@pytest.fixture(autouse=True)
def _isolated_storage_key(monkeypatch):
    clear_storage_key_for_testing()
    monkeypatch.delenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE", raising=False)
    monkeypatch.delenv("REVERIE_STORAGE_KEY_FD", raising=False)
    yield
    clear_storage_key_for_testing()


@pytest.fixture
def catalog(tmp_path: Path):
    install_storage_key(os.urandom(32))
    store = MemoryCatalog(tmp_path / "metadata.db")
    worker = FoldWorker(store._connection, store._lock)
    worker.set_catalog(store)
    store._fold_worker = worker
    yield store
    store.close()
    assert (tmp_path / "metadata.db").read_bytes()[:16] != SQLITE_HEADER


def job_keys(store: MemoryCatalog) -> list[str]:
    rows = store._connection.execute("SELECT dedupe_key FROM memory_jobs ORDER BY dedupe_key").fetchall()
    return [row[0] for row in rows]


def test_both_drivers_integrity_errors_are_recognized() -> None:
    from sqlcipher3 import dbapi2 as sqlcipher

    assert not issubclass(sqlcipher.IntegrityError, sqlite3.IntegrityError)
    assert {sqlite3.IntegrityError, sqlcipher.IntegrityError} <= set(integrity_errors())


def test_duplicate_fold_job_on_encrypted_catalog_is_skipped_and_rolled_back(catalog) -> None:
    worker = catalog._fold_worker

    assert worker.enqueue("extract_atoms", {"memory_id": "m1"}, dedupe_key="atoms:m1")
    assert worker.enqueue("extract_atoms", {"memory_id": "m1"}, dedupe_key="atoms:m1") is None
    assert not catalog._connection.in_transaction
    assert worker.enqueue("evidence_check", {"memory_id": "m1"}, dedupe_key="evidence:m1")
    assert job_keys(catalog) == ["atoms:m1", "evidence:m1"]


def test_identity_resync_on_encrypted_catalog_keeps_one_job_per_key(catalog) -> None:
    # A second mount of the same persona re-syncs its identity anchors.
    for _ in range(2):
        catalog.upsert(
            id="identity_0123456789abcdef01234567",
            text="I am a synthetic test persona.",
            retention_layer="permanent",
            cognitive_layer="semantic",
            timestamp=1.0,
            importance=1.0,
            emotions=None,
            embedding_model_version="test:encrypted",
            source_type="persona_identity",
            source_hash="a" * 64,
        )

    assert job_keys(catalog) == [
        "atoms:identity_0123456789abcdef01234567",
        "evidence:identity_0123456789abcdef01234567",
    ]
    assert not catalog._connection.in_transaction
    assert catalog.get("identity_0123456789abcdef01234567") is not None


def test_duplicate_backup_ids_on_encrypted_catalog_are_a_value_error(catalog) -> None:
    record = {"id": "duplicate", "text": "备份里的重复记忆", "retention_layer": "short_term",
              "cognitive_layer": "semantic"}

    with pytest.raises(ValueError, match="duplicate id"):
        catalog.import_records(iter([record, dict(record)]), replace=True)
    assert not catalog._connection.in_transaction
