"""Synthetic coverage for bounded candidate review pages; no provider or model."""

import asyncio
import base64
import hashlib
import io
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.bridge.stdio_bridge import StdioController
from src.bridge.stdio_transport import MAX_FRAME_BYTES, encode_frame, read_frame
from src.config.settings import FeatureSettings, MemorySettings
from src.kernel.contracts import MemoryCandidateListPayload, MUTATING_COMMAND_NAMES
from src.memory import manager as manager_module
from src.memory.catalog import MemoryCatalog
from src.memory.manager import (
    MEMORY_CANDIDATE_PAGE_MAX_BYTES,
    MemoryManager,
    _decode_memory_candidate_cursor,
    _encode_memory_candidate_cursor,
    _encode_memory_list_cursor,
)


@pytest.fixture
def catalog(tmp_path):
    value = MemoryCatalog(tmp_path / "candidate-pages.db")
    yield value
    value.close()


def candidate_id(number: int) -> str:
    return f"mc_{number:032x}"


def seed(catalog, number: int, *, created_at=None, status="pending") -> str:
    text = f"候选分页证据 {number:03d}"
    row = catalog.create_candidate(
        fact_key=f"candidate-paging:{number}", proposed_text=text, source_text=text,
        source_type="user_statement", source_uri=f"synthetic:candidate:{number}",
        source_hash=hashlib.sha256(text.encode()).hexdigest(), confidence=1.0,
    )
    identifier = candidate_id(number)
    timestamp = 1000.0 + number if created_at is None else created_at
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_candidates SET id=?,created_at=? WHERE id=?",
                           (identifier, timestamp, row["id"]))
    if status == "confirmed":
        catalog.confirm_candidate(identifier, embedding_model_version="synthetic")
    elif status == "rejected":
        catalog.reject_candidate(identifier)
    return identifier


def make_manager(catalog, *, instance="a" * 32):
    # Explicitly initialize the normal constructor's nonce in this isolated fake.
    memory = object.__new__(MemoryManager)
    memory.state_scope = None
    memory._candidate_cursor_instance = instance
    memory.store = SimpleNamespace(
        catalog=catalog, runtime=SimpleNamespace(model_version="synthetic"),
    )
    memory._last_memory_activity_at = 123.0
    memory._pending_injection = [{"id": "prior-turn", "text": "unchanged", "ts": 456.0}]
    return memory


def ids(page):
    return [row["id"] for row in page["candidates"]]


def walk(memory, *, status="pending", limit=100):
    pages, cursor = [], None
    while True:
        page = memory.list_memory_candidates_page(status=status, limit=limit, cursor=cursor)
        assert page["ok"] is True
        assert page["status"] == status
        assert page["candidates"] or not page["has_more"]
        pages.append(page)
        if not page["has_more"]:
            assert page["next_cursor"] is None
            return pages
        assert page["next_cursor"] != cursor
        cursor = page["next_cursor"]


def raw_cursor(body: str) -> str:
    return "mc1." + base64.urlsafe_b64encode(body.encode()).decode().rstrip("=")


def cursor_value(**changes):
    return {"kind": "memory_candidates", "status": "pending", "instance": "a" * 32,
            "created_at": 1000.0, "id": candidate_id(1), **changes}


def test_pages_cover_pending_candidates_in_creation_order(catalog):
    for number in range(1, 251):
        seed(catalog, number)
    seed(catalog, 251, status="confirmed")
    seed(catalog, 252, status="rejected")
    pages = walk(make_manager(catalog))
    assert [len(page["candidates"]) for page in pages] == [100, 100, 50]
    listed = [identifier for page in pages for identifier in ids(page)]
    assert listed == [candidate_id(number) for number in range(250, 0, -1)]
    assert len(set(listed)) == 250
    assert set(pages[0]) == {"ok", "status", "candidates", "has_more", "next_cursor"}


def test_equal_creation_times_use_strict_id_boundary(catalog):
    for number in range(1, 8):
        seed(catalog, number, created_at=2000.0)
    seed(catalog, 8, created_at=1999.0)
    pages = walk(make_manager(catalog), limit=3)
    assert [len(page["candidates"]) for page in pages] == [3, 3, 2]
    assert [identifier for page in pages for identifier in ids(page)] == [
        *(candidate_id(number) for number in range(7, 0, -1)), candidate_id(8),
    ]


