"""Load an adopted formal baseline by rechecking its saved evidence.

Only JSON/XML/plain runtime output is read. No historical runner, acceptance
consumer, GUI application or build tool is imported or executed. A new-format
baseline must bind current expectations and actual runtime output independently
of its older baselineSource provenance.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import os
from pathlib import Path, PurePosixPath
import re

from .identities import (collect_saved_outputs, compare_manifests,
                         require_actual_collection, require_all_passed, signed_baseline)
from .isolation import assert_not_data_path, canonical_directory
from .state import load_json_bytes, regular_file
from .preview import MODE as PREVIEW_MODE, enabled as preview_enabled, verify_saved as verify_preview_saved


REGISTRATION_SCHEMA = "reverie.registered-run.registration.v1"
CONFIG_SCHEMA = "reverie.registered-run.config.v1"
LEGACY_SCHEMA = "reverie.p1.worldbook-injection.r1.formal.registration.v1"
RAW_NAMES = ("python-unit.xml", "node-identities.jsonl", "frontend-unit.json", "native-unit.xml", "native-lasttest.log")
EXPECTATION_KEYS = ("pythonTargets", "expectedPythonIdentities", "nodeTests", "expectedNodeNames",
                    "frontendTests", "expectedFrontendNames", "nativeTargets", "expectedNativeIdentities")
GUI_PROOF_KEYS = {
    "injection": ("worldbookInjectionEvidence",),
    "regex": ("worldbookRegexEvidence", "regexWorkerOwnership"),
    "entry": ("worldbookEntrySettingsEvidence",),
    "persona": ("worldbookPriorityEvidence", "personaRowInputEvidence", "authorControlInputEvidence"),
    "candidate": ("memoryCandidateBatchEvidence", "checkCountsByCycle", "requests", "messageIdsAcrossRestartEqual"),
    "ordinary": ("memoryBatchDeleteEvidence", "summaryAcquisitionEvidence", "summaryViewEvidence", "replyStartEvidence", "memoryBatchPinEvidence"),
    "settings": ("settingsOrdinaryEvidence", "settingsEvidence"),
}


class BaselineError(ValueError):
    pass


def _need(condition, code):
    if not condition:
        raise BaselineError(code)


def _digest(payload):
    return hashlib.sha256(payload).hexdigest()


def _sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _path(root, value):
    _need(isinstance(value, (str, Path)), "BASELINE_PATH_REQUIRED")
    raw = str(value)
    _need(raw and not any(character in raw for character in "\0\r\n\\"), "BASELINE_PATH_INVALID")
    parts = PurePosixPath(raw).parts
    _need(".." not in parts, "BASELINE_PATH_ESCAPES_ROOT")
    path = Path(raw)
    path = path if path.is_absolute() else root / path
    _need(path.is_relative_to(root) and path == Path(os.path.abspath(path)), "BASELINE_PATH_ESCAPES_ROOT")
    assert_not_data_path(path, root)
    # regular_file and canonical_directory reject symlinks and aliases, including
    # every existing ancestor, before any content is opened.
    return path


def _read(root, path):
    path = _path(root, path)
    before = regular_file(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        _need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), "BASELINE_FILE_IDENTITY_CHANGED")
        payload = stream.read()
    after = regular_file(path)
    _need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
          (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns), "BASELINE_FILE_CHANGED_DURING_READ")
    return payload


def _json(root, path):
    payload = _read(root, path)
    value = load_json_bytes(payload)
    _need(isinstance(value, dict), "BASELINE_JSON_OBJECT_REQUIRED")
    return value, payload


def _reference(root, report, reference, filename):
    _need(isinstance(reference, dict) and isinstance(reference.get("path"), str) and
          _sha(reference.get("sha256")), "BASELINE_FILE_BINDING_REQUIRED:" + filename)
    value = reference["path"]
    path = _path(root, value) if Path(value).is_absolute() or value.startswith(".tools/") else _path(root, report / value)
    _need(path == report / filename, "BASELINE_REFERENCE_OUTSIDE_OWN_REPORT:" + filename)
    payload = _read(root, path)
    _need(_digest(payload) == reference["sha256"], "BASELINE_REFERENCE_HASH_CHANGED:" + filename)
    if "bytes" in reference:
        _need(type(reference["bytes"]) is int and reference["bytes"] == len(payload),
              "BASELINE_REFERENCE_BYTES_CHANGED:" + filename)
    return payload


def _artifact(root, report, registration, filename):
    artifacts = registration.get("artifacts")
    _need(isinstance(artifacts, dict) and filename in artifacts, "BASELINE_ARTIFACT_BINDING_REQUIRED:" + filename)
    reference = artifacts[filename]
    if isinstance(reference, str):
        _need(_sha(reference), "BASELINE_ARTIFACT_HASH_INVALID:" + filename)
        payload = _read(root, report / filename)
        _need(_digest(payload) == reference, "BASELINE_ARTIFACT_HASH_CHANGED:" + filename)
    else:
        payload = _reference(root, report, reference, filename)
    value = load_json_bytes(payload)
    _need(isinstance(value, dict), "BASELINE_ARTIFACT_OBJECT_REQUIRED:" + filename)
    return value, payload


def _stream_reference(root, reference):
    _need(isinstance(reference, dict) and isinstance(reference.get("path"), str) and
          _sha(reference.get("sha256")) and type(reference.get("bytes")) is int and reference["bytes"] >= 0,
          "BASELINE_PUBLIC_ARTIFACT_BINDING_INVALID")
    path = _path(root, reference["path"])
    before = regular_file(path)
    _need(before.st_size == reference["bytes"], "BASELINE_PUBLIC_ARTIFACT_BYTES_CHANGED:" + path.name)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        _need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), "BASELINE_FILE_IDENTITY_CHANGED")
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    after = regular_file(path)
    _need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
          (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns), "BASELINE_FILE_CHANGED_DURING_READ")
    _need(digest.hexdigest() == reference["sha256"], "BASELINE_PUBLIC_ARTIFACT_HASH_CHANGED:" + path.name)
    return path


def _public_result(root, report, config, ledger):
    public_path = root / "docs/evidence" / (config["registrationId"] + ".json")
    public, payload = _json(root, public_path)
    _need(public.get("formalAcceptance") is True and public.get("registrationId") == config["registrationId"] and
          public.get("sourceHead") == config["sourceHead"], "BASELINE_PUBLIC_FORMAL_RESULT_REQUIRED")
    for key in ("passed", "overallPassed"):
        if key in public:
            _need(public[key] is True, "BASELINE_PUBLIC_RESULT_NOT_PASSED")
    references = public.get("artifacts")
    _need(isinstance(references, list) and references, "BASELINE_PUBLIC_ARTIFACT_TABLE_REQUIRED")
    paths = [_stream_reference(root, reference) for reference in references]
    _need(len(paths) == len(set(paths)), "BASELINE_PUBLIC_ARTIFACT_REPEATED")
    required = set()
    directories = [report]
    gui_results = ledger.get("guiResults", {})
    _need(isinstance(gui_results, dict), "BASELINE_GUI_RESULTS_INVALID")
    for record in gui_results.values():
        _need(isinstance(record, dict) and isinstance(record.get("reportRoot"), str), "BASELINE_GUI_REPORT_BINDING_REQUIRED")
        directory = _path(root, record["reportRoot"])
        canonical_directory(directory)
        directories.append(directory)
    for directory in directories:
        for path in directory.rglob("*"):
            _need(not path.is_symlink(), "BASELINE_PUBLIC_SOURCE_SYMLINK_FORBIDDEN")
            if path.is_dir():
                canonical_directory(path)
            else:
                regular_file(path)
                required.add(path)
    required.add(_path(root, config["candidateDirectory"]) / "build.json")
    _need(required <= set(paths), "BASELINE_PUBLIC_ARTIFACT_TABLE_INCOMPLETE")
    return {"path": str(public_path.relative_to(root)), "sha256": _digest(payload),
            "bytes": len(payload), "artifacts": len(paths)}


def _same_identities(first, second, code):
    require_all_passed(first)
    require_all_passed(second)
    difference = compare_manifests(first, second)
    _need(difference["identitiesMatch"] and not difference["statusChanges"], code)


def _stages(config, registration, ledger, *, legacy):
    sequence = config.get("sequence")
    _need(isinstance(sequence, list) and sequence and len(sequence) == len(set(sequence)) and
          {"sdk-build", "python-unit", "node-unit", "frontend-unit", "native-unit"} <= set(sequence),
          "BASELINE_COMPLETE_FORMAL_SEQUENCE_REQUIRED")
    _need(registration.get("sequence") == sequence, "BASELINE_REGISTERED_SEQUENCE_CHANGED")
    runs = ledger.get("runs")
    _need(isinstance(runs, list) and all(isinstance(row, dict) for row in runs) and
          [row.get("id") for row in runs] == sequence,
          "BASELINE_ACTUAL_SEQUENCE_CHANGED")
    for row in runs:
        _need(isinstance(row, dict) and type(row.get("exitCode")) is int and row["exitCode"] == 0 and
              row.get("state") == "completed" and row.get("processGroupGone") is True and
              not row.get("cleanupErrors") and (row.get("passed", True) is True if legacy else row.get("passed") is True),
              "BASELINE_STAGE_NOT_PASSED:" + str(row.get("id")))
    if legacy:
        _need(ledger.get("scratchRemoved") is True, "BASELINE_CLEANUP_NOT_COMPLETE")
    else:
        _need(ledger.get("unitScratchRemoved") is True and type(ledger.get("ownedProcessesRemaining")) is int and
              ledger["ownedProcessesRemaining"] == 0 and ledger.get("processCleanupConfirmed") is True,
              "BASELINE_CLEANUP_NOT_COMPLETE")


def _gui_results(root, report, config, ledger):
    expected = {stage for stage in config["sequence"] if stage.endswith("-check")}
    results = ledger.get("guiResults", {})
    _need(isinstance(results, dict) and set(results) == expected, "BASELINE_COMPLETE_GUI_RESULTS_REQUIRED")
    for stage in expected:
        record = results[stage]
        mode = stage.removesuffix("-check")
        if mode == PREVIEW_MODE:
            _need(preview_enabled(config) and isinstance(record, dict), "BASELINE_PREVIEW_CONTRACT_REQUIRED")
            matching = [row for row in ledger["runs"] if row.get("id") == stage]
            _need(len(matching) == 1 and matching[0].get("previewIsolationRoot") ==
                  ledger.get("unitIsolation", {}).get("scratch"), "BASELINE_PREVIEW_ISOLATION_BINDING")
            from .modes.context import RunContext
            summary_path = report / stage / "summary.json"
            observed = verify_preview_saved(RunContext(root, report, config), summary_path, matching[0], record)
            _need(all(record.get(key) == value for key, value in observed.items()) and
                  record.get("reportRoot") == str(summary_path.parent) and
                  record.get("summarySha256") == _digest(_read(root, summary_path)), "BASELINE_PREVIEW_PROOF_CHANGED")
            continue
        _need(mode in GUI_PROOF_KEYS and isinstance(record, dict) and
              all(bool(record.get(key)) for key in GUI_PROOF_KEYS[mode]), "BASELINE_GUI_MODE_PROOFS_MISSING:" + stage)
        directory = _path(root, record.get("reportRoot"))
        canonical_directory(directory)
        _need(directory.parent == root / ".tools/reports" and directory.name.startswith("qt-"),
              "BASELINE_GUI_REPORT_ROOT_INVALID")
        summary, payload = _json(root, directory / "summary.json")
        _need(record.get("summarySha256") == _digest(payload) and summary.get("sourceHead") == config["sourceHead"] and
              summary.get("passed") is True and summary.get("automaticRetry") is False and
              summary.get("applicationDeadlineMs") == 240000 and all(summary.get(key) is True for key in
              ("noResidualProcesses", "testDataRemoved", "applicationUnchanged", "modelInputUnchanged")),
              "BASELINE_GUI_SUMMARY_BINDING_CHANGED")
        snapshot_name = stage + "-report-roots-before.json"
        snapshot_reference = record.get("reportRootsBeforeManifest")
        snapshot_payload = _reference(root, report, snapshot_reference, snapshot_name)
        snapshot = load_json_bytes(snapshot_payload)
        roots = snapshot.get("roots") if isinstance(snapshot, dict) else None
        _need(isinstance(snapshot, dict) and snapshot.get("schema") == "reverie.gui-report-roots-before.v1" and
              snapshot.get("stage") == snapshot_reference.get("stage") == stage and isinstance(roots, list) and
              all(isinstance(value, str) and re.fullmatch(r"\.tools/reports/qt-[A-Za-z0-9_.-]+", value) for value in roots) and
              roots == sorted(set(roots)) and snapshot.get("count") == snapshot_reference.get("count") ==
              record.get("reportRootsBefore") == len(roots) and str(directory.relative_to(root)) not in roots,
              "BASELINE_GUI_SNAPSHOT_INVALID")
        cycles = summary.get("reports")
        _need(isinstance(cycles, list) and len(cycles) == 2, "BASELINE_GUI_TWO_CYCLES_REQUIRED")
        raw = []
        for cycle, expected_cycle in enumerate(cycles, 1):
            path = directory / ("cycle-" + str(cycle) + ".json")
            actual_cycle, cycle_payload = _json(root, path)
            _need(actual_cycle == expected_cycle and actual_cycle.get("passed") is True and
                  actual_cycle.get("error") in (None, ""), "BASELINE_GUI_RAW_CYCLE_CHANGED")
            raw.append({"path": str(path.relative_to(root)), "sha256": _digest(cycle_payload), "bytes": len(cycle_payload)})
        _need(record.get("rawReportBinding") == raw, "BASELINE_GUI_RAW_BINDING_CHANGED")
        exits = summary.get("processExits")
        _need(isinstance(exits, list) and all(isinstance(row, dict) for row in exits) and
              [row.get("cycle") for row in exits if row.get("cycle") in (1, 2)] == [1, 2] and
              all(type(row.get("exitCode")) is int and row["exitCode"] == 0 and row.get("signal") is None and
                  row.get("remaining") == [] for row in exits), "BASELINE_GUI_PROCESS_EXIT_INVALID")
        forced = record.get("forcedCleanupEvidence")
        _need(isinstance(record.get("archiveControlReadinessEvidence"), dict) and
              record["archiveControlReadinessEvidence"].get("passed") is True and
              forced == {"forcedCleanup": False, "forcedCleanupTargets": 0,
                  "forcedCleanupSignalsSent": 0, "forcedCleanupIdentityChanged": 0, "forcedCleanupErrors": []},
              "BASELINE_GUI_COMMON_PROOFS_MISSING")
        _need(all(type(forced[key]) is int for key in
                  ("forcedCleanupTargets", "forcedCleanupSignalsSent", "forcedCleanupIdentityChanged")),
              "BASELINE_GUI_FORCED_CLEANUP_TYPES_CHANGED")


def _adopted_pointer(root, report, config, ledger, *, legacy):
    if legacy:
        _need(ledger.get("defaultPointerAdoptedAfterFullPass") is True and
              ledger.get("defaultPointerAdoptedAtEnd") is True, "BASELINE_FORMAL_ADOPTION_REQUIRED")
    else:
        _need(ledger.get("defaultPointerCandidateVerified") is True and
              config.get("adoptCandidate") is True and ledger.get("adoptionRolledBack") is not True,
              "BASELINE_FORMAL_ADOPTION_REQUIRED")
    pointer, payload = _json(root, report / "sdk-default-pointer.json")
    _need(_sha(ledger.get("adoptedPointerSha256")) and _digest(payload) == ledger["adoptedPointerSha256"],
          "BASELINE_ADOPTED_POINTER_HASH_CHANGED")
    candidate = _path(root, config["candidateDirectory"])
    canonical_directory(candidate)
    _need(isinstance(config.get("candidateName"), str) and candidate.name == config["candidateName"],
          "BASELINE_CANDIDATE_NAME_CHANGED")
    _need(pointer.get("directory") == str(candidate), "BASELINE_ADOPTED_CANDIDATE_CHANGED")
    record, record_payload = _json(root, candidate / "build.json")
    _need(_sha(pointer.get("buildManifestSha256")) and _digest(record_payload) == pointer["buildManifestSha256"],
          "BASELINE_ADOPTED_BUILD_HASH_CHANGED")
    cmake = _path(root, config["cmakeDirectory"])
    _need(record.get("candidate") == config["candidateName"] and record.get("source", {}).get("head") == config["sourceHead"] and
          record.get("source", {}).get("postBuildInventoryVerified") is True and
          record.get("compilation", {}).get("cmakeDirectory") == str(cmake), "BASELINE_ADOPTED_BUILD_BINDING_CHANGED")
    return {"pointerSha256": _digest(payload), "candidateDirectory": str(candidate.relative_to(root)),
            "buildManifestSha256": _digest(record_payload)}


def load_signed_baseline(root, report_dir):
    """Return (effective config, original registration metadata plus checks).

    New registrations store their effective config separately. Their older
    baselineSource is historical provenance and is never substituted for the
    current expected identity proof or actual output from this formal run.
    """
    root = Path(root).resolve(strict=True)
    canonical_directory(root)
    report = _path(root, report_dir)
    canonical_directory(report)
    registration, registration_payload = _json(root, report / "registration.json")
    ledger, ledger_payload = _json(root, report / "run-ledger.json")
    legacy = registration.get("schema") == LEGACY_SCHEMA
    _need(legacy or registration.get("schema") == REGISTRATION_SCHEMA, "BASELINE_REGISTRATION_SCHEMA_UNSUPPORTED")
    _need(ledger.get("passed") is True, "BASELINE_NOT_PASSED")
    if legacy:
        config = deepcopy(registration)
        _need(isinstance(config.get("kind"), str) and config["kind"].startswith("Formal ") and
              ledger.get("schema") == "reverie.p1.worldbook-injection.r1.formal.ledger.v1",
              "BASELINE_FORMAL_KIND_REQUIRED")
        _need(ledger.get("registrationSha256") == _digest(registration_payload), "BASELINE_REGISTRATION_HASH_CHANGED")
    else:
        config, config_payload = _artifact(root, report, registration, "config.json")
        expected, _ = _artifact(root, report, registration, "expected-identities.json")
        _need(config.get("configSchema") == CONFIG_SCHEMA and
              registration.get("configSha256") == _digest(config_payload) == ledger.get("configSha256"),
              "BASELINE_CONFIG_BINDING_CHANGED")
        _need(ledger.get("schema") == "reverie.shared-run.ledger.v1" and
              registration.get("runKind") == config.get("runKind") == ledger.get("kind") == "formal" and
              registration.get("adoptCandidate") is True, "BASELINE_FORMAL_KIND_REQUIRED")
        _need(all(registration.get(key) == config.get(key) for key in
                  ("sequence", "budgets", "timeoutsSeconds", "candidateName", "candidateDirectory", "cmakeDirectory", "adoptCandidate")),
              "BASELINE_METADATA_CONTRACT_CHANGED")
        if preview_enabled(config):
            _need(registration.get("previewWorkspaceContract") == config["previewWorkspaceContract"],
                  "BASELINE_PREVIEW_METADATA_CONTRACT_CHANGED")
            if config["previewWorkspaceContract"] in ("v3", "v4"):
                _need(registration.get("previewWorkspaceChecks") == config["previewWorkspaceChecks"],
                      "BASELINE_PREVIEW_V3_METADATA_CHECKS_CHANGED")
            if config["previewWorkspaceContract"] == "v4":
                _need(registration.get("previewUpgradeBaseline") == config["previewUpgradeBaseline"],
                      "BASELINE_PREVIEW_V4_METADATA_INPUT_CHANGED")
        require_actual_collection(expected)
        require_all_passed(expected)
        _need(expected.get("framework") == "combined" and expected.get("allPassed") is True and
              expected.get("source") == "actual-runtime-outputs" and isinstance(expected.get("rawOutputs"), list) and
              len(expected["rawOutputs"]) == 5, "BASELINE_EXPECTED_ACTUAL_PROOF_REQUIRED")
        expected_paths = []
        for reference in expected["rawOutputs"]:
            _need(isinstance(reference, dict) and isinstance(reference.get("path"), str) and
                  _sha(reference.get("sha256")) and type(reference.get("bytes")) is int and reference["bytes"] > 0,
                  "BASELINE_EXPECTED_RAW_BINDING_INVALID")
            expected_paths.append(_path(root, reference["path"]))
        _need({path.name for path in expected_paths} == set(RAW_NAMES) and
              len({path.parent for path in expected_paths}) == 1, "BASELINE_EXPECTED_RAW_BINDING_SET")
        _same_identities(signed_baseline(config), expected, "BASELINE_SIGNED_EXPECTATIONS_CHANGED")
    identity = registration.get("registrationId")
    source_head = registration.get("sourceHead")
    _need(isinstance(identity, str) and identity and config.get("registrationId") == ledger.get("registrationId") == identity and
          isinstance(source_head, str) and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", source_head) and
          config.get("sourceHead") == ledger.get("sourceHead") == source_head, "BASELINE_SOURCE_OR_IDENTITY_CHANGED")
    if not legacy and "sourceTreeHash" in registration:
        _need(config.get("sourceTreeHash") == ledger.get("sourceTreeHash") == registration["sourceTreeHash"],
              "BASELINE_SOURCE_TREE_CHANGED")
    _stages(config, registration, ledger, legacy=legacy)
    _gui_results(root, report, config, ledger)
    adoption = _adopted_pointer(root, report, config, ledger, legacy=legacy)
    if legacy:
        selection = deepcopy(config)
        selection.pop("nodeIdentityReport", None)
        for filename in ("python-unit.xml", "node-unit.log", "frontend-unit.json", "native-unit.xml", "native-lasttest.log"):
            _read(root, report / filename)
        actual = collect_saved_outputs(report, selection, root, historical_replay=True)
        _same_identities(signed_baseline(config), actual, "BASELINE_LEGACY_OUTPUT_IDENTITIES_CHANGED")
    else:
        runtime, runtime_payload = _json(root, report / "runtime-config.json")
        binding = ledger.get("runtimeConfigBinding")
        runtime_sha = ledger.get("runtimeConfigSha256")
        _need(isinstance(binding, dict) or _sha(runtime_sha), "BASELINE_RUNTIME_CONFIG_BINDING_REQUIRED")
        if binding is not None:
            _reference(root, report, binding, "runtime-config.json")
        if runtime_sha is not None:
            _need(_sha(runtime_sha) and _digest(runtime_payload) == runtime_sha, "BASELINE_RUNTIME_CONFIG_HASH_CHANGED")
        for key in (*EXPECTATION_KEYS, "registrationId", "sourceHead", "runKind", "sequence", "candidateName",
                    "candidateDirectory", "cmakeDirectory", "budgets", "timeoutsSeconds"):
            _need(runtime.get(key) == config.get(key), "BASELINE_RUNTIME_CONTRACT_CHANGED:" + key)
        if preview_enabled(config):
            _need(runtime.get("previewWorkspaceContract") == config["previewWorkspaceContract"],
                  "BASELINE_PREVIEW_RUNTIME_CONTRACT_CHANGED")
            if config["previewWorkspaceContract"] in ("v3", "v4"):
                _need(runtime.get("previewWorkspaceChecks") == config["previewWorkspaceChecks"],
                      "BASELINE_PREVIEW_V3_RUNTIME_CHECKS_CHANGED")
            if config["previewWorkspaceContract"] == "v4":
                _need(runtime.get("previewUpgradeBaseline") == config["previewUpgradeBaseline"],
                      "BASELINE_PREVIEW_V4_RUNTIME_INPUT_CHANGED")
        _need(runtime.get("nodeIdentityReport") == "node-identities.jsonl", "BASELINE_ACTUAL_NODE_REPORTER_REQUIRED")
        saved_payload = _reference(root, report, ledger.get("identityManifest"), "actual-identities.json")
        saved = load_json_bytes(saved_payload)
        _need(isinstance(saved, dict) and saved.get("source") == "actual-runtime-outputs", "BASELINE_ACTUAL_MANIFEST_REQUIRED")
        require_actual_collection(saved)
        require_all_passed(saved)
        raw_outputs = saved.get("rawOutputs")
        _need(isinstance(raw_outputs, list) and len(raw_outputs) == len(RAW_NAMES), "BASELINE_RAW_OUTPUT_BINDINGS_REQUIRED")
        names = []
        for reference in raw_outputs:
            _need(isinstance(reference, dict) and isinstance(reference.get("path"), str), "BASELINE_RAW_OUTPUT_BINDING_INVALID")
            filename = Path(reference["path"]).name
            _need(filename in RAW_NAMES, "BASELINE_RAW_OUTPUT_NOT_REGISTERED")
            _reference(root, report, reference, filename)
            names.append(filename)
        _need(len(set(names)) == len(RAW_NAMES), "BASELINE_RAW_OUTPUT_SET_CHANGED")
        actual = collect_saved_outputs(report, runtime, root)
        require_actual_collection(actual)
        require_all_passed(actual)
        _need(saved == actual, "BASELINE_ACTUAL_MANIFEST_NOT_FROM_RAW_OUTPUT")
        _same_identities(expected, actual, "BASELINE_ACTUAL_IDENTITIES_CHANGED")
        _same_identities(signed_baseline(config), actual, "BASELINE_CURRENT_CONFIG_IDENTITIES_CHANGED")
    public_binding = _public_result(root, report, config, ledger)
    metadata = deepcopy(registration)
    metadata["_verification"] = {"format": "legacy-formal-r1" if legacy else "registered-run-v1",
        "registrationSha256": _digest(registration_payload), "ledgerSha256": _digest(ledger_payload),
        "source": actual["source"], "actualOutputsReparsed": True,
        "historicAttributionAmbiguities": deepcopy(actual.get("historicAttributionAmbiguities", [])),
        "adoption": adoption, "publicResult": public_binding}
    return deepcopy(config), metadata
