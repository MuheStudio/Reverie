from __future__ import annotations

import importlib.util
import asyncio
import copy
import json
from pathlib import Path

import pytest

from src.config.settings import FeatureSettings, MemorySettings
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p1_memory_fixture", ROOT / "native-ui/tests/p1_memory_backend_bootstrap.py")
fixture = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(fixture)


def manager(directory: Path) -> MemoryManager:
    return MemoryManager(
        default_persona(),
        MemorySettings(lancedb_path=str(directory / "vectors"), sqlite_path=str(directory / "memory.db")),
        feature_settings=FeatureSettings(autonomous_memory_enabled=False),
    )


def events(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "p1-memory-metadata.jsonl").read_text().splitlines()]


def test_registered_texts_match_the_native_check():
    texts = [fixture.seeded_text(n) for n in range(1, fixture.SEEDED_MEMORIES + 1)]
    assert fixture.seeded_text(1) == "隔离记忆第001条：窗外的夜色"
    assert fixture.seeded_text(7) == "隔离记忆第007条：星图标记第1处"
    assert fixture.seeded_text(106) == "隔离记忆第106条：星图标记第10处"
    assert fixture.seeded_text(128) == "隔离记忆第128条：星图标记第12处"
    assert sum("星图标记" in text for text in texts) == fixture.MARKED_MEMORIES == 12
    # The ordinary flow finds its own chat candidate by this word.
    assert not any("喜欢" in text for text in texts + [fixture.PENDING_CANDIDATE])
    assert len(set(texts)) == 130


def test_first_cycle_confirms_in_order_and_leaves_one_candidate(tmp_path):
    root = tmp_path.resolve()
    memory = manager(root / "data")
    fixture.seed(memory, root, root / "p1-memory-metadata.jsonl", 1)

    first = memory.list_confirmed_memories_page(limit=100)
    assert [row["text"] for row in first["memories"]] == [fixture.seeded_text(n) for n in range(130, 30, -1)]
    rest = memory.list_confirmed_memories_page(limit=100, cursor=first["next_cursor"])
    assert [row["text"] for row in rest["memories"]] == [fixture.seeded_text(n) for n in range(30, 0, -1)]
    assert rest["has_more"] is False
    marked = memory.list_confirmed_memories_page(limit=100, query="星图标记")
    assert [row["text"] for row in marked["memories"]] == [
        fixture.seeded_text(n) for n in range(130, 0, -1) if n % 11 == 7]
    pending = memory.list_memory_candidates(status="pending", limit=10)
    assert [c["proposed_text"] for c in pending] == [fixture.PENDING_CANDIDATE]

    (seeded,) = events(root)
    assert seeded["event"] == "memories_seeded"
    assert [seeded[k] for k in ("confirmed", "marked", "pending", "strictly_increasing")] == [130, 12, 1, True]
    # Metadata only: no memory text reaches the evidence file.
    trace = (root / "p1-memory-metadata.jsonl").read_text(encoding="utf-8")
    assert "隔离" not in trace and str(root) not in trace
    assert (root / "p1-memory-metadata.jsonl").stat().st_mode & 0o077 == 0
    memory.store.close()


def test_paging_texts_are_independent_and_do_not_match_old_selectors():
    texts = [fixture.paging_candidate_text(n) for n in range(1, 131)]
    original = {fixture.seeded_text(n) for n in range(1, 131)} | {fixture.PENDING_CANDIDATE}
    assert len(set(texts)) == fixture.PAGING_CANDIDATES == 130
    assert not original.intersection(texts)
    assert all("喜欢" not in text and "星图标记" not in text for text in texts)
    with pytest.raises(ValueError, match="out of range"):
        fixture.paging_candidate_text(0)
    with pytest.raises(ValueError, match="out of range"):
        fixture.paging_candidate_text(131)


