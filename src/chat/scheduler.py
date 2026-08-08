"""MessageScheduler — controls reply timing and message splitting.

Manages:
  - Reply delay (based on message length, current state, time of day)
  - Typing indicator duration
  - Message splitting (one reply → multiple chat bubbles)
  - Online status (online, busy, away, sleeping)
"""

from __future__ import annotations

import logging
import random
import re
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    pass

logger = logging.getLogger("reverie.chat.scheduler")

Status = Literal["online", "busy", "away", "sleeping"]

STATUS_LABELS: dict[Status, str] = {
    "online": "在线",
    "busy": "忙碌",
    "away": "外出",
    "sleeping": "睡觉",
}

RETRACT_PROBABILITY = 0.001


@dataclass(frozen=True)
class ReplyStartPlan:
    """Decision made before reply generation starts.

    ``start_delay`` models whether the character can pick up the conversation
    now. The message is never silently discarded: a failed immediate-reply
    roll becomes a deferred reply instead.
    """

    start_delay: float
    immediate_probability: float
    status: Status
    reason: str


@dataclass
class MessageScheduler:
    """Calculates reply delays, splits, and typing indicators."""

    reply_delay_min: float = 3.0   # seconds
    reply_delay_max: float = 30.0  # seconds (ordinary messages cap here)
    split_messages: bool = True
    typing_indicator: bool = True
    status: Status = "online"
    allow_environment_description: bool = False
    length_stats: dict[str, int] = field(default_factory=lambda: {
        "short": 0,
        "medium": 0,
        "long": 0,
        "total": 0,
    })
    _temporary_status: Status | None = field(default=None, init=False, repr=False)
    _temporary_until: datetime | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        self.reply_delay_min = _clamp(self.reply_delay_min, 1.0, 60.0)
        self.reply_delay_max = _clamp(self.reply_delay_max, 1.0, 60.0)
        if self.reply_delay_min > self.reply_delay_max:
            self.reply_delay_min, self.reply_delay_max = self.reply_delay_max, self.reply_delay_min

    # ── Delay calculation ────────────────────────────────

    def plan_reply_start(
        self,
        user_message: str,
        *,
        emotions: dict[str, float] | None = None,
        now: datetime | None = None,
    ) -> ReplyStartPlan:
        """Decide when generation may start for the current presence state.

        Busy/away/sleeping affect the probability of replying in the current
        moment. A negative roll defers the reply instead of dropping it, which
        keeps user messages recoverable and avoids pretending they were seen.
        """
        now = now or datetime.now()
        status = self.current_status(now)
        probability = self.immediate_reply_probability(emotions=emotions)
        if random.random() <= probability:
            if status == "sleeping":
                delay = random.uniform(10 * 60, 20 * 60)
                return ReplyStartPlan(delay, probability, status, "sleepy_reply")
            return ReplyStartPlan(0.0, probability, status, "available_now")

        complexity = self.message_complexity(user_message)
        if status == "busy":
            delay = random.uniform(2 * 60, 8 * 60) * (1.0 + complexity * 0.35)
            reason = "busy_deferred"
        elif status == "away":
            delay = random.uniform(10 * 60, 45 * 60) * (1.0 + complexity * 0.25)
            reason = "away_deferred"
        elif status == "sleeping":
            wake_at = _next_wake_at(now, time(hour=9, minute=0))
            delay = max(10 * 60, (wake_at - now).total_seconds() + random.uniform(0, 45 * 60))
            reason = "sleep_until_wake"
        else:
            delay = random.uniform(8.0, 35.0) * (1.0 + complexity * 0.25)
            reason = "online_wobble"
        return ReplyStartPlan(round(delay, 1), probability, status, reason)

    def immediate_reply_probability(
        self,
        *,
        emotions: dict[str, float] | None = None,
    ) -> float:
        """Probability of starting a reply in the current moment."""
        status = self.current_status()
        base = {
            "online": 0.96,
            "busy": 0.68,
            "away": 0.42,
            "sleeping": 0.18,
        }.get(status, 0.96)
        emotions = emotions or {}
        urgency = max(
            float(emotions.get("excitement", 0.0)),
            float(emotions.get("anger", 0.0)),
            float(emotions.get("anxiety", 0.0)),
            float(emotions.get("touched", 0.0)),
        ) / 100.0
        sadness = float(emotions.get("sadness", 0.0)) / 100.0
        return _clamp(base + urgency * 0.10 - sadness * 0.06, 0.05, 1.0)

    def message_complexity(self, user_message: str) -> float:
        """Estimate response effort from length and reasoning markers (0-1)."""
        text = user_message.strip()
        if not text:
            return 0.0
        meaningful = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
        unique_ratio = len(set(meaningful)) / max(1, len(meaningful))
        repetition_penalty = 0.15 if len(meaningful) >= 40 and unique_ratio < 0.10 else 1.0
        length_score = min(len(text) / 240.0, 1.0) * repetition_penalty
        question_score = min(len(re.findall(r"[?？]", text)) * 0.16, 0.32)
        reasoning_markers = (
            "为什么", "怎么", "如何", "分析", "比较", "解释", "计划", "建议",
            "because", "why", "how", "compare", "explain", "plan",
        )
        marker_score = min(sum(marker in text.lower() for marker in reasoning_markers) * 0.10, 0.30)
        clause_score = min(len(re.findall(r"[，,；;：:\n]", text)) * 0.04, 0.18)
        return round(_clamp(length_score + question_score + marker_score + clause_score, 0.0, 1.0), 3)

    def allows_long_reply(self, user_message: str) -> bool:
        """Reserve replies over 80 characters for complex or important talk."""
        text = user_message.strip()
        important_markers = (
            "难过", "崩溃", "害怕", "焦虑", "生气", "吵架", "哭", "失眠",
            "生日", "纪念日", "项目", "提交", "考试", "生病", "疼", "医院",
            "重要", "认真", "求助", "怎么办", "救命", "对不起", "分手",
            "抑郁", "压力", "撑不住", "陪陪我", "长期计划", "重大决定",
        )
        if any(marker in text for marker in important_markers):
            return True
        meaningful = re.sub(r"[\s\W_]+", "", text, flags=re.UNICODE)
        if len(meaningful) < 28 or len(set(meaningful)) < 10:
            return False
        return self.message_complexity(text) >= 0.48

    def calculate_delay(
        self,
        reply_length: int,
        emotion_intensity: float = 0.0,
        *,
        user_message: str = "",
        emotions: dict[str, float] | None = None,
        status_delay_applied: bool = False,
    ) -> float:
        """Calculate how long to wait before showing the reply.

        Longer replies → longer delay (simulating reading + thinking + typing).
        Higher emotion → slightly faster reply (more engaged).
        """
        self.__post_init__()

        # Base: random within configurable range.
        base = random.triangular(
            self.reply_delay_min,
            self.reply_delay_max,
            min(self.reply_delay_max, self.reply_delay_min + (self.reply_delay_max - self.reply_delay_min) * 0.35),
        )

        # Longer messages take more time to type
        # ~60 WPM → ~1 word/sec, plus reading time
        word_count = max(reply_length / 5, 1)  # rough word estimate
        typing_delay = word_count * 0.8  # seconds per word

        complexity = self.message_complexity(user_message)

        # High arousal can speed up a reply, while sadness/anxiety can slow the
        # composition down. Mixed emotions remain independent inputs.
        emotions = emotions or {}
        fast_arousal = max(
            float(emotions.get("excitement", 0.0)),
            float(emotions.get("anger", 0.0)),
            float(emotions.get("touched", 0.0)),
        ) / 100.0
        slow_affect = max(
            float(emotions.get("sadness", 0.0)),
            float(emotions.get("anxiety", 0.0)),
            float(emotions.get("grievance", 0.0)),
        ) / 100.0
        emotion_modifier = 1.0 - (emotion_intensity * 0.18) - fast_arousal * 0.12 + slow_affect * 0.22

        delay = (base + typing_delay + complexity * 8.0) * emotion_modifier

        # Ordinary exchanges cap their thinking/reading base at the configured
        # ceiling (default 30s), while long replies keep their natural typing
        # time so a 500-character answer still feels human (up to 60s).
        long_message = max(len(user_message or ""), reply_length) > 200
        if long_message:
            delay = max(delay, float(self.reply_delay_max))
        else:
            base_share = min(base, float(self.reply_delay_max))
            delay = min(delay, base_share + typing_delay + complexity * 8.0)

        # Status modifiers. Non-rest status is capped by the user-facing 1-60s threshold.
        status = self.current_status()
        if status == "sleeping" and not status_delay_applied:
            return round(self._sleeping_delay_seconds(), 1)
        elif status == "away" and not status_delay_applied:
            delay = min(delay * 3, 60.0)
        elif status == "busy" and not status_delay_applied:
            delay = min(delay * 1.8, 60.0)

        # Small random wobble: real people do not reply on a metronome.
        delay *= random.uniform(0.75, 1.35)
        return round(_clamp(delay, 1.0, 60.0), 1)

    def status_payload(self) -> dict:
        """Return frontend-safe presence information."""
        status = self.current_status()
        return {
            "status": status,
            "label": STATUS_LABELS.get(status, "在线"),
            "is_available": self.is_available(),
            "immediate_reply_probability": self.immediate_reply_probability(),
        }

    def should_retract_message(
        self,
        *,
        had_typo: bool = False,
        emotions: dict[str, float] | None = None,
        bubble_count: int = 1,
    ) -> bool:
        """Allow rare accidental retractions and contextual typo corrections."""
        probability = RETRACT_PROBABILITY
        emotions = emotions or {}
        if had_typo:
            probability = max(probability, 0.18)
        anxiety = max(
            float(emotions.get("anxiety", 0.0)),
            float(emotions.get("grievance", 0.0)),
        )
        if anxiety >= 70:
            probability += 0.04
        if float(emotions.get("anger", 0.0)) >= 80:
            probability += 0.02
        if bubble_count > 1:
            probability += 0.002
        return random.random() < min(probability, 0.30)

    def _sleeping_delay_seconds(self, now: datetime | None = None) -> float:
        """During sleep, either reply sleepily after 10-20m or wait until wake."""
        now = now or datetime.now()
        if random.random() < 0.25:
            return random.uniform(10 * 60, 20 * 60)
        wake_at = _next_wake_at(now, time(hour=9, minute=0))
        return max(10 * 60, (wake_at - now).total_seconds() + random.uniform(0, 45 * 60))

    # ── Message splitting ─────────────────────────────────

    def shape_reply_length(
        self,
        message: str,
        *,
        allow_long: bool = False,
        allow_environment_description: bool | None = None,
    ) -> str:
        """Apply the target human-like reply length distribution.

        Target from the design doc:
        - 70% short replies: 1-20 chars/words-ish
        - 25% medium replies: 21-80
        - 5% long replies: 80+

        The 5% long bucket is reserved for serious contexts. In casual chat,
        even that bucket is capped at 80 characters to avoid essay-like output.
        """
        text = message.strip()
        if text.startswith("(API error:"):
            self._record_length_bucket(text)
            return text

        allow_env = (
            self.allow_environment_description
            if allow_environment_description is None
            else allow_environment_description
        )
        if not allow_env:
            text = self._strip_environment_descriptions(text)
        text = self._normalize_chat_punctuation(text)
        if not text:
            text = random.choice(["嗯嗯？", "唔，怎么啦？", "我在"])

        if len(text) <= 20:
            self._record_length_bucket(text)
            return text

        # Important/serious exchanges (birthdays, reminders, distress) always
        # keep their full length; the casual 70/25/5 distribution must not
        # truncate them.
        if allow_long:
            self._record_length_bucket(text)
            return text

        roll = random.random()
        if roll < 0.70:
            limit = 20
        elif roll < 0.95:
            limit = 80
        else:
            # Long bucket (5%): reserved for serious contexts. When the caller
            # did not mark the exchange important, the long reply is trimmed to
            # 80 chars but still counted as a long-bucket message.
            self.length_stats["long"] += 1
            self.length_stats["total"] += 1
            if not allow_long and len(text) > 80:
                return self._trim_at_natural_break(text, 80)
            return text

        if len(text) <= limit:
            self._record_length_bucket(text)
            return text

        shaped = self._trim_at_natural_break(text, limit)
        self._record_length_bucket(shaped)
        return shaped

    def get_length_stats(self) -> dict[str, int | float]:
        """Return reply length distribution stats for settings/debug UI."""
        total = self.length_stats.get("total", 0)
        if total <= 0:
            return {**self.length_stats, "short_ratio": 0.0, "medium_ratio": 0.0, "long_ratio": 0.0}
        return {
            **self.length_stats,
            "short_ratio": round(self.length_stats["short"] / total, 2),
            "medium_ratio": round(self.length_stats["medium"] / total, 2),
            "long_ratio": round(self.length_stats["long"] / total, 2),
        }

    def _record_length_bucket(self, text: str) -> None:
        length = len(text)
        if length <= 20:
            bucket = "short"
        elif length <= 80:
            bucket = "medium"
        else:
            bucket = "long"
        self.length_stats[bucket] += 1
        self.length_stats["total"] += 1

    def _trim_at_natural_break(self, text: str, limit: int) -> str:
        """Trim near a punctuation boundary without adding formal endings."""
        if len(text) <= limit:
            return text
        window = text[:limit]
        break_chars = ["，", ",", "！", "!", "？", "?", "\n", " "]
        last_break = max(window.rfind(ch) for ch in break_chars)
        if last_break >= max(6, int(limit * 0.45)):
            return self._normalize_chat_punctuation(window[:last_break].strip())
        return self._normalize_chat_punctuation(window.strip())

    def _strip_environment_descriptions(self, text: str) -> str:
        """Remove stage-direction style environment/action narration."""
        keywords = (
            "房间", "窗", "灯", "床", "桌", "周围", "环境", "身边", "背景",
            "抬头", "低头", "走到", "坐在", "靠在", "看向", "笑着", "叹气",
            "揉", "抱", "伸手", "空气", "夜色", "月光", "键盘", "屏幕",
        )
        patterns = [
            r"\([^()]{0,60}\)",
            r"（[^（）]{0,60}）",
            r"\*[^*]{0,80}\*",
            r"【[^】]{0,80}】",
            r"\[[^\]]{0,80}\]",
        ]
        cleaned = text
        for pattern in patterns:
            def repl(match: re.Match[str]) -> str:
                segment = match.group(0)
                return "" if any(keyword in segment for keyword in keywords) else segment

            cleaned = re.sub(pattern, repl, cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned.strip()

    def _normalize_chat_punctuation(self, text: str) -> str:
        """Keep replies closer to chat style: no formal full stops."""
        text = text.replace("。", "，")
        text = re.sub(r"(?<!\d)\.(?!\d)", "，", text)
        text = re.sub(r"[，,、；;：:\s]+$", "", text.strip())
        return text.strip()

    def should_split(self, message: str) -> bool:
        """Return True if this message should be split into multiple bubbles."""
        if not self.split_messages:
            return False
        text = message.strip()
        if len(text) > 80:
            return True
        if "\n" in text:
            return True
        break_count = len(re.findall(r"[，,！!？?\n]", text))
        return len(text) > 34 and break_count >= 2

    def split_message(self, message: str) -> list[str]:
        """Split a long message into multiple natural chunks.

        Splits at Chinese/Western chat punctuation while keeping chunks compact.
        """
        if not self.should_split(message):
            return [message]

        sentences = [part.strip() for part in re.split(r"(?<=[，,！!？?\n])\s*", message) if part.strip()]
        chunks: list[str] = []
        current = ""

        for sentence in sentences:
            candidate = f"{current}{sentence}" if current else sentence
            if current and len(candidate) > 42:
                if current:
                    chunks.append(self._normalize_chat_punctuation(current.strip()))
                current = sentence
            else:
                current = candidate

        if current:
            chunks.append(self._normalize_chat_punctuation(current.strip()))

        hard_chunks: list[str] = []
        for chunk in chunks:
            if len(chunk) <= 48:
                hard_chunks.append(chunk)
                continue
            for start in range(0, len(chunk), 42):
                hard_chunks.append(self._normalize_chat_punctuation(chunk[start:start + 42]))

        return [chunk for chunk in hard_chunks if chunk] or [self._normalize_chat_punctuation(message)]

    # ── Typing indicator ──────────────────────────────────

    def typing_duration(self, reply_length: int) -> float:
        """How long "typing..." should be shown before the message appears."""
        if not self.typing_indicator:
            return 0.0
        word_count = max(reply_length / 5, 1)
        # Simulate typing speed: ~3 words per second for display
        return round(_clamp(word_count * 0.3, 0.6, 8.0), 1)  # Cap at 8 seconds

    def inter_bubble_delay(self, bubble_length: int) -> float:
        """Pause between split chat bubbles while keeping typing visible."""
        return round(_clamp(0.35 + max(1, bubble_length) * 0.035, 0.45, 2.4), 2)

    # ── Status management ─────────────────────────────────

    def set_status(self, status: Status) -> None:
        self.status = status
        logger.debug("Status changed to %s", status)

    def set_temporary_status(self, status: Status, duration_seconds: float) -> None:
        """Apply an expiring runtime status without overwriting user settings."""
        self._temporary_status = status
        self._temporary_until = datetime.now() + timedelta(seconds=max(1.0, duration_seconds))
        logger.debug("Temporary status changed to %s until %s", status, self._temporary_until)

    def current_status(self, now: datetime | None = None) -> Status:
        now = now or datetime.now()
        if self._temporary_status and self._temporary_until and now < self._temporary_until:
            return self._temporary_status
        self._temporary_status = None
        self._temporary_until = None
        return self.status

    def is_available(self) -> bool:
        return self.current_status() != "sleeping"


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, float(value)))


def _next_wake_at(now: datetime, wake_time: time) -> datetime:
    wake_at = now.replace(
        hour=wake_time.hour,
        minute=wake_time.minute,
        second=0,
        microsecond=0,
    )
    if wake_at <= now:
        wake_at += timedelta(days=1)
    return wake_at