def test_insertions_between_pages_follow_the_value_boundary(catalog):
    for number in range(1, 7):
        seed(catalog, number)
    memory = make_manager(catalog)
    first = memory.list_memory_candidates_page(limit=2)
    seed(catalog, 7, created_at=9999.0)
    seed(catalog, 8, created_at=1004.5)
    second = memory.list_memory_candidates_page(limit=2, cursor=first["next_cursor"])
    third = memory.list_memory_candidates_page(limit=2, cursor=second["next_cursor"])
    fourth = memory.list_memory_candidates_page(limit=2, cursor=third["next_cursor"])
    assert [identifier for page in (first, second, third, fourth) for identifier in ids(page)] == [
        candidate_id(number) for number in (6, 5, 8, 4, 3, 2, 1)
    ]
    assert fourth["has_more"] is False
    assert ids(memory.list_memory_candidates_page(limit=2)) == [candidate_id(7), candidate_id(6)]


def test_decisions_between_pages_remove_only_the_decided_rows(catalog):
    for number in range(1, 7):
        seed(catalog, number)
    memory = make_manager(catalog)
    first = memory.list_memory_candidates_page(limit=2)
    memory.confirm_memory_candidate(candidate_id(4))
    memory.reject_memory_candidate(candidate_id(3))
    second = memory.list_memory_candidates_page(limit=2, cursor=first["next_cursor"])
    assert ids(first) + ids(second) == [candidate_id(number) for number in (6, 5, 2, 1)]
    assert second["has_more"] is False


@pytest.mark.parametrize("decision", ["confirmed", "rejected", "deleted"])
def test_cursor_does_not_require_its_boundary_row_to_exist(catalog, decision):
    for number in range(1, 6):
        seed(catalog, number)
    memory = make_manager(catalog)
    first = memory.list_memory_candidates_page(limit=2)
    boundary = first["candidates"][-1]["id"]
    if decision == "confirmed":
        memory.confirm_memory_candidate(boundary)
    elif decision == "rejected":
        memory.reject_memory_candidate(boundary)
    else:
        with catalog.transaction() as connection:
            connection.execute("DELETE FROM memory_candidates WHERE id=?", (boundary,))
    second = memory.list_memory_candidates_page(limit=2, cursor=first["next_cursor"])
    assert ids(second) == [candidate_id(3), candidate_id(2)]
    assert second["has_more"] is True


def test_rereading_the_same_page_start_fills_decided_slots(catalog):
    for number in range(1, 9):
        seed(catalog, number)
    memory = make_manager(catalog)
    first = memory.list_memory_candidates_page(limit=2)
    start = first["next_cursor"]
    current = memory.list_memory_candidates_page(limit=2, cursor=start)
    assert ids(current) == [candidate_id(6), candidate_id(5)]
    memory.confirm_memory_candidate(candidate_id(6))
    reread = memory.list_memory_candidates_page(limit=2, cursor=start)
    assert ids(reread) == [candidate_id(5), candidate_id(4)]
    memory.reject_memory_candidate(candidate_id(5))
    reread = memory.list_memory_candidates_page(limit=2, cursor=start)
    assert ids(reread) == [candidate_id(4), candidate_id(3)]
    assert reread["has_more"] is True
    assert ids(memory.list_memory_candidates_page(limit=2, cursor=reread["next_cursor"])) == [
        candidate_id(2), candidate_id(1),
    ]


def test_rereading_a_decided_final_page_returns_a_valid_empty_page(catalog):
    for number in range(1, 5):
        seed(catalog, number)
    memory = make_manager(catalog)
    first = memory.list_memory_candidates_page(limit=2)
    start = first["next_cursor"]
    assert ids(memory.list_memory_candidates_page(limit=2, cursor=start)) == [
        candidate_id(2), candidate_id(1),
    ]
    memory.confirm_memory_candidate(candidate_id(2))
    memory.reject_memory_candidate(candidate_id(1))
    assert memory.list_memory_candidates_page(limit=2, cursor=start) == {
        "ok": True, "status": "pending", "candidates": [], "has_more": False, "next_cursor": None,
    }


def test_empty_page_cannot_report_success_with_more_rows(catalog, monkeypatch):
    memory = make_manager(catalog)
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: ([], (1.0, candidate_id(1))))
    page = memory.list_memory_candidates_page()
    assert page["ok"] is False and page["error_code"] == "invalid_candidate_page"
    assert page["candidates"] == [] and page["has_more"] is False and page["next_cursor"] is None


