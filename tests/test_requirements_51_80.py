import asyncio
import base64
import io
import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.chat.proactive import ProactiveChat
from src.chat.delivery import ChatDeliveryCoordinator
from src.chat.pending import PendingChatStore
from src.chat.scheduler import MessageScheduler
from src.chat.typo import apply_typos
from src.persona.persona_card import default_persona
from src.persona.speech_habits import SpeechHabitEngine
from src.stickers import StickerManager
from src.timeline import TimelineManager
from src.user import UserManager
from src.web import WebSurfingManager, _is_public_https_url, _parse_feed
from PIL import Image


class StableEmotion:
    def __init__(self) -> None:
        self.values = {
            "joy": 45.0,
            "calm": 55.0,
            "excitement": 35.0,
            "sadness": 35.0,
            "anger": 35.0,
            "anxiety": 35.0,
            "grievance": 35.0,
            "touched": 35.0,
        }

    def get_dominant(self, count: int = 3):
        return sorted(self.values.items(), key=lambda item: item[1], reverse=True)[:count]

    def get_mood_label(self) -> str:
        return "平静"

    def get_intensity(self) -> float:
        return max(self.values.values()) / 100.0


class QueueAdapter:
    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.calls: list[list[dict]] = []

    async def chat(self, messages: list[dict], **_kwargs):
        self.calls.append(messages)
        content = self.responses.pop(0)
        return type("Response", (), {"content": content})()


class DatedMemory:
    def __init__(self, facts: list[str]) -> None:
        self.facts = facts
        self.stored: list[tuple[str, dict]] = []

    def list_event_facts_for_date(self, _date: str, k: int = 12) -> list[str]:
        return self.facts[:k]

    def store_event_memory(self, fact: str, **kwargs) -> str:
        self.stored.append((fact, kwargs))
        return "memory-1"


def test_long_replies_require_real_complexity_or_importance(monkeypatch) -> None:
    scheduler = MessageScheduler()

    assert scheduler.allows_long_reply("哈" * 300) is False
    assert scheduler.allows_long_reply("我在医院，有件重要的事想认真和你商量") is True
    assert scheduler.allows_long_reply(
        "请比较这两个方案的成本、风险和维护难度，并解释为什么这样选择？还有替代计划吗？"
    ) is True

    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.999)
    shaped = scheduler.shape_reply_length("普通闲聊" * 80, allow_long=False)
    assert len(shaped) <= 80


def test_speech_habits_persist_and_emotion_changes_punctuation(tmp_path: Path, monkeypatch) -> None:
    engine = SpeechHabitEngine(default_persona(), data_dir=tmp_path)
    engine.since_catchphrase = engine.MAX_REPLIES_WITHOUT_CATCHPHRASE
    monkeypatch.setattr("src.persona.speech_habits.random.choice", lambda items: items[0])
    monkeypatch.setattr("src.persona.speech_habits.random.random", lambda: 0.0)

    result = engine.apply(
        "今天想和你认真聊聊最近发生的事情，也想听听你真正的想法",
        emotions={"excitement": 90.0},
    )

    assert result.startswith(default_persona().catchphrases[0])
    assert result.endswith("！")
    restored = SpeechHabitEngine(default_persona(), data_dir=tmp_path)
    assert restored.since_catchphrase == 0
    assert restored.usage[default_persona().catchphrases[0]] == 1


def test_chinese_typo_is_light_and_protects_links_and_dates(monkeypatch) -> None:
    monkeypatch.setattr("src.chat.typo.random.random", lambda: 0.0)
    monkeypatch.setattr("src.chat.typo.random.choice", lambda items: items[0])

    changed = apply_typos("我在这里等你", rate=1.0)
    assert changed == "我再这里等你"
    assert apply_typos("https://example.com/2026-07-13", rate=1.0) == "https://example.com/2026-07-13"


def test_retraction_probability_uses_typo_and_emotion_context(monkeypatch) -> None:
    scheduler = MessageScheduler()
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.10)

    assert scheduler.should_retract_message() is False
    assert scheduler.should_retract_message(had_typo=True) is True
    assert scheduler.should_retract_message(emotions={"anxiety": 90.0}) is False


