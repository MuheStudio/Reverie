"""Atomic batch candidate decisions and read-only previews on synthetic catalogs."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from src.kernel.contracts import (
    COMMAND_PAYLOAD_MODELS,
    MUTATING_COMMAND_NAMES,
    MVP_COMMAND_NAMES,
    CommandEnvelopeV4,
    MemoryCandidateDecideManyPayload,
    MemoryCandidateStatusPayload,
    PersonaScopeV4,
)
from src.memory.catalog import MemoryCatalog
from src.memory.manager import MemoryManager
from src.memory.versioned_store import VersionedVectorStore
from src.persona.identity import PersonaEpochRegistry, StalePersonaEpoch
from src.persona.persona_card import Persona, default_persona
from src.persona.state_scope import PersonaStateScope
from src.storage.encrypted_sqlite import integrity_errors


VALID = "mc_" + "a" * 32
BAD_SELECTIONS = [
    pytest.param([], id="empty"),
    pytest.param([f"mc_{n:032x}" for n in range(101)], id="over-100"),
    pytest.param([VALID, VALID], id="duplicate"),
    pytest.param(["mc_" + "a" * 31], id="short-hex"),
    pytest.param(["mc_" + "a" * 33], id="long-hex"),
    pytest.param(["mc_" + "A" * 32], id="upper-hex"),
    pytest.param(["mc_" + "g" * 32], id="non-hex"),
    pytest.param(["fact_" + "a" * 32], id="memory-id"),
    pytest.param([VALID + "\n"], id="newline"),
    pytest.param([""], id="blank"),
    pytest.param([None], id="null-id"),
    pytest.param([True], id="bool-id"),
    pytest.param([123], id="int-id"),
    pytest.param([VALID.encode()], id="bytes-id"),
    pytest.param([[VALID]], id="nested-list"),
    pytest.param([{"id": VALID}], id="object-id"),
    pytest.param(VALID, id="string-selection"),
    pytest.param(None, id="null-selection"),
    pytest.param((VALID,), id="tuple-selection"),
    pytest.param({VALID}, id="set-selection"),
]
BAD_DECISIONS = [
    pytest.param(None, id="null"),
    pytest.param("", id="blank"),
    pytest.param("Confirm", id="capitalized"),
    pytest.param("accept", id="other-word"),
    pytest.param("confirm ", id="trailing-space"),
    pytest.param(True, id="bool"),
    pytest.param(1, id="int"),
    pytest.param(["confirm"], id="list"),
    pytest.param({}, id="object"),
]
PREVIEW_KEYS = {"pending_ids", "stale_ids", "new_ids", "replace_ids", "same_ids",
                "replaced_pinned_ids", "conflict_groups"}


@pytest.fixture
def catalog(tmp_path):
    value = MemoryCatalog(tmp_path / "candidate-batch.db")
    yield value
    value.close()


def candidate(catalog, key, text=None, *, source_id="initial"):
    """Keep source identity deterministic, including for separate evidence of the same text."""
    text = text or f"Synthetic candidate {key}"
    source_uri = f"synthetic:candidate-batch:{source_id}"
    return catalog.create_candidate(
        fact_key=key, proposed_text=text, source_text=text,
        source_type="user_statement", source_uri=source_uri,
        source_hash=hashlib.sha256(f"{source_uri}\0{text}".encode()).hexdigest(), confidence=1.0,
    )["id"]


def confirmed(catalog, key, text=None):
    return catalog.confirm_candidate(
        candidate(catalog, key, text), embedding_model_version="synthetic-candidate-batch",
    )["memory"]


def make_memory(catalog, *, state_scope=None):
    # Use the real manager/catalog boundary without starting models or workers.
    store = object.__new__(VersionedVectorStore)
    store.catalog = catalog
    store.runtime = SimpleNamespace(model_version="synthetic-candidate-batch")
    memory = object.__new__(MemoryManager)
    memory.store = store
    memory.state_scope = state_scope
    memory._last_memory_activity_at = 123.0
    return memory


def snapshot(catalog):
    tables = catalog._connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).fetchall()
    return {
        row["name"]: sorted(
            [tuple(value) for value in catalog._connection.execute(
                'SELECT * FROM "' + row["name"].replace('"', '""') + '"',
            ).fetchall()], key=repr,
        )
        for row in tables
    }


def envelope(command, payload):
    return CommandEnvelopeV4(
        request_id="candidate_batch_request_01", idempotency_key="candidate_batch_request_01",
        command=command,
        persona=PersonaScopeV4(persona_id="batch_persona", epoch=1, fingerprint="a" * 64),
        payload=payload,
    )


@pytest.mark.parametrize("selected", BAD_SELECTIONS)
def test_payloads_and_envelopes_reject_malformed_selections(selected):
    for command, model, extra in (
        ("memory:candidates:status", MemoryCandidateStatusPayload, {}),
        ("memory:candidates:decide_many", MemoryCandidateDecideManyPayload, {"decision": "confirm"}),
    ):
        payload = {"candidate_ids": selected, **extra}
        with pytest.raises(ValidationError):
            model.model_validate(payload)
        with pytest.raises(ValidationError):
            envelope(command, payload)


@pytest.mark.parametrize("selected", BAD_SELECTIONS)
def test_catalog_rejects_malformed_selections_without_sql(catalog, selected):
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        with pytest.raises(ValueError):
            catalog.candidate_status(selected)
        with pytest.raises(ValueError):
            catalog.decide_candidates(selected, "confirm", embedding_model_version="v")
    finally:
        catalog._connection.set_trace_callback(None)
    assert statements == []


@pytest.mark.parametrize("decision", BAD_DECISIONS)
def test_decision_must_be_exactly_confirm_or_reject(catalog, decision):
    payload = {"candidate_ids": [VALID], "decision": decision}
    with pytest.raises(ValidationError):
        MemoryCandidateDecideManyPayload.model_validate(payload)
    with pytest.raises(ValidationError):
        envelope("memory:candidates:decide_many", payload)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        with pytest.raises(ValueError):
            catalog.decide_candidates([VALID], decision, embedding_model_version="v")
    finally:
        catalog._connection.set_trace_callback(None)
    assert statements == []


@pytest.mark.parametrize("command,payload", [
    ("memory:candidates:status", {}),
    ("memory:candidates:status", {"candidate_ids": [VALID], "decision": "confirm"}),
    ("memory:candidates:status", {"candidate_ids": [VALID], "confirm": True}),
    ("memory:candidates:decide_many", {"candidate_ids": [VALID]}),
    ("memory:candidates:decide_many", {"candidate_ids": [VALID], "decision": "reject", "confirm": True}),
], ids=["status-empty", "status-extra-decision", "status-extra-confirm", "decide-missing-decision", "decide-extra-confirm"])
def test_missing_and_extra_fields_are_rejected(command, payload):
    with pytest.raises(ValidationError):
        COMMAND_PAYLOAD_MODELS[command].model_validate(payload)


def test_payload_boundaries_and_mutation_classification():
    ids = [f"mc_{n:032x}" for n in range(100, 0, -1)]
    assert MemoryCandidateStatusPayload.model_validate({"candidate_ids": ids}).candidate_ids == ids
    for decision in ("confirm", "reject"):
        model = MemoryCandidateDecideManyPayload.model_validate({"candidate_ids": ids, "decision": decision})
        assert model.candidate_ids == ids and model.decision == decision
    assert {"memory:candidates:status", "memory:candidates:decide_many"} <= MVP_COMMAND_NAMES
    assert "memory:candidates:status" not in MUTATING_COMMAND_NAMES
    assert "memory:candidates:decide_many" in MUTATING_COMMAND_NAMES
    assert COMMAND_PAYLOAD_MODELS["memory:candidates:status"] is MemoryCandidateStatusPayload
    assert COMMAND_PAYLOAD_MODELS["memory:candidates:decide_many"] is MemoryCandidateDecideManyPayload


def test_status_is_one_read_only_snapshot_without_bodies(catalog, monkeypatch):
    fresh = candidate(catalog, "c:new", "Private new body")
    confirmed(catalog, "c:replace", "Private old body")
    replace = candidate(catalog, "c:replace", "Private replacement body")
    confirmed(catalog, "c:same", "Private same body")
    same = candidate(catalog, "c:same", "Private same body", source_id="same-followup")
    done = candidate(catalog, "c:done")
    catalog.confirm_candidate(done, embedding_model_version="v")
    rejected = candidate(catalog, "c:rejected")
    catalog.reject_candidate(rejected)
    missing = "mc_" + "f" * 32
    memory = make_memory(catalog)
    selected = [replace, missing, fresh, done, same, rejected]
    before = snapshot(catalog)
    statements = []
    monkeypatch.setattr("src.memory.catalog.time.time", lambda: pytest.fail("preview read the clock"))
    catalog._connection.execute("PRAGMA query_only=ON")
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.memory_candidate_status(selected)
    finally:
        catalog._connection.set_trace_callback(None)
        catalog._connection.execute("PRAGMA query_only=OFF")
    assert result == {
        "ok": True, "candidate_ids": selected,
        "states": [{"candidate_id": replace, "status": "pending"}, {"candidate_id": fresh, "status": "pending"},
                   {"candidate_id": done, "status": "confirmed"}, {"candidate_id": same, "status": "pending"},
                   {"candidate_id": rejected, "status": "rejected"}],
        "pending_ids": [replace, fresh, same], "stale_ids": [missing, done, rejected],
        "new_ids": [fresh], "replace_ids": [replace], "same_ids": [same],
        "replaced_pinned_ids": [], "conflict_groups": [],
    }
    assert "Private" not in repr(result)
    assert len(statements) == 1 and statements[0].lstrip().upper().startswith("WITH ")
    assert snapshot(catalog) == before
    assert memory._last_memory_activity_at == 123.0
    assert not catalog._connection.in_transaction


def test_status_reports_same_fact_groups_and_replaced_pins(catalog):
    old = confirmed(catalog, "c:pinned")
    catalog.set_pinned(old["id"], True)
    pinned_replace = candidate(catalog, "c:pinned", "Replacement for a pinned fact")
    first = candidate(catalog, "c:shared", "First wording")
    other = candidate(catalog, "c:solo")
    second = candidate(catalog, "c:shared", "Second wording")
    third = candidate(catalog, "c:shared", "Third wording")
    result = make_memory(catalog).memory_candidate_status([pinned_replace, first, other, second, third])
    assert result["replace_ids"] == [pinned_replace]
    assert result["replaced_pinned_ids"] == [pinned_replace]
    assert result["conflict_groups"] == [[first, second, third]]
    assert result["new_ids"] == [first, other, second, third] and result["stale_ids"] == []


@pytest.mark.parametrize("count", [1, 100], ids=["one", "hundred"])
def test_boundary_selections_keep_request_order(catalog, count):
    selected = [candidate(catalog, f"c:boundary:{n}") for n in range(count)][::-1]
    status = make_memory(catalog).memory_candidate_status(selected)
    assert status["candidate_ids"] == status["pending_ids"] == status["new_ids"] == selected
    result = make_memory(catalog).decide_memory_candidates(selected, "reject")
    assert result == {"ok": True, "candidate_ids": selected, "decision": "reject", "rejected_ids": selected}
    assert [row["status"] for row in catalog.list_candidates(status="rejected", limit=200)] == ["rejected"] * count


def build_pair(tmp_path, name):
    """Two identical catalogs: one decided one by one, one decided as a batch."""
    catalogs = []
    for side in ("single", "batch"):
        catalog = MemoryCatalog(tmp_path / f"{name}-{side}.db")
        ids = {}
        old = confirmed(catalog, "eq:replace", "Original wording")
        catalog.set_pinned(old["id"], True)
        confirmed(catalog, "eq:same", "Unchanged wording")
        ids["replace"] = candidate(catalog, "eq:replace", "Revised wording")
        ids["new"] = candidate(catalog, "eq:new", "Brand new wording")
        ids["same"] = candidate(catalog, "eq:same", "Unchanged wording", source_id="same-followup")
        catalogs.append((catalog, ids))
    return catalogs


def decision_tables(catalog):
    return {name: rows for name, rows in snapshot(catalog).items()
            if name in {"memory_records", "memory_candidates", "memory_references"}}


@pytest.mark.parametrize("decision", ["confirm", "reject"])
def test_batch_matches_single_decisions_exactly(tmp_path, monkeypatch, decision):
    # One clock for setup and decisions, so both catalogs differ only by path.
    monkeypatch.setattr("src.memory.catalog.time.time", lambda: 1_000_000.0)
    (single, ids), (batch, batch_ids) = build_pair(tmp_path, decision)
    assert ids == batch_ids
    try:
        order = [ids["replace"], ids["new"], ids["same"]]
        for candidate_id in order:
            if decision == "confirm":
                make_memory(single).confirm_memory_candidate(candidate_id)
            else:
                make_memory(single).reject_memory_candidate(candidate_id)
        memory = make_memory(batch)
        result = memory.decide_memory_candidates(order, decision)
        assert decision_tables(batch) == decision_tables(single)
        assert len(decision_tables(batch)) == 3
        if decision == "confirm":
            replaced = [row for row in batch.all() if row["lifecycle_state"] == "superseded"]
            assert len(replaced) == 1 and replaced[0]["pinned"] == 1
            assert result["new_ids"] == [ids["new"]] and result["replace_ids"] == [ids["replace"]]
            assert result["same_ids"] == [ids["same"]] and result["replaced_pinned_ids"] == [ids["replace"]]
            assert [entry["candidate_id"] for entry in result["confirmed"]] == order
            assert result["confirmed"][0]["replaced_memory_id"] == replaced[0]["id"]
            assert [entry["idempotent"] for entry in result["confirmed"]] == [False, False, True]
            assert memory._last_memory_activity_at != 123.0
        else:
            assert result["rejected_ids"] == order and memory._last_memory_activity_at == 123.0
    finally:
        single.close()
        batch.close()


def test_replacing_a_pinned_fact_leaves_the_new_revision_unpinned(catalog):
    old = confirmed(catalog, "c:pin-kept", "Pinned original")
    catalog.set_pinned(old["id"], True)
    replace = candidate(catalog, "c:pin-kept", "Unpinned replacement")
    result = make_memory(catalog).decide_memory_candidates([replace], "confirm")
    new = catalog.get(result["confirmed"][0]["memory_id"])
    assert result["replaced_pinned_ids"] == [replace]
    assert new["pinned"] == 0 and new["supersedes_id"] == old["id"] and new["fact_revision"] == 2
    assert catalog.get(old["id"])["lifecycle_state"] == "superseded"


def test_same_fact_selection_rejects_confirmation_but_allows_rejection(catalog):
    first = candidate(catalog, "c:twice", "One wording")
    second = candidate(catalog, "c:twice", "Another wording")
    before = snapshot(catalog)
    memory = make_memory(catalog)
    result = memory.decide_memory_candidates([first, second], "confirm")
    assert result == {"ok": False, "error_code": "fact_conflict",
                      "error": "Selected candidates share a fact; no candidates were decided",
                      "conflict_groups": [[first, second]]}
    assert snapshot(catalog) == before and memory._last_memory_activity_at == 123.0
    rejected = memory.decide_memory_candidates([first, second], "reject")
    assert rejected["rejected_ids"] == [first, second]


@pytest.mark.parametrize("decision", ["confirm", "reject"])
@pytest.mark.parametrize("stale", ["missing", "confirmed", "rejected"])
def test_any_non_pending_candidate_rejects_the_whole_batch(catalog, decision, stale):
    pending = candidate(catalog, "c:pending")
    other = candidate(catalog, "c:other")
    if stale == "missing":
        target = "mc_" + "e" * 32
    else:
        target = candidate(catalog, "c:target")
        if stale == "confirmed":
            catalog.confirm_candidate(target, embedding_model_version="v")
        else:
            catalog.reject_candidate(target)
    before = snapshot(catalog)
    result = make_memory(catalog).decide_memory_candidates([pending, target, other], decision)
    assert result["ok"] is False and result["error_code"] == "stale_selection"
    assert result["stale_ids"] == [target]
    assert snapshot(catalog) == before


def test_stale_selection_takes_precedence_over_fact_conflict(catalog):
    first = candidate(catalog, "c:dup")
    second = candidate(catalog, "c:dup", "Second dup")
    result = make_memory(catalog).decide_memory_candidates([first, "mc_" + "d" * 32, second], "confirm")
    assert result["error_code"] == "stale_selection"


@pytest.mark.parametrize("decision", ["confirm", "reject"])
def test_storage_failure_rolls_back_the_entire_batch(catalog, decision):
    ids = [candidate(catalog, f"c:rollback:{n}") for n in range(3)]
    with catalog.transaction() as connection:
        connection.execute("""
            CREATE TRIGGER reject_candidate_batch BEFORE UPDATE OF status ON memory_candidates
            WHEN OLD.fact_key='c:rollback:2'
            BEGIN SELECT RAISE(ABORT, 'synthetic candidate batch failure'); END
        """)
    before = snapshot(catalog)
    with pytest.raises(integrity_errors(), match="synthetic candidate batch failure"):
        make_memory(catalog).decide_memory_candidates(ids, decision)
    assert snapshot(catalog) == before
    assert not catalog._connection.in_transaction


def test_durable_commit_exception_propagates_without_safe_rejection(catalog, monkeypatch):
    target = candidate(catalog, "c:commit-unknown")
    transaction = catalog.transaction

    @contextmanager
    def committed_then_failed():
        with transaction() as connection:
            yield connection
        raise OSError("synthetic commit acknowledgement lost")

    monkeypatch.setattr(catalog, "transaction", committed_then_failed)
    with pytest.raises(OSError, match="commit acknowledgement lost"):
        make_memory(catalog).decide_memory_candidates([target], "confirm")
    assert catalog.list_candidates(status="confirmed")[0]["id"] == target


def replacement(persona):
    data = persona.to_dict()
    data["name"] = "Candidate Batch Replacement"
    data["identity"]["persona_id"] = "candidate_batch_replacement"
    data["identity"]["identity_version"] = 1
    return Persona(**data)


def activate(registry, persona):
    authorization = registry.authorize_update(
        actor="owner", reason="synthetic candidate batch scope test", user_confirmed=True,
    )
    registry.activate_update(persona, authorization)


def test_candidate_commands_cannot_cross_personas_or_use_a_stale_manager(tmp_path):
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    old_scope = PersonaStateScope(persona, registry=registry, base_dir=tmp_path / "personas").module("memory")
    old_catalog = MemoryCatalog(old_scope.file("metadata.db"))
    new_catalog = None
    try:
        old = candidate(old_catalog, "c:old-persona")
        old_memory = make_memory(old_catalog, state_scope=old_scope)
        updated = replacement(persona)
        activate(registry, updated)
        new_scope = PersonaStateScope(updated, registry=registry, base_dir=tmp_path / "personas").module("memory")
        new_catalog = MemoryCatalog(new_scope.file("metadata.db"))
        new = candidate(new_catalog, "c:new-persona")
        new_memory = make_memory(new_catalog, state_scope=new_scope)
        before_old, before_new = snapshot(old_catalog), snapshot(new_catalog)
        status = new_memory.memory_candidate_status([new, old])
        assert status["stale_ids"] == [old] and status["pending_ids"] == [new]
        assert new_memory.decide_memory_candidates([new, old], "confirm")["error_code"] == "stale_selection"
        with pytest.raises(StalePersonaEpoch):
            old_memory.memory_candidate_status([old])
        with pytest.raises(StalePersonaEpoch):
            old_memory.decide_memory_candidates([old], "reject")
        assert snapshot(old_catalog) == before_old and snapshot(new_catalog) == before_new
    finally:
        old_catalog.close()
        if new_catalog is not None:
            new_catalog.close()


def test_persona_switch_after_precheck_is_stopped_by_commit_boundary(tmp_path, monkeypatch):
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    module = PersonaStateScope(persona, registry=registry, base_dir=tmp_path / "personas").module("memory")
    catalog = MemoryCatalog(module.file("metadata.db"))
    try:
        target = candidate(catalog, "c:epoch-race")
        memory = make_memory(catalog, state_scope=module)
        before = snapshot(catalog)
        require_current = memory._require_current

        def switch_after_check():
            require_current()
            activate(registry, replacement(persona))

        monkeypatch.setattr(memory, "_require_current", switch_after_check)
        with pytest.raises(StalePersonaEpoch):
            memory.decide_memory_candidates([target], "confirm")
        assert snapshot(catalog) == before
    finally:
        catalog.close()


def test_batch_decisions_keep_candidate_pages_and_survive_restart(tmp_path):
    path = tmp_path / "restart-candidates.db"
    catalog = MemoryCatalog(path)
    try:
        ids = [candidate(catalog, f"c:paging:{n}") for n in range(6)]
        with catalog.transaction() as connection:
            connection.executemany("UPDATE memory_candidates SET created_at=? WHERE id=?",
                                   [(100.0 + n, candidate_id) for n, candidate_id in enumerate(ids)])
        first, after = catalog.list_candidates_page(limit=2)
        memory = make_memory(catalog)
        confirmed_ids = [first[0]["id"], first[1]["id"]]
        memory.decide_memory_candidates(confirmed_ids, "confirm")
        second, after_second = catalog.list_candidates_page(limit=2, after=after)
        rejected_ids = [second[0]["id"]]
        memory.decide_memory_candidates(rejected_ids, "reject")
        third, _ = catalog.list_candidates_page(limit=2, after=after_second)
        pages = [row["id"] for row in first + second + third]
        assert sorted(pages) == sorted(ids)
        new_ids = {row["id"] for row in catalog.all() if row["confirmation_state"] == "confirmed"}
    finally:
        catalog.close()
    reopened = MemoryCatalog(path)
    try:
        status = make_memory(reopened).memory_candidate_status(ids)
        decided = {state["candidate_id"]: state["status"] for state in status["states"]}
        assert [decided[candidate_id] for candidate_id in confirmed_ids] == ["confirmed", "confirmed"]
        assert decided[rejected_ids[0]] == "rejected"
        assert status["pending_ids"] == [i for i in ids if i not in confirmed_ids + rejected_ids]
        assert {row["id"] for row in reopened.all() if row["confirmation_state"] == "confirmed"} == new_ids
    finally:
        reopened.close()


def test_preview_keys_never_include_candidate_or_memory_text(catalog):
    target = candidate(catalog, "c:keys", "Secret wording")
    result = make_memory(catalog).memory_candidate_status([target])
    assert set(result) == {"ok", "candidate_ids", "states"} | PREVIEW_KEYS
    assert "Secret" not in repr(result)
