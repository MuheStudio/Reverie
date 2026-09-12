"""P0 memory lifecycle governance: score separation, budget valve, usage signals.

All tests run offline (embedding unavailable → lexical path dominates, which is
exactly the degraded mode the governance layer must survive).
"""

from __future__ import annotations

import asyncio
import time

import pytest

from src.config.settings import FeatureSettings, MemorySettings
from src.memory.lifecycle_constants import (
    AUTO_REINFORCE_DAILY_CAP,
    PIN_LIMIT,
    REPLY_OVERLAP_THRESHOLD,
    protection_tier_for_text,
)
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona

GOV_ON = dict(memory_lifecycle_governance_enabled=True)
RAW_A = "用户说：我最喜欢的游戏是星穹铁道，每天都上线做任务。"
RAW_B = "用户说：今天买了一个新的游戏手柄，特别开心。"
STORED_A = f"事件记忆：{RAW_A}"
STORED_B = f"事件记忆：{RAW_B}"
QUERY = "还记得我最喜欢的游戏星穹铁道吗"


def _make_manager(tmp_path, *, governance: bool) -> MemoryManager:
    return MemoryManager(
        default_persona(),
        MemorySettings(
            lancedb_path=str(tmp_path / "vectors"),
            memory_lifecycle_governance_enabled=governance,
        ),
        feature_settings=FeatureSettings(autonomous_memory_enabled=False),
    )


def _age_memory(manager: MemoryManager, memory_id: str, days: float) -> None:
    with manager.store.catalog.transaction() as connection:
        connection.execute(
            "UPDATE memory_records SET timestamp=?, last_accessed=? WHERE id=?",
            (time.time() - days * 86400.0, time.time() - days * 86400.0, memory_id),
        )


def _id_by_text(manager: MemoryManager, text: str) -> str:
    row = manager.store.catalog._connection.execute(
        "SELECT id FROM memory_records WHERE text=?", (text,)
    ).fetchone()
    assert row is not None, f"memory not stored: {text[:30]}"
    return str(row["id"])


def test_governance_off_is_stable_and_on_separates_retention_from_ranking(tmp_path) -> None:
    off_manager = _make_manager(tmp_path / "off", governance=False)
    off_manager.store_event_memory(RAW_A, importance=0.8)
    off_manager.store_event_memory(RAW_B, importance=0.8)
    aged_off = _id_by_text(off_manager, STORED_A)
    _age_memory(off_manager, aged_off, days=200.0)
    first = off_manager.retrieve_relevant(QUERY, k=4)
    second = off_manager.retrieve_relevant(QUERY, k=4)
    assert first == second  # legacy path deterministic across runs

    on_manager = _make_manager(tmp_path / "on", governance=True)
    on_manager.store_event_memory(RAW_A, importance=0.8)
    on_manager.store_event_memory(RAW_B, importance=0.8)
    aged_on = _id_by_text(on_manager, STORED_A)
    _age_memory(on_manager, aged_on, days=200.0)

    legacy_rank = next(
        (index for index, text in enumerate(first) if "星穹铁道" in text), 99
    )
    governed = on_manager.retrieve_relevant(QUERY, k=4)
    governed_rank = next(
        (index for index, text in enumerate(governed) if "星穹铁道" in text), 99
    )
    # 拟真保留：旧记忆仍能被召回（资格门+突袭项）；治理开启后原始相关度
    # 主导排名——被衰减压扁的排序证据恢复，名次不得比旧路径更差。
    assert governed_rank < 99
    assert governed_rank <= legacy_rank


async def test_usage_signals_injected_and_reply_overlap(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=True)
    manager.store_event_memory(RAW_A, importance=0.8)
    manager.store_event_memory(RAW_B, importance=0.8)
    memories = manager.retrieve_relevant(QUERY, k=4)
    assert memories  # something injected
    catalog = manager.store.catalog
    await manager.store_interaction(
        "我最喜欢的游戏还记得吗",
        "当然记得，你最喜欢的是星穹铁道呀。",
    )
    scores = catalog.usage_scores_since(time.time() - 60.0)
    injected_ids = {memory_id for memory_id, score in scores.items() if score >= 0.2}
    assert injected_ids, "injected events must be recorded"
    a_id = _id_by_text(manager, STORED_A)
    b_id = _id_by_text(manager, STORED_B)
    # 星穹铁道 only appears in A and the reply → A must out-score B.
    assert scores.get(a_id, 0.0) > scores.get(b_id, 0.0)
    # Pending injection is consumed exactly once; events are append-only.
    await manager.store_interaction("随便聊聊", "好呀。")
    again = catalog.usage_scores_since(time.time() - 60.0)
    assert sum(again.values()) >= sum(scores.values())


def test_pending_injection_ignored_when_governance_off(tmp_path) -> None:
    manager = _make_manager(tmp_path / "off", governance=False)
    manager.store_event_memory(RAW_A, importance=0.8)
    manager.retrieve_relevant(QUERY, k=4)
    assert manager._pending_injection == []


