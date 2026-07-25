"""Keepsake collection for photos, stickers, screenshots, and shared memories."""

from __future__ import annotations

import json
import logging
import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from ..config.settings import KEEPSAKE_DIR

logger = logging.getLogger("reverie.keepsakes")

KEEPSAKE_KINDS = {"photo", "sticker", "chat_screenshot", "special_memory", "text"}
MAX_MEDIA_DATA_URL_LENGTH = 2 * 1024 * 1024


@dataclass
class Keepsake:
    """A user/character collected memento."""

    id: str
    kind: str
    title: str
    content: str = ""
    source_path: str = ""
    media_data_url: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    last_recalled_at: str | None = None
    importance: float = 0.5

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "content": self.content,
            "source_path": self.source_path,
            "media_data_url": self.media_data_url,
            "tags": list(self.tags),
            "created_at": self.created_at,
            "last_recalled_at": self.last_recalled_at,
            "importance": self.importance,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Keepsake":
        kind = _sanitize_kind(data.get("kind", "text"))
        return cls(
            id=str(data.get("id") or uuid.uuid4().hex),
            kind=kind,
            title=_safe_text(data.get("title", ""), 80) or _default_title(kind),
            content=_safe_text(data.get("content", ""), 1200),
            source_path=_safe_text(data.get("source_path", ""), 1000),
            media_data_url=_safe_media_data_url(data.get("media_data_url", "")),
            tags=_safe_tags(data.get("tags", [])),
            created_at=_safe_text(data.get("created_at", ""), 64) or datetime.now().isoformat(),
            last_recalled_at=_safe_text(data.get("last_recalled_at", ""), 64) or None,
            importance=_clamp_float(data.get("importance", 0.5), 0.0, 1.0),
        )


class KeepsakeManager:
    """Persistent memory collection independent from chat history."""

    def __init__(
        self,
        data_dir: Path | None = None,
        *,
        enabled: bool = True,
        recall_probability: float = 0.05,
        random_func: Callable[[], float] = random.random,
    ) -> None:
        self.data_dir = data_dir or KEEPSAKE_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.enabled = enabled
        self.recall_probability = _clamp_float(recall_probability, 0.01, 0.30)
        self.random_func = random_func
        self._items: list[Keepsake] = []
        self._load()

    @property
    def path(self) -> Path:
        return self.data_dir / "keepsakes.json"

    def apply_settings(self, *, enabled: bool, recall_probability: float) -> None:
        self.enabled = enabled
        self.recall_probability = _clamp_float(recall_probability, 0.01, 0.30)

    def add(
        self,
        *,
        kind: str,
        title: str,
        content: str = "",
        source_path: str = "",
        media_data_url: str = "",
        tags: list[str] | str | None = None,
        importance: float = 0.5,
    ) -> Keepsake:
        item = Keepsake(
            id=uuid.uuid4().hex,
            kind=_sanitize_kind(kind),
            title=_safe_text(title, 80) or _default_title(kind),
            content=_safe_text(content, 1200),
            source_path=_safe_text(source_path, 1000),
            media_data_url=_safe_media_data_url(media_data_url),
            tags=_safe_tags(tags or []),
            importance=_clamp_float(importance, 0.0, 1.0),
        )
        self._items.append(item)
        self._save()
        return item

    def list_recent(self, limit: int = 20) -> list[Keepsake]:
        limit = max(1, min(100, int(limit)))
        return sorted(self._items, key=lambda item: item.created_at, reverse=True)[:limit]

    def maybe_recall_context(self) -> str:
        """Maybe return a natural-language prompt block for one stored keepsake."""
        if not self.enabled or not self._items:
            return ""
        if self.random_func() > self.recall_probability:
            return ""
        item = self._pick_recall_item()
        if item is None:
            return ""
        item.last_recalled_at = datetime.now().isoformat()
        self._save()
        return self.format_for_prompt(item)

    def format_for_prompt(self, item: Keepsake) -> str:
        tags = "、".join(item.tags) if item.tags else "未标注"
        media_hint = ""
        if item.kind in {"photo", "sticker", "chat_screenshot"}:
            media_hint = " This keepsake may include user-provided image data or a local source path."
        return (
            "=== MEMORY COLLECTION ===\n"
            f"You once kept this {item.kind} because it mattered.\n"
            f"Title: {item.title}\n"
            f"Content: {item.content or 'No written note.'}\n"
            f"Tags: {tags}\n"
            "If it fits naturally, you may bring it up like: "
            "\"我翻到这个了，还记得吗？\" "
            "Do not recite it like a database and do not invent exact dates."
            f"{media_hint}"
        )

    def _pick_recall_item(self) -> Keepsake | None:
        candidates = sorted(
            self._items,
            key=lambda item: (item.last_recalled_at is not None, -item.importance),
        )
        if not candidates:
            return None
        top = candidates[: min(8, len(candidates))]
        return random.choice(top)

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            raw_items = data.get("items", []) if isinstance(data, dict) else data
            if isinstance(raw_items, list):
                self._items = [
                    Keepsake.from_dict(item)
                    for item in raw_items
                    if isinstance(item, dict)
                ]
        except Exception:
            logger.exception("Failed to load keepsakes")
            self._items = []

    def _save(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"items": [item.to_dict() for item in self._items]}, f, indent=2, ensure_ascii=False)


def _sanitize_kind(value: Any) -> str:
    kind = str(value or "text").strip()
    return kind if kind in KEEPSAKE_KINDS else "text"


def _default_title(kind: str) -> str:
    return {
        "photo": "收藏的照片",
        "sticker": "收藏的表情",
        "chat_screenshot": "聊天截图",
        "special_memory": "特殊回忆",
        "text": "一段回忆",
    }.get(kind, "一段回忆")


def _safe_text(value: Any, limit: int) -> str:
    text = str(value or "").replace("\x00", "").strip()
    return text[:limit]


def _safe_media_data_url(value: Any) -> str:
    text = _safe_text(value, MAX_MEDIA_DATA_URL_LENGTH)
    if not text:
        return ""
    if not text.startswith("data:image/"):
        return ""
    return text


def _safe_tags(value: list[str] | str) -> list[str]:
    if isinstance(value, str):
        raw = value.replace("，", "、").replace(",", "、").split("、")
    elif isinstance(value, list):
        raw = value
    else:
        raw = []
    seen: set[str] = set()
    tags: list[str] = []
    for item in raw:
        tag = _safe_text(item, 24)
        if tag and tag not in seen:
            tags.append(tag)
            seen.add(tag)
        if len(tags) >= 12:
            break
    return tags


def _clamp_float(value: Any, minimum: float, maximum: float) -> float:
    try:
        numeric = float(value)
    except Exception:
        numeric = minimum
    return min(maximum, max(minimum, numeric))