def test_retraction_targets_only_the_changed_bubble(monkeypatch, tmp_path: Path) -> None:
    sent: list[tuple[str, str, dict]] = []
    scheduler = MessageScheduler()
    monkeypatch.setattr(scheduler, "should_retract_message", lambda **_kwargs: True)
    session = SimpleNamespace(scheduler=scheduler, emotion=StableEmotion())
    store = PendingChatStore(tmp_path / "pending.json")
    request_id = "delivery_1"
    store.enqueue(
        "测试",
        request_id=request_id,
        client_id="controller",
        conversation_id="conversation",
        persona_id="persona",
    )
    result = {
        "messages": ["错字气泡", "后续气泡"],
        "clean_messages": ["正确气泡", "后续气泡"],
        "typo_indices": [0],
        "had_typo": True,
    }
    store.mark_ready(request_id, result)

    async def fake_emit(client_id: str, message_type: str, payload: dict) -> bool:
        sent.append((client_id, message_type, payload))
        return True

    async def no_sleep(_seconds: float) -> None:
        return None

    coordinator = ChatDeliveryCoordinator(
        store=store,
        get_session=lambda: session,
        emit=fake_emit,
        sleep=no_sleep,
    )
    asyncio.run(coordinator._maybe_emit_retraction(store.get_item(request_id) or {}, result))
    # A reconnect or duplicate completion cannot emit the correction twice.
    asyncio.run(coordinator._maybe_emit_retraction(store.get_item(request_id) or {}, result))

    retract = next(payload for _, message_type, payload in sent if message_type == "chat:retract")
    assert retract["replacement"] == "正确气泡"
    assert retract["bubble_index"] == 0
    assert retract["request_id"] == request_id
    assert len([item for item in sent if item[1] == "chat:retract"]) == 1
    assert store.get_item(request_id)["retraction_state"] == "completed"


def test_sticker_preferences_learn_only_from_user_actions(tmp_path: Path) -> None:
    user = UserManager(data_dir=tmp_path / "user")
    stickers = StickerManager(user_manager=user, data_dir=tmp_path / "stickers")
    sticker = stickers.collect("猫咪太可爱了哈哈", style_tags=[])

    assert "joy" in sticker.emotions
    assert "猫咪" in sticker.style_tags
    before = dict(user.profile.sticker_preferences)
    stickers.record_use(sticker)
    assert user.profile.sticker_preferences == before

    stickers.record_user_sent(sticker.to_dict())
    assert user.get_sticker_weight("joy") > 1.0
    restored = UserManager(data_dir=tmp_path / "user")
    assert restored.get_sticker_weight("joy") == user.get_sticker_weight("joy")