def test_long_term_capture_bar_rises_with_pressure(tmp_path) -> None:
    on_manager = _make_manager(tmp_path / "on", governance=True)
    assert on_manager._long_term_capture_bar() == pytest.approx(0.6)
    filler = "事件记忆：用户说：今天记录了一条很长的日常流水账内容。" + "日常" * 90_000
    on_manager.store_fact(filler, layer="long_term")
    usage = on_manager.store.catalog.layer_char_usage()
    assert usage.get("long_term", 0) > 0.70 * 250_000
    bar = on_manager._long_term_capture_bar()
    assert 0.6 < bar <= 0.95  # pressure raises the bar, capped

    off_manager = _make_manager(tmp_path / "off", governance=False)
    off_manager.store_fact(filler, layer="long_term")
    assert off_manager._long_term_capture_bar() == pytest.approx(0.6)


def test_pin_limit_enforced(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=True)
    ids = [manager.store_fact(f"事件记忆：第{i}条待固定的事实记录内容。") for i in range(PIN_LIMIT + 1)]
    for memory_id in ids[:PIN_LIMIT]:
        assert manager.pin_memory(memory_id)["ok"] is True
    overflow = manager.pin_memory(ids[PIN_LIMIT])
    assert overflow["ok"] is False
    assert manager.store.catalog.count_pinned() == PIN_LIMIT
    assert manager.unpin_memory(ids[0]) is True
    assert manager.pin_memory(ids[PIN_LIMIT])["ok"] is True


def test_usage_event_tombstone_tolerance(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=True)
    catalog = manager.store.catalog
    assert catalog.record_usage_event(
        memory_id="missing_id", signal="injected", weight=1.0
    ) is False
    with pytest.raises(ValueError):
        catalog.record_usage_event(memory_id="x" * 8, signal="bogus", weight=1.0)


def test_protection_tier_set_on_insert(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=True)
    birthday_id = manager.store_fact("事件记忆：用户的生日是5月1日。")
    promise_id = manager.store_fact("事件记忆：用户答应周末一起看电影。")
    plain_id = manager.store_fact("事件记忆：用户今天去了附近的公园散步。")
    catalog = manager.store.catalog
    assert catalog.get(birthday_id)["protection_tier"] == 1
    assert catalog.get(promise_id)["protection_tier"] == 1
    assert catalog.get(plain_id)["protection_tier"] == 0
    assert protection_tier_for_text("这是普通的日常记录") == 0


def test_auto_reinforce_capped_per_day(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=True)
    catalog = manager.store.catalog
    ids = [
        manager.store_fact(f"事件记忆：自动强化测试事实第{i}号，内容各不相同甲乙丙丁。")
        for i in range(AUTO_REINFORCE_DAILY_CAP + 3)
    ]
    now = time.time()
    for memory_id in ids:
        for _ in range(2):
            catalog.record_usage_event(
                memory_id=memory_id,
                signal="reply_overlap",
                weight=1.0,
                created_at=now - 10.0,
            )
    before = {memory_id: catalog.get(memory_id)["importance"] for memory_id in ids}
    summary = asyncio.run(manager.run_maintenance())
    governance = summary["governance"]
    assert governance["enabled"] is True
    assert governance["auto_reinforced"] == AUTO_REINFORCE_DAILY_CAP
    strengthened = [
        memory_id for memory_id in ids
        if catalog.get(memory_id)["importance"] > before[memory_id]
    ]
    assert len(strengthened) == AUTO_REINFORCE_DAILY_CAP
    # The auto path must not masquerade as a manual user confirmation.
    recent_signals = {
        str(row["signal"])
        for row in catalog._connection.execute(
            "SELECT DISTINCT signal FROM memory_usage_events"
        ).fetchall()
    }
    assert "auto_reinforce" in recent_signals
    assert "user_confirmed" not in recent_signals


def test_expire_skips_pinned_and_protected_rows(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=True)
    pinned_id = manager.store_fact("事件记忆：用户今天去了附近的公园散步。")
    protected_id = manager.store_fact("事件记忆：用户的生日是5月1日。")
    ordinary_id = manager.store_fact("事件记忆：用户随口提了一句天气不错。")
    assert manager.pin_memory(pinned_id)["ok"] is True
    cutoff = time.time() + 10
    expired = manager.store.catalog.expire_before(cutoff)
    assert expired >= 1
    assert manager.store.catalog.get(pinned_id)["lifecycle_state"] == "active"
    assert manager.store.catalog.get(protected_id)["lifecycle_state"] == "active"
    assert manager.store.catalog.get(ordinary_id)["lifecycle_state"] == "expired"


def test_governance_off_maintenance_reports_pressure_without_actions(tmp_path) -> None:
    manager = _make_manager(tmp_path, governance=False)
    manager.store_fact("事件记忆：关闭治理时也要能看到压力读数的记录。")
    summary = asyncio.run(manager.run_maintenance())
    governance = summary["governance"]
    assert governance["enabled"] is False
    assert governance["budget"]["pressure"] >= 0.0
    assert "auto_reinforced" not in governance
    assert REPLY_OVERLAP_THRESHOLD > 0  # constants sanity
