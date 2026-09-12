"""update_profile must never erase existing data with blank values.

The rerun-onboarding incident: the wizard's finish commit submitted a
near-empty profile object, and update_profile overwrote every provided
key with the blank payload, then re-seeded memory anchors from the wiped
profile. Empty values are now treated as "not provided".
"""

from __future__ import annotations

from pathlib import Path

from src.user import UserManager


def _manager(tmp_path: Path) -> UserManager:
    return UserManager(data_dir=tmp_path)


def test_blank_payload_never_erases_existing_profile(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    manager.update_profile({
        "name": "星野白夜",
        "nickname": "白夜",
        "birthday": "2007-03-03",
        "age": 19,
        "identity": "生物学家",
        "schedule": "09:00-23:00",
        "interests": ["明日方舟", "蔚蓝档案"],
        "important_dates": {"纪念日": "3 月 3 日"},
    })

    manager.update_profile({
        # The onboarding wizard's near-empty finish payload.
        "name": "", "nickname": "  ", "birthday": "", "identity": "", "schedule": "",
        "interests": [], "hobbies": [], "favorite_topics": [], "favorite_games": [],
        "favorite_anime": [], "important_dates": {},
    })

    profile = manager.profile
    assert profile.name == "星野白夜"
    assert profile.nickname == "白夜"
    assert profile.birthday == "2007-03-03"
    assert profile.age == 19
    assert profile.identity == "生物学家"
    assert profile.schedule == "09:00-23:00"
    assert list(profile.interests) == ["明日方舟", "蔚蓝档案"]
    assert profile.important_dates.get("纪念日") == "3 月 3 日"


def test_nonempty_values_still_update(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    manager.update_profile({"name": "旧名", "interests": ["明日方舟"]})
    manager.update_profile({"name": "新名", "age": 20, "interests": ["终末地"], "hobbies": ["写小说"]})
    assert manager.profile.name == "新名"
    assert manager.profile.age == 20
    assert list(manager.profile.interests) == ["终末地"]
    assert list(manager.profile.hobbies) == ["写小说"]


def test_invalid_age_is_ignored_not_wiped(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    manager.update_profile({"age": 19})
    manager.update_profile({"age": "not-a-number"})
    assert manager.profile.age == 19
    manager.update_profile({"age": 0})
    assert manager.profile.age == 19


def test_first_run_blank_profile_still_saves_marker_fields(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    profile = manager.update_profile({"nickname": "小白", "age": 18})
    assert profile.nickname == "小白"
    assert profile.age == 18
    reloaded = UserManager(data_dir=tmp_path)
    assert reloaded.profile.nickname == "小白"


def test_restore_default_profile_replaces_editable_fields(tmp_path: Path) -> None:
    manager = _manager(tmp_path)
    manager.update_profile({"name": "自定义", "nickname": "小白", "age": 22, "identity": "学生"})
    restored = manager.restore_default_profile()
    assert restored.name == "星野白夜"
    assert restored.nickname == "白夜"
    assert restored.age == 19
    assert restored.identity == "生物学家，医学家，化学家"
