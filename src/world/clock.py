"""Timezone-aware local clock with fail-closed holiday knowledge."""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config.settings import WORLD_DIR
from ..local_store import atomic_write_json, read_json_object

logger = logging.getLogger("reverie.world.clock")

CHINESE_WEEKDAYS = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")
OFFICIAL_2026_SOURCE = (
    "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm"
)

_HOLIDAY_RANGES_2026 = (
    ("元旦", "2026-01-01", "2026-01-03"),
    ("春节", "2026-02-15", "2026-02-23"),
    ("清明节", "2026-04-04", "2026-04-06"),
    ("劳动节", "2026-05-01", "2026-05-05"),
    ("端午节", "2026-06-19", "2026-06-21"),
    ("中秋节", "2026-09-25", "2026-09-27"),
    ("国庆节", "2026-10-01", "2026-10-07"),
)
_ADJUSTED_WORKDAYS_2026 = {
    "2026-01-04": "元旦调休上班",
    "2026-02-14": "春节调休上班",
    "2026-02-28": "春节调休上班",
    "2026-05-09": "劳动节调休上班",
    "2026-09-20": "国庆节调休上班",
    "2026-10-10": "国庆节调休上班",
}

# 2027-2030: only the statutory festival days are marked (《全国年节及纪念日
# 放假办法》2024年修订 + 农历/节气推算).  The official annual arrangement
# (连休与调休) is a government decision published each autumn — until it is,
# the clock stays fail-closed about 调休 instead of guessing.
_STATUTORY_HOLIDAY_RANGES: dict[str, tuple[tuple[str, str, str], ...]] = {
    "2027": (
        ("元旦", "2027-01-01", "2027-01-01"),
        ("春节", "2027-02-05", "2027-02-08"),
        ("清明节", "2027-04-05", "2027-04-05"),
        ("劳动节", "2027-05-01", "2027-05-02"),
        ("端午节", "2027-06-09", "2027-06-09"),
        ("中秋节", "2027-09-15", "2027-09-15"),
        ("国庆节", "2027-10-01", "2027-10-03"),
    ),
    "2028": (
        ("元旦", "2028-01-01", "2028-01-01"),
        ("春节", "2028-01-25", "2028-01-28"),
        ("清明节", "2028-04-04", "2028-04-04"),
        ("劳动节", "2028-05-01", "2028-05-02"),
        ("端午节", "2028-05-28", "2028-05-28"),
        ("国庆节", "2028-10-01", "2028-10-03"),
        # 中秋与国庆同年重叠：后写者胜出，重叠日显示更具体的节日名。
        ("中秋节", "2028-10-03", "2028-10-03"),
    ),
    "2029": (
        ("元旦", "2029-01-01", "2029-01-01"),
        ("春节", "2029-02-12", "2029-02-15"),
        ("清明节", "2029-04-04", "2029-04-04"),
        ("劳动节", "2029-05-01", "2029-05-02"),
        ("端午节", "2029-06-16", "2029-06-16"),
        ("中秋节", "2029-09-22", "2029-09-22"),
        ("国庆节", "2029-10-01", "2029-10-03"),
    ),
    "2030": (
        ("元旦", "2030-01-01", "2030-01-01"),
        ("春节", "2030-02-02", "2030-02-05"),
        ("清明节", "2030-04-05", "2030-04-05"),
        ("劳动节", "2030-05-01", "2030-05-02"),
        ("端午节", "2030-06-05", "2030-06-05"),
        ("中秋节", "2030-09-12", "2030-09-12"),
        ("国庆节", "2030-10-01", "2030-10-03"),
    ),
}
_STATUTORY_ARRANGEMENT_SOURCE = (
    "法定节日当天依据《全国年节及纪念日放假办法》（2024年修订）与农历/节气推算；"
    "当年官方连休与调休安排公布前不猜测。"
)


@dataclass(frozen=True)
class CalendarEvent:
    id: str
    label: str
    date: str
    kind: str
    days_until: int = 0


