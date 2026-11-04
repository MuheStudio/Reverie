"""Keyset pages and literal filtering of the confirmed-memory review list."""

import asyncio
import base64
import hashlib

import pytest
from pydantic import ValidationError

from src.config.settings import FeatureSettings, MemorySettings
from src.kernel.contracts import MemoryListPayload
from src.memory.catalog import MemoryCatalog
from src.memory.manager import MemoryManager, _encode_memory_list_cursor
from src.persona.persona_card import default_persona


def confirm(catalog: MemoryCatalog, text: str, *, created_at: float | None = None) -> str:
    candidate = catalog.create_candidate(
        fact_key="paging:" + hashlib.sha256(text.encode()).hexdigest()[:16],
        proposed_text=text,
        source_text=text,
        source_type="user_statement",
        source_uri="",
        source_hash=hashlib.sha256(text.encode()).hexdigest(),
        confidence=1.0,
    )
    memory_id = str(catalog.confirm_candidate(
        candidate["id"], embedding_model_version="test")["memory"]["id"])
    if created_at is not None:
        with catalog.transaction() as connection:
            connection.execute("UPDATE memory_records SET created_at=?,confirmed_at=? WHERE id=?",
                               (created_at, created_at, memory_id))
    return memory_id


def walk(catalog: MemoryCatalog, *, limit: int, query: str = "", between=None) -> list[list[dict]]:
    pages, after = [], None
    while True:
        rows, after = catalog.list_confirmed_page(limit=limit, after=after, query=query)
        pages.append(rows)
        if after is None:
            return pages
        if between is not None:
            between(len(pages))


def expected_order(catalog: MemoryCatalog, query: str = "") -> list[str]:
    rows = [row for row in catalog.all()
            if row["confirmation_state"] == "confirmed" and row["lifecycle_state"] == "active"
            and query.lower() in row["text"].lower()]
    rows.sort(key=lambda row: (row["confirmed_at"] if row["confirmed_at"] is not None
                               else row["created_at"], row["id"]), reverse=True)
    return [row["id"] for row in rows]


def test_pages_cover_only_current_confirmed_facts_newest_first(tmp_path) -> None:
    catalog = MemoryCatalog(tmp_path / "memory.db")
    ids = [confirm(catalog, f"分页记忆第{n:03d}条", created_at=1000.0 + n) for n in range(250)]
    # Not part of the review list: observed rows, a pending candidate, a
    # superseded revision and an expired fact.
    catalog.upsert(id="observed_1", text="仅观察到的记录", retention_layer="short_term",
                   cognitive_layer="episodic", timestamp=5000.0, importance=0.5,
                   emotions=None, embedding_model_version="test")
    catalog.create_candidate(fact_key="paging:pending", proposed_text="尚未确认的候选",
                             source_text="尚未确认的候选", source_type="user_statement",
                             source_uri="", source_hash="0" * 64, confidence=1.0)
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_records SET lifecycle_state='superseded' WHERE id=?", (ids[10],))
        connection.execute("UPDATE memory_records SET lifecycle_state='expired' WHERE id=?", (ids[20],))

    pages = walk(catalog, limit=100)
    listed = [row["id"] for page in pages for row in page]

    assert [len(page) for page in pages] == [100, 100, 48]
    assert listed == [memory_id for memory_id in reversed(ids) if memory_id not in {ids[10], ids[20]}]
    assert listed == expected_order(catalog)
    catalog.close()


def test_rows_without_a_confirmation_time_fall_back_to_creation(tmp_path) -> None:
    catalog = MemoryCatalog(tmp_path / "memory.db")
    newer = confirm(catalog, "有确认时间的较新记忆", created_at=8000.0)
    legacy = confirm(catalog, "没有确认时间的旧记忆", created_at=7000.0)
    older = confirm(catalog, "有确认时间的较早记忆", created_at=6000.0)
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_records SET confirmed_at=NULL WHERE id=?", (legacy,))

    assert [row["id"] for page in walk(catalog, limit=1) for row in page] == [newer, legacy, older]
    catalog.close()


