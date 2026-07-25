"""Canonical optional storage for social character cards and world books."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any

from src.kernel.modules import CapabilityManifest
from src.kernel.storage import connect_sqlite


ARCHIVE_SCHEMA_VERSION = 1
MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
MAX_CHARACTERS = 200
MAX_WORLD_BOOKS = 200
MAX_WORLD_BOOK_ENTRIES = 10_000
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
_DANGEROUS_KEYS = frozenset({"__proto__", "prototype", "constructor"})


class ArchiveConflict(RuntimeError):
    """The caller edited a stale archive revision."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: Any, *, label: str, maximum: int, required: bool = False) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    result = value.strip()
    if (required and not result) or len(result) > maximum or "\x00" in result:
        raise ValueError(f"{label} is invalid")
    return result


def _identifier(value: Any, *, label: str) -> str:
    result = _text(value, label=label, maximum=160, required=True)
    if not _ID.fullmatch(result):
        raise ValueError(f"{label} contains unsupported characters")
    return result


def _string_list(value: Any, *, label: str, limit: int = 100) -> list[str]:
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f"{label} must be a bounded array")
    return [
        _text(item, label=f"{label} item", maximum=500, required=True)
        for item in value
    ]


def _asset_reference(value: Any) -> str:
    result = _text(value or "", label="portraitUrl", maximum=512)
    lowered = result.lower()
    if (
        lowered.startswith(("http:", "https:", "data:", "file:"))
        or "\\" in result
        or ".." in result.split("/")
    ):
        raise ValueError("portraitUrl must reference a managed local asset")
    return result


