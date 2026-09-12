"""Clause 94/95: statutory holiday tables for 2027-2030 (fail-closed about 调休)."""

from __future__ import annotations

from datetime import datetime, timezone

from src.local_store import atomic_write_json
from src.world.clock import WorldClock, _seed_calendar_payload


def make_clock(tmp_path) -> WorldClock:
    return WorldClock(data_dir=tmp_path / "calendar")


def _dt(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, 12, 0, tzinfo=timezone.utc)


def test_2027_spring_festival_statutory_days(tmp_path) -> None:
    clock = make_clock(tmp_path)
    for day in (5, 6, 7, 8):  # 除夕(02-05) 到初三(02-08)，初一为 02-06
        context = clock.day_context(_dt(2027, 2, day))
        assert context.is_day_off is True, day
        assert context.holiday == "春节"
    assert clock.day_context(_dt(2027, 2, 9)).is_day_off is False


def test_lunar_and_solar_term_festival_days_2027_to_2030(tmp_path) -> None:
    clock = make_clock(tmp_path)
    expected = (
        (2027, 6, 9, "端午节"), (2028, 5, 28, "端午节"),
        (2029, 6, 16, "端午节"), (2030, 6, 5, "端午节"),
        (2027, 9, 15, "中秋节"), (2028, 10, 3, "中秋节"),
        (2029, 9, 22, "中秋节"), (2030, 9, 12, "中秋节"),
        (2027, 4, 5, "清明节"), (2028, 4, 4, "清明节"),
        (2029, 4, 4, "清明节"), (2030, 4, 5, "清明节"),
        (2030, 2, 3, "春节"), (2028, 1, 26, "春节"),
    )
    for year, month, day, label in expected:
        context = clock.day_context(_dt(year, month, day))
        assert context.holiday == label, (year, month, day, context.holiday)


def test_statutory_only_years_fail_closed_about_tiaoxiu(tmp_path) -> None:
    clock = make_clock(tmp_path)
    future_prompt = clock.build_prompt_context(_dt(2027, 2, 6))
    assert "调休" in future_prompt
    assert "不得猜测" in future_prompt
    official_prompt = clock.build_prompt_context(_dt(2026, 2, 17))
    assert "尚未公布" not in official_prompt


def test_upcoming_events_find_future_mid_autumn(tmp_path) -> None:
    clock = make_clock(tmp_path)
    events = clock.upcoming_events(value=_dt(2027, 9, 15), days=0)
    assert any(event.kind == "holiday" and "中秋节" in event.label for event in events)


def test_seed_merge_reaches_existing_installs(tmp_path) -> None:
    """旧安装的 holidays.json 只有 2026 年：启动时应补种缺失的种子年份。"""
    legacy = _seed_calendar_payload()
    legacy["years"] = {"2026": legacy["years"]["2026"]}
    atomic_write_json(tmp_path / "calendar" / "holidays.json", legacy)

    clock = WorldClock(data_dir=tmp_path / "calendar")
    years = clock.export_all()["years"]
    assert {"2026", "2027", "2028", "2029", "2030"} <= set(years)


def test_sanitize_round_trip_preserves_arrangement_status(tmp_path) -> None:
    clock = make_clock(tmp_path)
    payload = clock.export_all()
    assert payload["years"]["2027"]["arrangement_status"] == "statutory_only"
    assert payload["years"]["2026"]["arrangement_status"] == "official"

    restored = WorldClock(data_dir=tmp_path / "calendar2")
    restored.import_all(payload)
    assert restored.export_all()["years"]["2028"]["arrangement_status"] == "statutory_only"
