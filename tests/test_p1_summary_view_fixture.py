"""Prepared regression cases for the explicitly registered synthetic viewer.

These tests exercise fixture boundaries; they do not assert that a model
generated a summary. Formal registration preparation does not run this file.
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.bridge import ws_bridge
from src.config.settings import _Settings
from src.config.usage_policy import UsagePolicy
from src.conversation_summary.runtime import ConversationSummaryRuntime
from src.conversation_summary.store import SummaryStore
from src.kernel.storage import KernelStore
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import default_persona
from src.storage.encrypted_sqlite import clear_storage_key_for_testing, install_storage_key
from tests.test_conversation_summary_store import exchange
from tests.test_p1_memory_fixture import manager


ROOT = Path(__file__).resolve().parents[1]


def load_fixture(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"native-ui/tests/{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


bootstrap = load_fixture("p1_memory_backend_bootstrap")
fixture = load_fixture("p1_summary_view_fixture")


def events(env):
    return [json.loads(line) for line in env.evidence.read_text(encoding="utf-8").splitlines()]


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _physical_rows(memory):
    rows = copy.deepcopy(memory.store.catalog.all())
    identities = [row["id"] for row in rows]
    assert all(isinstance(identity, str) and identity for identity in identities)
    assert len(identities) == len(set(identities))
    return {row["id"]: row for row in rows}


def _assert_layout(memory, baseline, expected_physical, expected_active, record, phase):
    rows = _physical_rows(memory)
    actual_active = [row["id"] for row in memory.list_confirmed_memories_page(limit=200)["memories"]]
    baseline_matches = all(identity in rows and _digest(rows[identity]) == digest
                           for identity, digest in baseline.items())
    physical_matches = set(rows) == set(expected_physical)
    active_matches = actual_active == list(expected_active)
    # Bounded per-case XML metadata: no identity text or complete row values.
    record("summary_fixture_" + phase, json.dumps({
        "baselineCount": len(baseline), "physicalCount": len(rows),
        "expectedPhysicalCount": len(expected_physical), "activeCount": len(actual_active),
        "expectedActiveCount": len(expected_active), "baselineRecordsMatch": baseline_matches,
        "physicalIdsMatch": physical_matches, "activeIdsAndOrderMatch": active_matches,
        "physicalIdsSha256": _digest(sorted(rows)), "activeIdsSha256": _digest(actual_active),
    }, sort_keys=True))
    assert baseline_matches, "initial identity records changed"
    assert physical_matches, "physical record identity set changed"
    assert active_matches, "active confirmed identities or order changed"
    assert len(rows) == len(expected_physical)
    return rows


@pytest.fixture
def environment(tmp_path, record_property):
    root = tmp_path.resolve()
    clear_storage_key_for_testing()
    install_storage_key(os.urandom(32))
    memory = None
    kernel = None
    try:
        memory = manager(root / "data")
        initial = _physical_rows(memory)
        envelope = memory.persona.identity_envelope
        identity_only = bool(initial) and all(
            row["source_type"] == "persona_identity"
            and row["retention_layer"] == "permanent"
            and row["confirmation_state"] == "observed"
            and row["lifecycle_state"] == "active"
            and row["source_hash"] == envelope.fingerprint
            and row["source_uri"] == f"reverie-persona://{envelope.persona_id}/{envelope.version}"
            for row in initial.values())
        record_property("summary_fixture_initialization", json.dumps({
            "baselineCount": len(initial), "allRowsAreCurrentPersonaIdentity": identity_only,
            "baselineIdsSha256": _digest(sorted(initial)),
        }, sort_keys=True))
        assert identity_only, "initial catalog is not exclusively current persona identity records"
        baseline = {identity: _digest(row) for identity, row in initial.items()}
        _assert_layout(memory, baseline, set(baseline), [], record_property, "initial")
        assert not memory.store.catalog.list_candidates(status="all", limit=1)
        evidence = root / "p1-memory-metadata.jsonl"
        bootstrap.seed(memory, root, evidence, 1)
        seeded = memory.list_confirmed_memories_page(limit=200)["memories"]
        seed_ids = [row["id"] for row in seeded]
        assert len(seed_ids) == len(set(seed_ids)) == 130
        assert [row["fact_key"] for row in seeded] == [f"isolated_memory:{n:03d}" for n in range(130, 0, -1)]
        assert set(seed_ids).isdisjoint(baseline)
        physical_seed = set(baseline) | set(seed_ids)
        _assert_layout(memory, baseline, physical_seed, seed_ids, record_property, "seeded")
        bootstrap.prepare_batch_delete_fixture(memory, root, evidence, 1)
        _assert_layout(memory, baseline, physical_seed, seed_ids, record_property, "pinned")
        # Reproduce the original paging edit, which retains seed106 as a
        # superseded confirmed revision and adds its active replacement.
        old_revision = next(row for row in memory.list_confirmed_memories_page(limit=200)["memories"]
                            if row["text"] == bootstrap.seeded_text(106))
        corrected = memory.correct_confirmed_memory(old_revision["id"], "隔离记忆第106条：星图标记·已改")["memory"]
        assert corrected and corrected["id"] != old_revision["id"]
        assert memory.store.catalog.get(old_revision["id"])["lifecycle_state"] == "superseded"
        assert corrected["id"] not in physical_seed
        before_delete_ids = [corrected["id"], *[identity for identity in seed_ids if identity != old_revision["id"]]]
        physical_revised = physical_seed | {corrected["id"]}
        revised = _assert_layout(memory, baseline, physical_revised, before_delete_ids, record_property, "revised")
        assert revised[old_revision["id"]]["confirmation_state"] == "confirmed"
        assert revised[corrected["id"]]["confirmation_state"] == "confirmed"
        assert revised[corrected["id"]]["lifecycle_state"] == "active"
        assert revised[corrected["id"]]["supersedes_id"] == old_revision["id"]
        assert revised[corrected["id"]]["fact_key"] == revised[old_revision["id"]]["fact_key"] == "isolated_memory:106"
        targets = next(row["targetIds"] for row in events(SimpleNamespace(evidence=evidence))
                       if row["event"] == "batch_delete_prepared")
        assert len(targets) == len(set(targets)) == 3
        assert set(targets) <= set(seed_ids)
        assert set(targets).isdisjoint(set(baseline) | {old_revision["id"], corrected["id"]})
        assert [revised[identity]["fact_key"] for identity in targets] == ["isolated_memory:130", "isolated_memory:129", "isolated_memory:127"]
        assert all(sum(row["fact_key"] == revised[identity]["fact_key"] for row in revised.values()) == 1
                   for identity in targets)
        expected_physical = physical_revised - set(targets)
        expected_active = [identity for identity in before_delete_ids if identity not in targets]
        assert len(expected_physical) == len(baseline) + 130 + 1 - 3
        assert len(expected_active) == 127
        kernel = KernelStore(root / "data/kernel.sqlite3")
        registry = PersonaEpochRegistry()
        token = registry.activate_initial(default_persona())
        store = SummaryStore(kernel, token)
        # Thirteen real committed exchanges produce the fixed 39 canonical
        # messages, including the complete three-message first source.
        for index in range(13):
            exchange(kernel, index, persona=token.persona_id, conversation="dream-room",
                     text=f"private synthetic user {index}",
                     bubbles=[f"private synthetic reply {index}", "private synthetic second bubble"])
        settings = _Settings()
        policy = UsagePolicy(lambda: settings, save_callback=lambda _: None)
        adapter = SimpleNamespace(settings=settings.llm, usage_policy=policy,
                                  chat=MagicMock(side_effect=AssertionError("fixture must never call a model")))
        runtime = ConversationSummaryRuntime(store, adapter, registry=registry, token=token,
                                            enabled=lambda: settings.features.hypa_compression_enabled)
        scope = {"persona_id": token.persona_id, "persona_epoch": token.epoch,
                 "persona_fingerprint": token.fingerprint}
        bridge = SimpleNamespace(bridge_state=SimpleNamespace(kernel_store=kernel, memory=memory),
                                 _summary_runtime=lambda: runtime, _active_persona_scope=lambda: dict(scope))
        yield SimpleNamespace(root=root, evidence=evidence, memory=memory, kernel=kernel, registry=registry,
                              token=token, store=store, settings=settings, policy=policy, adapter=adapter,
                              runtime=runtime, scope=scope, bridge=bridge,
                              superseded_id=old_revision["id"], corrected_id=corrected["id"],
                              targets=targets, baseline=baseline, expected_physical=expected_physical,
                              expected_physical_count=len(baseline) + 130 + 1 - 3,
                              expected_active=expected_active, record=record_property)
        # Also cover the observer case, whose real dispatch wrapper bypasses
        # batch(). This is one manager lifetime, not a cross-restart equality.
        final_rows = _physical_rows(memory)
        baseline_matches = all(identity in final_rows and _digest(final_rows[identity]) == digest
                               for identity, digest in baseline.items())
        record_property("summary_fixture_final_identity", json.dumps({
            "baselineCount": len(baseline), "baselineRecordsMatch": baseline_matches,
        }, sort_keys=True))
        assert baseline_matches, "initial identity records changed before fixture cleanup"
    finally:
        if memory is not None:
            memory.store.close()
        if kernel is not None:
            kernel.close()
        clear_storage_key_for_testing()


def message(env, command, request="summary-fixture-request-01", **payload):
    return {"type": command, "request_id": request, "payload": {
        "expected_persona_id": env.scope["persona_id"], "expected_persona_epoch": env.scope["persona_epoch"],
        "expected_persona_fingerprint": env.scope["persona_fingerprint"], **payload}}


def batch(env):
    request = message(env, "memory:delete_many", "registered-batch-request-01", memory_ids=list(env.targets))
    result = env.memory.delete_confirmed_memories(env.targets)
    assert result["ok"] is True and result["deleted_ids"] == env.targets and result["purged_revisions"] == 3
    _assert_layout(env.memory, env.baseline, env.expected_physical, env.expected_active, env.record, "deleted")
    return request, result


def seed(env, request, result, cycle=1):
    fixture.seed_after_batch(env.bridge, env.root, env.evidence, cycle, request, result, bootstrap.record)


def summary_counts(env):
    with env.kernel.transaction() as connection:
        return tuple(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                     for table in ("conversation_summary_attempts", "conversation_summary_items"))


def test_context_requires_explicit_true_and_excludes_candidate_paging(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    data = root / "owned"
    (data / "data").mkdir(parents=True)
    endpoint = "http://127.0.0.1:44021/v1"
    (data / "data/config.json").write_text(json.dumps({"llm": {"provider": "ollama", "base_url": endpoint}}))
    context = root / "context.json"
    context.touch(mode=0o600)
    identity = lambda path: {"path": str(path), "uid": path.stat().st_uid,
                             "device": str(path.stat().st_dev), "inode": str(path.stat().st_ino)}
    registered = {"schema": "reverie.qt.isolation.v1", "root": identity(root), "data": identity(data),
                  "p1_memory": {"endpoint": endpoint, **bootstrap.REGISTERED}}
    monkeypatch.setattr(bootstrap, "os", SimpleNamespace(getuid=os.getuid,
        environ={"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                 "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                 "PYTHON_DOTENV_DISABLED": "1"}, fstat=lambda _: SimpleNamespace(st_mode=stat.S_IFIFO)))

    def validate(paging=False):
        context.write_text(json.dumps(registered))
        return bootstrap.validate_context(context, data, endpoint, data / "p1-memory-metadata.jsonl", 1, paging)

    assert validate() is False
    registered["p1_memory"]["summaryView"] = True
    assert validate() is True
    registered["p1_memory"].update(bootstrap.PAGING_REGISTERED)
    with pytest.raises(ValueError, match="not registered"):
        validate(True)
    for invalid in (False, 1, "true", None):
        registered["p1_memory"] = {"endpoint": endpoint, **bootstrap.REGISTERED, "summaryView": invalid}
        with pytest.raises(ValueError, match="not registered"):
            validate()


def test_seed_is_late_canonical_atomic_and_metadata_only(environment):
    env = environment
    assert env.runtime.detail("dream-room", fixture.SUMMARY_ID) is None
    request = message(env, "memory:delete_many", "registered-batch-request-01", memory_ids=env.targets)
    with pytest.raises(ValueError, match="successful first-cycle"):
        seed(env, request, {"ok": False})
    assert summary_counts(env) == (0, 0)
    request, result = batch(env)
    listed = env.memory.list_confirmed_memories_page(limit=200)["memories"]
    listed_ids = [row["id"] for row in listed]
    assert len(listed_ids) == 127 and env.superseded_id not in listed_ids and env.corrected_id in listed_ids
    assert len(env.memory.store.catalog.all()) == env.expected_physical_count
    original_request, original_result = copy.deepcopy(request), copy.deepcopy(result)
    seed(env, request, result)
    _assert_layout(env.memory, env.baseline, env.expected_physical, env.expected_active, env.record, "summary_seeded")
    saved = env.runtime.detail("dream-room", fixture.SUMMARY_ID)
    assert saved and saved.text == fixture.BODY and saved.origin == "generated" and saved.active
    assert request == original_request and result == original_result
    with env.kernel.transaction() as connection:
        first = env.store._exchanges(connection, "dream-room")[0]
    assert saved.source_ids == tuple(row.message_id for row in first)
    assert (saved.source_first_sequence, saved.source_last_sequence) == (1, 3)
    event = events(env)[-1]
    assert event["event"] == "summary_view_seeded" and event["causeRequestId"] == request["request_id"]
    assert event["messageCount"] == 39 and event["memoryCount"] == 127
    assert event["sourceMessageCount"] == 3
    assert event["bodySha256"] == hashlib.sha256(fixture.BODY.encode()).hexdigest()
    assert event["bodyCharacters"] == len(fixture.BODY)
    assert all(event[name] is True for name in ("messageIdsUnchanged", "memoryIdsUnchanged",
        "kernelNonSummaryUnchanged", "memoryTablesUnchanged", "otherSummaryTablesUnchanged", "beforeAfterMatches"))
    assert all(event[name] is False for name in ("enabled", "grantEnabled", "grantAcknowledged", "policyAllowed", "naturalGeneration"))
    assert event["snapshots"]["before"]["messageIdsSha256"] == event["snapshots"]["after"]["messageIdsSha256"]
    # Active pagination and the complete durable table are different facts:
    # The initialized identity rows plus 127 active confirmed records and one
    # superseded revision all remain represented in the complete row hash.
    snapshots = event["snapshots"]
    assert snapshots["before"]["memoryCount"] == snapshots["after"]["memoryCount"] == 127
    assert snapshots["before"]["memoryTables"]["memory_records"]["count"] == env.expected_physical_count
    assert snapshots["before"]["memoryTables"] == snapshots["after"]["memoryTables"]
    assert snapshots["before"]["memoryIdsSha256"] == snapshots["after"]["memoryIdsSha256"] == fixture._ordered_ids_digest(listed_ids)
    trace = env.evidence.read_text(encoding="utf-8")
    assert all(secret not in trace for secret in (fixture.BODY, fixture.MARKER, "private synthetic", env.token.persona_id,
                                                 env.token.fingerprint, str(env.root), "source_json", "messageIds\""))
    assert env.evidence.stat().st_mode & 0o077 == 0
    env.adapter.chat.assert_not_called()
    with pytest.raises(ValueError, match="duplicate or foreign"):
        seed(env, request, result)
    assert summary_counts(env) == (1, 1)
    assert sum(row["event"] == "summary_view_seeded" for row in events(env)) == 1


def test_seed_refuses_wrong_batch_owner_counts_and_grants(environment):
    env = environment
    request, result = batch(env)
    wrong = copy.deepcopy(request)
    wrong["payload"]["memory_ids"][0] = "unregistered-private-id"
    with pytest.raises(ValueError, match="does not match registration"):
        seed(env, wrong, result)
    with pytest.raises(ValueError, match="first-cycle"):
        seed(env, request, result, cycle=2)
    real_path = env.kernel.path
    env.kernel.path = env.root.parent / "outside.sqlite3"
    try:
        with pytest.raises((ValueError, FileNotFoundError)):
            seed(env, request, result)
    finally:
        env.kernel.path = real_path
    env.settings.ai_usage.conversation_summary.api_cost_acknowledged = True
    with pytest.raises(ValueError, match="disabled ungranted"):
        seed(env, request, result)
    env.settings.ai_usage.conversation_summary.api_cost_acknowledged = False
    with env.kernel.transaction() as connection:
        connection.execute("DELETE FROM messages WHERE rowid=(SELECT MAX(rowid) FROM messages)")
    with pytest.raises(ValueError, match="original chat archive backup"):
        seed(env, request, result)
    assert summary_counts(env) == (0, 0)


def test_incomplete_first_source_and_failed_insert_roll_back_both_tables(environment):
    env = environment
    request, result = batch(env)
    with env.kernel.transaction() as connection:
        connection.execute("UPDATE command_ledger SET state='accepted' WHERE request_id=(SELECT request_id FROM messages WHERE rowid=1)")
    with pytest.raises(ValueError, match="first exchange is incomplete"):
        seed(env, request, result)
    assert summary_counts(env) == (0, 0)
    with env.kernel.transaction() as connection:
        connection.execute("UPDATE command_ledger SET state='committed' WHERE request_id=(SELECT request_id FROM messages WHERE rowid=1)")
        connection.execute("""CREATE TEMP TRIGGER reject_fixture_item BEFORE INSERT ON conversation_summary_items
            BEGIN SELECT RAISE(ABORT,'synthetic fixture rollback'); END""")
    with pytest.raises(Exception, match="synthetic fixture rollback"):
        seed(env, request, result)
    assert summary_counts(env) == (0, 0)
    assert not any(row["event"] == "summary_view_seeded" for row in events(env))


def test_observer_keeps_recall_and_status_separate_then_reads_existing_once_each_cycle(environment, monkeypatch):
    env = environment
    calls = []

    async def original(received, endpoint, *, emit_result=True):
        calls.append((copy.deepcopy(received), endpoint, emit_result))
        if received["type"] == "memory:delete_many":
            return env.memory.delete_confirmed_memories(received["payload"]["memory_ids"])
        if received["type"] == "summary:status":
            return {"ok": True, "operation": "status", **env.runtime.status("dream-room"), **env.scope}
        if received["type"] == "summary:get":
            saved = env.runtime.detail("dream-room", received["payload"]["summary_id"])
            assert saved is not None
            return {"ok": True, "operation": "detail", "conversation_id": "dream-room", **env.scope,
                    "summary": {"summary_id": saved.id, "text": saved.text, "sourceDigest": saved.source_digest,
                                "firstSequence": saved.source_first_sequence, "lastSequence": saved.source_last_sequence,
                                "messageIds": list(saved.source_ids), "contractVersion": saved.contract_version}}
        return {"ok": True, "memories": ["private recall marker"], "retrieval": {"mode": "lexical_fallback",
            "reason": "model_unavailable", "indexPending": 127}}

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original)
    monkeypatch.setattr(ws_bridge, "_summary_runtime", env.bridge._summary_runtime)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", env.bridge._active_persona_scope)
    monkeypatch.setattr(ws_bridge, "bridge_state", env.bridge.bridge_state)
    endpoint = object()
    detail = message(env, "summary:get", summary_id=fixture.SUMMARY_ID)
    status = message(env, "summary:status", "summary-status-request-01")
    recall = message(env, "memory:query", "summary-recall-request-01", query="星图标记")
    for cycle in (1, 2):
        undo_recall = bootstrap.install_query_observer(env.evidence, cycle)
        undo_summary = fixture.install_summary_view_observer(env.root, env.evidence, cycle, bootstrap.record)
        try:
            if cycle == 1:
                with pytest.raises(ValueError, match="before the late"):
                    asyncio.run(ws_bridge.dispatch_authenticated_message(detail, endpoint))
                assert summary_counts(env) == (0, 0)
                # The pre-existing archive check toggles generation before
                # the late fixture exists. Its enabled status passes through
                # unchanged, without strict consent checks or new evidence.
                env.settings.features.hypa_compression_enabled = True
                trace_before = env.evidence.read_text(encoding="utf-8")
                status_before = copy.deepcopy(status)
                preseed = asyncio.run(ws_bridge.dispatch_authenticated_message(status, endpoint, emit_result=False))
                assert preseed["enabled"] is True and preseed["authorized"] is False
                assert status == status_before and calls[-1] == (status, endpoint, False)
                assert env.evidence.read_text(encoding="utf-8") == trace_before
                env.settings.features.hypa_compression_enabled = False
                request = message(env, "memory:delete_many", "registered-batch-request-01", memory_ids=env.targets)
                asyncio.run(ws_bridge.dispatch_authenticated_message(request, endpoint))
            asyncio.run(ws_bridge.dispatch_authenticated_message(recall, endpoint))
            asyncio.run(ws_bridge.dispatch_authenticated_message(status, endpoint))
            before = copy.deepcopy(detail)
            result = asyncio.run(ws_bridge.dispatch_authenticated_message(detail, endpoint, emit_result=False))
            assert detail == before and result["summary"]["text"] == fixture.BODY
            with pytest.raises(ValueError, match="exactly one summary body"):
                asyncio.run(ws_bridge.dispatch_authenticated_message(detail, endpoint))
        finally:
            undo_summary()
            undo_summary()
            undo_recall()
    rows = events(env)
    assert len([row for row in rows if row["event"] == "summary_view_seeded"]) == 1
    assert [row["cycle"] for row in rows if row["event"] == "summary_view_restart_validated"] == [2]
    assert [row["cycle"] for row in rows if row["event"] == "summary_view_dispatched"] == [1, 2]
    assert [row["cycle"] for row in rows if row["event"] == "recall_query_dispatched"] == [1, 2]
    results = [row for row in rows if row["event"] == "summary_view_result"]
    assert all(row["readCount"] == 1 and all(row[name] is True for name in (
        "ok", "operationMatches", "idMatches", "fixtureMatches", "sourceMatches", "statusMatches", "scopeMatches"))
        for row in results)
    directory = [row for row in rows if row["event"] == "summary_view_status_result"]
    assert [row["fixturePresent"] for row in directory] == [True, True]
    assert all(row["resultEnabled"] is False and row["resultAuthorized"] is False and row["resultStatusDisabled"] is True
               for row in directory)
    assert sum(item[0]["type"] == "summary:get" for item in calls) == 2
    assert calls[-1][2] is False and summary_counts(env) == (1, 1)
    assert ws_bridge.dispatch_authenticated_message is original
    assert all(secret not in env.evidence.read_text() for secret in (fixture.BODY, "private recall marker", "private synthetic"))
    env.adapter.chat.assert_not_called()


def test_restart_refuses_corrupt_existing_fixture_without_seeding(environment, monkeypatch):
    env = environment
    request, result = batch(env)
    seed(env, request, result)
    with env.kernel.transaction() as connection:
        connection.execute("UPDATE conversation_summary_items SET source_digest=?", ("0" * 64,))
    calls = []

    async def original(*args, **kwargs):
        calls.append(args)
        return {"ok": False}

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original)
    monkeypatch.setattr(ws_bridge, "_summary_runtime", env.bridge._summary_runtime)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", env.bridge._active_persona_scope)
    monkeypatch.setattr(ws_bridge, "bridge_state", env.bridge.bridge_state)
    undo = fixture.install_summary_view_observer(env.root, env.evidence, 2, bootstrap.record)
    try:
        with pytest.raises(ValueError, match="source is not valid"):
            asyncio.run(ws_bridge.dispatch_authenticated_message(message(env, "summary:get", summary_id=fixture.SUMMARY_ID), object()))
    finally:
        undo()
    assert calls == [] and summary_counts(env) == (1, 1)
    assert not any(row["event"] == "summary_view_restart_validated" for row in events(env))
