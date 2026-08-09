"""Crash-recoverable transaction journal for complete local world restores."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config.settings import WORLD_STATE_DB
from .storage.encrypted_sqlite import connect_database


@dataclass(frozen=True)
class RestoreIntent:
    phase: str
    before: dict[str, Any]
    after: dict[str, Any]


class WorldStateStore:
    """Stores snapshots and restore intent in one durable SQLite database."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or WORLD_STATE_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @staticmethod
    def _encode(payload: dict[str, Any]) -> tuple[str, str]:
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return text, hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def _decode(text: str, checksum: str) -> dict[str, Any]:
        actual = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if actual != checksum:
            raise RuntimeError("World-state transaction checksum mismatch")
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise RuntimeError("World-state transaction payload is not an object")
        return payload

    def _connect(self) -> sqlite3.Connection:
        # The complete backup snapshot (memory archive, user profile, diary,
        # emotion/relationship state) is written here, so it must use the same
        # fail-closed SQLCipher path as every other durable database. Without a
        # key the dev/test fallback stays plaintext.
        connection = connect_database(
            self.path,
            timeout=30.0,
            isolation_level=None,
        )
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS active_snapshot (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    payload TEXT NOT NULL,
                    checksum TEXT NOT NULL,
                    committed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS restore_journal (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    phase TEXT NOT NULL CHECK (phase IN ('applying', 'rolling_back')),
                    before_payload TEXT NOT NULL,
                    before_checksum TEXT NOT NULL,
                    after_payload TEXT NOT NULL,
                    after_checksum TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )

    def checkpoint(self, payload: dict[str, Any]) -> None:
        """Atomically replace the authoritative complete snapshot."""
        text, checksum = self._encode(payload)
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = connection.execute(
                    "SELECT checksum FROM active_snapshot WHERE singleton=1"
                ).fetchone()
                if current is not None and str(current[0]) == checksum:
                    connection.execute("DELETE FROM restore_journal WHERE singleton = 1")
                    connection.execute("COMMIT")
                    return
                connection.execute(
                    """
                    INSERT INTO active_snapshot(singleton, payload, checksum, committed_at)
                    VALUES(1, ?, ?, ?)
                    ON CONFLICT(singleton) DO UPDATE SET
                        payload=excluded.payload,
                        checksum=excluded.checksum,
                        committed_at=excluded.committed_at
                    """,
                    (text, checksum, now),
                )
                connection.execute("DELETE FROM restore_journal WHERE singleton = 1")
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def prepare_restore(self, before: dict[str, Any], after: dict[str, Any]) -> None:
        """Durably record recovery direction before any manager file is changed."""
        before_text, before_checksum = self._encode(before)
        after_text, after_checksum = self._encode(after)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    INSERT INTO restore_journal(
                        singleton, phase, before_payload, before_checksum,
                        after_payload, after_checksum, created_at
                    ) VALUES(1, 'applying', ?, ?, ?, ?, ?)
                    ON CONFLICT(singleton) DO UPDATE SET
                        phase='applying',
                        before_payload=excluded.before_payload,
                        before_checksum=excluded.before_checksum,
                        after_payload=excluded.after_payload,
                        after_checksum=excluded.after_checksum,
                        created_at=excluded.created_at
                    """,
                    (
                        before_text,
                        before_checksum,
                        after_text,
                        after_checksum,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def mark_rolling_back(self) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                cursor = connection.execute(
                    "UPDATE restore_journal SET phase='rolling_back' WHERE singleton=1"
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("Restore journal disappeared before rollback")
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def pending_restore(self) -> RestoreIntent | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT phase, before_payload, before_checksum, after_payload, after_checksum
                FROM restore_journal WHERE singleton=1
                """
            ).fetchone()
        if row is None:
            return None
        return RestoreIntent(
            phase=str(row[0]),
            before=self._decode(str(row[1]), str(row[2])),
            after=self._decode(str(row[3]), str(row[4])),
        )

    def load_active(self) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload, checksum FROM active_snapshot WHERE singleton=1"
            ).fetchone()
        return None if row is None else self._decode(str(row[0]), str(row[1]))

    def integrity_check(self) -> bool:
        with self._connect() as connection:
            row = connection.execute("PRAGMA integrity_check").fetchone()
        return bool(row and row[0] == "ok")
