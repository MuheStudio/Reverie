"""Manual adjustment receipts and zero-importance preservation on isolated catalogs."""

from __future__ import annotations

import asyncio
import hashlib
from types import SimpleNamespace

import pytest

from src.bridge import ws_bridge
from src.config.settings import MemorySettings
from src.memory.catalog import MemoryCatalog
from src.memory.cognitive_decay import CognitiveDecaySystem
from src.memory.lifecycle_constants import USER_SIGNAL_WEIGHT
from src.memory.manager import MemoryManager
from src.memory.versioned_store import VersionedVectorStore
from src.persona.identity import PersonaEpochRegistry, StalePersonaEpoch
from src.persona.persona_card import Persona, default_persona
from src.persona.state_scope import PersonaStateScope


ADJUST_OPS = ["strengthen", "weaken", "reactivate"]
RECEIPT_KEYS = {
    "ok", "op", "memory_id", "changed", "importance_before", "importance_after",
}


@pytest.fixture
def catalog(tmp_path):
    value = MemoryCatalog(tmp_path / "memory-adjust.db")
    yield value
    value.close()


def candidate(catalog, key, text=None):
    text = text or f"Synthetic adjustment fact {key}"
    return catalog.create_candidate(
        fact_key=key, proposed_text=text, source_text=text,
        source_type="user_statement", source_uri="synthetic:memory-adjust",
        source_hash=hashlib.sha256(text.encode()).hexdigest(), confidence=1.0,
    )


def confirm(catalog, key, *, text=None, importance=0.5):
    item = candidate(catalog, key, text)
    return catalog.confirm_candidate(
        item["id"], embedding_model_version="synthetic-adjust", importance=importance,
    )["memory"]


def manager(catalog, *, governance=True, state_scope=None):
    # Exercise the real manager/catalog boundary without loading models or workers.
    memory = object.__new__(MemoryManager)
    memory.store = SimpleNamespace(catalog=catalog)
    memory.settings = MemorySettings(memory_lifecycle_governance_enabled=governance)
    memory.state_scope = state_scope
    return memory


def snapshot(catalog):
    tables = catalog._connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).fetchall()
    return {
        item["name"]: sorted(
            [tuple(row) for row in catalog._connection.execute(
                'SELECT * FROM "' + item["name"].replace('"', '""') + '"',
            ).fetchall()], key=repr,
        )
        for item in tables
    }


def usage(catalog, memory_id):
    return [tuple(row) for row in catalog._connection.execute(
        "SELECT signal,weight FROM memory_usage_events WHERE memory_id=? ORDER BY id",
        (memory_id,),
    ).fetchall()]


@pytest.mark.parametrize("op", ADJUST_OPS)
@pytest.mark.parametrize("state", [
    "missing", "pending", "rejected", "observed", "superseded", "expired",
])
def test_non_current_confirmed_targets_are_rejected_without_any_data_change(catalog, op, state):
    if state in {"pending", "rejected"}:
        target = candidate(catalog, f"adjust:{state}")
        if state == "rejected":
            catalog.reject_candidate(target["id"])
    elif state == "observed":
        catalog.upsert(
            id="observed_adjustment", text="Synthetic unconfirmed observation",
            retention_layer="long_term", cognitive_layer="semantic", timestamp=100.0,
            importance=0.5, emotions={}, embedding_model_version="synthetic-adjust",
        )
        target = catalog.get("observed_adjustment")
    elif state in {"superseded", "expired"}:
        target = confirm(catalog, f"adjust:{state}")
        if state == "superseded":
            confirm(catalog, f"adjust:{state}", text="Synthetic replacement adjustment fact")
            assert catalog.get(target["id"])["lifecycle_state"] == "superseded"
        else:
            with catalog.transaction() as connection:
                connection.execute("UPDATE memory_records SET lifecycle_state='expired' WHERE id=?",
                                   (target["id"],))
    else:
        target = {"id": "missing_adjustment"}
    before = snapshot(catalog)

    result = manager(catalog).adjust_memory(target["id"], op)

    assert result["ok"] is False
    assert result["error_code"] == "memory_not_adjustable"
    assert result["op"] == op and result["memory_id"] == target["id"]
    assert snapshot(catalog) == before


