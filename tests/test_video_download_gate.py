"""Compliance gate for the cat-catch-inspired video download feature.

The feature is disclaimer-gated and default-off. These tests drive the real
``handle_settings_update`` bridge handler (section=features) to prove the
fail-closed invariant end-to-end: ``video_download_enabled`` can never be True
unless ``video_download_disclaimer_acknowledged`` is True in the resulting
settings, and revoking the acknowledgement disables the feature in the same
update. See 待实施计划/Reverie与猫抓的联网搜索新灵感/视频下载到聊天发送-实施设计方案.md §一.
"""

import asyncio

from unittest.mock import MagicMock

from src.bridge import ws_bridge
from src.config.settings import FeatureSettings, _Settings


class _DummyWebSocket:
    def __init__(self) -> None:
        self.sent: list = []

    async def send(self, message: str) -> None:  # pragma: no cover - not asserted
        self.sent.append(message)


def _wire(monkeypatch, tmp_path) -> _Settings:
    settings = _Settings()
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", settings)
    monkeypatch.setattr(ws_bridge.bridge_state, "work_manager", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "diary", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "proactive", MagicMock())
    monkeypatch.setattr("src.config.settings.CONFIG_FILE", tmp_path / "config.json")
    return settings


def _update(payload: dict) -> None:
    asyncio.run(ws_bridge.handle_settings_update(payload, _DummyWebSocket()))


def test_defaults_are_off() -> None:
    features = FeatureSettings()
    assert features.video_download_enabled is False
    assert features.video_download_disclaimer_acknowledged is False
    assert features.video_max_size_mb == 500
    assert features.video_max_duration_seconds == 1800
    assert features.video_total_quota_mb == 4096


def test_enable_without_acknowledgement_is_forced_off(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    _update({
        "section": "features",
        "video_download_enabled": True,
    })
    # Fail-closed: no acknowledged disclaimer -> feature stays off.
    assert settings.features.video_download_enabled is False


def test_enable_with_acknowledgement_succeeds(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    _update({
        "section": "features",
        "video_download_disclaimer_acknowledged": True,
        "video_download_enabled": True,
    })
    assert settings.features.video_download_disclaimer_acknowledged is True
    assert settings.features.video_download_enabled is True


def test_revoking_acknowledgement_disables_feature(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    _update({
        "section": "features",
        "video_download_disclaimer_acknowledged": True,
        "video_download_enabled": True,
    })
    assert settings.features.video_download_enabled is True
    # Revoke acknowledgement in a later update -> feature disabled in the same pass.
    _update({
        "section": "features",
        "video_download_disclaimer_acknowledged": False,
    })
    assert settings.features.video_download_disclaimer_acknowledged is False
    assert settings.features.video_download_enabled is False


def test_limits_are_clamped(monkeypatch, tmp_path) -> None:
    settings = _wire(monkeypatch, tmp_path)
    _update({
        "section": "features",
        "video_max_size_mb": 999999,
        "video_max_duration_seconds": 0,
        "video_total_quota_mb": 999999,
    })
    assert settings.features.video_max_size_mb == 4096
    assert settings.features.video_max_duration_seconds == 1
    assert settings.features.video_total_quota_mb == 51200
