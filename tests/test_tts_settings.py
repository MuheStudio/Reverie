"""S3 TTS settings contract and projection tests."""

from __future__ import annotations

from src.config.settings import TTSSettings, _Settings
from src.kernel.contracts import SettingsUpdatePayload


def test_tts_settings_defaults() -> None:
    settings = TTSSettings()
    assert settings.provider == "gemini"
    assert settings.enabled is False
    assert settings.voice == ""
    assert settings.model == ""
    assert settings.resolved_api_key == "" or len(settings.resolved_api_key) > 3


def test_tts_settings_persists_without_api_key() -> None:
    settings = _Settings()
    data = settings.model_dump()
    assert "tts" in data
    assert set(data["tts"]) == {"provider", "model", "voice", "enabled"}


def test_settings_update_payload_accepts_tts_section() -> None:
    payload = SettingsUpdatePayload(
        section="tts",
        tts_enabled=True,
        tts_provider="openai",
        tts_voice="nova",
    )
    assert payload.tts_enabled is True
    assert payload.tts_provider == "openai"
    assert payload.tts_voice == "nova"


def test_settings_update_payload_rejects_foreign_tts_fields() -> None:
    try:
        SettingsUpdatePayload(section="tts", tts_enabled=True, tts_voice="nova", mode="mvp")
    except ValueError:
        pass
    else:
        raise AssertionError("mode is not a valid tts section field")


def test_settings_update_payload_rejects_unknown_tts_provider() -> None:
    try:
        SettingsUpdatePayload(section="tts", tts_provider="unknown")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown tts provider must be rejected")


def test_settings_update_payload_rejects_tts_fields_in_other_sections() -> None:
    try:
        SettingsUpdatePayload(section="ui", tts_enabled=True)
    except ValueError:
        pass
    else:
        raise AssertionError("tts fields are only valid in the tts section")
