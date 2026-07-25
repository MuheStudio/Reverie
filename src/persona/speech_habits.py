"""Persistent speech-habit enforcement for generated chat messages."""

from __future__ import annotations

import json
import logging
import random
import re
from pathlib import Path
from typing import TYPE_CHECKING

from ..config.settings import PERSONA_DIR

if TYPE_CHECKING:
    from ..config.settings import FeatureSettings
    from ..relationship.tracker import RelationshipTracker
    from .alignment import UserPhraseAlignment
    from .persona_card import Persona

logger = logging.getLogger("reverie.persona.speech_habits")


class SpeechHabitEngine:
    """Keep catchphrases present over time without forcing every reply."""

    MAX_REPLIES_WITHOUT_CATCHPHRASE = 8

    def __init__(
        self,
        persona: "Persona",
        data_dir: Path | None = None,
        *,
        alignment_engine: "UserPhraseAlignment | None" = None,
        feature_settings: "FeatureSettings | None" = None,
        relationship: "RelationshipTracker | None" = None,
    ) -> None:
        self.persona = persona
        self.data_dir = data_dir or PERSONA_DIR
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "speech_habits.json"
        self.reply_count = 0
        self.since_catchphrase = 0
        self.usage: dict[str, int] = {}
        self.alignment_engine = alignment_engine
        self.feature_settings = feature_settings
        self.relationship = relationship
        self._load()

    def apply(
        self,
        text: str,
        *,
        emotions: dict[str, float] | None = None,
        allow_long: bool = False,
    ) -> str:
        """Apply emotional punctuation and occasionally enforce a catchphrase."""
        if not text or text.startswith("(API error:"):
            return text

        emotions = emotions or {}
        result = self._apply_emotional_punctuation(text, emotions)
        catchphrases = [item.strip() for item in self.persona.catchphrases if item.strip()]
        existing = next((item for item in catchphrases if item in result), None)

        self.reply_count += 1
        if existing:
            self.since_catchphrase = 0
            self.usage[existing] = self.usage.get(existing, 0) + 1
        else:
            self.since_catchphrase += 1
            arousal = max(
                float(emotions.get("joy", 0.0)),
                float(emotions.get("excitement", 0.0)),
                float(emotions.get("anxiety", 0.0)),
                float(emotions.get("touched", 0.0)),
            ) / 100.0
            probability = min(0.28, 0.06 + arousal * 0.12)
            due = self.since_catchphrase >= self.MAX_REPLIES_WITHOUT_CATCHPHRASE
            # Do not turn a naturally tiny chat bubble into a catchphrase
            # sandwich. A due phrase stays due until the next fuller reply.
            if catchphrases and len(result) > 20 and (due or random.random() < probability):
                least_used = min(self.usage.get(item, 0) for item in catchphrases)
                pool = [item for item in catchphrases if self.usage.get(item, 0) == least_used]
                chosen = random.choice(pool)
                result = self._prepend_with_limit(chosen, result, allow_long=allow_long)
                self.since_catchphrase = 0
                self.usage[chosen] = self.usage.get(chosen, 0) + 1

        if (
            self.alignment_engine is not None
            and self.feature_settings is not None
            and self.feature_settings.user_phrase_alignment_enabled
        ):
            try:
                result = self.alignment_engine.maybe_apply(
                    result,
                    intimacy=int(getattr(self.relationship, "intimacy", 0) or 0),
                    probability=self.feature_settings.user_phrase_alignment_probability,
                    minimum_count=self.feature_settings.user_phrase_min_count,
                )
            except Exception:
                logger.exception("Bidirectional phrase alignment failed")

        self._save()
        return result

    def _apply_emotional_punctuation(
        self,
        text: str,
        emotions: dict[str, float],
    ) -> str:
        result = text.strip().replace("。", "，")
        dominant = max(emotions, key=emotions.get, default="calm")
        intensity = float(emotions.get(dominant, 0.0))

        if dominant == "calm":
            result = re.sub(r"!{2,}", "!", result)
            result = re.sub(r"！{2,}", "！", result)
            result = re.sub(r"[，,]+$", "", result)
            return result

        if dominant in {"excitement", "joy", "touched"} and intensity >= 60:
            probability = min(0.9, 0.25 + intensity / 130.0)
            if not re.search(r"[!！?？…]$", result) and random.random() < probability:
                result += "！"
        elif dominant in {"sadness", "anxiety", "grievance"} and intensity >= 55:
            probability = min(0.85, 0.20 + intensity / 140.0)
            if random.random() < probability:
                result = re.sub(r"[，,]+$", "", result) + "……"
        elif dominant == "anger" and intensity >= 60:
            probability = min(0.9, 0.30 + intensity / 130.0)
            if not re.search(r"[!！?？]$", result) and random.random() < probability:
                result += "！"
        return result

    @staticmethod
    def _prepend_with_limit(catchphrase: str, text: str, *, allow_long: bool) -> str:
        combined = f"{catchphrase}，{text}" if text else catchphrase
        if allow_long or len(combined) <= 80:
            return combined
        body_limit = max(1, 80 - len(catchphrase) - 1)
        return f"{catchphrase}，{text[:body_limit]}".rstrip("，,")

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.reply_count = max(0, int(data.get("reply_count", 0)))
            self.since_catchphrase = max(0, int(data.get("since_catchphrase", 0)))
            usage = data.get("usage", {})
            if isinstance(usage, dict):
                self.usage = {
                    str(key): max(0, int(value))
                    for key, value in usage.items()
                    if str(key).strip()
                }
        except Exception:
            logger.exception("Failed to load speech-habit state")

    def _save(self) -> None:
        data = {
            "reply_count": self.reply_count,
            "since_catchphrase": self.since_catchphrase,
            "usage": self.usage,
        }
        temp_path = self.path.with_suffix(".tmp")
        try:
            temp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            temp_path.replace(self.path)
        except Exception:
            logger.exception("Failed to persist speech-habit state")
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