@dataclass(frozen=True)
class DayContext:
    date: str
    time: str
    weekday: str
    timezone: str
    holiday: str = ""
    is_day_off: bool = False
    adjusted_workday: str = ""
    calendar_covered: bool = False
    arrangement_pending: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class WorldClock:
    """Single source of truth for local dates used by character world state."""

    def __init__(
        self,
        timezone_name: str = "Asia/Shanghai",
        *,
        data_dir: Path | None = None,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self.timezone_name = timezone_name
        try:
            self.tz = ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError:
            logger.warning("IANA timezone unavailable; using fixed China Standard Time")
            self.tz = timezone(timedelta(hours=8), name="Asia/Shanghai")
        self.data_dir = data_dir or (WORLD_DIR / "calendar")
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            logger.exception("Local calendar directory is not writable; using in-memory calendar")
        self._now_provider = now_provider
        self.calendar_path = self.data_dir / "holidays.json"
        self._calendar = self._load_or_seed_calendar()

    def now(self) -> datetime:
        value = self._now_provider() if self._now_provider else datetime.now(timezone.utc)
        if value.tzinfo is None:
            value = value.replace(tzinfo=self.tz)
        return value.astimezone(self.tz)

    def coerce(self, value: datetime | None = None) -> datetime:
        if value is None:
            return self.now()
        if value.tzinfo is None:
            return value.replace(tzinfo=self.tz)
        return value.astimezone(self.tz)

    def day_context(self, value: datetime | None = None) -> DayContext:
        now = self.coerce(value)
        key = now.date().isoformat()
        year_data = self._calendar.get("years", {}).get(str(now.year), {})
        holidays = year_data.get("holidays", {}) if isinstance(year_data, dict) else {}
        workdays = year_data.get("adjusted_workdays", {}) if isinstance(year_data, dict) else {}
        arrangement = year_data.get("arrangement_status", "official") if isinstance(year_data, dict) else ""
        return DayContext(
            date=key,
            time=now.strftime("%H:%M"),
            weekday=CHINESE_WEEKDAYS[now.weekday()],
            timezone=self.timezone_name,
            holiday=str(holidays.get(key, "")),
            is_day_off=key in holidays,
            adjusted_workday=str(workdays.get(key, "")),
            calendar_covered=bool(year_data),
            arrangement_pending=isinstance(arrangement, str) and arrangement == "statutory_only",
        )

    def build_prompt_context(self, value: datetime | None = None) -> str:
        day = self.day_context(value)
        lines = [
            f"当前日期：{day.date} {day.weekday}",
            f"当前时间：{day.time}（{day.timezone}）",
        ]
        if day.holiday:
            lines.append(f"今天是{day.holiday}假期")
        if day.adjusted_workday:
            lines.append(f"今天是{day.adjusted_workday}，不是普通周末")
        if day.arrangement_pending:
            lines.append("当年官方连休与调休安排尚未公布：以上仅法定节日当天，具体放假调休不得猜测")
        if not day.calendar_covered:
            lines.append("当前年份没有本地权威节假日表，不得猜测法定放假安排")
        return "\n".join(lines)

    def upcoming_events(
        self,
        *,
        persona: Any = None,
        user_profile: Any = None,
        value: datetime | None = None,
        days: int = 1,
    ) -> list[CalendarEvent]:
        now = self.coerce(value)
        result: list[CalendarEvent] = []
        for offset in range(max(0, days) + 1):
            target = now.date() + timedelta(days=offset)
            target_dt = datetime.combine(target, datetime.min.time(), tzinfo=self.tz)
            day = self.day_context(target_dt)
            if day.holiday:
                result.append(CalendarEvent(f"holiday:{target}", day.holiday, str(target), "holiday", offset))

        birthday = str(getattr(persona, "birthday", "") or "")
        name = str(getattr(persona, "name", "她") or "她")
        result.extend(self._recurring_events({f"{name}的生日": birthday}, now, days, "character_birthday"))

        if user_profile is not None:
            important_dates = dict(getattr(user_profile, "important_dates", {}) or {})
            user_birthday = str(getattr(user_profile, "birthday", "") or "")
            if user_birthday:
                important_dates.setdefault("你的生日", user_birthday)
            result.extend(self._recurring_events(important_dates, now, days, "important_date"))

        deduped: dict[tuple[str, str], CalendarEvent] = {}
        for event in result:
            deduped[(event.label, event.date)] = event
        return sorted(deduped.values(), key=lambda item: (item.date, item.label))

    def _recurring_events(
        self,
        values: dict[str, str],
        now: datetime,
        days: int,
        kind: str,
    ) -> list[CalendarEvent]:
        events: list[CalendarEvent] = []
        for label, raw in values.items():
            parsed = _parse_date(raw)
            if parsed is None:
                continue
            for year in range(now.year, now.year + 5):
                try:
                    candidate = date(year, parsed.month, parsed.day)
                except ValueError:
                    continue
                offset = (candidate - now.date()).days
                if offset < 0:
                    continue
                if 0 <= offset <= max(0, days):
                    events.append(
                        CalendarEvent(
                            id=f"{kind}:{label}:{candidate}",
                            label=str(label)[:80],
                            date=candidate.isoformat(),
                            kind=kind,
                            days_until=offset,
                        )
                    )
                break
        return events

    def export_all(self) -> dict[str, Any]:
        return dict(self._calendar)

    def import_all(self, payload: dict[str, Any]) -> int:
        if not isinstance(payload, dict) or not isinstance(payload.get("years"), dict):
            raise ValueError("节假日数据格式无效")
        normalized = _sanitize_calendar_payload(payload)
        self._calendar = normalized
        atomic_write_json(self.calendar_path, normalized)
        return len(normalized["years"])

    def _load_or_seed_calendar(self) -> dict[str, Any]:
        try:
            payload = read_json_object(self.calendar_path)
            if payload and isinstance(payload.get("years"), dict):
                calendar = _sanitize_calendar_payload(payload)
                # Existing installs predate later seed years: merge any seed
                # year the local file lacks instead of never offering it.
                missing = {
                    year: data
                    for year, data in _seed_calendar_payload()["years"].items()
                    if year not in calendar["years"]
                }
                if missing:
                    calendar["years"].update(missing)
                    atomic_write_json(self.calendar_path, calendar)
                return calendar
        except Exception:
            logger.exception("Failed to load local holiday calendar")
        payload = _seed_calendar_payload()
        try:
            atomic_write_json(self.calendar_path, payload)
        except OSError:
            logger.warning("Could not persist seeded calendar; keeping authoritative table in memory")
        return payload


def _parse_date(value: str) -> date | None:
    text = value.strip().replace("年", "-").replace("月", "-").replace("日", "")
    text = text.replace("/", "-").replace(".", "-")
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _holiday_map(ranges: tuple[tuple[str, str, str], ...]) -> dict[str, str]:
    holidays: dict[str, str] = {}
    for label, start_text, end_text in ranges:
        current = date.fromisoformat(start_text)
        end = date.fromisoformat(end_text)
        while current <= end:
            holidays[current.isoformat()] = label
            current += timedelta(days=1)
    return holidays


def _seed_calendar_payload() -> dict[str, Any]:
    years: dict[str, Any] = {
        "2026": {
            "jurisdiction": "CN",
            "source": OFFICIAL_2026_SOURCE,
            "holidays": _holiday_map(_HOLIDAY_RANGES_2026),
            "adjusted_workdays": dict(_ADJUSTED_WORKDAYS_2026),
            "arrangement_status": "official",
        }
    }
    for year, ranges in _STATUTORY_HOLIDAY_RANGES.items():
        years[year] = {
            "jurisdiction": "CN",
            "source": _STATUTORY_ARRANGEMENT_SOURCE,
            "holidays": _holiday_map(ranges),
            "adjusted_workdays": {},
            "arrangement_status": "statutory_only",
        }
    return {
        "schema": "reverie.local_calendar.v1",
        "cloud_status": "开发中",
        "years": years,
    }


def _sanitize_calendar_payload(payload: dict[str, Any]) -> dict[str, Any]:
    years: dict[str, Any] = {}
    for raw_year, raw_data in payload.get("years", {}).items():
        year = str(raw_year)
        if not re.fullmatch(r"20\d{2}", year) or not isinstance(raw_data, dict):
            continue
        holidays: dict[str, str] = {}
        workdays: dict[str, str] = {}
        for source, target in (
            (raw_data.get("holidays", {}), holidays),
            (raw_data.get("adjusted_workdays", {}), workdays),
        ):
            if not isinstance(source, dict):
                continue
            for raw_date, raw_label in source.items():
                key = str(raw_date)
                try:
                    parsed = date.fromisoformat(key)
                except ValueError:
                    continue
                if parsed.year != int(year):
                    continue
                label = re.sub(r"[\x00-\x1f<>]", "", str(raw_label)).strip()[:80]
                if label:
                    target[key] = label
        years[year] = {
            "jurisdiction": re.sub(r"[^A-Za-z0-9_-]", "", str(raw_data.get("jurisdiction", "CN")))[:20],
            "source": str(raw_data.get("source", ""))[:500],
            "holidays": holidays,
            "adjusted_workdays": workdays,
            "arrangement_status": (
                "statutory_only"
                if str(raw_data.get("arrangement_status", "")) == "statutory_only"
                else "official"
            ),
        }
    if not years:
        raise ValueError("节假日数据不包含有效年份")
    return {
        "schema": "reverie.local_calendar.v1",
        "cloud_status": "开发中",
        "years": years,
    }