@pytest.mark.parametrize("op,before,after,signal,weight", [
    ("strengthen", 0.0, 0.1, "user_confirmed", USER_SIGNAL_WEIGHT),
    ("weaken", 0.1, 0.0, "user_rejected", -USER_SIGNAL_WEIGHT),
    ("reactivate", 0.5, 0.65, "user_confirmed", USER_SIGNAL_WEIGHT),
    ("strengthen", 0.23456789, 0.334568, "user_confirmed", USER_SIGNAL_WEIGHT),
    ("weaken", 0.23456789, 0.134568, "user_rejected", -USER_SIGNAL_WEIGHT),
    ("strengthen", 0.95, 1.0, "user_confirmed", USER_SIGNAL_WEIGHT),
    ("weaken", 0.05, 0.0, "user_rejected", -USER_SIGNAL_WEIGHT),
])
def test_success_receipt_matches_stored_rounded_values_and_governance(
    catalog, op, before, after, signal, weight,
):
    row = confirm(catalog, "adjust:receipt", importance=before)
    result = manager(catalog).adjust_memory(row["id"], op)

    assert set(result) == RECEIPT_KEYS
    assert result == {"ok": True, "op": op, "memory_id": row["id"], "changed": True,
                      "importance_before": before, "importance_after": after}
    assert isinstance(result["importance_before"], float)
    assert isinstance(result["importance_after"], float)
    updated = catalog.get(row["id"])
    assert updated["importance"] == after
    assert updated["access_count"] == row["access_count"] + int(op == "reactivate")
    assert usage(catalog, row["id"]) == [(signal, weight)]


@pytest.mark.parametrize("op,importance", [("strengthen", 1.0), ("weaken", 0.0)])
def test_boundaries_are_successful_noops_without_writes_or_governance(catalog, op, importance):
    row = confirm(catalog, "adjust:boundary", importance=importance)
    before = snapshot(catalog)

    result = manager(catalog).adjust_memory(row["id"], op)

    assert result == {"ok": True, "op": op, "memory_id": row["id"], "changed": False,
                      "importance_before": importance, "importance_after": importance}
    assert snapshot(catalog) == before
    assert usage(catalog, row["id"]) == []


def test_reactivation_at_maximum_always_touches_and_records_governance(catalog):
    row = confirm(catalog, "adjust:reactivate-max", importance=1.0)
    references_before = catalog._connection.execute(
        "SELECT COUNT(*) FROM memory_references WHERE memory_id=?", (row["id"],),
    ).fetchone()[0]
    result = manager(catalog).adjust_memory(row["id"], "reactivate")

    assert result == {"ok": True, "op": "reactivate", "memory_id": row["id"], "changed": True,
                      "importance_before": 1.0, "importance_after": 1.0}
    after = catalog.get(row["id"])
    assert after["access_count"] == row["access_count"] + 1
    assert after["last_accessed"] is not None
    assert after["lifecycle_state"] == "active"
    assert catalog._connection.execute(
        "SELECT COUNT(*) FROM memory_references WHERE memory_id=?", (row["id"],),
    ).fetchone()[0] == references_before + 1
    assert usage(catalog, row["id"]) == [("user_confirmed", USER_SIGNAL_WEIGHT)]


def test_repeated_weakening_reaches_exact_zero_then_strengthens_from_zero(catalog):
    row = confirm(catalog, "adjust:sequence", importance=0.5)
    memory = manager(catalog)
    results = [memory.adjust_memory(row["id"], "weaken") for _ in range(6)]
    assert [item["importance_after"] for item in results] == [0.4, 0.3, 0.2, 0.1, 0.0, 0.0]
    assert [item["changed"] for item in results] == [True, True, True, True, True, False]
    assert memory.adjust_memory(row["id"], "strengthen")["importance_after"] == 0.1


