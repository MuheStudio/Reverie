import asyncio
import time

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
