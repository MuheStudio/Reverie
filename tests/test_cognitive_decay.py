import asyncio
import time

import pytest

from src.memory.catalog import MemoryCatalog
from src.memory.cognitive_decay import (
    CognitiveDecaySystem,
    FUZZY_RECALL_PREFIX,
)


class CatalogStore:
    def __init__(self, catalog: MemoryCatalog) -> None:
        self.catalog = catalog

    def list_by_layer(self, layer: str, limit: int | None = None) -> list[dict]:
        return self.catalog.list_by_layer(layer, limit)


def add_memory(
    catalog: MemoryCatalog,
    *,
    memory_id: str,
    text: str,
    timestamp: float,
    importance: float = 0.5,
    emotions: dict[str, float] | None = None,
    layer: str = "long_term",
    cognitive_layer: str = "episodic",
) -> None:
    catalog.upsert(
        id=memory_id,
        text=text,
        retention_layer=layer,
        cognitive_layer=cognitive_layer,
        timestamp=timestamp,
        importance=importance,
        emotions=emotions or {},
        embedding_model_version="test:4",
    )


def test_decay_is_non_destructive_and_salient_recalled_memory_last_longer(tmp_path) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    add_memory(
        catalog,
        memory_id="routine",
        text="Routine lunch note",
        timestamp=now - 120 * 86400,
        importance=0.2,
    )
    add_memory(
        catalog,
        memory_id="salient",
        text="An emotionally important promise",
        timestamp=now - 120 * 86400,
        importance=0.85,
        emotions={"touched": 90.0},
    )
    catalog.touch_access(["salient", "salient", "salient"])
    system = CognitiveDecaySystem(CatalogStore(catalog))  # type: ignore[arg-type]

    routine = catalog.get("routine")
    salient = catalog.get("salient")
    assert routine is not None and salient is not None
    assert system.retention(salient, now=now) > system.retention(routine, now=now)

    summary = asyncio.run(system.run_forgetting_cycle())
    assert summary["forgotten"] == 0
    assert catalog.count() == 2
    catalog.close()


def test_fuzzy_recall_is_ephemeral_audited_and_correction_reinforces_truth(
    monkeypatch,
    tmp_path,
) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    truth = "用户一直喜欢玩《明日方舟》这款游戏"
    add_memory(
        catalog,
        memory_id="truth",
        text=truth,
        timestamp=now - 120 * 86400,
        importance=0.6,
    )
    add_memory(
        catalog,
        memory_id="distractor",
        text="用户后来也玩过《异环》这款游戏",
        timestamp=now - 100 * 86400,
        importance=0.5,
    )
    store = CatalogStore(catalog)
    system = CognitiveDecaySystem(
        store,  # type: ignore[arg-type]
        misremembering_enabled=True,
        long_term_misremember_probability=0.01,
    )
    monkeypatch.setattr("src.memory.cognitive_decay.random.random", lambda: 0.0)
    monkeypatch.setattr("src.memory.cognitive_decay.random.choice", lambda values: values[0])

    truth_row = catalog.get("truth")
    distractor_row = catalog.get("distractor")
    assert truth_row is not None and distractor_row is not None
    rendered, events = system.apply_retrieval_noise(
        [truth_row],
        query="我最喜欢玩的游戏是什么",
        distractors=[truth_row, distractor_row],
    )

    assert len(events) == 1
    assert rendered[0].startswith(FUZZY_RECALL_PREFIX)
    assert "异环" in rendered[0]
    assert catalog.get("truth")["text"] == truth
    original_timestamp = catalog.get("truth")["timestamp"]
    original_importance = catalog.get("truth")["importance"]

    assert system.resolve_user_correction("你记错了，我说的是《明日方舟》") is True
    corrected = catalog.get("truth")
    assert corrected["text"] == truth
    assert corrected["timestamp"] == original_timestamp
    assert corrected["importance"] > original_importance
    assert catalog.latest_open_recall_confusion() is None
    catalog.close()


def test_identity_and_procedural_facts_can_never_enter_fuzzy_recall(monkeypatch, tmp_path) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    protected = "用户生日是 1 月 1 日，也喜欢玩《明日方舟》游戏"
    add_memory(
        catalog,
        memory_id="protected",
        text=protected,
        timestamp=now - 300 * 86400,
        importance=0.5,
        cognitive_layer="semantic",
    )
    add_memory(
        catalog,
        memory_id="distractor",
        text="用户玩过《异环》游戏",
        timestamp=now - 200 * 86400,
    )
    system = CognitiveDecaySystem(
        CatalogStore(catalog),  # type: ignore[arg-type]
        misremembering_enabled=True,
        long_term_misremember_probability=0.01,
    )
    monkeypatch.setattr("src.memory.cognitive_decay.random.random", lambda: 0.0)
    rows = catalog.all()

    rendered, events = system.apply_retrieval_noise(
        [catalog.get("protected")],  # type: ignore[list-item]
        query="生日和游戏",
        distractors=rows,
    )

    assert rendered == [protected]
    assert events == []
    catalog.close()


