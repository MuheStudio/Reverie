import asyncio
from datetime import datetime, timedelta

from src.chat.proactive import ProactiveChat
from src.chat.reflex import ReflexSystem
from src.chat.scheduler import MessageScheduler
from src.persona.persona_card import default_persona


class BrokenAdapter:
    async def chat(self, *_args, **_kwargs):
        raise ConnectionError("provider unavailable")


class StableEmotion:
    values = {
        "joy": 50.0,
        "calm": 60.0,
        "excitement": 20.0,
        "sadness": 10.0,
        "anger": 5.0,
        "anxiety": 10.0,
        "grievance": 5.0,
        "touched": 15.0,
    }

    def get_dominant(self, count=3):
        return list(self.values.items())[:count]

    def get_mood_label(self):
        return "平静"


def test_reflex_library_has_over_one_hundred_local_phrases(tmp_path) -> None:
    reflex = ReflexSystem(tmp_path / "reflex.sqlite3", persona=default_persona())

    assert reflex.count() >= 150
    phrases = [reflex.choose("timeout") for _ in range(30)]
    assert len(set(phrases)) == 30
    assert all("AI" not in phrase and "语言模型" not in phrase for phrase in phrases)


def test_temporary_busy_status_expires_without_overwriting_user_setting() -> None:
    scheduler = MessageScheduler(status="online")
    scheduler.set_temporary_status("busy", 60)

    assert scheduler.current_status() == "busy"
    assert scheduler.current_status(datetime.now() + timedelta(minutes=2)) == "online"
    assert scheduler.status == "online"


def test_proactive_generation_falls_back_to_local_reflex(tmp_path) -> None:
    reflex = ReflexSystem(tmp_path / "reflex.sqlite3", persona=default_persona())
    proactive = ProactiveChat(
        default_persona(),
        BrokenAdapter(),
        StableEmotion(),
        MessageScheduler(),
        state_path=tmp_path / "proactive.json",
        reflex_system=reflex,
    )

    result = asyncio.run(proactive._generate_message(
        "user_care", {"time": "21:00", "reason": "distress_followup"},
    ))

    assert result is not None
    assert result.messages
    assert result.metadata["local_reflex"] is True
