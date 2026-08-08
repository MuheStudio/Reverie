"""User profile system — persistent user information storage.

Per requirements #9-10:
  - Records user identity, interests, important dates, goals, habits
  - Feeds into sticker preference analysis (#65-66)
  - Persisted as JSON: data/user/profile.json
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, TYPE_CHECKING

from ..config.settings import USER_DIR

if TYPE_CHECKING:
    pass

logger = logging.getLogger("reverie.user")


# ── Data structures ───────────────────────────────────────

@dataclass
class UserProfile:
    """Long-term user profile, persisted across sessions."""

    # Identity
    name: str = ""
    nickname: str = ""
    age: int | None = None
    birthday: str = ""                        # YYYY-MM-DD
    identity: str = ""
    schedule: str = ""

    # Interests & preferences
    interests: list[str] = field(default_factory=list)   # e.g. ["anime","gaming","cats"]
    hobbies: list[str] = field(default_factory=list)
    favorite_topics: list[str] = field(default_factory=list)
    favorite_games: list[str] = field(default_factory=list)
    favorite_anime: list[str] = field(default_factory=list)

    # Important dates
    important_dates: dict[str, str] = field(default_factory=dict)  # {"anniversary": "2025-03-15"}

    # Sticker preferences (for #65-66)
    sticker_preferences: dict[str, float] = field(default_factory=dict)
    # emotion → weight, e.g. {"joy": 1.2, "sadness": 0.8}

    # Goals & habits
    long_term_goals: list[str] = field(default_factory=list)
    habits: list[str] = field(default_factory=list)
    historical_events: list[str] = field(default_factory=list)

    # Metadata
    first_seen: str = ""
    last_seen: str = ""
    session_count: int = 0

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "nickname": self.nickname,
            "age": self.age,
            "birthday": self.birthday,
            "identity": self.identity,
            "schedule": self.schedule,
            "interests": self.interests,
            "hobbies": self.hobbies,
            "favorite_topics": self.favorite_topics,
            "favorite_games": self.favorite_games,
            "favorite_anime": self.favorite_anime,
            "important_dates": self.important_dates,
            "sticker_preferences": self.sticker_preferences,
            "long_term_goals": self.long_term_goals,
            "habits": self.habits,
            "historical_events": self.historical_events,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "session_count": self.session_count,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "UserProfile":
        def as_list(value: object) -> list[str]:
            if isinstance(value, list):
                return [str(item).strip() for item in value if str(item).strip()]
            if isinstance(value, str):
                return UserManager._split_list(value)
            return []

        def as_age(value: object) -> int | None:
            try:
                age = int(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return None
            return age if age > 0 else None

        def as_dict(value: object) -> dict:
            return value if isinstance(value, dict) else {}

        def as_int(value: object, fallback: int = 0) -> int:
            try:
                return int(value)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return fallback

        return cls(
            name=str(data.get("name", "") or ""),
            nickname=str(data.get("nickname", "") or ""),
            age=as_age(data.get("age")),
            birthday=str(data.get("birthday", "") or ""),
            identity=str(data.get("identity", "") or ""),
            schedule=str(data.get("schedule", "") or ""),
            interests=as_list(data.get("interests", [])),
            hobbies=as_list(data.get("hobbies", [])),
            favorite_topics=as_list(data.get("favorite_topics", [])),
            favorite_games=as_list(data.get("favorite_games", [])),
            favorite_anime=as_list(data.get("favorite_anime", [])),
            important_dates=as_dict(data.get("important_dates", {})),
            sticker_preferences=as_dict(data.get("sticker_preferences", {})),
            long_term_goals=as_list(data.get("long_term_goals", [])),
            habits=as_list(data.get("habits", [])),
            historical_events=as_list(data.get("historical_events", [])),
            first_seen=data.get("first_seen", ""),
            last_seen=data.get("last_seen", ""),
            session_count=as_int(data.get("session_count", 0), 0),
        )


@dataclass
class EmotionalMemory:
    """A relationship memory focused on feelings, not raw chat logs."""

    id: str
    date: str
    summary: str
    user_message: str
    assistant_reply: str
    emotion_changes: dict[str, float]
    dominant_emotions: list[str] = field(default_factory=list)
    importance: float = 0.7
    created_at: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "date": self.date,
            "summary": self.summary,
            "user_message": self.user_message,
            "assistant_reply": self.assistant_reply,
            "emotion_changes": self.emotion_changes,
            "dominant_emotions": self.dominant_emotions,
            "importance": self.importance,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "EmotionalMemory":
        return cls(
            id=data.get("id", ""),
            date=data.get("date", ""),
            summary=data.get("summary", ""),
            user_message=data.get("user_message", ""),
            assistant_reply=data.get("assistant_reply", ""),
            emotion_changes=data.get("emotion_changes", {}),
            dominant_emotions=data.get("dominant_emotions", []),
            importance=float(data.get("importance", 0.7)),
            created_at=data.get("created_at", ""),
        )


def default_user_profile() -> UserProfile:
    """Return the built-in user profile requested for first-run seeding."""
    return UserProfile(
        name="星野白夜",
        nickname="白夜",
        age=19,
        birthday="2026-03-03",
        identity="生物学家，医学家，化学家",
        schedule="09:00～23:00",
        interests=["二次元游戏", "动漫", "写小说"],
        hobbies=["写小说"],
        favorite_topics=["明日方舟", "蔚蓝档案", "终末地", "异环", "饥荒联机版", "梦想成为魔法少女", "慎重勇者"],
        favorite_games=["明日方舟", "蔚蓝档案", "终末地", "异环", "饥荒联机版"],
        favorite_anime=["梦想成为魔法少女", "慎重勇者"],
        important_dates={"生日": "2026-03-03"},
    )


# ── UserManager ───────────────────────────────────────────

class UserManager:
    """Manages the user profile — load, update, persist.

    Usage::

        user_mgr = UserManager()
        profile = user_mgr.profile
        user_mgr.add_interest("anime")
        user_mgr.record_sticker_use("joy", 0.1)
        user_mgr.save()
    """

    def __init__(
        self,
        data_dir: Path | None = None,
        *,
        document_store: Any | None = None,
    ) -> None:
        self.data_dir = data_dir or USER_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.document_store = document_store
        self.profile = UserProfile()
        self.emotional_memories: list[EmotionalMemory] = []
        self._load()
        self._load_emotional_memories()

    # ── Profile management ─────────────────────────────────

    def ensure_default_profile(self) -> None:
        """Fill empty first-run profile fields without overwriting user edits."""
        default = default_user_profile()
        changed = False
        for key, value in default.to_dict().items():
            if key in {"first_seen", "last_seen", "session_count", "sticker_preferences"}:
                continue
            current = getattr(self.profile, key, None)
            if current in ("", None, [], {}):
                setattr(self.profile, key, value)
                changed = True
        if changed:
            self.save()

    def update_profile(self, data: dict) -> UserProfile:
        """Update editable profile fields from a JSON payload."""
        list_fields = {
            "interests", "hobbies", "favorite_topics", "favorite_games",
            "favorite_anime", "long_term_goals", "habits", "historical_events",
        }
        scalar_fields = {"name", "nickname", "identity", "schedule"}
        for key in scalar_fields:
            if key in data:
                setattr(self.profile, key, str(data.get(key) or "").strip())
        if "birthday" in data:
            self.profile.birthday = self._normalize_date(str(data.get("birthday") or "").strip())
        if "age" in data:
            try:
                age = int(data["age"])
                self.profile.age = age if age > 0 else None
            except (TypeError, ValueError):
                self.profile.age = None
        for key in list_fields:
            if key in data:
                raw = data.get(key)
                if isinstance(raw, str):
                    items = self._split_list(raw)
                elif isinstance(raw, list):
                    items = [str(item).strip() for item in raw if str(item).strip()]
                else:
                    items = []
                setattr(self.profile, key, items)
        if isinstance(data.get("important_dates"), dict):
            self.profile.important_dates = {
                str(k).strip(): str(v).strip()
                for k, v in data["important_dates"].items()
                if str(k).strip() and str(v).strip()
            }
        self.save()
        return self.profile

    def extract_profile_updates(self, text: str) -> dict:
        """Extract explicit user facts from natural language."""
        updates: dict[str, object] = {}
        patterns = [
            ("name", r"(?:我叫|我的名字是)([^，。,\.！!？?\n]{1,24})"),
            ("nickname", r"我的昵称是([^，。,\.！!？?\n]{1,24})"),
            ("birthday", r"(?:我的生日是|生日是)(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})"),
            ("age", r"(?:我今年|我的年龄是|年龄是)(\d{1,3})岁?"),
            ("identity", r"(?:我的身份是|我是)([^。.!！?\n]{2,80}(?:学家|医生|作家|学生|工程师|研究员))"),
            ("schedule", r"(?:我的作息|作息时间)(?:是|为)?\s*([0-2]?\d[:：][0-5]\d\s*[～~-]\s*[0-2]?\d[:：][0-5]\d)"),
        ]
        for key, pattern in patterns:
            match = re.search(pattern, text)
            if match:
                value = match.group(1).strip()
                updates[key] = self._normalize_date(value) if key == "birthday" else value

        list_patterns = [
            ("favorite_games", r"喜欢的游戏(?:是|有|：|:)?([^。！？\n]+)"),
            ("favorite_anime", r"喜欢的动漫(?:是|有|：|:)?([^。！？\n]+)"),
            ("hobbies", r"喜欢做的事(?:是|有|：|:)?([^。！？\n]+)"),
        ]
        for key, pattern in list_patterns:
            match = re.search(pattern, text)
            if match:
                updates[key] = self._split_list(match.group(1))
        return updates

    def profile_facts(self) -> list[str]:
        """Return stable user facts for permanent memory seeding."""
        profile = self.profile
        facts: list[str] = []
        display_name = profile.nickname or profile.name
        if profile.name:
            facts.append(f"用户档案：用户的姓名是 {profile.name}。")
        if profile.nickname and profile.nickname != profile.name:
            facts.append(f"用户档案：用户的昵称是 {profile.nickname}。")
        if profile.age:
            facts.append(f"用户档案：{display_name or '用户'}今年 {profile.age} 岁。")
        if profile.birthday:
            facts.append(f"用户档案：{display_name or '用户'}的生日是 {profile.birthday}。")
        if profile.identity:
            facts.append(f"用户档案：{display_name or '用户'}的身份是 {profile.identity}。")
        if profile.schedule:
            facts.append(f"用户档案：{display_name or '用户'}的作息时间是 {profile.schedule}。")
        for label, values in [
            ("喜欢的游戏", profile.favorite_games),
            ("喜欢的动漫", profile.favorite_anime),
            ("喜欢做的事", profile.hobbies),
            ("兴趣", profile.interests),
        ]:
            if values:
                facts.append(f"用户档案：{display_name or '用户'}的{label}：{'、'.join(values)}。")
        return facts

    def build_prompt_context(self, max_emotional_memories: int = 6) -> str:
        """Build a compact prompt section for user facts and emotional memories."""
        profile_lines = self.profile_facts()
        memory_lines = [
            f"- {memory.summary}"
            for memory in self.get_recent_emotional_memories(max_emotional_memories)
            if memory.summary
        ]
        blocks: list[str] = []
        if profile_lines:
            blocks.append("用户档案分区（白夜的稳定信息）：\n" + "\n".join(f"- {line}" for line in profile_lines))
        if memory_lines:
            blocks.append("情感记忆分区（只保存关系中的心情，不等同聊天记录）：\n" + "\n".join(memory_lines))
        return "\n\n".join(blocks)

    def export_all(self) -> dict:
        """Export profile and separated emotional memories for local backup."""
        return {
            "profile": self.profile.to_dict(),
            "emotional_memories": [
                memory.to_dict()
                for memory in self.emotional_memories
            ],
        }

    def import_all(self, data: dict) -> None:
        """Restore profile and separated emotional memories from backup data."""
        if isinstance(data.get("profile"), dict):
            self.profile = UserProfile.from_dict(data["profile"])
        memories = data.get("emotional_memories", [])
        if isinstance(memories, list):
            self.emotional_memories = [
                EmotionalMemory.from_dict(item)
                for item in memories
                if isinstance(item, dict)
            ]
        self.save()
        self._save_emotional_memories()

    # ── Emotional memory ───────────────────────────────────

    def record_emotional_memory(
        self,
        *,
        user_message: str,
        assistant_reply: str,
        emotion_changes: dict[str, float],
        dominant_emotions: list[str],
        importance: float = 0.7,
    ) -> EmotionalMemory | None:
        """Persist a significant relationship memory focused on feeling."""
        if not self._should_record_emotional_memory(user_message, emotion_changes, importance):
            return None
        now = datetime.now()
        summary = self._summarize_emotional_memory(
            user_message=user_message,
            emotion_changes=emotion_changes,
            dominant_emotions=dominant_emotions,
        )
        memory = EmotionalMemory(
            id=f"emo_{now.strftime('%Y%m%d%H%M%S%f')}_{len(self.emotional_memories) + 1}",
            date=now.strftime("%Y-%m-%d"),
            summary=summary,
            user_message=user_message[:500],
            assistant_reply=assistant_reply[:500],
            emotion_changes=dict(emotion_changes),
            dominant_emotions=dominant_emotions[:4],
            importance=importance,
            created_at=now.isoformat(),
        )
        self.emotional_memories.append(memory)
        self._save_emotional_memories()
        return memory

    def get_recent_emotional_memories(self, limit: int = 6) -> list[EmotionalMemory]:
        return list(reversed(self.emotional_memories[-limit:]))

    # ── Interest management ───────────────────────────────

    def add_interest(self, interest: str) -> None:
        if interest not in self.profile.interests:
            self.profile.interests.append(interest)

    def add_hobby(self, hobby: str) -> None:
        if hobby not in self.profile.hobbies:
            self.profile.hobbies.append(hobby)

    def add_important_date(self, label: str, date_str: str) -> None:
        self.profile.important_dates[label] = date_str

    # ── Sticker preference tracking (#65-66) ──────────────

    def record_sticker_use(self, emotion: str, delta: float = 0.05) -> None:
        """Update sticker preference weight for a given emotion.

        Positive delta = user liked it (weight increases).
        Called when user reacts positively to a sticker.
        """
        current = self.profile.sticker_preferences.get(emotion, 1.0)
        self.profile.sticker_preferences[emotion] = max(0.1, min(3.0, current + delta))
        self.save()

    def get_sticker_weight(self, emotion: str) -> float:
        """Get the preference weight for an emotion. 1.0 = neutral."""
        return self.profile.sticker_preferences.get(emotion, 1.0)

    # ── Session tracking ──────────────────────────────────

    def on_session_start(self) -> None:
        now = datetime.now().isoformat()
        if not self.profile.first_seen:
            self.profile.first_seen = now
        self.profile.last_seen = now
        self.profile.session_count += 1

    # ── Persistence ───────────────────────────────────────

    def save(self) -> None:
        if self.document_store is not None:
            self.document_store.write_private_document(
                "user_profile",
                self.profile.to_dict(),
            )
            return
        filepath = self.data_dir / "profile.json"
        temp_path = filepath.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(self.profile.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        temp_path.replace(filepath)

    def _load(self) -> None:
        if self.document_store is not None:
            stored = self.document_store.read_private_document("user_profile")
            if stored is not None:
                self.profile = UserProfile.from_dict(stored)
                return
        filepath = self.data_dir / "profile.json"
        if not filepath.exists():
            return
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                self.profile = UserProfile.from_dict(json.load(f))
            if self.document_store is not None:
                self.save()
                if self.document_store.read_private_document("user_profile") != self.profile.to_dict():
                    raise RuntimeError("encrypted profile migration verification failed")
                filepath.unlink()
        except Exception:
            logger.exception("Failed to load user profile")

    def _load_emotional_memories(self) -> None:
        if self.document_store is not None:
            stored = self.document_store.read_private_document("user_emotional_memories")
            if stored is not None:
                items = stored.get("memories", [])
                self.emotional_memories = [
                    EmotionalMemory.from_dict(item)
                    for item in items
                    if isinstance(item, dict)
                ]
                return
        filepath = self.data_dir / "emotional_memories.json"
        if not filepath.exists():
            return
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            items = data.get("memories", data if isinstance(data, list) else [])
            self.emotional_memories = [
                EmotionalMemory.from_dict(item)
                for item in items
                if isinstance(item, dict)
            ]
            if self.document_store is not None:
                self._save_emotional_memories()
                verified = self.document_store.read_private_document(
                    "user_emotional_memories",
                )
                if verified != {
                    "memories": [memory.to_dict() for memory in self.emotional_memories],
                }:
                    raise RuntimeError("encrypted emotional-memory migration verification failed")
                filepath.unlink()
        except Exception:
            logger.exception("Failed to load emotional memories")

    def _save_emotional_memories(self) -> None:
        if self.document_store is not None:
            self.document_store.write_private_document(
                "user_emotional_memories",
                {"memories": [memory.to_dict() for memory in self.emotional_memories]},
            )
            return
        filepath = self.data_dir / "emotional_memories.json"
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(
                {"memories": [memory.to_dict() for memory in self.emotional_memories]},
                f,
                indent=2,
                ensure_ascii=False,
            )

    def _should_record_emotional_memory(
        self,
        user_message: str,
        emotion_changes: dict[str, float],
        importance: float,
    ) -> bool:
        if importance >= 0.65:
            return True
        total_delta = sum(abs(float(value)) for value in emotion_changes.values())
        if total_delta >= 8:
            return True
        important_words = [
            "生日", "喜欢", "讨厌", "爱", "孤独", "难过", "哭", "生气",
            "吃醋", "陪伴", "不要离开", "想你", "记住", "约定",
            "lonely", "sad", "angry", "love", "miss you", "remember",
        ]
        text = user_message.lower()
        return any(word in text or word.lower() in text for word in important_words)

    def _summarize_emotional_memory(
        self,
        *,
        user_message: str,
        emotion_changes: dict[str, float],
        dominant_emotions: list[str],
    ) -> str:
        name = self.profile.nickname or self.profile.name or "用户"
        strongest = ", ".join(dominant_emotions[:3]) if dominant_emotions else "复杂情绪"
        changed = ", ".join(
            f"{key}{value:+.0f}"
            for key, value in sorted(
                emotion_changes.items(),
                key=lambda item: abs(float(item[1])),
                reverse=True,
            )[:4]
        )
        snippet = user_message.strip().replace("\n", " ")[:120]
        if changed:
            return f"{name}说“{snippet}”，这让她记住了当时的心情：{strongest}（变化：{changed}）。"
        return f"{name}说“{snippet}”，这件事被她当作一段重要的关系记忆保存下来。"

    @staticmethod
    def _split_list(value: str) -> list[str]:
        return [
            re.sub(r"^(?:等|以及|和)\s*", "", item.strip()).strip()
            for item in re.split(r"[、,，/；;\s]+", value)
            if item.strip() and item.strip() not in {"等", "以及", "和"}
        ]

    @staticmethod
    def _normalize_date(value: str) -> str:
        match = re.fullmatch(r"(\d{4})年(\d{1,2})月(\d{1,2})日", value)
        if match:
            year, month, day = (int(part) for part in match.groups())
            return f"{year:04d}-{month:02d}-{day:02d}"
        match = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", value)
        if match:
            year, month, day = (int(part) for part in match.groups())
            return f"{year:04d}-{month:02d}-{day:02d}"
        return value
