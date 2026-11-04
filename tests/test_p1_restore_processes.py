from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
BODY = ROOT / "tests/p1_restore_process.py"


def run_process(args, key, timeout=120):
    result = subprocess.run([sys.executable, "-I", "-B", str(BODY), *args], input=key,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                            env={**os.environ, "PYTHON_DOTENV_DISABLED": "1"})
    return result


@pytest.mark.parametrize("phase", ["before_memory_commit", "after_memory_commit", "before_finalize"])
def test_encrypted_fault_process_restarts_once_and_converges(tmp_path, phase, record_property):
    key = os.urandom(32)
    crashed = run_process(["crash", str(tmp_path), "--phase", phase], key)
    assert crashed.returncode == 73, crashed.stderr.decode(errors="replace")
    assert json.loads((tmp_path / "crash-reached.json").read_text())["phase"] == phase
    replay = run_process(["replay", str(tmp_path), "--phase", phase], key)
    assert replay.returncode == 0, replay.stderr.decode(errors="replace")
    report = json.loads(replay.stdout)
    assert report["passed"] and report["idempotent"]
    record_property("fault_process", json.dumps(report, ensure_ascii=False))


def test_fixed_accepted_exporter_compatibility_artifact_identity():
    fixture = ROOT / "tests/fixtures/p1_restore_same_identity_v3.json"
    manifest = json.loads(fixture.with_suffix(".manifest.json").read_text())
    raw = fixture.read_bytes()
    assert len(raw) == manifest["bytes"]
    assert hashlib.sha256(raw).hexdigest() == manifest["sha256"]
    assert manifest["exporterCommit"] == "00d557062bac4093bb9c74ea5b6afaa7a9d8c0ea"
    assert json.loads(raw)["persona_identity"] == manifest["personaIdentity"]


def test_large_observation_harness_small_development_case(tmp_path):
    result = run_process(["large", str(tmp_path), "--bytes", str(128 * 1024)], os.urandom(32))
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    report = json.loads(result.stdout)
    assert report["passed"] and report["fileBytes"] >= 128 * 1024


@pytest.mark.skipif(os.environ.get("REVERIE_P1_FORMAL_LARGE") != "1", reason="128 MiB one-shot is reserved for the formal Python batch")
def test_formal_128_mib_single_observation(record_property):
    parent = ROOT / ".tools/reports/p1-restore-20261013/large-file"
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    report_path = parent / "observation.json"
    marker = parent / "started.json"
    assert not marker.exists(), "Formal large-file observation already attempted; no rerun"
    marker.write_text(json.dumps({"limitSeconds":600,"fixedSeed":20261013,"sourceBodySha256":hashlib.sha256(BODY.read_bytes()).hexdigest()}))
    with tempfile.TemporaryDirectory(prefix="registered-", dir=parent) as directory:
        scratch = Path(directory)
        (parent / "temporary-identity.json").write_text(json.dumps({"path":directory,"device":scratch.stat().st_dev,"inode":scratch.stat().st_ino,"uid":scratch.stat().st_uid}))
        try:
            result = run_process(["large", directory], os.urandom(32), timeout=600)
        except subprocess.TimeoutExpired:
            report_path.write_text(json.dumps({"passed":False,"error":"600_SECOND_SAFETY_LIMIT","performanceComparable":False}))
            raise
        report_path.write_bytes(result.stdout if result.returncode == 0 else json.dumps({"passed":False,"exitCode":result.returncode,"errorClass":"correctness_or_execution_failure"}).encode())
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        report = json.loads(result.stdout)
        assert report["passed"] and report["fileBytes"] >= 128 * 1024 * 1024
        record_property("large_file_observation", json.dumps(report, ensure_ascii=False))
    cleanup = {"temporaryDataRemoved": not scratch.exists(), "sampleAndDatabasesRemoved": not scratch.exists()}
    (parent / "cleanup.json").write_text(json.dumps(cleanup))
    assert cleanup["temporaryDataRemoved"]
