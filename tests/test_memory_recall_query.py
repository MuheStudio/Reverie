"""Deterministic query-only recall contracts; no model loader is invoked."""

from __future__ import annotations

import asyncio
import copy
import json
from types import SimpleNamespace

import numpy as np
import pytest

from src.bridge import ws_bridge
from src.memory.catalog import MemoryCatalog
from src.memory.embedding import EmbeddingUnavailable
from src.memory.layers import MemoryLayers
from src.memory.manager import MemoryManager
from src.memory.versioned_store import VersionedVectorStore


FIXED_TIME = 2_000_000_000.0
MODEL_VERSION = "fixture-space:2"


def _row(memory_id: str, text: str, *, layer: str = "long_term", importance: float = 0.5) -> dict:
    return {
        "id": memory_id,
        "text": text,
        "layer": layer,
        "cognitive_layer": "semantic",
        "timestamp": FIXED_TIME,
        "importance": importance,
        "mention_count": 1,
        "access_count": 0,
        "last_accessed": FIXED_TIME - 100,
        "emotions": {},
        "trust_level": "trusted_local",
        "lifecycle_state": "active",
    }


FIXED_ROWS = [
    _row("name", "My name is Reverie.", layer="permanent", importance=1.0),
    _row("profile", "用户档案：偏好折纸", layer="permanent", importance=1.0),
    _row("alpha", "  orbit amber  ", importance=0.8),
    _row("beta", "orbit cobalt 🛰️", importance=0.4),
    _row("duplicate", "orbit cobalt!", importance=0.3),
    _row("unrelated", "garden fern", importance=0.9),
    {**_row("web", "orbit secret", importance=1.0), "trust_level": "untrusted_web"},
]

# Fixed expectations from c3147e8's rules and fixture inputs, including original
# whitespace, Unicode, ordering, and term deduplication. Never derive these from
# query_recall (or use a new result as the expected value for the old API).
PRECHANGE_VECTOR = [
    "My name is Reverie.", "用户档案：偏好折纸", "orbit cobalt 🛰️", "  orbit amber  ",
]
PRECHANGE_LEXICAL = [
    "My name is Reverie.", "用户档案：偏好折纸", "  orbit amber  ", "orbit cobalt 🛰️",
]


class RecordingCatalog:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = copy.deepcopy(rows)
        self._connection = None
        self.permanent_calls: list[tuple[str, int]] = []
        self.candidate_calls: list[tuple[str, int, bool]] = []
        self.get_calls: list[str] = []
        self.count_calls: list[str] = []
        self.touch_calls: list[list[str]] = []
        self.pending = 7
        self.pending_error: Exception | None = None
        self.candidate_error: Exception | None = None
        self.get_error: Exception | None = None
        self.vector_overrides: dict[str, dict] = {}

    def permanent_candidates(self, query: str, *, limit: int) -> list[dict]:
        self.permanent_calls.append((query, limit))
        return copy.deepcopy([row for row in self.rows if row["layer"] == "permanent"][:limit])

    def candidate_rows(self, query: str, limit: int, *, oldest_first: bool) -> list[dict]:
        self.candidate_calls.append((query, limit, oldest_first))
        if self.candidate_error is not None:
            raise self.candidate_error
        return copy.deepcopy(self.rows[:limit])

    def get(self, memory_id: str) -> dict | None:
        self.get_calls.append(memory_id)
        if self.get_error is not None:
            raise self.get_error
        if memory_id in self.vector_overrides:
            return copy.deepcopy(self.vector_overrides[memory_id])
        return next((copy.deepcopy(row) for row in self.rows if row["id"] == memory_id), None)

    def embedding_counts(self, version: str) -> tuple[int, int]:
        self.count_calls.append(version)
        if self.pending_error is not None:
            raise self.pending_error
        return 2, self.pending

    def touch_access(self, memory_ids) -> None:
        ids = list(memory_ids)
        self.touch_calls.append(ids)
        for row in self.rows:
            if row["id"] in ids:
                row["access_count"] += 1
                row["last_accessed"] = FIXED_TIME


