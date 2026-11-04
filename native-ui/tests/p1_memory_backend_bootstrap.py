"""Two-cycle, owner-isolated memory paging fixture.

No production control enables this bootstrap. Inside the registered isolated
data directory the first cycle confirms 130 synthetic memories through the
backend's own candidate path, in order and each strictly later than the one
before, and leaves one synthetic candidate pending. Twelve memories carry the
filter marker. The second cycle seeds nothing. The evidence file holds counts
and timings only, never memory text.
"""
from __future__ import annotations

import argparse
import functools
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SEEDED_MEMORIES = 130
MARKED_MEMORIES = 12
PENDING_CANDIDATE = "隔离候选：待拒绝的星图"
REGISTERED = {"seededMemories": SEEDED_MEMORIES, "markedMemories": MARKED_MEMORIES, "pendingCandidates": 1}
PAGING_CANDIDATES = 130
PAGING_REGISTERED = {"candidatePaging": True, "pagingCandidates": PAGING_CANDIDATES}
# The five first-cycle chat turns the ordinary flow sends, in order; kept equal
# to native-ui/src/main.cpp and MoonroomInteractionCheck.cpp.
REGISTERED_CHAT_TURNS = (
    "你好，我喜欢和你一起看星空。",
    "阅读记录 1：请认真给我一份完整的项目说明",
    "阅读记录 2：请认真给我一份完整的项目说明",
    "停止记录",
    "组合记录：请认真给我一份完整的后续安排",
)
FIXTURE_REPLY_START_REASON = "isolated_memory_fixture"
REPLY_START_STATUSES = frozenset({"online", "busy", "away", "sleeping"})
REPLY_START_REASONS = frozenset({"available_now", "sleepy_reply", "busy_deferred", "away_deferred",
                                 "sleep_until_wake", "online_wobble"})


def paging_candidate_text(number: int) -> str:
    """Independent facts; neither the ordinary chat selector nor recall marker matches."""
    if not 1 <= number <= PAGING_CANDIDATES:
        raise ValueError("candidate fixture number out of range")
    return f"隔离分页候选第{number:03d}条：水面记录"


def seeded_text(number: int) -> str:
    """Kept equal to MemoryPageCheck::seededText; none of them says "喜欢"."""
    if number % 11 == 7:
        return f"隔离记忆第{number:03d}条：星图标记第{(number - 7) // 11 + 1}处"
    return f"隔离记忆第{number:03d}条：窗外的夜色"


def private_regular(path: Path, maximum: int):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum
            or path.resolve() != path):
        raise ValueError("invalid isolated fixture file")
    return info


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int, candidate_paging: bool = False):
    if cycle not in (1, 2) or not all(p.is_absolute() for p in (context, data, evidence)):
        raise ValueError("explicit absolute fixture arguments required")
    private_regular(context, 16384)
    registered = json.loads(context.read_text())
    memory_registration = registered.get("p1_memory")
    summary_view = isinstance(memory_registration, dict) and memory_registration.get("summaryView") is True
    if (registered.get("schema") != "reverie.qt.isolation.v1"
            or (candidate_paging and summary_view)
            or memory_registration != {"endpoint": endpoint, **REGISTERED,
                                       **(PAGING_REGISTERED if candidate_paging else {}),
                                       **({"summaryView": True} if summary_view else {})}
            or any(key in registered for key in ("p1_restore", "p1_persona", "p1_provider", "p0_tail"))
            or evidence != data / "p1-memory-metadata.jsonl"):
        raise ValueError("memory fixture not registered by isolated host")
    for key in ("root", "data"):
        expected = registered[key]; target = Path(expected["path"]); info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target
                or info.st_uid != os.getuid() or int(expected["uid"]) != info.st_uid
                or str(info.st_dev) != expected["device"] or str(info.st_ino) != expected["inode"]):
            raise ValueError("isolated directory identity mismatch")
    if data != Path(registered["data"]["path"]) or data.parent != Path(registered["root"]["path"]) or context.parent != data.parent:
        raise ValueError("fixture outside isolation")
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{4,5})/v1", endpoint)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise ValueError("owned model endpoint required")
    required = {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                "PYTHON_DOTENV_DISABLED": "1"}
    if any(os.environ.get(k) != v for k, v in required.items()) or not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("private encrypted desktop bootstrap required")
    settings = json.loads((data / "data/config.json").read_text()).get("llm", {})
    if settings.get("provider") != "ollama" or settings.get("base_url", "").rstrip("/") != endpoint:
        raise ValueError("fixture provider not the owned endpoint")
    if evidence.exists():
        private_regular(evidence, 65536)
    return summary_view


