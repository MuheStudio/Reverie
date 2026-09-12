from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from src.chat.proactive import ProactiveChat
from src.persona.persona_card import default_persona


class Emotion:
    def __init__(self, values, baseline=None, enabled=True):
        self.values = values
        self.baseline = baseline or {}
        self.enabled = enabled


class Clock:
    def now(self):
        return datetime(2026, 9, 6, 10, 0)

    def coerce(self, value):
        return value or self.now()


class Adapter:
    async def chat(self, messages, **kwargs):
        return SimpleNamespace(content="好")


def make(tmp_path, emotion, **kwargs):
    return ProactiveChat(
        default_persona(),
        Adapter(),
        emotion,
        world_clock=Clock(),
        state_path=tmp_path / "proactive.json",
        **kwargs,
    )


def test_modifier_is_neutral_at_baseline(tmp_path):
    emotion = Emotion(
        {"excitement": 30.0, "sadness": 20.0},
        baseline={"excitement": 30.0, "sadness": 20.0},
    )
    assert make(tmp_path, emotion)._emotion_interval_modifier() == 1.0


def test_arousal_shortens_and_heaviness_lengthens(tmp_path):
    excited = Emotion({"excitement": 90.0}, baseline={"excitement": 30.0})
    assert make(tmp_path, excited)._emotion_interval_modifier() == pytest.approx(1.0 - 0.25 * 0.6)
    heavy = Emotion({"sadness": 80.0}, baseline={"sadness": 20.0})
    assert make(tmp_path, heavy)._emotion_interval_modifier() == pytest.approx(1.0 + 0.25 * 0.6)


def test_modifier_is_bounded_fail_safe_and_respects_disable(tmp_path):
    wild = Emotion({"excitement": 500.0, "anger": 999.0})
    assert make(tmp_path, wild)._emotion_interval_modifier() == 0.75
    broken = Emotion("not-a-dict")
    assert make(tmp_path, broken)._emotion_interval_modifier() == 1.0
    disabled = Emotion({"excitement": 100.0}, enabled=False)
    assert make(tmp_path, disabled)._emotion_interval_modifier() == 1.0


def test_can_trigger_uses_the_modulated_interval(tmp_path):
    now = datetime(2026, 9, 6, 10, 0)
    excited = Emotion({"excitement": 90.0}, baseline={"excitement": 30.0})
    proactive = make(tmp_path, excited, min_interval_minutes=60)
    proactive._last_any_triggered = now - timedelta(minutes=54)
    assert proactive._can_trigger("test", now) is True

    calm = Emotion({"excitement": 30.0}, baseline={"excitement": 30.0})
    calm_proactive = make(tmp_path, calm, min_interval_minutes=60)
    calm_proactive._last_any_triggered = now - timedelta(minutes=54)
    assert calm_proactive._can_trigger("test", now) is False
