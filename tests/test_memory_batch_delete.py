"""Atomic confirmed-memory batch deletion with synthetic catalog records."""

from __future__ import annotations

import hashlib

import pytest
from pydantic import ValidationError

from src.kernel.contracts import (
    COMMAND_PAYLOAD_MODELS,
    MUTATING_COMMAND_NAMES,
    MVP_COMMAND_NAMES,
    CommandEnvelopeV4,
    MemoryDeleteManyPayload,
    PersonaScopeV4,
)
from src.memory.catalog import MemoryCatalog
from src.memory.manager import MemoryManager
from src.memory.versioned_store import VersionedVectorStore
from src.persona.identity import PersonaEpochRegistry, StalePersonaEpoch
from src.persona.persona_card import Persona, default_persona
from src.persona.state_scope import PersonaStateScope
from src.storage.encrypted_sqlite import integrity_errors


@pytest.fixture
def catalog(tmp_path):
    value = MemoryCatalog(tmp_path / "batch-delete.db")
    yield value
    value.close()


def candidate(catalog, fact_key, text):
    return catalog.create_candidate(
        fact_key=fact_key,
        proposed_text=text,
        source_text=text,
        source_type="user_statement",
        source_uri="synthetic:batch-delete",
        source_hash=hashlib.sha256(text.encode()).hexdigest(),
        confidence=1.0,
    )


def confirm(catalog, fact_key, text):
    row = candidate(catalog, fact_key, text)
    return catalog.confirm_candidate(
        row["id"], embedding_model_version="synthetic-batch-delete",
    )["memory"]


def make_memory(catalog, *, index=None, state_scope=None):
    # Exercise the real deletion layers without constructing models, importing
    # a legacy vector store, or seeding unrelated permanent memories.
    store = object.__new__(VersionedVectorStore)
    store.catalog = catalog
    store._sqlite_index = index
    memory = object.__new__(MemoryManager)
    memory.state_scope = state_scope
    memory.store = store
    return memory


def snapshot(catalog):
    return (
        sorted(catalog.all(), key=lambda row: row["id"]),
        catalog.list_candidates(status="all", limit=1000),
    )


class RecordingIndex:
    def __init__(self, catalog, purged_ids, *, fail_id=None):
        self.catalog = catalog
        self.purged_ids = list(purged_ids)
        self.fail_id = fail_id
        self.deleted = []

    def delete(self, memory_id):
        assert not self.catalog._connection.in_transaction
        assert all(self.catalog.get(identifier) is None for identifier in self.purged_ids)
        self.deleted.append(memory_id)
        if memory_id == self.fail_id:
            raise OSError("synthetic disposable index failure")


def envelope(payload):
    return CommandEnvelopeV4(
        request_id="batch_delete_request_01",
        idempotency_key="batch_delete_request_01",
        command="memory:delete_many",
        persona=PersonaScopeV4(persona_id="batch_persona", epoch=1, fingerprint="a" * 64),
        payload=payload,
    )


@pytest.mark.parametrize("payload", [
    {},
    {"memory_ids": []},
    {"memory_ids": [f"fact_{number}" for number in range(101)]},
    {"memory_ids": ["fact_1", "fact_1"]},
    {"memory_ids": ["../fact_1"]},
    {"memory_ids": ["fact 1"]},
    {"memory_ids": ["fact_1\n"]},
    {"memory_ids": ["事实_1"]},
    {"memory_ids": ["_fact_1"]},
    {"memory_ids": ["x" * 129]},
    {"memory_ids": [""]},
    {"memory_ids": [None]},
    {"memory_ids": [True]},
    {"memory_ids": [123]},
    {"memory_ids": "fact_1"},
    {"memory_ids": None},
    {"memory_ids": ("fact_1",)},
    {"memory_ids": ["fact_1"], "confirm": True},
    {"memory_id": "fact_1"},
])
def test_batch_contract_rejects_malformed_selections(payload):
    with pytest.raises(ValidationError):
        MemoryDeleteManyPayload.model_validate(payload)
    with pytest.raises(ValidationError):
        envelope(payload)


def test_batch_contract_preserves_requested_order_and_boundaries():
    single = "A" + "._:-9" * 25 + "xy"
    assert len(single) == 128
    assert envelope({"memory_ids": [single]}).payload == {"memory_ids": [single]}
    selected = [f"fact_{number:03d}" for number in range(100, 0, -1)]
    assert envelope({"memory_ids": selected}).payload == {"memory_ids": selected}
    assert "memory:delete_many" in MVP_COMMAND_NAMES
    assert "memory:delete_many" in MUTATING_COMMAND_NAMES
    assert COMMAND_PAYLOAD_MODELS["memory:delete_many"] is MemoryDeleteManyPayload