class RecordingIndex:
    def __init__(self, memory_ids: tuple[str, ...]) -> None:
        self.memory_ids = memory_ids
        self.calls: list[dict] = []
        self.error: Exception | None = None

    def search(self, vector, **kwargs) -> list[dict]:
        self.calls.append({"vector": vector.copy(), **kwargs})
        if self.error is not None:
            raise self.error
        return [{"id": memory_id, "_distance": 0.1} for memory_id in self.memory_ids]


class QuietForgetting:
    minimum_retrieval_retention = 0.0

    @staticmethod
    def retention(_row: dict) -> float:
        return 1.0

    @staticmethod
    def retrieval_weight(_row: dict) -> float:
        return 1.0

    @staticmethod
    def apply_retrieval_noise(*_args, **_kwargs):
        raise AssertionError("query-only recall must not apply retrieval noise")


@pytest.fixture
def recall_factory(monkeypatch):
    monkeypatch.setattr("src.memory.manager.time.time", lambda: FIXED_TIME)
    monkeypatch.setattr("src.memory.manager.entity_boost_candidates", lambda *_args, **_kwargs: {})

    def make(*, rows=None, vector_ids=("beta", "alpha"), governance=True):
        catalog = RecordingCatalog(FIXED_ROWS if rows is None else rows)
        index = RecordingIndex(vector_ids)
        store = object.__new__(VersionedVectorStore)
        store.catalog = catalog
        store.runtime = SimpleNamespace(model_version=MODEL_VERSION, backend="fixture")
        store._sqlite_index = index
        embedding = SimpleNamespace(calls=[], error=None)

        def embed(query):
            embedding.calls.append(query)
            if embedding.error is not None:
                raise embedding.error
            return np.asarray([1.0, 0.0], dtype=np.float32)

        monkeypatch.setattr(store, "embed_query", embed)
        layers = object.__new__(MemoryLayers)
        layers.store = store
        memory = object.__new__(MemoryManager)
        memory.store = store
        memory.layers = layers
        memory.state_scope = None
        memory.settings = SimpleNamespace(memory_lifecycle_governance_enabled=governance)
        memory.forgetting = QuietForgetting()
        memory._last_memory_activity_at = 123.0
        memory._pending_injection = [{"id": "prior-turn", "text": "keep", "ts": 456.0}]
        return SimpleNamespace(memory=memory, catalog=catalog, index=index, embedding=embedding)

    return make


def _retrieval(mode: str, reason: str, pending=7) -> dict:
    return {"mode": mode, "reason": reason, "indexPending": pending}


def test_query_records_completed_vector_search_once(recall_factory) -> None:
    fixture = recall_factory()

    result = fixture.memory.query_recall("orbit", k=2)

    assert result == {
        "memories": PRECHANGE_VECTOR,
        "retrieval": _retrieval("hybrid", "vector_search_completed"),
    }
    assert fixture.embedding.calls == ["orbit"]
    assert len(fixture.index.calls) == 1
    assert fixture.index.calls[0]["k"] == 96
    assert fixture.catalog.get_calls == ["beta", "alpha"]
    assert fixture.catalog.count_calls == [MODEL_VERSION]


@pytest.mark.parametrize("empty_catalog", [False, True])
def test_completed_empty_vector_search_is_still_hybrid(recall_factory, empty_catalog) -> None:
    fixture = recall_factory(rows=[] if empty_catalog else FIXED_ROWS, vector_ids=())

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == ([] if empty_catalog else PRECHANGE_LEXICAL)
    assert result["retrieval"] == _retrieval("hybrid", "vector_search_completed")
    assert len(fixture.index.calls) == 1


def test_actual_embedding_unavailable_reports_model_fallback(recall_factory) -> None:
    fixture = recall_factory()
    fixture.embedding.error = EmbeddingUnavailable("fixture model absent")

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_LEXICAL
    assert result["retrieval"] == _retrieval("lexical_fallback", "model_unavailable")
    assert fixture.embedding.calls == ["orbit"]
    assert fixture.index.calls == []


