import asyncio
from datetime import datetime, timedelta
from pathlib import Path

from src.chat.proactive import ProactiveChat
from src.chat.scheduler import MessageScheduler
from src.config.settings import FeatureSettings
from src.persona.persona_card import default_persona
from src.relationship.tracker import RelationshipTracker
from src.work_manager import WorkManager


class FakeDiary:
    def __init__(self) -> None:
        self.missed: list[str] = []
        self.sleep_events: list[tuple[str, bool]] = []

    def record_missed(self, date_str: str) -> None:
        if date_str not in self.missed:
            self.missed.append(date_str)

    async def handle_sleep_event(self, date_str: str, *, late_night_active: bool = False) -> list[str]:
        self.sleep_events.append((date_str, late_night_active))
        return [f"entry:{date_str}"]


class FakeEmotion:
    values: dict[str, float] = {}


def test_work_manager_interval_is_fifteen_minutes() -> None:
    assert WorkManager.CHECK_INTERVAL_SECONDS == 15 * 60


def test_late_night_records_missed_without_sleeping(tmp_path: Path) -> None:
    diary = FakeDiary()
    scheduler = MessageScheduler()
    settings = FeatureSettings(
        diary_enabled=True,
        late_night_enabled=True,
        late_night_probability=0.30,
    )
    manager = WorkManager(
        persona=default_persona(),
        scheduler=scheduler,
        diary=diary,
        feature_settings=settings,
        state_path=tmp_path / "state.json",
        random_func=lambda: 0.0,
    )

    entries = asyncio.run(manager.run_once(datetime(2099, 1, 1, 23, 5)))

    assert entries == []
    assert scheduler.status == "online"
    assert diary.missed == ["2099-01-01"]
    assert diary.sleep_events == []
    assert manager.late_night_active is True


def test_normal_sleep_runs_fixed_diary_event_for_sleep_date(tmp_path: Path) -> None:
    diary = FakeDiary()
    scheduler = MessageScheduler()
    settings = FeatureSettings(
        diary_enabled=True,
        late_night_enabled=True,
        late_night_probability=0.30,
    )
    manager = WorkManager(
        persona=default_persona(),
        scheduler=scheduler,
        diary=diary,
        feature_settings=settings,
        state_path=tmp_path / "state.json",
        random_func=lambda: 0.99,
    )

    entries = asyncio.run(manager.run_once(datetime(2099, 1, 2, 1, 10)))

    assert entries == ["entry:2099-01-01"]
    assert scheduler.status == "sleeping"
    assert diary.missed == []
    assert diary.sleep_events == [("2099-01-01", False)]
    assert manager.late_night_active is False
    assert manager.diary_writing is False


def test_diary_activity_is_true_only_while_generation_is_running(tmp_path: Path) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    class BlockingDiary(FakeDiary):
        async def handle_sleep_event(self, date_str: str, *, late_night_active: bool = False) -> list[str]:
            entered.set()
            await release.wait()
            return await super().handle_sleep_event(date_str, late_night_active=late_night_active)

    async def exercise() -> None:
        manager = WorkManager(
            persona=default_persona(),
            scheduler=MessageScheduler(),
            diary=BlockingDiary(),
            feature_settings=FeatureSettings(
                diary_enabled=True,
                late_night_enabled=False,
            ),
            state_path=tmp_path / "activity.json",
            random_func=lambda: 0.99,
        )
        task = asyncio.create_task(manager.run_once(datetime(2099, 1, 2, 1, 10)))
        await entered.wait()
        assert manager.diary_writing is True
        release.set()
        await task
        assert manager.diary_writing is False

    asyncio.run(exercise())


def test_late_night_roll_is_persisted(tmp_path: Path) -> None:
    state_path = tmp_path / "state.json"
    settings = FeatureSettings(
        diary_enabled=True,
        late_night_enabled=True,
        late_night_probability=0.30,
    )
    first_diary = FakeDiary()
    first = WorkManager(
        persona=default_persona(),
        scheduler=MessageScheduler(),
        diary=first_diary,
        feature_settings=settings,
        state_path=state_path,
        random_func=lambda: 0.0,
    )
    asyncio.run(first.run_once(datetime(2099, 1, 1, 23, 5)))

    second_diary = FakeDiary()
    second = WorkManager(
        persona=default_persona(),
        scheduler=MessageScheduler(),
        diary=second_diary,
        feature_settings=settings,
        state_path=state_path,
        random_func=lambda: 0.99,
    )
    asyncio.run(second.run_once(datetime(2099, 1, 1, 23, 20)))

    assert second.late_night_active is True
    assert second_diary.missed == ["2099-01-01"]
    assert second_diary.sleep_events == []


