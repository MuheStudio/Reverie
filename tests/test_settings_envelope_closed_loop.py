"""Product closed-loop: UI-shaped settings:update must pass the V4 envelope.

Direct handler tests can stay as unit coverage. They are not acceptance for
the four live loops (memory governance, web/keyless, video download, imported
prompt opts) because production stdio/WS always constructs CommandEnvelopeV4
first.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from src.bridge import ws_bridge
from src.config.settings import _Settings
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4


def _persona() -> PersonaScopeV4:
    return PersonaScopeV4(
        persona_id="persona_test",
        epoch=1,
        fingerprint="a" * 64,
    )


def _envelope(payload: dict, *, request_id: str = "request_settings_loop_01") -> CommandEnvelopeV4:
    return CommandEnvelopeV4(
        protocol_version=4,
        request_id=request_id,
        idempotency_key=request_id,
        command="settings:update",
        persona=_persona(),
        payload=payload,
    )


class _DummyWebSocket:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, message: str) -> None:  # pragma: no cover
        self.sent.append(message)


def _wire(monkeypatch, tmp_path) -> _Settings:
    settings = _Settings()
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", settings)
    monkeypatch.setattr(ws_bridge.bridge_state, "work_manager", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "diary", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "proactive", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "session", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", None)
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", None)
    monkeypatch.setattr(ws_bridge.bridge_state, "web_surfing", None)
    monkeypatch.setattr("src.config.settings.CONFIG_FILE", tmp_path / "config.json")
    return settings


def _dispatch(payload: dict, *, request_id: str = "request_settings_loop_01") -> dict:
    envelope = _envelope(payload, request_id=request_id)
    return asyncio.run(ws_bridge.handle_settings_update(dict(envelope.payload), _DummyWebSocket()))


def test_memory_governance_toggle_survives_envelope(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    assert settings.memory.memory_lifecycle_governance_enabled is True
    result = _dispatch({
        "section": "memory",
        "memory_lifecycle_governance_enabled": False,
        "memory_long_budget_chars": 250_000,
        "short_term_forget_probability": 0.05,
    })
    assert result["ok"] is True
    assert settings.memory.memory_lifecycle_governance_enabled is False
    assert settings.memory.memory_long_budget_chars == 250_000
    assert settings.memory.short_term_forget_probability == 0.05


def test_video_download_pair_survives_envelope(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    rejected = _dispatch({
        "section": "features",
        "video_download_enabled": True,
        "video_download_disclaimer_acknowledged": False,
    }, request_id="request_settings_loop_video_off")
    assert rejected["ok"] is True
    assert settings.features.video_download_enabled is False
    accepted = _dispatch({
        "section": "features",
        "video_download_disclaimer_acknowledged": True,
        "video_download_enabled": True,
    }, request_id="request_settings_loop_video_on")
    assert accepted["ok"] is True
    assert settings.features.video_download_enabled is True


def test_persona_prompt_opts_survive_envelope(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    session = ws_bridge.bridge_state.session
    result = _dispatch({
        "section": "persona_prompt_opts",
        "use_imported_system_prompt": True,
        "use_imported_post_history_instructions": False,
    }, request_id="request_settings_loop_prompt")
    assert result["ok"] is True
    assert session.imported_prompt_opts["use_imported_system_prompt"] is True
    assert session.imported_prompt_opts["use_imported_post_history_instructions"] is False
    assert settings is ws_bridge.bridge_state.settings


def test_keyless_onboarding_flags_survive_envelope(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    result = _dispatch({
        "section": "personality",
        "web_native_search_enabled": False,
        "surf_keyless_search_enabled": True,
        "web_surfing_enabled": True,
        "web_disclaimer_acknowledged": True,
    }, request_id="request_settings_loop_web")
    assert result["ok"] is True
    assert settings.features.surf_keyless_search_enabled is True
    assert settings.features.web_surfing_enabled is True
    assert settings.features.web_disclaimer_acknowledged is True


def test_features_proactive_no_longer_ignored(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    proactive = ws_bridge.bridge_state.proactive
    proactive.running = False
    result = _dispatch({
        "section": "features",
        "proactive_chat_enabled": True,
        "proactive_notifications_enabled": True,
        "proactive_daily_limit": 3,
        "proactive_min_interval_minutes": 30,
        "proactive_wake_min_minutes": 3,
        "proactive_wake_max_minutes": 8,
    }, request_id="request_settings_loop_proactive")
    assert result["ok"] is True
    assert settings.features.proactive_chat_enabled is True
    assert settings.features.proactive_daily_limit == 3
    proactive.start.assert_called()
