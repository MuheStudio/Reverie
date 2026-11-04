"""Emotion settings: switching off keeps emotions, switching on never catches up.

enabled, carryover_days and inertia_factor are global settings; persona
snapshots and backups restore values, baseline and time only.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest

from src.backup import LocalBackupManager
from src.bridge import ws_bridge
from src.chat.session import ChatSession
from src.config.settings import EMOTION_PAUSE_INTERVAL_LIMIT, FeatureSettings, _Settings
from src.emotion.system import EmotionSystem
from src.persona.persona_card import default_persona
from src.relationship.tracker import RelationshipTracker

DAY0 = datetime(2026, 10, 1, 12, 0, 0)


class Clock:
    def __init__(self, now: datetime) -> None:
        self.current = now

    def now(self) -> datetime:
        return self.current


def stored(path, joy: float, last_updated: datetime, **extra) -> None:
    path.write_text(json.dumps({"values": {"joy": joy}, "baseline": {}, "last_updated": last_updated.isoformat(),
                                **extra}), encoding="utf-8")


def one_step(value: float, baseline: float, days: int = 3) -> float:
    return value + (baseline - value) * (1.0 / days)


class DummyWebSocket:
    async def send(self, _message: str) -> None:
        return None


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    settings = _Settings()
    clock = Clock(DAY0)
    emotion = EmotionSystem(state_path=tmp_path / "active.json", world_clock=clock)
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", settings)
    monkeypatch.setattr(ws_bridge.bridge_state, "emotion", emotion)
    monkeypatch.setattr(ws_bridge.bridge_state, "session", MagicMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "timeline", None)
    monkeypatch.setattr(ws_bridge.bridge_state, "proactive", None)
    monkeypatch.setattr(ws_bridge.bridge_state, "keepsakes", None)
    monkeypatch.setattr("src.config.settings.CONFIG_FILE", tmp_path / "config.json")
    return settings, emotion, clock


def save(**fields) -> dict:
    return asyncio.run(ws_bridge.handle_settings_update({"section": "personality", **fields}, DummyWebSocket()))


def test_nothing_changes_emotions_while_off(tmp_path) -> None:
    path = tmp_path / "emotion.json"
    stored(path, 90.0, DAY0)
    emotion = EmotionSystem(state_path=path, enabled=False, world_clock=Clock(DAY0 + timedelta(days=3)))

    emotion.apply_daily_carryover(DAY0 + timedelta(days=3))
    emotion.apply_event({"joy": -30})
    emotion.tick()
    emotion.apply_user_silence(12)

    assert emotion.values["joy"] == 90.0
    assert emotion._last_updated == DAY0.isoformat()
    assert json.loads(path.read_text(encoding="utf-8"))["values"]["joy"] == 90.0


def test_the_prompt_still_carries_the_kept_emotion_while_off() -> None:
    class Adapter:
        def __init__(self) -> None:
            self.calls: list[list[dict]] = []

        async def chat(self, messages, **_kwargs):
            self.calls.append(messages)
            return type("Reply", (), {"content": "嗯，我在呢。"})()

    class Memory:
        def retrieve_relevant(self, _query):
            return []

        async def store_interaction(self, *_args, **_kwargs):
            return None

        def store_fact(self, _fact, layer="long_term"):
            return "fact-1"

    emotion = EmotionSystem(values={"anger": 88.0}, enabled=False)
    adapter = Adapter()
    session = ChatSession(persona=default_persona(), adapter=adapter, memory=Memory(), emotion=emotion,
                          relationship=RelationshipTracker(),
                          feature_settings=FeatureSettings(emotion_system_enabled=False))

    asyncio.run(session.send_message("今天过得怎么样？"))

    prompt = json.dumps(adapter.calls[0], ensure_ascii=False)
    assert "=== CURRENT EMOTIONAL STATE ===" in prompt and "anger: 88/100" in prompt
    assert emotion.values["anger"] == 88.0


def test_switching_on_skips_the_off_period_for_every_persona(bridge, tmp_path) -> None:
    settings, active, clock = bridge
    active.apply_event({"joy": 40})
    active._last_updated = DAY0.isoformat()
    kept = active.values["joy"]
    inactive_path = tmp_path / "inactive.json"
    stored(inactive_path, kept, DAY0)

    clock.current = DAY0 + timedelta(days=1)
    assert save(emotion_system_enabled=False)["emotionRuntime"]["enabled"] is False
    assert settings.features.emotion_paused_since == clock.current.isoformat()
    clock.current = DAY0 + timedelta(days=5)
    active.apply_daily_carryover(clock.current)
    assert active.values["joy"] == kept
    assert save(emotion_system_enabled=True)["emotionRuntime"]["enabled"] is True
    assert settings.features.emotion_paused_since == ""
    assert settings.features.emotion_pause_intervals == [
        ((DAY0 + timedelta(days=1)).isoformat(), (DAY0 + timedelta(days=5)).isoformat())]
    assert active.pause_intervals == settings.features.emotion_pause_intervals
    assert active._last_updated == DAY0.isoformat()

    # Only the day before switching off counts, for the mounted persona and
    # for one that was not mounted at the time alike.
    active.apply_daily_carryover(clock.current)
    inactive = EmotionSystem(state_path=inactive_path, defer_startup_writes=True, world_clock=clock,
                             pause_intervals=list(settings.features.emotion_pause_intervals))
    inactive.apply_daily_carryover(clock.current)
    expected = one_step(kept, active.baseline["joy"])
    assert active.values["joy"] == pytest.approx(expected)
    assert inactive.values["joy"] == pytest.approx(expected)
    uncounted = EmotionSystem(state_path=tmp_path / "control.json", defer_startup_writes=True, world_clock=clock)
    uncounted.values["joy"], uncounted._last_updated = kept, DAY0.isoformat()
    uncounted.apply_daily_carryover(clock.current)
    assert uncounted.values["joy"] < expected - 1


def test_only_a_real_switch_changes_the_pause_record(bridge) -> None:
    settings, emotion, clock = bridge
    clock.current = DAY0 + timedelta(days=1)
    save(emotion_system_enabled=False)
    clock.current = DAY0 + timedelta(days=2)
    save(emotion_system_enabled=False, emotion_carryover_days=5)
    assert settings.features.emotion_paused_since == (DAY0 + timedelta(days=1)).isoformat()
    save(emotion_carryover_days=7)
    assert settings.features.emotion_paused_since == (DAY0 + timedelta(days=1)).isoformat()
    assert settings.features.emotion_pause_intervals == []
    save(emotion_system_enabled=True)
    save(emotion_system_enabled=True, emotion_inertia_factor=0.3)
    assert len(settings.features.emotion_pause_intervals) == 1


def test_restart_and_persona_switch_keep_offline_carryover(tmp_path) -> None:
    path = tmp_path / "emotion.json"
    stored(path, 90.0, DAY0)
    later = DAY0 + timedelta(days=2)
    pauses = [((DAY0 - timedelta(days=9)).isoformat(), (DAY0 - timedelta(days=8)).isoformat())]

    restarted = EmotionSystem(state_path=path, defer_startup_writes=True, world_clock=Clock(later),
                              pause_intervals=list(pauses))
    assert restarted._last_updated == DAY0.isoformat() and restarted.values["joy"] == 90.0
    restarted.apply_daily_carryover(later)

    two_days = one_step(one_step(90.0, restarted.baseline["joy"]), restarted.baseline["joy"])
    assert restarted.values["joy"] == pytest.approx(two_days)
    assert restarted.pause_intervals == pauses


def test_snapshots_and_restore_never_override_the_global_parameters(tmp_path) -> None:
    path = tmp_path / "emotion.json"
    stored(path, 77.0, DAY0, enabled=True, carryover_days=3, inertia_factor=0.15)

    emotion = EmotionSystem(state_path=path, enabled=False, carryover_days=5, inertia_factor=0.3,
                            defer_startup_writes=True)
    assert (emotion.enabled, emotion.carryover_days, emotion.inertia_factor) == (False, 5, 0.3)
    assert emotion.values["joy"] == 77.0 and emotion._last_updated == DAY0.isoformat()

    emotion.restore({"values": {"joy": 12.0}, "last_updated": DAY0.isoformat(),
                     "enabled": True, "carryover_days": 1, "inertia_factor": 0.6})
    assert (emotion.enabled, emotion.carryover_days, emotion.inertia_factor) == (False, 5, 0.3)
    assert emotion.values["joy"] == 12.0
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert (saved["enabled"], saved["carryover_days"], saved["inertia_factor"]) == (False, 5, 0.3)


def test_an_older_backup_restores_emotions_but_keeps_the_global_parameters(tmp_path) -> None:
    emotion = EmotionSystem(state_path=tmp_path / "emotion.json", enabled=False, carryover_days=5,
                            inertia_factor=0.3, defer_startup_writes=True)
    manager = LocalBackupManager(memory=MagicMock(), emotion=emotion, relationship=MagicMock(),
                                 diary=MagicMock(), user_manager=MagicMock())
    snapshot = {"emotion": emotion._state_payload()}
    backup = {"emotion": {"values": {"joy": 33.0}, "last_updated": DAY0.isoformat(),
                          "enabled": True, "carryover_days": 1, "inertia_factor": 0.6}}

    target = manager._materialize_nonmemory_target(backup, snapshot)
    emotion.restore(target["emotion"])

    assert (emotion.enabled, emotion.carryover_days, emotion.inertia_factor) == (False, 5, 0.3)
    assert emotion.values["joy"] == 33.0 and emotion._last_updated == DAY0.isoformat()
    assert LocalBackupManager._semantic_matches(target["emotion"], emotion._state_payload(), ("emotion",))


def test_reads_and_saves_report_the_running_emotion(bridge) -> None:
    settings, emotion, _clock = bridge
    result = save(emotion_carryover_days=7, emotion_inertia_factor=0.05)
    assert result["ok"] is True
    assert result["emotionRuntime"] == {"enabled": True, "carryover_days": 7, "inertia_factor": 0.05}
    read = asyncio.run(ws_bridge.handle_settings_get({}, DummyWebSocket()))
    assert read["emotionRuntime"] == result["emotionRuntime"]
    assert (read["features"]["emotion_carryover_days"], read["features"]["emotion_inertia_factor"]) == (7, 0.05)
    # A different running value is reported as it is, not as the saved one.
    emotion.carryover_days = 3
    assert asyncio.run(ws_bridge.handle_settings_get({}, DummyWebSocket()))["emotionRuntime"]["carryover_days"] == 3


def test_a_failed_save_changes_neither_the_settings_nor_the_runtime(bridge, monkeypatch) -> None:
    settings, emotion, clock = bridge
    clock.current = DAY0 + timedelta(days=1)

    def refuse(_staged):
        raise OSError("injected settings write failure")

    monkeypatch.setattr("src.config.settings.write_settings_file", refuse)
    result = save(emotion_system_enabled=False, emotion_carryover_days=7)

    assert result["ok"] is False
    assert settings.features.emotion_system_enabled is True and settings.features.emotion_carryover_days == 3
    assert settings.features.emotion_paused_since == ""
    assert (emotion.enabled, emotion.carryover_days) == (True, 3)


def test_a_malformed_pause_record_is_dropped_without_invalidating_settings() -> None:
    valid = ["2026-10-01T00:00:00", "2026-10-02T00:00:00"]
    settings = _Settings(features={
        "emotion_paused_since": "not a time",
        "emotion_pause_intervals": [["bad", "x"], ["2026-10-03T00:00:00", "2026-10-01T00:00:00"],
                                    ["2026-10-01T00:00:00+08:00", "2026-10-02T00:00:00+08:00"], valid],
        "emotion_carryover_days": 5})
    assert settings.features.emotion_paused_since == ""
    assert settings.features.emotion_pause_intervals == [tuple(valid)]
    assert settings.features.emotion_carryover_days == 5
    many = [[(DAY0 + timedelta(days=n)).isoformat(), (DAY0 + timedelta(days=n, hours=1)).isoformat()]
            for n in range(EMOTION_PAUSE_INTERVAL_LIMIT + 6)]
    kept = FeatureSettings(emotion_pause_intervals=many).emotion_pause_intervals
    assert len(kept) == EMOTION_PAUSE_INTERVAL_LIMIT and kept[0] == tuple(many[6])
