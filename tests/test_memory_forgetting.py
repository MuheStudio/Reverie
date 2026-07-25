import asyncio
import time

from src.memory.forgetting import ForgettingSystem


class FakeStore:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.deleted: list[str] = []

    def list_by_layer(self, layer: str, limit: int | None = None) -> list[dict]:
        rows = [row for row in self.rows if row.get("layer") == layer]
        return rows if limit is None else rows[:limit]

    def delete(self, memory_id: str) -> None:
        self.deleted.append(memory_id)
        self.rows = [row for row in self.rows if row.get("id") != memory_id]

    def add(self, **row) -> None:
        self.rows.append({**row, "timestamp": row.get("timestamp", time.time())})


def test_forgetting_cycle_never_deletes_long_term_memories() -> None:
    now = time.time()
    store = FakeStore([
        {"id": "old-long", "layer": "long_term", "timestamp": now - 61 * 86400, "text": "old"},
        {"id": "new-long", "layer": "long_term", "timestamp": now - 10 * 86400, "text": "new"},
        {"id": "old-short", "layer": "short_term", "timestamp": now - 10 * 86400, "text": "short"},
        {"id": "perm", "layer": "permanent", "timestamp": now - 500 * 86400, "text": "core"},
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        long_term_forget_days=60,
        short_term_forgetting_enabled=False,
        long_term_forget_probability=1.0,
        misremembering_enabled=False,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["forgotten"] == 0
    assert summary["evaluated"] == 2
    assert store.deleted == []


def test_forgetting_cycle_evaluates_enabled_short_term_layer_only() -> None:
    now = time.time()
    store = FakeStore([
        {"id": "old-long", "layer": "long_term", "timestamp": now - 365 * 86400, "text": "old long"},
        {"id": "old-short", "layer": "short_term", "timestamp": now - 2 * 86400, "text": "old short"},
        {"id": "new-short", "layer": "short_term", "timestamp": now - 1, "text": "new short"},
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        long_term_forgetting_enabled=False,
        short_term_forget_days=1,
        short_term_forget_probability=1.0,
        misremembering_enabled=False,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["forgotten"] == 0
    assert summary["evaluated"] == 2
    assert store.deleted == []


def test_maintenance_observation_is_bounded_for_years_of_memories() -> None:
    now = time.time()
    store = FakeStore([
        {
            "id": f"old-{index}",
            "layer": "long_term",
            "timestamp": now - (index + 1) * 86400,
            "text": f"memory {index}",
        }
        for index in range(700)
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        short_term_forgetting_enabled=False,
        misremembering_enabled=False,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["evaluated"] == 512
    assert summary["forgotten"] == 0


def test_forgetting_ignores_rows_without_safe_timestamps() -> None:
    store = FakeStore([
        {"id": "missing-time", "layer": "long_term", "text": "legacy row"},
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        long_term_forget_days=60,
        long_term_forget_probability=1.0,
        misremembering_enabled=False,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["forgotten"] == 0
    assert store.deleted == []


def test_misremembering_ignores_long_term_when_threshold_is_too_short() -> None:
    now = time.time()
    store = FakeStore([
        {"id": "old-long", "layer": "long_term", "timestamp": now - 120 * 86400, "text": "old long"},
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        forgetting_enabled=False,
        long_term_forget_days=89,
        short_term_misremembering_enabled=False,
        long_term_misremember_probability=1.0,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["misremembered"] == 0
    assert store.deleted == []


def test_maintenance_never_confabulates_canonical_memory() -> None:
    now = time.time()
    store = FakeStore([
        {"id": "old-long", "layer": "long_term", "timestamp": now - 120 * 86400, "text": "用户最近开始学画画"},
        {"id": "new-long", "layer": "long_term", "timestamp": now - 2 * 86400, "text": "new long"},
        {"id": "perm", "layer": "permanent", "timestamp": now - 500 * 86400, "text": "core fact"},
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        forgetting_enabled=False,
        long_term_forget_days=120,
        short_term_misremembering_enabled=False,
        long_term_misremember_probability=1.0,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["misremembered"] == 0
    assert store.deleted == []
    assert any(
        row.get("id") == "old-long" and row.get("text") == "用户最近开始学画画"
        for row in store.rows
    )
    assert any(row.get("id") == "new-long" for row in store.rows)
    assert any(row.get("id") == "perm" for row in store.rows)


def test_misremembering_ignores_short_term_when_threshold_is_too_short() -> None:
    now = time.time()
    store = FakeStore([
        {"id": "old-short", "layer": "short_term", "timestamp": now - 10 * 86400, "text": "old short"},
    ])
    forgetting = ForgettingSystem(
        store,  # type: ignore[arg-type]
        forgetting_enabled=False,
        long_term_misremembering_enabled=False,
        short_term_forget_days=4,
        short_term_misremember_probability=1.0,
    )

    summary = asyncio.run(forgetting.run_forgetting_cycle())

    assert summary["misremembered"] == 0
    assert store.deleted == []