@pytest.mark.parametrize("status", ["pending", "confirmed", "rejected", "all"])
def test_status_filters_have_independent_bound_cursors(catalog, status):
    for number in range(1, 7):
        seed(catalog, number, status=("pending", "confirmed", "rejected")[(number - 1) % 3])
    memory = make_manager(catalog)
    pages = walk(memory, status=status, limit=1)
    expected = [row["id"] for row in catalog.list_candidates(status=status)]
    assert [identifier for page in pages for identifier in ids(page)] == expected
    first = pages[0]
    assert first["next_cursor"].startswith("mc1.")
    assert len(first["next_cursor"]) <= 512
    wrong_status = "all" if status != "all" else "pending"
    invalid = memory.list_memory_candidates_page(status=wrong_status, cursor=first["next_cursor"])
    assert invalid["ok"] is False and invalid["error_code"] == "invalid_cursor"
    assert invalid["candidates"] == [] and invalid["has_more"] is False


def test_each_normal_manager_construction_invalidates_previous_cursors(catalog, monkeypatch, tmp_path):
    for number in range(1, 4):
        seed(catalog, number)
    monkeypatch.setattr(manager_module, "VersionedVectorStore", lambda **_kwargs: SimpleNamespace(
        catalog=catalog, count=lambda *_args: 0,
    ))
    monkeypatch.setattr(manager_module, "MemoryLayers", lambda *_args, **_kwargs: SimpleNamespace())
    monkeypatch.setattr(manager_module, "CognitiveDecaySystem", lambda *_args, **_kwargs: SimpleNamespace())
    monkeypatch.setattr("src.memory.fold_worker.FoldWorker", lambda *_args, **_kwargs: SimpleNamespace(
        set_catalog=lambda _catalog: None,
    ))
    settings = MemorySettings(lancedb_path=str(tmp_path / "vectors"), sqlite_path=str(tmp_path / "memory.db"))
    persona = SimpleNamespace(seal_identity=lambda: None)
    first_manager = MemoryManager(persona, settings, feature_settings=FeatureSettings())
    remounted_manager = MemoryManager(persona, settings, feature_settings=FeatureSettings())
    assert re.fullmatch(r"[a-f0-9]{32}", first_manager._candidate_cursor_instance)
    assert first_manager._candidate_cursor_instance != remounted_manager._candidate_cursor_instance
    first = first_manager.list_memory_candidates_page(limit=1)
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: pytest.fail("foreign cursor reached storage"))
    invalid = remounted_manager.list_memory_candidates_page(cursor=first["next_cursor"])
    assert invalid["ok"] is False and invalid["error_code"] == "invalid_cursor"


def test_missing_manager_instance_is_not_made_readable_by_a_fallback(catalog, monkeypatch):
    memory = make_manager(catalog)
    del memory._candidate_cursor_instance
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: pytest.fail("missing instance read storage"))
    with pytest.raises(AttributeError):
        memory.list_memory_candidates_page()


@pytest.mark.parametrize("changes", [
    {"kind": "memory_list"}, {"status": "all"}, {"instance": "b" * 32},
    {"instance": "a" * 31}, {"created_at": True}, {"created_at": "1000"},
    {"created_at": None}, {"created_at": float("nan")}, {"created_at": float("inf")},
    {"created_at": float("-inf")}, {"id": "mc_bad"}, {"id": "mc_" + "A" * 32},
    {"id": candidate_id(1) + "\n"}, {"id": 1}, {"extra": True},
])
def test_foreign_or_malformed_cursor_fields_fail_before_storage(catalog, monkeypatch, changes):
    memory = make_manager(catalog)
    token = raw_cursor(json.dumps(cursor_value(**changes), separators=(",", ":")))
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: pytest.fail("invalid cursor reached storage"))
    page = memory.list_memory_candidates_page(cursor=token)
    assert page["ok"] is False and page["error_code"] == "invalid_cursor"
    assert page["candidates"] == [] and page["has_more"] is False and page["next_cursor"] is None
    assert token not in json.dumps(page)