def record(evidence: Path, cycle: int, event: str, **fields):
    fd = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_regular(evidence, 65536)
        os.write(fd, (json.dumps({"schema": "reverie.qt.p1-memory-metadata.v1", "event": event,
                                 "cycle": cycle, "monotonic_ns": time.monotonic_ns(), **fields}) + "\n").encode())
    finally:
        os.close(fd)


def seed(manager, data: Path, evidence: Path, cycle: int):
    """Confirm the registered memories and leave the registered candidate pending."""
    catalog = manager.store.catalog
    if not Path(catalog.path).resolve().is_relative_to(data.resolve()):
        raise ValueError("memory store outside isolation")
    if catalog.list_confirmed_page(limit=1)[0] or catalog.list_candidates(status="all", limit=1):
        raise ValueError("memory fixture requires a fresh memory store")
    started = time.monotonic()
    for number in range(1, SEEDED_MEMORIES + 1):
        text = seeded_text(number)
        candidate = catalog.create_candidate(
            fact_key=f"isolated_memory:{number:03d}", proposed_text=text, source_text=text,
            source_type="user_statement", source_uri="", confidence=1.0,
            source_hash=hashlib.sha256(text.encode("utf-8")).hexdigest())
        manager.confirm_memory_candidate(candidate["id"])
    catalog.create_candidate(
        fact_key="isolated_memory:pending", proposed_text=PENDING_CANDIDATE, source_text=PENDING_CANDIDATE,
        source_type="user_statement", source_uri="", confidence=1.0,
        source_hash=hashlib.sha256(PENDING_CANDIDATE.encode("utf-8")).hexdigest())
    rows = [row for row in catalog.all() if row["confirmation_state"] == "confirmed"]
    rows.sort(key=lambda row: row["confirmed_at"])
    order = [row["text"] for row in rows]
    times = [row["confirmed_at"] for row in rows]
    strictly_increasing = all(later > earlier for earlier, later in zip(times, times[1:]))
    if order != [seeded_text(n) for n in range(1, SEEDED_MEMORIES + 1)] or not strictly_increasing:
        raise ValueError("seeded memories are not strictly ordered by confirmation")
    pending = catalog.list_candidates(status="pending", limit=10)
    record(evidence, cycle, "memories_seeded", confirmed=len(rows),
           marked=sum("星图标记" in text for text in order), pending=len(pending),
           strictly_increasing=strictly_increasing,
           embedding_pending=sum(row.get("embedding_status") == "pending" for row in rows),
           seconds=round(time.monotonic() - started, 3))


def prepare_batch_delete_fixture(manager, data: Path, evidence: Path, cycle: int):
    """Pin one of three unmarked seed facts; no RPC or model invocation.

    Only the ordinary memory mode uses this extension. Candidate paging keeps
    its original seed and 130-ID restart contract. Pinning does not reorder the
    confirmed_at keyset and is restored by the pre-existing backup flow.
    """
    if cycle != 1 or not Path(manager.store.catalog.path).resolve().is_relative_to(data.resolve()):
        raise ValueError("batch fixture outside first isolated cycle")
    numbers = (130, 129, 127)
    rows = manager.list_confirmed_memories_page(limit=200)["memories"]
    chosen = [next(row for row in rows if row["text"] == seeded_text(number)) for number in numbers]
    if any("星图标记" in row["text"] or "喜欢" in row["text"] for row in chosen):
        raise ValueError("batch fixture overlaps original checks")
    if manager.pin_memory(chosen[0]["id"]).get("ok") is not True:
        raise ValueError("batch fixture pin was not confirmed")
    record(evidence, cycle, "batch_delete_prepared", targetNumbers=list(numbers),
           targetIds=[row["id"] for row in chosen], pinnedNumber=130, modelRequests=0)


def seed_paging_candidates(manager, data: Path, evidence: Path, cycle: int):
    """Append only the explicitly registered older pending facts after the old seed event."""
    catalog = manager.store.catalog
    if cycle != 1 or not Path(catalog.path).resolve().is_relative_to(data.resolve()):
        raise ValueError("candidate paging seed outside first isolated cycle")
    pending_before = catalog.list_candidates(status="pending", limit=1000)
    if len(pending_before) != 1 or pending_before[0]["proposed_text"] != PENDING_CANDIDATE:
        raise ValueError("candidate paging requires the unchanged ordinary memory seed")
    created = []
    for number in range(1, PAGING_CANDIDATES + 1):
        text = paging_candidate_text(number)
        row = catalog.create_candidate(
            fact_key=f"isolated_candidate_paging:{number:03d}", proposed_text=text, source_text=text,
            source_type="user_statement", source_uri="", confidence=1.0,
            source_hash=hashlib.sha256(text.encode("utf-8")).hexdigest())
        # This isolated fixture controls only its own synthetic timestamps.
        # No wall-clock or timer granularity can change the known page boundary.
        with catalog.transaction() as connection:
            connection.execute("UPDATE memory_candidates SET created_at=?,updated_at=? WHERE id=?",
                               (1_000_000_000.0 + number, 1_000_000_000.0 + number, row["id"]))
        created.append(row["id"])
    pending = catalog.list_candidates(status="pending", limit=1000)
    expected = [PENDING_CANDIDATE] + [paging_candidate_text(n) for n in range(PAGING_CANDIDATES, 0, -1)]
    pairs = [(row["created_at"], row["id"]) for row in pending]
    if [row["proposed_text"] for row in pending] != expected or pairs != sorted(pairs, reverse=True):
        raise ValueError("candidate paging seed order mismatch")
    record(evidence, cycle, "candidate_paging_seeded", appended=len(created), pending=len(pending),
           uniqueIds=len(set(created)), olderThanOrdinaryCandidate=all(
               row["created_at"] < pending[0]["created_at"] for row in pending[1:]),
           descendingCreatedAtId=pairs == sorted(pairs, reverse=True))