def test_actual_missing_index_reports_index_fallback(recall_factory) -> None:
    fixture = recall_factory()
    fixture.memory.store._sqlite_index = None

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_LEXICAL
    assert result["retrieval"] == _retrieval("lexical_fallback", "index_unavailable")
    assert fixture.embedding.calls == ["orbit"]
    assert fixture.index.calls == []


def test_inner_swallowed_vector_error_remains_unknown(recall_factory) -> None:
    fixture = recall_factory()
    fixture.index.error = RuntimeError("fixture index failure")

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_LEXICAL
    assert result["retrieval"] == _retrieval("unknown", "vector_search_failed")
    assert len(fixture.index.calls) == 1


@pytest.mark.parametrize("failure", ["catalog_mapping", "text_mapping"])
def test_mapping_failure_cannot_claim_completed_vector_recall(recall_factory, failure) -> None:
    fixture = recall_factory()
    if failure == "catalog_mapping":
        fixture.catalog.get_error = OSError("fixture canonical mapping failure")
    else:
        fixture.catalog.vector_overrides["beta"] = {"id": "beta", "importance": 0.4}

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_LEXICAL
    assert result["retrieval"] == _retrieval("unknown", "retrieval_path_unverified")
    assert len(fixture.index.calls) == 1


def test_generic_embedding_failure_is_not_model_unavailable(recall_factory) -> None:
    fixture = recall_factory()
    fixture.embedding.error = RuntimeError("fixture inference failure")

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_LEXICAL
    assert result["retrieval"] == _retrieval("unknown", "retrieval_path_unverified")


