from pathlib import Path

import src.diary as diary_module
import src.interest.tracker as interest_module
import src.social.circle as social_module
import src.stickers as stickers_module
import src.timeline as timeline_module
import src.user as user_module
import src.web as web_module
from src.diary import DiaryManager
from src.interest.tracker import InterestTracker
from src.persona.persona_card import Persona, default_persona
from src.social.circle import SocialCircle
from src.stickers import StickerManager
from src.timeline import TimelineManager
from src.user import UserManager
from src.web import WebSurfingManager


def test_persona_description_supports_background_prompts() -> None:
    persona = default_persona()

    assert persona.description == persona.identity["description"]


def test_persona_description_falls_back_when_identity_description_missing() -> None:
    persona = Persona(
        name="Test",
        age=18,
        gender="female",
        identity={"title": "Artist"},
        personality_traits=["curious"],
    )

    assert persona.description == "18-year-old Artist"


def test_stateful_managers_default_to_configured_data_dirs(tmp_path, monkeypatch) -> None:
    persona = default_persona()
    expected_dirs = {
        "user": tmp_path / "user",
        "stickers": tmp_path / "stickers",
        "social": tmp_path / "social",
        "interest": tmp_path / "interest",
        "web": tmp_path / "web_cache",
        "timeline": tmp_path / "timeline",
        "diary": tmp_path / "diary",
        "diary_keys": tmp_path / "diary" / "keys",
    }

    monkeypatch.setattr(user_module, "USER_DIR", expected_dirs["user"])
    monkeypatch.setattr(stickers_module, "STICKERS_DIR", expected_dirs["stickers"])
    monkeypatch.setattr(social_module, "SOCIAL_DIR", expected_dirs["social"])
    monkeypatch.setattr(interest_module, "INTEREST_DIR", expected_dirs["interest"])
    monkeypatch.setattr(web_module, "WEB_CACHE_DIR", expected_dirs["web"])
    monkeypatch.setattr(timeline_module, "TIMELINE_DIR", expected_dirs["timeline"])
    monkeypatch.setattr(diary_module, "DIARY_DIR", expected_dirs["diary"])
    monkeypatch.setattr(diary_module, "ENCRYPTION_DIR", expected_dirs["diary_keys"])
    monkeypatch.setattr(diary_module, "KEY_FILE", expected_dirs["diary_keys"] / "diary_key.json")
    monkeypatch.setattr(diary_module, "KEY_BACKUP_DIR", expected_dirs["diary_keys"] / "key_backups")
    monkeypatch.setattr(diary_module, "METHOD_FILE", expected_dirs["diary_keys"] / "README-日记加密方式.txt")

    managers = [
        (UserManager(), expected_dirs["user"]),
        (StickerManager(), expected_dirs["stickers"]),
        (SocialCircle(), expected_dirs["social"]),
        (InterestTracker(), expected_dirs["interest"]),
        (WebSurfingManager(persona), expected_dirs["web"]),
        (TimelineManager(persona), expected_dirs["timeline"]),
        (DiaryManager(persona), expected_dirs["diary"]),
    ]

    for manager, expected_dir in managers:
        actual_dir = getattr(manager, "data_dir", getattr(manager, "diary_dir", None))
        assert Path(actual_dir).resolve() == expected_dir.resolve()

    assert not (expected_dirs["diary_keys"] / "diary_key.json").exists()