def test_proactive_can_stop_managing_sleep_status() -> None:
    scheduler = MessageScheduler()
    proactive = ProactiveChat(
        default_persona(),
        adapter=None,
        emotion=FakeEmotion(),
        scheduler=scheduler,
        manage_status=False,
    )

    proactive._update_status()

    assert scheduler.status == "online"


def test_sleep_schedule_allows_early_rest_and_late_sleep(tmp_path: Path) -> None:
    settings = FeatureSettings(diary_enabled=False, late_night_enabled=False)
    early = WorkManager(
        persona=default_persona(),
        scheduler=MessageScheduler(),
        diary=FakeDiary(),
        feature_settings=settings,
        state_path=tmp_path / "early.json",
        random_func=lambda: 0.05,
    )
    late = WorkManager(
        persona=default_persona(),
        scheduler=MessageScheduler(),
        diary=FakeDiary(),
        feature_settings=settings,
        state_path=tmp_path / "late.json",
        random_func=lambda: 0.15,
    )

    assert early._rest_event_date(datetime(2099, 1, 1, 22, 30)) == "2099-01-01"
    assert late._rest_event_date(datetime(2099, 1, 1, 23, 30)) is None
    assert late._rest_event_date(datetime(2099, 1, 2, 0, 30)) == "2099-01-01"


def test_relationship_stage_never_shortens_configured_proactive_cooldown() -> None:
    now = datetime(2099, 1, 1, 18, 0)
    initial = ProactiveChat(
        default_persona(), None, FakeEmotion(),
        relationship=RelationshipTracker(0),
        min_interval_minutes=120,
    )
    enduring = ProactiveChat(
        default_persona(), None, FakeEmotion(),
        relationship=RelationshipTracker(2200),
        min_interval_minutes=120,
    )
    initial._last_any_triggered = now - timedelta(minutes=80)
    enduring._last_any_triggered = now - timedelta(minutes=80)

    assert initial._can_trigger("check", now) is False
    assert enduring._can_trigger("check", now) is False

    initial._last_any_triggered = now - timedelta(minutes=130)
    enduring._last_any_triggered = now - timedelta(minutes=130)

    assert initial._can_trigger("check", now) is False
    assert enduring._can_trigger("check", now) is True


class FakeInterest:
    def __init__(self) -> None:
        self.calls = 0

    def advance_due(self, now):
        self.calls += 1
        class _Grown:
            name = "画画"
            progress = 42.0
        return _Grown()


class FakeMemory:
    def __init__(self) -> None:
        self.facts: list[tuple[str, str, str]] = []

    def store_fact(self, text: str, layer: str = "long_term", *, source_type: str = "local_fact") -> str:
        self.facts.append((text, layer, source_type))
        return f"fact_{len(self.facts)}"


def test_self_growth_advance_writes_long_term_memory(tmp_path: Path) -> None:
    diary = FakeDiary()
    scheduler = MessageScheduler()
    settings = FeatureSettings(
        diary_enabled=False,
        late_night_enabled=False,
        self_growth_from_memory_enabled=True,
    )
    interest = FakeInterest()
    memory = FakeMemory()
    manager = WorkManager(
        persona=default_persona(),
        scheduler=scheduler,
        diary=diary,
        feature_settings=settings,
        state_path=tmp_path / "state.json",
        interest_tracker=interest,  # type: ignore[arg-type]
        memory=memory,  # type: ignore[arg-type]
    )

    asyncio.run(manager.run_once(datetime(2099, 1, 1, 12, 0)))

    assert interest.calls == 1
    assert len(memory.facts) == 1
    text, layer, source = memory.facts[0]
    assert layer == "long_term"
    assert source == "self_growth"
    assert "画画" in text
    assert "42%" in text


def test_self_growth_skips_memory_write_when_disabled(tmp_path: Path) -> None:
    diary = FakeDiary()
    scheduler = MessageScheduler()
    settings = FeatureSettings(
        diary_enabled=False,
        late_night_enabled=False,
        self_growth_from_memory_enabled=False,
    )
    interest = FakeInterest()
    memory = FakeMemory()
    manager = WorkManager(
        persona=default_persona(),
        scheduler=scheduler,
        diary=diary,
        feature_settings=settings,
        state_path=tmp_path / "state.json",
        interest_tracker=interest,  # type: ignore[arg-type]
        memory=memory,  # type: ignore[arg-type]
    )

    asyncio.run(manager.run_once(datetime(2099, 1, 1, 12, 0)))

    assert interest.calls == 1
    assert memory.facts == []