@pytest.mark.parametrize("token", [
    "", "mc1.", "mc1.!!!!", "mc2.e30", "mc1.a b", "mc1.e30=", "mc1.a", "mc1._w",
    "mc1." + "a" * 509, "v1.e30", raw_cursor("[]"), raw_cursor("{}"),
    raw_cursor('{"kind":"memory_candidates","kind":"memory_candidates","status":"pending",'
               '"instance":"' + "a" * 32 + '","created_at":1,"id":"' + candidate_id(1) + '"}'),
])
def test_invalid_cursor_encodings_and_exact_field_sets_are_rejected(catalog, monkeypatch, token):
    memory = make_manager(catalog)
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: pytest.fail("bad token read storage"))
    result = memory.list_memory_candidates_page(cursor=token)
    assert result["ok"] is False and result["error_code"] == "invalid_cursor"


def test_cursor_kind_is_separate_from_confirmed_memory_pagination(catalog):
    candidate_cursor = _encode_memory_candidate_cursor((1000.0, candidate_id(1)), "pending", "a" * 32)
    old_cursor = _encode_memory_list_cursor((1000.0, "fact_x"), "")
    assert _decode_memory_candidate_cursor(candidate_cursor, "pending", "a" * 32) == (1000.0, candidate_id(1))
    assert _decode_memory_candidate_cursor(old_cursor, "pending", "a" * 32) is None
    decoded = json.loads(base64.urlsafe_b64decode(candidate_cursor[4:] + "=" * (-len(candidate_cursor[4:]) % 4)))
    assert set(decoded) == {"kind", "status", "instance", "created_at", "id"}
    assert "source_text" not in decoded and "proposed_text" not in decoded


@pytest.mark.parametrize("timestamp", [True, float("nan"), float("inf"), float("-inf")])
def test_catalog_and_cursor_encoder_require_finite_numeric_boundaries(catalog, timestamp):
    with pytest.raises(ValueError):
        catalog.list_candidates_page(after=(timestamp, candidate_id(1)))
    with pytest.raises(ValueError):
        _encode_memory_candidate_cursor((timestamp, candidate_id(1)), "pending", "a" * 32)


def test_page_reads_do_not_write_or_refresh_memory_activity(catalog):
    for number in range(1, 5):
        seed(catalog, number)
    memory = make_manager(catalog)
    before_changes = catalog._connection.total_changes
    before_rows = catalog.list_candidates(status="all")
    before_injection = list(memory._pending_injection)
    statements = []
    catalog._connection.set_trace_callback(statements.append)
    try:
        first = memory.list_memory_candidates_page(limit=2)
        memory.list_memory_candidates_page(limit=2, cursor=first["next_cursor"])
    finally:
        catalog._connection.set_trace_callback(None)
    assert statements and all(statement.lstrip().upper().startswith("SELECT") for statement in statements)
    assert catalog._connection.total_changes == before_changes
    assert catalog.list_candidates(status="all") == before_rows
    assert memory._last_memory_activity_at == 123.0
    assert memory._pending_injection == before_injection
    assert "memory:candidates:list" not in MUTATING_COMMAND_NAMES
    assert "memory:candidates:list" in ws_bridge._RECOVERY_READ_COMMANDS
    assert "memory:candidates:list" in ws_bridge._PERSONA_SCOPED_COMMANDS


def test_persona_scope_is_checked_before_cursor_or_catalog(catalog, monkeypatch):
    memory = make_manager(catalog)
    def stale():
        raise PermissionError("synthetic stale scope")
    memory.state_scope = SimpleNamespace(require_current=stale)
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: pytest.fail("stale scope read storage"))
    with pytest.raises(PermissionError, match="synthetic stale scope"):
        memory.list_memory_candidates_page(cursor="mc1.bad")


class CaptureController(StdioController):
    def __init__(self):
        super().__init__()
        self.frames = []

    async def write(self, payload):
        self.frames.append(payload)