def test_existing_boolean_methods_preserve_return_type_and_apply_the_same_gate(catalog):
    memory = manager(catalog)
    row = confirm(catalog, "adjust:compatibility", importance=0.5)
    assert memory.strengthen_memory(row["id"]) is True
    assert memory.weaken_memory(row["id"]) is True
    assert memory.reactivate_memory(row["id"]) is True
    before = snapshot(catalog)
    assert memory.strengthen_memory("missing_adjustment") is False
    assert memory.weaken_memory("missing_adjustment") is False
    assert memory.reactivate_memory("missing_adjustment") is False
    assert snapshot(catalog) == before


@pytest.mark.parametrize("op", ADJUST_OPS)
def test_governance_off_does_not_record_user_signals(catalog, op):
    row = confirm(catalog, "adjust:governance-off")
    assert manager(catalog, governance=False).adjust_memory(row["id"], op)["changed"] is True
    assert usage(catalog, row["id"]) == []


def test_confirmed_list_rounds_importance_and_reads_back_adjusted_value(catalog):
    zero = confirm(catalog, "adjust:list-zero", importance=0.0)
    precise = confirm(catalog, "adjust:list-precision", importance=0.123456789)
    memory = manager(catalog)
    listed = {row["id"]: row for row in memory.list_confirmed_memories()}
    assert listed[zero["id"]]["importance"] == 0.0
    assert listed[precise["id"]]["importance"] == 0.123457
    receipt = memory.adjust_memory(zero["id"], "reactivate")
    paged = {row["id"]: row for row in memory.list_confirmed_memories_page()["memories"]}
    assert paged[zero["id"]]["importance"] == receipt["importance_after"] == 0.15


@pytest.mark.parametrize("raw,expected", [(-0.5, 0.0), (1.5, 1.0), (None, 0.5), (0.0, 0.0)])
def test_confirmed_view_bounds_importance(raw, expected):
    importance = MemoryManager._confirmed_memory_view({"importance": raw})["importance"]
    assert importance == expected
    assert isinstance(importance, float)
    assert MemoryManager._confirmed_memory_view({})["importance"] == 0.5


def replacement(persona):
    data = persona.to_dict()
    data["name"] = "Adjustment Replacement"
    data["identity"]["persona_id"] = "memory_adjust_replacement"
    data["identity"]["identity_version"] = 1
    return Persona(**data)


def activate(registry, persona):
    authorization = registry.authorize_update(
        actor="owner", reason="synthetic memory adjustment scope test", user_confirmed=True,
    )
    registry.activate_update(persona, authorization)


@pytest.mark.parametrize("op", ADJUST_OPS)
def test_adjustment_cannot_cross_personas_or_use_a_stale_manager(tmp_path, op):
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    base = tmp_path / "personas"
    old_scope = PersonaStateScope(persona, registry=registry, base_dir=base).module("memory")
    old_catalog = MemoryCatalog(old_scope.file("metadata.db"))
    new_catalog = None
    try:
        old = confirm(old_catalog, "adjust:old-persona")
        old_memory = manager(old_catalog, state_scope=old_scope)
        updated = replacement(persona)
        activate(registry, updated)
        new_scope = PersonaStateScope(updated, registry=registry, base_dir=base).module("memory")
        new_catalog = MemoryCatalog(new_scope.file("metadata.db"))
        confirm(new_catalog, "adjust:new-persona")
        new_memory = manager(new_catalog, state_scope=new_scope)
        before_old, before_new = snapshot(old_catalog), snapshot(new_catalog)
        assert new_memory.adjust_memory(old["id"], op)["error_code"] == "memory_not_adjustable"
        with pytest.raises(StalePersonaEpoch):
            old_memory.adjust_memory(old["id"], op)
        assert snapshot(old_catalog) == before_old
        assert snapshot(new_catalog) == before_new
    finally:
        old_catalog.close()
        if new_catalog is not None:
            new_catalog.close()