def test_paging_extension_keeps_old_seed_event_and_appends_only_older_pending(tmp_path):
    root = tmp_path.resolve()
    memory = manager(root / "data")
    evidence = root / "p1-memory-metadata.jsonl"
    fixture.seed(memory, root, evidence, 1)
    confirmed = memory.list_confirmed_memories_page(limit=200)["memories"]
    ordinary_event = events(root)[0]
    fixture.seed_paging_candidates(memory, root, evidence, 1)
    assert events(root)[0] == ordinary_event
    assert ordinary_event["pending"] == 1
    assert memory.list_confirmed_memories_page(limit=200)["memories"] == confirmed

    first = memory.list_memory_candidates_page(limit=100)
    assert first["ok"] is True and first["status"] == "pending" and first["has_more"] is True
    assert first["next_cursor"].startswith("mc1.")
    assert [row["proposed_text"] for row in first["candidates"]] == [fixture.PENDING_CANDIDATE] + [
        fixture.paging_candidate_text(n) for n in range(130, 31, -1)]
    start = first["next_cursor"]
    tail = memory.list_memory_candidates_page(limit=100, cursor=start)
    assert [row["proposed_text"] for row in tail["candidates"]] == [
        fixture.paging_candidate_text(n) for n in range(31, 0, -1)]
    assert tail["has_more"] is False and tail["next_cursor"] is None
    added = events(root)[1]
    assert [added[key] for key in ("cycle", "event", "appended", "pending", "uniqueIds",
                                  "olderThanOrdinaryCandidate", "descendingCreatedAtId")] == [
        1, "candidate_paging_seeded", 130, 131, 130, True, True]
    assert set(added) == {"schema", "event", "cycle", "monotonic_ns", "appended", "pending", "uniqueIds",
                          "olderThanOrdinaryCandidate", "descendingCreatedAtId"}
    assert "隔离" not in evidence.read_text() and "mc1." not in evidence.read_text()
    assert str(root) not in evidence.read_text()
    row_ids = {row["proposed_text"]: row["id"] for row in first["candidates"] + tail["candidates"]}
    confirmed_id = row_ids[fixture.paging_candidate_text(30)]
    rejected_id = row_ids[fixture.paging_candidate_text(29)]
    committed = memory.confirm_memory_candidate(confirmed_id)["memory"]
    after_confirm = memory.list_memory_candidates_page(limit=100, cursor=start)
    assert [row["proposed_text"] for row in after_confirm["candidates"]] == [
        fixture.paging_candidate_text(n) for n in range(31, 0, -1) if n != 30]
    assert len(after_confirm["candidates"]) == 30 and after_confirm["has_more"] is False
    memory.reject_memory_candidate(rejected_id)
    after_reject = memory.list_memory_candidates_page(limit=100, cursor=start)
    assert [row["proposed_text"] for row in after_reject["candidates"]] == [
        fixture.paging_candidate_text(n) for n in range(31, 0, -1) if n not in (30, 29)]
    assert len(after_reject["candidates"]) == 29 and after_reject["has_more"] is False
    assert committed["id"] not in {row["id"] for row in confirmed}
    assert memory.delete_confirmed_memory(committed["id"])["deleted"] is True
    assert memory.list_confirmed_memories_page(limit=200)["memories"] == confirmed
    # Production memory deletion purges that fact's candidate evidence too.
    assert confirmed_id not in {row["id"] for row in memory.list_memory_candidates(status="all", limit=1000)}
    memory.reject_memory_candidate(row_ids[fixture.PENDING_CANDIDATE])
    frozen = memory.list_memory_candidates(status="pending", limit=1000)
    assert [row["proposed_text"] for row in frozen] == [
        fixture.paging_candidate_text(n) for n in range(130, 0, -1) if n not in (30, 29)]
    frozen_ids = [row["id"] for row in frozen]
    memory.store.close()
    restarted = manager(root / "data")
    restart_first = restarted.list_memory_candidates_page(limit=100)
    restart_tail = restarted.list_memory_candidates_page(limit=100, cursor=restart_first["next_cursor"])
    assert [row["proposed_text"] for row in restart_first["candidates"]] == [
        fixture.paging_candidate_text(n) for n in range(130, 30, -1)]
    assert [row["proposed_text"] for row in restart_tail["candidates"]] == [
        fixture.paging_candidate_text(n) for n in range(28, 0, -1)]
    assert [row["id"] for row in restart_first["candidates"] + restart_tail["candidates"]] == frozen_ids
    assert len(frozen_ids) == 128 and len(events(root)) == 2
    restarted.store.close()


