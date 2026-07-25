from datetime import datetime, timedelta
from types import SimpleNamespace

from src.ambient import AmbientPresence
from src.config.settings import FeatureSettings
from src.diary import DiaryEntry
from src.diary.easter_egg import DiaryKeyManager


class FakeDiary:
    def __init__(self) -> None:
        self.entries = {
            "2026-05-01": DiaryEntry(
                date="2026-05-01",
                title="没说出口",
                content="今天确实有点委屈，但我没有想把它变成责怪。",
                mood="upset",
                emotions={"sadness": 72.0, "grievance": 84.0},
                created_at="2026-05-01T23:10:00",
            ),
            "2026-07-15": DiaryEntry(
                date="2026-07-15",
                title="今天",
                content="今天很开心。",
                mood="happy",
                emotions={"joy": 80.0},
                created_at="2026-07-15T23:10:00",
            ),
        }

    def list_entries(self):
        return sorted(self.entries)

    def get_entry_metadata(self, date_str):
        entry = self.entries.get(date_str)
        if entry is None:
            return None
        return {
            "date": entry.date,
            "mood": entry.mood,
            "emotions": entry.emotions,
            "created_at": entry.created_at,
            "is_locked": True,
        }

    def load_entry(self, date_str):
        return self.entries.get(date_str)

    def can_peek(self, **_kwargs):
        return False


def test_diary_key_unlocks_one_old_high_emotion_entry_without_exposing_key(tmp_path) -> None:
    settings = FeatureSettings(
        diary_key_intimacy_threshold=2000,
        diary_key_happy_days=7,
        diary_key_private_emotion_threshold=60,
    )
    database = tmp_path / "world.sqlite3"
    ambient = AmbientPresence(settings, path=database)
    today = datetime(2026, 7, 15, 12, 0)
    for offset in range(7):
        ambient.advance(
            today - timedelta(days=6 - offset),
            emotions={"joy": 80, "sadness": 5, "grievance": 5},
        )
    diary = FakeDiary()
    manager = DiaryKeyManager(
        settings,
        ambient=ambient,
        diary=diary,
        relationship=SimpleNamespace(intimacy=2000),
        path=database,
    )

    state = manager.evaluate(today)
    assert state is not None
    assert state["host_date"] == "2026-07-15"
    decorated = manager.decorate_entries([
        {"date": "2026-07-15", "can_peek": False},
        {"date": "2026-05-01", "can_peek": False},
    ], now=today)
    assert decorated[0]["key_available"] is True
    assert "target_date" not in decorated[0]

    revealed = manager.unlock("2026-07-15", now=today)
    assert revealed["entry"]["date"] == "2026-05-01"
    assert "委屈" in revealed["entry"]["content"]
    assert "master_key" not in str(revealed)

    after = manager.decorate_entries([
        {"date": "2026-05-01", "can_peek": False},
    ], now=today)
    assert after[0]["key_unlocked"] is True
    assert after[0]["can_peek"] is True
