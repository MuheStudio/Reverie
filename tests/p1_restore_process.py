"""Isolated subprocess body for crash recovery and the one large-file observation."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import resource
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("crash", "replay", "large"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--phase", default="before_memory_commit")
    parser.add_argument("--bytes", type=int, default=128 * 1024 * 1024)
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir() or root.is_symlink():
        raise ValueError("registered temporary directory required")
    os.environ["REVERIE_DATA_DIR"] = str(root / "data")
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    from src.storage.encrypted_sqlite import install_storage_key
    key = sys.stdin.buffer.read(33)
    if len(key) != 32:
        raise ValueError("one process-local test key must arrive over stdin pipe")
    install_storage_key(key)
    from p1_restore_support import Graph
    report = {"schema": "reverie.p1.restore-process.v1", "mode": args.mode, "pid": os.getpid(), "ownerThread": threading.get_ident()}

    if args.mode == "crash":
        graph = Graph(root / "state")
        graph.seed("after")
        graph.manager.backup_to_file(root / "target.json")
        graph.seed("before")
        def fault(name):
            if name == args.phase:
                (root / "crash-reached.json").write_text(json.dumps({**report, "phase": name}))
                os._exit(73)
        # Reopen with the explicit hook; do not mutate production attributes.
        graph.close()
        graph = Graph(root / "state", fault_hook=fault)
        graph.manager.restore_from_file(root / "target.json")
        raise AssertionError("registered crash hook was not reached")

    if args.mode == "replay":
        graph = Graph(root / "state")
        intent = graph.journal.pending_restore()
        assert intent is not None
        target_marker = intent.after["_memory_restore_marker"]
        result = graph.manager.recover_interrupted_restore()
        assert result
        graph.assert_fixture("before" if args.phase == "before_memory_commit" else "after",
                             target_marker=None if args.phase == "before_memory_commit" else target_marker)
        assert graph.journal.pending_restore() is None
        before = graph.observable()
        assert not graph.manager.recover_interrupted_restore()
        assert graph.observable() == before
        report.update(passed=True, phase=args.phase, idempotent=True, sectionsVerified=["memory", "user", "emotion", "relationship", "diary", "marker"])
        graph.close()
        print(json.dumps(report)); return

    from src.backup_inspection import inspect_backup_file
    graph = Graph(root / "state")
    graph.seed("after")
    template = graph.manager._export_nonmemory_payload()
    # All expected non-memory values come from a fixed fixture before restore.
    expected_nonmemory = {key: template[key] for key in ("emotion", "relationship", "user", "diary")}
    destination = root / "large-v3.json"
    randomizer = random.Random(20261013)
    expected = hashlib.sha256()
    phases = {}
    started = time.monotonic()
    count = 0
    with destination.open("wb") as stream:
        prefix = json.dumps(template, ensure_ascii=False, separators=(",", ":")).encode()
        stream.write(prefix[:-1] + b',"memory":[')
        while stream.tell() < args.bytes:
            values = [randomizer.randrange(100000) for _ in range(12)]
            sentences = [f"第{count}项合成观测记录，时段{k}的仪器编号{value}，目标星区{value % 97}，测量温度{value % 30}度，记录者已完成读数核对。" for k, value in enumerate(values)]
            row = {"id": f"synthetic-large-{count:08}", "text": "".join(sentences), "layer": "long_term", "timestamp": 1791849600.0 - count, "importance": 0.6}
            if count: stream.write(b',')
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode())
            expected.update(json.dumps([row["id"], row["text"], row["timestamp"], row["importance"], row["layer"]], ensure_ascii=False, separators=(",", ":")).encode())
            count += 1
        stream.write(b']}'); stream.flush(); os.fsync(stream.fileno())
    phases["generationSeconds"] = time.monotonic() - started
    started = time.monotonic(); inspected = inspect_backup_file(destination)
    phases["inspectionSeconds"] = time.monotonic() - started
    graph.seed("before")
    async def restore_on_owner():
        await asyncio.sleep(0)
        loop = asyncio.get_running_loop()
        begin = time.monotonic_ns()
        result = graph.manager.restore_from_file(destination)
        end = time.monotonic_ns()
        assert asyncio.get_running_loop() is loop and threading.get_ident() == report["ownerThread"]
        return result, begin, end
    result, restore_begin, restore_end = asyncio.run(restore_on_owner())
    phases["ownerThreadRestoreWallSeconds"] = (restore_end - restore_begin) / 1e9
    started = time.monotonic()
    actual = hashlib.sha256(); restored = 0
    for page in graph.memory.iter_export_pages():
        for row in page:
            actual.update(json.dumps([row["id"], row["text"], row["timestamp"], row["importance"], row["retention_layer"]], ensure_ascii=False, separators=(",", ":")).encode()); restored += 1
    assert restored == count and actual.hexdigest() == expected.hexdigest()
    observed = graph.manager._export_nonmemory_payload()
    for section, expected_value in expected_nonmemory.items():
        assert observed[section] == expected_value, section
    marker = graph.memory.store.catalog.metadata_get("full_restore_marker")
    assert marker and marker != "fixture-before-marker" and graph.journal.pending_restore() is None
    from src.storage.encrypted_sqlite import SQLITE_HEADER
    for database in (graph.kernel.path, graph.memory.store.catalog.path, graph.journal.path):
        with database.open("rb") as stream:
            assert stream.read(16) != SQLITE_HEADER
    phases["verificationSeconds"] = time.monotonic() - started
    report.update(passed=True, seed=20261013, fileBytes=destination.stat().st_size,
                  requestedBytes=args.bytes, memoryCount=count, memoryDigest=actual.hexdigest(),
                  inspectedSha256=inspected.sha256, inspectedBytes=inspected.file_bytes,
                  encryptedStoresVerified=True,
                  ownerEventLoopInterval={"beginMonotonicNs":restore_begin,"endMonotonicNs":restore_end,"durationNs":restore_end-restore_begin,"sameOwnerThread":True},
                  nonmemoryDigests={k: hashlib.sha256(json.dumps(v,sort_keys=True,ensure_ascii=False).encode()).hexdigest() for k,v in expected_nonmemory.items()},
                  marker=marker, phases=phases, peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                  machine={"system":platform.system(),"release":platform.release(),"architecture":platform.machine()},
                  volumeDevice=root.stat().st_dev, temporaryDirectory=str(root),
                  performanceComparable=False, metricBoundary="Owner-thread synchronous restore wall time, not CPU or GPU time; one observation, no performance threshold")
    graph.close()
    print(json.dumps(report))


if __name__ == "__main__":
    main()