def test_equal_creation_times_are_ordered_by_id_without_gaps(tmp_path) -> None:
    catalog = MemoryCatalog(tmp_path / "memory.db")
    for n in range(7):
        confirm(catalog, f"同一时刻的记忆{n}", created_at=2000.0)
    confirm(catalog, "更早的记忆", created_at=1999.0)

    pages = walk(catalog, limit=3)
    listed = [row["id"] for page in pages for row in page]

    assert [len(page) for page in pages] == [3, 3, 2]
    assert listed == expected_order(catalog)
    assert len(set(listed)) == 8
    catalog.close()


def test_background_updates_between_pages_do_not_skip_or_repeat(tmp_path) -> None:
    catalog = MemoryCatalog(tmp_path / "memory.db")
    ids = [confirm(catalog, f"后台改动记忆{n:02d}", created_at=3000.0 + n) for n in range(30)]

    def rewrite_updated_at(page_number: int) -> None:
        # Embedding, decay and pinning all rewrite updated_at.
        for memory_id in ids[page_number * 3:page_number * 3 + 6]:
            catalog.mark_embedding(memory_id, "test", "vectors", 4)
            catalog.update_importance(memory_id, 0.2)
            catalog.set_pinned(memory_id, True)

    pages = walk(catalog, limit=10, between=rewrite_updated_at)
    listed = [row["id"] for page in pages for row in page]

    assert listed == list(reversed(ids))
    catalog.close()


def test_filter_is_a_literal_substring_and_pages_within_it(tmp_path) -> None:
    catalog = MemoryCatalog(tmp_path / "memory.db")
    for n in range(9):
        confirm(catalog, f"星图标记·第{n}条", created_at=4000.0 + n)
    confirm(catalog, "OrbitKey 大写的英文", created_at=4100.0)
    confirm(catalog, "百分号 100% 与下划线 a_b", created_at=4101.0)
    confirm(catalog, "百分之百与 axb", created_at=4102.0)
    confirm(catalog, "无关的记忆", created_at=4103.0)

    marked = walk(catalog, limit=4, query="星图标记")
    assert [len(page) for page in marked] == [4, 4, 1]
    assert [row["id"] for page in marked for row in page] == expected_order(catalog, "星图标记")
    assert [row["text"] for row in walk(catalog, limit=10, query="orbitkey")[0]] == ["OrbitKey 大写的英文"]
    assert [row["text"] for row in walk(catalog, limit=10, query="100%")[0]] == ["百分号 100% 与下划线 a_b"]
    assert [row["text"] for row in walk(catalog, limit=10, query="a_b")[0]] == ["百分号 100% 与下划线 a_b"]
    assert walk(catalog, limit=10, query="不存在的词") == [[]]
    catalog.close()


def raw_cursor(body: str) -> str:
    return "v1." + base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")


def manager(tmp_path) -> MemoryManager:
    return MemoryManager(
        default_persona(),
        MemorySettings(lancedb_path=str(tmp_path / "vectors"), sqlite_path=str(tmp_path / "memory.db")),
        feature_settings=FeatureSettings(autonomous_memory_enabled=False),
    )


