"""Hard caps for chat context: history scope, prompt tail, and cost sentinel.

The Luna-ts "390K-token incident" lessons pinned as tests:
- the entry/char caps are hard and independent of any summarization success;
- eviction always removes whole user/assistant pairs, never half an exchange;
- a single anomalous request trips a LOUD cost sentinel in the log.
"""

from __future__ import annotations

import logging

from unittest.mock import MagicMock

from src.api.adapter import LLMAdapter
from src.chat.session import ChatSession, _content_chars
from src.config.settings import FeatureSettings, LLMSettings


def _session() -> ChatSession:
    return ChatSession(
        persona=MagicMock(),
        adapter=MagicMock(),
        memory=MagicMock(),
        emotion=MagicMock(),
        relationship=MagicMock(),
    )


def _append_pair(history: list[dict], user_text: str, assistant_text: str) -> None:
    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": assistant_text})


# ── Entry cap keeps pairs ─────────────────────────────────────────────────


def test_entry_cap_keeps_whole_pairs() -> None:
    session = _session()
    history: list[dict] = []
    for index in range(110):
        _append_pair(history, f"u{index}", f"a{index}")
    session._trim_history(history)
    assert len(history) == ChatSession.MAX_HISTORY_ENTRIES
    assert len(history) % 2 == 0
    assert history[0]["role"] == "user"
    assert history[0]["content"] == "u10"
    assert history[-1]["content"] == "a109"


def test_entry_cap_never_splits_a_pair() -> None:
    session = _session()
    history: list[dict] = []
    for index in range(101):
        _append_pair(history, f"u{index}", f"a{index}")
    session._trim_history(history)
    assert len(history) % 2 == 0
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"


# ── Scope char cap ────────────────────────────────────────────────────────


def test_scope_char_cap_evicts_oldest_pairs_until_fit() -> None:
    session = _session()
    history: list[dict] = []
    for index in range(9):
        _append_pair(history, "x" * 30_000, "y" * 30_000)
    session._trim_history(history)
    total = sum(_content_chars(entry.get("content")) for entry in history)
    assert total <= ChatSession.MAX_HISTORY_CHARS
    assert len(history) % 2 == 0
    assert history[0]["role"] == "user"
    assert len(history) > 0


def test_image_parts_are_counted_by_allowance_not_raw_length() -> None:
    huge_data_url = "data:image/jpeg;base64," + "A" * 5_000_000
    entry = {
        "role": "user",
        "content": [
            {"type": "text", "text": "看看这张图"},
            {"type": "image_url", "image_url": {"url": huge_data_url}},
        ],
    }
    assert _content_chars(entry["content"]) < 2_000


# ── Prompt tail cap ───────────────────────────────────────────────────────


def test_prompt_tail_is_bounded_and_pair_aligned() -> None:
    session = _session()
    history = session._history_for("conv-tail")
    for _ in range(10):
        _append_pair(history, "x" * 30_000, "y" * 30_000)
    tail = session._prompt_tail("conv-tail")
    total = sum(_content_chars(entry.get("content")) for entry in tail)
    assert total <= ChatSession.MAX_PROMPT_TAIL_CHARS
    assert len(tail) % 2 == 0
    if tail:
        assert tail[0]["role"] == "user"


def test_prompt_tail_normal_conversation_is_untouched() -> None:
    session = _session()
    history = session._history_for("conv-normal")
    for index in range(30):
        _append_pair(history, f"u{index}", f"a{index}")
    tail = session._prompt_tail("conv-normal")
    expected = [content for index in range(20, 30) for content in (f"u{index}", f"a{index}")]
    assert [entry["content"] for entry in tail] == expected
    assert len(tail) == 20


def test_prompt_tail_drops_everything_when_one_pair_exceeds_the_cap() -> None:
    session = _session()
    history = session._history_for("conv-huge")
    _append_pair(history, "x" * 60_000, "y" * 60_000)
    tail = session._prompt_tail("conv-huge")
    assert tail == []


# ── Cost sentinel ─────────────────────────────────────────────────────────


def _adapter(sentinel: int) -> LLMAdapter:
    return LLMAdapter(
        LLMSettings(provider="anthropic", model="claude-test", api_key="test-key"),
        resolve_settings=False,
        cost_sentinel_tokens=sentinel,
    )


def test_feature_settings_expose_the_sentinel_default() -> None:
    features = FeatureSettings()
    assert features.api_cost_sentinel_tokens == 60_000
    assert FeatureSettings(api_cost_sentinel_tokens=0).api_cost_sentinel_tokens == 0


def test_sentinel_shouts_on_expensive_estimate(caplog) -> None:
    adapter = _adapter(100)
    with caplog.at_level(logging.WARNING, logger="reverie.api"):
        adapter._warn_if_expensive_request(
            500,
            purpose="chat_reply",
            provider="deepseek",
            model="deepseek-v4-flash",
            message_count=7,
        )
    assert any("[cost]" in record.message and "500" in record.message for record in caplog.records)


def test_sentinel_stays_silent_under_threshold_and_when_disabled(caplog) -> None:
    adapter = _adapter(100)
    with caplog.at_level(logging.WARNING, logger="reverie.api"):
        adapter._warn_if_expensive_request(
            50,
            purpose="chat_reply",
            provider="deepseek",
            model="deepseek-v4-flash",
            message_count=2,
        )
        disabled = _adapter(0)
        disabled._warn_if_expensive_request(
            999_999,
            purpose="chat_reply",
            provider="deepseek",
            model="deepseek-v4-flash",
            message_count=2,
        )
    assert not caplog.records


def test_sentinel_shouts_on_measured_prompt_tokens(caplog) -> None:
    adapter = _adapter(100)
    with caplog.at_level(logging.WARNING, logger="reverie.api"):
        adapter._warn_if_measured_prompt(120, purpose="chat_reply")
    assert any("[cost]" in record.message and "120" in record.message for record in caplog.records)
