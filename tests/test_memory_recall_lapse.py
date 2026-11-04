"""Forget probability as a one-turn recall lapse during a conversation.

A lapse never changes a memory row. It needs an enabled layer, an unprotected
memory and an idle period of at least that layer's forget days; a chat turn
skips at most one such memory, and nothing outside a chat turn ever lapses.
"""

from __future__ import annotations

import asyncio
import time

from src.chat.session import ChatSession
from src.config.settings import FeatureSettings, MemorySettings
from src.emotion.system import EmotionSystem
from src.memory.catalog import MemoryCatalog
from src.memory.cognitive_decay import (
    CognitiveDecaySystem,
    conversational_recall,
    conversational_recall_active,
)
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona
from src.relationship.tracker import RelationshipTracker


DAY = 86_400.0
NOW = 2_000_000_000.0


class _Store:
    def __init__(self, catalog: MemoryCatalog | None = None) -> None:
        self.catalog = catalog


def _system(**overrides) -> CognitiveDecaySystem:
    options = dict(long_term_forget_days=90, short_term_forget_days=7,
                   long_term_forget_probability=0.10, short_term_forget_probability=0.05)
    options.update(overrides)
    return CognitiveDecaySystem(_Store(), **options)  # type: ignore[arg-type]


def _row(*, layer: str = "long_term", idle_days: float = 120.0, **fields) -> dict:
    row = {"id": "m1", "text": "事件记忆：一起去看了海边的灯塔", "layer": layer,
           "cognitive_layer": "episodic", "importance": 0.5, "pinned": 0,
           "timestamp": NOW - idle_days * DAY, "last_accessed": None}
    row.update(fields)
    return row


def _draws(monkeypatch, value: float) -> list[float]:
    calls: list[float] = []

    def draw() -> float:
        calls.append(value)
        return value

    monkeypatch.setattr("src.memory.cognitive_decay.random.random", draw)
    return calls


def test_eligible_memory_lapses_below_its_layer_probability(monkeypatch) -> None:
    system = _system()
    _draws(monkeypatch, 0.0)
    assert system.lapses(_row(), now=NOW) is True
    assert system.lapses(_row(layer="short_term", idle_days=7.0), now=NOW) is True

    _draws(monkeypatch, 0.10)
    assert system.lapses(_row(), now=NOW) is False
    _draws(monkeypatch, 0.05)
    assert system.lapses(_row(layer="short_term", idle_days=8.0), now=NOW) is False


def test_memory_inside_its_forget_days_never_draws(monkeypatch) -> None:
    system = _system()
    draws = _draws(monkeypatch, 0.0)

    assert system.lapses(_row(idle_days=89.9), now=NOW) is False
    assert system.lapses(_row(layer="short_term", idle_days=6.9), now=NOW) is False
    assert draws == []


def test_disabled_forgetting_or_layer_never_draws(monkeypatch) -> None:
    draws = _draws(monkeypatch, 0.0)

    assert _system(forgetting_enabled=False).lapses(_row(), now=NOW) is False
    assert _system(long_term_forgetting_enabled=False).lapses(_row(), now=NOW) is False
    assert _system(short_term_forgetting_enabled=False).lapses(
        _row(layer="short_term", idle_days=30.0), now=NOW) is False
    assert draws == []


def test_protected_memories_never_lapse_or_draw(monkeypatch) -> None:
    system = _system()
    draws = _draws(monkeypatch, 0.0)

    for row in (
        _row(layer="permanent"),
        _row(cognitive_layer="procedural"),
        _row(importance=0.9),
        _row(text="事件记忆：用户的生日在冬天"),
        _row(text="事件记忆：我们约定下次一起去海边"),
        _row(pinned=1),
    ):
        assert system.lapses(row, now=NOW) is False
    assert draws == []


def test_last_recall_and_missing_time_decide_the_idle_period(monkeypatch) -> None:
    system = _system()
    draws = _draws(monkeypatch, 0.0)

    assert system.lapses(_row(last_accessed=NOW - 2 * DAY), now=NOW) is False
    assert system.lapses(_row(timestamp=None), now=NOW) is False
    assert system.lapses(_row(timestamp="not a time"), now=NOW) is False
    assert system.lapses(_row(timestamp=float("nan")), now=NOW) is False
    assert draws == []
    assert system.lapses(_row(timestamp=NOW, last_accessed=NOW - 100 * DAY), now=NOW) is True


