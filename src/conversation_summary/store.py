"""Derived summaries inside the existing encrypted canonical ledger.

The caller owns persona/consent commit barriers. All local changes use the
KernelStore's existing serialized transaction and SQLCipher connection.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
import math
import re
import time
from uuid import uuid4
from urllib.parse import urlsplit

from .engine import (
    CONTRACT_VERSION, COOLDOWN_SECONDS, MAX_SOURCE_MESSAGES, MAX_SUMMARY_CHARS, SourceBatch, SourceMessage,
    SourceSelection, StoredSummary, select_source, source_digest, source_document,
)
from .legacy import LegacyDocument, LegacyImportError, parse_legacy


_SUMMARY_ID_PATTERN = re.compile(r"summary_[0-9a-f]{32}")


class SummaryStorageError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Attempt:
    id: str
    source: SourceBatch


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _time(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise SummaryStorageError("summary_invalid_clock")
    return float(value)


def _messages(value: str) -> tuple[SourceMessage, ...]:
    try:
        rows = json.loads(value)
        if not isinstance(rows, list):
            raise ValueError()
        messages = tuple(SourceMessage(**row) for row in rows)
        if any(not isinstance(m.sequence, int) or isinstance(m.sequence, bool) or m.sequence < 1
               or m.role not in {"user", "assistant"}
               or any(not isinstance(v, str) for v in (m.message_id, m.request_id, m.content))
               for m in messages):
            raise ValueError()
        return messages
    except (ValueError, TypeError, KeyError) as exc:
        raise SummaryStorageError("summary_corrupt_source") from exc


def _provenance(value: dict | None) -> dict:
    if value is not None and not isinstance(value, dict):
        raise SummaryStorageError("summary_invalid_provenance")
    result = {"algorithm_version": CONTRACT_VERSION} if value is None else dict(value)
    limits = {"algorithm_version": 128, "provider": 64, "origin": 512, "model": 256, "settings_digest": 64}
    if (set(result) - limits.keys() or result.get("algorithm_version") != CONTRACT_VERSION
            or any(not isinstance(v, str) or not v or len(v) > limits[k] for k, v in result.items())):
        raise SummaryStorageError("summary_invalid_provenance")
    if "settings_digest" in result and (len(result["settings_digest"]) != 64 or any(c not in "0123456789abcdef" for c in result["settings_digest"])):
        raise SummaryStorageError("summary_invalid_provenance")
    if "origin" in result:
        try:
            parsed = urlsplit(result["origin"])
        except ValueError as exc:
            raise SummaryStorageError("summary_invalid_provenance") from exc
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
            raise SummaryStorageError("summary_invalid_provenance")
    return result


class SummaryStore:
    def __init__(self, kernel_store, token) -> None:
        self.kernel_store = kernel_store
        self.token = token
        self.persona_id = str(token.persona_id)
        if not self.persona_id:
            raise SummaryStorageError("summary_persona_required")
        with kernel_store.transaction() as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS conversation_summary_schema (version INTEGER PRIMARY KEY)")
            versions = [row[0] for row in connection.execute("SELECT version FROM conversation_summary_schema")]
            if versions and versions != [1]:
                raise SummaryStorageError("summary_schema_unsupported")
            connection.execute("INSERT OR IGNORE INTO conversation_summary_schema(version) VALUES (1)")
            connection.execute("""CREATE TABLE IF NOT EXISTS conversation_summary_attempts (
                attempt_id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                source_digest TEXT NOT NULL, source_json TEXT NOT NULL, started_at REAL NOT NULL,
                finished_at REAL, status TEXT NOT NULL, error_code TEXT, provenance_json TEXT NOT NULL,
                UNIQUE(persona_id, conversation_id, source_digest))""")
            connection.execute("""CREATE INDEX IF NOT EXISTS conversation_summary_attempt_scope
                ON conversation_summary_attempts(persona_id, conversation_id, started_at)""")
            connection.execute("""CREATE TABLE IF NOT EXISTS conversation_summary_imports (
                source_sha256 TEXT PRIMARY KEY, original_json TEXT NOT NULL, imported_at REAL NOT NULL)""")
            connection.execute("""CREATE TABLE IF NOT EXISTS conversation_summary_items (
                summary_id TEXT PRIMARY KEY, persona_id TEXT, conversation_id TEXT,
                text TEXT NOT NULL, source_json TEXT NOT NULL, source_digest TEXT,
                first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
                origin TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
                linkage TEXT NOT NULL, attempt_id TEXT UNIQUE,
                legacy_sha256 TEXT, legacy_position INTEGER, metadata_json TEXT NOT NULL,
                created_at REAL NOT NULL, UNIQUE(legacy_sha256, legacy_position))""")
            connection.execute("""CREATE INDEX IF NOT EXISTS conversation_summary_item_scope
                ON conversation_summary_items(persona_id, conversation_id, active)""")

    def _conversation(self, conversation_id: str) -> str:
        if not isinstance(conversation_id, str) or not conversation_id.strip() or len(conversation_id) > 512:
            raise SummaryStorageError("summary_conversation_required")
        return conversation_id

    def _exchanges(self, connection, conversation_id: str,
                   diagnostics: list[str] | None = None) -> list[tuple[SourceMessage, ...]]:
        rows = connection.execute("""
            SELECT m.rowid AS sequence, m.message_id, m.request_id, m.role, m.content, m.bubble_index,
                   c.result_json AS committed_result
            FROM messages m JOIN command_ledger c ON c.request_id=m.request_id
            WHERE m.persona_id=? AND m.conversation_id=?
              AND c.persona_id=m.persona_id AND c.command='chat:send' AND c.state='committed'
              AND m.source='chat' AND m.role IN ('user','assistant')
            ORDER BY m.rowid
        """, (self.persona_id, conversation_id)).fetchall()
        grouped: dict[str, list] = {}
        for row in rows:
            grouped.setdefault(row["request_id"], []).append(row)
        exchanges = []
        for rows in grouped.values():
            users = [row for row in rows if row["role"] == "user"]
            assistants = [row for row in rows if row["role"] == "assistant"]
            # A committed request with missing or discontinuous bubbles is
            # corrupt/incomplete evidence, never a partial summarization input.
            try:
                committed = json.loads(rows[0]["committed_result"])
            except (TypeError, ValueError):
                committed = None
            expected_count = None
            if isinstance(committed, dict):
                value = committed.get("bubble_count")
                if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                    expected_count = value
                elif isinstance(committed.get("bubbles"), list) and all(isinstance(t, str) and t for t in committed["bubbles"]):
                    expected_count = len(committed["bubbles"])
            if expected_count is None:
                if diagnostics is not None:
                    diagnostics.append("source_exchange_unproven")
                continue
            if (len(users) != 1 or not assistants or users[0]["bubble_index"] != 0
                    or len(assistants) != expected_count
                    or [row["bubble_index"] for row in assistants] != list(range(len(assistants)))
                    or rows[0]["role"] != "user"):
                if diagnostics is not None:
                    diagnostics.append("source_exchange_incomplete")
                continue
            exchanges.append(tuple(SourceMessage(
                row["message_id"], row["request_id"], row["role"], row["content"], row["sequence"]
            ) for row in rows))
        return exchanges

    def _excluded(self, connection, conversation_id: str) -> set[str]:
        rows = connection.execute("""SELECT source_json FROM conversation_summary_attempts
            WHERE persona_id=? AND conversation_id=?""", (self.persona_id, conversation_id))
        return {m.message_id for row in rows for m in _messages(row[0])}

    def _selection(self, connection, conversation_id: str) -> SourceSelection:
        diagnostics = []
        result = select_source(self._exchanges(connection, conversation_id, diagnostics),
                               self._excluded(connection, conversation_id),
                               persona_id=self.persona_id, conversation_id=conversation_id)
        return replace(result, diagnostics=tuple(dict.fromkeys(diagnostics + list(result.diagnostics))))

    def select_source(self, conversation_id: str) -> SourceSelection:
        conversation_id = self._conversation(conversation_id)
        with self.kernel_store.transaction() as connection:
            return self._selection(connection, conversation_id)

    def claim_attempt(self, source: SourceBatch, *, now: float, provenance: dict | None = None) -> Attempt | None:
        now = _time(now)
        provenance = _provenance(provenance)
        if source.persona_id != self.persona_id:
            raise SummaryStorageError("summary_scope_mismatch")
        self._conversation(source.conversation_id)
        with self.kernel_store.transaction() as connection:
            last = connection.execute("""SELECT MAX(started_at) FROM conversation_summary_attempts
                WHERE persona_id=? AND conversation_id=?""", (self.persona_id, source.conversation_id)).fetchone()[0]
            if last is not None and now - float(last) < COOLDOWN_SECONDS:
                return None
            selection = self._selection(connection, source.conversation_id)
            if selection.source != source:
                return None
            attempt = Attempt(uuid4().hex, source)
            connection.execute("""INSERT INTO conversation_summary_attempts
                (attempt_id,persona_id,conversation_id,source_digest,source_json,started_at,status,provenance_json)
                VALUES (?,?,?,?,?,?,'started',?)""", (attempt.id, self.persona_id,
                    source.conversation_id, source.source_digest, _json(source_document(source.messages)), now, _json(provenance)))
            return attempt

    def _source_current(self, connection, source: SourceBatch) -> bool:
        if source.persona_id != self.persona_id or not source.messages:
            return False
        canonical = {m.message_id: m for exchange in self._exchanges(connection, source.conversation_id) for m in exchange}
        return (len({m.message_id for m in source.messages}) == len(source.messages)
                and all(canonical.get(m.message_id) == m for m in source.messages)
                and source.source_digest == source_digest(self.persona_id, source.conversation_id, source.messages))

    def complete_attempt(self, attempt: Attempt, text: str, *, now: float) -> StoredSummary:
        now = _time(now)
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_SUMMARY_CHARS:
            raise SummaryStorageError("summary_invalid_output")
        source = attempt.source
        with self.kernel_store.transaction() as connection:
            row = connection.execute("SELECT * FROM conversation_summary_attempts WHERE attempt_id=?", (attempt.id,)).fetchone()
            if (row is None or row["persona_id"] != self.persona_id or row["conversation_id"] != source.conversation_id
                    or row["source_digest"] != source.source_digest or row["status"] != "started"
                    or not self._source_current(connection, source)):
                raise SummaryStorageError("summary_source_changed")
            summary_id = "summary_" + uuid4().hex
            connection.execute("""INSERT INTO conversation_summary_items
                (summary_id,persona_id,conversation_id,text,source_json,source_digest,first_sequence,last_sequence,
                 origin,active,linkage,attempt_id,metadata_json,created_at)
                VALUES (?,?,?,?,?,?,?,?, 'generated',1,'linked',?,?,?)""",
                (summary_id, self.persona_id, source.conversation_id, text, row["source_json"], source.source_digest,
                 source.first_sequence, source.last_sequence, attempt.id, row["provenance_json"], now))
            connection.execute("UPDATE conversation_summary_attempts SET status='completed',finished_at=? WHERE attempt_id=?", (now, attempt.id))
        return StoredSummary(summary_id, text, tuple(m.message_id for m in source.messages),
                             source.first_sequence, source.last_sequence, "generated", True, source.source_digest)

    def fail_attempt(self, attempt: Attempt, code: str, *, now: float) -> None:
        now = _time(now)
        # Codes are fixed public state identifiers, never exception text or inputs.
        if not isinstance(code, str) or not code or len(code) > 80 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789_" for c in code):
            raise SummaryStorageError("summary_invalid_error_code")
        with self.kernel_store.transaction() as connection:
            connection.execute("""UPDATE conversation_summary_attempts SET status='failed',error_code=?,finished_at=?
                WHERE attempt_id=? AND persona_id=? AND conversation_id=? AND source_digest=? AND status='started'""",
                (code, now, attempt.id, self.persona_id, attempt.source.conversation_id, attempt.source.source_digest))

    def _validated_summary(self, connection, row, conversation_id: str, *, for_detail: bool = False) -> StoredSummary | None:
        """One validation boundary for context/status reads and body lookup."""
        if row is None:
            return None
        try:
            metadata = json.loads(row["metadata_json"])
            if for_detail and not isinstance(metadata, dict):
                return None
            provenance = _provenance(metadata)
        except (ValueError, TypeError):
            return None
        messages = _messages(row["source_json"])
        first, last = row["first_sequence"], row["last_sequence"]
        text = row["text"]
        if for_detail:
            for value in provenance.values():
                value.encode("utf-8")
            if (not messages or len(messages) > MAX_SOURCE_MESSAGES
                    or row["persona_id"] != self.persona_id or row["conversation_id"] != conversation_id
                    or row["active"] != 1 or row["origin"] != "generated"
                    or not isinstance(row["summary_id"], str)
                    or not _SUMMARY_ID_PATTERN.fullmatch(row["summary_id"])
                    or not isinstance(first, int) or isinstance(first, bool)
                    or not isinstance(last, int) or isinstance(last, bool)
                    or first < 1 or last > 9_007_199_254_740_991
                    or first != min(m.sequence for m in messages) or last != max(m.sequence for m in messages)
                    or any(not m.message_id or m.message_id.strip() != m.message_id
                           or "\x00" in m.message_id or len(m.message_id) > 512 for m in messages)):
                return None
            for message in messages:
                message.message_id.encode("utf-8")
        source = SourceBatch(self.persona_id, conversation_id, messages, row["source_digest"], first, last)
        if (not self._source_current(connection, source) or not isinstance(text, str)
                or not text.strip() or len(text) > MAX_SUMMARY_CHARS):
            return None
        if for_detail:
            # A body must be a valid Unicode string that the transport can
            # return verbatim; never repair, trim or truncate stored content.
            text.encode("utf-8")
        return StoredSummary(row["summary_id"], text, tuple(m.message_id for m in messages),
                             first, last, row["origin"], True, row["source_digest"],
                             provenance["algorithm_version"])

    def get_summary(self, conversation_id: str, summary_id: str) -> StoredSummary | None:
        """Read one current-scope generated record without scanning summaries."""
        conversation_id = self._conversation(conversation_id)
        if not isinstance(summary_id, str) or not _SUMMARY_ID_PATTERN.fullmatch(summary_id):
            return None
        with self.kernel_store.transaction() as connection:
            row = connection.execute("""SELECT * FROM conversation_summary_items
                WHERE summary_id=? AND persona_id=? AND conversation_id=? AND active=1 AND origin='generated'""",
                (summary_id, self.persona_id, conversation_id)).fetchone()
            try:
                return self._validated_summary(connection, row, conversation_id, for_detail=True)
            except (ValueError, TypeError, KeyError):
                # Body reads fail closed even when a source record is corrupt.
                # Existing context/status exception behavior stays unchanged.
                return None

    def active_summaries(self, conversation_id: str) -> tuple[StoredSummary, ...]:
        conversation_id = self._conversation(conversation_id)
        with self.kernel_store.transaction() as connection:
            rows = connection.execute("""SELECT * FROM conversation_summary_items
                WHERE persona_id=? AND conversation_id=? AND active=1 AND origin='generated'
                ORDER BY last_sequence DESC, summary_id""", (self.persona_id, conversation_id)).fetchall()
            output = []
            for row in rows:
                item = self._validated_summary(connection, row, conversation_id)
                if item is not None:
                    output.append(item)
            return tuple(output)

    def status(self, conversation_id: str, *, now: float | None = None) -> dict:
        conversation_id = self._conversation(conversation_id)
        now = _time(time.time() if now is None else now)
        with self.kernel_store.transaction() as connection:
            counts = {row[0]: row[1] for row in connection.execute("""SELECT status,COUNT(*) FROM conversation_summary_attempts
                WHERE persona_id=? AND conversation_id=? GROUP BY status""", (self.persona_id, conversation_id))}
            last = connection.execute("""SELECT status,error_code,started_at,finished_at FROM conversation_summary_attempts
                WHERE persona_id=? AND conversation_id=? ORDER BY started_at DESC,attempt_id LIMIT 1""",
                (self.persona_id, conversation_id)).fetchone()
            imported = connection.execute("""SELECT COUNT(*) FROM conversation_summary_items WHERE origin='legacy'
                AND (persona_id=? OR persona_id IS NULL)""", (self.persona_id,)).fetchone()[0]
            selection = self._selection(connection, conversation_id)
        active = self.active_summaries(conversation_id)
        last_status = last["status"] if last else None
        state = ("outcome_unknown" if last_status == "started" else "failed" if last_status == "failed"
                 else "ready" if active else "not_ready")
        identities = [{"summary_id": item.id, "sourceDigest": item.source_digest,
                       "firstSequence": item.source_first_sequence, "lastSequence": item.source_last_sequence,
                       "messageIds": list(item.source_ids), "contractVersion": item.contract_version}
                      for item in active[:100]]
        return {"status": state, "errorCode": last["error_code"] if last else None,
                "attempts": counts, "lastAttempt": dict(last) if last else None,
                "activeCount": len(active), "legacyInactiveCount": imported,
                "cooldownSeconds": COOLDOWN_SECONDS, "sourceDiagnostics": list(selection.diagnostics),
                "cooldownRemainingSeconds": max(0, COOLDOWN_SECONDS - (now - last["started_at"])) if last else 0,
                "pendingBudget": selection.pending_budget, "summaries": identities,
                "summaryTotal": len(active), "hasMore": len(active) > 100}

    @staticmethod
    def _document(document: LegacyDocument | str | bytes, expected_digest: str | None) -> LegacyDocument:
        # Reparse even a constructed document: caller-created dataclasses are
        # not authority to bypass the size/shape/duplicate-key contract.
        result = parse_legacy(document.raw_text if isinstance(document, LegacyDocument) else document)
        if expected_digest is not None and expected_digest != result.sha256:
            raise LegacyImportError("legacy_digest_changed")
        return result

    def _link_legacy(self, connection, ids: tuple[str, ...]) -> tuple[str | None, str | None, tuple[SourceMessage, ...]]:
        if not ids:
            return None, None, ()
        found = {}
        distinct = list(dict.fromkeys(ids))
        for index in range(0, len(distinct), 400):
            batch = distinct[index:index + 400]
            marks = ",".join("?" for _ in batch)
            for row in connection.execute(f"""SELECT m.rowid AS sequence,m.*
                FROM messages m JOIN command_ledger c ON c.request_id=m.request_id
                WHERE m.message_id IN ({marks}) AND c.persona_id=m.persona_id
                  AND c.command='chat:send' AND c.state='committed' AND m.source='chat'
                  AND m.role IN ('user','assistant')""", batch):
                found[row["message_id"]] = row
        if len(found) != len(distinct):
            return None, None, ()
        scopes = {(row["persona_id"], row["conversation_id"]) for row in found.values()}
        if len(scopes) != 1:
            return None, None, ()
        persona, conversation = next(iter(scopes))
        messages = tuple(SourceMessage(row["message_id"], row["request_id"], row["role"], row["content"], row["sequence"])
                         for row in sorted(found.values(), key=lambda row: row["sequence"]))
        return persona, conversation, messages

    def _preview(self, connection, document: LegacyDocument) -> dict:
        items = []
        for entry in document.entries:
            persona, conversation, messages = self._link_legacy(connection, entry.chat_ids)
            items.append({"position": entry.position, "linkage": "linked" if messages else "unattributed",
                          "persona_id": persona, "conversation_id": conversation,
                          "sourceCount": len(entry.chat_ids), "active": False})
        linked = sum(item["linkage"] == "linked" for item in items)
        return {"sha256": document.sha256, "total": len(items), "linked": linked,
                "unattributed": len(items) - linked, "active": 0, "entries": items}

    def preview_legacy(self, document: LegacyDocument | str | bytes, *, expected_digest: str | None = None) -> dict:
        document = self._document(document, expected_digest)
        with self.kernel_store.transaction() as connection:
            return self._preview(connection, document)

    def import_legacy(self, document: LegacyDocument | str | bytes, *, now: float,
                      expected_digest: str | None = None) -> dict:
        now = _time(now)
        document = self._document(document, expected_digest)
        with self.kernel_store.transaction() as connection:
            existing = connection.execute("SELECT 1 FROM conversation_summary_imports WHERE source_sha256=?", (document.sha256,)).fetchone()
            result = self._preview(connection, document)
            if existing:
                # Re-import reports the original durable attribution. Newly
                # appearing IDs never silently activate or reclassify records.
                rows = connection.execute("""SELECT legacy_position,linkage,persona_id,conversation_id
                    FROM conversation_summary_items WHERE legacy_sha256=? ORDER BY legacy_position""",
                    (document.sha256,)).fetchall()
                entries = [{"position": row["legacy_position"], "linkage": row["linkage"],
                            "persona_id": row["persona_id"], "conversation_id": row["conversation_id"],
                            "sourceCount": len(document.entries[row["legacy_position"]].chat_ids), "active": False}
                           for row in rows]
                linked = sum(row["linkage"] == "linked" for row in rows)
                return {"sha256": document.sha256, "total": len(entries), "linked": linked,
                        "unattributed": len(entries) - linked, "active": 0, "entries": entries,
                        "imported": 0, "reused": True}
            connection.execute("INSERT INTO conversation_summary_imports VALUES (?,?,?)", (document.sha256, document.raw_text, now))
            for entry in document.entries:
                persona, conversation, messages = self._link_legacy(connection, entry.chat_ids)
                summary_id = "legacy_" + hashlib.sha256(f"{document.sha256}:{entry.position}".encode("ascii")).hexdigest()
                connection.execute("""INSERT INTO conversation_summary_items
                    (summary_id,persona_id,conversation_id,text,source_json,source_digest,first_sequence,last_sequence,
                     origin,active,linkage,legacy_sha256,legacy_position,metadata_json,created_at)
                    VALUES (?,?,?,?,?,?,?,?, 'legacy',0,?,?,?,?,?)""",
                    (summary_id, persona, conversation, entry.text, _json(source_document(messages)),
                     source_digest(persona, conversation, messages) if messages else None,
                     messages[0].sequence if messages else 0, messages[-1].sequence if messages else 0,
                     "linked" if messages else "unattributed", document.sha256, entry.position,
                     _json({"originalChatIds": list(entry.chat_ids), **entry.metadata}), now))
            return {**result, "imported": len(document.entries), "reused": False}
