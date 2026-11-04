"""Disposable W2 smoke evidence helpers; no host, real workspace or keychain."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
from types import SimpleNamespace

import pytest

from script import check_preview_workspace as smoke


def fixture_workspace(tmp_path):
    root = tmp_path.resolve() / "isolated-preview"
    for name in ("data/runtime", "data/cache", "data/empty", "avatars", "logs", "qml-cache"):
        (root / name).mkdir(parents=True, mode=0o700)
    for relative, data in (("data/runtime/kernel.sqlite3", b"original database bytes"),
                           ("avatars/model.dat", b"original avatar bytes"),
                           ("data/cache/excluded.dat", b"excluded cache bytes"),
                           ("logs/excluded.log", b"excluded original log")):
        (root / relative).write_bytes(data)
        (root / relative).chmod(0o600)
    return root


def test_v3_prelaunch_inventory_hashes_original_bytes_and_excludes_cache_logs(tmp_path):
    root = fixture_workspace(tmp_path)
    value = smoke.inventory(root)
    assert {row["path"] for row in value["files"]} == {"data/runtime/kernel.sqlite3", "avatars/model.dat"}
    assert "data/empty" in value["directories"] and "data/cache" not in value["directories"]
    database = next(row for row in value["files"] if row["path"].endswith("kernel.sqlite3"))
    assert database["sha256"] == hashlib.sha256(b"original database bytes").hexdigest()
    assert int(value["totalBytes"]) == sum(int(row["size"]) for row in value["files"])


@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
def test_v3_prelaunch_inventory_rejects_links_instead_of_following_them(tmp_path, kind):
    root = fixture_workspace(tmp_path)
    target = root / "data/runtime/kernel.sqlite3"
    alias = root / "avatars/alias"
    if kind == "symlink":
        alias.symlink_to(target)
    else:
        os.link(target, alias)
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_INVENTORY_UNSAFE"):
        smoke.inventory(root)


def test_v3_copied_inventory_detects_excluded_cache_if_it_was_accidentally_copied(tmp_path):
    root = fixture_workspace(tmp_path)
    shutil.rmtree(root / "logs"); shutil.rmtree(root / "qml-cache")
    smoke.write_json(root / "manifest.json", {})
    root.chmod(0o700)
    for directory in (root / "data", root / "data/runtime", root / "data/cache", root / "data/empty", root / "avatars"):
        directory.chmod(0o700)
    value = smoke.inventory(root, copied=True)
    assert "data/cache" in value["directories"]
    from script.registered_run import preview_v3, preview
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_SNAPSHOT_PATH"):
        preview_v3.inventory(value)


@pytest.mark.parametrize("kind", ["world-readable", "symlink", "hardlink", "oversize"])
def test_v3_saved_evidence_reader_rejects_unsafe_files(tmp_path, kind):
    path = tmp_path / "metadata.json"
    path.write_bytes(b"{}"); path.chmod(0o600)
    if kind == "world-readable":
        path.chmod(0o644)
    elif kind == "symlink":
        target = tmp_path / "target.json"
        path.rename(target); path.symlink_to(target)
    elif kind == "hardlink":
        os.link(path, tmp_path / "other.json")
    else:
        path.write_bytes(b"x" * 20)
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_EVIDENCE_FILE"):
        smoke.read_owned_bytes(path, 16, private=True)


def test_v3_fake_previous_candidate_changes_only_the_isolated_ready_record(tmp_path):
    root = fixture_workspace(tmp_path)
    current = {"candidate": "current-preview", "sourceHead": "a" * 40, "buildManifestSha256": "b" * 64}
    marker = {"schema": "reverie.preview.ready-candidate.v1", "readyId": "c" * 32, **current}
    smoke.write_json(root / "ready-candidate.json", marker)
    before = smoke.inventory(root)
    previous = smoke.previous_candidate(root, current)
    assert smoke.read_ready_candidate(root) == previous
    assert previous["candidate"] == "smoke-previous-candidate" and previous["readyId"] != marker["readyId"]
    assert (root / "ready-candidate.json").stat().st_mode & 0o777 == 0o600
    assert smoke.inventory(root) == before and not list(root.glob(".smoke-ready-*"))


def test_v3_fake_previous_candidate_refuses_an_unbound_current_marker(tmp_path):
    root = fixture_workspace(tmp_path)
    smoke.write_json(root / "ready-candidate.json", {"candidate": "unexpected"})
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_READY_RECORD_NOT_CURRENT"):
        smoke.previous_candidate(root, {"candidate": "expected", "sourceHead": "a" * 40, "buildManifestSha256": "b" * 64})
    assert json.loads((root / "ready-candidate.json").read_bytes()) == {"candidate": "unexpected"}


def test_v3_diagnostics_command_is_bound_to_explicit_isolated_workspace_and_runtime(tmp_path, monkeypatch):
    isolation = tmp_path.resolve()
    workspace = isolation / "isolated-workspace"
    runtime = {"runtimeRoot": str(isolation / "isolated-runtime")}
    calls = []
    def run(command, **options):
        calls.append((command, options))
        output = Path(command[command.index("--output") + 1])
        smoke.write_json(output, {"schema": "synthetic-only"})
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(smoke.subprocess, "run", run)
    value = smoke.export_diagnostics(runtime, workspace, isolation)
    command, options = calls[0]
    assert command[1:] == ["diagnostics", "--runtime-root", runtime["runtimeRoot"], "--workspace", str(workspace),
                           "--output", str(isolation / "preview-diagnostics.json")]
    assert options["timeout"] == 30 and value["outputMode"] == 0o600
    assert value["sha256"] == hashlib.sha256(value["exportJson"].encode()).hexdigest()


def test_v3_diagnostics_command_error_does_not_accept_a_stale_export(tmp_path, monkeypatch):
    output = tmp_path / "preview-diagnostics.json"
    smoke.write_json(output, {"stale": True})
    monkeypatch.setattr(smoke.subprocess, "run", lambda *_a, **_k: SimpleNamespace(returncode=1))
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_DIAGNOSTICS_EXPORT_FAILED"):
        smoke.export_diagnostics({"runtimeRoot": "/synthetic/isolated-runtime"}, tmp_path / "workspace", tmp_path)
    assert json.loads(output.read_bytes()) == {"stale": True}
