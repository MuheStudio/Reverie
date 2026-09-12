from __future__ import annotations

from datetime import datetime, timedelta

from src.affairs.manager import PersonalAffairManager
from src.work_manager import WorkManager


class RecordingEmotion:
    def __init__(self):
        self.calls = []

    def apply_event_outcome(self, outcome, *, explicit_changes=None):
        self.calls.append((outcome, dict(explicit_changes or {})))
        return dict(explicit_changes or {})


class ExplodingEmotion:
    def apply_event_outcome(self, outcome, *, explicit_changes=None):
        raise RuntimeError("boom")


def make_work_manager(emotion):
    manager = WorkManager.__new__(WorkManager)
    manager.emotion = emotion
    return manager


def test_affair_updates_move_emotions(tmp_path):
    now = datetime(2026, 9, 6, 10, 0)
    affairs = PersonalAffairManager(data_dir=tmp_path / "affairs")
    affair = affairs.create("整理相册", now=now - timedelta(hours=2))
    emotion = RecordingEmotion()
    manager = make_work_manager(emotion)

    affair.progress = 95.0
    affairs._affairs[affair.id].next_update_at = (now - timedelta(minutes=5)).isoformat()
    updates = affairs.advance_due(now)
    assert updates and updates[0]["status"] == "completed"

    manager._apply_affair_emotion_outcomes(updates)
    assert len(emotion.calls) == 1
    outcome, changes = emotion.calls[0]
    assert "整理相册" in outcome
    assert changes == {"joy": 8.0}


def test_in_progress_affair_moves_emotions_gently(tmp_path):
    now = datetime(2026, 9, 6, 10, 0)
    affairs = PersonalAffairManager(data_dir=tmp_path / "affairs")
    affair = affairs.create("练琴", now=now - timedelta(hours=2))
    affairs._affairs[affair.id].next_update_at = (now - timedelta(minutes=5)).isoformat()
    updates = affairs.advance_due(now)
    assert updates and updates[0]["status"] == "in_progress"

    emotion = RecordingEmotion()
    make_work_manager(emotion)._apply_affair_emotion_outcomes(updates)
    assert emotion.calls[0][1] == {"joy": 3.0}


def test_missing_or_failing_emotion_never_breaks_the_loop(tmp_path):
    updates = [{"title": "整理相册", "status": "completed"}]

    make_work_manager(None)._apply_affair_emotion_outcomes(updates)
    make_work_manager(RecordingEmotion())._apply_affair_emotion_outcomes([])
    make_work_manager(ExplodingEmotion())._apply_affair_emotion_outcomes(updates)
    make_work_manager(RecordingEmotion())._apply_affair_emotion_outcomes(["junk", None])