def test_image_stickers_are_locally_tagged_and_unsafe_formats_are_blocked(tmp_path: Path) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), (255, 240, 100)).save(buffer, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    manager = StickerManager(data_dir=tmp_path)

    sticker = manager.collect("", image_data_url=data_url)

    assert len(sticker.emotions) >= 2
    assert "joy" in sticker.emotions
    with pytest.raises(ValueError):
        manager.collect("bad", image_data_url="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")
    with pytest.raises(ValueError):
        manager.collect(
            "伪装图片",
            image_data_url="data:image/png;base64,"
            + base64.b64encode(b"<script>alert(1)</script>").decode("ascii"),
        )


def test_web_feed_parser_and_ssrf_guards(tmp_path: Path) -> None:
    atom = b"""<?xml version='1.0'?>
    <feed xmlns='http://www.w3.org/2005/Atom'>
      <entry><id>a1</id><title>Game update</title><summary>New local event</summary>
      <published>2026-07-13T10:00:00Z</published><link href='https://news.example/item'/></entry>
    </feed>"""
    entries = _parse_feed(atom, limit=10)
    assert entries[0]["id"] == "a1"
    assert entries[0]["link"] == "https://news.example/item"
    with pytest.raises(ValueError):
        _parse_feed(b"<!DOCTYPE x [<!ENTITY a 'boom'>]><rss></rss>", limit=10)

    assert asyncio.run(_is_public_https_url("http://example.com/feed")) is False
    assert asyncio.run(_is_public_https_url("https://127.0.0.1/feed")) is False
    assert asyncio.run(_is_public_https_url("https://169.254.169.254/latest")) is False

    manager = WebSurfingManager(
        default_persona(),
        data_dir=tmp_path,
        allowed_topics=["游戏更新", "社会热点"],
        feed_sources=[
            {"topic": "游戏更新", "url": "https://example.com/feed"},
            {"topic": "社会热点", "url": "https://example.com/hot"},
            {"topic": "游戏更新", "url": "http://example.com/insecure"},
        ],
    )
    assert manager.allowed_topics == ["游戏更新"]
    assert manager.feed_sources == [{"url": "https://example.com/feed", "topic": "游戏更新", "name": "example.com"}]


def test_proactive_reminders_care_and_state_survive_restart(tmp_path: Path) -> None:
    now = datetime(2026, 7, 13, 12, 0)
    user = UserManager(data_dir=tmp_path / "user")
    user.add_important_date("交稿", "2026-07-14")
    user.save()
    state_path = tmp_path / "proactive.json"
    proactive = ProactiveChat(
        default_persona(),
        QueueAdapter(["记得明天交稿呀"]),
        StableEmotion(),
        user_manager=user,
        state_path=state_path,
    )

    trigger, context = proactive._check_triggers(now)
    assert trigger == "reminder"
    assert context["label"] == "交稿"
    proactive._record_successful_trigger(trigger, context)

    restored = ProactiveChat(
        default_persona(),
        QueueAdapter(["不会重复"]),
        StableEmotion(),
        user_manager=user,
        state_path=state_path,
    )
    assert restored._check_triggers(now) == (None, None)

    restored.mark_user_replied("我今天发烧，很难受")
    restored._last_user_activity = datetime.now() - timedelta(hours=1)
    restored._last_any_triggered = None
    restored._daily_trigger_count.clear()
    care_trigger, care = restored._check_triggers(datetime.now())
    assert care_trigger == "user_care"
    assert care["reason"] == "distress_followup"


def test_timeline_verifies_continuity_and_restores_event_facts(tmp_path: Path, monkeypatch) -> None:
    adapter = QueueAdapter([
        "画稿今天终于完成了",
        json.dumps({"consistent": True, "contradictions": []}, ensure_ascii=False),
    ])
    memory = DatedMemory(["今天继续练习画画，仍处于草稿阶段。"])
    timeline = TimelineManager(
        default_persona(),
        adapter=adapter,
        emotion=StableEmotion(),
        memory=memory,
        data_dir=tmp_path,
    )
    timeline.record_event_fact(
        event_id="drawing",
        title="练习画画",
        fact="今天继续练习画画，仍处于草稿阶段。",
        date="2026-07-13",
    )
    monkeypatch.setattr("src.timeline.random.random", lambda: 0.0)

    post = asyncio.run(timeline.generate_post("afternoon_update", now=datetime(2026, 7, 13, 15, 0)))

    assert post is not None
    assert post.event_id == "drawing"
    assert post.consistency_status == "verified"
    assert post.source_facts
    assert memory.stored and "朋友圈动态" in memory.stored[0][0]

    restored = TimelineManager(default_persona(), data_dir=tmp_path)
    assert restored.get_recent(1)[0].consistency_status == "verified"
    assert restored.list_events()[0].facts[-1].endswith("草稿阶段。")


def test_timeline_contradiction_fails_closed_without_template_only_generation(tmp_path: Path, monkeypatch) -> None:
    adapter = QueueAdapter([
        "画稿已经全部完成啦",
        json.dumps({"consistent": False, "contradictions": ["与草稿阶段矛盾"]}, ensure_ascii=False),
    ])
    timeline = TimelineManager(
        default_persona(),
        adapter=adapter,
        emotion=StableEmotion(),
        memory=DatedMemory(["画稿仍处于草稿阶段。"]),
        data_dir=tmp_path,
    )
    timeline.record_event_fact(event_id="drawing", title="练习画画", fact="画稿仍处于草稿阶段。")
    monkeypatch.setattr("src.timeline.random.random", lambda: 0.0)

    post = asyncio.run(timeline.generate_post("afternoon_update"))

    assert post is not None
    assert post.consistency_status == "grounded_fallback"
    assert "已经全部完成" not in post.content
