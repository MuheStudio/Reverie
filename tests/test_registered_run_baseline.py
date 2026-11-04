"""Original-shaped synthetic saved files in temporary fake repositories only.

These fixtures exercise real read-only parsers. They are unit-test data, never
acceptance evidence; no test process, Qt producer, Node consumer or build runs.
"""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path

import pytest

from script.registered_run.baseline import BaselineError, load_signed_baseline
from script.registered_run.identities import NODE_EVENT_SCHEMA, collect_saved_outputs


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reference(root, path):
    return {"path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size}


def public_result(root, report, config):
    paths = sorted(path for path in report.rglob("*") if path.is_file())
    paths.append(root / config["candidateDirectory"] / "build.json")
    return dump(root / "docs/evidence" / (config["registrationId"] + ".json"), {
        "schema": "reverie.unit-test.synthetic-formal-public.v1", "formalAcceptance": True,
        "overallPassed": True, "registrationId": config["registrationId"], "sourceHead": config["sourceHead"],
        "syntheticUnitFixtureOnly": True, "artifacts": [reference(root, path) for path in paths]})


@pytest.fixture
def saved(tmp_path):
    root = tmp_path.resolve()
    report = root / ".tools/reports/signed-fixture"
    report.mkdir(parents=True)
    config = {"configSchema": "reverie.registered-run.config.v1", "registrationId": "signed-fixture",
        "sourceHead": "a" * 40, "sourceTreeHash": "b" * 40, "runKind": "formal", "adoptCandidate": True,
        "kind": "Formal synthetic original-format unit fixture",
        "sequence": ["sdk-build", "python-unit", "node-unit", "frontend-unit", "native-unit"],
        "budgets": {"sdkBuild": 1, "pythonBatch": 1, "nodeBatch": 1, "frontendBatch": 1, "nativeBatch": 1},
        "timeoutsSeconds": {stage: 300 for stage in ("sdk-build", "python-unit", "node-unit", "frontend-unit", "native-unit")},
        "pythonTargets": ["tests/test_a.py"], "expectedPythonIdentities": ["tests/test_a.py::test_a"],
        "nodeTests": ["native-ui/a.test.cjs", "native-ui/b.test.cjs"],
        "expectedNodeNames": {"native-ui/a.test.cjs": ["same"], "native-ui/b.test.cjs": ["same"]},
        "frontendTests": ["frontend/a.test.ts"], "expectedFrontendNames": {"frontend/a.test.ts": ["suite a"]},
        "nativeTargets": ["target"],
        "expectedNativeIdentities": {"target": ["Case::initTestCase()", "Case::case()", "Case::cleanupTestCase()"]},
        "nodeIdentityReport": "node-identities.jsonl", "candidateName": "signed-fixture",
        "candidateDirectory": ".tools/qt-candidates/signed-fixture", "cmakeDirectory": ".tools/qt-builds/signed-fixture",
        "baselineSource": {"report": ".tools/reports/OLDER", "sourceHead": "c" * 40,
                           "expectedPythonIdentities": ["older-not-current"]}}
    py = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="tests.test_a" name="test_a"/></testsuite>'
    (report / "python-unit.xml").write_text(py)
    events = [{"schema": NODE_EVENT_SCHEMA, "type": "stream:start", "nodeVersion": "v24.19.0"}]
    for sequence, file in enumerate(config["nodeTests"], 1):
        events.append({"schema": NODE_EVENT_SCHEMA, "sequence": sequence, "type": "test:pass", "data": {
            "file": str(root / file), "name": "same", "nesting": 0, "testNumber": sequence,
            "skip": None, "todo": None, "reportedType": "test", "failureType": None}})
    events.extend([{"schema": NODE_EVENT_SCHEMA, "sequence": 3, "type": "test:summary", "data": {
        "file": None, "counts": {"tests": 2, "suites": 0, "passed": 2, "failed": 0,
        "cancelled": 0, "skipped": 0, "todo": 0}, "success": True}},
        {"schema": NODE_EVENT_SCHEMA, "type": "stream:end", "events": 3, "cases": 2, "summaries": 1}])
    (report / "node-identities.jsonl").write_text("".join(json.dumps(row) + "\n" for row in events))
    (report / "node-unit.log").write_text("\n".join(["TAP version 13", "# Subtest: same", "ok 1 - same",
        "# Subtest: same", "ok 2 - same", "1..2", "# tests 2", "# suites 0", "# pass 2", "# fail 0",
        "# cancelled 0", "# skipped 0", "# todo 0"]) + "\n")
    dump(report / "frontend-unit.json", {"success": True, "numTotalTests": 1, "numPassedTests": 1,
        "numFailedTests": 0, "numPendingTests": 0, "numTodoTests": 0, "testResults": [{"name": str(root / "frontend/a.test.ts"),
        "status": "passed", "assertionResults": [{"ancestorTitles": ["suite"], "title": "a", "fullName": "suite a",
        "status": "passed", "failureMessages": []}]}]})
    (report / "native-unit.xml").write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="target" status="run"/></testsuite>')
    (report / "native-lasttest.log").write_text("\n".join(["1/1 Testing: target", "********* Start testing of Case *********",
        "PASS   : Case::initTestCase()", "PASS   : Case::case()", "PASS   : Case::cleanupTestCase()",
        "Totals: 3 passed, 0 failed, 0 skipped, 0 blacklisted, 1ms", "********* Finished testing of Case *********", "<end of output>"]))
    actual = collect_saved_outputs(report, config, root)
    config_sha = dump(report / "config.json", config)
    expected_sha = dump(report / "expected-identities.json", actual)
    runtime_sha = dump(report / "runtime-config.json", config)
    actual_sha = dump(report / "actual-identities.json", actual)
    build = root / config["candidateDirectory"] / "build.json"
    build_sha = dump(build, {"candidate": config["candidateName"], "source": {
        "head": config["sourceHead"], "postBuildInventoryVerified": True},
        "compilation": {"cmakeDirectory": str(root / config["cmakeDirectory"])}})
    pointer_sha = dump(report / "sdk-default-pointer.json", {"directory": str(build.parent), "buildManifestSha256": build_sha})
    registration = {"schema": "reverie.registered-run.registration.v1", "registrationId": config["registrationId"],
        "sourceHead": config["sourceHead"], "sourceTreeHash": config["sourceTreeHash"], "runKind": "formal",
        "adoptCandidate": True, "sequence": config["sequence"], "configSha256": config_sha,
        "artifacts": {"config.json": config_sha, "expected-identities.json": expected_sha}}
    registration.update({key: deepcopy(config[key]) for key in
                         ("budgets", "timeoutsSeconds", "candidateName", "candidateDirectory", "cmakeDirectory")})
    dump(report / "registration.json", registration)
    ledger = {"schema": "reverie.shared-run.ledger.v1", "kind": "formal", "passed": True,
        "registrationId": config["registrationId"], "sourceHead": config["sourceHead"], "sourceTreeHash": config["sourceTreeHash"],
        "configSha256": config_sha, "runtimeConfigSha256": runtime_sha,
        "runtimeConfigBinding": reference(root, report / "runtime-config.json"),
        "identityManifest": {"path": str((report / "actual-identities.json").relative_to(root)), "sha256": actual_sha},
        "unitScratchRemoved": True, "ownedProcessesRemaining": 0, "processCleanupConfirmed": True,
        "defaultPointerCandidateVerified": True, "adoptedPointerSha256": pointer_sha,
        "runs": [{"id": stage, "passed": True, "exitCode": 0, "state": "completed", "processGroupGone": True}
                 for stage in config["sequence"]]}
    for row in ledger["runs"]:
        row.update(command=[str(root / "unit-fixture-never-executed"), row["id"]],
                   timeoutSeconds=config["timeoutsSeconds"][row["id"]], cwd=str(root))
    dump(report / "run-ledger.json", ledger)
    public_result(root, report, config)
    return root, report, config, registration, ledger


def test_new_signed_baseline_reads_bound_current_config_and_recomputes_real_parser_output(saved):
    root, report, config, _, _ = saved
    effective, metadata = load_signed_baseline(root, report)
    assert effective == config
    assert effective["expectedPythonIdentities"] != effective["baselineSource"]["expectedPythonIdentities"]
    assert metadata["_verification"]["source"] == "actual-runtime-outputs"
    assert metadata["_verification"]["actualOutputsReparsed"] is True
    assert metadata["_verification"]["historicAttributionAmbiguities"] == []
    assert effective["expectedNodeNames"]["native-ui/a.test.cjs"] == effective["expectedNodeNames"]["native-ui/b.test.cjs"]


def test_new_metadata_baseline_export_is_self_compatible_and_uses_current_effective_expectations(saved):
    from script.registered_run.export_config import equivalence, export_baseline
    root, report, config, registration, ledger = saved
    exported = export_baseline(report, root)
    assert exported["configSchema"] == config["configSchema"]
    assert exported.get("schema") == config.get("schema")
    assert exported["expectedPythonIdentities"] == config["expectedPythonIdentities"]
    assert exported["expectedNodeNames"] == config["expectedNodeNames"]
    assert "artifacts" not in exported
    assert exported["baselineSource"]["report"] == str(report.relative_to(root))
    assert exported["baselineSource"]["metadataSchema"] == registration["schema"]
    assert exported["baselineSource"]["verification"]["source"] == "actual-runtime-outputs"
    assert [stage["baselineCommand"] for stage in exported["stages"]] == [row["command"] for row in ledger["runs"]]
    assert equivalence(exported, registration, ledger) == []


def test_legacy_formal_baseline_replays_original_tap_with_explicit_file_attribution_ambiguity(saved):
    root, report, config, _, ledger = saved
    legacy = deepcopy(config)
    legacy["schema"] = "reverie.p1.worldbook-injection.r1.formal.registration.v1"
    legacy.pop("configSchema")
    legacy.pop("nodeIdentityReport")
    registration_sha = dump(report / "registration.json", legacy)
    ledger.update(schema="reverie.p1.worldbook-injection.r1.formal.ledger.v1", registrationSha256=registration_sha,
                  scratchRemoved=True, defaultPointerAdoptedAfterFullPass=True, defaultPointerAdoptedAtEnd=True)
    dump(report / "run-ledger.json", ledger)
    public_result(root, report, legacy)
    effective, metadata = load_signed_baseline(root, report)
    assert effective == legacy
    verification = metadata["_verification"]
    assert verification["source"] == "historical-replay"
    assert verification["historicAttributionAmbiguities"] == [{"name": "same", "files": config["nodeTests"], "count": 2}]


@pytest.mark.parametrize("filename", ["config.json", "expected-identities.json", "runtime-config.json", "sdk-default-pointer.json"])
def test_signed_baseline_rejects_changed_bound_bytes(saved, filename):
    root, report, _, _, _ = saved
    path = report / filename
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(BaselineError, match="HASH_CHANGED|BINDING_CHANGED"):
        load_signed_baseline(root, report)


def test_expected_actual_proof_cannot_be_omitted_from_new_metadata(saved):
    root, report, _, registration, _ = saved
    registration["artifacts"].pop("expected-identities.json")
    dump(report / "registration.json", registration)
    with pytest.raises(BaselineError, match="ARTIFACT_BINDING_REQUIRED"):
        load_signed_baseline(root, report)


def test_duplicate_identity_multiplicity_is_not_collapsed(saved):
    root, report, config, registration, ledger = saved
    config["expectedNodeNames"]["native-ui/b.test.cjs"] = []
    digest = dump(report / "config.json", config)
    registration["artifacts"]["config.json"] = registration["configSha256"] = ledger["configSha256"] = digest
    dump(report / "registration.json", registration)
    dump(report / "run-ledger.json", ledger)
    with pytest.raises(BaselineError, match="SIGNED_EXPECTATIONS_CHANGED"):
        load_signed_baseline(root, report)


def test_actual_manifest_claim_cannot_replace_reparsed_raw_output(saved):
    root, report, _, _, ledger = saved
    path = report / "actual-identities.json"
    actual = json.loads(path.read_text())
    actual["cases"][0]["name"] = "forged-but-still-claimed-passed"
    ledger["identityManifest"]["sha256"] = dump(path, actual)
    dump(report / "run-ledger.json", ledger)
    with pytest.raises(BaselineError, match="MANIFEST_NOT_FROM_RAW_OUTPUT"):
        load_signed_baseline(root, report)


def test_formal_raw_output_hash_is_required_even_if_case_names_are_unchanged(saved):
    root, report, _, _, _ = saved
    path = report / "node-identities.jsonl"
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(BaselineError, match="REFERENCE_HASH_CHANGED"):
        load_signed_baseline(root, report)


@pytest.mark.parametrize(("field", "replacement", "code"), [
    ("kind", "tool-validation", "FORMAL_KIND_REQUIRED"),
    ("defaultPointerCandidateVerified", False, "FORMAL_ADOPTION_REQUIRED"),
    ("registrationId", "another-run", "SOURCE_OR_IDENTITY_CHANGED"),
    ("sourceHead", "f" * 40, "SOURCE_OR_IDENTITY_CHANGED"),
])
def test_incomplete_or_nonadopted_runs_cannot_be_signed_baselines(saved, field, replacement, code):
    root, report, _, _, ledger = saved
    ledger[field] = replacement
    dump(report / "run-ledger.json", ledger)
    with pytest.raises(BaselineError, match=code):
        load_signed_baseline(root, report)


def test_config_and_a_passed_ledger_alone_are_not_a_signed_baseline(saved):
    root, report, config, _, _ = saved
    dump(report / "registration.json", config)
    dump(report / "run-ledger.json", {"passed": True})
    with pytest.raises(BaselineError, match="REGISTRATION_SCHEMA_UNSUPPORTED"):
        load_signed_baseline(root, report)


def test_missing_stage_is_rejected_before_accepting_passed_ledger_flag(saved):
    root, report, _, _, ledger = saved
    ledger["runs"].pop()
    dump(report / "run-ledger.json", ledger)
    with pytest.raises(BaselineError, match="ACTUAL_SEQUENCE_CHANGED"):
        load_signed_baseline(root, report)


@pytest.mark.parametrize("alias", ["symlink", "hardlink"])
def test_signed_baseline_rejects_symlinked_or_hardlinked_raw_evidence(saved, alias):
    root, report, _, _, _ = saved
    path = report / "native-lasttest.log"
    replacement = root / "unchanged-raw-log.txt"
    replacement.write_bytes(path.read_bytes())
    path.unlink()
    if alias == "symlink":
        path.symlink_to(replacement)
    else:
        os.link(replacement, path)
    with pytest.raises((ValueError, RuntimeError), match="ALIAS|SYMLINK"):
        load_signed_baseline(root, report)


def test_default_data_report_path_is_rejected_before_any_content_read(saved):
    root, _, _, _, _ = saved
    forbidden = root / "data"
    forbidden.mkdir()
    with pytest.raises((ValueError, RuntimeError), match="DEFAULT_DATA"):
        load_signed_baseline(root, forbidden)


def test_passed_and_adopted_run_without_public_formal_record_is_not_signed_baseline(saved):
    root, report, config, _, _ = saved
    (root / "docs/evidence" / (config["registrationId"] + ".json")).unlink()
    with pytest.raises(OSError):
        load_signed_baseline(root, report)


def test_public_artifact_table_must_cover_all_saved_report_files(saved):
    root, report, config, _, _ = saved
    path = root / "docs/evidence" / (config["registrationId"] + ".json")
    public = json.loads(path.read_text())
    public["artifacts"] = [row for row in public["artifacts"] if not row["path"].endswith("/node-unit.log")]
    dump(path, public)
    with pytest.raises(BaselineError, match="PUBLIC_ARTIFACT_TABLE_INCOMPLETE"):
        load_signed_baseline(root, report)


def test_public_formal_identity_and_artifact_hashes_are_checked(saved):
    root, report, config, _, _ = saved
    path = root / "docs/evidence" / (config["registrationId"] + ".json")
    public = json.loads(path.read_text())
    public["sourceHead"] = "f" * 40
    dump(path, public)
    with pytest.raises(BaselineError, match="PUBLIC_FORMAL_RESULT_REQUIRED"):
        load_signed_baseline(root, report)
