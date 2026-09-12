"""Entity co-occurrence index — extraction, linking, and retrieval boost tests."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from src.memory.catalog import MemoryCatalog
from src.memory.entity_index import (
    extract_entities,
    entity_boost_candidates,
    index_entities,
)


@pytest.fixture()
def catalog(tmp_path: Path):
    cat = MemoryCatalog(tmp_path / "entity_test.db")
    yield cat
    cat.close()


def _upsert(catalog: MemoryCatalog, mid: str, text: str, **kw) -> None:
    catalog.upsert(
        id=mid,
        text=text,
        retention_layer=kw.get("layer", "long_term"),
        cognitive_layer=kw.get("cognitive", "episodic"),
        timestamp=kw.get("timestamp", time.time()),
        importance=kw.get("importance", 0.6),
        emotions=None,
        embedding_model_version="test:v1",
        event_time=kw.get("event_time"),
    )


# ── Extraction tests ─────────────────────────────────────────────────


def test_extract_chinese_person():
    entities = extract_entities("我的朋友小明今天来了")
    types = {t for t, _ in entities}
    texts = {v for _, v in entities}
    assert "person" in types
    assert "小明" in texts


def test_extract_location():
    entities = extract_entities("我住在上海市")
    types = {t for t, _ in entities}
    texts = {v for _, v in entities}
    assert "location" in types
    assert "上海市" in texts


def test_extract_work_title():
    entities = extract_entities("最近在看《三体》，特别好看")
    types = {t for t, _ in entities}
    texts = {v for _, v in entities}
    assert "work" in types
    assert "三体" in texts


def test_extract_work_verb():
    entities = extract_entities("我在玩星穹铁道")
    types = {t for t, _ in entities}
    texts = {v for _, v in entities}
    assert "work" in types
    assert "星穹铁道" in texts


def test_extract_event():
    entities = extract_entities("下周有个面试")
    types = {t for t, _ in entities}
    texts = {v for _, v in entities}
    assert "event" in types
    assert "面试" in texts


def test_extract_english_person():
    entities = extract_entities("my friend Alice is visiting")
    types = {t for t, _ in entities}
    texts = {v for _, v in entities}
    assert "person" in types
    assert "Alice" in texts


def test_extract_empty_and_long():
    assert extract_entities("") == []
    assert extract_entities("a" * 9000) == []


def test_extract_deduplicates():
    entities = extract_entities("我的朋友小明和我的同学小明一起来了")
    names = [(t, v) for t, v in entities if v == "小明"]
    assert len(names) == 1  # deduplicated by (type, casefold)


def test_extract_trims_to_name():
    """Chinese names are trimmed to 2 chars when followed by verbs."""
    entities = extract_entities("我的朋友小明喜欢去北京市旅行")
    person_texts = {v for t, v in entities if t == "person"}
    assert "小明" in person_texts


# ── Indexing tests ───────────────────────────────────────────────────


def test_index_entities_creates_links(catalog: MemoryCatalog):
    _upsert(catalog, "m1", "我的朋友小明喜欢去北京市旅行")
    # Entities should have been indexed during upsert (person + location + event)
    with catalog._lock:
        entities = catalog._connection.execute(
            "SELECT entity_text, entity_type FROM memory_entities"
        ).fetchall()
        links = catalog._connection.execute(
            "SELECT entity_id, memory_id FROM memory_entity_links"
        ).fetchall()
    entity_texts = {str(row[0]) for row in entities}
    assert "小明" in entity_texts, f"Expected 小明 in {entity_texts}"
    assert "北京市" in entity_texts, f"Expected 北京市 in {entity_texts}"
    assert len(links) >= 2
    assert all(str(row[1]) == "m1" for row in links)


def test_index_entities_upsert_idempotent(catalog: MemoryCatalog):
    # Upsert the same memory twice — entity should appear once
    _upsert(catalog, "m1", "我的朋友小明来了")
    _upsert(catalog, "m1", "我的朋友小明来了")  # re-upsert
    with catalog._lock:
        rows = catalog._connection.execute(
            "SELECT COUNT(*) FROM memory_entities WHERE normalized='小明'"
        ).fetchone()
        entity_count = int(rows[0]) if rows else 0
    assert entity_count == 1, f"Expected 1 entity row for 小明, got {entity_count}"


def test_no_entities_no_crash(catalog: MemoryCatalog):
    _upsert(catalog, "m1", "今天天气不错")
    with catalog._lock:
        links = catalog._connection.execute(
            "SELECT COUNT(*) FROM memory_entity_links WHERE memory_id='m1'"
        ).fetchone()[0]
    assert links == 0


# ── Boost tests ──────────────────────────────────────────────────────


def test_entity_boost_shared_entity(catalog: MemoryCatalog):
    _upsert(catalog, "m1", "我的朋友小明喜欢吃火锅")
    _upsert(catalog, "m2", "我的朋友小明最近搬家了")
    _upsert(catalog, "m3", "今天下雨了，没出门")

    # Debug: verify entities were indexed
    with catalog._lock:
        ents = catalog._connection.execute(
            "SELECT id, entity_text, normalized FROM memory_entities"
        ).fetchall()
        links = catalog._connection.execute(
            "SELECT entity_id, memory_id FROM memory_entity_links"
        ).fetchall()

    # Query entities extracted from the query text
    from src.memory.entity_index import extract_entities
    q_ents = extract_entities("小明最近怎么样")

    with catalog._lock:
        boosts = entity_boost_candidates(
            catalog._connection,
            "小明最近怎么样",
            ["m1", "m2", "m3"],
        )
    # m1 and m2 share entity 小明 with the query; m3 does not
    assert "m1" in boosts and boosts["m1"] > 0, (
        f"boosts={boosts}, q_ents={q_ents}, db_ents={[(r[0],r[1],r[2]) for r in ents]}, "
        f"links={[(r[0],r[1]) for r in links]}"
    )
    assert "m2" in boosts and boosts["m2"] > 0
    assert boosts.get("m3", 0.0) == 0.0


def test_entity_boost_no_query_entities(catalog: MemoryCatalog):
    _upsert(catalog, "m1", "我的朋友小明来了")
    with catalog._lock:
        boosts = entity_boost_candidates(
            catalog._connection,
            "今天心情如何",
            ["m1"],
        )
    assert boosts == {} or boosts.get("m1", 0.0) == 0.0


def test_entity_boost_capped_at_max(catalog: MemoryCatalog):
    # Memory with 3 entities matching query
    _upsert(catalog, "m1", "我的朋友小明在北京市参加了面试")
    with catalog._lock:
        boosts = entity_boost_candidates(
            catalog._connection,
            "小明在北京市面试",
            ["m1"],
        )
    # Cap is 0.08 regardless of how many entities match
    assert boosts.get("m1", 0.0) <= 0.08


def test_entity_boost_empty_candidates(catalog: MemoryCatalog):
    with catalog._lock:
        boosts = entity_boost_candidates(
            catalog._connection,
            "小明",
            [],
        )
    assert boosts == {}
