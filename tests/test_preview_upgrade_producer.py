"""Producer assembly tests use saved synthetic files and mocked process calls."""
import json
from pathlib import Path

import pytest

from script import check_preview_upgrade as producer


def test_upgrade_driver_uses_current_host_and_selected_old_backend_without_production_preview_flags(tmp_path, monkeypatch):
    runtime = {"hostExecutable": "/new-runtime/host", "runtimeRoot": "/new-runtime"}
    old = {"runtimeRoot": "/old-runtime", "python": "/old-runtime/.venv/bin/python"}
    observed = {}
    monkeypatch.setattr(producer, "context", lambda isolation, workspace, name, upgrade, **kwargs: observed.update(bound=upgrade, frozen=kwargs) or tmp_path / "context.json")
    def command(argv, **kwargs):
        observed.update(argv=argv, cwd=kwargs["cwd"], timeout=kwargs["timeout"])
        return {"hostPid": 100, "startedNs": 1, "exitedNs": 2, "exitCode": 0, "remainingPids": [], "descendantPids": [101], "stderr": ""}
    monkeypatch.setattr(producer, "owned_command", command)
    monkeypatch.setattr(producer.smoke, "read_owned_bytes", lambda *args, **kwargs: b'{"synthetic":true}')
    expected_identity = {"candidate": "old", "sourceHead": "a" * 40, "buildManifestSha256": "b" * 64}
    result = producer.native(runtime, old, tmp_path, tmp_path / "preview-workspace", "seed", identity=expected_identity, public_sha="c" * 64,
                             endpoint="http://127.0.0.1:9876/v1", model=tmp_path / "licensed-copy")
    assert observed["argv"][0] == runtime["hostExecutable"]
    assert observed["bound"]["--backend-root"] == old["runtimeRoot"] and observed["bound"]["--backend-python"] == old["python"]
    assert "--workspace" not in observed["argv"] and "--test-endpoint" not in observed["argv"]
    assert observed["cwd"] == runtime["runtimeRoot"] and observed["timeout"] == 240
    assert observed["frozen"] == {"identity": expected_identity, "public_sha": "c" * 64}
    assert result["hostPid"] == 100 and result["descendantPids"] == [101]


def test_upgrade_context_keeps_runner_data_separate_from_preview_workspace(tmp_path):
    for name in ("data", "preview-workspace"):
        (tmp_path / name).mkdir(mode=0o700)
    path = producer.context(tmp_path, tmp_path / "preview-workspace", "seed", {"--upgrade-action": "seed"})
    value = json.loads(path.read_bytes())
    assert value["data"]["path"] == str(tmp_path / "data")
    assert value["previewWorkspace"]["path"] == str(tmp_path / "preview-workspace")
    assert value["purpose"] == "reverie.qt.preview-test-cleanup.v1"
    assert value["previewUpgrade"] == {"--upgrade-action": "seed"}


def test_format_refusal_inventory_covers_root_control_files_and_excludes_only_lock_and_events(tmp_path):
    (tmp_path / "data").mkdir(); (tmp_path / "avatars").mkdir()
    for name in ("ready-candidate.json", "restore-source.json", "workspace.lock", "preview-events.jsonl"):
        (tmp_path / name).write_text("synthetic")
    first = producer.refusal_inventory(tmp_path)
    assert {row["path"] for row in first["files"]} == {"ready-candidate.json", "restore-source.json"}
    (tmp_path / "workspace.lock").write_text("new pid")
    assert producer.refusal_inventory(tmp_path) == first
    (tmp_path / "ready-candidate.json").write_text("changed")
    assert producer.refusal_inventory(tmp_path) != first


def test_format_refusal_inventory_rejects_symlink_before_reading_its_target(tmp_path):
    (tmp_path / "data").mkdir(); (tmp_path / "avatars").mkdir()
    (tmp_path / "data/linked").symlink_to("/nonexistent/never-read")
    with pytest.raises(RuntimeError, match="PREVIEW_V4_FORMAT_INVENTORY_UNSAFE"):
        producer.refusal_inventory(tmp_path)
