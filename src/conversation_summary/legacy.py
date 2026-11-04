"""Bounded import contract for explicitly selected legacy summary files.

Only the documented data shape is supported. No file discovery, path reads,
old compressor imports, identity inference, or activation occurs here.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math


MAX_LEGACY_BYTES = 128 * 1024
_ENTRY_FIELDS = frozenset({"text", "chat_ids", "is_important", "category_id", "tags", "created_at"})


class LegacyImportError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class LegacyEntry:
    position: int
    text: str
    chat_ids: tuple[str, ...]
    metadata: dict


@dataclass(frozen=True, slots=True)
class LegacyDocument:
    sha256: str
    raw_text: str
    entries: tuple[LegacyEntry, ...]


def _pairs(items: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            raise LegacyImportError("legacy_duplicate_key")
        result[key] = value
    return result


def parse_legacy(content: str | bytes) -> LegacyDocument:
    if not isinstance(content, (str, bytes)):
        raise LegacyImportError("legacy_content_type")
    try:
        payload = content.encode("utf-8") if isinstance(content, str) else content
    except UnicodeError as exc:
        raise LegacyImportError("legacy_encoding") from exc
    if len(payload) > MAX_LEGACY_BYTES:
        raise LegacyImportError("legacy_size_limit")
    try:
        raw = payload.decode("utf-8")
        value = json.loads(raw, object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(LegacyImportError("legacy_nonfinite")))
    except LegacyImportError:
        raise
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise LegacyImportError("legacy_invalid_json") from exc
    if not isinstance(value, dict) or set(value) != {"summaries"} or not isinstance(value["summaries"], list):
        raise LegacyImportError("legacy_shape")
    try:
        # JSON escape syntax can represent lone surrogates even though they
        # cannot be stored as UTF-8 text. Refuse them before any transaction.
        json.dumps(value, ensure_ascii=False).encode("utf-8")
    except (UnicodeError, RecursionError) as exc:
        raise LegacyImportError("legacy_encoding") from exc
    entries: list[LegacyEntry] = []
    for position, item in enumerate(value["summaries"]):
        if not isinstance(item, dict) or set(item) - _ENTRY_FIELDS or not isinstance(item.get("text"), str):
            raise LegacyImportError("legacy_entry_shape")
        ids = item.get("chat_ids", [])
        tags = item.get("tags", [])
        if (not isinstance(ids, list) or any(not isinstance(i, str) or not i or len(i) > 256 for i in ids)
                or not isinstance(tags, list) or any(not isinstance(t, str) for t in tags)):
            raise LegacyImportError("legacy_entry_shape")
        if "is_important" in item and not isinstance(item["is_important"], bool):
            raise LegacyImportError("legacy_entry_shape")
        if item.get("category_id") is not None and not isinstance(item["category_id"], str):
            raise LegacyImportError("legacy_entry_shape")
        created = item.get("created_at")
        if created is not None and (isinstance(created, bool) or not isinstance(created, (str, int, float))
                                    or isinstance(created, float) and not math.isfinite(created)):
            raise LegacyImportError("legacy_entry_shape")
        entries.append(LegacyEntry(position, item["text"], tuple(ids),
                                   {key: item[key] for key in ("is_important", "category_id", "tags", "created_at") if key in item}))
    return LegacyDocument(hashlib.sha256(payload).hexdigest(), raw, tuple(entries))
