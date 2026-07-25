from datetime import datetime, timedelta
import asyncio

from src.emotion.system import EmotionSystem


def test_emotion_state_persists_and_carries_over(tmp_path) -> None:
    path = tmp_path / "emotion.json"
    emotion = EmotionSystem(state_path=path, carryover_days=3, inertia_factor=0.1)

    emotion.apply_event({"joy": 30, "sadness": 15})
    high_joy = emotion.values["joy"]

    reloaded = EmotionSystem(state_path=path, carryover_days=3, inertia_factor=0.1)
    assert reloaded.values["joy"] == high_joy

    reloaded._last_updated = (datetime.now() - timedelta(days=1)).isoformat()
    reloaded.apply_daily_carryover(datetime.now())

    assert reloaded.values["joy"] < high_joy
    assert reloaded.values["joy"] > reloaded.baseline["joy"]


def test_user_silence_changes_emotion_only_after_threshold() -> None:
    emotion = EmotionSystem()

    assert emotion.apply_user_silence(2) == {}
    changes = emotion.apply_user_silence(8)

    assert changes["sadness"] > 0
    assert changes["grievance"] > 0


def test_all_eight_emotions_coexist_and_roundtrip() -> None:
    emotion = EmotionSystem()
    emotion.apply_event({name: index for index, name in enumerate(emotion.values, start=1)})
    snapshot = emotion.to_dict()

    restored = EmotionSystem()
    restored.restore(snapshot)

    assert set(restored.values) == {
        "joy", "calm", "excitement", "sadness",
        "anger", "anxiety", "grievance", "touched",
    }
    assert restored.values == emotion.values
    assert snapshot["baseline"] == emotion.baseline


def test_memory_context_affects_keyword_fallback() -> None:
    emotion = EmotionSystem()

    changes = asyncio.run(
        emotion.analyze_exchange(
            "嗯",
            "我在",
            adapter=None,
            memories=["事件记忆：那天用户认真说谢谢你一直陪伴我，我很感动"],
        )
    )

    assert changes["touched"] > 0


def test_event_outcome_updates_emotion_state() -> None:
    emotion = EmotionSystem()
    before = emotion.values["joy"]

    changes = emotion.apply_event_outcome(
        "项目完成了",
        explicit_changes={"joy": 9, "anxiety": -4},
    )

    assert changes["joy"] == 9
    assert emotion.values["joy"] == before + 9