def test_cursor_is_opaque_bound_to_its_query_and_rejected_when_malformed(tmp_path) -> None:
    memory = manager(tmp_path)
    for n in range(5):
        confirm(memory.store.catalog, f"游标记忆{n}", created_at=5000.0 + n)

    first = memory.list_confirmed_memories_page(limit=2)
    assert first["ok"] is True and first["has_more"] is True and first["query"] == ""
    assert first["next_cursor"].startswith("v1.")
    assert set(first["memories"][0]) >= {"id", "text", "pinned"}
    second = memory.list_confirmed_memories_page(limit=2, cursor=first["next_cursor"])
    third = memory.list_confirmed_memories_page(limit=2, cursor=second["next_cursor"])
    assert [row["text"] for row in first["memories"] + second["memories"] + third["memories"]] == [
        f"游标记忆{n}" for n in (4, 3, 2, 1, 0)]
    assert third["has_more"] is False and third["next_cursor"] is None

    mismatched = memory.list_confirmed_memories_page(limit=2, cursor=first["next_cursor"], query="游标")
    assert mismatched["ok"] is False and mismatched["error_code"] == "invalid_cursor"
    assert mismatched["memories"] == []
    digest = hashlib.sha256(b"").hexdigest()[:16]
    for cursor in ("v1.", "v1.!!!!", "v2." + first["next_cursor"][3:], "v1.bm90LWpzb24",
                   raw_cursor('{"c":Infinity,"i":"fact_x","q":"%s"}' % digest),
                   raw_cursor('{"c":true,"i":"fact_x","q":"%s"}' % digest),
                   raw_cursor('{"c":1.0,"i":"fact_x","q":"%s","x":1}' % digest),
                   _encode_memory_list_cursor((5000.0, "bad id"), "")):
        result = memory.list_confirmed_memories_page(limit=2, cursor=cursor)
        assert result["ok"] is False and result["error_code"] == "invalid_cursor"
    with pytest.raises(ValueError):
        _encode_memory_list_cursor((float("nan"), "fact_x"), "")
    memory.store.close()


def test_payload_contract_bounds_the_new_fields() -> None:
    assert MemoryListPayload.model_validate({}).model_dump() == {"limit": 100, "cursor": None, "query": None}
    assert MemoryListPayload.model_validate({"query": "  星图  "}).query == "星图"
    for bad in ({"limit": 201}, {"limit": 0}, {"query": ""}, {"query": "   "}, {"query": "a\nb"},
                {"query": "x" * 101}, {"cursor": "v1"}, {"cursor": "v1.a b"},
                {"cursor": "v1." + "a" * 510}, {"other": 1}):
        with pytest.raises(ValidationError):
            MemoryListPayload.model_validate(bad)


def test_correction_is_newest_and_deletion_leaves_the_page(tmp_path) -> None:
    memory = manager(tmp_path)
    for n in range(3):
        confirm(memory.store.catalog, f"已有记忆{n}", created_at=1.0 + n)
    candidate = asyncio.run(memory.store_interaction("我叫小夜。", "知道了。"))
    original = memory.confirm_memory_candidate(candidate["id"])["memory"]
    # The original is newest already; make it oldest so the revision has to move.
    with memory.store.catalog.transaction() as connection:
        connection.execute("UPDATE memory_records SET created_at=0.5,confirmed_at=0.5 WHERE id=?",
                           (original["id"],))

    corrected = memory.correct_confirmed_memory(original["id"], "用户姓名：白夜")["memory"]
    page = memory.list_confirmed_memories_page(limit=10)["memories"]
    assert page[0]["id"] == corrected["id"]
    assert original["id"] not in [row["id"] for row in page]

    memory.delete_confirmed_memory(corrected["id"])
    assert [row["text"] for row in memory.list_confirmed_memories_page(limit=10)["memories"]] == [
        "已有记忆2", "已有记忆1", "已有记忆0"]
    memory.store.close()


def test_restored_records_keep_the_same_page_order(tmp_path) -> None:
    source = MemoryCatalog(tmp_path / "source.db")
    for n in range(12):
        confirm(source, f"恢复前的记忆{n}", created_at=6000.0 + n // 3)
    before = [row["id"] for page in walk(source, limit=5) for row in page]

    restored = MemoryCatalog(tmp_path / "restored.db")
    restored.import_records(source.all(), replace=True)
    after = [row["id"] for page in walk(restored, limit=5) for row in page]

    # An import rewrites created_at; the order rests on the kept confirmed_at.
    assert {row["created_at"] for row in restored.all()} != {row["created_at"] for row in source.all()}
    assert after == before and len(after) == 12
    source.close()
    restored.close()
