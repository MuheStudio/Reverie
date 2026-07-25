import logging

from src.config import settings as settings_module


def test_invalid_config_warns_and_keeps_backup(tmp_path, monkeypatch, caplog) -> None:
    config_file = tmp_path / "config.json"
    config_file.write_text("{bad json", encoding="utf-8")

    monkeypatch.setattr(settings_module, "_settings", None)
    monkeypatch.setattr(settings_module, "CONFIG_FILE", config_file)
    monkeypatch.setattr(settings_module, "PERSONA_DIR", tmp_path / "persona")
    monkeypatch.setattr(settings_module, "MEMORY_DIR", tmp_path / "memory")
    monkeypatch.setattr(settings_module, "DIARY_DIR", tmp_path / "diary")
    monkeypatch.setattr(settings_module, "DIARY_KEY_DIR", tmp_path / "diary" / "keys")
    monkeypatch.setattr(settings_module, "STICKERS_DIR", tmp_path / "stickers")
    monkeypatch.setattr(settings_module, "BACKUPS_DIR", tmp_path / "backups")
    monkeypatch.setattr(settings_module, "TIMELINE_DIR", tmp_path / "timeline")
    monkeypatch.setattr(settings_module, "WEB_CACHE_DIR", tmp_path / "web_cache")
    monkeypatch.setattr(settings_module, "USER_DIR", tmp_path / "user")
    monkeypatch.setattr(settings_module, "SOCIAL_DIR", tmp_path / "social")
    monkeypatch.setattr(settings_module, "INTEREST_DIR", tmp_path / "interest")
    monkeypatch.setattr(settings_module, "AFFAIRS_DIR", tmp_path / "affairs")
    monkeypatch.setattr(settings_module, "WORLD_DIR", tmp_path / "world")
    monkeypatch.setattr(settings_module, "EMOTION_DIR", tmp_path / "emotion")
    monkeypatch.setattr(settings_module, "KEEPSAKE_DIR", tmp_path / "keepsakes")
    monkeypatch.setattr(settings_module, "RELATIONSHIP_DIR", tmp_path / "relationship")
    caplog.set_level(logging.WARNING, logger="reverie.config.settings")

    settings = settings_module.load_settings()

    assert settings is not None
    assert list(tmp_path.glob("config.invalid.*.json"))
    assert "Invalid config file" in caplog.text
    assert "using defaults" in caplog.text