def test_pinned_memory_is_never_misremembered(monkeypatch, tmp_path) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    truth = "用户一直喜欢玩《明日方舟》这款游戏"
    for memory_id, text, days in (("truth", truth, 120), ("distractor", "用户后来也玩过《异环》这款游戏", 100)):
        catalog.upsert(id=memory_id, text=text, retention_layer="long_term", cognitive_layer="episodic",
                       timestamp=now - days * DAY, importance=0.6, emotions={},
                       embedding_model_version="test:4")
    assert catalog.set_pinned("truth", True) is True
    system = CognitiveDecaySystem(
        _Store(catalog),  # type: ignore[arg-type]
        misremembering_enabled=True,
        long_term_misremember_probability=0.10,
    )
    _draws(monkeypatch, 0.0)
    monkeypatch.setattr("src.memory.cognitive_decay.random.choice", lambda values: values[0])

    rendered, events = system.apply_retrieval_noise(
        [catalog.get("truth")],  # type: ignore[list-item]
        query="我最喜欢玩的游戏是什么",
        distractors=[catalog.get("truth"), catalog.get("distractor")],  # type: ignore[list-item]
    )

    assert rendered == [truth] and events == []
    assert catalog.latest_open_recall_confusion() is None
    catalog.close()


QUERY = "还记得海边灯塔吗"
TEXTS = ("事件记忆：我们在海边灯塔下面拍了很多照片。", "事件记忆：后来在海边灯塔附近吃了烤鱼。")


def _aged_manager(monkeypatch, tmp_path) -> MemoryManager:
    memory = MemoryManager(
        default_persona(),
        MemorySettings(lancedb_path=str(tmp_path / "vectors"), long_term_forget_days=90,
                       long_term_forget_probability=0.10),
        feature_settings=FeatureSettings(autonomous_memory_enabled=False),
    )
    runtime = memory.store.runtime.model_version
    now = time.time()
    for index, text in enumerate(TEXTS):
        memory.store.catalog.upsert(
            id=f"aged-{index}", text=text, retention_layer="long_term", cognitive_layer="episodic",
            timestamp=now - 120 * DAY, importance=0.6, emotions={}, embedding_model_version=runtime,
        )
    monkeypatch.setattr(memory.layers, "search_all", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(memory.layers, "_search_all", lambda *_args, **_kwargs: [])
    return memory


def _aged_order(texts: list[str]) -> list[str]:
    return [text for text in texts if text in TEXTS]


def test_chat_turn_recall_skips_one_old_memory_and_keeps_its_row(monkeypatch, tmp_path) -> None:
    memory = _aged_manager(monkeypatch, tmp_path)
    ranked = _aged_order(memory.search(QUERY, k=4))
    assert sorted(ranked) == sorted(TEXTS)
    first, second = ranked
    rows_before = {row["id"]: dict(row) for row in memory.store.catalog.all()}
    _draws(monkeypatch, 0.0)

    with conversational_recall():
        recalled = memory.retrieve_relevant(QUERY, k=4)

    # Every eligible row would lapse at this draw; only the first one may.
    assert _aged_order(recalled) == [second]
    lapsed_id = next(i for i, row in rows_before.items() if row["text"] == first)
    kept_id = next(i for i, row in rows_before.items() if row["text"] == second)
    lapsed = memory.store.catalog.get(lapsed_id)
    kept = memory.store.catalog.get(kept_id)
    assert lapsed["text"] == first
    assert lapsed["access_count"] == rows_before[lapsed_id]["access_count"]
    assert lapsed["last_accessed"] == rows_before[lapsed_id]["last_accessed"]
    assert kept["access_count"] == rows_before[kept_id]["access_count"] + 1
    assert memory.store.catalog.count() == len(rows_before)
    memory.store.close()


def test_recall_outside_a_chat_turn_never_lapses(monkeypatch, tmp_path) -> None:
    memory = _aged_manager(monkeypatch, tmp_path)
    draws = _draws(monkeypatch, 0.0)

    with conversational_recall():
        assert sorted(_aged_order(memory.search(QUERY, k=4))) == sorted(TEXTS)
        assert sorted(_aged_order(memory.query_recall(QUERY, k=4)["memories"])) == sorted(TEXTS)
        assert sorted(_aged_order(memory.retrieve_relevant(QUERY, k=4, record_access=False))) == sorted(TEXTS)
    assert sorted(_aged_order(memory.retrieve_relevant(QUERY, k=4))) == sorted(TEXTS)
    assert draws == []
    memory.store.close()


class _Reply:
    content = "嗯，我记得。"


class _Adapter:
    async def chat(self, _messages: list[dict], **_kwargs) -> _Reply:
        return _Reply()


class _RecordingMemory:
    def __init__(self) -> None:
        self.conversational: list[bool] = []

    def retrieve_relevant(self, _query: str) -> list[str]:
        self.conversational.append(conversational_recall_active())
        return []

    async def store_interaction(self, *_args, **_kwargs) -> None:
        return None

    def store_fact(self, *_args, **_kwargs) -> str:
        return "fact"


def test_chat_turn_recall_is_conversational_only_for_that_call() -> None:
    memory = _RecordingMemory()
    session = ChatSession(
        persona=default_persona(), adapter=_Adapter(), memory=memory, emotion=EmotionSystem(),
        relationship=RelationshipTracker(), feature_settings=FeatureSettings(emotion_system_enabled=False),
    )

    asyncio.run(session.send_message("还记得海边灯塔吗"))

    assert memory.conversational == [True]
    assert conversational_recall_active() is False