def install_seed(data: Path, evidence: Path, cycle: int, candidate_paging: bool = False):
    """Seed once, into the first memory manager of the first cycle's process."""
    from src.memory.manager import MemoryManager
    original_init = MemoryManager.__init__
    state = {"constructed": 0}

    @functools.wraps(original_init)
    def init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        state["constructed"] += 1
        if cycle == 1 and state["constructed"] == 1:
            seed(self, data, evidence, cycle)
            if candidate_paging:
                seed_paging_candidates(self, data, evidence, cycle)
            else:
                prepare_batch_delete_fixture(self, data, evidence, cycle)

    MemoryManager.__init__ = init

    def undo():
        MemoryManager.__init__ = original_init
    return undo


def install_query_observer(evidence: Path, cycle: int):
    """Observe the already-authenticated query dispatch, without changing it.

    The seam is the same dispatcher used by the isolated stdio controller.
    It does not replace a handler, inspect an index, influence retrieval, or
    seed anything. Only bounded metadata leaves the call's local lifetime.
    """
    from src.bridge import ws_bridge

    original_dispatch = ws_bridge.dispatch_authenticated_message
    modes = {"hybrid", "lexical_fallback", "unknown"}
    reasons = {"vector_search_completed", "model_unavailable", "index_unavailable",
               "vector_search_failed", "retrieval_path_unverified"}

    @functools.wraps(original_dispatch)
    async def dispatch(message, endpoint, *, emit_result=True):
        if not isinstance(message, dict) or message.get("type") != "memory:query":
            return await original_dispatch(message, endpoint, emit_result=emit_result)
        payload = message.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        request_id = message.get("request_id")
        request_id = request_id if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id) else ""
        query = payload.get("query")
        query = query if isinstance(query, str) else ""
        active = ws_bridge._active_persona_scope()
        scope_matches = (isinstance(active.get("persona_id"), str) and bool(active["persona_id"])
                         and type(active.get("persona_epoch")) is int
                         and isinstance(active.get("persona_fingerprint"), str) and bool(active["persona_fingerprint"])
                         and all(payload.get(expected) == active.get(actual) for expected, actual in (
            ("expected_persona_id", "persona_id"), ("expected_persona_epoch", "persona_epoch"),
            ("expected_persona_fingerprint", "persona_fingerprint"))))
        record(evidence, cycle, "recall_query_dispatched", stage=cycle, requestId=request_id,
               queryCharacters=len(query), markerMatches=query == "星图标记", scopeMatches=scope_matches)
        result = await original_dispatch(message, endpoint, emit_result=emit_result)
        result_map = result if isinstance(result, dict) else {}
        rows = result_map.get("memories")
        strings = isinstance(rows, list) and all(isinstance(row, str) for row in rows)
        retrieval = result_map.get("retrieval")
        retrieval = retrieval if isinstance(retrieval, dict) else {}
        mode = retrieval.get("mode")
        reason = retrieval.get("reason")
        pending = retrieval.get("indexPending")
        record(evidence, cycle, "recall_query_result", stage=cycle, requestId=request_id,
               resultStrings=strings, resultCount=len(rows) if strings else 0,
               resultCharacters=sum(map(len, rows)) if strings else 0,
               markerMatches=any("星图标记" in row for row in rows) if strings else False,
               mode=mode if isinstance(mode, str) and mode in modes else "unknown",
               reason=reason if isinstance(reason, str) and reason in reasons else "",
               indexPending=pending if type(pending) is int and pending >= 0 else None,
               scopeMatches=scope_matches)
        return result

    ws_bridge.dispatch_authenticated_message = dispatch
    restored = False

    def undo():
        nonlocal restored
        if not restored:
            ws_bridge.dispatch_authenticated_message = original_dispatch
            restored = True
    return undo


