"""SQLite-backed canonical ledger for identity, consent, chat, and events."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any, Iterable, Iterator
from uuid import uuid4

from src.storage.encrypted_sqlite import connect_database

from .contracts import CommandEnvelopeV4, DomainEventV4, PersonaScopeV4


KERNEL_SCHEMA_VERSION = 3
COMMAND_TERMINAL_STATES = frozenset({"committed", "failed", "outcome_unknown"})
PRIVATE_DOCUMENT_NAMES = frozenset(
    {
        "persona_emotion_state",
        "persona_relationship_state",
        "user_profile",
        "user_emotional_memories",
    }
)
MAX_PRIVATE_DOCUMENT_BYTES = 1024 * 1024
PROACTIVE_ID_PATTERN = re.compile(r"^proactive_[0-9a-f]{32}$")


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
    connection = connect_database(
        target,
        read_only=read_only,
        timeout=5.0,
        isolation_level=None,
    )
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA trusted_schema = OFF")
    if not read_only:
        # SQLCipher 0.6.2 currently embeds SQLite 3.51.1, which predates the
        # upstream WAL-reset race fix. This store is a serialized single
        # writer, so rollback journaling is the safer durability tradeoff
        # until the packaged SQLCipher runtime includes the fix.
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("PRAGMA synchronous = FULL")
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
                    source TEXT NOT NULL DEFAULT 'chat',
                    proactive_id TEXT,
                    UNIQUE(request_id, role, bubble_index)
                );
                CREATE INDEX IF NOT EXISTS messages_conversation_order
                    ON messages(conversation_id, created_at_utc, message_id);

                CREATE TABLE IF NOT EXISTS proactive_publications (
                    proactive_id TEXT PRIMARY KEY,
                    persona_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    effects_claimed INTEGER NOT NULL DEFAULT 0 CHECK (effects_claimed IN (0, 1)),
                    notification_published INTEGER NOT NULL DEFAULT 0 CHECK (notification_published IN (0, 1)),
                    broadcast_published INTEGER NOT NULL DEFAULT 0 CHECK (broadcast_published IN (0, 1)),
                    created_at_utc TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS proactive_publications_pending
                    ON proactive_publications(persona_id, broadcast_published, created_at_utc);

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

                -- Attachments for chat messages. Rows are written at accept
                -- time alongside the write-through user message; the actual
                -- bytes live under DATA_DIR/chat-media/<media_id>.jpg.
                CREATE TABLE IF NOT EXISTS chat_media (
                    media_id TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    media_path TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    bytes INTEGER NOT NULL,
                    created_at_utc TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS chat_media_request
                    ON chat_media(request_id);

                CREATE TABLE IF NOT EXISTS module_checkpoints (
                    module_id TEXT NOT NULL,
                    persona_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL DEFAULT 0,
                    updated_at_utc TEXT NOT NULL,
                    PRIMARY KEY (module_id, persona_id)
                );

                CREATE TABLE IF NOT EXISTS private_documents (
                    document_name TEXT PRIMARY KEY,
                    payload_json TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                );
                COMMIT;
                """
            )
            columns = {
                str(row["name"])
                for row in self._connection.execute("PRAGMA table_info(messages)").fetchall()
            }
            if "source" not in columns:
                self._connection.execute(
                    "ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'chat'"
                )
            if "proactive_id" not in columns:
                self._connection.execute("ALTER TABLE messages ADD COLUMN proactive_id TEXT")
            self._connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS messages_proactive_bubble
                ON messages(proactive_id, bubble_index)
                WHERE proactive_id IS NOT NULL
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

    def read_private_document(self, document_name: str) -> dict[str, Any] | None:
        """Read one closed-world encrypted document owned by the local host."""

        if document_name not in PRIVATE_DOCUMENT_NAMES:
            raise ValueError("private document name is outside the MVP allowlist")
        with self._lock:
            row = self._connection.execute(
                "SELECT payload_json FROM private_documents WHERE document_name = ?",
                (document_name,),
            ).fetchone()
        if row is None:
            return None
        value = json.loads(str(row["payload_json"]))
        if not isinstance(value, dict):
            raise KernelStorageError("private document root is invalid")
        return value

    def write_private_document(
        self,
        document_name: str,
        payload: dict[str, Any],
    ) -> None:
        """Atomically replace one bounded private document."""

        if document_name not in PRIVATE_DOCUMENT_NAMES:
            raise ValueError("private document name is outside the MVP allowlist")
        encoded = _json(payload)
        if len(encoded.encode("utf-8")) > MAX_PRIVATE_DOCUMENT_BYTES:
            raise ValueError("private document exceeds the storage limit")
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO private_documents(document_name,payload_json,updated_at_utc)
                VALUES (?,?,?)
                ON CONFLICT(document_name) DO UPDATE SET
                    payload_json=excluded.payload_json,
                    updated_at_utc=excluded.updated_at_utc
                """,
                (document_name, encoded, _utc_now()),
            )

    def activate_persona(
        self,
        persona: PersonaScopeV4,
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

    def active_persona(self) -> PersonaScopeV4 | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT persona_id, epoch, fingerprint FROM personas WHERE active = 1"
            ).fetchone()
        if row is None:
            return None
        return PersonaScopeV4(
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

    def begin_command(self, command: CommandEnvelopeV4) -> CommandRecord:
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

    def commit_command_result(
        self,
        command: CommandEnvelopeV4,
        result: Any,
    ) -> CommandRecord:
        """Atomically cache the result of a non-chat idempotent command."""

        request_json = command.model_dump_json()
        now = _utc_now()
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
                row["idempotency_key"] != command.idempotency_key
                or row["command"] != command.command
                or row["persona_id"] != command.persona.persona_id
                or row["persona_epoch"] != command.persona.epoch
                or row["persona_fingerprint"] != command.persona.fingerprint
                or row["request_json"] != request_json
            ):
                raise IdempotencyConflict("command changed before result commit")
            connection.execute(
                """
                UPDATE command_ledger
                SET state='committed', provider_state='completed',
                    result_json=?, error_code=NULL, updated_at_utc=?
                WHERE request_id=?
                """,
                (_json(result), now, command.request_id),
            )
            final = connection.execute(
                "SELECT * FROM command_ledger WHERE request_id = ?",
                (command.request_id,),
            ).fetchone()
        assert final is not None
        return self._command_record(final)

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

    def append_user_message(
        self,
        *,
        request_id: str,
        conversation_id: str,
        persona_id: str,
        text: str,
        created_at_utc: str | None = None,
        media: dict[str, Any] | None = None,
    ) -> bool:
        """Durably record the user's message the moment it is accepted.

        Generation failures and cancellations must never erase what the user
        said, so the user row lands before any provider call is made.
        ``commit_chat_exchange`` later repeats this insert with the same
        ``ON CONFLICT DO NOTHING`` guard, which keeps the write-through
        idempotent even if the process dies between the two.
        """
        now = created_at_utc or _utc_now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO conversations(
                    conversation_id, persona_id, created_at_utc, updated_at_utc
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    updated_at_utc = excluded.updated_at_utc
                """,
                (conversation_id, persona_id, now, now),
            )
            cursor = connection.execute(
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
                    persona_id,
                    request_id,
                    text,
                    now,
                ),
            )
            if media:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO chat_media(
                        media_id, request_id, conversation_id,
                        media_path, mime, bytes, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(media.get("media_id") or ""),
                        request_id,
                        conversation_id,
                        str(media.get("media_path") or ""),
                        str(media.get("mime") or "image/jpeg"),
                        int(media.get("bytes") or 0),
                        now,
                    ),
                )
            return bool(cursor.rowcount)

    def count_user_messages_on_date(self, date_str: str) -> int:
        """Number of accepted user messages whose UTC timestamp starts with
        ``date_str`` — the daily diary trigger's "enough happened today" gate."""
        if not date_str or not all(part.isdigit() for part in date_str.split("-")):
            raise ValueError("date must look like YYYY-MM-DD")
        with self._lock:
            row = self._connection.execute(
                """
                SELECT COUNT(*) AS total
                FROM messages
                WHERE role = 'user' AND created_at_utc LIKE ?
                """,
                (f"{date_str}%",),
            ).fetchone()
        return int(row["total"]) if row is not None else 0

    def append_proactive_messages(
        self,
        *,
        proactive_id: str,
        conversation_id: str,
        persona: PersonaScopeV4,
        messages: Iterable[str],
        created_at_utc: str,
        publication_payload: dict[str, Any] | None = None,
    ) -> bool:
        """Persist one proactive assistant turn without inventing a user turn."""

        bubbles = [str(value) for value in messages if str(value)]
        if not PROACTIVE_ID_PATTERN.fullmatch(proactive_id) or not bubbles:
            raise ValueError("proactive message identity and bubbles are required")
        with self.transaction() as connection:
            active = connection.execute(
                "SELECT persona_id, epoch, fingerprint FROM personas WHERE active = 1"
            ).fetchone()
            if active is None or (
                str(active["persona_id"]) != persona.persona_id
                or int(active["epoch"]) != persona.epoch
                or str(active["fingerprint"]) != persona.fingerprint
            ):
                raise IdempotencyConflict("proactive message belongs to a stale persona scope")
            existing = connection.execute(
                """
                SELECT conversation_id, persona_id, bubble_index, content, created_at_utc
                FROM messages
                WHERE proactive_id = ?
                ORDER BY bubble_index
                """,
                (proactive_id,),
            ).fetchall()
            if existing:
                existing_bubbles = [str(row["content"]) for row in existing]
                exact_replay = (
                    existing_bubbles == bubbles
                    and all(str(row["conversation_id"]) == conversation_id for row in existing)
                    and all(str(row["persona_id"]) == persona.persona_id for row in existing)
                    and all(str(row["created_at_utc"]) == created_at_utc for row in existing)
                    and [int(row["bubble_index"]) for row in existing] == list(range(len(bubbles)))
                )
                if exact_replay:
                    if publication_payload is not None:
                        publication = connection.execute(
                            "SELECT payload_json FROM proactive_publications WHERE proactive_id = ?",
                            (proactive_id,),
                        ).fetchone()
                        encoded = _json(publication_payload)
                        if publication is not None and str(publication["payload_json"]) != encoded:
                            raise IdempotencyConflict(
                                "proactive publication identity was reused with new content"
                            )
                        if publication is None:
                            connection.execute(
                                """
                                INSERT INTO proactive_publications(
                                    proactive_id, persona_id, payload_json,
                                    created_at_utc, updated_at_utc
                                ) VALUES (?, ?, ?, ?, ?)
                                """,
                                (
                                    proactive_id,
                                    persona.persona_id,
                                    encoded,
                                    created_at_utc,
                                    _utc_now(),
                                ),
                            )
                    return False
                raise IdempotencyConflict("proactive message identity was reused with new content")
            connection.execute(
                """
                INSERT INTO conversations(
                    conversation_id, persona_id, created_at_utc, updated_at_utc
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(conversation_id) DO UPDATE SET
                    updated_at_utc = excluded.updated_at_utc
                """,
                (conversation_id, persona.persona_id, created_at_utc, created_at_utc),
            )
            inserted = 0
            for index, bubble in enumerate(bubbles):
                cursor = connection.execute(
                    """
                    INSERT INTO messages(
                        message_id, conversation_id, persona_id, request_id, role,
                        bubble_index, content, delivery_state, created_at_utc,
                        source, proactive_id
                    ) VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'done', ?, 'proactive', ?)
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        uuid4().hex,
                        conversation_id,
                        persona.persona_id,
                        proactive_id,
                        index,
                        bubble,
                        created_at_utc,
                        proactive_id,
                    ),
                )
                inserted += int(cursor.rowcount)
            if inserted != len(bubbles):
                raise IdempotencyConflict("proactive message identity conflicts with chat history")
            if publication_payload is not None:
                connection.execute(
                    """
                    INSERT INTO proactive_publications(
                        proactive_id, persona_id, payload_json,
                        created_at_utc, updated_at_utc
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        proactive_id,
                        persona.persona_id,
                        _json(publication_payload),
                        created_at_utc,
                        _utc_now(),
                    ),
                )
            return True

    def pending_proactive_publications(
        self,
        persona_id: str,
        *,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Return durable proactive work that still needs an external publication."""

        if limit < 1 or limit > 1000:
            raise ValueError("proactive publication limit is outside the safe range")
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT proactive_id, payload_json, effects_claimed,
                       notification_published, broadcast_published
                FROM proactive_publications
                WHERE persona_id = ? AND (
                    effects_claimed = 0
                    OR notification_published = 0
                    OR broadcast_published = 0
                )
                ORDER BY created_at_utc, proactive_id
                LIMIT ?
                """,
                (persona_id, limit),
            ).fetchall()
        return [
            {
                "proactive_id": str(row["proactive_id"]),
                "payload": json.loads(str(row["payload_json"])),
                "effects_claimed": bool(row["effects_claimed"]),
                "notification_published": bool(row["notification_published"]),
                "broadcast_published": bool(row["broadcast_published"]),
            }
            for row in rows
        ]

    def claim_proactive_effects(self, proactive_id: str) -> bool:
        """Claim non-transactional persona effects before applying them.

        Claim-before-apply makes these effects at-most-once across a crash. A
        crash after this claim can omit an effect, but can never apply it twice.
        """

        with self.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE proactive_publications
                SET effects_claimed = 1, updated_at_utc = ?
                WHERE proactive_id = ? AND effects_claimed = 0
                """,
                (_utc_now(), proactive_id),
            )
            return bool(cursor.rowcount)

    def mark_proactive_published(self, proactive_id: str, channel: str) -> None:
        if channel not in {"notification", "broadcast"}:
            raise ValueError("unknown proactive publication channel")
        column = f"{channel}_published"
        with self.transaction() as connection:
            cursor = connection.execute(
                f"""
                UPDATE proactive_publications
                SET {column} = 1, updated_at_utc = ?
                WHERE proactive_id = ?
                """,
                (_utc_now(), proactive_id),
            )
            if not cursor.rowcount:
                raise KeyError(proactive_id)

    def media_for_requests(self, request_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        """Attachment records keyed by request_id for history rendering."""
        unique = [str(value) for value in dict.fromkeys(request_ids) if str(value)]
        if not unique:
            return {}
        placeholders = ",".join("?" for _ in unique)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT media_id, request_id, mime, bytes
                FROM chat_media
                WHERE request_id IN ({placeholders})
                """,
                unique,
            ).fetchall()
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(str(row["request_id"]), []).append(dict(row))
        return grouped

    def commit_chat_exchange(
        self,
        command: CommandEnvelopeV4,
        *,
        conversation_id: str,
        user_text: str,
        assistant_bubbles: Iterable[str],
        events: Iterable[DomainEventV4] = (),
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
                       delivery_state, created_at_utc, source, proactive_id
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
                       delivery_state, created_at_utc, source, proactive_id
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
    ) -> list[tuple[int, DomainEventV4]]:
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
                DomainEventV4(
                    event_id=row["event_id"],
                    event_type=row["event_type"],
                    persona=PersonaScopeV4(
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
