"""Temporal intent detection and retrieval boost tests (Phase 1E)."""

from __future__ import annotations

import pytest

from src.memory.temporal_intent import (
    detect_temporal_intent,
    temporal_recency_boost,
)


# ── Intent detection ─────────────────────────────────────────────────


class TestDetectTemporalIntent:

    @pytest.mark.parametrize("query", [
        "我现在住在哪",
        "目前我的工作是什么",
        "最近在玩什么游戏",
        "当前我的爱好",
        "What am I currently working on",
        "my latest hobby",
        "what am I doing these days",
    ])
    def test_recent_intent(self, query: str) -> None:
        assert detect_temporal_intent(query) == "recent"

    @pytest.mark.parametrize("query", [
        "我以前住在哪",
        "我曾经养过什么宠物",
        "之前的工作是什么",
        "过去我喜欢什么",
        "I used to live where",
        "what did I do before",
        "back then what was my hobby",
    ])
    def test_historical_intent(self, query: str) -> None:
        assert detect_temporal_intent(query) == "historical"

    @pytest.mark.parametrize("query", [
        "我的生日是什么时候",
        "我们什么时候约好的",
        "哪天搬的家",
        "when did I move",
        "what date is the anniversary",
    ])
    def test_when_intent(self, query: str) -> None:
        assert detect_temporal_intent(query) == "when"

    @pytest.mark.parametrize("query", [
        "我喜欢什么",
        "我养了什么宠物",
        "tell me about my hobbies",
        "",
    ])
    def test_no_intent(self, query: str) -> None:
        assert detect_temporal_intent(query) is None

    def test_when_takes_priority_over_recent(self) -> None:
        # "最近什么时候" has both recent and when keywords; when wins
        assert detect_temporal_intent("最近什么时候见的面") == "when"


# ── Recency boost ────────────────────────────────────────────────────


class TestTemporalRecencyBoost:

    def test_none_intent_zero_boost(self) -> None:
        assert temporal_recency_boost(None, 0) == 0.0
        assert temporal_recency_boost(None, 365) == 0.0

    def test_recent_new_memory_gets_max_boost(self) -> None:
        boost = temporal_recency_boost("recent", age_days=1)
        assert boost == pytest.approx(0.08)

    def test_recent_old_memory_gets_penalty(self) -> None:
        boost = temporal_recency_boost("recent", age_days=60)
        assert boost < 0

    def test_recent_medium_age_gets_partial_boost(self) -> None:
        boost = temporal_recency_boost("recent", age_days=15)
        assert 0 < boost < 0.08

    def test_historical_old_memory_gets_mild_boost(self) -> None:
        boost = temporal_recency_boost("historical", age_days=90)
        assert boost > 0

    def test_historical_new_memory_no_penalty(self) -> None:
        boost = temporal_recency_boost("historical", age_days=5)
        assert boost == 0.0

    def test_when_intent_neutral(self) -> None:
        assert temporal_recency_boost("when", age_days=0) == 0.0
        assert temporal_recency_boost("when", age_days=365) == 0.0

    def test_boost_bounded(self) -> None:
        # All values should be within [-0.08, 0.08]
        for intent in ("recent", "historical", "when"):
            for days in (0, 1, 7, 30, 90, 365, 1000):
                boost = temporal_recency_boost(intent, age_days=days)
                assert -0.08 <= boost <= 0.08, (
                    f"intent={intent}, days={days}, boost={boost}"
                )