def bounded_plan(result, reasons) -> dict:
    """Numbers and registered enums of one reply-start plan; nothing else."""
    delay = getattr(result, "start_delay", None)
    probability = getattr(result, "immediate_probability", None)
    status = getattr(result, "status", None)
    reason = getattr(result, "reason", None)
    finite = isinstance(delay, (int, float)) and not isinstance(delay, bool) and delay == delay and abs(delay) < 1e9
    return {"planned": result is not None,
            "startDelayMs": int(round(delay * 1000)) if finite else None,
            "immediate": finite and delay <= 0,
            "probability": round(float(probability), 4)
            if isinstance(probability, (int, float)) and not isinstance(probability, bool) else None,
            "status": status if isinstance(status, str) and status in REPLY_START_STATUSES else "",
            "reason": reason if isinstance(reason, str) and reason in reasons else ""}


def registered_chat_stage(text, cycle: int) -> int:
    return REGISTERED_CHAT_TURNS.index(text) + 1 if cycle == 1 and text in REGISTERED_CHAT_TURNS else 0


def install_registered_reply_start(evidence: Path, cycle: int):
    """Start the registered first-cycle chat turns without a presence wait.

    Production still plans every turn first and its decision is recorded. For a
    registered turn, seen for the first time in this cycle, only the wait
    before generation becomes zero; the plan's probability and status are
    kept and its reason names the fixture, so the trace never reads as a
    natural immediate start. Other texts, the second cycle and repeats keep
    the production plan. Model latency and bubble delivery are untouched.
    """
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    original_plan = ws_bridge._reply_start_planner
    seen: set[int] = set()

    @functools.wraps(original_plan)
    def plan(text):
        result = original_plan(text)
        stage = registered_chat_stage(text, cycle)
        if not stage:
            return result
        repeated = stage in seen
        seen.add(stage)
        override = not repeated and result is not None
        production = bounded_plan(result, REPLY_START_REASONS)
        record(evidence, cycle, "reply_start_fixture_override", stage=stage, repeated=repeated,
               fixtureOverride=override, appliedDelayMs=0 if override else production["startDelayMs"],
               **{"production" + key[0].upper() + key[1:]: value for key, value in production.items()})
        if not override:
            return result
        return ReplyStartPlan(0.0, result.immediate_probability, result.status, FIXTURE_REPLY_START_REASON)

    ws_bridge._reply_start_planner = plan
    restored = False

    def undo():
        nonlocal restored
        if not restored:
            ws_bridge._reply_start_planner = original_plan
            restored = True
    return undo


def install_reply_start_observer(evidence: Path, cycle: int):
    """Record each reply-start decision as bounded metadata, without changing it.

    The production planner may defer a reply at random (presence wobble). A GUI
    step that waits for that reply can then time out; this event lets the host
    report show the decision. No message text, scope or identity leaves here.
    """
    from src.bridge import ws_bridge

    original_plan = ws_bridge._reply_start_planner
    reasons = REPLY_START_REASONS | {FIXTURE_REPLY_START_REASON}

    @functools.wraps(original_plan)
    def plan(text):
        result = original_plan(text)
        record(evidence, cycle, "reply_start_planned",
               textCharacters=len(text) if isinstance(text, str) else 0,
               **bounded_plan(result, reasons))
        return result

    ws_bridge._reply_start_planner = plan
    restored = False

    def undo():
        nonlocal restored
        if not restored:
            ws_bridge._reply_start_planner = original_plan
            restored = True
    return undo


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdio-bridge", action="store_true", required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cycle", type=int, required=True)
    parser.add_argument("--candidate-paging", action="store_true")
    args = parser.parse_args(argv)
    summary_view = validate_context(args.context, args.data_dir, args.endpoint, args.evidence, args.cycle, args.candidate_paging)
    sys.path.insert(0, str(ROOT))
    record(args.evidence, args.cycle, "bootstrap_started")
    undo = install_seed(args.data_dir, args.evidence, args.cycle, args.candidate_paging)
    undo_observer = install_query_observer(args.evidence, args.cycle)
    # The observer wraps the registered-turn override, so it records the plan
    # delivery actually receives; undone in reverse order.
    undo_registered_reply_start = install_registered_reply_start(args.evidence, args.cycle)
    undo_reply_start_observer = install_reply_start_observer(args.evidence, args.cycle)
    undo_summary_observer = None
    if summary_view:
        # Test-only and explicitly host-registered; importing the bootstrap or
        # running either original mode does not install the extension.
        from p1_summary_view_fixture import install_summary_view_observer
        undo_summary_observer = install_summary_view_observer(args.data_dir, args.evidence, args.cycle, record)
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    try:
        runpy.run_module("src.main", run_name="__main__")
    finally:
        if undo_summary_observer is not None:
            undo_summary_observer()
        undo_reply_start_observer()
        undo_registered_reply_start()
        undo_observer()
        undo()


if __name__ == "__main__":
    main()
