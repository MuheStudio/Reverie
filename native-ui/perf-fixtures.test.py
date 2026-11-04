"""Isolated fixtures: exact committed rows, deterministic identities, encryption."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).with_name("perf-fixtures.py")
spec = importlib.util.spec_from_file_location("reverie_perf_fixtures", SCRIPT)
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def snapshot(directory):
    info = directory.stat()
    return {"path": str(directory), "uid": info.st_uid, "device": str(info.st_dev), "inode": str(info.st_ino)}


def seed_process(root, rows, key):
    root.mkdir(mode=0o700)
    data = root / "history"
    data.mkdir(mode=0o700)
    context = root / "context.json"
    context.write_text(json.dumps({"schema": "reverie.qt.isolation.v1", "root": snapshot(root), "data": snapshot(data)}))
    report = root / "fixture.json"
    read_fd, write_fd = os.pipe()
    os.write(write_fd, key)
    os.close(write_fd)
    try:
        # Only the inherited descriptor number is passed; key bytes stay in
        # the anonymous pipe and never enter command arguments or environment.
        bootstrap = "import os,runpy,sys; fd=int(sys.argv.pop(1)); os.dup2(fd,3); os.close(fd) if fd!=3 else None; sys.argv[0]=sys.argv.pop(1); runpy.run_path(sys.argv[0],run_name='__main__')"
        env = {**os.environ, "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1", "PYTHON_DOTENV_DISABLED": "1"}
        env.pop("REVERIE_DATA_DIR", None)
        result = subprocess.run([sys.executable, "-c", bootstrap, str(read_fd), str(SCRIPT), "--data-dir", str(data),
                                 "--rows", str(rows), "--context", str(context), "--report", str(report)],
                                pass_fds=(read_fd,), env=env, capture_output=True, text=True, timeout=30)
    finally:
        os.close(read_fd)
    assert result.returncode == 0, result.stderr
    return json.loads(report.read_text()), data / "data" / "runtime" / "kernel.sqlite3"


@pytest.mark.parametrize("rows", [9, 100, 300])
def test_exact_encrypted_committed_and_deterministic_history(tmp_path, rows):
    tmp_path = tmp_path.resolve()
    first, database = seed_process(tmp_path / "first", rows, os.urandom(32))
    second, _ = seed_process(tmp_path / "second", rows, os.urandom(32))
    assert first == second
    assert len(first["messageIds"]) == rows
    assert first["committed"] and first["encrypted"] and first["integrity"] == "ok"
    assert first["serializedHistoryBytes"] + 4096 < 1024 * 1024
    assert database.read_bytes()[:16] != b"SQLite format 3\x00"


def test_fixture_never_seeds_replaced_context_directory(tmp_path):
    tmp_path = tmp_path.resolve()
    data = tmp_path / "history"
    data.mkdir()
    context = tmp_path / "context.json"
    context.write_text(json.dumps({"schema": "reverie.qt.isolation.v1", "root": snapshot(tmp_path), "data": snapshot(data)}))
    data.rename(tmp_path / "original")
    data.mkdir()
    with pytest.raises(ValueError, match="identity changed"):
        fixtures.verify_context(context, data)


def test_fixture_rejects_aliases_and_unsupported_counts(tmp_path):
    with pytest.raises(ValueError):
        fixtures.exchanges(301)
    data = tmp_path / "history"
    data.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(data)
    with pytest.raises(ValueError, match="canonical"):
        fixtures.verify_context(tmp_path / "missing.json", alias)
