import numpy as np
import pytest
import sqlite3
from datetime import datetime, timezone

from src.memory.catalog import MemoryCatalog
from src.memory.sqlite_vec_index import SQLiteVecIndex


def add_record(
    catalog: MemoryCatalog,
    memory_id: str,
    text: str,
    *,
    layer: str = "long_term",
    timestamp: float = 100.0,
) -> dict:
    catalog.upsert(
        id=memory_id,
        text=text,
        retention_layer=layer,
        cognitive_layer="semantic",
        timestamp=timestamp,
        importance=0.7,
        emotions={},
        embedding_model_version="test:v1:4",
    )
    row = catalog.get(memory_id)
    assert row is not None
    return row


def test_sqlite_vec_index_is_persistent_and_model_version_isolated(tmp_path) -> None:
    database = tmp_path / "memory.db"
    catalog = MemoryCatalog(database)
    first = add_record(catalog, "first", "first memory")
    second = add_record(catalog, "second", "second memory")
    index = SQLiteVecIndex(database, model_version="test:v1:4", dimensions=4)
    index.upsert(first, np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32))
    index.upsert(second, np.array([0.0, 1.0, 0.0, 0.0], dtype=np.float32))

    result = index.search(np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32), k=2)
    assert [row["id"] for row in result] == ["first", "second"]
    assert result[0]["_distance"] == pytest.approx(0.0)

    index.activate("test:v2:4", 4)
    assert index.search(np.ones(4, dtype=np.float32), k=2) == []
    index.close()

    reopened = SQLiteVecIndex(database, model_version="test:v1:4", dimensions=4)
    assert reopened.search(np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32), k=1)[0]["id"] == "first"
    reopened.close()
    catalog.close()


def test_sqlite_vec_rejects_dimension_drift_and_nonfinite_vectors(tmp_path) -> None:
    database = tmp_path / "memory.db"
    catalog = MemoryCatalog(database)
    row = add_record(catalog, "memory", "memory")
    index = SQLiteVecIndex(database, model_version="test:v1:4", dimensions=4)

    with pytest.raises(ValueError):
        index.upsert(row, [1.0, 2.0])
    with pytest.raises(ValueError):
        index.upsert(row, [1.0, 2.0, 3.0, float("nan")])

    index.close()
    catalog.close()


def test_new_embedding_invalidates_stale_vectors_from_other_models(tmp_path) -> None:
    database = tmp_path / "memory.db"
    catalog = MemoryCatalog(database)
    row = add_record(catalog, "memory", "updated memory")
    index = SQLiteVecIndex(database, model_version="test:v1:4", dimensions=4)
    index.upsert(row, [1.0, 0.0, 0.0, 0.0])

    index.activate("test:v2:4", 4)
    index.upsert(row, [0.0, 1.0, 0.0, 0.0])
    index.activate("test:v1:4", 4)
    assert index.search([1.0, 0.0, 0.0, 0.0], k=1) == []

    index.activate("test:v2:4", 4)
    assert index.search([0.0, 1.0, 0.0, 0.0], k=1)[0]["id"] == "memory"
    index.close()
    catalog.close()


def test_knn_metadata_filter_cannot_be_crowded_out_by_other_layers(tmp_path) -> None:
    database = tmp_path / "memory.db"
    catalog = MemoryCatalog(database)
    short = add_record(catalog, "short", "near but wrong layer", layer="short_term")
    long = add_record(catalog, "long", "slightly farther correct layer", layer="long_term")
    index = SQLiteVecIndex(database, model_version="test:v1:4", dimensions=4)
    index.upsert(short, [1.0, 0.0, 0.0, 0.0])
    index.upsert(long, [0.8, 0.2, 0.0, 0.0])

    result = index.search([1.0, 0.0, 0.0, 0.0], k=1, layers=["long_term"])
    assert [row["id"] for row in result] == ["long"]
    index.close()
    catalog.close()


def test_int8_index_uses_partition_key_and_filters_quarters(tmp_path) -> None:
    database = tmp_path / "memory.db"
    catalog = MemoryCatalog(database)
    q1 = add_record(
        catalog,
        "q1",
        "first quarter",
        timestamp=datetime(2026, 2, 1, tzinfo=timezone.utc).timestamp(),
    )
    q2 = add_record(
        catalog,
        "q2",
        "second quarter",
        timestamp=datetime(2026, 5, 1, tzinfo=timezone.utc).timestamp(),
    )
    index = SQLiteVecIndex(
        database,
        model_version="test:v1:4",
        dimensions=4,
        quantization="int8",
        partitioning=True,
    )
    index.upsert(q1, [1.0, 0.0, 0.0, 0.0])
    index.upsert(q2, [1.0, 0.0, 0.0, 0.0])

    only_q2 = index.search(
        [1.0, 0.0, 0.0, 0.0],
        k=5,
        event_buckets=["2026-Q2"],
    )
    assert [row["id"] for row in only_q2] == ["q2"]
    schema = index._connection.execute(
        "SELECT sql FROM sqlite_master WHERE name=?", (index.table_name,)
    ).fetchone()[0]
    assert "int8[4]" in schema
    assert "event_bucket text partition key" in schema
    index.close()
    catalog.close()


def test_changing_quantization_invalidates_only_rebuildable_vectors(tmp_path) -> None:
    database = tmp_path / "memory.db"
    catalog = MemoryCatalog(database)
    row = add_record(catalog, "memory", "canonical text survives")
    index = SQLiteVecIndex(
        database,
        model_version="test:v1:4",
        dimensions=4,
        quantization="float32",
    )
    index.upsert(row, [1.0, 0.0, 0.0, 0.0])
    old_table = index.table_name
    index.activate("test:v1:4", 4, quantization="int8", partitioning=True)

    assert index.search([1.0, 0.0, 0.0, 0.0], k=1) == []
    assert catalog.get("memory")["text"] == "canonical text survives"
    assert index._connection.execute(
        "SELECT 1 FROM sqlite_master WHERE name=?", (old_table,)
    ).fetchone() is None
    index.upsert(row, [1.0, 0.0, 0.0, 0.0])
    assert index.search([1.0, 0.0, 0.0, 0.0], k=1)[0]["id"] == "memory"
    index.close()
    catalog.close()