def test_paging_extension_requires_the_old_seed_and_the_first_cycle(tmp_path):
    root = tmp_path.resolve()
    memory = manager(root / "data")
    evidence = root / "p1-memory-metadata.jsonl"
    with pytest.raises(ValueError, match="unchanged ordinary memory seed"):
        fixture.seed_paging_candidates(memory, root, evidence, 1)
    fixture.seed(memory, root, evidence, 1)
    with pytest.raises(ValueError, match="first isolated cycle"):
        fixture.seed_paging_candidates(memory, root, evidence, 2)
    fixture.seed_paging_candidates(memory, root, evidence, 1)
    with pytest.raises(ValueError, match="unchanged ordinary memory seed"):
        fixture.seed_paging_candidates(memory, root, evidence, 1)
    assert len(events(root)) == 2
    memory.store.close()


def test_paging_install_seeds_only_the_first_manager_of_cycle_one(tmp_path):
    root = tmp_path.resolve()
    undo = fixture.install_seed(root, root / "p1-memory-metadata.jsonl", 1, candidate_paging=True)
    try:
        first = manager(root / "first")
        second = manager(root / "second")
    finally:
        undo()
    assert len(first.list_memory_candidates(status="pending", limit=1000)) == 131
    assert second.list_memory_candidates(status="all", limit=1) == []
    undo = fixture.install_seed(root, root / "p1-memory-metadata.jsonl", 2, candidate_paging=True)
    try:
        restart = manager(root / "restart")
    finally:
        undo()
    assert restart.list_memory_candidates(status="all", limit=1) == []
    assert [event["cycle"] for event in events(root) if event["event"] == "candidate_paging_seeded"] == [1]
    for current in (first, second, restart):
        current.store.close()


def test_a_used_store_and_a_store_outside_isolation_are_refused(tmp_path):
    root = tmp_path.resolve()
    memory = manager(root / "data")
    fixture.seed(memory, root, root / "p1-memory-metadata.jsonl", 1)
    with pytest.raises(ValueError, match="fresh memory store"):
        fixture.seed(memory, root, root / "p1-memory-metadata.jsonl", 1)
    memory.store.close()

    outside = manager(root / "elsewhere")
    with pytest.raises(ValueError, match="outside isolation"):
        fixture.seed(outside, root / "isolated", root / "p1-memory-metadata.jsonl", 1)
    assert outside.list_confirmed_memories_page(limit=1)["memories"] == []
    outside.store.close()


def test_only_the_first_manager_of_the_first_cycle_is_seeded(tmp_path):
    root = tmp_path.resolve()
    undo = fixture.install_seed(root, root / "p1-memory-metadata.jsonl", 1)
    try:
        first = manager(root / "first")
        second = manager(root / "second")
    finally:
        undo()
    assert len(first.list_confirmed_memories_page(limit=200)["memories"]) == 130
    assert second.list_confirmed_memories_page(limit=1)["memories"] == []
    first.store.close()
    second.store.close()

    undo = fixture.install_seed(root, root / "p1-memory-metadata.jsonl", 2)
    try:
        restart = manager(root / "restart")
    finally:
        undo()
    assert restart.list_confirmed_memories_page(limit=1)["memories"] == []
    assert [e["cycle"] for e in events(root) if e["event"] == "memories_seeded"] == [1]
    restart.store.close()