def _character(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or _DANGEROUS_KEYS.intersection(value):
        raise ValueError("character must be an object")
    allowed = {
        "id", "name", "alternateName", "age", "birthday", "role", "identity",
        "schedule", "likesDiary", "values", "catchphrases", "neverSay",
        "portraitUrl", "description", "personality", "speakingStyle",
        "firstMessage", "tags", "createdAt", "updatedAt",
    }
    if set(value) - allowed:
        raise ValueError("character contains unsupported fields")
    return {
        "id": _identifier(value.get("id"), label="character id"),
        "name": _text(value.get("name"), label="character name", maximum=160, required=True),
        "alternateName": _text(value.get("alternateName", ""), label="alternateName", maximum=160),
        "age": _text(value.get("age", ""), label="age", maximum=80),
        "birthday": _text(value.get("birthday", ""), label="birthday", maximum=80),
        "role": _text(value.get("role", ""), label="role", maximum=500),
        "identity": _text(value.get("identity", ""), label="identity", maximum=10_000),
        "schedule": _text(value.get("schedule", ""), label="schedule", maximum=500),
        "likesDiary": value.get("likesDiary") is True,
        "values": _text(value.get("values", ""), label="values", maximum=10_000),
        "catchphrases": _string_list(value.get("catchphrases", []), label="catchphrases"),
        "neverSay": _string_list(value.get("neverSay", []), label="neverSay"),
        "portraitUrl": _asset_reference(value.get("portraitUrl", "")),
        "description": _text(
            value.get("description"), label="description", maximum=50_000, required=True
        ),
        "personality": _text(value.get("personality", ""), label="personality", maximum=30_000),
        "speakingStyle": _text(
            value.get("speakingStyle", ""), label="speakingStyle", maximum=30_000
        ),
        "firstMessage": _text(
            value.get("firstMessage", ""), label="firstMessage", maximum=20_000
        ),
        "tags": _string_list(value.get("tags", []), label="tags"),
        "createdAt": _text(value.get("createdAt", _now()), label="createdAt", maximum=64),
        "updatedAt": _text(value.get("updatedAt", _now()), label="updatedAt", maximum=64),
    }


def _world_entry(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or _DANGEROUS_KEYS.intersection(value):
        raise ValueError("world-book entry must be an object")
    allowed = {"id", "key", "comment", "content", "alwaysActive", "enabled"}
    if set(value) - allowed:
        raise ValueError("world-book entry contains unsupported fields")
    return {
        "id": _identifier(value.get("id"), label="world-book entry id"),
        "key": _text(value.get("key", ""), label="world-book key", maximum=5_000),
        "comment": _text(value.get("comment", ""), label="world-book comment", maximum=5_000),
        "content": _text(
            value.get("content"), label="world-book content", maximum=100_000, required=True
        ),
        "alwaysActive": value.get("alwaysActive") is True,
        "enabled": value.get("enabled") is not False,
    }


def _world_book(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or _DANGEROUS_KEYS.intersection(value):
        raise ValueError("world book must be an object")
    allowed = {"id", "name", "entries", "createdAt", "updatedAt"}
    if set(value) - allowed:
        raise ValueError("world book contains unsupported fields")
    entries = value.get("entries", [])
    if not isinstance(entries, list) or len(entries) > MAX_WORLD_BOOK_ENTRIES:
        raise ValueError("world-book entries exceed the safe limit")
    return {
        "id": _identifier(value.get("id"), label="world-book id"),
        "name": _text(value.get("name"), label="world-book name", maximum=500, required=True),
        "entries": [_world_entry(item) for item in entries],
        "createdAt": _text(value.get("createdAt", _now()), label="createdAt", maximum=64),
        "updatedAt": _text(value.get("updatedAt", _now()), label="updatedAt", maximum=64),
    }


def normalize_archive(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or _DANGEROUS_KEYS.intersection(value):
        raise ValueError("archive must be an object")
    if set(value) - {"characters", "activeCharacterIds", "worldBooks"}:
        raise ValueError("archive contains unsupported fields")
    characters = value.get("characters", [])
    world_books = value.get("worldBooks", [])
    if not isinstance(characters, list) or len(characters) > MAX_CHARACTERS:
        raise ValueError("character count exceeds the safe limit")
    if not isinstance(world_books, list) or len(world_books) > MAX_WORLD_BOOKS:
        raise ValueError("world-book count exceeds the safe limit")
    normalized_characters = [_character(item) for item in characters]
    character_ids = {item["id"] for item in normalized_characters}
    if len(character_ids) != len(normalized_characters):
        raise ValueError("archive contains duplicate character ids")
    active = _string_list(
        value.get("activeCharacterIds", []),
        label="activeCharacterIds",
        limit=MAX_CHARACTERS,
    )
    if len(set(active)) != len(active) or any(item not in character_ids for item in active):
        raise ValueError("activeCharacterIds contains an unknown or duplicate id")
    normalized_books = [_world_book(item) for item in world_books]
    if len({item["id"] for item in normalized_books}) != len(normalized_books):
        raise ValueError("archive contains duplicate world-book ids")
    result = {
        "characters": normalized_characters,
        "activeCharacterIds": active,
        "worldBooks": normalized_books,
    }
    encoded = json.dumps(
        result, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    if len(encoded) > MAX_ARCHIVE_BYTES:
        raise ValueError("archive exceeds the safe serialized size")
    return result


class ArchiveStore:
    """One SQLite writer for an optional persona-scoped archive."""

    manifest = CapabilityManifest(
        module_id="archive",
        version="1.0.0",
        api_consuming=False,
        default_enabled=True,
        dependencies=(),
        data_permissions=("archive:read", "archive:write"),
    )

    def __init__(self, path: Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()
        self._connection = connect_sqlite(self.path)
        self._connection.executescript(
            """
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS archive_state (
                persona_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                archive_json TEXT NOT NULL,
                checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
                updated_at_utc TEXT NOT NULL
            );
            COMMIT;
            """
        )
        self._connection.execute(f"PRAGMA user_version = {ARCHIVE_SCHEMA_VERSION}")

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def get(self, persona_id: str) -> dict[str, Any]:
        persona_id = _identifier(persona_id, label="persona id")
        with self._lock:
            row = self._connection.execute(
                """
                SELECT revision, archive_json, checksum_sha256, updated_at_utc
                FROM archive_state WHERE persona_id = ?
                """,
                (persona_id,),
            ).fetchone()
        if row is None:
            return {
                "exists": False,
                "revision": 0,
                "archive": None,
                "checksum": "",
                "updated_at_utc": "",
            }
        raw = str(row["archive_json"])
        checksum = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        if checksum != row["checksum_sha256"]:
            raise RuntimeError("archive checksum mismatch")
        return {
            "exists": True,
            "revision": int(row["revision"]),
            "archive": json.loads(raw),
            "checksum": checksum,
            "updated_at_utc": str(row["updated_at_utc"]),
        }

    def put(
        self,
        persona_id: str,
        archive: Any,
        *,
        expected_revision: int,
        migrate_only: bool = False,
    ) -> dict[str, Any]:
        persona_id = _identifier(persona_id, label="persona id")
        if isinstance(expected_revision, bool) or expected_revision < 0:
            raise ValueError("expected revision is invalid")
        normalized = normalize_archive(archive)
        raw = json.dumps(
            normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        checksum = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        now = _now()
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    "SELECT revision FROM archive_state WHERE persona_id = ?",
                    (persona_id,),
                ).fetchone()
                current = int(row["revision"]) if row else 0
                if migrate_only and current:
                    self._connection.execute("ROLLBACK")
                    return self.get(persona_id)
                if current != expected_revision:
                    raise ArchiveConflict(
                        f"archive revision changed from {expected_revision} to {current}"
                    )
                revision = current + 1
                self._connection.execute(
                    """
                    INSERT INTO archive_state(
                        persona_id, revision, archive_json,
                        checksum_sha256, updated_at_utc
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(persona_id) DO UPDATE SET
                        revision = excluded.revision,
                        archive_json = excluded.archive_json,
                        checksum_sha256 = excluded.checksum_sha256,
                        updated_at_utc = excluded.updated_at_utc
                    """,
                    (persona_id, revision, raw, checksum, now),
                )
                self._connection.execute("COMMIT")
            except BaseException:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise
        return {
            "exists": True,
            "revision": revision,
            "archive": normalized,
            "checksum": checksum,
            "updated_at_utc": now,
        }

    def start(self) -> None:
        if self.integrity_check() != "ok":
            raise RuntimeError("archive database integrity check failed")

    def stop(self) -> None:
        # The registry gates new calls. Keep the connection available so a
        # user-requested retry can restart this detachable module in-process.
        return

    def handle_event(self, _event) -> None:
        return

    def integrity_check(self) -> str:
        with self._lock:
            row = self._connection.execute("PRAGMA integrity_check").fetchone()
        return str(row[0] if row else "")

    def health(self) -> dict[str, Any]:
        with self._lock:
            count = self._connection.execute(
                "SELECT count(*) FROM archive_state"
            ).fetchone()[0]
        return {
            "integrity": self.integrity_check(),
            "persona_archives": int(count),
            "schema_version": ARCHIVE_SCHEMA_VERSION,
        }