def test_multibyte_evidence_pages_fit_complete_production_frames(catalog):
    long_text = "🌌" * 2000
    long_source = "中文证据" * 1000
    long_uri = ('🌌"\\中' * 1024)[:4096]
    for number in range(1, 41):
        seed(catalog, number)
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_candidates SET proposed_text=?,source_text=?,source_uri=?",
                           (long_text, long_source, long_uri))
    pages = walk(make_manager(catalog), limit=200)
    assert len(pages) > 1 and 0 < len(pages[0]["candidates"]) < 40
    listed = []
    for page in pages:
        controller = CaptureController()
        assert asyncio.run(ws_bridge.send_to_frontend(
            controller, ws_bridge.MsgType.MEMORY_CANDIDATE_RESULT, page, request_id="r" * 128,
        )) is True
        assert len(controller.frames) == 1
        frame = controller.frames[0]
        compact = json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode()
        assert len(compact) <= MEMORY_CANDIDATE_PAGE_MAX_BYTES
        encoded = encode_frame(frame)
        assert len(encoded) - 4 == len(compact) <= 900_000 < MAX_FRAME_BYTES == 1024 * 1024
        assert read_frame(io.BytesIO(encoded)) == frame
        for row in page["candidates"]:
            assert row["proposed_text"] == long_text
            assert row["source_text"] == long_source
            assert row["source_uri"] == long_uri
        listed.extend(ids(page))
    assert listed == [candidate_id(number) for number in range(40, 0, -1)]


def test_single_oversized_candidate_returns_only_a_fixed_error(catalog):
    seed(catalog, 1)
    seed(catalog, 2)
    private_source = "仅合成超限来源🌌" * 100_000
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_candidates SET source_uri=? WHERE id=?",
                           (private_source, candidate_id(2)))
    result = make_manager(catalog).list_memory_candidates_page(limit=200)
    assert result == {"ok": False, "status": "pending", "candidates": [],
                      "has_more": False, "next_cursor": None,
                      "error_code": "candidate_page_too_large",
                      "error": "A memory candidate exceeds the response size limit"}
    serialized = json.dumps(result, ensure_ascii=False)
    assert "仅合成" not in serialized and candidate_id(2) not in serialized and "mc1." not in serialized


def test_byte_limit_resumes_before_an_oversized_row_without_skipping(catalog):
    for number in range(1, 4):
        seed(catalog, number)
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_candidates SET source_uri=? WHERE id=?",
                           ("界" * 400_000, candidate_id(2)))
    memory = make_manager(catalog)
    first = memory.list_memory_candidates_page(limit=200)
    assert first["ok"] is True and ids(first) == [candidate_id(3)] and first["has_more"] is True
    second = memory.list_memory_candidates_page(limit=200, cursor=first["next_cursor"])
    assert second["ok"] is False and second["error_code"] == "candidate_page_too_large"
    with catalog.transaction() as connection:
        connection.execute("UPDATE memory_candidates SET source_uri='' WHERE id=?", (candidate_id(2),))
    reread = memory.list_memory_candidates_page(limit=200, cursor=first["next_cursor"])
    assert ids(reread) == [candidate_id(2), candidate_id(1)] and reread["has_more"] is False


@pytest.mark.parametrize("bad_payload", [
    {"limit": 0}, {"limit": 201}, {"status": "unknown"}, {"cursor": "mc1."},
    {"cursor": "v1.e30"}, {"cursor": "mc1.a b"}, {"cursor": "mc1." + "a" * 509},
    {"extra": True},
])
def test_payload_contract_rejects_outside_bounds(bad_payload):
    with pytest.raises(ValidationError):
        MemoryCandidateListPayload.model_validate(bad_payload)


def test_payload_contract_preserves_defaults_and_optional_cursor():
    assert MemoryCandidateListPayload.model_validate({}).model_dump() == {
        "status": "pending", "limit": 100, "cursor": None,
    }
    token = _encode_memory_candidate_cursor((1.0, candidate_id(1)), "pending", "a" * 32)
    assert MemoryCandidateListPayload.model_validate({"cursor": token, "limit": 200}).cursor == token
    assert MemoryCandidateListPayload.model_validate({"cursor": None}).cursor is None


def test_generated_schema_matches_the_candidate_payload_contract():
    schema = json.loads((Path(__file__).resolve().parents[1]
                         / "config" / "protocol-v4.schema.json").read_text(encoding="utf-8"))
    assert schema["$defs"]["CommandPayloadsV4"]["memory:candidates:list"] == (
        MemoryCandidateListPayload.model_json_schema()
    )


def authorize(monkeypatch, controller):
    monkeypatch.setattr(ws_bridge, "_controller_ws", controller)
    monkeypatch.setitem(ws_bridge._client_contexts, controller, ws_bridge.BridgeClientContext(
        client_id="candidate_controller_01", protocol_version=4, authenticated=True,
        conversation_id="candidate_pages", persona_id="synthetic_persona",
    ))


