"""Registration orchestration tests use temporary fake repositories only."""
from copy import deepcopy
import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from script.registered_run import registration as reg
from script.registered_run.identities import (
    NODE_EVENT_SCHEMA, combine_reports, parse_ctest_junit, parse_frontend_json,
    parse_node_identity_events, parse_pytest_junit, parse_qtest_transcript,
)
from script.registered_run.state import ExecutionLock, RegistrationState


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def active(root):
    with ExecutionLock(root) as lock:
        return RegistrationState(root, lock).active()


def saved_full_run(root, output, config, source):
    """Save complete synthetic runtime output and genuine parser observations."""
    output.mkdir(parents=True)
    runtime = deepcopy(config)
    runtime.update(runKind="local", package="process-tools", sourceHead=source["head"])
    runtime_hash = dump(output / "runtime-config.json", runtime)
    py = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="tests.test_a" name="test_a"/></testsuite>'
    (output / "python-unit.xml").write_text(py)
    events = [
        {"schema": NODE_EVENT_SCHEMA, "type": "stream:start", "nodeVersion": "v24.19.0"},
        {"schema": NODE_EVENT_SCHEMA, "sequence": 1, "type": "test:pass", "data": {
            "file": str(root / "native-ui/a.test.cjs"), "name": "same", "nesting": 0, "testNumber": 1,
            "skip": None, "todo": None, "reportedType": "test", "failureType": None}},
        {"schema": NODE_EVENT_SCHEMA, "sequence": 2, "type": "test:summary", "data": {
            "file": None, "counts": {"tests": 1, "suites": 0, "passed": 1, "failed": 0, "cancelled": 0, "skipped": 0, "todo": 0}, "success": True}},
        {"schema": NODE_EVENT_SCHEMA, "type": "stream:end", "events": 2, "cases": 1, "summaries": 1},
    ]
    node = "\n".join(json.dumps(event) for event in events) + "\n"
    (output / "node-identities.jsonl").write_text(node)
    frontend = {"success": True, "numTotalTests": 1, "numPassedTests": 1, "numFailedTests": 0, "numPendingTests": 0, "numTodoTests": 0,
        "testResults": [{"name": str(root / "frontend/a.test.ts"), "status": "passed", "assertionResults": [{
            "ancestorTitles": ["suite"], "title": "a", "fullName": "suite a", "status": "passed", "failureMessages": []}]}]}
    dump(output / "frontend-unit.json", frontend)
    ctest = '<testsuite tests="1" failures="0" skipped="0"><testcase name="target" status="run"/></testsuite>'
    (output / "native-unit.xml").write_text(ctest)
    qtest = "\n".join(["1/1 Testing: target", "********* Start testing of Case *********",
        "PASS   : Case::initTestCase()", "PASS   : Case::case()", "PASS   : Case::cleanupTestCase()",
        "Totals: 3 passed, 0 failed, 0 skipped, 0 blacklisted, 1ms", "********* Finished testing of Case *********", "<end of output>"])
    (output / "native-lasttest.log").write_text(qtest)
    reports = [parse_pytest_junit(py, config["pythonTargets"]), parse_node_identity_events(node, config["nodeTests"], root),
        parse_frontend_json(frontend, config["frontendTests"], root),
        combine_reports([parse_ctest_junit(ctest, config["nativeTargets"]), parse_qtest_transcript(qtest)])]
    manifest = reg.collect_saved_outputs(output, runtime, root)
    identity_hash = dump(output / "identities.json", manifest)
    metadata = {"path": str((output / "identities.json").relative_to(root)), "sha256": identity_hash,
                "bytes": (output / "identities.json").stat().st_size}
    ledger = {"schema": "reverie.shared-run.ledger.v1", "kind": "local", "passed": True,
        "sourceHead": source["head"], "sourceTreeHash": source["treeHash"], "codeTreeHash": source["codeTreeHash"], "identityManifest": metadata,
        "unitScratchRemoved": True, "ownedProcessesRemaining": 0,
        "runtimeConfigBinding": {"path": str((output / "runtime-config.json").relative_to(root)),
                                 "sha256": runtime_hash, "bytes": (output / "runtime-config.json").stat().st_size}, "runs": []}
    for label, report in zip(("python", "node", "frontend", "native"), reports):
        key = label + "ActualIdentities"
        ledger[key] = report
        ledger["runs"].append({"id": label + "-unit", "passed": True, "exitCode": 0, "state": "completed",
                               "processGroupGone": True, "evidence": {key: report}})
    dump(output / "run-ledger.json", ledger)
    return manifest, metadata


def saved_gui_run(root, output, config, source):
    """Original GUI report/ledger shapes with explicitly synthetic values."""
    mode, stage = "persona", "persona-check"
    runtime = deepcopy(config)
    runtime.update(runKind="local", package="process-tools", sourceHead=source["head"], candidateName=None,
                   candidateDirectory=".tools/qt-builds/local-process-tools", cmakeDirectory=".tools/qt-builds/local-process-tools")
    runtime_hash = dump(output / "runtime-config.json", runtime)
    report_root = root / ".tools/reports/qt-synthetic-persona"
    reports, raw = [], []
    for cycle in (1, 2):
        report = {"cycle": str(cycle), "passed": True, "error": "", "syntheticUnitFixture": True}
        path = report_root / ("cycle-" + str(cycle) + ".json")
        digest = dump(path, report)
        reports.append(report)
        raw.append({"path": str(path.relative_to(root)), "sha256": digest, "bytes": path.stat().st_size})
    archive = {"schema": "reverie.archive-control-readiness.evidence.v1", "passed": True, "mode": mode,
               "cycleActionCounts": [0, 0], "actions": [], "focusTraversal": [], "contentCollected": False}
    forced = {"forcedCleanup": False, "forcedCleanupTargets": 0, "forcedCleanupSignalsSent": 0,
              "forcedCleanupIdentityChanged": 0, "forcedCleanupErrors": []}
    priority = {"passed": True, "checks": [6, 4], "http": 25, "legacyHttp": 22, "priorityHttp": 3,
                "preparationWrites": [1, 0], "saveWrites": [2, 0]}
    book = {"passed": True, "checks": [7, 4], "http": 3, "preparationWrites": [1, 0], "saveWrites": [2, 0], "chats": [3, 0]}
    row_proof = {"passed": True, "contract": "synthetic-format-only", "steps": [[], []], "dispatches": [0, 0]}
    author = {"passed": True, "steps": [[], []], "mouseDispatches": [0, 0], "toggledSignals": [0, 0], "writeRequestId": "synthetic"}
    summary = {"sourceHead": source["head"], "passed": True, "automaticRetry": False, "applicationDeadlineMs": 240000,
               **{key: True for key in ("noResidualProcesses", "testDataRemoved", "applicationUnchanged", "modelInputUnchanged")},
               "reports": reports, "processExits": [{"cycle": cycle, "exitCode": 0, "signal": None, "remaining": []} for cycle in (1, 2, "cleanup")],
               **forced, "archiveControlReadinessEvidence": archive, "worldbookPriority": priority, "worldbookBookSettings": book,
               "personaRowInputEvidence": row_proof, "authorControlInputEvidence": author}
    summary_hash = dump(report_root / "summary.json", summary)
    snapshot_path = output / (stage + "-report-roots-before.json")
    snapshot_hash = dump(snapshot_path, {"schema": "reverie.gui-report-roots-before.v1", "stage": stage,
                                       "capturedUtc": "2026-10-27T00:00:00Z", "roots": [], "count": 0})
    record = {"reportRootsBefore": 0, "reportRootsBeforeManifest": {"path": str(snapshot_path.relative_to(root)),
        "sha256": snapshot_hash, "bytes": snapshot_path.stat().st_size, "count": 0, "stage": stage},
        "reportRoot": str(report_root), "summarySha256": summary_hash, "rawReportBinding": raw,
        "archiveControlReadinessEvidence": archive, "forcedCleanupEvidence": forced,
        "worldbookPriorityEvidence": {"priority": priority, "bookSettings": book}, "personaRowInputEvidence": row_proof,
        "authorControlInputEvidence": author}
    (output / (stage + ".log")).write_text(json.dumps({"reportRoot": str(report_root)}) + "\n")
    run = {"id": stage, "passed": True, "exitCode": 0, "state": "completed", "processGroupGone": True,
           "command": [str(root / "script/check-qt-macos.sh"), "--build-dir", str(root / runtime["candidateDirectory"]), "--p1-persona"],
           "cwd": str(root), "evidence": {"guiResults": {stage: record}}}
    dump(output / "run-ledger.json", {"schema": "reverie.shared-run.ledger.v1", "kind": "local", "passed": True,
        "sourceHead": source["head"], "sourceTreeHash": source["treeHash"], "codeTreeHash": source["codeTreeHash"], "unitScratchRemoved": True,
        "ownedProcessesRemaining": 0, "runtimeConfigBinding": {"path": str((output / "runtime-config.json").relative_to(root)),
        "bytes": (output / "runtime-config.json").stat().st_size, "sha256": runtime_hash}, "runs": [run], "guiResults": {stage: record}})
    return report_root