def test_persona_switch_after_precheck_is_stopped_by_existing_commit_boundary(tmp_path, monkeypatch):
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    scope = PersonaStateScope(persona, registry=registry, base_dir=tmp_path / "personas").module("memory")
    catalog = MemoryCatalog(scope.file("metadata.db"))
    try:
        row = confirm(catalog, "adjust:epoch-race")
        memory = manager(catalog, state_scope=scope)
        before = snapshot(catalog)
        require_current = memory._require_current

        def switch_after_check():
            require_current()
            activate(registry, replacement(persona))

        monkeypatch.setattr(memory, "_require_current", switch_after_check)
        with pytest.raises(StalePersonaEpoch):
            memory.adjust_memory(row["id"], "strengthen")
        assert snapshot(catalog) == before
    finally:
        catalog.close()


@pytest.mark.parametrize("raw,expected", [({}, 0.5), ({"importance": None}, 0.5), ({"importance": 0.0}, 0.0)])
def test_export_preserves_zero_and_defaults_only_missing_or_none(catalog, raw, expected):
    assert manager(catalog)._export_row(raw)["importance"] == expected


@pytest.mark.parametrize("materialized", [False, True], ids=["stream", "materialized"])
def test_catalog_import_paths_preserve_zero_and_missing_none_defaults(catalog, materialized):
    records = [
        {"id": "adjust_zero", "text": "Synthetic zero", "importance": 0.0},
        {"id": "adjust_none", "text": "Synthetic none", "importance": None},
        {"id": "adjust_missing", "text": "Synthetic missing"},
    ]
    if materialized:
        assert catalog._replace_all_materialized(records) == 3
    else:
        assert catalog.import_records(iter(records), replace=True) == 3
    assert {row["id"]: row["importance"] for row in catalog.all()} == {
        "adjust_zero": 0.0, "adjust_none": 0.5, "adjust_missing": 0.5,
    }


def test_legacy_migration_preserves_zero_and_missing_none_defaults(catalog, tmp_path):
    store = object.__new__(VersionedVectorStore)
    store.catalog = catalog
    store.db_path = tmp_path / "synthetic-legacy"
    store.db_path.mkdir()
    (store.db_path / "synthetic-marker").touch()
    store.legacy_table_name = "memories"
    rows = [
        {"id": "legacy_zero", "text": "Synthetic legacy zero", "importance": 0.0},
        {"id": "legacy_none", "text": "Synthetic legacy none", "importance": None},
        {"id": "legacy_missing", "text": "Synthetic legacy missing"},
    ]
    table = SimpleNamespace(to_lance=lambda: SimpleNamespace(to_pylist=lambda: rows))
    store._db = SimpleNamespace(list_tables=lambda: ["memories"], open_table=lambda _name: table)
    store._migrate_legacy_lance_rows()
    assert {row["id"]: row["importance"] for row in catalog.all()} == {
        "legacy_zero": 0.0, "legacy_none": 0.5, "legacy_missing": 0.5,
    }


def test_internal_automatic_adjustment_preserves_zero_without_manual_confirmation_gate(catalog):
    catalog.upsert(
        id="automatic_zero", text="Synthetic automatic observed fact", retention_layer="long_term",
        cognitive_layer="semantic", timestamp=100.0, importance=0.0, emotions={},
        embedding_model_version="synthetic-adjust",
    )
    assert manager(catalog)._adjust_memory_importance("automatic_zero", 0.1, touch=False) is True
    assert catalog.get("automatic_zero")["importance"] == 0.1