@pytest.mark.parametrize("vector_failure", [False, True])
def test_batch_purges_all_revisions_and_evidence_then_cleans_vectors(
    catalog, vector_failure, caplog,
):
    old_first = confirm(catalog, "batch:first", "第一条记忆的旧内容")
    first = confirm(catalog, "batch:first", "第一条记忆的新内容")
    old_second = confirm(catalog, "batch:second", "第二条记忆的旧内容")
    second = confirm(catalog, "batch:second", "第二条记忆的新内容")
    untouched = confirm(catalog, "batch:untouched", "保留的第三条记忆")
    candidate(catalog, "batch:first", "第一条的未决定证据")
    rejected = candidate(catalog, "batch:second", "第二条的已放弃证据")
    catalog.reject_candidate(rejected["id"])
    catalog.set_pinned(second["id"], True)
    purged = [old_first["id"], first["id"], old_second["id"], second["id"]]
    for identifier in purged:
        catalog.mark_embedding(identifier, "synthetic-batch-delete", "synthetic-vectors", 4)
    index = RecordingIndex(catalog, purged, fail_id=purged[0] if vector_failure else None)
    memory = make_memory(catalog, index=index)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.delete_confirmed_memories([second["id"], first["id"]])
    finally:
        catalog._connection.set_trace_callback(None)

    assert result == {
        "ok": True,
        "deleted_ids": [second["id"], first["id"]],
        "purged_revisions": 4,
    }
    assert set(index.deleted) == set(purged) and len(index.deleted) == 4
    assert [row["id"] for row in catalog.all()] == [untouched["id"]]
    assert {row["fact_key"] for row in catalog.list_candidates(status="all")} == {"batch:untouched"}
    assert catalog._connection.execute("SELECT COUNT(*) FROM memory_embeddings").fetchone()[0] == 0
    assert sum(sql.upper() == "BEGIN IMMEDIATE" for sql in statements) == 1
    assert sum(sql.upper() == "COMMIT" for sql in statements) == 1
    if vector_failure:
        assert "sqlite-vec batch lineage deletion failed" in caplog.text


@pytest.mark.parametrize("stale_kind", [
    "missing", "superseded", "deleted", "unconfirmed", "expired", "unkeyed",
])
def test_one_stale_revision_rejects_the_entire_batch_without_writes(catalog, stale_kind):
    first_old = confirm(catalog, "batch:first", "保留的第一条旧修订")
    first = confirm(catalog, "batch:first", "保留的第一条新修订")
    second = confirm(catalog, "batch:second", "保留的第二条")
    target = confirm(catalog, "batch:changed", "可能发生变化的记忆")
    stale_id = target["id"]
    if stale_kind == "missing":
        stale_id = "fact_missing"
    elif stale_kind == "superseded":
        confirm(catalog, "batch:changed", "已经替换过的记忆")
    elif stale_kind == "deleted":
        catalog.delete_fact_lineage("batch:changed")
    else:
        with catalog.transaction() as connection:
            if stale_kind == "unconfirmed":
                connection.execute("UPDATE memory_records SET confirmation_state='observed' WHERE id=?", (stale_id,))
            elif stale_kind == "expired":
                connection.execute("UPDATE memory_records SET lifecycle_state='expired' WHERE id=?", (stale_id,))
            else:
                connection.execute("UPDATE memory_records SET fact_key='' WHERE id=?", (stale_id,))
    before = snapshot(catalog)
    index = RecordingIndex(catalog, [])
    memory = make_memory(catalog, index=index)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.delete_confirmed_memories([first["id"], stale_id, second["id"]])
    finally:
        catalog._connection.set_trace_callback(None)

    assert result["ok"] is False
    assert result["error_code"] == "stale_selection"
    assert result["stale_ids"] == [stale_id]
    assert "deleted_ids" not in result
    assert snapshot(catalog) == before
    assert catalog.get(first_old["id"]) is not None
    assert index.deleted == []
    assert sum(sql.upper() == "BEGIN IMMEDIATE" for sql in statements) == 1
    assert any(sql.upper() == "ROLLBACK" for sql in statements)
    assert not any(sql.lstrip().upper().startswith(("DELETE", "UPDATE", "INSERT")) for sql in statements)


