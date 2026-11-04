"""Owner-isolated settings-section fixture: only the reply start is fixed.

No setting, memory or message is seeded or changed here. The seven
first-cycle chat turns the settings flow sends start without a presence wait;
production still plans each one first and its decision is recorded. Model
latency, bubble delivery and every other message keep the production path.
The evidence file holds counts, lengths and registered enums, never text.
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
# In send order; kept equal to native-ui/src/main.cpp, MoonroomInteractionCheck.cpp
# and SettingsSectionsCheck.cpp.
REGISTERED_CHAT_TURNS = (
    "你好，我喜欢和你一起看星空。",
    "阅读记录 1：请认真给我一份完整的项目说明",
    "阅读记录 2：请认真给我一份完整的项目说明",
    "停止记录",
    "组合记录：请认真给我一份完整的后续安排",
    "设置记录一：请认真分几句说说明天的安排",
    "设置记录二：请认真分几句说说明天的安排",
)
REGISTERED = {"registeredChats": len(REGISTERED_CHAT_TURNS)}
FIXTURE_REPLY_START_REASON = "isolated_settings_fixture"
REPLY_START_STATUSES = frozenset({"online", "busy", "away", "sleeping"})
REPLY_START_REASONS = frozenset({"available_now", "sleepy_reply", "busy_deferred", "away_deferred",
                                 "sleep_until_wake", "online_wobble"})


def private_regular(path: Path, maximum: int):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum
            or path.resolve() != path):
        raise ValueError("invalid isolated settings fixture file")
    return info


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int):
    if cycle not in (1, 2) or not all(path.is_absolute() for path in (context, data, evidence)):
        raise ValueError("explicit absolute settings fixture arguments required")
    private_regular(context, 16384)
    registered = json.loads(context.read_text())
    if (registered.get("schema") != "reverie.qt.isolation.v1"
            or set(registered) != {"schema", "root", "data", "p1_settings"}
            or registered.get("p1_settings") != {"endpoint": endpoint, **REGISTERED}
            or evidence != data / "p1-settings-metadata.jsonl"):
        raise ValueError("settings fixture not registered by isolated host")
    for key in ("root", "data"):
        expected = registered[key]
        target = Path(expected["path"])
        info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target
                or info.st_uid != os.getuid() or int(expected["uid"]) != info.st_uid
                or str(info.st_dev) != expected["device"] or str(info.st_ino) != expected["inode"]):
            raise ValueError("isolated settings directory identity mismatch")
    if data != Path(registered["data"]["path"]) or data.parent != Path(registered["root"]["path"]) or context.parent != data.parent:
        raise ValueError("settings fixture outside isolation")
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{4,5})/v1", endpoint)
    if not match or not 1024 <= int(match[1]) <= 65535:
        raise ValueError("owned settings model endpoint required")
    required = {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                "PYTHON_DOTENV_DISABLED": "1"}
    if any(os.environ.get(key) != value for key, value in required.items()) or not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("private encrypted desktop settings bootstrap required")
    settings = json.loads((data / "data/config.json").read_text()).get("llm", {})
    if settings.get("provider") != "ollama" or settings.get("base_url", "").rstrip("/") != endpoint:
        raise ValueError("settings fixture provider not the owned endpoint")
    if evidence.exists():
        private_regular(evidence, 65536)


def record(evidence: Path, cycle: int, event: str, **fields):
    descriptor = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        private_regular(evidence, 65536)
        os.write(descriptor, (json.dumps({"schema": "reverie.qt.p1-settings-metadata.v1", "event": event,
                                        "cycle": cycle, "monotonic_ns": time.monotonic_ns(), **fields}) + "\n").encode())
    finally:
        os.close(descriptor)


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

    Production plans every turn first and its decision is recorded. Only for a
    registered turn seen for the first time in this cycle does the wait before
    generation become zero; probability and status are kept and the reason
    names the fixture. Other texts, the second cycle and repeats keep the
    production plan.
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
    """Record the plan delivery actually receives, without changing it."""
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
    args = parser.parse_args(argv)
    validate_context(args.context, args.data_dir, args.endpoint, args.evidence, args.cycle)
    sys.path.insert(0, str(ROOT))
    record(args.evidence, args.cycle, "bootstrap_started")
    # The observer wraps the override, so it records the plan delivery
    # receives; both are undone in reverse order.
    undo_override = install_registered_reply_start(args.evidence, args.cycle)
    undo_observer = install_reply_start_observer(args.evidence, args.cycle)
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    try:
        runpy.run_module("src.main", run_name="__main__")
    finally:
        undo_observer()
        undo_override()


if __name__ == "__main__":
    main()
