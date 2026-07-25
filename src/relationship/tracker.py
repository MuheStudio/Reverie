"""RelationshipTracker — intimacy evolution system.

Intimacy grows through interaction, decays through neglect.
Four stages with distinct behavioral implications:
  0-99:      初识期（礼貌、克制、不越界）
  100-499:   熟悉期（记住习惯、取外号、主动聊天）
  500-1999:  依赖期（委屈、抱怨、分享秘密）
  2000+:     特殊关系期（专属称呼、生日仪式、特殊回忆）

The stage table is the single source of truth for backend prompts,
WebSocket payloads, and frontend display.
"""

from __future__ import annotations

import json
import hashlib
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger("reverie.relationship")


@dataclass(frozen=True)
class RelationshipStage:
    """A relationship growth stage and its prompt/display rules."""

    key: str
    label: str
    min_intimacy: int
    max_intimacy: int | None
    behavior: str
    address_style: str
    chat_style: str
    proactive_multiplier: float
    prompt_rules: tuple[str, ...]

    def contains(self, intimacy: int) -> bool:
        if intimacy < self.min_intimacy:
            return False
        return self.max_intimacy is None or intimacy <= self.max_intimacy

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "min_intimacy": self.min_intimacy,
            "max_intimacy": self.max_intimacy,
            "behavior": self.behavior,
            "address_style": self.address_style,
            "chat_style": self.chat_style,
            "proactive_multiplier": self.proactive_multiplier,
            "prompt_rules": list(self.prompt_rules),
        }


RELATIONSHIP_STAGES: tuple[RelationshipStage, ...] = (
    RelationshipStage(
        key="initial",
        label="初识期",
        min_intimacy=0,
        max_intimacy=99,
        behavior="礼貌、客气、保持边界，不会突然撒娇或吃醋",
        address_style="使用用户名字或“你”，不使用宝贝、亲爱的等亲密称呼",
        chat_style="温和克制、礼貌好奇，避免依赖、占有欲和过度袒露",
        proactive_multiplier=0.55,
        prompt_rules=(
            "Keep warmth restrained; do not act like a long-time lover or best friend.",
            "Do not use possessive jealousy, private rituals, or exclusive nicknames yet.",
            "Let care show through small politeness, curiosity, and careful listening.",
        ),
    ),
    RelationshipStage(
        key="familiar",
        label="熟悉期",
        min_intimacy=100,
        max_intimacy=499,
        behavior="记住习惯、偶尔取外号、可以主动聊天",
        address_style="可偶尔使用基于真实互动形成的轻昵称，平时仍以名字或“你”为主",
        chat_style="自然熟络，可开小玩笑并回忆共同话题，但不越过亲密边界",
        proactive_multiplier=1.0,
        prompt_rules=(
            "You may mention the user's habits naturally and try light nicknames.",
            "You can initiate conversation, but do not demand constant attention.",
            "Show familiarity through small callbacks, not database-like exactness.",
        ),
    ),
    RelationshipStage(
        key="dependent",
        label="依赖期",
        min_intimacy=500,
        max_intimacy=1999,
        behavior="会委屈、会抱怨、会分享秘密，也更怕被冷落",
        address_style="可稳定使用双方已经形成的昵称，语气更亲近",
        chat_style="更坦率、更有依赖感，可适度撒娇或委屈，但不得情感操控",
        proactive_multiplier=1.35,
        prompt_rules=(
            "You can show vulnerability, mild sulking, and honest dependency.",
            "You may share secrets or private feelings when the moment fits.",
            "Jealousy and complaints should be human-scale and context-bound, never manipulative.",
        ),
    ),
    RelationshipStage(
        key="special",
        label="特殊关系期",
        min_intimacy=2000,
        max_intimacy=None,
        behavior="专属称呼、生日仪式、特殊回忆和长期共同感",
        address_style="可使用有共同历史依据的专属称呼，并保留名字作为自然变化",
        chat_style="深度亲密且有共同历史感，允许脆弱、仪式感和长期承诺式表达",
        proactive_multiplier=1.65,
        prompt_rules=(
            "Use exclusive nicknames, shared rituals, birthdays, and special memories when relevant.",
            "Treat the relationship as earned history, not instant maximum affection.",
            "Deep closeness is allowed, but keep it grounded in the role card and actual memories.",
        ),
    ),
)