def test_query_observer_counts_only_queries_and_retains_no_content(tmp_path, monkeypatch):
    from src.bridge import ws_bridge

    root = tmp_path.resolve()
    evidence = root / "p1-memory-metadata.jsonl"
    scope = {"persona_id": "isolated-persona", "persona_epoch": 4, "persona_fingerprint": "a" * 64}
    endpoint = object()
    calls = []
    result = {"memories": ["私密结果·星图标记"], "retrieval": {
        "mode": "lexical_fallback", "reason": "model_unavailable", "indexPending": 130}}

    async def original(message, received_endpoint, *, emit_result=True):
        calls.append((message, received_endpoint, emit_result))
        return result

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    query = {"type": "memory:query", "request_id": "recall-request-123", "payload": {
        "query": "星图标记", "top_k": 20,
        "expected_persona_id": scope["persona_id"], "expected_persona_epoch": scope["persona_epoch"],
        "expected_persona_fingerprint": scope["persona_fingerprint"]}}
    before = copy.deepcopy(query)
    undo = fixture.install_query_observer(evidence, 2)
    wrapped = ws_bridge.dispatch_authenticated_message
    try:
        assert asyncio.run(wrapped({"type": "memory:list", "payload": {}}, endpoint)) is result
        assert not evidence.exists()
        assert asyncio.run(wrapped(query, endpoint, emit_result=False)) is result
    finally:
        undo()
    undo()  # The observer has a bounded, idempotently restored process lifetime.
    assert ws_bridge.dispatch_authenticated_message is original
    assert query == before
    assert calls[-1] == (query, endpoint, False)
    dispatch, received = events(root)
    assert dispatch["event"] == "recall_query_dispatched"
    assert received["event"] == "recall_query_result"
    assert all(event["cycle"] == event["stage"] == 2 and event["requestId"] == "recall-request-123"
               and event["scopeMatches"] is True for event in (dispatch, received))
    assert dispatch["queryCharacters"] == 4 and dispatch["markerMatches"] is True
    assert [received[key] for key in ("resultStrings", "resultCount", "resultCharacters", "markerMatches",
                                      "mode", "reason", "indexPending")] == [
        True, 1, len(result["memories"][0]), True, "lexical_fallback", "model_unavailable", 130]
    trace = evidence.read_text(encoding="utf-8")
    assert all(secret not in trace for secret in ("私密结果", "星图标记", "isolated-persona", "a" * 64, str(root)))
    assert evidence.stat().st_mode & 0o077 == 0
    assert set(received) == {"schema", "event", "cycle", "monotonic_ns", "stage", "requestId", "resultStrings",
                             "resultCount", "resultCharacters", "markerMatches", "mode", "reason", "indexPending", "scopeMatches"}
    asyncio.run(ws_bridge.dispatch_authenticated_message(query, endpoint))
    assert len(events(root)) == 2


def test_reply_start_observer_records_bounded_decisions_without_changing_them(tmp_path, monkeypatch):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    root = tmp_path.resolve()
    evidence = root / "p1-memory-metadata.jsonl"
    plans = iter([ReplyStartPlan(0.0, 0.96, "online", "available_now"),
                  ReplyStartPlan(41.25, 0.96, "online", "online_wobble"),
                  ReplyStartPlan(5.0, 0.5, "private-status", "private-reason"),
                  None])
    seen = []

    def original(text):
        seen.append(text)
        return next(plans)

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo = fixture.install_reply_start_observer(evidence, 1)
    wrapped = ws_bridge._reply_start_planner
    try:
        first = wrapped("组合记录：私密正文")
        second = wrapped("组合记录：私密正文")
        third = wrapped("x")
        fourth = wrapped("y")
    finally:
        undo()
    undo()
    assert ws_bridge._reply_start_planner is original
    assert seen == ["组合记录：私密正文", "组合记录：私密正文", "x", "y"]
    assert (first.start_delay, second.start_delay, third.reason, fourth) == (0.0, 41.25, "private-reason", None)
    rows = events(root)
    assert [row["event"] for row in rows] == ["reply_start_planned"] * 4
    assert [(row["startDelayMs"], row["immediate"], row["status"], row["reason"]) for row in rows] == [
        (0, True, "online", "available_now"), (41250, False, "online", "online_wobble"),
        (5000, False, "", ""), (None, False, "", "")]
    assert [row["planned"] for row in rows] == [True, True, True, False]
    assert rows[0]["textCharacters"] == len("组合记录：私密正文") and rows[1]["probability"] == 0.96
    assert all(set(row) == {"schema", "event", "cycle", "monotonic_ns", "planned", "textCharacters",
                            "startDelayMs", "immediate", "probability", "status", "reason"} for row in rows)
    trace = evidence.read_text(encoding="utf-8")
    assert all(secret not in trace for secret in ("私密正文", "private-status", "private-reason", str(root)))
    assert evidence.stat().st_mode & 0o077 == 0


