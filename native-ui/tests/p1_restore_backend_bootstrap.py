"""Two-cycle, owner-isolated restore-finalization fault fixture.

No production control enables this hook. The native test host supplies a
registered directory identity and a private one-shot schedule. It never reads
or writes a user backup, key or default data directory.
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
FAULT_SCHEMA = "reverie.qt.p1-restore-fault.v1"


def private_regular(path: Path, maximum: int):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > maximum
            or path.resolve() != path):
        raise ValueError("invalid isolated fixture file")
    return info


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int):
    if cycle not in (1, 2) or not all(p.is_absolute() for p in (context, data, evidence)):
        raise ValueError("explicit absolute fixture arguments required")
    private_regular(context, 16384)
    registered = json.loads(context.read_text())
    if (registered.get("schema") != "reverie.qt.isolation.v1"
            or registered.get("p1_restore") != {"endpoint": endpoint, "faults": 2}
            or evidence != data / "p1-restore-metadata.jsonl"):
        raise ValueError("restore fixture not registered by isolated host")
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


def install_fault(data: Path, evidence: Path, cycle: int):
    from src.backup import LocalBackupManager
    from src.bridge import stdio_bridge, ws_bridge
    original = LocalBackupManager.__init__
    original_control = stdio_bridge._handle_control
    fault_file = data / "p1-restore-fault.json"

    def record(event, **fields):
        fd = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            private_regular(evidence, 65536)
            os.write(fd, (json.dumps({"schema": "reverie.qt.p1-restore-metadata.v1", "event": event,
                                     "cycle": cycle, "monotonic_ns": time.monotonic_ns(), **fields}) + "\n").encode())
        finally:
            os.close(fd)

    def hook(phase):
        if phase != "before_finalize" or not fault_file.exists():
            return
        private_regular(fault_file, 1024)
        value = json.loads(fault_file.read_text())
        if (set(value) != {"schema", "phase", "remaining"} or value["schema"] != FAULT_SCHEMA
                or value["phase"] != "before_finalize" or type(value["remaining"]) is not int
                or value["remaining"] not in (0, 1, 2)):
            raise ValueError("invalid fixed restore fault schedule")
        remaining = value["remaining"]
        if not remaining:
            record("finalization_allowed", remaining=0)
            return
        if (cycle == 1 and remaining != 2) or (cycle == 2 and remaining != 1):
            raise ValueError("restore fault repeated outside registered cycle")
        value["remaining"] -= 1
        temporary = fault_file.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, (json.dumps(value) + "\n").encode()); os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, fault_file)
        record("finalization_fault", phase=phase, remaining=value["remaining"])
        raise OSError("isolated finalization fault")

    @functools.wraps(original)
    def initializing(self, *args, **kwargs):
        if kwargs.get("fault_hook") is not None:
            raise ValueError("nested recovery test hook forbidden")
        kwargs["fault_hook"] = hook
        return original(self, *args, **kwargs)

    LocalBackupManager.__init__ = initializing
    @functools.wraps(original_control)
    async def observed_control(message):
        command = message.get("type")
        if command not in {"backup:file:inspect", "backup:file:export", "backup:file:import"}:
            return await original_control(message)
        raw_id = str(message.get("requestId") or "")
        request_id = raw_id if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", raw_id) else "invalid"
        record("control_begin", command=command, request_id=request_id)
        try:
            result = await original_control(message)
        except Exception as error:
            record("control_handler_error", command=command, request_id=request_id,
                   code=ws_bridge.control_error_code(error))
            raise
        # Observe the actual composed result, with no path, contents or raw
        # exception. This private test bootstrap never changes the receipt.
        schema = result.get("schema")
        backup_schema = result.get("backup_schema")
        record("control_result", command=command, request_id=request_id,
               envelope_schema=schema if schema in {"reverie.bridge.stdio.control.v4", "reverie.full_local_backup.v3"} else "invalid",
               backup_schema=backup_schema if backup_schema in {"reverie.full_local_backup.v1", "reverie.full_local_backup.v2", "reverie.full_local_backup.v3"} else "absent_or_invalid",
               ok=result.get("ok") if type(result.get("ok")) is bool else None,
               outcome=result.get("outcome") if result.get("outcome") in {"committed", "rolled_back", "unconfirmed"} else None,
               recovery_state=result.get("recovery_state") if result.get("recovery_state") in {"clean", "recovering", "recovery_required"} else None)
        return result
    stdio_bridge._handle_control = observed_control
    record("bootstrap")
    def undo():
        LocalBackupManager.__init__ = original
        stdio_bridge._handle_control = original_control
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
    undo = install_fault(args.data_dir, args.evidence, args.cycle)
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    try:
        runpy.run_module("src.main", run_name="__main__")
    finally:
        undo()


if __name__ == "__main__":
    main()