def saved_legacy_gui(root, report_dir, baseline, mode):
    stage = mode + "-check"
    roots = sorted(str(path.relative_to(root)) for path in (root / ".tools/reports").glob("qt-*") if path.is_dir())
    report_root = root / ".tools/reports" / ("qt-synthetic-baseline-" + mode)
    reports, raw = [], []
    for cycle in (1, 2):
        report = {"passed": True, "error": "", "cycle": str(cycle), "syntheticUnitFixture": True}
        path = report_root / ("cycle-" + str(cycle) + ".json")
        digest = dump(path, report)
        reports.append(report)
        raw.append({"path": str(path.relative_to(root)), "sha256": digest, "bytes": path.stat().st_size})
    archive = {"schema": "reverie.archive-control-readiness.evidence.v1", "passed": True, "mode": mode,
               "cycleActionCounts": [0, 0], "actions": [], "focusTraversal": [], "contentCollected": False}
    forced = {"forcedCleanup": False, "forcedCleanupTargets": 0, "forcedCleanupSignalsSent": 0,
              "forcedCleanupIdentityChanged": 0, "forcedCleanupErrors": []}
    simple = {"passed": True, "syntheticUnitFixture": True}
    proof = {key: deepcopy(simple) for key in reg.GUI_PROOF_KEYS[mode]}
    summary = {"sourceHead": baseline["sourceHead"], "passed": True, "automaticRetry": False, "applicationDeadlineMs": 240000,
               **{key: True for key in ("noResidualProcesses", "testDataRemoved", "applicationUnchanged", "modelInputUnchanged")},
               "reports": reports, "processExits": [{"cycle": cycle, "exitCode": 0, "signal": None, "remaining": []} for cycle in (1, 2, "cleanup")],
               **forced, "archiveControlReadinessEvidence": archive}
    if mode in ("injection", "regex", "entry"):
        evidence, key = {"injection": ("worldbookInjectionEvidence", "worldbookInjection"),
            "regex": ("worldbookRegexEvidence", "worldbookRegex"), "entry": ("worldbookEntrySettingsEvidence", "worldbookEntrySettings")}[mode]
        proof[evidence] = {"checkCountsByCycle": [{}, {}], "requests": 0, "messageCount": 0, "proof": deepcopy(simple)}
        summary[key] = deepcopy(simple)
    elif mode == "persona":
        proof["worldbookPriorityEvidence"] = {"priority": deepcopy(simple), "bookSettings": deepcopy(simple)}
        summary.update(worldbookPriority=deepcopy(simple), worldbookBookSettings=deepcopy(simple),
                       personaRowInputEvidence=deepcopy(simple), authorControlInputEvidence=deepcopy(simple))
    if mode == "candidate":
        proof.update(checkCountsByCycle=[{}, {}], requests=7, messageIdsAcrossRestartEqual=True)
    summary_hash = dump(report_root / "summary.json", summary)
    snapshot = report_dir / (stage + "-report-roots-before.json")
    snapshot_hash = dump(snapshot, {"schema": "reverie.gui-report-roots-before.v1", "stage": stage,
                                  "capturedUtc": "2026-10-26T00:00:00Z", "roots": roots, "count": len(roots)})
    record = {"reportRootsBefore": len(roots), "reportRootsBeforeManifest": {"path": str(snapshot.relative_to(root)), "sha256": snapshot_hash,
        "bytes": snapshot.stat().st_size, "count": len(roots), "stage": stage}, "reportRoot": str(report_root), "summarySha256": summary_hash,
        "rawReportBinding": raw, "archiveControlReadinessEvidence": archive, "forcedCleanupEvidence": forced, **proof}
    (report_dir / (stage + ".log")).write_text(json.dumps({"reportRoot": str(report_root)}) + "\n")
    run = {"id": stage, "state": "completed", "exitCode": 0, "processGroupGone": True,
           "command": [str(root / "script/check-qt-macos.sh"), "--build-dir", str(root / baseline["candidateDirectory"]), *dict(reg.MODE_OPTIONS)[mode]],
           "cwd": str(root), "evidence": {"guiResults": {stage: record}}}
    return record, run


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    root = tmp_path.resolve()
    baseline_dir = root / ".tools/reports/signed-baseline"
    protected_state = {}
    protected_path = baseline_dir / "protected-tracked-data.json"
    protected_sha = dump(protected_path, {})
    baseline = {"schema": "reverie.p1.worldbook-injection.r1.formal.registration.v1",
        "kind": "Formal synthetic twelve-stage adopted baseline for registration-tool unit tests",
        "registrationId": "signed-baseline", "sourceHead": "a" * 40, "sequence": list(reg.STAGE_BUDGETS),
        "candidateName": "signed-accepted", "candidateDirectory": ".tools/qt-candidates/signed-accepted",
        "cmakeDirectory": ".tools/qt-builds/signed-accepted",
        "pythonTargets": ["tests/test_a.py"], "expectedPythonIdentities": ["tests/test_a.py::test_a"],
        "nodeTests": ["native-ui/a.test.cjs"], "expectedNodeNames": {"native-ui/a.test.cjs": ["same"]},
        "frontendTests": ["frontend/a.test.ts"], "expectedFrontendNames": {"frontend/a.test.ts": ["suite a"]},
        "nativeTargets": ["target"], "expectedNativeIdentities": {"target": ["Case::initTestCase()", "Case::case()", "Case::cleanupTestCase()"]},
        "protectedTrackedData": {}, "protectedTrackedDataManifest": {"path": str(protected_path.relative_to(root)),
            "sha256": protected_sha, "bytes": protected_path.stat().st_size},
        "historicalEvidence": {"historical.txt": hashlib.sha256(b"history").hexdigest()}}
    (root / "historical.txt").write_bytes(b"history")
    registration_hash = dump(baseline_dir / "registration.json", baseline)
    build_path = root / baseline["candidateDirectory"] / "build.json"
    build_sha = dump(build_path, {"candidate": baseline["candidateName"], "source": {"head": baseline["sourceHead"], "postBuildInventoryVerified": True},
                                "compilation": {"cmakeDirectory": str(root / baseline["cmakeDirectory"])}})
    pointer_sha = dump(baseline_dir / "sdk-default-pointer.json", {"directory": str(build_path.parent), "buildManifestSha256": build_sha})
    baseline_ledger_hash = dump(baseline_dir / "run-ledger.json", {"schema": "reverie.p1.worldbook-injection.r1.formal.ledger.v1",
        "passed": True, "sourceHead": baseline["sourceHead"],
        "registrationId": baseline["registrationId"], "registrationSha256": registration_hash,
        "scratchRemoved": True, "defaultPointerAdoptedAfterFullPass": True, "defaultPointerAdoptedAtEnd": True,
        "adoptedPointerSha256": pointer_sha, "runs": [{"id": stage, "state": "completed", "exitCode": 0, "processGroupGone": True} for stage in baseline["sequence"]]})
    dump(baseline_dir / "authorization.json", {"approved": True, "userApprovalText": "old approval"})
    dump(root / "docs/evidence/signed-baseline.json", {"formalAcceptance": True, "artifacts": []})
    # Real commit identity for ancestry checks; all engine outputs stay synthetic.
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "--allow-empty", "-qm", "synthetic fixture"], check=True)
    fixture_head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    source = {"head": fixture_head, "treeHash": "c" * 40, "codeTreeHash": "e" * 40,
              "dirty": False, "files": [], "scope": "fake-explicit-source"}
    config = {"configSchema": reg.CONFIG_SCHEMA, "registrationId": "tooling-validation", "runKind": "tool-validation", "adoptCandidate": False,
        "sequence": list(reg.STAGE_BUDGETS), "budgets": {name: 1 for name in reg.STAGE_BUDGETS.values()},
        "timeoutsSeconds": {stage: 30 for stage in reg.STAGE_BUDGETS}, "stopOnFirstFailure": True, "retries": 0,
        "requiredGuiModes": ["persona"], "nodeIdentityReport": "node-identities.jsonl", "node": ".tools/node/bin/node",
        "candidateName": "fake-candidate", "candidateDirectory": ".tools/qt-candidates/fake-candidate", "cmakeDirectory": ".tools/qt-builds/fake-build",
        "baselineSource": {"report": str(baseline_dir.relative_to(root)), "sourceHead": baseline["sourceHead"],
                           "registrationSha256": registration_hash, "ledgerSha256": baseline_ledger_hash},
        **{key: baseline[key] for key in reg.UNIT_KEYS}, "expectedUnitCounts": {}}
    output = root / ".tools/local/process-tools/runs/full"
    manifest, identity_metadata = saved_full_run(root, output, config, source)
    for filename in ("python-unit.xml", "frontend-unit.json", "native-unit.xml", "native-lasttest.log"):
        (baseline_dir / filename).write_bytes((output / filename).read_bytes())
    (baseline_dir / "node-unit.log").write_text("TAP version 13\n# Subtest: same\nok 1 - same\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n")
    gui_output = root / ".tools/local/process-tools/runs/gui-persona"
    gui_report = saved_gui_run(root, gui_output, config, source)
    baseline_ledger = json.loads((baseline_dir / "run-ledger.json").read_text())
    baseline_ledger["guiResults"] = {}
    gui_roots = []
    for mode in reg.GUI_MODES:
        record, run = saved_legacy_gui(root, baseline_dir, baseline, mode)
        baseline_ledger["guiResults"][mode + "-check"] = record
        existing = next(row for row in baseline_ledger["runs"] if row["id"] == mode + "-check")
        existing.update(run)
        gui_roots.append(Path(record["reportRoot"]))
    config["baselineSource"]["ledgerSha256"] = dump(baseline_dir / "run-ledger.json", baseline_ledger)
    public_files = sorted([path for path in baseline_dir.rglob("*") if path.is_file()] + [build_path] +
                          [path for directory in gui_roots for path in directory.rglob("*") if path.is_file()])
    dump(root / "docs/evidence/signed-baseline.json", {"schema": "reverie.p1.worldbook-injection.r1.formal.result.v1",
        "registrationId": baseline["registrationId"], "sourceHead": baseline["sourceHead"], "overallPassed": True, "formalAcceptance": True,
        "artifacts": [{"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                       "bytes": path.stat().st_size} for path in public_files]})
    rows = [dict(sequence=1, sourceHead=source["head"], sourceTreeHash=source["treeHash"], codeTreeHash=source["codeTreeHash"], sourceDirty=False,
                 category="full", selection="registered", passed=True, exitCode=0, diagnostic=False, unstable=False,
                 outputDirectory=str(output), identityManifest=identity_metadata),
            dict(sequence=2, sourceHead=source["head"], sourceTreeHash=source["treeHash"], codeTreeHash=source["codeTreeHash"], sourceDirty=False,
                 category="gui", selection="persona", passed=True, exitCode=0, diagnostic=False, unstable=False,
                 outputDirectory=str(gui_output), guiModes=["persona"])]
    ledger = root / ".tools/local/process-tools/ledger.jsonl"
    def write_rows():
        ledger.write_text("".join(json.dumps(row) + "\n" for row in rows))
    def refresh_baseline_binding():
        baseline_ledger = json.loads((baseline_dir / "run-ledger.json").read_text())
        baseline_ledger["registrationSha256"] = hashlib.sha256((baseline_dir / "registration.json").read_bytes()).hexdigest()
        dump(baseline_dir / "run-ledger.json", baseline_ledger)
        config["baselineSource"].update(sourceHead=baseline["sourceHead"],
            registrationSha256=hashlib.sha256((baseline_dir / "registration.json").read_bytes()).hexdigest(),
            ledgerSha256=hashlib.sha256((baseline_dir / "run-ledger.json").read_bytes()).hexdigest())
        public_path = root / "docs/evidence/signed-baseline.json"
        public = json.loads(public_path.read_text())
        for artifact in public["artifacts"]:
            artifact_path = root / artifact["path"]
            artifact.update(sha256=hashlib.sha256(artifact_path.read_bytes()).hexdigest(), bytes=artifact_path.stat().st_size)
        dump(public_path, public)
    write_rows()
    monkeypatch.setattr(reg, "snapshot_source", lambda *_: deepcopy(source))
    def assert_fake_frozen(_, expected, **kwargs):
        if any(source[key] != expected[key] for key in ("head", "treeHash", "files")) or (
                kwargs.get("require_clean", True) and source["dirty"]):
            raise reg.RegistrationError("FAKE_FROZEN_SOURCE_CHANGED")
        return deepcopy(expected)
    monkeypatch.setattr(reg, "assert_frozen", assert_fake_frozen)
    # This orchestration fixture has no default data or real Git checkout.
    # The dedicated protected-data tests exercise the real metadata-only guard.
    monkeypatch.setattr(reg, "protected_data_snapshot", lambda *_: deepcopy(protected_state))
    monkeypatch.setattr(reg, "_validated_config", lambda _, value: deepcopy(value))
    monkeypatch.setattr(reg, "_audit_sources", lambda *args: {"schema": "reverie.registered-run.test-audit.v1", "signedChanges": [],
        "otherChanges": [], "rejectedChangeIds": [], "registrationAllowed": True})
    return SimpleNamespace(root=root, baseline=baseline, baseline_dir=baseline_dir, config=config, source=source,
                           rows=rows, write_rows=write_rows, ledger=ledger, manifest=manifest,
                           output=output, refresh_baseline_binding=refresh_baseline_binding,
                           gui_output=gui_output, gui_report=gui_report,
                           protected_state=protected_state,
                           report=root / ".tools/reports/tooling-validation")


def freeze(prepared):
    return reg.freeze(prepared.root, "process-tools", prepared.config, prepared.report)


def test_freeze_saves_data_hashes_actual_expectations_and_active_marker(prepared):
    result = freeze(prepared)
    assert result["toolCommit"] == prepared.source["head"]
    config = json.loads((prepared.report / "config.json").read_text())
    assert config["expectedPythonCount"] == 1
    assert config["expectedUnitCounts"]["qtTestTotals"] == 3
    assert config["expectedUnitCounts"]["lifecycleRows"] == 2
    assert config["expectedNativeIdentities"]["target"] == prepared.baseline["expectedNativeIdentities"]["target"]
    assert active(prepared.root)["registrationId"] == "tooling-validation"
    assert not (prepared.report / "run-once.py").exists()
    assert not (prepared.report / "authorization.json").exists()
    for filename, sha in result["artifacts"].items():
        assert hashlib.sha256((prepared.report / filename).read_bytes()).hexdigest() == sha


def test_freeze_rejects_dirty_source_or_missing_same_source_full_run(prepared):
    prepared.source["dirty"] = True
    with pytest.raises(reg.RegistrationError, match="CLEAN_FROZEN_SOURCE"):
        freeze(prepared)
    assert active(prepared.root) is None
    prepared.source["dirty"] = False
    prepared.rows[0]["sourceTreeHash"] = "d" * 40
    prepared.write_rows()
    with pytest.raises(reg.RegistrationError, match="COMPLETE_ACTUAL_UNIT_PASS"):
        freeze(prepared)


def test_freeze_requires_actual_manifest_hash_and_complete_selected_files(prepared):
    prepared.rows[0]["identityManifest"]["sha256"] = "0" * 64
    prepared.write_rows()
    with pytest.raises(reg.RegistrationError, match="IDENTITY_MANIFEST_HASH_CHANGED"):
        freeze(prepared)


def test_freeze_requires_changed_gui_mode_pass_on_same_clean_source(prepared):
    prepared.rows[1]["sourceDirty"] = True
    prepared.write_rows()
    with pytest.raises(reg.RegistrationError, match="LOCAL_FROZEN_GUI_PASS_REQUIRED:persona"):
        freeze(prepared)


def test_freeze_does_not_erase_unanalysed_failure_with_later_pass(prepared):
    failed = {**prepared.rows[0], "sequence": 1, "passed": False, "exitCode": 1}
    prepared.rows[:] = [failed, {**prepared.rows[0], "sequence": 2}, {**prepared.rows[1], "sequence": 3}]
    prepared.write_rows()
    with pytest.raises(reg.RegistrationError, match="LOCAL_UNANALYSED_FAILURE_OR_INSTABILITY"):
        freeze(prepared)
    analyses = prepared.ledger.parent / "analyses.jsonl"
    analyses.write_text(json.dumps({"failureSequences": [1], "note": "analysed and reported to user", "reportedToUser": True}) + "\n")
    assert freeze(prepared)["state"] == "frozen-awaiting-explicit-run-approval"


def test_unstable_diagnostic_pass_cannot_satisfy_prerequisite(prepared):
    prepared.rows[0].update(unstable=True, diagnostic=True)
    prepared.write_rows()
    analyses = prepared.ledger.parent / "analyses.jsonl"
    analyses.write_text(json.dumps({"failureSequences": [1], "note": "instability analysed", "reportedToUser": True}) + "\n")
    with pytest.raises(reg.RegistrationError, match="COMPLETE_ACTUAL_UNIT_PASS"):
        freeze(prepared)


def test_freeze_rejects_unconfirmed_signed_audit_change(prepared, monkeypatch):
    monkeypatch.setattr(reg, "_audit_sources", lambda *args: {"schema": "reverie.registered-run.test-audit.v1", "signedChanges": [{
        "kind": "body-edited", "framework": "python", "identity": "tests/test_a.py::test_a",
        "beforeHash": "a" * 64, "afterHash": "b" * 64, "changeId": "concrete-change-id", "confirmed": False}],
        "otherChanges": [], "rejectedChangeIds": ["concrete-change-id"], "registrationAllowed": False})
    # Even an adapter that returns an unapproved report cannot bypass freeze.
    with pytest.raises(Exception, match="UNCONFIRMED_SIGNED_TEST_CHANGES"):
        freeze(prepared)


def test_historical_snapshot_inherits_and_adds_full_baseline_without_modifying_it(prepared):
    before = {str(path): path.read_bytes() for path in prepared.baseline_dir.rglob("*") if path.is_file()}
    freeze(prepared)
    historical = json.loads((prepared.report / "historical-evidence.json").read_text())
    assert historical["historical.txt"] == hashlib.sha256(b"history").hexdigest()
    assert str((prepared.baseline_dir / "authorization.json").relative_to(prepared.root)) in historical
    assert {str(path): path.read_bytes() for path in prepared.baseline_dir.rglob("*") if path.is_file()} == before
    (prepared.root / "historical.txt").write_bytes(b"changed")
    with pytest.raises(reg.RegistrationError, match="HISTORICAL_EVIDENCE_CHANGED"):
        reg._historical_unchanged(prepared.root, historical)


def test_historical_manifest_same_path_conflicting_hash_rejects(prepared):
    public = prepared.root / "docs/evidence/signed-baseline.json"
    dump(public, {"formalAcceptance": True, "artifacts": [{"path": "historical.txt", "sha256": "0" * 64}]})
    with pytest.raises(reg.RegistrationError, match="HISTORICAL_MANIFEST_HASH_CONFLICT"):
        reg._historical_snapshot(prepared.root, prepared.baseline_dir, prepared.baseline, prepared.config)


def test_authorization_records_exact_original_text_and_bindings_once(prepared):
    frozen = freeze(prepared)
    text = "  批准一次工具验证批运行\n原文保留  "
    authorization = reg.authorize_registration(prepared.root, prepared.report, text)
    assert authorization["userApprovalText"] == text
    assert authorization["approved"] is True
    assert authorization["configSha256"] == frozen["configSha256"]
    with pytest.raises(FileExistsError):
        reg.authorize_registration(prepared.root, prepared.report, "second")


def test_void_releases_only_current_marker_and_preserves_frozen_bytes(prepared):
    freeze(prepared)
    original = (prepared.report / "registration.json").read_bytes()
    result = reg.void_registration(prepared.root, "tooling-validation", "direction replaced")
    assert result["reason"] == "direction replaced"
    assert active(prepared.root) is None
    assert (prepared.report / "registration.json").read_bytes() == original
    with pytest.raises(Exception):
        reg.void_registration(prepared.root, "old-signed-batch", "unrelated")
    assert not (prepared.baseline_dir / "void.json").exists()


def fake_runtime(prepared, monkeypatch, *, fail=False, mutate_auth=False, mutate_history=False, mutate_runtime=False, mutate_protected=False,
                 real_plan=False, cleanup_state=None, fail_final_save=False, post_mutation=None):
    from script.registered_run import engine, stages
    calls = []
    def plan(root, output, config, environment, category, selection):
        assert category == "registered"
        assert selection is None
        candidate = root / config["candidateDirectory"]
        candidate.mkdir(parents=True)
        (candidate / "build.json").write_bytes(b'{"candidate":"fake-candidate"}\n')
        pointer = {"directory": str(candidate), "buildManifestSha256": hashlib.sha256((candidate / "build.json").read_bytes()).hexdigest()}
        dump(output / "runtime-config.json", config)
        calls.append("plan")
        return [SimpleNamespace(id=stage) for stage in config["sequence"]], json.dumps(pointer).encode()
    pointer = {}
    def planned(*args):
        selected, payload = plan(*args)
        pointer["payload"] = payload
        return selected
    class FakeEngine:
        def __init__(self, root, report_dir, **kwargs):
            self.root, self.report_dir, self.options = root, report_dir, kwargs
            self.isolation = kwargs["isolation"]
            self.ledger = {"passed": False, "runs": [], "used": {}, "frozenChecks": [], "sourceHead": None,
                           "ownedProcessesRemaining": 0, "unitScratchRemoved": False}
            self.pointer_guard = engine.PointerGuard(root / ".tools/qt-candidates/last-local-sdk.json", writable=True)
            self.pointer_guard.captured = pointer.get("payload")
        @property
        def captured_pointer(self):
            return self.pointer_guard.captured
        def run(self, selected, *, finalize=None, adopt=None, post_adopt=None):
            try:
                self.options["frozen"]("before-attempt", self.ledger)
                for stage in selected:
                    self.options["frozen"]("before-" + stage.id, self.ledger)
                    calls.append(stage.id)
                    if mutate_auth:
                        data = json.loads((self.report_dir / "authorization.json").read_text())
                        data["userApprovalText"] += "changed"
                        dump(self.report_dir / "authorization.json", data)
                    if mutate_history:
                        (self.root / "historical.txt").write_bytes(b"changed")
                    if mutate_runtime:
                        data = json.loads((self.report_dir / "runtime-config.json").read_text())
                        data["sourceHead"] = "changed"
                        dump(self.report_dir / "runtime-config.json", data)
                    if mutate_protected:
                        prepared.protected_state["synthetic-index-change"] = {"stage": "0"}
                    self.options["frozen"]("after-" + stage.id, self.ledger)
                    self.ledger["runs"].append({"id": stage.id, "passed": not fail, "exitCode": 1 if fail else 0,
                                                "state": "completed", "processGroupGone": True,
                                                "command": list(getattr(stage, "command", []))})
                    if fail:
                        break
                if not fail:
                    self.ledger.update(finalize(self))
                self.ledger["unitScratchRemoved"] = self.isolation.cleanup()
                if adopt is not None and not fail:
                    assert self.ledger["unitScratchRemoved"] is True
                    calls.append("adopt")
                    self.pointer_guard.adopt(adopt(self))
                    self.ledger["defaultPointerCandidateVerified"] = True
                    if post_mutation == "auth":
                        data = json.loads((self.report_dir / "authorization.json").read_text())
                        data["userApprovalText"] += " changed after adoption"
                        dump(self.report_dir / "authorization.json", data)
                    elif post_mutation == "pointer":
                        self.pointer_guard.path.write_bytes(b'{"unexpected":true}\n')
                    elif post_mutation in ("config", "runtime"):
                        filename = "config.json" if post_mutation == "config" else "runtime-config.json"
                        with (self.report_dir / filename).open("ab") as stream:
                            stream.write(b"\n")
                    elif post_mutation == "history":
                        (self.root / "historical.txt").write_bytes(b"changed after adoption")
                    elif post_mutation == "source":
                        prepared.source["treeHash"] = "f" * 40
                    elif post_mutation == "protected":
                        prepared.protected_state["synthetic-index-change"] = {"stage": "0"}
                    assert post_adopt is not None
                    post_adopt(self)
                self.ledger["passed"] = not fail
            except BaseException as error:
                self.ledger.update(passed=False, stopReason=str(error))
            finally:
                if not self.isolation.removed:
                    self.ledger["unitScratchRemoved"] = self.isolation.cleanup()
                if not self.ledger["passed"] or adopt is None:
                    self.pointer_guard.restore()
                    self.ledger["priorDefaultPointerRestored"] = True
                if cleanup_state:
                    self.ledger["passed"] = False
                    if cleanup_state == "scratch":
                        self.ledger["unitScratchRemoved"] = False
                    else:
                        self.ledger["runs"][-1].update(spawnAttempted=True, ownedProcessGroup=42424, processGroupGone=False)
                        self.ledger["ownedProcessesRemaining"] = 1 if cleanup_state == "unknown-group" else 0
                dump(self.report_dir / "run-ledger.json", self.ledger)
            if fail_final_save:
                raise OSError("synthetic final ledger publication failed")
            return self.ledger
    if not real_plan:
        monkeypatch.setattr(stages, "plan", planned)
    monkeypatch.setattr(engine, "Engine", FakeEngine)
    monkeypatch.setattr(reg, "collect_saved_outputs", lambda *args: deepcopy(prepared.manifest))
    return calls


def test_registered_run_requires_separate_approval_and_consumes_failure(prepared, monkeypatch):
    freeze(prepared)
    calls = fake_runtime(prepared, monkeypatch)
    with pytest.raises(FileNotFoundError):
        reg.run_registered(prepared.root, prepared.report)
    assert calls == []
    assert active(prepared.root) is None
    assert (prepared.report / "run-claim.json").exists()
    assert json.loads((prepared.report / "run-ledger.json").read_text())["passed"] is False
    with pytest.raises(reg.RegistrationError):
        reg.run_registered(prepared.root, prepared.report)


def test_tool_validation_and_development_never_adopt(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    calls = fake_runtime(prepared, monkeypatch)
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is True
    assert result["identityMultiplicitiesMatch"] is True
    assert "adopt" not in calls
    assert active(prepared.root) is None


def test_formal_adoption_uses_actual_pointer_directory_and_manifest_hash_after_cleanup(prepared, monkeypatch):
    prepared.config.update(runKind="formal", adoptCandidate=True)
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次正式批运行")
    calls = fake_runtime(prepared, monkeypatch)
    assert reg.run_registered(prepared.root, prepared.report)["passed"] is True
    assert calls[-1] == "adopt"


@pytest.mark.parametrize("mutation", ["auth", "history"])
def test_stage_boundaries_reject_mutated_authorization_or_full_history(prepared, monkeypatch, mutation):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    calls = fake_runtime(prepared, monkeypatch, mutate_auth=mutation == "auth", mutate_history=mutation == "history")
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is False
    assert "AUTHORIZATION_BYTES_CHANGED" in result["stopReason"] or "HISTORICAL_EVIDENCE_CHANGED" in result["stopReason"]
    assert len([call for call in calls if call in reg.STAGE_BUDGETS]) == 1
    assert active(prepared.root) is None


def test_failed_attempt_releases_marker_without_adoption_or_retry(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    calls = fake_runtime(prepared, monkeypatch, fail=True)
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is False
    assert "adopt" not in calls
    assert active(prepared.root) is None
    assert (prepared.report / "run-claim.json").exists()


def test_tampered_frozen_artifact_consumes_attempt_and_releases_own_marker(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    fake_runtime(prepared, monkeypatch)
    (prepared.report / "config.json").write_text('{}\n')
    with pytest.raises(reg.RegistrationError, match="FROZEN_ARTIFACT_CHANGED"):
        reg.run_registered(prepared.root, prepared.report)
    assert active(prepared.root) is None
    assert (prepared.report / "run-claim.json").exists()


def test_runtime_identity_deletion_cannot_hide_behind_unchanged_test_bodies(prepared):
    prepared.baseline["expectedPythonIdentities"].append("tests/test_a.py::test_removed")
    dump(prepared.baseline_dir / "registration.json", prepared.baseline)
    path = prepared.baseline_dir / "python-unit.xml"
    path.write_text(path.read_text().replace('tests="1"', 'tests="2"').replace("</testsuite>",
        '<testcase classname="tests.test_a" name="test_removed"/></testsuite>'))
    prepared.refresh_baseline_binding()
    with pytest.raises(Exception, match="UNCONFIRMED_SIGNED_TEST_CHANGES"):
        freeze(prepared)
    assert active(prepared.root) is None
    assert not prepared.report.exists()


def test_runtime_identity_deletion_needs_exact_hash_bound_confirmation(prepared):
    old = deepcopy(prepared.manifest)
    after = deepcopy(old)
    after["cases"] = [case for case in after["cases"] if case["framework"] != "python"]
    difference = reg.compare_manifests(old, after)
    audit = {"signedChanges": [], "rejectedChangeIds": [], "registrationAllowed": True}
    reg._protect_runtime_deletions(audit, difference, old, after, prepared.config)
    change = audit["signedChanges"][0]
    assert change["kind"] == "runtime-identity-deleted"
    assert audit["registrationAllowed"] is False
    direction = {"path": "docs/direction.md", "sha256": "f" * 64, "section": "explicit retirement"}
    prepared.config["testChangeDirectionDocument"] = direction
    prepared.config["confirmedTestChanges"] = [{key: change[key] for key in ("changeId", "identity", "kind", "beforeHash", "afterHash")}]
    prepared.config["confirmedTestChanges"][0].update(directionDocument=direction, authorization="explicitly confirm this identity retirement", confirmedAt="2026-10-27")
    audit = {"signedChanges": [], "rejectedChangeIds": [], "registrationAllowed": True}
    reg._protect_runtime_deletions(audit, difference, old, after, prepared.config)
    assert audit["registrationAllowed"] is True


def test_stage_boundary_binds_actual_runtime_config_bytes(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    calls = fake_runtime(prepared, monkeypatch, mutate_runtime=True)
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is False
    assert "REGISTERED_RUNTIME_CONFIG_BYTES_CHANGED" in result["stopReason"]
    assert len([call for call in calls if call in reg.STAGE_BUDGETS]) == 1
    assert active(prepared.root) is None
    assert (prepared.report / "run-claim.json").exists()


def test_freeze_refreshes_source_history_ids_and_current_default_pointer(prepared):
    pointer = prepared.root / ".tools/qt-candidates/last-local-sdk.json"
    current = {"directory": str(prepared.root / ".tools/qt-candidates/official-injection"), "buildManifestSha256": "4" * 64}
    dump(pointer, current)
    original_pointer_bytes = pointer.read_bytes()
    prepared.config.update(sourceHead="old-baseline-head", sourceHashes={"old.py": "old"},
        historicalEvidence={"stale": "wrong"}, defaultPointer={"sha256": "old-regex-prior"},
        sourceHashManifest={"path": "old/report/source-hashes.json"},
        runnerSha256="one-off-runner-hash", verifierHashes={"old": "verifier"})
    result = freeze(prepared)
    config = json.loads((prepared.report / "config.json").read_text())
    assert config["registrationId"] == "tooling-validation"
    assert config["sourceHead"] == prepared.source["head"]
    assert config["toolCommit"] == prepared.source["head"]
    assert config["sourceTreeHash"] == prepared.source["treeHash"]
    assert config["sourceHashes"] == {}
    assert config["historicalEvidence"].get("stale") is None
    assert config["defaultPointer"]["candidate"] == "official-injection"
    assert config["defaultPointer"]["sha256"] == hashlib.sha256(original_pointer_bytes).hexdigest()
    assert result["defaultPointer"] == config["defaultPointer"]
    assert config["sourceHashManifest"]["path"].startswith(".tools/reports/tooling-validation/")
    assert "runnerSha256" not in config and "verifierHashes" not in config
    assert (prepared.report / "frozen-default-pointer.json").read_bytes() == original_pointer_bytes
    assert pointer.read_bytes() == original_pointer_bytes


def test_changed_default_pointer_after_freeze_stops_before_any_stage(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    calls = fake_runtime(prepared, monkeypatch)
    dump(prepared.root / ".tools/qt-candidates/last-local-sdk.json", {"directory": "unexpected", "buildManifestSha256": "0" * 64})
    with pytest.raises(reg.RegistrationError, match="FROZEN_DEFAULT_POINTER_BYTES_CHANGED"):
        reg.run_registered(prepared.root, prepared.report)
    assert calls == []
    assert active(prepared.root) is None


@pytest.mark.parametrize("field,code", [
    ("registrationSha256", "SIGNED_BASELINE_REGISTRATION_SHA256_MISMATCH"),
    ("ledgerSha256", "SIGNED_BASELINE_LEDGER_SHA256_MISMATCH"),
    ("sourceHead", "SIGNED_BASELINE_SOURCE_HEAD_MISMATCH"),
])
def test_signed_baseline_single_field_binding_mismatch_rejects(prepared, field, code):
    prepared.config["baselineSource"][field] = "0" * (40 if field == "sourceHead" else 64)
    with pytest.raises(reg.RegistrationError, match=code):
        freeze(prepared)
    assert active(prepared.root) is None
    assert not prepared.report.exists()


@pytest.mark.parametrize("field", ["registrationSha256", "ledgerSha256", "sourceHead"])
def test_signed_baseline_binding_is_required(prepared, field):
    del prepared.config["baselineSource"][field]
    with pytest.raises(reg.RegistrationError, match="SIGNED_BASELINE_BINDING_REQUIRED"):
        freeze(prepared)


def test_signed_baseline_ledger_head_must_match_registration_head(prepared):
    dump(prepared.baseline_dir / "run-ledger.json", {"passed": True, "sourceHead": "f" * 40})
    prepared.refresh_baseline_binding()
    with pytest.raises(reg.RegistrationError, match="SIGNED_BASELINE_SOURCE_HEAD_MISMATCH"):
        freeze(prepared)


def rewrite_manifest_binding(prepared, manifest, *, update_engine):
    path = prepared.output / "identities.json"
    sha = dump(path, manifest)
    metadata = {"path": str(path.relative_to(prepared.root)), "sha256": sha, "bytes": path.stat().st_size}
    prepared.rows[0]["identityManifest"] = metadata
    prepared.write_rows()
    if update_engine:
        ledger = json.loads((prepared.output / "run-ledger.json").read_text())
        ledger["identityManifest"] = metadata
        dump(prepared.output / "run-ledger.json", ledger)


def test_actual_source_label_cannot_promote_an_arbitrary_document(prepared):
    invented = deepcopy(prepared.manifest)
    invented["cases"][0]["identity"] = "tests/test_a.py::invented"
    invented["cases"][0]["name"] = "invented"
    assert invented["source"] == "actual-runtime-outputs"
    rewrite_manifest_binding(prepared, invented, update_engine=False)
    with pytest.raises(reg.RegistrationError, match="LOCAL_ENGINE_IDENTITY_MANIFEST_BINDING"):
        freeze(prepared)


@pytest.mark.parametrize("filename", ["python-unit.xml", "node-identities.jsonl", "frontend-unit.json", "native-unit.xml", "native-lasttest.log"])
def test_each_actual_raw_output_has_an_exact_byte_hash_binding(prepared, filename):
    with (prepared.output / filename).open("ab") as stream:
        stream.write(b"\n")
    with pytest.raises(reg.RegistrationError, match="LOCAL_RAW_OUTPUT_HASH_CHANGED:" + filename):
        freeze(prepared)


def test_actual_raw_output_path_cannot_be_a_different_document(prepared):
    invented = deepcopy(prepared.manifest)
    invented["rawOutputs"][0]["path"] = "docs/evidence/signed-baseline.json"
    rewrite_manifest_binding(prepared, invented, update_engine=True)
    with pytest.raises(reg.RegistrationError, match="LOCAL_RAW_OUTPUT_OUTSIDE_OWN_RUN"):
        freeze(prepared)


def test_local_full_runtime_config_is_bound_by_the_engine_ledger(prepared):
    with (prepared.output / "runtime-config.json").open("ab") as stream:
        stream.write(b"\n")
    with pytest.raises(reg.RegistrationError, match="LOCAL_RUNTIME_CONFIG_BINDING"):
        freeze(prepared)


def test_local_full_runtime_binding_path_cannot_point_elsewhere(prepared):
    path = prepared.output / "run-ledger.json"
    ledger = json.loads(path.read_text())
    ledger["runtimeConfigBinding"]["path"] = "docs/evidence/signed-baseline.json"
    dump(path, ledger)
    with pytest.raises(reg.RegistrationError, match="LOCAL_RUNTIME_CONFIG_BINDING"):
        freeze(prepared)


def test_manifest_is_recomputed_from_raw_even_when_its_two_metadata_hashes_match(prepared):
    invented = deepcopy(prepared.manifest)
    invented["cases"][0]["identity"] = "tests/test_a.py::invented"
    invented["cases"][0]["name"] = "invented"
    rewrite_manifest_binding(prepared, invented, update_engine=True)
    with pytest.raises(reg.RegistrationError, match="LOCAL_IDENTITY_MANIFEST_NOT_FROM_SAVED_OUTPUTS"):
        freeze(prepared)


def test_recomputed_raw_must_match_the_original_per_stage_observation(prepared):
    path = prepared.output / "python-unit.xml"
    path.write_text(path.read_text().replace('name="test_a"', 'name="invented"'))
    runtime = json.loads((prepared.output / "runtime-config.json").read_text())
    recomputed = reg.collect_saved_outputs(prepared.output, runtime, prepared.root)
    rewrite_manifest_binding(prepared, recomputed, update_engine=True)
    with pytest.raises(reg.RegistrationError, match="LOCAL_STAGE_ACTUAL_IDENTITIES_CHANGED:python"):
        freeze(prepared)


def test_local_full_stage_snapshot_cannot_disagree_with_its_ledger_copy(prepared):
    path = prepared.output / "run-ledger.json"
    ledger = json.loads(path.read_text())
    ledger["pythonActualIdentities"]["cases"][0]["name"] = "invented"
    dump(path, ledger)
    with pytest.raises(reg.RegistrationError, match="LOCAL_STAGE_ACTUAL_IDENTITY_BINDING:python"):
        freeze(prepared)


@pytest.mark.parametrize("change", ["missing", "failed", "wrong-head"])
def test_local_actual_manifest_requires_a_complete_passing_engine_run(prepared, change):
    path = prepared.output / "run-ledger.json"
    ledger = json.loads(path.read_text())
    if change == "missing":
        ledger["runs"].pop()
        expected = "LOCAL_COMPLETE_UNIT_ENGINE_STAGES_REQUIRED"
    elif change == "failed":
        ledger["passed"] = False
        expected = "LOCAL_FULL_ENGINE_LEDGER_BINDING"
    else:
        ledger["sourceTreeHash"] = "f" * 40
        expected = "LOCAL_FULL_ENGINE_LEDGER_BINDING"
    dump(path, ledger)
    with pytest.raises(reg.RegistrationError, match=expected):
        freeze(prepared)


def test_gui_prerequisite_binds_actual_reports_and_freezes_all_local_inputs(prepared):
    freeze(prepared)
    prerequisites = json.loads((prepared.report / "local-prerequisites.json").read_text())
    persona = prerequisites["requiredGuiRuns"]["persona"]
    assert persona["sequence"] == 2 and persona["stage"] == "persona-check"
    assert persona["hostProofsSha256"] == hashlib.sha256(reg._bytes(persona["hostProofs"])).hexdigest()
    paths = {reference["path"] for reference in prerequisites["bindings"]}
    for path in (prepared.gui_output / "run-ledger.json", prepared.gui_output / "runtime-config.json",
                 prepared.gui_output / "persona-check.log", prepared.gui_report / "summary.json",
                 prepared.gui_report / "cycle-1.json", prepared.gui_report / "cycle-2.json",
                 prepared.output / "python-unit.xml", prepared.output / "run-ledger.json", prepared.ledger):
        assert str(path.relative_to(prepared.root)) in paths


def test_gui_journal_pass_without_actual_output_cannot_satisfy_prerequisite(prepared):
    del prepared.rows[1]["outputDirectory"]
    prepared.write_rows()
    with pytest.raises(reg.RegistrationError, match="LOCAL_GUI_ACTUAL_OUTPUT_REQUIRED:persona"):
        freeze(prepared)


def rewrite_gui_record(prepared, mutate):
    path = prepared.gui_output / "run-ledger.json"
    ledger = json.loads(path.read_text())
    record = ledger["guiResults"]["persona-check"]
    mutate(record)
    ledger["runs"][0]["evidence"]["guiResults"]["persona-check"] = deepcopy(record)
    dump(path, ledger)


@pytest.mark.parametrize("field,code", [
    ("summarySha256", "LOCAL_GUI_ACTUAL_SUMMARY_BINDING"),
    ("raw", "LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED"),
    ("snapshot", "LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED"),
    ("missing-host-proof", "LOCAL_GUI_HOST_PROOFS_MISSING"),
    ("changed-host-proof", "LOCAL_GUI_MODE_HOST_PROOF_CHANGED"),
])
def test_gui_single_field_proof_or_raw_hash_mismatch_rejects(prepared, field, code):
    def mutate(record):
        if field == "summarySha256":
            record[field] = "0" * 64
        elif field == "raw":
            record["rawReportBinding"][0]["sha256"] = "0" * 64
        elif field == "snapshot":
            record["reportRootsBeforeManifest"]["sha256"] = "0" * 64
        elif field == "missing-host-proof":
            del record["authorControlInputEvidence"]
        else:
            record["personaRowInputEvidence"]["passed"] = False
    rewrite_gui_record(prepared, mutate)
    with pytest.raises(reg.RegistrationError, match=code):
        freeze(prepared)


@pytest.mark.parametrize("field,code", [
    ("source", "LOCAL_GUI_ENGINE_LEDGER_BINDING"),
    ("runtime", "LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED"),
    ("command", "LOCAL_GUI_STAGE_COMMAND_BINDING"),
    ("stage", "LOCAL_GUI_COMPLETE_ENGINE_STAGES_REQUIRED"),
    ("host-copy", "LOCAL_GUI_STAGE_PROOF_BINDING"),
])
def test_gui_engine_command_runtime_and_stage_are_independently_bound(prepared, field, code):
    path = prepared.gui_output / "run-ledger.json"
    ledger = json.loads(path.read_text())
    if field == "source":
        ledger["sourceTreeHash"] = "0" * 40
    elif field == "runtime":
        ledger["runtimeConfigBinding"]["sha256"] = "0" * 64
    elif field == "command":
        ledger["runs"][0]["command"][-1] = "--p1-settings"
    elif field == "stage":
        ledger["runs"][0]["passed"] = False
    else:
        ledger["runs"][0]["evidence"]["guiResults"]["persona-check"]["summarySha256"] = "0" * 64
    dump(path, ledger)
    with pytest.raises(reg.RegistrationError, match=code):
        freeze(prepared)


@pytest.mark.parametrize("filename,code", [
    ("summary.json", "LOCAL_GUI_ACTUAL_SUMMARY_BINDING"),
    ("cycle-1.json", "LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED"),
    ("cycle-2.json", "LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED"),
])
def test_gui_saved_bytes_are_not_replaceable_by_equivalent_json(prepared, filename, code):
    with (prepared.gui_report / filename).open("ab") as stream:
        stream.write(b"\n")
    with pytest.raises(reg.RegistrationError, match=code):
        freeze(prepared)


def test_gui_summary_and_raw_cycle_must_be_exact_objects(prepared):
    path = prepared.gui_report / "summary.json"
    summary = json.loads(path.read_text())
    summary["reports"][0]["syntheticUnitFixture"] = False
    digest = dump(path, summary)
    rewrite_gui_record(prepared, lambda record: record.update(summarySha256=digest))
    with pytest.raises(reg.RegistrationError, match="LOCAL_GUI_RAW_SUMMARY_EXACT_MISMATCH"):
        freeze(prepared)


def test_gui_log_must_advertise_exactly_its_fresh_report_root(prepared):
    (prepared.gui_output / "persona-check.log").write_text(json.dumps({"reportRoot": "unexpected"}) + "\n")
    with pytest.raises(reg.RegistrationError, match="LOCAL_GUI_STAGE_LOG_ROOT_BINDING"):
        freeze(prepared)


def test_gui_frozen_prerequisite_reference_is_checked_again_before_authorization(prepared):
    freeze(prepared)
    with (prepared.gui_report / "cycle-1.json").open("ab") as stream:
        stream.write(b"\n")
    with pytest.raises(reg.RegistrationError, match="LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED"):
        reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    assert active(prepared.root) is not None
    assert not (prepared.report / "authorization.json").exists()


def test_original_cleanup_exit_row_remains_required_to_be_normal():
    normal = [{"cycle": cycle, "exitCode": 0, "signal": None, "remaining": []} for cycle in (1, 2, "cleanup")]
    assert reg._gui_process_exits(normal) is True
    normal[-1]["exitCode"] = 1
    assert reg._gui_process_exits(normal) is False


def test_all_seven_signed_r1_gui_saved_structures_accept_cleanup_exit_read_only():
    # Read saved evidence only; no GUI, application, consumer or build process.
    workspace = Path(__file__).resolve().parents[1]
    ledger = json.loads((workspace / ".tools/reports/p1-worldbook-injection-r1-20261026/run-ledger.json").read_text())
    assert set(ledger["guiResults"]) == {mode + "-check" for mode in reg.GUI_MODES}
    for record in ledger["guiResults"].values():
        summary = json.loads((Path(record["reportRoot"]) / "summary.json").read_text())
        assert [row["cycle"] for row in summary["processExits"]] == [1, 2, "cleanup"]
        assert reg._gui_process_exits(summary["processExits"]) is True
        assert len(summary["reports"]) == len(record["rawReportBinding"]) == 2
        for report, reference in zip(summary["reports"], record["rawReportBinding"]):
            raw = workspace / reference["path"]
            assert hashlib.sha256(raw.read_bytes()).hexdigest() == reference["sha256"]
            assert json.loads(raw.read_text()) == report


def test_registered_entry_uses_real_closed_planner_without_executing_commands(prepared, monkeypatch):
    prepared.config.update(python=".venv/bin/python", localSdk=".tools/qt-sdk",
        guiModes=[{"stage": mode + "-check", "option": options[0],
                   **({"modifier": options[1]} if len(options) > 1 else {})} for mode, options in reg.MODE_OPTIONS])
    for filename in [*prepared.config["pythonTargets"], *prepared.config["nodeTests"], *prepared.config["frontendTests"],
                     "script/registered_run/native_stage.py"]:
        path = prepared.root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("raise RuntimeError('synthetic command must never execute')\n")
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    def forbidden(*args, **kwargs):
        raise AssertionError("No project command may execute in this orchestration test")
    monkeypatch.setattr("subprocess.Popen", forbidden)
    calls = fake_runtime(prepared, monkeypatch, real_plan=True)
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is True
    assert [row["id"] for row in result["runs"]] == prepared.config["sequence"]
    assert (prepared.report / "runtime-config.json").is_file()
    assert "plan" not in calls


@pytest.mark.parametrize("cleanup_state", ["unknown-group", "unconfirmed-row", "scratch"])
def test_unconfirmed_registered_cleanup_keeps_active_marker_and_blocks_new_run(prepared, monkeypatch, cleanup_state):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    fake_runtime(prepared, monkeypatch, cleanup_state=cleanup_state)
    assert reg.run_registered(prepared.root, prepared.report)["passed"] is False
    assert active(prepared.root)["registrationId"] == "tooling-validation"
    with pytest.raises(reg.RegistrationError, match="REGISTRATION_ALREADY_CONSUMED"):
        reg.run_registered(prepared.root, prepared.report)
    assert active(prepared.root)["registrationId"] == "tooling-validation"
    with pytest.raises(Exception, match="ACTIVE_REGISTRATION"):
        freeze(prepared)


def test_final_ledger_publication_error_keeps_registration_marker(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    fake_runtime(prepared, monkeypatch, fail_final_save=True)
    with pytest.raises(OSError, match="final ledger publication failed"):
        reg.run_registered(prepared.root, prepared.report)
    assert active(prepared.root)["registrationId"] == "tooling-validation"


@pytest.mark.parametrize("mutation", ["auth", "pointer", "config", "runtime", "source", "history", "protected"])
def test_real_registered_entry_post_adoption_binding_failure_rolls_back_original_bytes(prepared, monkeypatch, mutation):
    prior = prepared.root / ".tools/qt-candidates/last-local-sdk.json"
    prior.parent.mkdir(parents=True, exist_ok=True)
    prior_bytes = b'{ "directory": "old accepted candidate", "buildManifestSha256": "old" }\n'
    prior.write_bytes(prior_bytes)
    prepared.config.update(runKind="formal", adoptCandidate=True)
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次正式批运行")
    calls = fake_runtime(prepared, monkeypatch, post_mutation=mutation)
    result = reg.run_registered(prepared.root, prepared.report)
    assert "adopt" in calls
    assert result["passed"] is False
    assert result["priorDefaultPointerRestored"] is True
    assert prior.read_bytes() == prior_bytes
    assert active(prepared.root) is None
    assert (prepared.report / "sdk-default-pointer.json").is_file()


def test_abandoned_local_marker_blocks_registered_claim_before_attempt_is_consumed(prepared):
    from script.registered_run.state import LocalRunState
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    with ExecutionLock(prepared.root) as lock:
        marker = LocalRunState(prepared.root, lock)
        marker.begin({"package": "other-tools", "category": "native", "syntheticCrashFixture": True})
        marker.prepare_spawn("native-unit", ["synthetic-not-executed"])
    with pytest.raises(Exception, match="ACTIVE_LOCAL_RUN_REQUIRES_REVIEW"):
        reg.run_registered(prepared.root, prepared.report)
    assert not (prepared.report / "run-claim.json").exists()
    assert active(prepared.root)["registrationId"] == "tooling-validation"


def test_prelaunch_failure_without_durable_completion_keeps_registration_marker(prepared, monkeypatch):
    freeze(prepared)
    original = reg.exclusive_json
    def fail_completion(path, value):
        if path.name == "run-ledger.json":
            raise OSError("synthetic completion storage unavailable")
        return original(path, value)
    monkeypatch.setattr(reg, "exclusive_json", fail_completion)
    with pytest.raises(OSError, match="completion storage unavailable"):
        reg.run_registered(prepared.root, prepared.report)
    assert active(prepared.root)["registrationId"] == "tooling-validation"
    assert (prepared.report / "run-claim.json").exists()


def test_freeze_binds_original_fourth_protected_metadata_manifest(prepared):
    freeze(prepared)
    config = json.loads((prepared.report / "config.json").read_text())
    path = prepared.report / "protected-tracked-data.json"
    reference = config["protectedTrackedDataManifest"]
    assert config["protectedTrackedData"] == json.loads(path.read_text()) == {}
    assert reference == {"path": str(path.relative_to(prepared.root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}
    registration = json.loads((prepared.report / "registration.json").read_text())
    assert registration["artifacts"][path.name] == reference["sha256"]


def test_freeze_rejects_protected_metadata_difference_from_signed_baseline(prepared):
    prepared.protected_state["synthetic-index-change"] = {"stage": "0"}
    with pytest.raises(reg.RegistrationError, match="PROTECTED_DATA_METADATA_CHANGED"):
        freeze(prepared)
    assert active(prepared.root) is None
    assert not prepared.report.exists()


def test_registered_boundaries_recompute_protected_metadata_and_stop_on_change(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    calls = fake_runtime(prepared, monkeypatch, mutate_protected=True)
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is False and "PROTECTED_DATA_METADATA_CHANGED" in result["stopReason"]
    assert len([call for call in calls if call in reg.STAGE_BUDGETS]) == 1
    assert active(prepared.root) is None


def test_registered_success_records_protected_metadata_and_all_four_manifests(prepared, monkeypatch):
    freeze(prepared)
    reg.authorize_registration(prepared.root, prepared.report, "批准一次工具验证批运行")
    fake_runtime(prepared, monkeypatch)
    result = reg.run_registered(prepared.root, prepared.report)
    assert result["passed"] is True
    assert result["protectedDataMetadataUnchanged"] is True
    assert result["protectedTrackedDataFiles"] == 0
    assert all(check["protectedDataMetadataUnchanged"] is True and check["verifiedManifests"] == [
        "sourceHashManifest", "protectedTrackedDataManifest", "historicalEvidenceManifest", "unitExpectationManifest"]
        for check in result["bindingChecks"])
