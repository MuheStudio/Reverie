"""Owner-isolated worldbook insertion fixture with three registered chat turns.

Nothing is seeded here. The three fixture-specific first-cycle messages retain
their 0 s start and 100 ms delivery plans. The separate shared greeting/Moonroom
fixture removes only the first start wait of its five first-cycle turns, after
production plans them; probability, status and delivery timing are retained. Each
archive write that carries the fixture book is recorded at dispatch, in both
cycles, so the restart can show it wrote nothing. The evidence file holds
request IDs, revisions, persona scope and fixed operation names only;
archive and conversation contents are absent.
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
INJECTION_REQUESTS = (
    "插入记录一：清风徐来",
    "插入记录二：云影经过",
    "插入记录三：远灯亮起",
)
INJECTION_BOOK_ID = "p1_injection_book"
REGISTERED = {"injectionChats": 3}


def private_regular(path: Path, maximum: int):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum
            or path.resolve() != path):
        raise ValueError("invalid isolated injection fixture file")
    return info


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int):
    if cycle not in (1, 2) or not all(path.is_absolute() for path in (context, data, evidence)):
        raise ValueError("explicit absolute injection fixture arguments required")
    private_regular(context, 16384)
    registered = json.loads(context.read_text())
    if (registered.get("schema") != "reverie.qt.isolation.v1"
            or set(registered) != {"schema", "root", "data", "p1_worldbook_injection"}
            or registered.get("p1_worldbook_injection") != {"endpoint": endpoint, **REGISTERED}
            or evidence != data / "p1-worldbook-injection-metadata.jsonl"):
        raise ValueError("injection fixture not registered by isolated host")
    for key in ("root", "data"):
        expected = registered[key]
        target = Path(expected["path"])
        info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target
                or info.st_uid != os.getuid() or int(expected["uid"]) != info.st_uid
                or str(info.st_dev) != expected["device"] or str(info.st_ino) != expected["inode"]):
            raise ValueError("isolated injection directory identity mismatch")
    if data != Path(registered["data"]["path"]) or data.parent != Path(registered["root"]["path"]) or context.parent != data.parent:
        raise ValueError("injection fixture outside isolation")
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{4,5})/v1", endpoint)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise ValueError("owned injection model endpoint required")
    required = {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                "PYTHON_DOTENV_DISABLED": "1"}
    if any(os.environ.get(key) != value for key, value in required.items()) or not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("private encrypted desktop injection bootstrap required")
    settings = json.loads((data / "data/config.json").read_text()).get("llm", {})
    if settings.get("provider") != "ollama" or settings.get("base_url", "").rstrip("/") != endpoint:
        raise ValueError("injection fixture provider not the owned endpoint")
    if evidence.exists():
        private_regular(evidence, 65536)


def record(evidence: Path, cycle: int, event: str, **fields):
    descriptor = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_regular(evidence, 65536)
        os.write(descriptor, (json.dumps({"schema": "reverie.qt.p1-worldbook-injection-metadata.v1", "event": event,
                                        "cycle": cycle, "monotonic_ns": time.monotonic_ns(), **fields}) + "\n").encode())
    finally:
        os.close(descriptor)


def registered_stage(user_message, cycle: int) -> int:
    return (INJECTION_REQUESTS.index(user_message) + 1
            if cycle == 1 and isinstance(user_message, str) and user_message in INJECTION_REQUESTS else 0)


def carries_fixture_book(payload) -> bool:
    archive = payload.get("archive") if isinstance(payload, dict) else None
    books = archive.get("worldBooks") if isinstance(archive, dict) else None
    return isinstance(books, list) and any(
        isinstance(book, dict) and book.get("id") == INJECTION_BOOK_ID for book in books)


def install_injection_request_timing(evidence: Path, cycle: int):
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
            raise ValueError("registered injection turn repeated")
        started.add(stage)
        record(evidence, cycle, "injection_timing", stage=stage, start_delay_ms=0, delivery_delay_ms=100)
        return ReplyStartPlan(0.0, 1.0, "online", "isolated_injection_fixture")

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


def install_injection_observer(evidence: Path, cycle: int):
    from src.bridge import ws_bridge
    original_dispatch = ws_bridge.dispatch_authenticated_message

    def request_id(message):
        value = message.get("request_id")
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value):
            raise ValueError("injection request identity invalid")
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
            record(evidence, cycle, "injection_archive_put_dispatch", request_id=request_id(message),
                   expected_revision=expected if type(expected) is int and expected >= 0 else None, **scope_fields())
        if command == "chat:send":
            stage = registered_stage(payload.get("text"), cycle)
            if stage:
                record(evidence, cycle, "injection_dispatch", stage=stage, request_id=request_id(message),
                       **scope_fields())
        return await original_dispatch(message, endpoint, **kwargs)

    ws_bridge.dispatch_authenticated_message = dispatch

    def undo():
        ws_bridge.dispatch_authenticated_message = original_dispatch
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
    undo_timing = install_injection_request_timing(args.evidence, args.cycle)
    undo_observer = install_injection_observer(args.evidence, args.cycle)
    from moonroom_reply_start import install_moonroom_reply_start
    undo_moonroom = install_moonroom_reply_start(args.cycle)
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    try:
        runpy.run_module("src.main", run_name="__main__")
    finally:
        undo_moonroom()
        undo_observer()
        undo_timing()


if __name__ == "__main__":
    main()
