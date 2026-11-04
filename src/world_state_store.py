"""Persona-bound SQLCipher journal for complete local restore recovery.

Memory rows stay in encrypted staging. The journal stores other participants
and before/after memory markers. Only matching finalization clears intent.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import threading
from typing import Any, Callable, Iterable, Iterator
import uuid

from .backup_inspection import BackupRestoreError
from .config.settings import WORLD_STATE_DB
from .storage.encrypted_sqlite import EncryptedStorageError, _current_key, connect_database

INTENT_VERSION = 1


def _require_key() -> None:
    if _current_key() is None:
        raise EncryptedStorageError("Recovery requires the existing SQLCipher storage key")


def _identity(identity: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(identity, dict):
        raise BackupRestoreError("Recovery identity is unavailable", code="BACKUP_RECOVERY_REQUIRED")
    result = {"persona_id": str(identity.get("persona_id") or ""),
              "fingerprint": str(identity.get("fingerprint") or ""),
              "identity_version": int(identity.get("identity_version") or 0)}
    if not result["persona_id"] or not result["fingerprint"] or result["identity_version"] < 1:
        raise BackupRestoreError("Recovery identity is incomplete", code="BACKUP_RECOVERY_REQUIRED")
    return result


@dataclass(frozen=True)
class RestoreIntent:
    operation_id: str
    intent_version: int
    persona_identity: dict[str, Any]
    phase: str
    before: dict[str, Any]
    after: dict[str, Any]
    before_marker: str
    after_marker: str

    def classify_marker(self, marker: str | None) -> str:
        if marker is None:
            return "unknown"
        if marker == self.after_marker:
            return "after"
        if marker == self.before_marker:
            return "before"
        return "unknown"


class WorldStateStore:
    def __init__(self, path: Path | None = None, *,
                 persona_identity: dict[str, Any] | None = None,
                 fault_hook: Callable[[str], None] | None = None) -> None:
        _require_key()
        self.path = Path(path or WORLD_STATE_DB)
        self.persona_identity = _identity(persona_identity) if persona_identity is not None else None
        self._owner_thread = threading.get_ident()
        self._fault_hook = fault_hook
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        if self.persona_identity is not None:
            self.bind_identity(self.persona_identity)

    def _assert_owner(self) -> None:
        if threading.get_ident() != self._owner_thread:
            raise RuntimeError("Recovery journal writes must run on the owner thread")

    def _fault(self, name: str) -> None:
        if self._fault_hook is not None:
            self._fault_hook(name)

    @staticmethod
    def _encode(payload: dict[str, Any]) -> tuple[str, str]:
        text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        return text, hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def _decode(text: str, checksum: str) -> dict[str, Any]:
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != checksum:
            raise BackupRestoreError("Recovery payload checksum mismatch", code="BACKUP_RECOVERY_REQUIRED")
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise BackupRestoreError("Recovery payload is not an object", code="BACKUP_RECOVERY_REQUIRED")
        return payload

    def _connect(self, *, read_only: bool = False):
        _require_key()
        connection = connect_database(self.path, timeout=30.0, isolation_level=None, read_only=read_only)
        connection.execute("PRAGMA busy_timeout=30000")
        if read_only:
            connection.execute("PRAGMA query_only=ON")
        else:
            self._assert_owner()
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA temp_store=MEMORY")
        return connection

    @staticmethod
    def _rollback(connection) -> None:
        # A COMMIT exception may occur after durable commit. Callers confirm
        # its outcome through a fresh readonly connection before another write.
        if connection.in_transaction:
            try:
                connection.execute("ROLLBACK")
            except Exception:
                pass

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS active_snapshot (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    payload TEXT NOT NULL, checksum TEXT NOT NULL, committed_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recovery_identity (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS restore_journal (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), phase TEXT NOT NULL,
                    before_payload TEXT NOT NULL, before_checksum TEXT NOT NULL,
                    after_payload TEXT NOT NULL, after_checksum TEXT NOT NULL, created_at TEXT NOT NULL,
                    operation_id TEXT NOT NULL, intent_version INTEGER NOT NULL,
                    persona_identity TEXT NOT NULL, before_marker TEXT NOT NULL, after_marker TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS restore_staging (
                    operation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                    payload TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(operation_id,sequence)
                );
                CREATE TABLE IF NOT EXISTS restore_targets (
                    operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,checksum TEXT NOT NULL,
                    memory_count INTEGER NOT NULL,source_sha256 TEXT NOT NULL,file_bytes INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS restore_archives (
                    operation_id TEXT PRIMARY KEY, intent_version INTEGER NOT NULL,
                    persona_identity TEXT NOT NULL, phase TEXT NOT NULL,
                    before_payload TEXT NOT NULL,before_checksum TEXT NOT NULL,
                    after_payload TEXT NOT NULL,after_checksum TEXT NOT NULL,
                    before_marker TEXT NOT NULL,after_marker TEXT NOT NULL,
                    created_at TEXT NOT NULL, preserved_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS restore_receipts (
                    operation_id TEXT PRIMARY KEY, intent_version INTEGER NOT NULL,
                    outcome TEXT NOT NULL CHECK(outcome IN ('before','after')),
                    checksum TEXT NOT NULL, finalized_at TEXT NOT NULL
                );
            """)
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(restore_journal)")}
            # Legacy pending intent is retained and fails closed. Adding
            # columns cannot establish its missing identity or commit marker.
            additions = {"operation_id": "TEXT NOT NULL DEFAULT ''",
                         "intent_version": "INTEGER NOT NULL DEFAULT 0",
                         "persona_identity": "TEXT NOT NULL DEFAULT '{}'",
                         "before_marker": "TEXT NOT NULL DEFAULT ''",
                         "after_marker": "TEXT NOT NULL DEFAULT ''"}
            for column, declaration in additions.items():
                if column not in columns:
                    connection.execute(f"ALTER TABLE restore_journal ADD COLUMN {column} {declaration}")

    def bind_identity(self, identity: dict[str, Any]) -> None:
        identity = _identity(identity)
        text, _ = self._encode(identity)
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT identity FROM recovery_identity WHERE singleton=1").fetchone()
                try:
                    raw_previous = json.loads(str(row[0])) if row is not None else None
                    previous = _identity(raw_previous) if raw_previous is not None else None
                    if previous is not None and (raw_previous != previous
                            or type(raw_previous.get("identity_version")) is not int):
                        raise ValueError("noncanonical recovery identity")
                except (ValueError, TypeError) as exc:
                    raise BackupRestoreError("Recovery identity is invalid", code="BACKUP_RECOVERY_REQUIRED") from exc
                if previous is not None and previous != identity:
                    # Use the same pending-intent parser as recovery.  A corrupt
                    # or legacy intent must fail closed as well as a valid one.
                    pending = self._read_pending(connection)
                    if (previous["persona_id"] != identity["persona_id"]
                            or identity["identity_version"] <= previous["identity_version"]
                            or pending is not None):
                        raise BackupRestoreError("Recovery journal belongs to another persona", code="BACKUP_RECOVERY_REQUIRED")
                    # Create the audit table only on a permitted forward step,
                    # in this transaction, so rejected binds do not migrate it.
                    connection.execute("""CREATE TABLE IF NOT EXISTS recovery_identity_advances (
                        sequence INTEGER PRIMARY KEY, previous_identity TEXT NOT NULL,
                        current_identity TEXT NOT NULL, advanced_at TEXT NOT NULL
                    )""")
                    previous_text, _ = self._encode(previous)
                    connection.execute("UPDATE recovery_identity SET identity=? WHERE singleton=1", (text,))
                    connection.execute("""INSERT INTO recovery_identity_advances(
                        previous_identity,current_identity,advanced_at) VALUES(?,?,?)""",
                        (previous_text, text, datetime.now(timezone.utc).isoformat()))
                    self._fault("identity_advanced")
                else:
                    connection.execute("INSERT OR IGNORE INTO recovery_identity(singleton,identity) VALUES(1,?)", (text,))
                connection.execute("COMMIT")
            except BaseException:
                self._rollback(connection)
                raise
        self.persona_identity = identity

    @classmethod
    def _read_pending(cls, connection) -> RestoreIntent | None:
        exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_journal'").fetchone()
        if exists is None:
            return None
        row = connection.execute("SELECT * FROM restore_journal WHERE singleton=1").fetchone()
        if row is None:
            return None
        if not {"operation_id", "intent_version", "persona_identity", "before_marker", "after_marker"}.issubset(row.keys()):
            raise BackupRestoreError("Legacy restore intent cannot be confirmed", code="BACKUP_RECOVERY_REQUIRED")
        operation_id, version = str(row["operation_id"]), int(row["intent_version"])
        if not operation_id or version != INTENT_VERSION or not str(row["after_marker"]):
            raise BackupRestoreError("Restore intent version or operation is invalid", code="BACKUP_RECOVERY_REQUIRED")
        identity = _identity(json.loads(str(row["persona_identity"])))
        before = cls._decode(str(row["before_payload"]), str(row["before_checksum"]))
        after = cls._decode(str(row["after_payload"]), str(row["after_checksum"]))
        if (before.get("_memory_restore_marker") != str(row["before_marker"])
                or after.get("_memory_restore_marker") != str(row["after_marker"])):
            raise BackupRestoreError("Restore marker and intent disagree", code="BACKUP_RECOVERY_REQUIRED")
        return RestoreIntent(operation_id,version,identity,str(row["phase"]),before,after,
                             str(row["before_marker"]),str(row["after_marker"]))

    @classmethod
    def peek_pending(cls, path: Path) -> RestoreIntent | None:
        path = Path(path)
        if not path.exists():
            return None
        _require_key()
        with closing(connect_database(path, timeout=5.0, isolation_level=None, read_only=True)) as connection:
            connection.execute("PRAGMA query_only=ON")
            return cls._read_pending(connection)

    def pending_restore(self) -> RestoreIntent | None:
        with closing(self._connect(read_only=True)) as connection:
            pending = self._read_pending(connection)
        if pending is not None and self.persona_identity is not None and pending.persona_identity != self.persona_identity:
            raise BackupRestoreError("Pending restore belongs to another persona", code="BACKUP_RECOVERY_REQUIRED")
        return pending

    def classify_marker(self, marker: str | None) -> str:
        pending = self.pending_restore()
        return "clean" if pending is None else pending.classify_marker(marker)

    def checkpoint(self, payload: dict[str, Any]) -> None:
        """Checkpoint clean state without deleting or superseding pending intent."""
        text, checksum = self._encode(payload)
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if connection.execute("SELECT 1 FROM restore_journal WHERE singleton=1").fetchone():
                    raise BackupRestoreError("Checkpoint refused while recovery is pending", code="BACKUP_RECOVERY_REQUIRED")
                self._write_active(connection,text,checksum)
                connection.execute("COMMIT")
            except BaseException:
                self._rollback(connection)
                raise

    @staticmethod
    def _write_active(connection, text: str, checksum: str) -> None:
        connection.execute("""INSERT INTO active_snapshot(singleton,payload,checksum,committed_at)
            VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,
            checksum=excluded.checksum,committed_at=excluded.committed_at""",
            (text,checksum,datetime.now(timezone.utc).isoformat()))

    def stage_memory(self, operation_id: str, rows: Iterable[dict[str, Any]]) -> int:
        from .memory.catalog import MemoryCatalog
        count = 0
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if connection.execute("SELECT 1 FROM restore_staging WHERE operation_id=? LIMIT 1", (operation_id,)).fetchone():
                    raise RuntimeError("Staging operation already exists")
                connection.execute("CREATE TEMP TABLE restore_seen_ids(id TEXT PRIMARY KEY)")
                for count, row in enumerate(rows,1):
                    if not isinstance(row,dict):
                        raise ValueError("Backup memory contains a non-object record")
                    prepared = MemoryCatalog._prepare_import_record(row, 0.0)
                    if connection.execute("SELECT 1 FROM restore_seen_ids WHERE id=?",(prepared[0],)).fetchone():
                        raise ValueError(f"Backup contains duplicate id: {prepared[0]}")
                    connection.execute("INSERT INTO restore_seen_ids VALUES(?)",(prepared[0],))
                    text,checksum = self._encode(row)
                    connection.execute("INSERT INTO restore_staging VALUES(?,?,?,?)", (operation_id,count,text,checksum))
                connection.execute("COMMIT")
            except BaseException:
                self._rollback(connection)
                raise
        return count

    def iter_staged_memory(self, operation_id: str) -> Iterator[dict[str, Any]]:
        with closing(self._connect(read_only=True)) as connection:
            cursor = connection.execute("SELECT payload,checksum FROM restore_staging WHERE operation_id=? ORDER BY sequence", (operation_id,))
            for row in cursor:
                yield self._decode(str(row[0]),str(row[1]))

    def record_staged_target(self, operation_id: str, payload: dict[str,Any], *,
                             memory_count: int, source_sha256: str, file_bytes: int) -> None:
        text,checksum = self._encode(payload)
        with closing(self._connect()) as connection:
            connection.execute("INSERT INTO restore_targets VALUES(?,?,?,?,?,?)",
                               (operation_id,text,checksum,memory_count,source_sha256,file_bytes))

    def load_staged_target(self, operation_id: str) -> tuple[dict[str,Any],int,str,int]:
        with closing(self._connect(read_only=True)) as connection:
            row = connection.execute("SELECT payload,checksum,memory_count,source_sha256,file_bytes FROM restore_targets WHERE operation_id=?",(operation_id,)).fetchone()
            count = connection.execute("SELECT count(*) FROM restore_staging WHERE operation_id=?",(operation_id,)).fetchone()
        if row is None or int(row[2]) != int(count[0]):
            raise BackupRestoreError("Encrypted staging is incomplete",code="BACKUP_RECOVERY_REQUIRED")
        return self._decode(str(row[0]),str(row[1])),int(row[2]),str(row[3]),int(row[4])

    def discard_staging(self, operation_id: str) -> None:
        with closing(self._connect()) as connection:
            connection.execute("""DELETE FROM restore_staging WHERE operation_id=?
                AND NOT EXISTS(SELECT 1 FROM restore_journal WHERE operation_id=?)
                AND NOT EXISTS(SELECT 1 FROM restore_archives WHERE operation_id=?)""",
                (operation_id,operation_id,operation_id))
            connection.execute("""DELETE FROM restore_targets WHERE operation_id=?
                AND NOT EXISTS(SELECT 1 FROM restore_journal WHERE operation_id=?)
                AND NOT EXISTS(SELECT 1 FROM restore_archives WHERE operation_id=?)""",
                (operation_id,operation_id,operation_id))

    def prepare_restore(self, before: dict[str, Any], after: dict[str, Any], *,
                        operation_id: str | None = None, rescue: bool = False) -> RestoreIntent:
        if self.persona_identity is None:
            raise BackupRestoreError("Recovery journal is not persona-bound", code="BACKUP_RECOVERY_REQUIRED")
        operation_id = operation_id or uuid.uuid4().hex
        before_marker = str(before.get("_memory_restore_marker", ""))
        after_marker = str(after.get("_memory_restore_marker", ""))
        if not after_marker or before_marker == after_marker:
            raise ValueError("Restore markers must distinguish before from after")
        before_text,before_checksum = self._encode(before)
        after_text,after_checksum = self._encode(after)
        identity_text,_ = self._encode(self.persona_identity)
        now = datetime.now(timezone.utc).isoformat()
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                row = connection.execute("SELECT * FROM restore_journal WHERE singleton=1").fetchone()
                if row is not None:
                    if not rescue:
                        raise BackupRestoreError("Another restore requires recovery", code="BACKUP_RECOVERY_REQUIRED")
                    archive_id = str(row["operation_id"]) or f"legacy-{uuid.uuid4().hex}"
                    connection.execute("INSERT INTO restore_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                        (archive_id,row["intent_version"],row["persona_identity"],row["phase"],
                         row["before_payload"],row["before_checksum"],row["after_payload"],row["after_checksum"],
                         row["before_marker"],row["after_marker"],row["created_at"],now))
                    self._fault("rescue_preserved")
                    connection.execute("DELETE FROM restore_journal WHERE singleton=1")
                connection.execute("""INSERT INTO restore_journal(singleton,phase,before_payload,before_checksum,
                    after_payload,after_checksum,created_at,operation_id,intent_version,persona_identity,
                    before_marker,after_marker) VALUES(1,'applying',?,?,?,?,?,?,?,?,?,?)""",
                    (before_text,before_checksum,after_text,after_checksum,now,operation_id,INTENT_VERSION,
                     identity_text,before_marker,after_marker))
                connection.execute("COMMIT")
            except BaseException:
                self._rollback(connection)
                raise
        return RestoreIntent(operation_id,INTENT_VERSION,dict(self.persona_identity),"applying",before,after,
                             before_marker,after_marker)

    def mark_rolling_back(self, operation_id: str, intent_version: int = INTENT_VERSION) -> None:
        with closing(self._connect()) as connection:
            cursor = connection.execute("UPDATE restore_journal SET phase='rolling_back' WHERE singleton=1 AND operation_id=? AND intent_version=?", (operation_id,intent_version))
            if cursor.rowcount != 1:
                raise BackupRestoreError("Restore operation changed during recovery", code="BACKUP_RECOVERY_REQUIRED")

    def finalize_restore(self, operation_id: str, intent_version: int, *, outcome: str,
                         payload: dict[str, Any]) -> None:
        if outcome not in {"before","after"}:
            raise ValueError("Unknown restore finalization direction")
        text,checksum = self._encode(payload)
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                pending = self._read_pending(connection)
                if pending is None or (pending.operation_id,pending.intent_version) != (operation_id,intent_version):
                    raise BackupRestoreError("Restore operation changed before finalization", code="BACKUP_RECOVERY_REQUIRED")
                if pending.persona_identity != self.persona_identity:
                    raise BackupRestoreError("Restore identity changed before finalization", code="BACKUP_RECOVERY_REQUIRED")
                expected = pending.before if outcome == "before" else pending.after
                if self._encode(expected)[1] != checksum:
                    raise BackupRestoreError("Finalization payload differs from intent", code="BACKUP_RECOVERY_REQUIRED")
                self._write_active(connection,text,checksum)
                connection.execute("INSERT INTO restore_receipts VALUES(?,?,?,?,?)", (operation_id,intent_version,outcome,checksum,datetime.now(timezone.utc).isoformat()))
                cursor = connection.execute("DELETE FROM restore_journal WHERE singleton=1 AND operation_id=? AND intent_version=?", (operation_id,intent_version))
                if cursor.rowcount != 1:
                    raise BackupRestoreError("Restore intent changed", code="BACKUP_RECOVERY_REQUIRED")
                connection.execute("DELETE FROM restore_staging WHERE operation_id=?", (operation_id,))
                connection.execute("DELETE FROM restore_targets WHERE operation_id=?", (operation_id,))
                self._fault("before_finalize_commit")
                connection.execute("COMMIT")
                self._fault("after_finalize_commit")
            except BaseException:
                self._rollback(connection)
                raise

    def confirm_finalized(self, operation_id: str, intent_version: int, *, outcome: str,
                          payload: dict[str, Any]) -> bool:
        with closing(self._connect(read_only=True)) as connection:
            row = connection.execute("SELECT intent_version,outcome,checksum FROM restore_receipts WHERE operation_id=?", (operation_id,)).fetchone()
            pending = connection.execute("SELECT 1 FROM restore_journal WHERE singleton=1").fetchone()
        return bool(row is not None and pending is None and int(row[0]) == intent_version
                    and str(row[1]) == outcome and str(row[2]) == self._encode(payload)[1])

    def load_active(self) -> dict[str, Any] | None:
        with closing(self._connect(read_only=True)) as connection:
            row = connection.execute("SELECT payload,checksum FROM active_snapshot WHERE singleton=1").fetchone()
        return None if row is None else self._decode(str(row[0]),str(row[1]))

    def integrity_check(self) -> bool:
        with closing(self._connect(read_only=True)) as connection:
            row = connection.execute("PRAGMA integrity_check").fetchone()
            cipher_errors = connection.execute("PRAGMA cipher_integrity_check").fetchall()
        return bool(row and str(row[0]) == "ok" and not cipher_errors)
