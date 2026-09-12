"""Shared fixtures for the memory evaluation framework."""

from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Generator

import pytest

from src.memory.catalog import MemoryCatalog


@pytest.fixture()
def catalog_factory(tmp_path: Path):
    """Return a factory that creates a fresh MemoryCatalog per call."""

    created: list[MemoryCatalog] = []

    def _make() -> MemoryCatalog:
        db_path = tmp_path / f"eval_{len(created)}.db"
        cat = MemoryCatalog(db_path)
        created.append(cat)
        return cat

    yield _make

    for cat in created:
        cat.close()


def seed_catalog(catalog: MemoryCatalog, memories: list[dict]) -> list[str]:
    """Populate a catalog with fixture memories; return the generated IDs."""

    ids: list[str] = []
    for i, mem in enumerate(memories):
        text = mem["text"]
        digest = hashlib.sha256(f"{text}:{i}".encode()).hexdigest()[:24]
        memory_id = f"eval_{digest}"
        catalog.upsert(
            id=memory_id,
            text=text,
            retention_layer=mem.get("retention_layer", "long_term"),
            cognitive_layer=mem.get("cognitive_layer", "episodic"),
            timestamp=mem.get("timestamp", time.time()),
            importance=mem.get("importance", 0.5),
            emotions=mem.get("emotions"),
            embedding_model_version="eval:test",
            source_type=mem.get("source_type", "local_interaction"),
            event_time=mem.get("event_time"),
        )
        ids.append(memory_id)
    return ids


def retrieve_texts(catalog: MemoryCatalog, query: str, limit: int = 10) -> list[str]:
    """Run candidate_rows + permanent_candidates retrieval and return texts."""

    seen: dict[str, str] = {}
    for row in catalog.candidate_rows(query, limit=limit):
        rid = str(row["id"])
        if rid not in seen:
            seen[rid] = str(row["text"])
    for row in catalog.permanent_candidates(query, limit=limit):
        rid = str(row["id"])
        if rid not in seen:
            seen[rid] = str(row["text"])
    return list(seen.values())
