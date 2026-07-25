"""SQLite-backed canonical ledger for identity, consent, chat, and events."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import threading
from typing import Any, Iterable, Iterator
from uuid import uuid4

from .contracts import CommandEnvelopeV3, DomainEventV3, PersonaScopeV3


KERNEL_SCHEMA_VERSION = 1
COMMAND_TERMINAL_STATES = frozenset({"committed", "failed", "outcome_unknown"})


class KernelStorageError(RuntimeError):
    pass


class IdempotencyConflict(KernelStorageError):
    pass


@dataclass(frozen=True)
class CommandRecord:
    request_id: str
    idempotency_key: str
    command: str
    state: str
    provider_state: str
    result: Any
    error_code: str | None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def connect_sqlite(path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    target = Path(path).expanduser().resolve()
    if not read_only:
        target.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(target, timeout=5.0, isolation_level=None)
    else:
        connection = sqlite3.connect(
            f"file:{target.as_posix()}?mode=ro",
            uri=True,
            timeout=5.0,
            isolation_level=None,
        )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA trusted_schema = OFF")
    if not read_only:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA wal_autocheckpoint = 1000")
    return connection


class KernelStore:
    """Single writer for the irreducible local persona state."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()
        self._connection = connect_sqlite(self.path)
        self._migrate()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                yield self._connection
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise
            else:
                self._connection.execute("COMMIT")

    def _migrate(self) -> None:
        with self._lock:
            self._connection.executescript(
                """
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at_utc TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS personas (
                    persona_id TEXT PRIMARY KEY,
                    epoch INTEGER NOT NULL CHECK (epoch >= 1),
                    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
                    identity_json TEXT NOT NULL,
                    identity_version INTEGER NOT NULL CHECK (identity_version >= 1),
                    sealed_at_utc TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_persona
                    ON personas(active) WHERE active = 1;

                CREATE TABLE IF NOT EXISTS identity_audit (
                    audit_id TEXT PRIMARY KEY,
                    persona_id TEXT NOT NULL,
                    epoch INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    occurred_at_utc TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS consents (
                    persona_id TEXT NOT NULL,
                    capability TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                    details_json TEXT NOT NULL,
                    acknowledged_at_utc TEXT,
                    updated_at_utc TEXT NOT NULL,
                    PRIMARY KEY (persona_id, capability)
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    conversation_id TEXT PRIMARY KEY,
                    persona_id TEXT NOT NULL,
                    created_at_utc TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    message_id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL
                        REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                    persona_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
                    bubble_index INTEGER NOT NULL DEFAULT 0 CHECK (bubble_index >= 0),
                    content TEXT NOT NULL,
                    delivery_state TEXT NOT NULL,
                    created_at_utc TEXT NOT NULL,
                    UNIQUE(request_id, role, bubble_index)
                );
                CREATE INDEX IF NOT EXISTS messages_conversation_order
                    ON messages(conversation_id, created_at_utc, message_id);

                CREATE TABLE IF NOT EXISTS command_ledger (
                    request_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    command TEXT NOT NULL,
                    persona_id TEXT NOT NULL,
                    persona_epoch INTEGER NOT NULL,
                    persona_fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL,
                    provider_state TEXT NOT NULL,
                    request_json TEXT NOT NULL,
                    result_json TEXT,
                    error_code TEXT,
                    created_at_utc TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS domain_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    request_id TEXT,
                    persona_id TEXT NOT NULL,
                    persona_epoch INTEGER NOT NULL,
                    persona_fingerprint TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    payload_version INTEGER NOT NULL,
                    occurred_at_utc TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS domain_events_persona_sequence
                    ON domain_events(persona_id, sequence);

                CREATE TABLE IF NOT EXISTS module_checkpoints (
                    module_id TEXT NOT NULL,
                    persona_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL DEFAULT 0,
                    updated_at_utc TEXT NOT NULL,
                    PRIMARY KEY (module_id, persona_id)
                );
                COMMIT;
                """
            )
            self._connection.execute(
                """
                INSERT OR IGNORE INTO schema_migrations(version, applied_at_utc)
                VALUES (?, ?)
                """,
                (KERNEL_SCHEMA_VERSION, _utc_now()),
            )
            self._connection.execute(f"PRAGMA user_version = {KERNEL_SCHEMA_VERSION}")

    def integrity_check(self) -> str:
        with self._lock:
            row = self._connection.execute("PRAGMA integrity_check").fetchone()
            return str(row[0] if row is not None else "")

    def activate_persona(
        self,
        persona: PersonaScopeV3,
        *,
        identity: dict[str, Any],
        identity_version: int,
        actor: str,
        reason: str,
    ) -> None:
        if actor not in {"bootstrap", "owner", "local_admin", "migration"}:
            raise PermissionError("persona activation actor is not privileged")
        now = _utc_now()
        with self.transaction() as connection:
            active = connection.execute(
                "SELECT persona_id, epoch, fingerprint FROM personas WHERE active = 1"
            ).fetchone()
            if active is not None and active["persona_id"] == persona.persona_id and (
                int(active["epoch"]) >= persona.epoch
                and str(active["fingerprint"]) != persona.fingerprint
            ):
                raise IdempotencyConflict("persona epoch must increase before identity changes")
            connection.execute("UPDATE personas SET active = 0 WHERE active = 1")
            connection.execute(
                """
                INSERT INTO personas(
                    persona_id, epoch, fingerprint, identity_json,
                    identity_version, sealed_at_utc, active
                ) VALUES (?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(persona_id) DO UPDATE SET
                    epoch = excluded.epoch,
                    fingerprint = excluded.fingerprint,
                    identity_json = excluded.identity_json,
                    identity_version = excluded.identity_version,
                    sealed_at_utc = excluded.sealed_at_utc,
                    active = 1
                """,
                (
                    persona.persona_id,
                    persona.epoch,
                    persona.fingerprint,
                    _json(identity),
                    identity_version,
                    now,
                ),
            )
            connection.execute(
                """
                INSERT INTO identity_audit(
                    audit_id, persona_id, epoch, fingerprint,
                    actor, reason, occurred_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    uuid4().hex,
                    persona.persona_id,
                    persona.epoch,
                    persona.fingerprint,
                    actor,
                    reason[:500],
                    now,
                ),
            )

    def active_persona(self) -> PersonaScopeV3 | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT persona_id, epoch, fingerprint FROM personas WHERE active = 1"
            ).fetchone()
        if row is None:
            return None
        return PersonaScopeV3(
            persona_id=row["persona_id"],
            epoch=row["epoch"],
            fingerprint=row["fingerprint"],
        )

    def set_consent(
        self,
        persona_id: str,
        capability: str,
        *,
        enabled: bool,
        details: dict[str, Any] | None = None,
        acknowledged: bool = False,
    ) -> None:
        now = _utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO consents(
                    persona_id, capability, enabled, details_json,
                    acknowledged_at_utc, updated_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(persona_id, capability) DO UPDATE SET
                    enabled = excluded.enabled,
                    details_json = excluded.details_json,
                    acknowledged_at_utc = excluded.acknowledged_at_utc,
                    updated_at_utc = excluded.updated_at_utc
                """,
                (
                    persona_id,
                    capability,
                    int(enabled),
                    _json(details or {}),
                    now if acknowledged else None,
                    now,
                ),
            )

    def has_consent(self, persona_id: str, capability: str) -> bool:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT enabled, acknowledged_at_utc
                FROM consents WHERE persona_id = ? AND capability = ?
                """,
                (persona_id, capability),
            ).fetchone()
        return bool(row and row["enabled"] and row["acknowledged_at_utc"])

    def begin_command(self, command: CommandEnvelopeV3) -> CommandRecord:
        request_json = command.model_dump_json()
        now = _utc_now()
        with self.transaction() as connection:
            by_key = connection.execute(
                "SELECT * FROM command_ledger WHERE idempotency_key = ?",
                (command.idempotency_key,),
            ).fetchone()
            if by_key is not None:
                if (
                    by_key["request_id"] != command.request_id
                    or by_key["command"] != command.command
                    or by_key["request_json"] != request_json
                ):
                    raise IdempotencyConflict(
                        "idempotency key was already used by another command"
                    )
                return self._command_record(by_key)
            connection.execute(
                """
                INSERT INTO command_ledger(
                    request_id, idempotency_key, command, persona_id,
                    persona_epoch, persona_fingerprint, state, provider_state,
                    request_json, created_at_utc, updated_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 'not_started', ?, ?, ?)
                """,
                (
                    command.request_id,
                    command.idempotency_key,
                    command.command,
                    command.persona.persona_id,
                    command.persona.epoch,
                    command.persona.fingerprint,
                    request_json,
                    now,
                    now,
                ),
            )
        return CommandRecord(
            request_id=command.request_id,
            idempotency_key=command.idempotency_key,
            command=command.command,
            state="accepted",
            provider_state="not_started",
            result=None,
            error_code=None,
        )

    def mark_provider_dispatched(self, request_id: str) -> None:
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT state, provider_state FROM command_ledger WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            if row is None:
                raise KeyError(request_id)
            if row["state"] in COMMAND_TERMINAL_STATES:
                raise IdempotencyConflict("terminal command cannot dispatch a provider")
            if row["provider_state"] == "completed":
                raise IdempotencyConflict("completed provider call cannot be dispatched again")
            connection.execute(
                """
                UPDATE command_ledger
                SET state = 'generating', provider_state = 'dispatched',
                    updated_at_utc = ?
                WHERE request_id = ?
                """,
                (_utc_now(), request_id),
            )

    def commit_chat_exchange(
        self,
        command: CommandEnvelopeV3,
        *,
        conversation_id: str,
        user_text: str,
        assistant_bubbles: Iterable[str],
        events: Iterable[DomainEventV3] = (),
        result: dict[str, Any] | None = None,
    ) -> CommandRecord:
        bubbles = [str(value) for value in assistant_bubbles if str(value)]
        if not bubbles:
            raise ValueError("chat exchange requires at least one assistant bubble")
        now = _utc_now()
        event_list = list(events)
        for event in event_list:
            if event.persona != command.persona:
                raise ValueError("domain event belongs to another persona scope")
            if event.causation_id not in {None, command.request_id}:
                raise ValueError("domain event has a conflicting causation id")

        with self.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM command_ledger WHERE request_id = ?",
                (command.request_id,),
            ).fetchone()
            if row is None:
                raise KeyError(command.request_id)
            existing = self._command_record(row)
            if existing.state == "committed":
                return existing
            if existing.state in {"failed", "outcome_unknown"}:
                raise IdempotencyConflict("terminal command cannot be committed")
            if (
                row["persona_id"] != command.persona.persona_id
                or row["persona_epoch"] != command.persona.epoch
                or row["persona_fingerprint"] != command.persona.fingerprint
            ):
                raise IdempotencyConflict("command persona scope changed before commit")

            connection.execute(
                """
                INSERT INTO conversations(
                    conversation_id, persona_id, created_at_utc, updated_at_utc
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    updated_at_utc = excluded.updated_at_utc
                """,
                (conversation_id, command.persona.persona_id, now, now),
            )
            connection.execute(
                """
                INSERT INTO messages(
                    message_id, conversation_id, persona_id, request_id, role,
                    bubble_index, content, delivery_state, created_at_utc
                ) VALUES (?, ?, ?, ?, 'user', 0, ?, 'accepted', ?)
                ON CONFLICT(request_id, role, bubble_index) DO NOTHING
                """,
                (
                    uuid4().hex,
                    conversation_id,
                    command.persona.persona_id,
                    command.request_id,
                    user_text,
                    now,
                ),
            )
            for index, bubble in enumerate(bubbles):
                connection.execute(
                    """
                    INSERT INTO messages(
                        message_id, conversation_id, persona_id, request_id,
                        role, bubble_index, content, delivery_state, created_at_utc
                    ) VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'ready_waiting', ?)
                    ON CONFLICT(request_id, role, bubble_index) DO NOTHING
                    """,
                    (
                        uuid4().hex,
                        conversation_id,
                        command.persona.persona_id,
                        command.request_id,
                        index,
                        bubble,
                        now,
                    ),
                )
            for event in event_list:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO domain_events(
                        event_id, request_id, persona_id, persona_epoch,
                        persona_fingerprint, event_type, payload_json,
                        payload_version, occurred_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event.event_id,
                        command.request_id,
                        event.persona.persona_id,
                        event.persona.epoch,
                        event.persona.fingerprint,
                        event.event_type,
                        _json(event.payload),
                        event.payload_version,
                        event.occurred_at_utc,
                    ),
                )
            final_result = result or {"conversation_id": conversation_id, "bubbles": bubbles}
            connection.execute(
                """
                UPDATE command_ledger
                SET state = 'committed', provider_state = 'completed',
                    result_json = ?, error_code = NULL, updated_at_utc = ?
                WHERE request_id = ?
                """,
                (_json(final_result), now, command.request_id),
            )
            final_row = connection.execute(
                "SELECT * FROM command_ledger WHERE request_id = ?",
                (command.request_id,),
            ).fetchone()
        assert final_row is not None
        return self._command_record(final_row)

    def fail_command(
        self,
        request_id: str,
        *,
        error_code: str,
        provider_outcome_unknown: bool = False,
    ) -> CommandRecord:
        state = "outcome_unknown" if provider_outcome_unknown else "failed"
        provider_state = "outcome_unknown" if provider_outcome_unknown else "not_started"
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT state, provider_state FROM command_ledger WHERE request_id = ?",
                (request_id,),
            ).fetchone()
            if row is None:
                raise KeyError(request_id)
            if row["state"] == "committed":
                raise IdempotencyConflict("committed command cannot fail")
            if row["provider_state"] == "dispatched":
                state = "outcome_unknown"
                provider_state = "outcome_unknown"
            connection.execute(
                """
                UPDATE command_ledger
                SET state = ?, provider_state = ?, error_code = ?, updated_at_utc = ?
                WHERE request_id = ?
                """,
                (state, provider_state, error_code, _utc_now(), request_id),
            )
            final = connection.execute(
                "SELECT * FROM command_ledger WHERE request_id = ?",
                (request_id,),
            ).fetchone()
        assert final is not None
        return self._command_record(final)

    def recover_ambiguous_commands(self) -> int:
        with self.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE command_ledger
                SET state = 'outcome_unknown',
                    provider_state = 'outcome_unknown',
                    error_code = 'PROVIDER_OUTCOME_UNKNOWN',
                    updated_at_utc = ?
                WHERE state = 'generating' AND provider_state = 'dispatched'
                """,
                (_utc_now(),),
            )
            return int(cursor.rowcount)

    def command(self, request_id: str) -> CommandRecord | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM command_ledger WHERE request_id = ?",
                (request_id,),
            ).fetchone()
        return self._command_record(row) if row is not None else None

    def messages(self, conversation_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT message_id, request_id, role, bubble_index, content,
                       delivery_state, created_at_utc
                FROM messages WHERE conversation_id = ?
                ORDER BY created_at_utc, role DESC, bubble_index, message_id
                """,
                (conversation_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def message_page(
        self,
        conversation_id: str,
        *,
        limit: int = 200,
        before_sequence: int | None = None,
        persona_id: str | None = None,
    ) -> dict[str, Any]:
        """Read a bounded page using SQLite insertion order as the cursor.

        ``created_at_utc`` is deliberately not the ordering authority: one
        atomic chat commit gives the user and assistant bubbles the same
        timestamp, while UUID message ids are random.  SQLite rowids preserve
        the transaction's insertion order for this table and also give us a
        compact keyset cursor that cannot split equal-timestamp bubbles in an
        arbitrary order.
        """
        if limit < 1 or limit > 1000:
            raise ValueError("message query limit is outside the safe range")
        parameters: list[Any] = [conversation_id]
        persona_sql = ""
        if persona_id:
            persona_sql = " AND persona_id = ?"
            parameters.append(persona_id)
        cursor_sql = ""
        if before_sequence is not None:
            if (
                isinstance(before_sequence, bool)
                or not isinstance(before_sequence, int)
                or before_sequence < 1
            ):
                raise ValueError("message cursor is invalid")
            cursor_sql = " AND rowid < ?"
            parameters.append(before_sequence)
        parameters.append(limit + 1)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT rowid AS message_sequence,
                       message_id, request_id, role, bubble_index, content,
                       delivery_state, created_at_utc
                FROM messages
                WHERE conversation_id = ? {persona_sql} {cursor_sql}
                ORDER BY rowid DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        page_rows.reverse()
        next_cursor = None
        if has_more and page_rows:
            oldest = page_rows[0]
            next_cursor = {
                "sequence": oldest["message_sequence"],
            }
        return {
            "items": [dict(row) for row in page_rows],
            "has_more": has_more,
            "next_cursor": next_cursor,
        }

    def events_after(
        self,
        persona_id: str,
        *,
        sequence: int = 0,
        limit: int = 100,
    ) -> list[tuple[int, DomainEventV3]]:
        if limit < 1 or limit > 10_000:
            raise ValueError("event query limit is outside the safe range")
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT sequence, event_id, event_type, persona_id, persona_epoch,
                       persona_fingerprint, payload_json, request_id,
                       occurred_at_utc, payload_version
                FROM domain_events
                WHERE persona_id = ? AND sequence > ?
                ORDER BY sequence LIMIT ?
                """,
                (persona_id, sequence, limit),
            ).fetchall()
        return [
            (
                int(row["sequence"]),
                DomainEventV3(
                    event_id=row["event_id"],
                    event_type=row["event_type"],
                    persona=PersonaScopeV3(
                        persona_id=row["persona_id"],
                        epoch=row["persona_epoch"],
                        fingerprint=row["persona_fingerprint"],
                    ),
                    payload=json.loads(row["payload_json"]),
                    causation_id=row["request_id"],
                    occurred_at_utc=row["occurred_at_utc"],
                    payload_version=row["payload_version"],
                ),
            )
            for row in rows
        ]

    def checkpoint(self, module_id: str, persona_id: str) -> int:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT sequence FROM module_checkpoints
                WHERE module_id = ? AND persona_id = ?
                """,
                (module_id, persona_id),
            ).fetchone()
        return int(row["sequence"]) if row else 0

    def save_checkpoint(self, module_id: str, persona_id: str, sequence: int) -> None:
        with self.transaction() as connection:
            current = connection.execute(
                """
                SELECT sequence FROM module_checkpoints
                WHERE module_id = ? AND persona_id = ?
                """,
                (module_id, persona_id),
            ).fetchone()
            if current is not None and int(current["sequence"]) > sequence:
                raise IdempotencyConflict("module checkpoint cannot move backwards")
            connection.execute(
                """
                INSERT INTO module_checkpoints(
                    module_id, persona_id, sequence, updated_at_utc
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(module_id, persona_id) DO UPDATE SET
                    sequence = excluded.sequence,
                    updated_at_utc = excluded.updated_at_utc
                """,
                (module_id, persona_id, sequence, _utc_now()),
            )

    @staticmethod
    def _command_record(row: sqlite3.Row) -> CommandRecord:
        result = json.loads(row["result_json"]) if row["result_json"] else None
        return CommandRecord(
            request_id=row["request_id"],
            idempotency_key=row["idempotency_key"],
            command=row["command"],
            state=row["state"],
            provider_state=row["provider_state"],
            result=result,
            error_code=row["error_code"],
        )
