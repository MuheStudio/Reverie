"""W2's two extra verdicts are recomputed from isolated saved facts only.

The historical W1 fixture/tests are imported unchanged. No host, PID table,
keychain, GUI, runtime installation, or real workspace is used here.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from script.registered_run import preview, preview_v3, stages
from script.registered_run.config import ConfigError, validate_config
from script.registered_run.contract import registration_contract
from script.registered_run.modes.context import RunContext
from tests.test_registered_run_preview import (
    SOURCE, config_value, derive, ready, report_value, report_value_v2, replace,
    save_observations, workspace, write_json,
)


def events(host, *, unchanged=False):
    names = ("startup", "snapshot_skipped" if unchanged else "snapshot_created", "keychain_read_started",
             "keychain_ready", "backend_starting", "ready")
    codes = ("OK", "UNCHANGED" if unchanged else "CREATED", "OK", "OK", "OK", "CLEAN")
    return [{"schema": "reverie.qt.preview-event.v1", "event": name, "hostPid": host, "sequence": index + 1,
             "timeMs": 1793480400000 + index, "elapsedMs": index, "code": code, "value": 0}
            for index, (name, code) in enumerate(zip(names, codes))]


def export_binding(document, *, exported_ns=13_100_000_000):
    raw = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    return {"exportJson": raw, "sha256": hashlib.sha256(raw.encode()).hexdigest(), "bytes": len(raw.encode()),
            "outputMode": 0o600, "exportedNs": exported_ns}


def report_value_v3(isolation, *, candidate="synthetic-preview", build_sha="b" * 64):
    value = report_value_v2(isolation, candidate=candidate, build_sha=build_sha)
    value.update(schema="reverie.preview-workspace.smoke.v3", contract="v3",
                 checks=[{"name": name, "passed": True, "observation": observation} for name, observation in preview_v3.CHECKS])
    old = {"schema": preview_v3.READY_CANDIDATE_SCHEMA, "readyId": "c" * 32,
           "candidate": "smoke-previous-candidate", "sourceHead": "f" * 40, "buildManifestSha256": "e" * 64}
    current = {"candidate": candidate, "sourceHead": SOURCE, "buildManifestSha256": build_sha}
    current_record = {"schema": preview_v3.READY_CANDIDATE_SCHEMA, "readyId": "d" * 32, **current}
    before = {"files": [{"path": "data/runtime/kernel.sqlite3", "size": "16", "sha256": "1" * 64},
                         {"path": "avatars/isolated.avatar", "size": "4", "sha256": "2" * 64}],
              "directories": ["avatars", "data", "data/runtime"], "totalBytes": "20"}
    previous_identity = {key: old[key] for key in current}
    transition = hashlib.sha256(preview_v3.canonical_json({"fromReadyId": old["readyId"],
        "from": previous_identity, "to": current})).hexdigest()
    created = "20261101T050000123Z"
    name = f"snapshot-{created}-{old['candidate']}--{candidate[:32]}-{transition[:32]}-1234abcd"
    manifest = {"schema": preview_v3.SNAPSHOT_SCHEMA, "name": name, "createdAt": created,
        "fromReadyId": old["readyId"], "from": previous_identity, "to": current, "transitionSha256": transition,
        **deepcopy(before)}
    manifest_json = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    snapshot = {"name": name, "manifestJson": manifest_json, "manifestSha256": hashlib.sha256(manifest_json.encode()).hexdigest(),
                "copiedInventory": deepcopy(before)}
    original_start = value["observations"]["forcedExit"]["recovery"]
    start, same = deepcopy(original_start), deepcopy(original_start)
    for entry in (start, same):
        del entry["staleLockObserved"]; del entry["lockRecovered"]
    workspace_id = value["cleanup"]["account"]
    start.update(startedNs=10_000_000_000, readyNs=11_000_000_000, ready=ready(109, 110, workspace_id, candidate))
    same.update(startedNs=12_000_000_000, readyNs=13_000_000_000, ready=ready(111, 112, workspace_id, candidate))
    def exited(host, backend, sent):
        return {"hostPid": host, "signal": "SIGTERM", "sentNs": sent,
                "hostExitedNs": sent + 10_000_000, "hostExitCode": 0, "allGoneNs": sent + 20_000_000,
                "descendantPidsBefore": [backend], "remainingPids": []}
    upgraded_events = events(109)
    added = {"previousReady": old, "beforeInventory": before, "preparedNs": 9_500_000_000,
             "snapshotNamesBefore": [], "start": start, "snapshot": snapshot, "readyRecord": current_record,
             "startupEvents": upgraded_events, "recoveryExit": exited(106, 107, 9_090_000_000),
             "sameCandidate": same, "snapshotNamesAfterSame": [name], "sameReadyRecord": deepcopy(current_record),
             "changedExit": exited(109, 110, 11_500_000_000), "finalExit": exited(111, 112, 14_000_000_000)}
    value["observations"]["versionSnapshot"] = added
    directories = [{"name": name, "exists": True, "bytes": 20, "fileCount": 2,
                    "directoryCount": 1, "skippedLinks": 0, "status": "ok"} for name in preview_v3.DIRECTORIES]
    document = {"schema": preview_v3.DIAGNOSTICS_SCHEMA,
        "runtime": {"candidate": candidate, "sourceShortHash": SOURCE[:8], "runtimeDirectoryCheck": "verified"},
        "system": {"macOSVersion": "15.7.1", "architecture": "arm64"}, "directories": directories,
        "snapshots": {"entries": [{"name": snapshot["name"], "bytes": 20, "fileCount": 2, "checkStatus": "verified"}],
                      "unmanagedCount": 0, "rejectedCount": 0, "truncated": False, "status": "ok"},
        "logs": {"fileCount": 2, "bytes": 20, "skippedLinks": 0, "status": "ok"},
        "events": {"entries": deepcopy(upgraded_events) + events(111, unchanged=True),
                   "rejectedRecords": 0, "truncated": False, "status": "ok"}}
    value["observations"]["diagnostics"] = export_binding(document)
    cleanup = value["cleanup"]
    cleanup.update(finalHostPid=111, finalHostExitCode=0, finalHostExitedNs=14_010_000_000, finalAllGoneNs=14_020_000_000)
    cleanup["hostCleanup"].update(startedNs=14_100_000_000, exitedNs=14_200_000_000)
    return value


def v3_config():
    return {**config_value(enabled=True, version="v3"), "previewWorkspaceChecks": list(preview.SCOPE_ADDITIONS)}


def rebind_manifest(value, change):
    observed = value["observations"]["versionSnapshot"]["snapshot"]
    manifest = json.loads(observed["manifestJson"])
    change(manifest)
    observed["manifestJson"] = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    observed["manifestSha256"] = hashlib.sha256(observed["manifestJson"].encode()).hexdigest()


def rebind_diagnostics(value, change):
    original = value["observations"]["diagnostics"]
    document = json.loads(original["exportJson"])
    change(document)
    value["observations"]["diagnostics"] = export_binding(document, exported_ns=original["exportedNs"])


def test_v3_configuration_requires_both_explicit_additions_and_preserves_old_limits():
    config = validate_config(v3_config())
    assert config["timeoutsSeconds"]["preview-check"] == 600
    assert preview.LIMITS == {"readyMs": 30000, "normalMs": 10000, "duplicateMs": 5000, "forcedMs": 10000}
    assert preview.command(Path("/repo"), config, Path("/report"), Path("/scratch"))[-2:] == ["--contract", "v3"]
    assert "--contract" not in preview.command(Path("/repo"), config_value(enabled=True), Path("/report"), Path("/scratch"))


def test_v3_contract_projection_binds_the_two_explicit_additions():
    args = ({"cases": [], "counts": {}}, {}, {}, {"unitRun": {"sequence": 1}, "requiredGuiRuns": {}}, {})
    projected = registration_contract(v3_config(), *args, code_tree_hash="c" * 40)
    assert projected["runtime"]["previewWorkspaceContract"] == "v3"
    assert projected["runtime"]["previewWorkspaceChecks"] == ["version-snapshot", "sanitized-diagnostics"]


@pytest.mark.parametrize("selection", [None, [], ["version-snapshot"], ["sanitized-diagnostics", "version-snapshot"],
                                        ["version-snapshot", "untrusted-extra"]])
def test_v3_configuration_rejects_missing_partial_or_reordered_additions(selection):
    config = v3_config()
    if selection is None:
        del config["previewWorkspaceChecks"]
    else:
        config["previewWorkspaceChecks"] = selection
    with pytest.raises(ConfigError, match="PREVIEW_V3_CHECK_SELECTION"):
        validate_config(config)


def test_v3_saved_verifier_proves_seven_facts_without_live_probes(tmp_path, monkeypatch):
    value = report_value_v3(tmp_path.resolve())
    def forbidden(*_args, **_kwargs):
        pytest.fail("v3 saved facts must never probe or execute")
    monkeypatch.setattr(Path, "stat", forbidden)
    monkeypatch.setattr(Path, "lstat", forbidden)
    monkeypatch.setattr("subprocess.Popen", forbidden)
    proof = derive(value)
    assert proof["checks"] == 7 and proof["contract"] == "v3"
    assert proof["snapshotBeforeKeychainAndBackend"] and proof["sameCandidateNoNewSnapshot"]
    assert proof["diagnosticsSanitized"] and len(proof["hostPids"]) == len(proof["backendPids"]) == 5


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_v3_reader_keeps_historical_five_check_proofs_unchanged(tmp_path, version):
    value = (report_value if version == "v1" else report_value_v2)(tmp_path.resolve())
    expected = preview._verify_lifecycle_observations(value, expected_source=SOURCE, expected_candidate=value["candidate"],
        expected_build_sha=value["buildManifestSha256"], isolation_root=tmp_path.resolve(), expected_version=version)
    assert derive(value) == expected and expected["checks"] == 5


def test_v3_cannot_be_claimed_by_relabelling_five_check_material(tmp_path):
    value = report_value_v2(tmp_path.resolve())
    value.update(schema="reverie.preview-workspace.smoke.v3", contract="v3")
    with pytest.raises(preview.PreviewError, match="PREVIEW_ORDERED_CHECKS"):
        derive(value)
    full = report_value_v3(tmp_path.resolve())
    with pytest.raises(preview.PreviewError, match="PREVIEW_SUMMARY_VERSION"):
        preview.verify_observations(full, expected_source=SOURCE, expected_candidate=full["candidate"],
            expected_build_sha=full["buildManifestSha256"], isolation_root=tmp_path.resolve(), expected_version="v2")


@pytest.mark.parametrize("field,value,code", [
    ("observations.versionSnapshot.preparedNs", 10_000_000_001, "PREVIEW_V3_PHASE_ORDER"),
    ("observations.versionSnapshot.beforeInventory.files.0.sha256", "3" * 64, "PREVIEW_V3_PRELAUNCH_SNAPSHOT_MISMATCH"),
    ("observations.versionSnapshot.snapshot.copiedInventory.files.0.sha256", "3" * 64, "PREVIEW_V3_SNAPSHOT_COPY_MISMATCH"),
    ("observations.versionSnapshot.snapshot.manifestSha256", "0" * 64, "PREVIEW_V3_MANIFEST_BINDING"),
    ("observations.versionSnapshot.startupEvents.1.code", "REUSED", "PREVIEW_V3_SNAPSHOT_EVENT_RESULT"),
    ("observations.versionSnapshot.startupEvents.1.hostPid", 111, "PREVIEW_V3_STARTUP_EVENT_BINDING"),
    ("observations.versionSnapshot.startupEvents.2.sequence", 4, "PREVIEW_V3_STARTUP_EVENT_BINDING"),
    ("observations.versionSnapshot.startupEvents.2.elapsedMs", 0, "PREVIEW_V3_STARTUP_EVENT_BINDING"),
    ("observations.versionSnapshot.readyRecord.buildManifestSha256", "0" * 64, "PREVIEW_V3_CURRENT_CANDIDATE_NOT_RECORDED"),
    ("observations.versionSnapshot.sameReadyRecord.readyId", "0" * 32, "PREVIEW_V3_CURRENT_CANDIDATE_NOT_RECORDED"),
    ("observations.versionSnapshot.snapshotNamesAfterSame", [], "PREVIEW_V3_SAME_CANDIDATE_SNAPSHOTTED"),
    ("observations.versionSnapshot.start.ready.runtimeWritable", False, "PREVIEW_READY_NOT_WRITABLE"),
    ("observations.versionSnapshot.sameCandidate.ready.recoveryState", "read-only", "PREVIEW_READY_NOT_WRITABLE"),
    ("observations.versionSnapshot.start.readyNs", 40_000_000_001, "PREVIEW_READY_DEADLINE"),
    ("observations.versionSnapshot.sameCandidate.storageItem.modificationTime", "20261101033446Z", "PREVIEW_V3_STORAGE_CHANGED"),
    ("observations.versionSnapshot.changedExit.remainingPids", [110], "PREVIEW_V3_NORMAL_EXIT"),
    ("observations.versionSnapshot.finalExit.sentNs", 13_099_999_999, "PREVIEW_V3_DIAGNOSTICS_EXPORT_BINDING"),
    ("observations.versionSnapshot.finalExit.signal", "SIGKILL", "PREVIEW_V3_NORMAL_EXIT"),
    ("observations.versionSnapshot.finalExit.allGoneNs", 14_020_000_001, "PREVIEW_V3_FINAL_EXIT_BINDING"),
    ("cleanup.finalHostPid", 109, "PREVIEW_FINAL_HOST_EXIT"),
    ("observations.diagnostics.outputMode", 0o644, "PREVIEW_V3_DIAGNOSTICS_EXPORT_BINDING"),
    ("observations.diagnostics.sha256", "0" * 64, "PREVIEW_V3_DIAGNOSTICS_EXPORT_BINDING"),
    ("observations.diagnostics.exportedNs", 12_999_999_999, "PREVIEW_V3_DIAGNOSTICS_EXPORT_BINDING"),
])
def test_v3_directed_counterexamples_start_from_valid_observations(tmp_path, field, value, code):
    report = report_value_v3(tmp_path.resolve())
    assert derive(report)["checks"] == 7
    replace(report, field, value)
    with pytest.raises(preview.PreviewError, match=code):
        derive(report)


def test_v3_rejects_snapshot_event_after_backend_even_when_resequenced(tmp_path):
    report = report_value_v3(tmp_path.resolve())
    rows = report["observations"]["versionSnapshot"]["startupEvents"]
    rows[1], rows[4] = rows[4], rows[1]
    for index, row in enumerate(rows):
        row.update(sequence=index + 1, elapsedMs=index)
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_SNAPSHOT_NOT_BEFORE_KEYCHAIN_OR_BACKEND"):
        derive(report)


@pytest.mark.parametrize("path", ["data/cache/user-file", "logs/private.txt", "data/../private", "/absolute/private"])
def test_v3_rejects_disallowed_manifest_paths_even_with_recomputed_binding(tmp_path, path):
    report = report_value_v3(tmp_path.resolve())
    rebind_manifest(report, lambda manifest: manifest["files"][0].update(path=path))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_SNAPSHOT_PATH"):
        derive(report)


def test_v3_snapshot_inventory_accepts_legal_whitespace_in_unexported_payload_filenames():
    value = {"files": [{"path": "avatars/legal\tname\nfile", "size": "0", "sha256": hashlib.sha256(b"").hexdigest()}],
             "directories": ["data", "avatars"], "totalBytes": "0"}
    assert preview_v3.inventory(value)["files"] == value["files"]


@pytest.mark.parametrize("field,replacement", [("totalBytes", "21"), ("fromReadyId", "0" * 32),
    ("transitionSha256", "0" * 64), ("createdAt", "20260231T050000123Z")])
def test_v3_rejects_bad_manifest_facts_after_rebinding_bytes(tmp_path, field, replacement):
    report = report_value_v3(tmp_path.resolve())
    rebind_manifest(report, lambda manifest: manifest.update({field: replacement}))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_(SNAPSHOT_TOTAL|SNAPSHOT_TRANSITION|SNAPSHOT_NAME_OR_HASH|SNAPSHOT_TIME)"):
        derive(report)


@pytest.mark.parametrize("location,field", [("runtime", "replyServiceAddress"), ("system", "absolutePath"),
    ("snapshots", "importedFilename"), ("logs", "rawLog"), ("events", "secretToken")])
def test_v3_rejects_prohibited_diagnostic_fields_after_valid_byte_rebinding(tmp_path, location, field):
    report = report_value_v3(tmp_path.resolve())
    rebind_diagnostics(report, lambda document: document[location].update({field: "synthetic-private-content"}))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_DIAGNOSTICS_.*FIELDS"):
        derive(report)


@pytest.mark.parametrize("field,replacement,code", [
    ("runtime.candidate", "/Users/private/workspace", "PREVIEW_V3_DIAGNOSTICS_ABSOLUTE_PATH"),
    ("snapshots.entries.0.name", "C:\\Users\\private", "PREVIEW_V3_DIAGNOSTICS_ABSOLUTE_PATH"),
    ("snapshots.entries.0.checkStatus", "invalid", "PREVIEW_V3_DIAGNOSTICS_SNAPSHOT_MISMATCH"),
    ("snapshots.entries", [], "PREVIEW_V3_DIAGNOSTICS_SNAPSHOTS"),
    ("events.entries", [], "PREVIEW_V3_DIAGNOSTICS_EVENTS"),
    ("events.entries.1.event", "arbitrary-event", "PREVIEW_V3_EVENT_VALUE"),
    ("events.entries.1.code", "SECRET_ERROR_CONTENT", "PREVIEW_V3_EVENT_VALUE"),
    ("events.entries.7.code", "FIRST_LAUNCH", "PREVIEW_V3_DIAGNOSTICS_SAME_CANDIDATE_EVENTS"),
    ("events.truncated", True, "PREVIEW_V3_DIAGNOSTICS_EVENTS"),
])
def test_v3_rejects_sanitized_export_counterexamples(tmp_path, field, replacement, code):
    report = report_value_v3(tmp_path.resolve())
    rebind_diagnostics(report, lambda document: replace(document, field, replacement))
    with pytest.raises(preview.PreviewError, match=code):
        derive(report)


def test_v3_export_size_limit_is_checked_even_with_recomputed_hash_and_length(tmp_path):
    report = report_value_v3(tmp_path.resolve())
    raw = " " * (preview.MAX_REPORT_BYTES + 1)
    report["observations"]["diagnostics"].update(exportJson=raw, bytes=len(raw), sha256=hashlib.sha256(raw.encode()).hexdigest())
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_DIAGNOSTICS_EXPORT_BINDING"):
        derive(report)


def test_v3_export_rejects_event_body_fields_in_a_rebound_document(tmp_path):
    report = report_value_v3(tmp_path.resolve())
    rebind_diagnostics(report, lambda document: document["events"]["entries"][0].update(rawMessage="synthetic-private-body"))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_EVENT_FIELDS"):
        derive(report)


@pytest.mark.parametrize("invalid", [-1, 10])
def test_v3_service_failure_events_keep_only_the_structured_provider_enum(invalid):
    row = {**events(109)[0], "event": "service_failure", "code": "PROVIDER_TIMEOUT", "value": 9}
    assert preview_v3.event(row) == row
    row["value"] = invalid
    with pytest.raises(preview.PreviewError, match="PREVIEW_V3_EVENT_VALUE"):
        preview_v3.event(row)


def test_v3_summary_and_saved_raw_observations_are_both_bound(workspace):
    env = workspace
    env.config = v3_config()
    spec, = stages.plan(env.root, env.report, env.config, env.environment, "gui", ["preview"])
    runtime = stages.load_runtime_config(env.report)
    directory = env.report / preview.STAGE
    build = env.root / runtime["candidateDirectory"] / "build.json"
    value = report_value_v3(env.scratch, candidate=build.parent.name, build_sha=hashlib.sha256(build.read_bytes()).hexdigest())
    save_observations(directory, value)
    record = {"previewIsolationRoot": str(env.scratch), "command": list(spec.command), "cwd": str(env.root)}
    result = preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", record)
    assert result["previewWorkspaceEvidence"]["checks"] == 7
    raw = json.loads((directory / "observations.json").read_bytes())
    raw["observations"]["versionSnapshot"]["beforeInventory"]["files"][0]["sha256"] = "9" * 64
    write_json(directory / "observations.json", raw)
    with pytest.raises(preview.PreviewError, match="PREVIEW_RAW_OBSERVATION_CHANGED"):
        preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", record)