def test_missing_vector_path_proof_stays_unknown(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    monkeypatch.setattr(fixture.memory.layers, "_search_all", lambda *_args, **_kwargs: [])

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_LEXICAL
    assert result["retrieval"] == _retrieval("unknown", "retrieval_path_unverified")


@pytest.mark.parametrize("path", ["vector", "model", "index", "vector_error"])
def test_pending_count_failure_does_not_change_path_evidence(recall_factory, path) -> None:
    fixture = recall_factory()
    expected = ("hybrid", "vector_search_completed")
    if path == "model":
        fixture.embedding.error = EmbeddingUnavailable("fixture absent")
        expected = ("lexical_fallback", "model_unavailable")
    elif path == "index":
        fixture.memory.store._sqlite_index = None
        expected = ("lexical_fallback", "index_unavailable")
    elif path == "vector_error":
        fixture.index.error = RuntimeError("fixture index failure")
        expected = ("unknown", "vector_search_failed")
    fixture.catalog.pending_error = OSError("fixture count failure")

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == (PRECHANGE_VECTOR if path == "vector" else PRECHANGE_LEXICAL)
    assert result["retrieval"] == _retrieval(*expected, pending=None)
    assert fixture.catalog.count_calls == [MODEL_VERSION]


@pytest.mark.parametrize("offered_pending,expected_pending", [
    (True, None), (False, None), (-1, None), (0.5, None), (7.0, None), ("7", None), (0, 0),
])
def test_pending_count_schema_does_not_change_memories_or_mode(recall_factory, offered_pending, expected_pending) -> None:
    fixture = recall_factory()
    fixture.catalog.pending = offered_pending

    result = fixture.memory.query_recall("orbit", k=2)

    assert result["memories"] == PRECHANGE_VECTOR
    assert result["retrieval"] == _retrieval("hybrid", "vector_search_completed", pending=expected_pending)
    assert fixture.catalog.count_calls == [MODEL_VERSION]


def test_query_observations_do_not_leak_between_invocations(recall_factory) -> None:
    fixture = recall_factory()
    first = fixture.memory.query_recall("orbit", k=2)
    fixture.embedding.error = EmbeddingUnavailable("fixture absent")
    second = fixture.memory.query_recall("orbit", k=2)
    fixture.embedding.error = None
    fixture.memory.store._sqlite_index = None
    third = fixture.memory.query_recall("orbit", k=2)
    fixture.memory.store._sqlite_index = fixture.index
    fixture.index.error = RuntimeError("fixture index failure")
    fourth = fixture.memory.query_recall("orbit", k=2)
    fixture.index.error = None
    fifth = fixture.memory.query_recall("orbit", k=2)

    assert [result["retrieval"] for result in (first, second, third, fourth, fifth)] == [
        _retrieval("hybrid", "vector_search_completed"),
        _retrieval("lexical_fallback", "model_unavailable"),
        _retrieval("lexical_fallback", "index_unavailable"),
        _retrieval("unknown", "vector_search_failed"),
        _retrieval("hybrid", "vector_search_completed"),
    ]
    assert fixture.embedding.calls == ["orbit"] * 5
    assert fixture.catalog.count_calls == [MODEL_VERSION] * 5


@pytest.mark.parametrize("governance", [False, True])
def test_public_search_and_query_keep_fixed_prechange_text_order_and_dedup(recall_factory, governance) -> None:
    fixture = recall_factory(governance=governance)

    assert fixture.memory.search("orbit", k=2) == PRECHANGE_VECTOR
    assert fixture.memory.query_recall("orbit", k=2)["memories"] == PRECHANGE_VECTOR
    assert fixture.catalog.rows == FIXED_ROWS
    assert fixture.catalog.touch_calls == []
    assert fixture.memory._last_memory_activity_at == 123.0
    assert fixture.memory._pending_injection == [{"id": "prior-turn", "text": "keep", "ts": 456.0}]


@pytest.mark.parametrize("governance", [False, True])
def test_native_ten_keeps_fixed_prechange_twenty_string_5400_codepoint_budget(recall_factory, governance) -> None:
    permanent = [
        _row(label, (prefix := f"My name is {label}.") + "🪐" * (180 - len(prefix)),
             layer="permanent", importance=1.0)
        for label in "ABCDEFGHIJ"
    ]
    related = [
        _row(f"r{number}", (prefix := f"orbit slot{number:02d} ") + "🪐" * (360 - len(prefix)),
             importance=1.0 - number * 0.05)
        for number in range(10)
    ]
    rows = [
        _row("oversize-permanent", "My name is Z." + "🪐" * 1800, layer="permanent", importance=1.0),
        *permanent,
        _row("oversize-related", "orbit oversized " + "🪐" * 3600, importance=1.0),
        *related,
    ]
    # Explicit baseline order: reverse permanent text order, then vector rank.
    expected = [row["text"] for row in reversed(permanent)] + [row["text"] for row in related]
    fixture = recall_factory(rows=rows, vector_ids=("oversize-related", *[f"r{i}" for i in range(10)]),
                             governance=governance)

    assert fixture.memory.search("orbit", k=10) == expected
    result = fixture.memory.query_recall("orbit", k=10)

    assert result["memories"] == expected
    assert len(result["memories"]) == 20
    assert sum(len(text) for text in result["memories"]) == 5400
    assert all(isinstance(text, str) for text in result["memories"])


def test_query_does_not_write_persisted_access_or_usage_counters(recall_factory, tmp_path) -> None:
    fixture = recall_factory(vector_ids=("alpha",))
    catalog = MemoryCatalog(tmp_path / "catalog.db")
    try:
        catalog.upsert(
            id="alpha", text="orbit amber", retention_layer="long_term", cognitive_layer="semantic",
            timestamp=FIXED_TIME, importance=0.8, emotions={}, embedding_model_version=MODEL_VERSION,
        )
        fixture.memory.store.catalog = catalog
        before = catalog.get("alpha")
        changes_before = catalog._connection.total_changes
        pending_before = fixture.memory._pending_injection

        result = fixture.memory.query_recall("orbit", k=10)

        assert result["memories"] == ["orbit amber"]
        assert catalog.get("alpha") == before
        assert catalog._connection.total_changes == changes_before
        assert fixture.memory._pending_injection is pending_before
        assert fixture.memory._last_memory_activity_at == 123.0
    finally:
        catalog.close()


def test_search_retains_public_retrieve_boundary_and_read_only_flags(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    calls = []
    expected = ["public boundary"]

    def retrieve(query, k=6, *, allow_fuzzy=True, record_access=True):
        calls.append((query, k, allow_fuzzy, record_access))
        return expected

    monkeypatch.setattr(fixture.memory, "retrieve_relevant", retrieve)

    assert fixture.memory.search("orbit", k=3) is expected
    assert calls == [("orbit", 3, False, False)]


def test_ordinary_retrieve_retains_public_layers_boundary(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    calls = []

    def search_all(query, k=8):
        calls.append((query, k))
        raise RuntimeError("ordinary public boundary")

    monkeypatch.setattr(fixture.memory.layers, "search_all", search_all)

    assert fixture.memory.retrieve_relevant("orbit", k=2, allow_fuzzy=False, record_access=False) == PRECHANGE_LEXICAL
    assert calls == [("orbit", 12)]


def test_ordinary_layers_search_retains_public_store_boundary(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    calls = []

    def search(vector, k=5):
        calls.append((vector.tolist(), k))
        return [{"text": "public vector boundary"}]

    monkeypatch.setattr(fixture.memory.store, "search", search)

    assert fixture.memory.layers.search_all("orbit", k=3) == ["public vector boundary"]
    assert calls == [([1.0, 0.0], 3)]


class CapturingSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))


def _authenticate(monkeypatch, ws, *, authenticated=True, controller=None) -> None:
    monkeypatch.setattr(ws_bridge, "_client_contexts", {
        ws: ws_bridge.BridgeClientContext("recall_controller", 4, authenticated=authenticated),
    })
    monkeypatch.setattr(ws_bridge, "_controller_ws", ws if controller is None else controller)


@pytest.mark.parametrize("permission", ["unregistered", "unauthenticated", "noncontroller"])
def test_query_requires_authenticated_controller_before_any_search_or_count(monkeypatch, recall_factory, permission) -> None:
    fixture = recall_factory()
    ws = CapturingSocket()
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", fixture.memory)
    if permission == "unregistered":
        monkeypatch.setattr(ws_bridge, "_client_contexts", {})
        monkeypatch.setattr(ws_bridge, "_controller_ws", ws)
    else:
        _authenticate(monkeypatch, ws, authenticated=permission != "unauthenticated",
                      controller=CapturingSocket() if permission == "noncontroller" else None)

    with pytest.raises(PermissionError, match="authenticated controller required"):
        asyncio.run(ws_bridge.handle_memory_query({"query": "orbit", "top_k": 2}, ws))

    assert fixture.catalog.permanent_calls == []
    assert fixture.catalog.candidate_calls == []
    assert fixture.embedding.calls == []
    assert fixture.index.calls == []
    assert fixture.catalog.count_calls == []
    assert fixture.catalog.touch_calls == []


def test_query_authorization_precedes_uninitialized_memory_check(monkeypatch) -> None:
    ws = CapturingSocket()
    monkeypatch.setattr(ws_bridge, "_client_contexts", {})
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", None)

    with pytest.raises(PermissionError, match="authenticated controller required"):
        asyncio.run(ws_bridge.handle_memory_query({"query": "orbit"}, ws))


def test_authenticated_query_returns_real_metadata_with_default_ten(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    ws = CapturingSocket()
    _authenticate(monkeypatch, ws)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", fixture.memory)

    result = asyncio.run(ws_bridge.handle_memory_query({"query": "orbit"}, ws))

    assert result == {"memories": PRECHANGE_VECTOR, "retrieval": _retrieval("hybrid", "vector_search_completed")}
    assert fixture.catalog.permanent_calls == [("orbit", 240)]
    assert fixture.catalog.candidate_calls == [("orbit", 300, False)]
    assert fixture.index.calls[0]["k"] == 320
    assert ws_bridge.response_type_for_request(ws_bridge.MsgType.MEMORY_QUERY) == ws_bridge.MsgType.MEMORY_RESULT


def test_overall_recall_failure_propagates_and_never_becomes_successful_empty(recall_factory) -> None:
    fixture = recall_factory()
    fixture.catalog.candidate_error = OSError("fixture canonical recall failure")

    with pytest.raises(OSError, match="canonical recall failure"):
        fixture.memory.query_recall("orbit", k=2)

    assert fixture.catalog.count_calls == []


def test_bridge_recall_failure_emits_error_instead_of_memory_result(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    fixture.catalog.candidate_error = OSError("fixture canonical recall failure")
    ws = CapturingSocket()
    _authenticate(monkeypatch, ws)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", fixture.memory)
    monkeypatch.setattr(ws_bridge.bridge_state, "runtime_unavailable", ())
    monkeypatch.setattr(ws_bridge.bridge_state, "persona_restart_required", False)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: {
        "persona_id": "fixture", "persona_epoch": 9, "persona_fingerprint": "a" * 64,
    })

    result = asyncio.run(ws_bridge.dispatch_authenticated_message({
        "type": ws_bridge.MsgType.MEMORY_QUERY,
        "request_id": "recall_failure_01",
        "payload": {"query": "orbit", "expected_persona_id": "fixture", "expected_persona_epoch": 9,
                    "expected_persona_fingerprint": "a" * 64},
    }, ws))

    assert result is None
    assert len(ws.sent) == 1
    assert ws.sent[0]["type"] == ws_bridge.MsgType.ERROR
    assert "memories" not in ws.sent[0]["payload"]
    assert fixture.catalog.count_calls == []


def test_dispatch_rejects_stale_persona_before_query_or_count(monkeypatch, recall_factory) -> None:
    fixture = recall_factory()
    ws = CapturingSocket()
    _authenticate(monkeypatch, ws)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", fixture.memory)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: {
        "persona_id": "fixture", "persona_epoch": 9, "persona_fingerprint": "a" * 64,
    })

    result = asyncio.run(ws_bridge.dispatch_authenticated_message({
        "type": ws_bridge.MsgType.MEMORY_QUERY,
        "payload": {"query": "orbit", "expected_persona_id": "fixture", "expected_persona_epoch": 8,
                    "expected_persona_fingerprint": "a" * 64},
    }, ws))

    assert result["code"] == "stale_persona"
    assert fixture.embedding.calls == []
    assert fixture.index.calls == []
    assert fixture.catalog.count_calls == []


@pytest.mark.parametrize("recovery_state", ["clean", "recovery_required"])
def test_scoped_query_keeps_existing_recovery_read_policy(monkeypatch, recall_factory, recovery_state) -> None:
    fixture = recall_factory()
    ws = CapturingSocket()
    _authenticate(monkeypatch, ws)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", fixture.memory)
    monkeypatch.setattr(ws_bridge.bridge_state, "backup_manager", None)
    monkeypatch.setattr(ws_bridge.bridge_state, "recovery_state", recovery_state)
    monkeypatch.setattr(ws_bridge.bridge_state, "runtime_unavailable", ())
    monkeypatch.setattr(ws_bridge.bridge_state, "persona_restart_required", False)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: {
        "persona_id": "fixture", "persona_epoch": 9, "persona_fingerprint": "a" * 64,
    })

    result = asyncio.run(ws_bridge.dispatch_authenticated_message({
        "type": ws_bridge.MsgType.MEMORY_QUERY,
        "request_id": "recall_scoped_01",
        "payload": {"query": "orbit", "top_k": 2, "expected_persona_id": "fixture",
                    "expected_persona_epoch": 9, "expected_persona_fingerprint": "a" * 64},
    }, ws))

    assert result == {"memories": PRECHANGE_VECTOR, "retrieval": _retrieval("hybrid", "vector_search_completed")}
    assert ws.sent[-1]["type"] == ws_bridge.MsgType.MEMORY_RESULT