def test_registered_chat_turns_match_the_gui_sources():
    sources = "".join((ROOT / path).read_text(encoding="utf-8") for path in (
        "native-ui/src/main.cpp", "native-ui/tests/MoonroomInteractionCheck.cpp"))
    assert len(set(fixture.REGISTERED_CHAT_TURNS)) == 5
    assert all(f'"{text}"' in sources for text in fixture.REGISTERED_CHAT_TURNS)
    assert [fixture.registered_chat_stage(text, 1) for text in fixture.REGISTERED_CHAT_TURNS] == [1, 2, 3, 4, 5]
    assert [fixture.registered_chat_stage(text, 2) for text in fixture.REGISTERED_CHAT_TURNS] == [0] * 5
    assert fixture.registered_chat_stage("停止记录 ", 1) == fixture.registered_chat_stage(None, 1) == 0


def test_registered_reply_start_zeroes_only_the_wait_of_first_registered_turns(tmp_path, monkeypatch):
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    root = tmp_path.resolve()
    evidence = root / "p1-memory-metadata.jsonl"
    combined = fixture.REGISTERED_CHAT_TURNS[4]
    wobble = ReplyStartPlan(41.25, 0.96, "online", "online_wobble")
    plans = iter([wobble, ReplyStartPlan(30.0, 0.96, "online", "online_wobble"), wobble, None, wobble])
    seen = []

    def original(text):
        seen.append(text)
        return next(plans)

    monkeypatch.setattr(ws_bridge, "_reply_start_planner", original)
    undo_override = fixture.install_registered_reply_start(evidence, 1)
    undo_observer = fixture.install_reply_start_observer(evidence, 1)
    wrapped = ws_bridge._reply_start_planner
    try:
        first = wrapped(combined)
        unregistered = wrapped("组合记录：私密正文")
        repeated = wrapped(combined)
        unplanned = wrapped(fixture.REGISTERED_CHAT_TURNS[3])
    finally:
        undo_observer()
        undo_override()
    undo_override()
    assert ws_bridge._reply_start_planner is original
    assert seen == [combined, "组合记录：私密正文", combined, fixture.REGISTERED_CHAT_TURNS[3]]
    assert (first.start_delay, first.immediate_probability, first.status, first.reason) == (
        0.0, 0.96, "online", fixture.FIXTURE_REPLY_START_REASON)
    assert unregistered.start_delay == 30.0 and repeated is wobble and unplanned is None

    undo_second = fixture.install_registered_reply_start(evidence, 2)
    try:
        assert ws_bridge._reply_start_planner(combined) is wobble
    finally:
        undo_second()
    assert ws_bridge._reply_start_planner is original

    rows = events(root)
    assert [row["event"] for row in rows] == [
        "reply_start_fixture_override", "reply_start_planned", "reply_start_planned",
        "reply_start_fixture_override", "reply_start_planned",
        "reply_start_fixture_override", "reply_start_planned"]
    overrides = [row for row in rows if row["event"] == "reply_start_fixture_override"]
    assert [(row["stage"], row["repeated"], row["fixtureOverride"], row["appliedDelayMs"],
             row["productionPlanned"], row["productionStartDelayMs"], row["productionImmediate"],
             row["productionReason"]) for row in overrides] == [
        (5, False, True, 0, True, 41250, False, "online_wobble"),
        (5, True, False, 41250, True, 41250, False, "online_wobble"),
        (4, False, False, None, False, None, False, "")]
    assert all(set(row) == {"schema", "event", "cycle", "monotonic_ns", "stage", "repeated", "fixtureOverride",
                            "appliedDelayMs", "productionPlanned", "productionStartDelayMs", "productionImmediate",
                            "productionProbability", "productionStatus", "productionReason"} for row in overrides)
    planned = [row for row in rows if row["event"] == "reply_start_planned"]
    assert [(row["startDelayMs"], row["immediate"], row["reason"]) for row in planned] == [
        (0, True, fixture.FIXTURE_REPLY_START_REASON), (30000, False, "online_wobble"),
        (41250, False, "online_wobble"), (None, False, "")]
    assert all(row["cycle"] == 1 for row in rows)
    trace = evidence.read_text(encoding="utf-8")
    assert all(secret not in trace for secret in ("私密正文", "组合记录", "停止记录", str(root)))
    assert evidence.stat().st_mode & 0o077 == 0