@pytest.mark.parametrize("memory_available", [False, True])
def test_bridge_denies_non_controller_before_initialization_or_reads(monkeypatch, memory_available):
    class GuardedMemory:
        def __bool__(self):
            pytest.fail("unauthorized caller inspected memory initialization")
        def list_memory_candidates_page(self, **_kwargs):
            pytest.fail("unauthorized caller read candidates")
    controller, observer = object(), object()
    authorize(monkeypatch, controller)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", GuardedMemory() if memory_available else None)
    with pytest.raises(PermissionError, match="authenticated controller required"):
        asyncio.run(ws_bridge.handle_memory_candidate_list({}, observer))


def test_bridge_unauthenticated_controller_cannot_read_candidates(monkeypatch):
    controller = object()
    authorize(monkeypatch, controller)
    monkeypatch.setitem(ws_bridge._client_contexts, controller, ws_bridge.BridgeClientContext(
        client_id="candidate_controller_01", protocol_version=4, authenticated=False,
        conversation_id="candidate_pages", persona_id="synthetic_persona",
    ))
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", SimpleNamespace(
        list_memory_candidates_page=lambda **_kwargs: pytest.fail("unauthenticated read"),
    ))
    with pytest.raises(PermissionError):
        asyncio.run(ws_bridge.handle_memory_candidate_list({}, controller))


def test_bridge_passes_cursor_and_preserves_recovery_read_permission(catalog, monkeypatch):
    controller = object()
    authorize(monkeypatch, controller)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", make_manager(catalog))
    monkeypatch.setattr(ws_bridge, "recovery_status_payload", lambda: {"writes_blocked": True})
    for number in range(1, 4):
        seed(catalog, number)
    first = asyncio.run(ws_bridge.handle_memory_candidate_list({"limit": 1}, controller))
    second = asyncio.run(ws_bridge.handle_memory_candidate_list(
        {"status": "pending", "limit": 1, "cursor": first["next_cursor"]}, controller,
    ))
    assert ids(first) == [candidate_id(3)] and ids(second) == [candidate_id(2)]
    assert ws_bridge.command_preflight("memory:candidates:confirm")["code"] == "BACKUP_RECOVERY_REQUIRED"


def test_bridge_uninitialized_response_has_complete_page_shape(monkeypatch):
    controller = object()
    authorize(monkeypatch, controller)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", None)
    result = asyncio.run(ws_bridge.handle_memory_candidate_list({"status": "all"}, controller))
    assert result["ok"] is False and result["status"] == "all"
    assert result["candidates"] == [] and result["has_more"] is False and result["next_cursor"] is None


def test_dispatch_rejects_stale_persona_before_candidate_reads(catalog, monkeypatch):
    controller = CaptureController()
    authorize(monkeypatch, controller)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", make_manager(catalog))
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: {
        "persona_id": "synthetic_persona", "persona_epoch": 9, "persona_fingerprint": "a" * 64,
    })
    monkeypatch.setattr(catalog, "list_candidates_page", lambda **_kwargs: pytest.fail("stale persona read storage"))
    result = asyncio.run(ws_bridge.dispatch_authenticated_message({
        "type": "memory:candidates:list", "request_id": "candidate_stale_01",
        "payload": {"expected_persona_id": "synthetic_persona", "expected_persona_epoch": 8,
                    "expected_persona_fingerprint": "a" * 64},
    }, controller))
    assert result["ok"] is False and result["code"] == "stale_persona"
    assert len(controller.frames) == 1
    assert controller.frames[0]["frame"]["payload"]["code"] == "stale_persona"


def test_legacy_array_methods_keep_their_shape_order_and_limit(catalog):
    for number in range(1, 221):
        seed(catalog, number)
    memory = make_manager(catalog)
    old_catalog = catalog.list_candidates(status="pending", limit=220)
    old_manager = memory.list_memory_candidates(status="pending", limit=220)
    assert isinstance(old_catalog, list) and isinstance(old_manager, list)
    assert len(old_catalog) == len(old_manager) == 220
    assert old_manager == old_catalog
    assert [row["id"] for row in old_catalog] == [candidate_id(number) for number in range(220, 0, -1)]
    assert len(memory.list_memory_candidates()) == 100
    assert len(memory.list_memory_candidates_page(limit=220)["candidates"]) == 200
