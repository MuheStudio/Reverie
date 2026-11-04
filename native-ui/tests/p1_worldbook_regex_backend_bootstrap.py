"""Owner-isolated worldbook regex fixture with three registered chat turns.

Nothing is seeded here. The three fixture-specific first-cycle messages retain
their 0 s start and 100 ms delivery plans. The separate shared greeting/Moonroom
fixture removes only the first start wait of its five first-cycle turns, after
production plans them; probability, status and delivery timing are retained. Each
archive write that carries the fixture book is recorded at dispatch, in both
cycles, so the restart can show it wrote nothing. The evidence file holds
request IDs, revisions, persona scope, fixed operation names and actual owned
worker lifecycle identities only; patterns and conversation contents are absent.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
REGEX_REQUESTS = (
    "正则记录一：ID-12",
    "正则记录二：ID-12",
    "正则记录三：ID-12",
)
REGEX_BOOK_ID = "p1_regex_book"
REGISTERED = {"regexChats": 3}


def private_regular(path: Path, maximum: int):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum
            or path.resolve() != path):
        raise ValueError("invalid isolated regex fixture file")
    return info


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int):
    if cycle not in (1, 2) or not all(path.is_absolute() for path in (context, data, evidence)):
        raise ValueError("explicit absolute regex fixture arguments required")
    private_regular(context, 16384)
    registered = json.loads(context.read_text())
    if (registered.get("schema") != "reverie.qt.isolation.v1"
            or set(registered) != {"schema", "root", "data", "p1_worldbook_regex"}
            or registered.get("p1_worldbook_regex") != {"endpoint": endpoint, **REGISTERED}
            or evidence != data / "p1-worldbook-regex-metadata.jsonl"):
        raise ValueError("regex fixture not registered by isolated host")
    for key in ("root", "data"):
        expected = registered[key]
        target = Path(expected["path"])
        info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target
                or info.st_uid != os.getuid() or int(expected["uid"]) != info.st_uid
                or str(info.st_dev) != expected["device"] or str(info.st_ino) != expected["inode"]):
            raise ValueError("isolated regex directory identity mismatch")
    if data != Path(registered["data"]["path"]) or data.parent != Path(registered["root"]["path"]) or context.parent != data.parent:
        raise ValueError("regex fixture outside isolation")
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{4,5})/v1", endpoint)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise ValueError("owned regex model endpoint required")
    required = {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                "PYTHON_DOTENV_DISABLED": "1"}
    if any(os.environ.get(key) != value for key, value in required.items()) or not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("private encrypted desktop regex bootstrap required")
    settings = json.loads((data / "data/config.json").read_text()).get("llm", {})
    if settings.get("provider") != "ollama" or settings.get("base_url", "").rstrip("/") != endpoint:
        raise ValueError("regex fixture provider not the owned endpoint")
    if evidence.exists():
        private_regular(evidence, 65536)


def record(evidence: Path, cycle: int, event: str, **fields):
    descriptor = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_regular(evidence, 65536)
        os.write(descriptor, (json.dumps({"schema": "reverie.qt.p1-worldbook-regex-metadata.v1", "event": event,
                                        "cycle": cycle, "monotonic_ns": time.monotonic_ns(), **fields}) + "\n").encode())
    finally:
        os.close(descriptor)


def registered_stage(user_message, cycle: int) -> int:
    return (REGEX_REQUESTS.index(user_message) + 1
            if cycle == 1 and isinstance(user_message, str) and user_message in REGEX_REQUESTS else 0)


def carries_fixture_book(payload) -> bool:
    archive = payload.get("archive") if isinstance(payload, dict) else None
    books = archive.get("worldBooks") if isinstance(archive, dict) else None
    return isinstance(books, list) and any(
        isinstance(book, dict) and book.get("id") == REGEX_BOOK_ID for book in books)


def install_regex_request_timing(evidence: Path, cycle: int):
    """Override only the three registered turns, never the production source."""
    from src.chat.scheduler import MessageScheduler, ReplyStartPlan
    original_start = MessageScheduler.plan_reply_start
    original_delay = MessageScheduler.calculate_delay
    started: set[int] = set()

    def start(self, user_message, **kwargs):
        stage = registered_stage(user_message, cycle)
        if not stage:
            return original_start(self, user_message, **kwargs)
        if stage in started:
            raise ValueError("registered regex turn repeated")
        started.add(stage)
        record(evidence, cycle, "regex_timing", stage=stage, start_delay_ms=0, delivery_delay_ms=100)
        return ReplyStartPlan(0.0, 1.0, "online", "isolated_regex_fixture")

    def delay(self, reply_length, emotion_intensity=0.0, *, user_message="", **kwargs):
        if registered_stage(user_message, cycle):
            return 0.1
        return original_delay(self, reply_length, emotion_intensity, user_message=user_message, **kwargs)

    MessageScheduler.plan_reply_start = start
    MessageScheduler.calculate_delay = delay

    def undo():
        MessageScheduler.plan_reply_start = original_start
        MessageScheduler.calculate_delay = original_delay
    return undo


def install_regex_observer(evidence: Path, cycle: int):
    from src.bridge import ws_bridge
    original_dispatch = ws_bridge.dispatch_authenticated_message

    def request_id(message):
        value = message.get("request_id")
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value):
            raise ValueError("regex request identity invalid")
        return value

    def scope_fields():
        scope = ws_bridge._active_persona_scope()
        return {"persona_id": scope.get("persona_id"), "persona_epoch": scope.get("persona_epoch"),
                "persona_fingerprint": scope.get("persona_fingerprint")}

    @functools.wraps(original_dispatch)
    async def dispatch(message, endpoint, **kwargs):
        command = message.get("type") if isinstance(message, dict) else None
        payload = message.get("payload") if isinstance(message, dict) else None
        payload = payload if isinstance(payload, dict) else {}
        if command == "archive:put" and carries_fixture_book(payload):
            expected = payload.get("expected_revision")
            record(evidence, cycle, "regex_archive_put_dispatch", request_id=request_id(message),
                   expected_revision=expected if type(expected) is int and expected >= 0 else None, **scope_fields())
        if command == "chat:send":
            stage = registered_stage(payload.get("text"), cycle)
            if stage:
                record(evidence, cycle, "regex_dispatch", stage=stage, request_id=request_id(message),
                       **scope_fields())
        return await original_dispatch(message, endpoint, **kwargs)

    ws_bridge.dispatch_authenticated_message = dispatch

    def undo():
        ws_bridge.dispatch_authenticated_message = original_dispatch
    return undo


def install_regex_worker_observer(evidence: Path, cycle: int):
    """Retain actual asyncio Process handles so short-lived workers cannot be missed.

    This fixture does not decide or alter process cleanup. An exit record is
    emitted only after the original cleanup returned/raised and the retained
    Process reports its actual exit code. No process is signalled here.
    """
    from src.worldbook.regex_supervisor import RegexSession
    original_attach, original_cleanup = RegexSession._attach, RegexSession._cleanup
    owned: dict[int, tuple[object, object, int]] = {}
    serial = 0

    def attach(self, process):
        nonlocal serial
        original_attach(self, process)
        pid = process.pid
        if type(pid) is not int or pid <= 0:
            raise ValueError("regex worker identity unavailable")
        existing = owned.get(pid)
        if existing is not None:
            if existing[0] is not self or existing[1] is not process:
                raise ValueError("regex worker identity reused before exit")
            return
        serial += 1
        owned[pid] = (self, process, serial)
        try:
            group = os.getpgid(pid)
        except ProcessLookupError:
            group = None
        record(evidence, cycle, "regex_worker_spawn", worker_id=serial, pid=pid,
               process_group=group, bootstrap_pid=os.getpid())

    async def cleanup(self):
        try:
            return await original_cleanup(self)
        finally:
            for pid, (owner, process, worker_id) in tuple(owned.items()):
                if owner is not self:
                    continue
                code = process.returncode
                if type(code) is int:
                    record(evidence, cycle, "regex_worker_exit", worker_id=worker_id, pid=pid,
                           returncode=code, bootstrap_pid=os.getpid())
                    del owned[pid]
                else:
                    record(evidence, cycle, "regex_worker_cleanup_unconfirmed", worker_id=worker_id,
                           pid=pid, bootstrap_pid=os.getpid())

    RegexSession._attach, RegexSession._cleanup = attach, cleanup

    def undo():
        RegexSession._attach, RegexSession._cleanup = original_attach, original_cleanup
    return undo


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdio-bridge", action="store_true", required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cycle", type=int, required=True)
    args = parser.parse_args(argv)
    validate_context(args.context, args.data_dir, args.endpoint, args.evidence, args.cycle)
    sys.path.insert(0, str(ROOT))
    record(args.evidence, args.cycle, "bootstrap_started")
    undo_timing = install_regex_request_timing(args.evidence, args.cycle)
    undo_observer = install_regex_observer(args.evidence, args.cycle)
    undo_workers = install_regex_worker_observer(args.evidence, args.cycle)
    from moonroom_reply_start import install_moonroom_reply_start
    undo_moonroom = install_moonroom_reply_start(args.cycle)
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    try:
        runpy.run_module("src.main", run_name="__main__")
    finally:
        undo_moonroom()
        undo_workers()
        undo_observer()
        undo_timing()


if __name__ == "__main__":
    main()
