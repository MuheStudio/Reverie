"""Background fixed-event manager for life-simulation tasks."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import random
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Any, Awaitable

from .config.settings import DATA_DIR
from .persona.identity import StalePersonaEpoch

if TYPE_CHECKING:
    from .ambient import AmbientPresence
    from .chat.scheduler import MessageScheduler
    from .config.settings import FeatureSettings
    from .diary import DiaryEntry, DiaryManager
    from .emotion.system import EmotionSystem
    from .persona.persona_card import Persona
    from .affairs import PersonalAffairManager
    from .interest import InterestTracker
    from .memory.manager import MemoryManager
    from .world import WorldClock
    from .persona.identity import PersonaEpochToken
    from .persona.state_scope import PersonaModuleState

from .local_store import atomic_write_json

logger = logging.getLogger("reverie.work_manager")


def _parse_time(value: str | None, fallback: str) -> time:
    raw = value or fallback
    try:
        hour_text, minute_text = raw.split(":", 1)
        hour = max(0, min(23, int(hour_text)))
        minute = max(0, min(59, int(minute_text)))
        return time(hour=hour, minute=minute)
    except Exception:
        fallback_hour, fallback_minute = fallback.split(":", 1)
        return time(hour=int(fallback_hour), minute=int(fallback_minute))


def _is_in_window(value: time, start: time, end: time) -> bool:
    if start == end:
        return False
    if start < end:
        return start <= value < end
    return value >= start or value < end


class WorkManager:
    """Runs fixed background events, including diary generation."""

    CHECK_INTERVAL_SECONDS = 15 * 60
    DEFAULT_STATE_PATH = DATA_DIR / "runtime" / "work_manager_state.json"

    def __init__(
        self,
        *,
        persona: "Persona",
        scheduler: "MessageScheduler",
        diary: "DiaryManager",
        feature_settings: "FeatureSettings",
        state_path: Path | None = None,
        check_interval_seconds: float = CHECK_INTERVAL_SECONDS,
        random_func: Callable[[], float] = random.random,
        late_night_message_callback: Callable[[str], Awaitable[bool] | bool] | None = None,
        affair_manager: "PersonalAffairManager | None" = None,
        interest_tracker: "InterestTracker | None" = None,
        memory: "MemoryManager | None" = None,
        world_clock: "WorldClock | None" = None,
        ambient_presence: "AmbientPresence | None" = None,
        state_scope: "PersonaModuleState | None" = None,
        emotion: "EmotionSystem | None" = None,
    ) -> None:
        self.persona = persona
        if callable(getattr(self.persona, "seal_identity", None)):
            self.persona.seal_identity()
        self.scheduler = scheduler
        self.diary = diary
        self.feature_settings = feature_settings
        scoped_path = (
            state_scope.file(self.DEFAULT_STATE_PATH.name)
            if state_scope is not None
            else None
        )
        if scoped_path is not None and state_path is not None:
            if Path(state_path).resolve() != scoped_path.resolve():
                raise ValueError("WorkManager state_path conflicts with persona state scope")
        self._state_scope = state_scope
        self.state_path = scoped_path or state_path or self.DEFAULT_STATE_PATH
        self.check_interval_seconds = check_interval_seconds
        self.random_func = random_func
        self.late_night_message_callback = late_night_message_callback
        self.affair_manager = affair_manager
        self.interest_tracker = interest_tracker
        self.memory = memory
        self.emotion = emotion
        self.ambient_presence = ambient_presence
        if world_clock is None:
            from .world import WorldClock

            world_clock = WorldClock()
        self.world_clock = world_clock
        self._task: asyncio.Task | None = None
        self._state: dict[str, Any] = self._load_state()
        self._late_night_active = False
        self._diary_writing = False

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def late_night_active(self) -> bool:
        event_date = self._rest_event_date(self.world_clock.now().replace(tzinfo=None))
        if event_date and self.feature_settings.late_night_enabled:
            roll = self._state.get("late_night_rolls", {}).get(event_date)
            if isinstance(roll, dict):
                return bool(roll.get("active"))
        return self._late_night_active

    @property
    def diary_writing(self) -> bool:
        """Expose real diary generation activity without renderer-owned timers."""
        return self._diary_writing

    def apply_settings(self, feature_settings: "FeatureSettings") -> None:
        self._require_scope()
        self.feature_settings = feature_settings
        if not feature_settings.diary_enabled:
            discard = getattr(self.diary, "discard_missed", None)
            if callable(discard):
                discard()

    def start(self) -> None:
        self._require_scope()
        if self.running:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            logger.warning("WorkManager cannot start without a running event loop")
            return
        self._task = loop.create_task(self._run_loop())
        logger.info("WorkManager started (interval=%ss)", self.check_interval_seconds)

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
            self._late_night_active = False
            self._diary_writing = False
            logger.info("WorkManager stopped")

    def _apply_affair_emotion_outcomes(self, updates: list[dict[str, Any]]) -> None:
        """Affair outcomes are non-chat life events: they must move the
        emotional state too, not only the affair ledger."""
        emotion = self.emotion
        if emotion is None or not updates:
            return
        for update in updates:
            if not isinstance(update, dict):
                continue
            title = str(update.get("title") or "").strip()[:80] or "一件小事"
            completed = str(update.get("status")) == "completed"
            outcome = f"{'完成了' if completed else '推进了'}「{title}」"
            try:
                emotion.apply_event_outcome(
                    outcome,
                    explicit_changes={"joy": 8.0 if completed else 3.0},
                )
            except Exception:
                logger.exception("Affair emotion outcome failed; life loop continues")

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.run_once()
                await asyncio.sleep(self.check_interval_seconds)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("WorkManager loop error")
                await asyncio.sleep(self.check_interval_seconds)

    async def run_once(self, now: datetime | None = None) -> list["DiaryEntry"]:
        """Check fixed events once and return diary entries written now."""
        epoch_token = self._capture_scope()
        now = self.world_clock.coerce(now).replace(tzinfo=None)
        try:
            if self.affair_manager is not None:
                updates = self.affair_manager.advance_due(now)
                self._apply_affair_emotion_outcomes(updates)
        except StalePersonaEpoch:
            raise
        except Exception:
            logger.exception("Personal affair advancement failed; life loop continues")
        try:
            if self.interest_tracker is not None:
                grown = self.interest_tracker.advance_due(now)
                # Self-initiated growth becomes a long-term memory so the
                # character can later recall and reference it (self-growth spec).
                if (
                    grown is not None
                    and self.memory is not None
                    and self.feature_settings.self_growth_from_memory_enabled
                ):
                    try:
                        self.memory.store_fact(
                            f"自我成长：{grown.name} 兴趣进度 {grown.progress:.0f}%",
                            layer="long_term",
                            source_type="self_growth",
                        )
                    except Exception:
                        logger.exception("Self-growth memory write failed; life loop continues")
        except StalePersonaEpoch:
            raise
        except Exception:
            logger.exception("Interest advancement failed; life loop continues")
        event_date = self._rest_event_date(now)

        if event_date is None:
            self._advance_ambient(now, late_night_active=False)
            self._late_night_active = False
            if self.scheduler.status == "sleeping":
                self.scheduler.set_status("online")
            return []

        late_night = self._late_night_for(event_date, now)
        self._late_night_active = late_night
        self._advance_ambient(now, late_night_active=late_night)

        if late_night:
            if self.scheduler.status == "sleeping":
                self.scheduler.set_status("online")
            await self._maybe_send_late_night_message(
                event_date,
                epoch_token=epoch_token,
            )
            self._require_scope(epoch_token)
            if self.feature_settings.diary_enabled and self._diary_generation_allowed():
                self.diary.record_missed(event_date)
            return []

        if self.scheduler.status != "sleeping":
            self.scheduler.set_status("sleeping")

        if not self.feature_settings.diary_enabled or not self._diary_generation_allowed():
            discard = getattr(self.diary, "discard_missed", None)
            if callable(discard):
                discard()
            return []

        self._diary_writing = True
        try:
            entries = await self.diary.handle_sleep_event(event_date, late_night_active=False)
        finally:
            self._diary_writing = False
        self._require_scope(epoch_token)
        if entries:
            logger.info("Diary sleep event wrote %d entrie(s)", len(entries))
        return entries

    def _advance_ambient(self, now: datetime, *, late_night_active: bool) -> None:
        if self.ambient_presence is None:
            return
        try:
            emotion = getattr(self.diary, "emotion", None)
            emotions = dict(getattr(emotion, "values", {}) or {})
            self.ambient_presence.advance(
                now,
                emotions=emotions,
                late_night_active=late_night_active,
            )
        except Exception:
            logger.exception("Ambient life advancement failed; fixed-event loop continues")

    def _diary_generation_allowed(self) -> bool:
        policy = getattr(self.diary, "usage_policy", None)
        if policy is None:
            return True
        return bool(policy.allowed("diary_generation"))

    async def _maybe_send_late_night_message(
        self,
        event_date: str,
        *,
        epoch_token: "PersonaEpochToken | None" = None,
    ) -> None:
        if not self.feature_settings.late_night_message_enabled:
            return
        if self.late_night_message_callback is None:
            return
        sent = self._state.setdefault("late_night_messages", {})
        if sent.get(event_date):
            return
        try:
            result = self.late_night_message_callback(event_date)
            if inspect.isawaitable(result):
                result = await result
            if result:
                self._require_scope(epoch_token)
                sent[event_date] = self.world_clock.now().replace(tzinfo=None).isoformat()
                self._save_state()
        except StalePersonaEpoch:
            raise
        except Exception:
            logger.exception("Late-night check-in message failed")

    def _rest_event_date(self, now: datetime) -> str | None:
        sleep_time = _parse_time(getattr(self.persona, "sleep_time", None), "23:00")
        wake_time = _parse_time(getattr(self.persona, "wake_time", None), "09:00")
        for start_date in (now.date(), now.date() - timedelta(days=1)):
            date_str = start_date.isoformat()
            offset = self._sleep_offset_for(date_str, now)
            starts_at = datetime.combine(start_date, sleep_time) + timedelta(minutes=offset)
            wake_date = start_date if sleep_time < wake_time else start_date + timedelta(days=1)
            wakes_at = datetime.combine(wake_date, wake_time)
            if starts_at <= now < wakes_at:
                return date_str
        return None

    def _sleep_offset_for(self, date_str: str, now: datetime) -> int:
        """Persist one nightly early/late-rest variation in local state."""
        variations = self._state.setdefault("sleep_variations", {})
        saved = variations.get(date_str)
        if isinstance(saved, dict):
            try:
                return max(-90, min(150, int(saved.get("offset_minutes", 0))))
            except (TypeError, ValueError):
                return 0

        roll = self.random_func()
        if roll < 0.10:
            offset = -60
            kind = "early_rest"
        elif roll < 0.22:
            offset = 60
            kind = "late_sleep"
        elif roll < 0.28:
            offset = 120
            kind = "very_late_sleep"
        else:
            offset = 0
            kind = "normal"
        variations[date_str] = {
            "offset_minutes": offset,
            "kind": kind,
            "rolled_at": now.isoformat(),
        }
        self._save_state()
        return offset

    def _late_night_for(self, date_str: str, now: datetime) -> bool:
        if not self.feature_settings.late_night_enabled:
            return False

        rolls = self._state.setdefault("late_night_rolls", {})
        roll = rolls.get(date_str)
        if not isinstance(roll, dict):
            probability = self.feature_settings.late_night_probability
            active = self.random_func() < probability
            roll = {
                "active": active,
                "rolled_at": now.isoformat(),
            }
            rolls[date_str] = roll
            self._save_state()
            if active:
                logger.info("Late-night event selected for %s", date_str)
        return bool(roll.get("active"))

    def _load_state(self) -> dict[str, Any]:
        self._require_scope()
        if not self.state_path.exists():
            return {"late_night_rolls": {}, "late_night_messages": {}, "sleep_variations": {}}
        try:
            with open(self.state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data.setdefault("late_night_rolls", {})
                data.setdefault("late_night_messages", {})
                data.setdefault("sleep_variations", {})
                return data
        except Exception:
            logger.exception("Failed to load WorkManager state")
        return {"late_night_rolls": {}, "late_night_messages": {}, "sleep_variations": {}}

    def _save_state(self) -> None:
        if self._state_scope is None:
            atomic_write_json(self.state_path, self._state)
            return
        self._state_scope.commit_bound(
            lambda: atomic_write_json(self.state_path, self._state)
        )

    def _capture_scope(self) -> "PersonaEpochToken | None":
        return self._state_scope.capture() if self._state_scope is not None else None

    def _require_scope(self, token: "PersonaEpochToken | None" = None) -> None:
        if self._state_scope is not None:
            self._state_scope.require_current(token)
