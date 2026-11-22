"""Preview-only keepsakes stored in the encrypted kernel database."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone, tzinfo
import json
import random
from typing import Callable
from uuid import uuid4

from src.kernel.contracts import PersonaScopeV4
from src.kernel.storage import KernelStore


PAGE_SIZE = 20
CONTENT_CHARS = 4000
MAX_KEEPSAKES = 200


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class PreviewKeepsakeError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class PreviewRecall:
    keepsake_id: str
    context: str
    persona_scope: PersonaScopeV4


class PreviewKeepsakes:
    """A persona-bound view; construction is restricted to preview assembly."""

    def __init__(
        self, store: KernelStore, persona_id: str, *, clock: Callable[[], datetime] = utc_now,
        random_func: Callable[[], float] = random.random, choice_func: Callable = random.choice,
        require_writable: Callable[[], None] | None = None,
        local_timezone: tzinfo | None = None,
    ) -> None:
        self.store = store
        self.persona_id = persona_id
        self.clock = clock
        # None asks astimezone() for the current machine zone on each check.
        self.timezone = local_timezone
        self.random_func = random_func
        self.choice_func = choice_func
        self.require_writable = require_writable
        with store.transaction() as connection:
            connection.execute("""
                CREATE TABLE IF NOT EXISTS preview_keepsakes (
                    id TEXT PRIMARY KEY,
                    persona_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    source TEXT NOT NULL,
                    original_message_at_utc TEXT NOT NULL,
                    content TEXT NOT NULL,
                    media_ids_json TEXT NOT NULL,
                    created_at_utc TEXT NOT NULL,
                    last_recalled_at_utc TEXT,
                    UNIQUE(persona_id, message_id)
                )
            """)
            connection.execute("""
                CREATE INDEX IF NOT EXISTS preview_keepsakes_persona_created
                ON preview_keepsakes(persona_id, created_at_utc DESC, id DESC)
            """)
            connection.execute("""
                CREATE TABLE IF NOT EXISTS preview_keepsake_recall_days (
                    persona_id TEXT PRIMARY KEY,
                    last_recalled_at_utc TEXT NOT NULL
                )
            """)

    def now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None or value.utcoffset() is None:
            raise PreviewKeepsakeError("KEEPSAKE_CLOCK_INVALID")
        return value.astimezone(timezone.utc)

    @staticmethod
    def _item(row, content_offset: int = 0) -> dict:
        content = str(row["content"])
        if content_offset < 0 or content_offset > len(content):
            raise PreviewKeepsakeError("KEEPSAKE_CONTENT_OFFSET_INVALID")
        end = min(len(content), content_offset + CONTENT_CHARS)
        return {
            "id": row["id"], "message_id": row["message_id"],
            "conversation_id": row["conversation_id"], "role": row["role"], "source": row["source"],
            "original_message_at_utc": row["original_message_at_utc"],
            "content": content[content_offset:end], "media_ids": json.loads(row["media_ids_json"]),
            "created_at_utc": row["created_at_utc"], "content_offset": content_offset,
            "content_total_chars": len(content), "content_next_offset": end if end < len(content) else None,
        }

    def _ids(self, connection) -> list[str]:
        return [str(row[0]) for row in connection.execute(
            "SELECT message_id FROM preview_keepsakes WHERE persona_id = ? ORDER BY created_at_utc DESC, id DESC",
            (self.persona_id,),
        ).fetchall()]

    def message_ids(self) -> list[str]:
        with self.store.transaction() as connection:
            return self._ids(connection)

    def collect(self, message_id: str) -> dict:
        with self.store.transaction() as connection:
            existing = connection.execute(
                "SELECT * FROM preview_keepsakes WHERE persona_id = ? AND message_id = ?",
                (self.persona_id, message_id),
            ).fetchone()
            if existing is not None:
                return {"item": self._item(existing), "created": False,
                        "preview_keepsake_message_ids": self._ids(connection)}
            message = connection.execute(
                "SELECT * FROM messages WHERE message_id = ? AND persona_id = ? AND role IN ('user', 'assistant')",
                (message_id, self.persona_id),
            ).fetchone()
            if message is None:
                raise PreviewKeepsakeError("KEEPSAKE_MESSAGE_NOT_FOUND")
            count = connection.execute(
                "SELECT count(*) FROM preview_keepsakes WHERE persona_id = ?", (self.persona_id,),
            ).fetchone()[0]
            if count >= MAX_KEEPSAKES:
                raise PreviewKeepsakeError("KEEPSAKE_FULL")
            media_ids = [str(row[0]) for row in connection.execute(
                "SELECT media_id FROM preview_chat_image_links WHERE message_id = ? ORDER BY media_id",
                (message_id,),
            ).fetchall()]
            keepsake_id = "keepsake_" + uuid4().hex
            connection.execute("""
                INSERT INTO preview_keepsakes (
                    id, persona_id, message_id, conversation_id, role, source,
                    original_message_at_utc, content, media_ids_json, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (keepsake_id, self.persona_id, message_id, message["conversation_id"], message["role"],
                  message["source"], message["created_at_utc"], message["content"],
                  json.dumps(media_ids, separators=(",", ":")), self.now().isoformat()))
            row = connection.execute("SELECT * FROM preview_keepsakes WHERE id = ?", (keepsake_id,)).fetchone()
            return {"item": self._item(row), "created": True,
                    "preview_keepsake_message_ids": self._ids(connection)}

    def page(self, *, offset: int = 0, keepsake_id: str | None = None, content_offset: int = 0) -> dict:
        with self.store.transaction() as connection:
            if keepsake_id is not None:
                row = connection.execute(
                    "SELECT * FROM preview_keepsakes WHERE id = ? AND persona_id = ?",
                    (keepsake_id, self.persona_id),
                ).fetchone()
                if row is None:
                    raise PreviewKeepsakeError("KEEPSAKE_NOT_FOUND")
                return {"mode": "content", "item": self._item(row, content_offset)}
            rows = connection.execute("""
                SELECT * FROM preview_keepsakes WHERE persona_id = ?
                ORDER BY created_at_utc DESC, id DESC LIMIT ? OFFSET ?
            """, (self.persona_id, PAGE_SIZE, offset)).fetchall()
            ids = self._ids(connection)
            next_offset = offset + len(rows)
            has_more = next_offset < len(ids)
            return {"mode": "list", "items": [self._item(row) for row in rows],
                    "offset": offset, "next_offset": next_offset if has_more else None,
                    "has_more": has_more, "total": len(ids), "preview_keepsake_message_ids": ids}

    def remove(self, keepsake_id: str) -> dict:
        with self.store.transaction() as connection:
            row = connection.execute(
                "SELECT message_id FROM preview_keepsakes WHERE id = ? AND persona_id = ?",
                (keepsake_id, self.persona_id),
            ).fetchone()
            if row is None:
                raise PreviewKeepsakeError("KEEPSAKE_NOT_FOUND")
            connection.execute("DELETE FROM preview_keepsakes WHERE id = ? AND persona_id = ?",
                               (keepsake_id, self.persona_id))
            return {"keepsake_id": keepsake_id, "message_id": row["message_id"], "removed": True,
                    "preview_keepsake_message_ids": self._ids(connection)}

    def _day_used(self, connection, now: datetime) -> bool:
        daily = connection.execute(
            "SELECT last_recalled_at_utc FROM preview_keepsake_recall_days WHERE persona_id = ?",
            (self.persona_id,),
        ).fetchone()
        return daily is not None and (
            datetime.fromisoformat(daily[0]).astimezone(self.timezone).date()
            >= now.astimezone(self.timezone).date()
        )

    def prepare_recall_context(self) -> PreviewRecall | None:
        """Choose a prompt candidate without consuming either durable allowance."""
        now = self.now()
        with self.store.transaction() as connection:
            scope = self.store.active_persona()
            if scope is None or scope.persona_id != self.persona_id or self._day_used(connection, now):
                return None
            rows = connection.execute("""
                SELECT * FROM preview_keepsakes WHERE persona_id = ?
                AND created_at_utc <= ? AND (last_recalled_at_utc IS NULL OR last_recalled_at_utc <= ?)
                ORDER BY created_at_utc, id
            """, (self.persona_id, (now - timedelta(hours=24)).isoformat(),
                  (now - timedelta(days=7)).isoformat())).fetchall()
            candidates = []
            for row in rows:
                text = row["content"].strip()
                # The native composer persists this placeholder for image-only input.
                image_only = bool(json.loads(row["media_ids_json"])) and text == "[图片]"
                if text and not image_only:
                    candidates.append(row)
            if not candidates or not 0 <= self.random_func() < 0.05:
                return None
            never_recalled = [row for row in candidates if row["last_recalled_at_utc"] is None]
            selected = self.choice_func(never_recalled or candidates)
            context = (
                "You once kept this message because it mattered.\n"
                f"Content: {selected['content'][:300]}\n"
                "If it fits naturally, you may bring it up like: \"我翻到这个了，还记得吗？\" "
                "Do not recite it like a database and do not invent exact dates."
            )
            return PreviewRecall(selected["id"], context, scope)

    def maybe_recall_context(self) -> str:
        """Compatibility read for callers that only construct a prompt."""
        selected = self.prepare_recall_context()
        return selected.context if selected is not None else ""

    def commit_recall(self, selected: PreviewRecall, *, request_id: str, conversation_id: str) -> bool:
        """Record a selected item only after this scoped reply is in the kernel history."""
        now = self.now()
        with self.store.transaction() as connection:
            current = self.store.active_persona()
            if current != selected.persona_scope or current is None or current.persona_id != self.persona_id:
                return False
            command = connection.execute("""
                SELECT persona_id, persona_epoch, persona_fingerprint, state
                FROM command_ledger WHERE request_id = ? AND command = 'chat:send'
            """, (request_id,)).fetchone()
            if command is None or command["state"] != "committed" or (
                command["persona_id"], command["persona_epoch"], command["persona_fingerprint"]
            ) != (current.persona_id, current.epoch, current.fingerprint):
                return False
            reply = connection.execute("""
                SELECT 1 FROM messages WHERE request_id = ? AND conversation_id = ?
                AND persona_id = ? AND role = 'assistant' AND length(content) > 0 LIMIT 1
            """, (request_id, conversation_id, self.persona_id)).fetchone()
            if reply is None or self._day_used(connection, now):
                return False
            row = connection.execute(
                "SELECT last_recalled_at_utc FROM preview_keepsakes WHERE id = ? AND persona_id = ?",
                (selected.keepsake_id, self.persona_id),
            ).fetchone()
            if row is None or (row[0] is not None and datetime.fromisoformat(row[0]) > now - timedelta(days=7)):
                return False
            if self.require_writable is not None:
                self.require_writable()
            stamp = now.isoformat()
            connection.execute("UPDATE preview_keepsakes SET last_recalled_at_utc = ? WHERE id = ? AND persona_id = ?",
                               (stamp, selected.keepsake_id, self.persona_id))
            connection.execute("""
                INSERT INTO preview_keepsake_recall_days(persona_id, last_recalled_at_utc) VALUES (?, ?)
                ON CONFLICT(persona_id) DO UPDATE SET last_recalled_at_utc = excluded.last_recalled_at_utc
            """, (self.persona_id, stamp))
            return True