def test_stale_rejection_reports_every_invalid_id_in_request_order(catalog):
    old = confirm(catalog, "batch:first", "旧修订")
    current = confirm(catalog, "batch:first", "新修订")
    other = confirm(catalog, "batch:other", "另一条有效记忆")
    before = snapshot(catalog)

    result = make_memory(catalog).delete_confirmed_memories([
        other["id"], "fact_missing_b", old["id"], current["id"], "fact_missing_a",
    ])

    assert result["error_code"] == "stale_selection"
    assert result["stale_ids"] == ["fact_missing_b", old["id"], "fact_missing_a"]
    assert snapshot(catalog) == before


def test_storage_failure_rolls_back_all_lineages_and_evidence_before_vector_cleanup(catalog):
    first = confirm(catalog, "batch:first", "第一条有效记忆")
    second = confirm(catalog, "batch:second", "第二条有效记忆")
    before = snapshot(catalog)
    with catalog.transaction() as connection:
        connection.execute("""
            CREATE TRIGGER reject_batch_delete BEFORE DELETE ON memory_records
            WHEN OLD.fact_key='batch:second'
            BEGIN SELECT RAISE(ABORT, 'synthetic batch purge failure'); END
        """)
    index = RecordingIndex(catalog, [])

    with pytest.raises(integrity_errors(), match="synthetic batch purge failure"):
        make_memory(catalog, index=index).delete_confirmed_memories([first["id"], second["id"]])

    assert snapshot(catalog) == before
    assert not catalog._connection.in_transaction
    assert index.deleted == []


@pytest.mark.parametrize("selected", [
    [], [f"fact_{number}" for number in range(101)], ["fact_1", "fact_1"],
    ["bad id"], [None], "fact_1",
])
def test_direct_catalog_call_also_rejects_malformed_selection(catalog, selected):
    row = confirm(catalog, "batch:kept", "不能因非法选择而删除的记忆")
    before = snapshot(catalog)
    with pytest.raises(ValueError):
        catalog.delete_confirmed_memories(selected)
    assert snapshot(catalog) == before
    assert catalog.get(row["id"]) is not None


def replacement(persona):
    data = persona.to_dict()
    data["name"] = "Batch Delete Replacement"
    data["identity"]["persona_id"] = "batch_delete_replacement"
    data["identity"]["identity_version"] = 1
    return Persona(**data)


def activate(registry, persona):
    authorization = registry.authorize_update(
        actor="owner", reason="synthetic batch delete scope test", user_confirmed=True,
    )
    registry.activate_update(persona, authorization)


def test_batch_cannot_cross_persona_catalogs_or_use_a_stale_manager(tmp_path):
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    old_scope = PersonaStateScope(original, registry=registry, base_dir=tmp_path / "personas")
    old_module = old_scope.module("memory")
    old_catalog = MemoryCatalog(old_module.file("metadata.db"))
    new_catalog = None
    try:
        old_memory = make_memory(old_catalog, state_scope=old_module)
        old = confirm(old_catalog, "batch:old", "只属于原人格的记忆")
        updated = replacement(original)
        activate(registry, updated)
        new_scope = PersonaStateScope(updated, registry=registry, base_dir=tmp_path / "personas")
        new_module = new_scope.module("memory")
        new_catalog = MemoryCatalog(new_module.file("metadata.db"))
        new_memory = make_memory(new_catalog, state_scope=new_module)
        new = confirm(new_catalog, "batch:new", "只属于新人格的记忆")
        old_before, new_before = snapshot(old_catalog), snapshot(new_catalog)

        rejected = new_memory.delete_confirmed_memories([new["id"], old["id"]])
        assert rejected["error_code"] == "stale_selection"
        assert rejected["stale_ids"] == [old["id"]]
        with pytest.raises(StalePersonaEpoch):
            old_memory.delete_confirmed_memories([old["id"]])
        assert snapshot(old_catalog) == old_before
        assert snapshot(new_catalog) == new_before
        assert old_catalog.path != new_catalog.path
    finally:
        old_catalog.close()
        if new_catalog is not None:
            new_catalog.close()


def test_persona_switch_after_precheck_is_rejected_by_commit_bound(tmp_path, monkeypatch):
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    scope = PersonaStateScope(persona, registry=registry, base_dir=tmp_path / "personas")
    module = scope.module("memory")
    catalog = MemoryCatalog(module.file("metadata.db"))
    try:
        memory = make_memory(catalog, state_scope=module)
        row = confirm(catalog, "batch:race", "切换人格前的记忆")
        before = snapshot(catalog)
        original_precheck = memory._require_current

        def switch_after_precheck():
            original_precheck()
            activate(registry, replacement(persona))

        monkeypatch.setattr(memory, "_require_current", switch_after_precheck)
        with pytest.raises(StalePersonaEpoch):
            memory.delete_confirmed_memories([row["id"]])
        assert snapshot(catalog) == before
    finally:
        catalog.close()