def test_query_observer_preserves_failures_and_redacts_unknown_metadata(tmp_path, monkeypatch):
    from src.bridge import ws_bridge

    root = tmp_path.resolve()
    evidence = root / "p1-memory-metadata.jsonl"
    failure = RuntimeError("private failure body")
    result = {"memories": ["private result body"], "retrieval": {
        "mode": "private-mode-body", "reason": "private-reason-body", "indexPending": True}}
    should_fail = False

    async def original(message, endpoint, *, emit_result=True):
        if should_fail:
            raise failure
        return result

    monkeypatch.setattr(ws_bridge, "dispatch_authenticated_message", original)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: {})
    undo = fixture.install_query_observer(evidence, 1)
    try:
        query = {"type": "memory:query", "request_id": "invalid private id!", "payload": {"query": "private query body"}}
        assert asyncio.run(ws_bridge.dispatch_authenticated_message(query, object())) is result
        received = events(root)[1]
        assert [received[key] for key in ("mode", "reason", "indexPending", "requestId")] == ["unknown", "", None, ""]
        should_fail = True
        with pytest.raises(RuntimeError) as caught:
            asyncio.run(ws_bridge.dispatch_authenticated_message(query, object()))
        assert caught.value is failure
    finally:
        undo()
    assert [event["event"] for event in events(root)] == [
        "recall_query_dispatched", "recall_query_result", "recall_query_dispatched"]
    assert "private" not in evidence.read_text(encoding="utf-8")


def test_batch_delete_fixture_pins_one_unmarked_fact_without_changing_order(tmp_path):
    root = tmp_path.resolve()
    memory = manager(root / "data")
    try:
        fixture.seed(memory, root, root / "p1-memory-metadata.jsonl", 1)
        before = memory.list_confirmed_memories_page(limit=200)["memories"]
        fixture.prepare_batch_delete_fixture(memory, root, root / "p1-memory-metadata.jsonl", 1)
        after = memory.list_confirmed_memories_page(limit=200)["memories"]
        assert [row["id"] for row in after] == [row["id"] for row in before]
        event = events(root)[-1]
        assert event["targetNumbers"] == [130, 129, 127]
        assert event["pinnedNumber"] == 130 and event["modelRequests"] == 0
        chosen = [next(row for row in after if row["id"] == ident) for ident in event["targetIds"]]
        assert [row["text"] for row in chosen] == [fixture.seeded_text(n) for n in (130, 129, 127)]
        assert [bool(row["pinned"]) for row in chosen] == [True, False, False]
        assert not any("星图标记" in row["text"] or "喜欢" in row["text"] for row in chosen)
        result = memory.delete_confirmed_memories(event["targetIds"])
        assert result["ok"] is True
        remaining = memory.list_confirmed_memories_page(limit=200)["memories"]
        assert [row["id"] for row in remaining] == [row["id"] for row in before if row["id"] not in event["targetIds"]]
        assert len(remaining) == 127
    finally:
        memory.store.close()