def test_cognitive_decay_distinguishes_zero_from_half_importance(catalog):
    decay = CognitiveDecaySystem(SimpleNamespace(catalog=catalog))
    aged = {"layer": "long_term", "timestamp": 100.0, "text": "Synthetic ordinary fact"}
    now = 100.0 + 90 * 86400
    zero, half = {**aged, "importance": 0.0}, {**aged, "importance": 0.5}
    assert decay.retention(zero, now=now) < decay.retention(half, now=now)
    assert decay.retrieval_weight(zero, now=now) == 0.0
    assert decay.retrieval_weight(half, now=now) > 0.0
    for defaulted in (aged, {**aged, "importance": None}):
        assert decay.retention(defaulted, now=now) == decay.retention(half, now=now)
        assert decay.retrieval_weight(defaulted, now=now) == decay.retrieval_weight(half, now=now)


def test_correcting_fuzzy_recall_strengthens_zero_to_point_zero_three(catalog):
    row = confirm(catalog, "adjust:decay-correction", importance=0.0)
    catalog.record_recall_confusion(
        memory_id=row["id"], query="Synthetic question", true_text=row["text"],
        rendered_text="Synthetic wrong fact", source_entity="truth", substitute_entity="wrong",
        domain="synthetic",
    )
    decay = CognitiveDecaySystem(SimpleNamespace(catalog=catalog))
    assert decay.resolve_user_correction("you got that wrong") is True
    assert catalog.get(row["id"])["importance"] == 0.03


@pytest.fixture
def bridge(catalog, monkeypatch):
    state = ws_bridge.BridgeState()
    state.memory = manager(catalog)
    controller = object()
    context = ws_bridge.BridgeClientContext(
        client_id="memory_adjust_controller", protocol_version=4, authenticated=True,
    )
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_controller_ws", controller)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {controller: context})
    return state, controller


@pytest.mark.parametrize("op,after", [("strengthen", 0.6), ("weaken", 0.4), ("reactivate", 0.65)])
def test_bridge_returns_complete_adjustment_receipts(catalog, bridge, op, after):
    _state, controller = bridge
    row = confirm(catalog, "adjust:bridge")
    assert asyncio.run(ws_bridge.handle_memory_reinforce(
        {"memory_id": row["id"], "op": op}, controller,
    )) == {"ok": True, "op": op, "memory_id": row["id"], "changed": True,
           "importance_before": 0.5, "importance_after": after}


@pytest.mark.parametrize("op", ADJUST_OPS)
def test_bridge_preserves_adjustment_rejection(catalog, bridge, op):
    _state, controller = bridge
    before = snapshot(catalog)
    result = asyncio.run(ws_bridge.handle_memory_reinforce(
        {"memory_id": "missing_adjustment", "op": op}, controller,
    ))
    assert result["ok"] is False and result["error_code"] == "memory_not_adjustable"
    assert result["memory_id"] == "missing_adjustment" and result["op"] == op
    assert snapshot(catalog) == before


def test_bridge_keeps_existing_custom_amount_and_pin_receipts(catalog, bridge):
    _state, controller = bridge
    row = confirm(catalog, "adjust:bridge-compatibility", importance=0.0)
    custom = asyncio.run(ws_bridge.handle_memory_reinforce(
        {"memory_id": row["id"], "op": "strengthen", "amount": 0.5}, controller,
    ))
    assert custom["importance_before"] == 0.0 and custom["importance_after"] == 0.5
    for op in ("pin", "unpin"):
        result = asyncio.run(ws_bridge.handle_memory_reinforce(
            {"memory_id": row["id"], "op": op}, controller,
        ))
        assert result == {"ok": True, "op": op, "memory_id": row["id"]}


@pytest.mark.parametrize("op,importance", [("strengthen", 1.0), ("weaken", 0.0)])
def test_bridge_reports_successful_noop_with_changed_false(catalog, bridge, op, importance):
    _state, controller = bridge
    row = confirm(catalog, "adjust:bridge-noop", importance=importance)
    before = snapshot(catalog)
    result = asyncio.run(ws_bridge.handle_memory_reinforce(
        {"memory_id": row["id"], "op": op}, controller,
    ))
    assert result == {"ok": True, "op": op, "memory_id": row["id"], "changed": False,
                      "importance_before": importance, "importance_after": importance}
    assert snapshot(catalog) == before
