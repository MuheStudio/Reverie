import asyncio
from datetime import datetime

import pytest

from src.api.adapter import ChatResponse, LLMAdapter
from src.api.budget import ApiBudgetExceeded, ApiBudgetTracker
from src.config.settings import (
    AIFeatureConsent,
    AIUsageSettings,
    FeatureSettings,
    LLMSettings,
    _Settings,
)
from src.config.usage_policy import UsagePolicy


def _settings(**overrides) -> FeatureSettings:
    defaults = {
        "api_budget_tracking_enabled": True,
        "api_background_budget_enforced": True,
        "api_background_daily_request_budget": 1,
        "api_background_daily_token_budget": 10_000,
    }
    defaults.update(overrides)
    return FeatureSettings(**defaults)


def test_background_request_budget_is_atomic_and_foreground_is_never_blocked(tmp_path) -> None:
    tracker = ApiBudgetTracker(_settings(), path=tmp_path / "world.db")
    now = datetime(2026, 7, 15, 9, 0)
    tracker.begin(
        provider="test",
        model="small",
        purpose="diary",
        background=True,
        estimated_tokens=10,
        now=now,
    )

    with pytest.raises(ApiBudgetExceeded):
        tracker.begin(
            provider="test",
            model="small",
            purpose="timeline",
            background=True,
            estimated_tokens=10,
            now=now,
        )

    foreground_id = tracker.begin(
        provider="test",
        model="small",
        purpose="chat_reply",
        background=False,
        estimated_tokens=10,
        now=now,
    )
    assert foreground_id


def test_snapshot_prefers_measured_usage_and_never_invents_currency(tmp_path) -> None:
    tracker = ApiBudgetTracker(_settings(), path=tmp_path / "world.db")
    now = datetime.now()
    call_id = tracker.begin(
        provider="test",
        model="small",
        purpose="diary",
        background=True,
        estimated_tokens=999,
        now=now,
    )
    tracker.complete(call_id, {"prompt_tokens": 12, "completion_tokens": 8})

    snapshot = tracker.snapshot(now)
    assert snapshot["prompt_tokens"] == 12
    assert snapshot["completion_tokens"] == 8
    assert snapshot["background"]["tokens"] == 20
    assert snapshot["currency_estimate"] is None


def test_live_budget_follows_whole_settings_replacement_and_lowering(tmp_path, monkeypatch) -> None:
    from src.bridge.ws_bridge import bridge_state
    from src.conversation_summary.runtime import current_runtime_settings

    initial = _Settings(features=_settings())
    monkeypatch.setattr(bridge_state, "settings", initial)
    tracker = ApiBudgetTracker(
        initial.features,
        path=tmp_path / "budget.sqlite3",
        settings_provider=lambda: current_runtime_settings(initial).features,
    )
    now = datetime(2026, 10, 5, 9, 0)
    request = {
        "provider": "test", "model": "summary-model", "purpose": "memory_summary",
        "background": True, "estimated_tokens": 10, "now": now,
    }
    assert tracker.begin(**request)
    with pytest.raises(ApiBudgetExceeded):
        tracker.begin(**request)

    raised = initial.model_copy(deep=True)
    raised.features.api_background_daily_request_budget = 2
    monkeypatch.setattr(bridge_state, "settings", raised)
    assert raised.features is not tracker.settings
    assert tracker.begin(**request)
    snapshot = tracker.snapshot(now)
    assert snapshot["background"]["request_budget"] == 2
    assert snapshot["background"]["requests"] == 2

    lowered = raised.model_copy(deep=True)
    lowered.features.api_background_daily_request_budget = 1
    monkeypatch.setattr(bridge_state, "settings", lowered)
    with pytest.raises(ApiBudgetExceeded):
        tracker.begin(**request)
    snapshot = tracker.snapshot(now)
    assert snapshot["background"]["request_budget"] == 1
    assert snapshot["background"]["requests"] == 2


def test_adapter_tracks_selected_model_and_actual_usage(tmp_path, monkeypatch) -> None:
    tracker = ApiBudgetTracker(
        _settings(api_background_daily_request_budget=10),
        path=tmp_path / "world.db",
    )
    settings = _Settings(
        features=_settings(
            api_background_daily_request_budget=10,
            hypa_compression_enabled=True,
        ),
        ai_usage=AIUsageSettings(),
    )
    usage_policy = UsagePolicy(
        settings_provider=lambda: settings,
        save_callback=lambda _settings: None,
    )
    usage_policy.grant("conversation_summary")
    adapter = LLMAdapter(
        LLMSettings(provider="ollama", model="default-model"),
        budget_tracker=tracker,
        usage_policy=usage_policy,
    )
    seen: list[str | None] = []

    async def fake_openai(messages, temperature=None, max_tokens=None, model=None):
        seen.append(model)
        return ChatResponse(
            content="ok",
            model=str(model),
            usage={"prompt_tokens": 3, "completion_tokens": 2},
        )

    monkeypatch.setattr(adapter, "_openai_chat", fake_openai)
    response = asyncio.run(
        adapter.chat(
            [{"role": "user", "content": "hello"}],
            model="summary-model",
            purpose="memory_summary",
            background=True,
        )
    )

    assert response.content == "ok"
    assert seen == ["summary-model"]
    snapshot = tracker.snapshot()
    assert snapshot["by_purpose"][0]["purpose"] == "memory_summary"
    assert snapshot["background"]["tokens"] == 5