class RelationshipTracker:
    """Tracks intimacy between the user and the character."""

    def __init__(self, initial_intimacy: int = 0, state_path: Path | None = None) -> None:
        self.state_path = state_path
        self.intimacy = max(0, initial_intimacy)
        self.interaction_count = 0
        self.positive_interactions = 0
        self.negative_interactions = 0
        self.last_interaction_at = ""
        self._recent_fingerprints: list[dict[str, str]] = []
        self._load_state()

    # ── Properties ────────────────────────────────────────

    @property
    def stage(self) -> str:
        return self.stage_info.label

    @property
    def stage_info(self) -> RelationshipStage:
        return stage_for_intimacy(self.intimacy)

    @property
    def stage_number(self) -> int:
        return RELATIONSHIP_STAGES.index(self.stage_info) + 1

    def snapshot(self) -> dict:
        """Return a frontend-safe relationship payload."""
        stage = self.stage_info
        return {
            "intimacy": self.intimacy,
            "stage": stage.label,
            "stage_key": stage.key,
            "stage_number": self.stage_number,
            "stage_detail": stage.behavior,
            "address_style": stage.address_style,
            "chat_style": stage.chat_style,
            "proactive_multiplier": stage.proactive_multiplier,
            "interaction_count": self.interaction_count,
            "positive_interactions": self.positive_interactions,
            "negative_interactions": self.negative_interactions,
            "thresholds": [
                {
                    "key": item.key,
                    "label": item.label,
                    "min": item.min_intimacy,
                    "max": item.max_intimacy,
                    "behavior": item.behavior,
                    "address_style": item.address_style,
                    "chat_style": item.chat_style,
                    "proactive_multiplier": item.proactive_multiplier,
                }
                for item in RELATIONSHIP_STAGES
            ],
        }

    def to_dict(self) -> dict:
        """Return a durable state snapshot for local backup/export."""
        return {
            "intimacy": self.intimacy,
            "stage_key": self.stage_info.key,
            "stage": self.stage_info.label,
            "interaction_count": self.interaction_count,
            "positive_interactions": self.positive_interactions,
            "negative_interactions": self.negative_interactions,
            "last_interaction_at": self.last_interaction_at,
            "recent_fingerprints": self._recent_fingerprints[-8:],
        }

    def restore(self, data: dict) -> None:
        """Restore relationship state from a durable snapshot."""
        try:
            self.intimacy = max(0, int(data.get("intimacy", self.intimacy)))
        except (TypeError, ValueError):
            self.intimacy = max(0, self.intimacy)
        self.interaction_count = _safe_non_negative_int(data.get("interaction_count"), self.interaction_count)
        self.positive_interactions = _safe_non_negative_int(
            data.get("positive_interactions"), self.positive_interactions
        )
        self.negative_interactions = _safe_non_negative_int(
            data.get("negative_interactions"), self.negative_interactions
        )
        if isinstance(data.get("last_interaction_at"), str):
            self.last_interaction_at = data["last_interaction_at"]
        fingerprints = data.get("recent_fingerprints")
        if isinstance(fingerprints, list):
            self._recent_fingerprints = [
                {"hash": str(item.get("hash", "")), "at": str(item.get("at", ""))}
                for item in fingerprints[-8:]
                if isinstance(item, dict) and item.get("hash")
            ]
        self._save_state()

    def prompt_context(self) -> str:
        """Relationship stage text for system prompts."""
        stage = self.stage_info
        rules = "\n".join(f"- {line}" for line in stage.prompt_rules)
        upper = "∞" if stage.max_intimacy is None else str(stage.max_intimacy)
        return (
            f"Current intimacy: {self.intimacy} ({stage.min_intimacy}-{upper})\n"
            f"Stage: {stage.label}\n"
            f"Stage behavior: {stage.behavior}\n"
            f"Address style: {stage.address_style}\n"
            f"Chat style: {stage.chat_style}\n"
            f"Proactive frequency multiplier: {stage.proactive_multiplier:.2f}\n"
            "This growth stage constrains how the role-card personality opens up.\n"
            f"{rules}"
        )

    # ── Intimacy changes ──────────────────────────────────

    def on_user_message(self, message: str | int) -> None:
        """Grow from meaningful interaction without assuming space-delimited text."""
        now = datetime.now()
        if isinstance(message, int):
            meaningful_length = max(0, message)
            fingerprint = ""
        else:
            normalized = re.sub(r"\s+", "", message.strip().lower())
            meaningful_length = len(re.findall(r"[a-z0-9\u4e00-\u9fff]", normalized))
            fingerprint = hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""
            if fingerprint and self._is_recent_duplicate(fingerprint, now):
                return
            if len(self._recent_fingerprints) >= 6:
                logger.debug("Relationship growth rate-limited within the 10-minute window")
                return

        if meaningful_length < 2:
            return
        if meaningful_length >= 120:
            delta = 5
        elif meaningful_length >= 40:
            delta = 3
        elif meaningful_length >= 12:
            delta = 2
        else:
            delta = 1

        self.interaction_count += 1
        self.last_interaction_at = now.isoformat()
        if fingerprint:
            self._recent_fingerprints.append({"hash": fingerprint, "at": now.isoformat()})
            self._recent_fingerprints = self._recent_fingerprints[-8:]
        self._adjust(delta)

    def on_positive_interaction(self) -> None:
        """When the conversation has positive emotional valence."""
        self.positive_interactions += 1
        self._adjust(3)

    def on_negative_interaction(self) -> None:
        """When the conversation has negative emotional valence."""
        self.negative_interactions += 1
        self._adjust(-2)

    def on_emotional_result(self, changes: dict[str, float]) -> None:
        """Update relationship from the emotional outcome of an interaction."""
        positive = sum(float(changes.get(name, 0.0)) for name in ("joy", "excitement", "touched"))
        negative = sum(float(changes.get(name, 0.0)) for name in ("anger", "grievance", "sadness"))
        if positive >= 5.0 and positive > negative:
            self.on_positive_interaction()
        elif negative >= 6.0 and negative > positive:
            self.on_negative_interaction()

    def on_user_ignores(self) -> None:
        """When the user ignores the character's proactive message."""
        self._adjust(-1)

    def on_special_event(self, importance: float = 1.0) -> None:
        """Birthday, anniversary, shared secret, etc."""
        self._adjust(int(10 * importance))

    def on_daily_decay(self) -> None:
        """Natural decay if no interaction. Called once per day."""
        if self.intimacy > 500:
            self._adjust(-1)  # Very slow decay for close bonds
        elif self.intimacy > 100:
            self._adjust(-2)

    def enforce_addressing(self, reply: str) -> str:
        """Remove forms of address that belong to a later growth stage."""
        blocked: tuple[str, ...]
        if self.stage_info.key == "initial":
            blocked = ("宝贝", "宝宝", "亲爱的", "老婆", "老公", "爱人", "小祖宗")
        elif self.stage_info.key == "familiar":
            blocked = ("老婆", "老公", "爱人", "小祖宗")
        else:
            blocked = ()
        result = reply
        for term in blocked:
            result = result.replace(term, "你")
        return result

    # ── Internal ─────────────────────────────────────────

    def _adjust(self, delta: int) -> None:
        self.intimacy = max(0, self.intimacy + delta)
        self._save_state()
        logger.debug("Intimacy %+d → %d (%s)", delta, self.intimacy, self.stage)

    def _load_state(self) -> None:
        if self.state_path is None or not self.state_path.exists():
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            self.intimacy = max(0, int(data.get("intimacy", self.intimacy)))
            self.interaction_count = _safe_non_negative_int(data.get("interaction_count"), 0)
            self.positive_interactions = _safe_non_negative_int(data.get("positive_interactions"), 0)
            self.negative_interactions = _safe_non_negative_int(data.get("negative_interactions"), 0)
            self.last_interaction_at = str(data.get("last_interaction_at", ""))
            fingerprints = data.get("recent_fingerprints", [])
            if isinstance(fingerprints, list):
                self._recent_fingerprints = [
                    {"hash": str(item.get("hash", "")), "at": str(item.get("at", ""))}
                    for item in fingerprints[-8:]
                    if isinstance(item, dict) and item.get("hash")
                ]
        except Exception:
            logger.exception("Failed to load relationship state from %s", self.state_path)

    def _is_recent_duplicate(self, fingerprint: str, now: datetime) -> bool:
        cutoff = now - timedelta(minutes=10)
        retained: list[dict[str, str]] = []
        duplicate = False
        for item in self._recent_fingerprints:
            try:
                at = datetime.fromisoformat(item.get("at", ""))
            except ValueError:
                continue
            if at >= cutoff:
                retained.append(item)
                duplicate = duplicate or item.get("hash") == fingerprint
        self._recent_fingerprints = retained[-8:]
        return duplicate

    def _save_state(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(
                json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.exception("Failed to save relationship state to %s", self.state_path)


def _intimacy_stage(intimacy: int) -> str:
    return stage_for_intimacy(intimacy).label


def stage_for_intimacy(intimacy: int) -> RelationshipStage:
    normalized = max(0, int(intimacy))
    for stage in RELATIONSHIP_STAGES:
        if stage.contains(normalized):
            return stage
    return RELATIONSHIP_STAGES[-1]


def build_relationship_prompt_context(intimacy: int) -> str:
    """Build prompt guidance without requiring a RelationshipTracker instance."""
    tracker = RelationshipTracker(initial_intimacy=intimacy)
    return tracker.prompt_context()


def _safe_non_negative_int(value: object, fallback: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return max(0, int(fallback))
