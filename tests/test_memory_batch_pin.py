"""Atomic batch pin state and read-only selection previews on synthetic catalogs."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib

import pytest
from pydantic import ValidationError

from src.kernel.contracts import (
    COMMAND_PAYLOAD_MODELS,
    MUTATING_COMMAND_NAMES,
    MVP_COMMAND_NAMES,
    CommandEnvelopeV4,
    MemoryPinManyPayload,
    MemoryPinStatusPayload,
    PersonaScopeV4,
)
from src.memory.catalog import MemoryCatalog
from src.memory.manager import MemoryManager
from src.memory.versioned_store import VersionedVectorStore
from src.persona.identity import PersonaEpochRegistry, StalePersonaEpoch
from src.persona.persona_card import Persona, default_persona
from src.persona.state_scope import PersonaStateScope
from src.storage.encrypted_sqlite import integrity_errors


BAD_SELECTIONS = [
    pytest.param([], id="empty"),
    pytest.param([f"fact_{n}" for n in range(101)], id="over-100"),
    pytest.param(["fact_1", "fact_1"], id="duplicate"),
    pytest.param(["../fact_1"], id="traversal"),
    pytest.param(["fact 1"], id="space"),
    pytest.param(["fact_1\n"], id="newline"),
    pytest.param(["事实_1"], id="non-ascii"),
    pytest.param(["_fact_1"], id="invalid-start"),
    pytest.param(["x" * 129], id="over-128"),
    pytest.param([""], id="blank"),
    pytest.param([None], id="null-id"),
    pytest.param([True], id="bool-id"),
    pytest.param([123], id="int-id"),
    pytest.param([1.25], id="float-id"),
    pytest.param([b"fact_1"], id="bytes-id"),
    pytest.param([["fact_1"]], id="nested-list"),
    pytest.param([{"id": "fact_1"}], id="object-id"),
    pytest.param("fact_1", id="string-selection"),
    pytest.param(None, id="null-selection"),
    pytest.param(("fact_1",), id="tuple-selection"),
    pytest.param({"fact_1"}, id="set-selection"),
    pytest.param({"0": "fact_1"}, id="object-selection"),
]
BAD_PINNED = [
    pytest.param(None, id="null"),
    pytest.param(0, id="zero"),
    pytest.param(1, id="one"),
    pytest.param(0.0, id="float-zero"),
    pytest.param(1.0, id="float-one"),
    pytest.param("true", id="string-true"),
    pytest.param("false", id="string-false"),
    pytest.param("1", id="string-one"),
    pytest.param(b"true", id="bytes"),
    pytest.param([], id="list"),
    pytest.param({}, id="object"),
]
SUCCESS_KEYS = {
    "ok", "memory_ids", "pinned", "changed_ids", "unchanged_ids",
    "pinned_total_before", "pinned_total_after", "pin_limit",
}


@pytest.fixture
def catalog(tmp_path):
    value = MemoryCatalog(tmp_path / "batch-pin.db")
    yield value
    value.close()


def confirm(catalog, key, text=None):
    text = text or f"Synthetic pin memory {key}"
    candidate = catalog.create_candidate(
        fact_key=key, proposed_text=text, source_text=text,
        source_type="user_statement", source_uri="synthetic:batch-pin",
        source_hash=hashlib.sha256(text.encode()).hexdigest(), confidence=1.0,
    )
    return catalog.confirm_candidate(
        candidate["id"], embedding_model_version="synthetic-batch-pin",
    )["memory"]


def make_memory(catalog, *, state_scope=None):
    # Use the real manager/catalog boundary without starting models or workers.
    store = object.__new__(VersionedVectorStore)
    store.catalog = catalog
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


def fill_pins(catalog, count):
    rows = [confirm(catalog, f"pin:occupied:{n}") for n in range(count)]
    with catalog.transaction() as connection:
        connection.executemany("UPDATE memory_records SET pinned=1 WHERE id=?",
                               [(row["id"],) for row in rows])
    return rows


def envelope(command, payload):
    return CommandEnvelopeV4(
        request_id="batch_pin_request_01", idempotency_key="batch_pin_request_01",
        command=command,
        persona=PersonaScopeV4(persona_id="batch_persona", epoch=1, fingerprint="a" * 64),
        payload=payload,
    )


@pytest.mark.parametrize("selected", BAD_SELECTIONS)
def test_payloads_and_envelopes_reject_malformed_selections(selected):
    for command, model, extra in (
        ("memory:pin_status", MemoryPinStatusPayload, {}),
        ("memory:pin_many", MemoryPinManyPayload, {"pinned": True}),
    ):
        payload = {"memory_ids": selected, **extra}
        with pytest.raises(ValidationError):
            model.model_validate(payload)
        with pytest.raises(ValidationError):
            envelope(command, payload)


@pytest.mark.parametrize("selected", BAD_SELECTIONS)
def test_catalog_rejects_malformed_selections_without_sql(catalog, selected):
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        for callback in (lambda: catalog.pin_status(selected),
                         lambda: catalog.pin_confirmed_memories(selected, True)):
            with pytest.raises(ValueError):
                callback()
    finally:
        catalog._connection.set_trace_callback(None)
    assert statements == []


@pytest.mark.parametrize("pinned", BAD_PINNED)
def test_write_requires_strict_boolean_at_contract_and_catalog(catalog, pinned):
    payload = {"memory_ids": ["fact_1"], "pinned": pinned}
    with pytest.raises(ValidationError):
        MemoryPinManyPayload.model_validate(payload)
    with pytest.raises(ValidationError):
        envelope("memory:pin_many", payload)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        with pytest.raises(ValueError, match="boolean"):
            catalog.pin_confirmed_memories(["fact_1"], pinned)
    finally:
        catalog._connection.set_trace_callback(None)
    assert statements == []


@pytest.mark.parametrize("command,payload", [
    ("memory:pin_status", {}),
    ("memory:pin_status", {"memory_ids": ["fact_1"], "pinned": True}),
    ("memory:pin_status", {"memory_ids": ["fact_1"], "confirm": True}),
    ("memory:pin_many", {"memory_ids": ["fact_1"]}),
    ("memory:pin_many", {"memory_ids": ["fact_1"], "pinned": False, "confirm": True}),
], ids=["status-missing-ids", "status-extra-pinned", "status-extra-confirm", "many-missing-pinned", "many-extra-confirm"])
def test_missing_and_extra_fields_are_rejected(command, payload):
    with pytest.raises(ValidationError):
        envelope(command, payload)


def test_payload_boundaries_order_and_mutation_classification():
    long_id = "A" + "._:-9" * 25 + "xy"
    assert len(long_id) == 128
    for ids in ([long_id], [f"fact_{n:03d}" for n in range(100, 0, -1)]):
        assert envelope("memory:pin_status", {"memory_ids": ids}).payload == {"memory_ids": ids}
        for pinned in (True, False):
            payload = {"memory_ids": ids, "pinned": pinned}
            assert envelope("memory:pin_many", payload).payload == payload
    assert {"memory:pin_status", "memory:pin_many"} <= MVP_COMMAND_NAMES
    assert "memory:pin_status" not in MUTATING_COMMAND_NAMES
    assert "memory:pin_many" in MUTATING_COMMAND_NAMES
    assert COMMAND_PAYLOAD_MODELS["memory:pin_status"] is MemoryPinStatusPayload
    assert COMMAND_PAYLOAD_MODELS["memory:pin_many"] is MemoryPinManyPayload


def test_status_is_one_read_only_snapshot_and_returns_only_identity_state(catalog, monkeypatch):
    current = confirm(catalog, "pin:current", "Private memory body must not be queried")
    stale = confirm(catalog, "pin:revised", "Old private text")
    revised = confirm(catalog, "pin:revised", "New private text")
    hidden = confirm(catalog, "pin:hidden")
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_records SET pinned=1 WHERE id IN (?,?)",
                           (current["id"], hidden["id"]))
        connection.execute("UPDATE memory_records SET lifecycle_state='expired' WHERE id=?", (hidden["id"],))
    memory = make_memory(catalog)
    selected = [stale["id"], current["id"], "fact_missing", revised["id"]]
    before = snapshot(catalog)
    statements = []
    monkeypatch.setattr("src.memory.catalog.time.time", lambda: pytest.fail("preview read the clock"))
    catalog._connection.execute("PRAGMA query_only=ON")
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.pin_status(selected)
    finally:
        catalog._connection.set_trace_callback(None)
        catalog._connection.execute("PRAGMA query_only=OFF")
    assert result == {
        "ok": True, "memory_ids": selected,
        "states": [{"memory_id": current["id"], "pinned": True},
                   {"memory_id": revised["id"], "pinned": False}],
        "stale_ids": [stale["id"], "fact_missing"], "pinned_total": 2, "pin_limit": 20,
    }
    assert len(statements) == 1 and statements[0].lstrip().upper().startswith("WITH ")
    assert not any(word in statements[0].lower() for word in ("text", "timestamp", "updated_at", "created_at"))
    assert snapshot(catalog) == before
    assert memory._last_memory_activity_at == 123.0
    assert not catalog._connection.in_transaction


@pytest.mark.parametrize("count", [1, 100], ids=["one", "hundred"])
def test_status_handles_boundary_selections_in_request_order(catalog, count):
    rows = [confirm(catalog, f"pin:boundary:{n}") for n in range(count)]
    selected = [row["id"] for row in reversed(rows)]
    status = make_memory(catalog).pin_status(selected)
    assert status["memory_ids"] == selected
    assert status["states"] == [{"memory_id": memory_id, "pinned": False} for memory_id in selected]
    assert status["stale_ids"] == [] and status["pinned_total"] == 0
    result = make_memory(catalog).pin_confirmed_memories(selected, False)
    assert result["changed_ids"] == [] and result["unchanged_ids"] == selected
    assert result["pinned_total_before"] == result["pinned_total_after"] == 0


def test_status_allows_an_entirely_stale_selection(catalog):
    fill_pins(catalog, 2)
    selected = [f"fact_missing_{n}" for n in range(100, 0, -1)]
    assert make_memory(catalog).pin_status(selected) == {
        "ok": True, "memory_ids": selected, "states": [], "stale_ids": selected,
        "pinned_total": 2, "pin_limit": 20,
    }


@pytest.mark.parametrize("pinned", [True, False], ids=["pin", "unpin"])
def test_mixed_batch_changes_only_needed_rows_in_one_transaction(catalog, pinned):
    first, second, third = [confirm(catalog, f"pin:mixed:{n}") for n in range(3)]
    catalog.set_pinned(second["id"], True)
    before = {row["id"]: row for row in catalog.all()}
    statements = []
    memory = make_memory(catalog)
    selected = [third["id"], second["id"], first["id"]]
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.pin_confirmed_memories(selected, pinned)
    finally:
        catalog._connection.set_trace_callback(None)
    changed = [third["id"], first["id"]] if pinned else [second["id"]]
    unchanged = [second["id"]] if pinned else [third["id"], first["id"]]
    assert result == {
        "ok": True, "memory_ids": selected, "pinned": pinned,
        "changed_ids": changed, "unchanged_ids": unchanged,
        "pinned_total_before": 1, "pinned_total_after": 3 if pinned else 0, "pin_limit": 20,
    }
    assert sum(sql.upper() == "BEGIN IMMEDIATE" for sql in statements) == 1
    assert sum(sql.upper() == "COMMIT" for sql in statements) == 1
    assert sum(sql.lstrip().upper().startswith("UPDATE") for sql in statements) == 1
    after = {row["id"]: row for row in catalog.all()}
    for memory_id in unchanged:
        assert after[memory_id] == before[memory_id]
    for memory_id in changed:
        assert {key: value for key, value in after[memory_id].items() if key not in {"pinned", "updated_at"}} == {
            key: value for key, value in before[memory_id].items() if key not in {"pinned", "updated_at"}
        }
    assert memory._last_memory_activity_at == 123.0


@pytest.mark.parametrize("pinned", [True, False], ids=["pin", "unpin"])
def test_idempotent_repetition_has_no_update_or_timestamp_activity(catalog, pinned):
    row = confirm(catalog, "pin:idempotent")
    memory = make_memory(catalog)
    memory.pin_confirmed_memories([row["id"]], pinned)
    before = snapshot(catalog)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.pin_confirmed_memories([row["id"]], pinned)
    finally:
        catalog._connection.set_trace_callback(None)
    assert set(result) == SUCCESS_KEYS
    assert result["changed_ids"] == [] and result["unchanged_ids"] == [row["id"]]
    assert result["pinned_total_before"] == result["pinned_total_after"] == int(pinned)
    assert not any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for sql in statements)
    assert snapshot(catalog) == before


@pytest.mark.parametrize("stale_kind", ["missing", "deleted", "superseded", "unconfirmed", "expired"],
                         ids=["missing", "deleted", "superseded", "unconfirmed", "expired"])
@pytest.mark.parametrize("pinned", [True, False], ids=["pin", "unpin"])
def test_stale_selection_rejects_whole_batch_before_any_write(catalog, stale_kind, pinned):
    first = confirm(catalog, "pin:kept")
    stale = confirm(catalog, "pin:stale")
    catalog.set_pinned(first["id"], not pinned)
    memory = make_memory(catalog)
    selected = [first["id"], stale["id"]]
    assert memory.pin_status(selected)["stale_ids"] == []
    if stale_kind == "missing":
        selected[-1] = "fact_missing"
    elif stale_kind == "deleted":
        catalog.delete_fact_lineage("pin:stale")
    elif stale_kind == "superseded":
        confirm(catalog, "pin:stale", "A correction changed this revision identity")
    else:
        with catalog.transaction() as connection:
            column, value = (("confirmation_state", "observed") if stale_kind == "unconfirmed"
                             else ("lifecycle_state", "expired"))
            connection.execute(f"UPDATE memory_records SET {column}=? WHERE id=?", (value, stale["id"]))
    before = snapshot(catalog)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        result = memory.pin_confirmed_memories(selected, pinned)
    finally:
        catalog._connection.set_trace_callback(None)
    assert result == {
        "ok": False, "error_code": "stale_selection",
        "error": "Selected memories changed; no pin states were changed", "stale_ids": [selected[-1]],
    }
    assert snapshot(catalog) == before
    assert not any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for sql in statements)
    assert sum(sql.upper() == "BEGIN IMMEDIATE" for sql in statements) == 1
    assert any(sql.upper() == "ROLLBACK" for sql in statements)


def test_status_and_rejection_report_every_stale_id_in_request_order(catalog):
    old = confirm(catalog, "pin:revisions")
    current = confirm(catalog, "pin:revisions", "Current revision")
    selected = ["fact_missing_b", current["id"], old["id"], "fact_missing_a"]
    memory = make_memory(catalog)
    expected = ["fact_missing_b", old["id"], "fact_missing_a"]
    assert memory.pin_status(selected)["stale_ids"] == expected
    assert memory.pin_confirmed_memories(selected, True)["stale_ids"] == expected


def test_capacity_is_exactly_twenty_and_entire_overflow_is_rejected(catalog):
    occupied = fill_pins(catalog, 19)
    first, second = [confirm(catalog, f"pin:capacity:{n}") for n in range(2)]
    memory = make_memory(catalog)
    before = snapshot(catalog)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        rejected = memory.pin_confirmed_memories([first["id"], occupied[0]["id"], second["id"]], True)
    finally:
        catalog._connection.set_trace_callback(None)
    assert set(rejected) == {"ok", "error_code", "error"}
    assert rejected["ok"] is False and rejected["error_code"] == "pin_limit_exceeded"
    assert rejected["error"]
    assert snapshot(catalog) == before
    assert sum(sql.upper() == "BEGIN IMMEDIATE" for sql in statements) == 1
    assert any(sql.upper() == "ROLLBACK" for sql in statements)
    assert not any(sql.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")) for sql in statements)
    accepted = memory.pin_confirmed_memories([occupied[0]["id"], first["id"]], True)
    assert accepted["changed_ids"] == [first["id"]]
    assert accepted["pinned_total_before"] == 19 and accepted["pinned_total_after"] == 20


def test_capacity_rechecks_global_count_after_preview_and_includes_hidden_rows(catalog):
    occupied = fill_pins(catalog, 19)
    row = confirm(catalog, "pin:preview-target")
    memory = make_memory(catalog)
    assert memory.pin_status([row["id"]])["pinned_total"] == 19
    extra = confirm(catalog, "pin:arrived-after-preview")
    catalog.set_pinned(extra["id"], True)
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_records SET lifecycle_state='expired' WHERE id=?", (extra["id"],))
        connection.execute("UPDATE memory_records SET confirmation_state='observed' WHERE id=?", (occupied[0]["id"],))
        connection.execute("UPDATE memory_records SET lifecycle_state='superseded' WHERE id=?", (occupied[1]["id"],))
    before = snapshot(catalog)
    result = memory.pin_confirmed_memories([row["id"]], True)
    assert result["error_code"] == "pin_limit_exceeded"
    assert memory.pin_status([row["id"]])["pinned_total"] == 20
    assert snapshot(catalog) == before


def test_current_target_state_overrides_preview_and_over_limit_idempotency_is_allowed(catalog):
    occupied = fill_pins(catalog, 21)
    row = confirm(catalog, "pin:late-target")
    memory = make_memory(catalog)
    assert memory.pin_status([row["id"]])["states"] == [{"memory_id": row["id"], "pinned": False}]
    catalog.set_pinned(row["id"], True)
    result = memory.pin_confirmed_memories([row["id"]], True)
    assert result["changed_ids"] == [] and result["unchanged_ids"] == [row["id"]]
    assert result["pinned_total_before"] == result["pinned_total_after"] == 22
    unpinned = memory.pin_confirmed_memories([row["id"], occupied[0]["id"]], False)
    assert unpinned["changed_ids"] == [row["id"], occupied[0]["id"]]
    assert unpinned["pinned_total_before"] == 22 and unpinned["pinned_total_after"] == 20


def test_stale_selection_takes_precedence_over_capacity_rejection(catalog):
    fill_pins(catalog, 20)
    row = confirm(catalog, "pin:stale-before-limit")
    before = snapshot(catalog)
    result = make_memory(catalog).pin_confirmed_memories([row["id"], "fact_missing"], True)
    assert result["error_code"] == "stale_selection"
    assert result["stale_ids"] == ["fact_missing"]
    assert snapshot(catalog) == before


@pytest.mark.parametrize("pinned", [True, False], ids=["pin", "unpin"])
def test_storage_failure_rolls_back_the_entire_batch(catalog, pinned):
    rows = [confirm(catalog, f"pin:rollback:{n}") for n in range(2)]
    with catalog.transaction() as connection:
        connection.executemany("UPDATE memory_records SET pinned=? WHERE id=?",
                               [(int(not pinned), row["id"]) for row in rows])
        connection.execute("""
            CREATE TRIGGER reject_batch_pin BEFORE UPDATE OF pinned ON memory_records
            WHEN OLD.fact_key='pin:rollback:1'
            BEGIN SELECT RAISE(ABORT, 'synthetic batch pin failure'); END
        """)
    before = snapshot(catalog)
    with pytest.raises(integrity_errors(), match="synthetic batch pin failure"):
        make_memory(catalog).pin_confirmed_memories([row["id"] for row in rows], pinned)
    assert snapshot(catalog) == before
    assert not catalog._connection.in_transaction


def test_durable_commit_exception_propagates_without_safe_rejection(catalog, monkeypatch):
    row = confirm(catalog, "pin:commit-unknown")
    transaction = catalog.transaction

    @contextmanager
    def committed_then_failed():
        with transaction() as connection:
            yield connection
        raise OSError("synthetic commit acknowledgement lost")

    monkeypatch.setattr(catalog, "transaction", committed_then_failed)
    with pytest.raises(OSError, match="commit acknowledgement lost"):
        make_memory(catalog).pin_confirmed_memories([row["id"]], True)
    assert catalog.get(row["id"])["pinned"] == 1


def replacement(persona):
    data = persona.to_dict()
    data["name"] = "Batch Pin Replacement"
    data["identity"]["persona_id"] = "batch_pin_replacement"
    data["identity"]["identity_version"] = 1
    return Persona(**data)


def activate(registry, persona):
    authorization = registry.authorize_update(
        actor="owner", reason="synthetic batch pin scope test", user_confirmed=True,
    )
    registry.activate_update(persona, authorization)


def test_pin_commands_cannot_cross_personas_or_use_a_stale_manager(tmp_path):
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    old_scope = PersonaStateScope(persona, registry=registry, base_dir=tmp_path / "personas").module("memory")
    old_catalog = MemoryCatalog(old_scope.file("metadata.db"))
    new_catalog = None
    try:
        old = confirm(old_catalog, "pin:old-persona")
        old_memory = make_memory(old_catalog, state_scope=old_scope)
        updated = replacement(persona)
        activate(registry, updated)
        new_scope = PersonaStateScope(updated, registry=registry, base_dir=tmp_path / "personas").module("memory")
        new_catalog = MemoryCatalog(new_scope.file("metadata.db"))
        new = confirm(new_catalog, "pin:new-persona")
        new_memory = make_memory(new_catalog, state_scope=new_scope)
        before_old, before_new = snapshot(old_catalog), snapshot(new_catalog)
        status = new_memory.pin_status([new["id"], old["id"]])
        assert status["stale_ids"] == [old["id"]]
        assert status["states"] == [{"memory_id": new["id"], "pinned": False}]
        assert new_memory.pin_confirmed_memories([new["id"], old["id"]], True)["error_code"] == "stale_selection"
        with pytest.raises(StalePersonaEpoch):
            old_memory.pin_status([old["id"]])
        with pytest.raises(StalePersonaEpoch):
            old_memory.pin_confirmed_memories([old["id"]], True)
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
        row = confirm(catalog, "pin:epoch-race")
        memory = make_memory(catalog, state_scope=module)
        before = snapshot(catalog)
        require_current = memory._require_current

        def switch_after_check():
            require_current()
            activate(registry, replacement(persona))

        monkeypatch.setattr(memory, "_require_current", switch_after_check)
        with pytest.raises(StalePersonaEpoch):
            memory.pin_confirmed_memories([row["id"]], True)
        assert snapshot(catalog) == before
    finally:
        catalog.close()


def test_pin_changes_keep_revision_page_cursor_and_restart_identity(tmp_path):
    path = tmp_path / "restart-pin.db"
    catalog = MemoryCatalog(path)
    try:
        rows = [confirm(catalog, f"pin:paging:{n}") for n in range(6)]
        with catalog.transaction() as connection:
            connection.executemany("UPDATE memory_records SET confirmed_at=?,created_at=? WHERE id=?",
                                   [(100.0 + n // 2, 100.0 + n // 2, row["id"]) for n, row in enumerate(rows)])
        memory = make_memory(catalog)
        original = memory.list_confirmed_memories_page(limit=6)["memories"]
        first = memory.list_confirmed_memories_page(limit=2)
        selected = [row["id"] for row in original]
        identity = {row["id"]: (row["fact_key"], row["fact_revision"], row["confirmed_at"], row["text"])
                    for row in original}
        memory.pin_confirmed_memories([selected[1], selected[4]], True)
        second = memory.list_confirmed_memories_page(limit=2, cursor=first["next_cursor"])
        third = memory.list_confirmed_memories_page(limit=2, cursor=second["next_cursor"])
        assert [row["id"] for page in (first, second, third) for row in page["memories"]] == selected
        assert memory.list_confirmed_memories_page(limit=2)["next_cursor"] == first["next_cursor"]
    finally:
        catalog.close()
    reopened = MemoryCatalog(path)
    try:
        memory = make_memory(reopened)
        restored = memory.list_confirmed_memories_page(limit=6)["memories"]
        assert [row["id"] for row in restored] == selected
        assert {row["id"]: (row["fact_key"], row["fact_revision"], row["confirmed_at"], row["text"])
                for row in restored} == identity
        assert [row["id"] for row in restored if row["pinned"]] == [selected[1], selected[4]]
        assert memory.pin_status(selected)["pinned_total"] == 2
        memory.pin_confirmed_memories([selected[1]], False)
        assert memory.pin_status(selected)["pinned_total"] == 1
    finally:
        reopened.close()