def test_misremember_probability_scales_with_age_between_baseline_and_threshold(
    monkeypatch,
    tmp_path,
) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    add_memory(
        catalog,
        memory_id="young",
        text="用户一直喜欢玩《明日方舟》这款游戏",
        timestamp=now - 95 * 86400,
        importance=0.6,
    )
    add_memory(
        catalog,
        memory_id="middle",
        text="用户后来也玩过《异环》这款游戏",
        timestamp=now - 150 * 86400,
        importance=0.6,
    )
    add_memory(
        catalog,
        memory_id="old",
        text="用户还玩过《终末地》这款游戏",
        timestamp=now - 400 * 86400,
        importance=0.6,
    )
    system = CognitiveDecaySystem(
        CatalogStore(catalog),  # type: ignore[arg-type]
        misremembering_enabled=True,
        long_term_misremembering_enabled=True,
        long_term_forget_days=180,
        long_term_misremember_probability=0.10,
    )
    # baseline day (90): 0.5x -> 0.05
    assert system._row_confusion_probability(catalog.get("young")) == pytest.approx(0.05, rel=0.02)  # type: ignore[arg-type]
    # beyond baseline but below threshold (150 of 180): 0.5 + 0.1 * (60/90) -> 0.5666...
    middle = system._row_confusion_probability(catalog.get("middle"))  # type: ignore[arg-type]
    assert middle == pytest.approx(0.10 * (0.5 + 0.1 * ((150 - 90) / 90)))
    # far past threshold (400): caps at 0.6x -> 0.06, never full configured value
    assert system._row_confusion_probability(catalog.get("old")) == pytest.approx(0.06)  # type: ignore[arg-type]
    catalog.close()


def test_misremember_stays_disabled_before_baseline_and_for_short_term_gate(
    monkeypatch,
    tmp_path,
) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    add_memory(
        catalog,
        memory_id="lt-young",
        text="用户喜欢玩《明日方舟》这款游戏",
        timestamp=now - 80 * 86400,
        importance=0.6,
    )
    add_memory(
        catalog,
        memory_id="st-young",
        text="用户今天吃了牛肉面",
        timestamp=now - 3 * 86400,
        importance=0.6,
        layer="short_term",
    )
    add_memory(
        catalog,
        memory_id="st-old",
        text="用户上周看了《慎重勇者》",
        timestamp=now - 30 * 86400,
        importance=0.6,
        layer="short_term",
    )
    system = CognitiveDecaySystem(
        CatalogStore(catalog),  # type: ignore[arg-type]
        misremembering_enabled=True,
        long_term_misremembering_enabled=True,
        short_term_misremembering_enabled=True,
        long_term_forget_days=90,
        short_term_forget_days=30,
        long_term_misremember_probability=0.10,
        short_term_misremember_probability=0.10,
    )
    # Long-term memory younger than the 90-day baseline cannot be misremembered.
    assert system._row_confusion_probability(catalog.get("lt-young")) == 0.0  # type: ignore[arg-type]
    # Short-term memory younger than the 5-day baseline cannot be misremembered.
    assert system._row_confusion_probability(catalog.get("st-young")) == 0.0  # type: ignore[arg-type]
    # Short-term memory at 30 days: baseline 5, ceiling 30 -> 0.5 + 0.1 * (25/25) = 0.6x
    assert system._row_confusion_probability(catalog.get("st-old")) == pytest.approx(0.06)  # type: ignore[arg-type]
    catalog.close()


def test_misremember_is_disabled_when_forget_threshold_is_below_baseline(
    monkeypatch,
    tmp_path,
) -> None:
    now = time.time()
    catalog = MemoryCatalog(tmp_path / "memory.db")
    add_memory(
        catalog,
        memory_id="lt-old",
        text="用户喜欢玩《明日方舟》这款游戏",
        timestamp=now - 300 * 86400,
        importance=0.6,
    )
    add_memory(
        catalog,
        memory_id="st-old",
        text="用户上周看了《慎重勇者》",
        timestamp=now - 40 * 86400,
        importance=0.6,
        layer="short_term",
    )
    system = CognitiveDecaySystem(
        CatalogStore(catalog),  # type: ignore[arg-type]
        misremembering_enabled=True,
        long_term_misremembering_enabled=True,
        short_term_misremembering_enabled=True,
        # Thresholds below the 90/5-day baselines must forbid misremembering.
        long_term_forget_days=60,
        short_term_forget_days=3,
        long_term_misremember_probability=0.10,
        short_term_misremember_probability=0.10,
    )
    assert system._row_confusion_probability(catalog.get("lt-old")) == 0.0  # type: ignore[arg-type]
    assert system._row_confusion_probability(catalog.get("st-old")) == 0.0  # type: ignore[arg-type]
    catalog.close()
