"""Immutable registration preparation and one approved shared-engine attempt.

This module saves data, hashes and repository tool commits. It never generates
or imports a report-local runner. Historical reports are read-only inputs.
All entry points take an explicit repository and use the one execution lock.
"""
from __future__ import annotations

from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Any, Mapping

from .export_config import CONFIG_SCHEMA, STAGE_BUDGETS
from .coverage import MODE_OPTIONS
from .baseline import load_signed_baseline
from .protected_data import protected_data_snapshot
from .identities import (collect_saved_outputs, compare_manifests, require_actual_collection,
                         require_all_passed, safe_relative_path, signed_baseline)
from .isolation import IsolationContext, assert_not_data_path, canonical_directory
from .readonly import ReadOnlyFileError, readonly_directory, readonly_regular_file
from .source import assert_frozen, snapshot_source
from .state import (ExecutionLock, LocalLedger, RegistrationState, StateError, ensure_directory,
                    exclusive_json, load_json_bytes, now, package_name, regular_file)
from .test_audit import audit_test_changes, read_git_sources, require_confirmed_audit
from .contract import registration_contract, contract_sha256
from .preview import (MODE as PREVIEW_MODE, SUPPORTED_VERSIONS as PREVIEW_VERSIONS,
                      effective_modes, stage_budgets, verify_saved as verify_preview_saved,
                      enabled as preview_enabled, require_current as require_current_preview)

SCHEMA = "reverie.registered-run.registration.v1"
AUTH_SCHEMA = "reverie.registered-run.authorization.v1"
GUI_MODES = ("injection", "regex", "entry", "persona", "candidate", "ordinary", "settings")
UNIT_KEYS = ("pythonTargets", "nodeTests", "frontendTests", "nativeTargets")
REHEARSAL_SCHEMA = "reverie.registered-run.rehearsal.v1"
# This is a best-effort diagnostic after the ordinary contract gate fails.
# Inspect no recursive trees and never let an untrusted record grow the read.
_REHEARSAL_LOOKUP_MAX_ENTRIES = 1024
_REHEARSAL_LOOKUP_MAX_BYTES = 64 * 1024


class RegistrationError(RuntimeError):
    pass


def _need(condition: Any, message: str) -> None:
    if not condition:
        raise RegistrationError(message)


def _bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n").encode()


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _interpreter_identity() -> dict:
    """Describe this process, resolving a venv/launcher symlink to its binary."""
    _need(isinstance(sys.executable, str) and bool(sys.executable) and Path(sys.executable).is_absolute(),
          "INTERPRETER_EXECUTABLE_UNAVAILABLE")
    identity = {"implementation": sys.implementation.name, "version": sys.version,
                "executable": str(Path(sys.executable).resolve(strict=True))}
    _need(_valid_interpreter_identity(identity), "INTERPRETER_IDENTITY_UNAVAILABLE")
    return identity


def _valid_interpreter_identity(value: Any) -> bool:
    return (isinstance(value, dict) and set(value) == {"implementation", "version", "executable"} and
            all(isinstance(value[key], str) and bool(value[key].strip()) for key in value) and
            Path(value["executable"]).is_absolute() and
            Path(value["executable"]) == Path(os.path.abspath(value["executable"])))


def _require_registration_interpreter(registration: Mapping[str, Any]) -> None:
    # Older immutable registrations predate this field and retain their rules.
    if "interpreter" not in registration:
        return
    current = _interpreter_identity()
    expected = registration["interpreter"]
    _need(_valid_interpreter_identity(expected) and expected == current,
          "REGISTRATION_INTERPRETER_MISMATCH:" +
          _bytes({"registeredInterpreter": expected, "currentInterpreter": current}).decode().strip())


def _read_rehearsal_record(root: Path, path: Path) -> dict:
    """Read a bounded diagnostic record without following an evidence alias."""
    identity = readonly_regular_file(root, path)
    _need(identity.st_size <= _REHEARSAL_LOOKUP_MAX_BYTES, "REHEARSAL_RECORD_TOO_LARGE")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        _need(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and opened.st_uid == os.getuid() and
              (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) ==
              (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns),
              "REHEARSAL_RECORD_IDENTITY_CHANGED")
        payload = stream.read(_REHEARSAL_LOOKUP_MAX_BYTES + 1)
        completed = os.fstat(stream.fileno())
        _need(len(payload) <= _REHEARSAL_LOOKUP_MAX_BYTES and
              (completed.st_dev, completed.st_ino, completed.st_size, completed.st_mtime_ns) ==
              (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns) and
              stat.S_ISREG(completed.st_mode) and completed.st_nlink == 1 and completed.st_uid == os.getuid(),
              "REHEARSAL_RECORD_CHANGED_DURING_READ")
    after = readonly_regular_file(root, path)
    _need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
          (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns),
          "REHEARSAL_RECORD_CHANGED_DURING_READ")
    value = load_json_bytes(payload)
    _need(isinstance(value, dict), "REHEARSAL_RECORD_OBJECT_REQUIRED")
    return value


def _rehearsal_interpreter_mismatch(root: Path, package: str, expected_contract_sha256: str,
                                   current: Mapping[str, Any]) -> dict | None:
    """Find only a same-package rehearsal of the supplied expected contract."""
    directory = root / ".tools/local" / package
    invalid = (OSError, ValueError, TypeError, UnicodeError, RecursionError,
               ReadOnlyFileError, StateError, RegistrationError)
    try:
        readonly_directory(root, directory)
        with os.scandir(directory) as entries:
            for _, entry in zip(range(_REHEARSAL_LOOKUP_MAX_ENTRIES), entries):
                try:
                    package_name(entry.name)
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    output = directory / entry.name
                    readonly_directory(root, output)
                    path = output / "rehearsal.json"
                    record = _read_rehearsal_record(root, path)
                    previous = record.get("interpreter")
                    if (record.get("schema") == REHEARSAL_SCHEMA and record.get("package") == package and
                            record.get("outputDirectory") == str(output.relative_to(root)) and
                            record.get("contractSha256") == expected_contract_sha256 and
                            record.get("registrationCreated") is False and record.get("activeMarkerCreated") is False and
                            _valid_interpreter_identity(previous) and previous != dict(current)):
                        return {"rehearsalRecord": str(path.relative_to(root)),
                                "rehearsalInterpreter": previous, "currentInterpreter": dict(current)}
                except invalid:
                    continue  # Missing, old, malformed and unsafe records are not evidence.
    except invalid:
        pass
    return None


def _file_sha(root: Path, path: Path) -> str:
    identity = readonly_regular_file(root, path)
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        _need(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and opened.st_uid == os.getuid() and
              (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) ==
              (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns),
              "HISTORICAL_FILE_IDENTITY_CHANGED")
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
        completed = os.fstat(stream.fileno())
        _need(stat.S_ISREG(completed.st_mode) and completed.st_nlink == 1 and completed.st_uid == os.getuid() and
              (completed.st_dev, completed.st_ino, completed.st_size, completed.st_mtime_ns) ==
              (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns),
              "HISTORICAL_FILE_CHANGED_DURING_HASH")
    after = readonly_regular_file(root, path)
    _need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
          (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns), "HISTORICAL_FILE_CHANGED_DURING_HASH")
    return digest.hexdigest()


def _read(path: Path) -> tuple[dict, bytes]:
    regular_file(path)
    payload = path.read_bytes()
    value = load_json_bytes(payload)
    _need(isinstance(value, dict), "REGISTRATION_JSON_OBJECT_REQUIRED:" + str(path))
    return value, payload


def _project_path(root: Path, value: str | Path) -> Path:
    path = Path(value)
    path = path if path.is_absolute() else root / path
    _need(path.is_relative_to(root) and path == Path(os.path.abspath(path)), "REGISTRATION_PATH_ESCAPES_ROOT")
    assert_not_data_path(path, root)
    return path


def _default_pointer(root: Path) -> tuple[dict, bytes | None]:
    filename = ".tools/qt-candidates/last-local-sdk.json"
    path = root / filename
    if not path.parent.exists() or regular_file(path, missing=True) is None:
        return {"path": filename, "exists": False, "sha256": None, "candidate": None}, None
    value, payload = _read(path)
    directory = value.get("directory")
    return {"path": filename, "exists": True, "sha256": _sha(payload),
            "candidate": Path(directory).name if isinstance(directory, str) else None}, payload


def _verify_default_pointer(root: Path, expected: Mapping[str, Any]) -> None:
    observed, _ = _default_pointer(root)
    _need(observed == dict(expected), "FROZEN_DEFAULT_POINTER_BYTES_CHANGED")


def _validated_config(root: Path, config: Mapping[str, Any]) -> dict:
    # The public CLI and registration share the data-only validator. Kept lazy
    # so importing this module cannot load or run external tools.
    from .config import validate_config
    value = validate_config(deepcopy(dict(config)))
    value = deepcopy(value if value is not None else dict(config))
    if preview_enabled(value):
        require_current_preview(value)  # Historical v1 remains readable, never newly registered.
    # This is creation only. Loading/exporting an older immutable registration
    # must retain its original eight-input/five-write v1 acceptance rules.
    value.setdefault("memoryActionContract", "v2")
    _need(value["memoryActionContract"] == "v2", "REGISTRATION_MEMORY_ACTION_CONTRACT_V2_REQUIRED")
    value.setdefault("cardExportContract", "v1")
    _need(value["cardExportContract"] == "v1", "REGISTRATION_CARD_EXPORT_CONTRACT_V1_REQUIRED")
    value.setdefault("cardEditContract", "v1")
    _need(value["cardEditContract"] == "v1", "REGISTRATION_CARD_EDIT_CONTRACT_V1_REQUIRED")
    _bytes(value)  # Reject non-data Python objects and non-finite numbers.
    _need(value.get("configSchema") == CONFIG_SCHEMA, "REGISTRATION_CONFIG_SCHEMA")
    _need(value.get("runKind") in ("formal", "development", "tool-validation"), "REGISTRATION_RUN_KIND")
    _need(value.get("stopOnFirstFailure") is True and value.get("retries") == 0, "REGISTRATION_FAIL_STOP_REQUIRED")
    sequence, budgets, timeouts = value.get("sequence"), value.get("budgets"), value.get("timeoutsSeconds")
    available_budgets = stage_budgets(value, STAGE_BUDGETS)
    _need(isinstance(sequence, list) and sequence and len(sequence) == len(set(sequence)) and
          all(stage in available_budgets for stage in sequence), "REGISTRATION_STAGE_IDS")
    _need(isinstance(budgets, dict) and isinstance(timeouts, dict), "REGISTRATION_STAGE_LIMITS")
    for stage in sequence:
        maximum = budgets.get(available_budgets[stage])
        timeout = timeouts.get(stage)
        _need(type(maximum) is int and maximum == 1, "REGISTRATION_STAGE_BUDGET:" + stage)
        _need(stage in timeouts and (timeout is None or (type(timeout) in (int, float) and timeout > 0)), "REGISTRATION_STAGE_TIMEOUT:" + stage)
    _need(value.get("runKind") == "formal" or value.get("adoptCandidate") is not True, "ONLY_FORMAL_MAY_ADOPT")
    for key in UNIT_KEYS:
        _need(isinstance(value.get(key), list) and value[key] and len(value[key]) == len(set(value[key])), "REGISTRATION_SELECTION:" + key)
        if key != "nativeTargets":
            for path in value[key]:
                safe_relative_path(path)
    modes = value.get("requiredGuiModes")
    _need(isinstance(modes, list) and len(modes) == len(set(modes)) and all(mode in effective_modes(value, GUI_MODES) for mode in modes), "REGISTRATION_REQUIRED_GUI_MODES")
    _need(value.get("nodeIdentityReport") == "node-identities.jsonl", "REGISTRATION_ACTUAL_NODE_REPORTER_REQUIRED")
    candidate, cmake = value.get("candidateDirectory"), value.get("cmakeDirectory")
    _need(isinstance(candidate, str) and candidate.startswith(".tools/qt-candidates/") and
          value.get("candidateName") == Path(candidate).name, "REGISTRATION_CANDIDATE_PATH")
    _need(isinstance(cmake, str) and cmake.startswith(".tools/qt-builds/") and
          not Path(cmake).name.startswith("local-"), "REGISTRATION_FRESH_CMAKE_REQUIRED")
    for path in (candidate, cmake):
        safe_relative_path(path)
        _project_path(root, path)
    return value


def _fresh_outputs(root: Path, config: Mapping[str, Any]) -> None:
    candidate = _project_path(root, config["candidateDirectory"])
    cmake = _project_path(root, config["cmakeDirectory"])
    _need(not candidate.exists() and not candidate.is_symlink(), "REGISTRATION_CANDIDATE_ALREADY_EXISTS")
    _need(not cmake.is_symlink() and (not cmake.exists() or (cmake.is_dir() and not any(cmake.iterdir()))), "REGISTRATION_CMAKE_NOT_FRESH_EMPTY")
    for path in (candidate, cmake):
        existing = path.parent
        while not existing.exists() and not existing.is_symlink():
            existing = existing.parent
        canonical_directory(existing)


def _selection_matches(manifest: Mapping[str, Any], config: Mapping[str, Any]) -> bool:
    observed = {
        "pythonTargets": {row["file"] for row in manifest["cases"] if row.get("framework") == "python"},
        "nodeTests": {row["file"] for row in manifest["cases"] if row.get("framework") == "node"},
        "frontendTests": {row["file"] for row in manifest["cases"] if row.get("framework") == "frontend"},
        "nativeTargets": {row["target"] for row in manifest["cases"] if row.get("framework") == "ctest"},
    }
    return all(observed[key] == set(config[key]) for key in UNIT_KEYS)


def _row_manifest(root: Path, row: Mapping[str, Any]) -> tuple[dict, dict]:
    metadata = row.get("identityManifest")
    if isinstance(metadata, dict):
        filename, expected = metadata.get("path"), metadata.get("sha256")
    else:
        filename, expected = metadata, row.get("identityManifestSha256")
    _need(isinstance(filename, str) and isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected), "LOCAL_ACTUAL_IDENTITY_MANIFEST_BINDING_REQUIRED")
    output = _project_path(root, row["outputDirectory"])
    path = _project_path(root, filename) if Path(filename).is_absolute() or filename.startswith(".tools/") else output / filename
    _need(path.is_relative_to(output), "LOCAL_IDENTITY_MANIFEST_OUTSIDE_OWN_OUTPUT")
    manifest, payload = _read(path)
    _need(_sha(payload) == expected, "LOCAL_IDENTITY_MANIFEST_HASH_CHANGED")
    require_actual_collection(manifest)
    require_all_passed(manifest)
    _need(manifest.get("source") == "actual-runtime-outputs", "LOCAL_ACTUAL_OUTPUT_PROVENANCE_REQUIRED")
    # A document claiming an "actual" source is not sufficient. The immutable
    # local completion row must agree with its run-owned engine ledger, runtime
    # config and all four stage observations; then saved raw output is parsed
    # again, without starting any project process.
    ledger, _ = _read(output / "run-ledger.json")
    _need(ledger.get("schema") == "reverie.shared-run.ledger.v1" and ledger.get("kind") == "local" and
          ledger.get("passed") is True and ledger.get("sourceHead") == row.get("sourceHead") and
          ledger.get("sourceTreeHash") == row.get("sourceTreeHash") and ledger.get("unitScratchRemoved") is True and
          ("codeTreeHash" not in row or ledger.get("codeTreeHash") == row["codeTreeHash"]) and
          ledger.get("ownedProcessesRemaining") == 0, "LOCAL_FULL_ENGINE_LEDGER_BINDING")
    bound_manifest = ledger.get("identityManifest")
    _need(isinstance(bound_manifest, dict) and isinstance(bound_manifest.get("path"), str) and
          bound_manifest.get("sha256") == expected, "LOCAL_ENGINE_IDENTITY_MANIFEST_BINDING")
    engine_path = bound_manifest["path"]
    engine_path = _project_path(root, engine_path) if Path(engine_path).is_absolute() or engine_path.startswith(".tools/") else output / engine_path
    _need(engine_path == path and bound_manifest.get("bytes", len(payload)) == len(payload), "LOCAL_ENGINE_IDENTITY_MANIFEST_BINDING")
    runtime, runtime_payload = _read(output / "runtime-config.json")
    runtime_binding = ledger.get("runtimeConfigBinding")
    _need(isinstance(runtime_binding, dict) and runtime_binding.get("path") == str((output / "runtime-config.json").relative_to(root)) and
          runtime_binding.get("sha256") == _sha(runtime_payload) and runtime_binding.get("bytes") == len(runtime_payload),
          "LOCAL_RUNTIME_CONFIG_BINDING")
    _need(runtime.get("runKind") == "local", "LOCAL_RUNTIME_CONFIG_KIND")
    stage_ids = ["python-unit", "node-unit", "frontend-unit", "native-unit"]
    runs = ledger.get("runs")
    _need(isinstance(runs, list) and [run.get("id") for run in runs] == stage_ids and
          all(run.get("passed") is True and run.get("exitCode") == 0 and run.get("state") == "completed" and
              run.get("processGroupGone") is True for run in runs),
          "LOCAL_COMPLETE_UNIT_ENGINE_STAGES_REQUIRED")
    raw_outputs = manifest.get("rawOutputs")
    _need(isinstance(raw_outputs, list) and len(raw_outputs) == 5, "LOCAL_RAW_OUTPUT_BINDINGS_REQUIRED")
    expected_names = {"python-unit.xml", "node-identities.jsonl", "frontend-unit.json", "native-unit.xml", "native-lasttest.log"}
    observed_paths = []
    for reference in raw_outputs:
        _need(isinstance(reference, dict) and isinstance(reference.get("path"), str), "LOCAL_RAW_OUTPUT_BINDING_INVALID")
        raw_path = _project_path(root, reference["path"])
        _need(raw_path.parent == output and raw_path.name in expected_names, "LOCAL_RAW_OUTPUT_OUTSIDE_OWN_RUN")
        regular_file(raw_path)
        raw_payload = raw_path.read_bytes()
        _need(reference.get("bytes") == len(raw_payload) and reference.get("sha256") == _sha(raw_payload), "LOCAL_RAW_OUTPUT_HASH_CHANGED:" + raw_path.name)
        observed_paths.append(raw_path.name)
    _need(set(observed_paths) == expected_names and len(set(observed_paths)) == len(observed_paths), "LOCAL_RAW_OUTPUT_BINDING_SET")
    recomputed = collect_saved_outputs(output, runtime, root)
    _need(recomputed == manifest, "LOCAL_IDENTITY_MANIFEST_NOT_FROM_SAVED_OUTPUTS")
    for run, label, frameworks in zip(runs, ("python", "node", "frontend", "native"),
                                     (("python",), ("node",), ("frontend",), ("ctest", "qtest"))):
        key = label + "ActualIdentities"
        report = ledger.get(key)
        _need(isinstance(report, dict) and run.get("evidence", {}).get(key) == report,
              "LOCAL_STAGE_ACTUAL_IDENTITY_BINDING:" + label)
        require_all_passed(report)
        recorded = [{**case, "framework": case.get("framework", report.get("framework"))} for case in report["cases"]]
        actual_cases = [case for case in recomputed["cases"] if case.get("framework") in frameworks]
        _need(Counter(_bytes(case) for case in recorded) == Counter(_bytes(case) for case in actual_cases),
              "LOCAL_STAGE_ACTUAL_IDENTITIES_CHANGED:" + label)
    return manifest, {"path": str(path.relative_to(root)), "sha256": expected, "sequence": row["sequence"],
                      "outputDirectory": str(output.relative_to(root)), "rawOutputs": deepcopy(raw_outputs),
                      "engineLedger": _reference(root, output / "run-ledger.json"),
                      "runtimeConfig": deepcopy(runtime_binding)}


def _reference(root: Path, path: Path) -> dict:
    identity = readonly_regular_file(root, path)
    digest = _file_sha(root, path)
    after = readonly_regular_file(root, path)
    _need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) ==
          (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns),
          "HISTORICAL_FILE_CHANGED_DURING_HASH")
    return {"path": str(path.relative_to(root)), "sha256": digest, "bytes": identity.st_size}


def _checked_reference(root: Path, reference: Mapping[str, Any], *, parent: Path | None = None) -> tuple[Path, dict]:
    _need(isinstance(reference, dict) and isinstance(reference.get("path"), str), "LOCAL_PREREQUISITE_REFERENCE_REQUIRED")
    path = _project_path(root, reference["path"])
    _need(parent is None or path.parent == parent, "LOCAL_PREREQUISITE_REFERENCE_PARENT")
    actual = _reference(root, path)
    _need(all(reference.get(key) == actual[key] for key in ("path", "sha256", "bytes")),
          "LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED:" + path.name)
    return path, actual


GUI_PROOF_KEYS = {
    "injection": ("worldbookInjectionEvidence",),
    "regex": ("worldbookRegexEvidence", "regexWorkerOwnership"),
    "entry": ("worldbookEntrySettingsEvidence",),
    "persona": ("worldbookPriorityEvidence", "personaRowInputEvidence", "authorControlInputEvidence"),
    "candidate": ("memoryCandidateBatchEvidence", "checkCountsByCycle", "requests", "messageIdsAcrossRestartEqual"),
    "ordinary": ("memoryBatchDeleteEvidence", "summaryAcquisitionEvidence", "summaryViewEvidence", "replyStartEvidence", "memoryBatchPinEvidence"),
    "settings": ("settingsOrdinaryEvidence", "settingsEvidence"),
}


def _gui_process_exits(exits: Any) -> bool:
    # The original checker also records a terminal "cleanup" process row.
    # Preserve its rule: two numbered cycles, and every exit including cleanup
    # is normal and has no remaining owned process.
    return (isinstance(exits, list) and all(isinstance(entry, dict) for entry in exits) and
            [entry.get("cycle") for entry in exits if entry.get("cycle") in (1, 2)] == [1, 2] and
            all(entry.get("exitCode") == 0 and entry.get("signal") is None and entry.get("remaining") == [] for entry in exits))


def _gui_prerequisite(root: Path, row: Mapping[str, Any], mode: str,
                      memory_action_contract: str | None = None,
                      card_export_contract: str | None = None,
                      card_edit_contract: str | None = None,
                      preview_workspace_contract: str | None = None,
                      preview_upgrade_baseline: dict | None = None) -> dict:
    _need(isinstance(row.get("outputDirectory"), str), "LOCAL_GUI_ACTUAL_OUTPUT_REQUIRED:" + mode)
    output = _project_path(root, row["outputDirectory"])
    ledger, _ = _read(output / "run-ledger.json")
    _need(ledger.get("schema") == "reverie.shared-run.ledger.v1" and ledger.get("kind") == "local" and
          ledger.get("passed") is True and ledger.get("sourceHead") == row.get("sourceHead") and
          ledger.get("sourceTreeHash") == row.get("sourceTreeHash") and ledger.get("unitScratchRemoved") is True and
          ("codeTreeHash" not in row or ledger.get("codeTreeHash") == row["codeTreeHash"]) and
          ledger.get("ownedProcessesRemaining") == 0, "LOCAL_GUI_ENGINE_LEDGER_BINDING:" + mode)
    runtime, runtime_bytes = _read(output / "runtime-config.json")
    _checked_reference(root, ledger.get("runtimeConfigBinding"), parent=output)
    _need(ledger["runtimeConfigBinding"]["path"] == str((output / "runtime-config.json").relative_to(root)) and
          runtime.get("runKind") == "local" and runtime.get("sourceHead") == row.get("sourceHead") and
          isinstance(runtime.get("package"), str) and runtime.get("candidateDirectory") == runtime.get("cmakeDirectory") ==
          ".tools/qt-builds/local-" + runtime["package"], "LOCAL_GUI_RUNTIME_CONFIG_BINDING:" + mode)
    stage_id = mode + "-check"
    runs = ledger.get("runs")
    _need(isinstance(runs, list) and runs and len({run.get("id") for run in runs}) == len(runs) and
          all(run.get("id") in {name + "-check" for name in effective_modes(runtime, GUI_MODES)} and run.get("passed") is True and
              run.get("state") == "completed" and run.get("exitCode") == 0 and run.get("processGroupGone") is True for run in runs),
          "LOCAL_GUI_COMPLETE_ENGINE_STAGES_REQUIRED:" + mode)
    matching = [run for run in runs if run["id"] == stage_id]
    _need(len(matching) == 1, "LOCAL_GUI_MODE_STAGE_MISSING:" + mode)
    run = matching[0]
    if mode == PREVIEW_MODE:
        _need(preview_workspace_contract in PREVIEW_VERSIONS and
              preview_workspace_contract == runtime.get("previewWorkspaceContract"),
              "LOCAL_PREVIEW_CONTRACT_BINDING")
        if preview_workspace_contract == "v4":
            _need(runtime.get("previewUpgradeBaseline") == preview_upgrade_baseline,
                  "LOCAL_PREVIEW_PREVIOUS_INPUT_BINDING")
        _need(run.get("previewIsolationRoot") == ledger.get("unitIsolation", {}).get("scratch"),
              "LOCAL_PREVIEW_ISOLATION_BINDING")
        record = ledger.get("guiResults", {}).get(stage_id)
        _need(isinstance(record, dict) and run.get("evidence", {}).get("guiResults", {}).get(stage_id) == record,
              "LOCAL_PREVIEW_STAGE_PROOF_BINDING")
        summary_path = output / stage_id / "summary.json"
        from .modes.context import RunContext
        observed = verify_preview_saved(RunContext(root, output, runtime), summary_path, run, record)
        _need(all(record.get(key) == value for key, value in observed.items()) and
              record.get("reportRoot") == str(summary_path.parent) and
              record.get("summarySha256") == _reference(root, summary_path)["sha256"], "LOCAL_PREVIEW_HOST_PROOF_CHANGED")
        log = output / (stage_id + ".log")
        regular_file(log)
        advertised = [value.get("reportRoot") for line in log.read_bytes().splitlines()
                      if line.strip().startswith(b"{") and isinstance((value := load_json_bytes(line)), dict) and
                      "reportRoot" in value]
        _need(advertised == [str(summary_path.parent)], "LOCAL_PREVIEW_STAGE_LOG_ROOT_BINDING")
        raw_references = []
        for reference in observed["rawReportBinding"]:
            parent = summary_path.parent
            name = reference.get("path") if isinstance(reference, dict) else None
            if preview_workspace_contract == "v4" and isinstance(name, str):
                path = _project_path(root, name)
                if path.parent == summary_path.parent / "evidence":
                    parent = summary_path.parent / "evidence"
            raw_references.append(_checked_reference(root, reference, parent=parent)[1])
        proof = observed["previewWorkspaceEvidence"]
        return {"sequence": row["sequence"], "stage": stage_id, "outputDirectory": str(output.relative_to(root)),
                "engineLedger": _reference(root, output / "run-ledger.json"),
                "runtimeConfig": _reference(root, output / "runtime-config.json"),
                "summary": _reference(root, summary_path), "rawReports": raw_references,
                "stageLog": _reference(root, log), "hostProofsSha256": _sha(_bytes(proof)),
                "hostProofs": {"previewWorkspaceEvidence": proof},
                "reportRoot": str(summary_path.parent.relative_to(root))}
    expected_command = [str(root / "script/check-qt-macos.sh"), "--build-dir", str(root / runtime["candidateDirectory"]), *dict(MODE_OPTIONS)[mode]]
    _need(run.get("command") == expected_command and run.get("cwd") == str(root), "LOCAL_GUI_STAGE_COMMAND_BINDING:" + mode)
    record = ledger.get("guiResults", {}).get(stage_id)
    _need(isinstance(record, dict) and run.get("evidence", {}).get("guiResults", {}).get(stage_id) == record,
          "LOCAL_GUI_STAGE_PROOF_BINDING:" + mode)
    required = ("archiveControlReadinessEvidence", "forcedCleanupEvidence", *GUI_PROOF_KEYS[mode])
    _need(all(key in record for key in required), "LOCAL_GUI_HOST_PROOFS_MISSING:" + mode)
    snapshot_path, snapshot_reference = _checked_reference(root, record.get("reportRootsBeforeManifest"), parent=output)
    snapshot, _ = _read(snapshot_path)
    roots = snapshot.get("roots")
    _need(snapshot.get("schema") == "reverie.gui-report-roots-before.v1" and snapshot.get("stage") == stage_id and
          isinstance(roots, list) and all(isinstance(name, str) and re.fullmatch(r"\.tools/reports/qt-[A-Za-z0-9_.-]+", name) for name in roots) and
          roots == sorted(set(roots)) and snapshot.get("count") == len(roots) == record.get("reportRootsBefore") ==
          record["reportRootsBeforeManifest"].get("count") and record["reportRootsBeforeManifest"].get("stage") == stage_id,
          "LOCAL_GUI_ROOT_SNAPSHOT_BINDING:" + mode)
    _need(isinstance(record.get("reportRoot"), str), "LOCAL_GUI_SUMMARY_ROOT_REQUIRED:" + mode)
    report_root = _project_path(root, record["reportRoot"])
    _need(report_root.parent == root / ".tools/reports" and report_root.name.startswith("qt-") and
          str(report_root.relative_to(root)) not in roots, "LOCAL_GUI_REPORT_NOT_OWN_FRESH_ROOT:" + mode)
    log = output / (stage_id + ".log")
    regular_file(log)
    advertised = []
    for line in log.read_bytes().splitlines():
        if line.strip().startswith(b"{"):
            value = load_json_bytes(line)
            if isinstance(value, dict) and "reportRoot" in value:
                advertised.append(value["reportRoot"])
    _need(advertised == [str(report_root)], "LOCAL_GUI_STAGE_LOG_ROOT_BINDING:" + mode)
    summary_path = report_root / "summary.json"
    summary, summary_bytes = _read(summary_path)
    _need(record.get("summarySha256") == _sha(summary_bytes) and summary.get("sourceHead") == row.get("sourceHead") and
          summary.get("passed") is True and summary.get("automaticRetry") is False and summary.get("applicationDeadlineMs") == 240000 and
          all(summary.get(key) is True for key in ("noResidualProcesses", "testDataRemoved", "applicationUnchanged", "modelInputUnchanged")),
          "LOCAL_GUI_ACTUAL_SUMMARY_BINDING:" + mode)
    exits = summary.get("processExits")
    _need(_gui_process_exits(exits),
          "LOCAL_GUI_PROCESS_EXITS_REQUIRED:" + mode)
    forced = {"forcedCleanup": False, "forcedCleanupTargets": 0, "forcedCleanupSignalsSent": 0,
              "forcedCleanupIdentityChanged": 0, "forcedCleanupErrors": []}
    _need(record["forcedCleanupEvidence"] == forced and all(summary.get(key) == value for key, value in forced.items()),
          "LOCAL_GUI_FORCED_CLEANUP_BINDING:" + mode)
    _need(isinstance(record["archiveControlReadinessEvidence"], dict) and record["archiveControlReadinessEvidence"].get("passed") is True and
          record["archiveControlReadinessEvidence"] == summary.get("archiveControlReadinessEvidence"), "LOCAL_GUI_ARCHIVE_HOST_PROOF_CHANGED:" + mode)
    reports, raw = summary.get("reports"), record.get("rawReportBinding")
    _need(isinstance(reports, list) and len(reports) == 2 and isinstance(raw, list) and len(raw) == 2, "LOCAL_GUI_RAW_TWO_CYCLES_REQUIRED:" + mode)
    if memory_action_contract == "v2":
        _need(runtime.get("memoryActionContract") == "v2", "LOCAL_GUI_MEMORY_ACTION_CONTRACT_MISMATCH:" + mode)
        # Recheck the run-owned raw acquisition using the tracked in-process
        # verifier. A prior v1 pass cannot satisfy a new v2 registration.
        from .modes.context import RunContext
        acquired = RunContext(root, output, runtime).invoke("verify_memory_action_result_v2", summary)
        _need(record.get("memoryActionAcquisition") == acquired,
              "LOCAL_GUI_MEMORY_ACTION_HOST_PROOF_CHANGED:" + mode)
        required = (*required, "memoryActionAcquisition")
    if mode == "persona" and card_export_contract is not None:
        _need(card_export_contract == "v1" and runtime.get("cardExportContract") == "v1",
              "LOCAL_GUI_CARD_EXPORT_CONTRACT_MISMATCH")
        from .modes.context import RunContext
        card_export = RunContext(root, output, runtime).invoke("verify_card_export", summary, runtime, summary_path)
        _need(record.get("cardExportEvidence") == card_export, "LOCAL_GUI_CARD_EXPORT_HOST_PROOF_CHANGED")
        required = (*required, "cardExportEvidence")
    if mode == "persona" and card_edit_contract is not None:
        _need(card_edit_contract == "v1" and runtime.get("cardEditContract") == "v1",
              "LOCAL_GUI_CARD_EDIT_CONTRACT_MISMATCH")
        from .modes.context import RunContext
        card_edit = RunContext(root, output, runtime).invoke("verify_card_edit", summary, runtime, summary_path)
        _need(record.get("cardEditEvidence") == card_edit, "LOCAL_GUI_CARD_EDIT_HOST_PROOF_CHANGED")
        required = (*required, "cardEditEvidence")
    raw_references = []
    for cycle, (report, reference) in enumerate(zip(reports, raw), 1):
        raw_path, checked = _checked_reference(root, reference, parent=report_root)
        raw_value, _ = _read(raw_path)
        _need(raw_path.name == "cycle-" + str(cycle) + ".json" and raw_value == report and report.get("passed") is True and
              report.get("error") in (None, "") and str(report.get("cycle")) == str(cycle), "LOCAL_GUI_RAW_SUMMARY_EXACT_MISMATCH:" + mode)
        raw_references.append(checked)
    if mode in ("injection", "regex", "entry"):
        evidence, summary_key = {"injection": ("worldbookInjectionEvidence", "worldbookInjection"),
            "regex": ("worldbookRegexEvidence", "worldbookRegex"), "entry": ("worldbookEntrySettingsEvidence", "worldbookEntrySettings")}[mode]
        _need(isinstance(record[evidence], dict) and record[evidence].get("proof") == summary.get(summary_key) and
              isinstance(summary.get(summary_key), dict) and summary[summary_key].get("passed") is True, "LOCAL_GUI_MODE_HOST_PROOF_CHANGED:" + mode)
    elif mode == "persona":
        evidence = record["worldbookPriorityEvidence"]
        _need(isinstance(evidence, dict) and evidence.get("priority") == summary.get("worldbookPriority") and
              evidence.get("bookSettings") == summary.get("worldbookBookSettings") and
              all(isinstance(summary.get(key), dict) and summary[key].get("passed") is True for key in ("worldbookPriority", "worldbookBookSettings")) and
              all(isinstance(record[key], dict) and record[key].get("passed") is True and record[key] == summary.get(key)
                  for key in ("personaRowInputEvidence", "authorControlInputEvidence")), "LOCAL_GUI_MODE_HOST_PROOF_CHANGED:" + mode)
    proof = {key: record[key] for key in required}
    return {"sequence": row["sequence"], "stage": stage_id, "outputDirectory": str(output.relative_to(root)),
            "engineLedger": _reference(root, output / "run-ledger.json"), "runtimeConfig": _reference(root, output / "runtime-config.json"),
            "summary": _reference(root, summary_path), "rawReports": raw_references, "reportRootsBefore": snapshot_reference,
            "stageLog": _reference(root, log), "hostProofsSha256": _sha(_bytes(proof)), "hostProofs": proof,
            "reportRoot": str(report_root.relative_to(root))}


def _prerequisite_files(root: Path, paths: list[Path]) -> list[dict]:
    references = {}
    for path in paths:
        _project_path(root, path)
        members = sorted(path.rglob("*")) if path.is_dir() else [path]
        for member in members:
            _need(not member.is_symlink(), "LOCAL_PREREQUISITE_SYMLINK_FORBIDDEN")
            if member.is_dir():
                canonical_directory(member)
            else:
                reference = _reference(root, member)
                previous = references.get(reference["path"])
                _need(previous is None or previous == reference, "LOCAL_PREREQUISITE_FILE_CHANGED_DURING_FREEZE")
                references[reference["path"]] = reference
    return [references[key] for key in sorted(references)]


def _local_source_link(root: Path, row: Mapping[str, Any], source: Mapping[str, Any]) -> dict | None:
    """Accept clean equal-code rows only across a verified docs-only ancestry."""
    code = source.get("codeTreeHash")
    if not isinstance(code, str) or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", code):
        return None
    if (source.get("dirty") is not False or row.get("sourceDirty") is not False or
            row.get("codeTreeHash") != code):
        return None
    before, after = row.get("sourceHead"), source.get("head")
    if not all(isinstance(head, str) and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", head)
               for head in (before, after)):
        return None
    # Two clean records at one commit cannot disagree about its full source
    # tree. The docs-only relaxation applies only across different commits.
    if before == after and row.get("sourceTreeHash") != source.get("treeHash"):
        return None
    ancestry = subprocess.run(["git", "merge-base", "--is-ancestor", before, after], cwd=root,
                              capture_output=True, check=False, timeout=30)
    if ancestry.returncode != 0:
        return None
    changed = subprocess.run(["git", "diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", before, after, "--"],
                             cwd=root, capture_output=True, check=True, timeout=30)
    paths = sorted(path for path in changed.stdout.decode().split("\0") if path)
    if any(not path.startswith("docs/") for path in paths):
        return None
    return {"sourceHead": before, "interveningDocumentationPaths": paths}


def _local_prerequisites(root: Path, package: str, config: Mapping[str, Any], source: Mapping[str, Any]) -> tuple[dict, dict]:
    directory = root / ".tools/local" / package
    ledger_path = directory / "ledger.jsonl"
    regular_file(ledger_path)
    rows = LocalLedger._read_rows(ledger_path)
    _need(all(row.get("sequence") == index for index, row in enumerate(rows, 1)), "LOCAL_PREREQUISITE_LEDGER_SEQUENCE")
    _need(not list(directory.glob("pending-*.json")), "LOCAL_PREREQUISITE_PENDING_RUN")
    # Failures on equal code include dirty runs and unrelated/re-written heads;
    # docs-only ancestry is a prerequisite guard, never a failure filter.
    _require_code_source(root, source)
    current = [row for row in rows if row.get("codeTreeHash") == source["codeTreeHash"]]
    analyses = LocalLedger._read_rows(directory / "analyses.jsonl")
    addressed = {sequence for analysis in analyses if analysis.get("reportedToUser") is True and analysis.get("note", "").strip()
                 for sequence in analysis.get("failureSequences", [])}
    unresolved = [row["sequence"] for row in current if (row.get("passed") is not True or row.get("unstable") is True) and row["sequence"] not in addressed]
    _need(not unresolved, "LOCAL_UNANALYSED_FAILURE_OR_INSTABILITY:" + json.dumps(unresolved))
    links = {row["sequence"]: link for row in current if (link := _local_source_link(root, row, source)) is not None}
    eligible = [row for row in current if row["sequence"] in links]
    complete = [row for row in eligible if row.get("category") == "full" and row.get("passed") is True
                and row.get("exitCode") == 0 and row.get("sourceDirty") is False
                and not row.get("diagnostic") and not row.get("unstable")]
    manifest, binding = None, None
    for row in reversed(complete):
        candidate, candidate_binding = _row_manifest(root, row)
        if _selection_matches(candidate, config):
            manifest, binding = candidate, {**candidate_binding, **links[row["sequence"]]}
            break
    _need(manifest is not None, "LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED")
    gui = {}
    for mode in config["requiredGuiModes"]:
        matches = [row for row in eligible if row.get("category") == "gui" and row.get("passed") is True
                   and row.get("exitCode") == 0 and row.get("sourceDirty") is False
                   and not row.get("diagnostic") and not row.get("unstable")
                   and (row.get("selection") in (mode, mode + "-check", [mode], [mode + "-check"])
                        or mode in row.get("guiModes", []))]
        _need(matches, "LOCAL_FROZEN_GUI_PASS_REQUIRED:" + mode)
        gui[mode] = {**_gui_prerequisite(root, matches[-1], mode, config.get("memoryActionContract"), config.get("cardExportContract"), config.get("cardEditContract"), config.get("previewWorkspaceContract"), config.get("previewUpgradeBaseline")),
                     **links[matches[-1]["sequence"]]}
    preserved = [root / binding["outputDirectory"], ledger_path]
    if (directory / "analyses.jsonl").exists():
        preserved.append(directory / "analyses.jsonl")
    for record in gui.values():
        preserved.extend((root / record["outputDirectory"], root / record["reportRoot"]))
    summary = {"sourceHead": source["head"], "sourceTreeHash": source["treeHash"], "unitRun": binding,
               "requiredGuiRuns": gui, "countsByCategory": dict(Counter(row.get("category") for row in rows)),
               "failedSequences": [row["sequence"] for row in rows if row.get("passed") is not True],
               "analysedFailureSequences": sorted(addressed), "unresolvedCurrentSourceFailures": [],
               "bindings": _prerequisite_files(root, preserved)}
    if "codeTreeHash" in source:
        summary["codeTreeHash"] = source["codeTreeHash"]
    summary["sourceLinks"] = [{"sequence": record["sequence"], "sourceHead": record["sourceHead"],
                               "interveningDocumentationPaths": record["interveningDocumentationPaths"]}
                              for record in [binding, *gui.values()]]
    return manifest, summary


def _git_paths(root: Path, revision: str) -> list[str]:
    result = subprocess.run(["git", "ls-tree", "-r", "--name-only", "-z", revision], cwd=root, capture_output=True, check=True)
    return [path for path in result.stdout.decode().split("\0") if path and path != "data" and not path.startswith("data/")]


def _is_test_scope(path: str, explicit: set[str]) -> bool:
    name = Path(path).name
    return path in explicit or path.startswith("tests/") or "/tests/" in path or (
        path.startswith("native-ui/") and name.endswith((".cjs", ".mjs"))) or (
        path.startswith("script/") and ("test" in name.lower() or "fixture" in name.lower()))


def _audit_sources(root: Path, baseline: Mapping[str, Any], source: Mapping[str, Any], config: Mapping[str, Any]) -> dict:
    baseline_paths = _git_paths(root, baseline["sourceHead"])
    current_paths = [item["path"] for item in source["files"]]
    explicit = {path for key in ("pythonTargets", "nodeTests", "frontendTests") for path in baseline[key]}
    explicit.update(config.get("testAuditPaths", []))
    for path in explicit:
        safe_relative_path(path)
    extensions = (".py", ".cjs", ".mjs", ".js", ".ts", ".tsx", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".json")
    before_paths = [path for path in baseline_paths if path.endswith(extensions) and _is_test_scope(path, explicit)]
    after_paths = [path for path in current_paths if path.endswith(extensions) and _is_test_scope(path, explicit)]
    before = read_git_sources(root, baseline["sourceHead"], before_paths)
    after = read_git_sources(root, source["head"], after_paths)
    direction = config.get("testChangeDirectionDocument")
    if direction is not None:
        _need(isinstance(direction, dict) and isinstance(direction.get("path"), str), "TEST_CHANGE_DIRECTION_DOCUMENT_INVALID")
        path = _project_path(root, safe_relative_path(direction["path"]))
        regular_file(path)
        _need(_sha(path.read_bytes()) == direction.get("sha256"), "TEST_CHANGE_DIRECTION_DOCUMENT_HASH_CHANGED")
    report = audit_test_changes(before, after, signed_baseline(baseline),
                                confirmations=config.get("confirmedTestChanges", []), direction_document=direction,
                                repository_root=root, node=str(root / config["node"]))
    report["scopePaths"] = {"before": before_paths, "after": after_paths}
    require_confirmed_audit(report)
    return report


def _historical_unchanged(root: Path, historical: Mapping[str, str]) -> int:
    def check(filename: str, expected: str) -> None:
        # Keep the complete serial per-file chain in one task. In particular,
        # a later malformed SHA/path must not outrank an earlier file error.
        _need(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected), "HISTORICAL_SHA256_INVALID")
        path = _project_path(root, safe_relative_path(filename))
        _need(_file_sha(root, path) == expected, "HISTORICAL_EVIDENCE_CHANGED:" + filename)

    entries = iter(historical.items())
    pending = deque()
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="historical-evidence") as executor:
        try:
            for _ in range(4):
                entry = next(entries, None)
                if entry is None:
                    break
                pending.append(executor.submit(check, *entry))
            while pending:
                # Consume in manifest order, regardless of completion order.
                # A successful result permits exactly one replacement task.
                pending.popleft().result()
                entry = next(entries, None)
                if entry is not None:
                    pending.append(executor.submit(check, *entry))
        finally:
            # Do not submit after an observed error. Cancel queued tasks and
            # let the executor context join every task that already started
            # before propagating the original exception from result().
            for future in pending:
                future.cancel()
    return len(historical)


def _historical_snapshot(root: Path, baseline_directory: Path, baseline: Mapping[str, Any], config: Mapping[str, Any]) -> dict:
    inherited = baseline.get("historicalEvidence", {})
    _need(isinstance(inherited, dict), "HISTORICAL_BASELINE_MANIFEST_REQUIRED")
    historical = dict(inherited)
    def add(filename: str, digest: str) -> None:
        safe_relative_path(filename)
        _need(filename not in historical or historical[filename] == digest, "HISTORICAL_MANIFEST_HASH_CONFLICT:" + filename)
        historical[filename] = digest
    public_name = config.get("baselineSource", {}).get("publicResult", "docs/evidence/" + baseline["registrationId"] + ".json")
    public_path = _project_path(root, safe_relative_path(public_name))
    public, payload = _read(public_path)
    _need(public.get("formalAcceptance") is True and isinstance(public.get("artifacts"), list), "SIGNED_BASELINE_PUBLIC_ARTIFACTS_REQUIRED")
    for row in public["artifacts"]:
        _need(isinstance(row, dict) and isinstance(row.get("path"), str) and isinstance(row.get("sha256"), str), "HISTORICAL_PUBLIC_ARTIFACT_INVALID")
        add(row["path"], row["sha256"])
    add(str(public_path.relative_to(root)), _sha(payload))
    # Include all immutable baseline preparation/run/raw files, not merely the
    # published subset. A symlink or alias never broadens this read scope.
    readonly_directory(root, baseline_directory)
    for path in sorted(baseline_directory.rglob("*")):
        _need(not path.is_symlink(), "HISTORICAL_REPORT_SYMLINK_FORBIDDEN")
        if path.is_dir():
            readonly_directory(root, path)
        else:
            add(str(path.relative_to(root)), _file_sha(root, path))
    _historical_unchanged(root, historical)
    return dict(sorted(historical.items()))


def _expectations(config: dict, manifest: dict, baseline: dict) -> dict:
    result = deepcopy(config)
    by_framework = {framework: [row for row in manifest["cases"] if row.get("framework") == framework]
                    for framework in ("python", "node", "frontend", "ctest", "qtest")}
    result["expectedPythonIdentities"] = [row["identity"] for row in by_framework["python"]]
    result["expectedPythonCount"] = len(by_framework["python"])
    result["expectedPythonByFile"] = dict(Counter(row["file"] for row in by_framework["python"]))
    for framework, key in (("node", "expectedNodeNames"), ("frontend", "expectedFrontendNames")):
        result[key] = {file: [row["name"] for row in by_framework[framework] if row["file"] == file]
                       for file in result["nodeTests" if framework == "node" else "frontendTests"]}
    result["expectedNativeIdentities"] = {target: [row["name"] for row in by_framework["qtest"] if row["target"] == target]
                                          for target in result["nativeTargets"]}
    result["expectedNativeTotals"] = {target: len(rows) for target, rows in result["expectedNativeIdentities"].items()}
    python_added = Counter(result["expectedPythonIdentities"]) - Counter(baseline["expectedPythonIdentities"])
    result["addedPythonIdentities"] = list(python_added.elements())
    for key, added in (("expectedNodeNames", "addedNodeNames"), ("expectedFrontendNames", "addedFrontendNames"),
                       ("expectedNativeIdentities", "addedNativeIdentities")):
        result[added] = {file: list((Counter(names) - Counter(baseline[key].get(file, []))).elements()) for file, names in result[key].items()}
    counts = deepcopy(result.get("expectedUnitCounts", {}))
    lifecycle = sum(bool(row.get("lifecycle")) for row in by_framework["qtest"])
    counts.update(python=len(by_framework["python"]), pythonFileCount=len(result["pythonTargets"]),
                  node=len(by_framework["node"]), nodeFileCount=len(result["nodeTests"]),
                  frontend=len(by_framework["frontend"]), frontendFileCount=len(result["frontendTests"]),
                  ctestTargets=len(by_framework["ctest"]), qtTestTotals=len(by_framework["qtest"]),
                  lifecycleRows=lifecycle, functionalRows=len(by_framework["qtest"]) - lifecycle)
    for target, key in (("runtime-bridge", "runtimeBridgeTestTotals"), ("persona-card-confirmation", "personaCardTestTotals"),
                        ("archive-editor", "archiveEditorTestTotals"), ("archive-drawer-scroll", "archiveDrawerScrollTestTotals"),
                        ("control-readiness", "controlReadinessTestTotals")):
        if target in result["expectedNativeTotals"]:
            counts[key] = result["expectedNativeTotals"][target]
    result["expectedUnitCounts"] = counts
    return result


def _protect_runtime_deletions(audit: dict, difference: dict, before: dict, after: dict, config: dict) -> None:
    """Protect runtime loss even when a helper/compile change hides a test.

    An already confirmed source change for the same signed identity covers its
    runtime deletion. Otherwise it needs its own exact, direction-bound change
    record; a later smaller passing run cannot silently redefine the baseline.
    """
    old_counts = Counter((row["framework"], row["identity"]) for row in before["cases"])
    new_counts = Counter((row["framework"], row["identity"]) for row in after["cases"])
    for removed in difference["deleted"]:
        framework, identity = removed["framework"], removed["identity"]
        if any(change.get("framework") == framework and change.get("identity") == identity and change.get("confirmed") is True
               for change in audit["signedChanges"]):
            continue
        old_count, new_count = old_counts[framework, identity], new_counts[framework, identity]
        payload = {"kind": "runtime-identity-deleted", "framework": framework, "identity": identity,
                   "beforeCount": old_count, "afterCount": new_count,
                   "beforeHash": _sha(_bytes({"identity": identity, "count": old_count})),
                   "afterHash": _sha(_bytes({"identity": identity, "count": new_count}))}
        change = {**payload, "changeId": _sha(_bytes(payload))}
        direction = config.get("testChangeDirectionDocument")
        confirmations = [item for item in config.get("confirmedTestChanges", []) if
            all(item.get(key) == change[key] for key in ("changeId", "kind", "identity", "beforeHash", "afterHash")) and
            direction is not None and item.get("directionDocument") == direction and
            isinstance(item.get("authorization"), str) and item["authorization"].strip() and
            isinstance(item.get("confirmedAt"), str) and item["confirmedAt"].strip()]
        _need(len(confirmations) <= 1, "DUPLICATE_RUNTIME_IDENTITY_CONFIRMATION")
        change["confirmed"] = len(confirmations) == 1
        audit["signedChanges"].append(change)
        if not change["confirmed"]:
            audit["rejectedChangeIds"].append(change["changeId"])
    audit["registrationAllowed"] = not audit["rejectedChangeIds"]
    difference["renameCandidates"] = [{"framework": change["framework"], "oldIdentity": change["identity"],
        "newName": change["newName"], "basis": "equal semantic source body", "confirmed": change["confirmed"]}
        for change in audit["signedChanges"] if change["kind"] == "renamed"]


def _require_code_source(root: Path, source: Mapping[str, Any]) -> None:
    code = source.get("codeTreeHash")
    _need(isinstance(code, str) and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", code),
          "REGISTRATION_CODE_TREE_HASH_REQUIRED")


def _prepare_registration(project: Path, package: str, config: Mapping[str, Any], report_dir: str | Path,
                          lock: ExecutionLock) -> dict:
    """Run every freeze guard and calculate materials without publishing them."""
    from .state import LocalRunState
    package_name(package)
    state = RegistrationState(project, lock)
    state.assert_no_active()
    LocalRunState(project, lock).assert_no_active()
    interpreter = _interpreter_identity()
    value = _validated_config(project, config)
    registration_id = package_name(value["registrationId"])
    destination = _project_path(project, report_dir)
    _need(destination.parent == project / ".tools/reports" and destination.name == registration_id,
          "REGISTRATION_REPORT_DIRECTORY_BINDING")
    _need(not destination.exists() and not destination.is_symlink(), "FRESH_REGISTRATION_DIRECTORY_REQUIRED")
    source = snapshot_source(project)
    _need(source["dirty"] is False, "REGISTRATION_REQUIRES_CLEAN_FROZEN_SOURCE")
    _require_code_source(project, source)
    _fresh_outputs(project, value)
    baseline_binding = value.get("baselineSource")
    _need(isinstance(baseline_binding, dict) and isinstance(baseline_binding.get("report"), str) and
          all(isinstance(baseline_binding.get(key), str) and re.fullmatch(r"[0-9a-f]{64}", baseline_binding[key])
              for key in ("registrationSha256", "ledgerSha256")) and
          isinstance(baseline_binding.get("sourceHead"), str) and
          re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", baseline_binding["sourceHead"]),
          "SIGNED_BASELINE_BINDING_REQUIRED")
    baseline_directory = _project_path(project, baseline_binding["report"])
    baseline, baseline_bytes = _read(baseline_directory / "registration.json")
    baseline_ledger, ledger_bytes = _read(baseline_directory / "run-ledger.json")
    _need(_sha(baseline_bytes) == baseline_binding["registrationSha256"], "SIGNED_BASELINE_REGISTRATION_SHA256_MISMATCH")
    _need(_sha(ledger_bytes) == baseline_binding["ledgerSha256"], "SIGNED_BASELINE_LEDGER_SHA256_MISMATCH")
    _need(baseline.get("sourceHead") == baseline_binding["sourceHead"] and
          baseline_ledger.get("sourceHead") == baseline_binding["sourceHead"], "SIGNED_BASELINE_SOURCE_HEAD_MISMATCH")
    _need(baseline_ledger.get("passed") is True, "SIGNED_BASELINE_NOT_PASSED")
    baseline, baseline_metadata = load_signed_baseline(project, baseline_directory)
    protected = protected_data_snapshot(project)
    _need(isinstance(baseline.get("protectedTrackedData"), dict) and protected == baseline["protectedTrackedData"],
          "PROTECTED_DATA_METADATA_CHANGED")
    manifest, local_summary = _local_prerequisites(project, package, value, source)
    audit = _audit_sources(project, baseline, source, value)
    identity_diff = compare_manifests(signed_baseline(baseline), manifest)
    _protect_runtime_deletions(audit, identity_diff, signed_baseline(baseline), manifest, value)
    require_confirmed_audit(audit)
    effective = _expectations(value, manifest, baseline)
    historical = _historical_snapshot(project, baseline_directory, baseline, value)
    effective["historicalEvidence"] = historical
    effective["protectedTrackedData"] = protected
    pointer, pointer_bytes = _default_pointer(project)
    source_hashes = {entry["path"]: entry["sha256"] for entry in source["files"]}
    for stale_key in ("runnerSha256", "runnerDerivation", "verifierHashes", "preparationHashes", "preparationAuthoringFiles",
                      "draftDirtyPaths", "observedHeadDuringPreparation", "createdLocal", "baseHead", "sourceBaseHead",
                      "latestDocumentationHashes", "unexecutedChecks", "runnerRehearsal", "approval", "state"):
        effective.pop(stale_key, None)
    effective.update(schema=CONFIG_SCHEMA, registrationId=registration_id, sourceHead=source["head"],
                     sourceTreeHash=source["treeHash"], toolCommit=source["head"],
                     sourceHashes=source_hashes, defaultPointer=pointer, createdUtc=now(),
                     kind=effective["runKind"] + ": repository shared engine registration",
                     nodeIdentityReport="node-identities.jsonl")
    for field, filename, document in (("sourceHashManifest", "source-hashes.json", source_hashes),
                                      ("historicalEvidenceManifest", "historical-evidence.json", historical),
                                      ("unitExpectationManifest", "expected-identities.json", manifest),
                                      ("protectedTrackedDataManifest", "protected-tracked-data.json", protected)):
        payload = _bytes(document)
        effective[field] = {"path": str((destination / filename).relative_to(project)),
                            "sha256": _sha(payload), "bytes": len(payload)}
    contract = registration_contract(effective, manifest, identity_diff, audit, local_summary, historical,
                                     code_tree_hash=source.get("codeTreeHash"))
    contract_digest = contract_sha256(contract)
    effective["contractSha256"] = contract_digest
    if "codeTreeHash" in source:
        effective["codeTreeHash"] = source["codeTreeHash"]
    config_bytes = _bytes(effective)
    registration = {"schema": SCHEMA, "registrationId": registration_id, "package": package,
                    "createdUtc": now(), "state": "frozen-awaiting-explicit-run-approval",
                    "interpreter": interpreter,
                    "runKind": effective["runKind"], "toolCommit": source["head"],
                    "configSha256": _sha(config_bytes), "contractSha256": contract_digest, "sourceHead": source["head"], "sourceTreeHash": source["treeHash"],
                    "baseline": {"directory": str(baseline_directory.relative_to(project)),
                                 "sourceHead": baseline["sourceHead"], "registrationSha256": _sha(baseline_bytes), "ledgerSha256": _sha(ledger_bytes),
                                 "schema": baseline_metadata["schema"], "format": baseline_metadata["_verification"]["format"]},
                    "sequence": effective["sequence"], "budgets": effective["budgets"], "timeoutsSeconds": effective["timeoutsSeconds"],
                    "candidateName": effective["candidateName"], "candidateDirectory": effective["candidateDirectory"],
                    "cmakeDirectory": effective["cmakeDirectory"], "adoptCandidate": effective.get("adoptCandidate") is True,
                    "localPrerequisiteSourceLinks": local_summary["sourceLinks"],
                    "defaultPointer": pointer,
                    "artifacts": {"contract.json": contract_digest, "config.json": _sha(config_bytes), "source-snapshot.json": _sha(_bytes(source)),
                                  "expected-identities.json": _sha(_bytes(manifest)), "test-change-audit.json": _sha(_bytes(audit)),
                                  "identity-diff.json": _sha(_bytes(identity_diff)), "local-prerequisites.json": _sha(_bytes(local_summary)),
                                  "historical-evidence.json": _sha(_bytes(historical)),
                                  "source-hashes.json": _sha(_bytes(source_hashes)),
                                  "protected-tracked-data.json": _sha(_bytes(protected))}}
    if "memoryActionContract" in effective:
        registration["memoryActionContract"] = effective["memoryActionContract"]
    if "cardExportContract" in effective:
        registration["cardExportContract"] = effective["cardExportContract"]
    if "cardEditContract" in effective:
        registration["cardEditContract"] = effective["cardEditContract"]
    if "previewWorkspaceContract" in effective:
        registration["previewWorkspaceContract"] = effective["previewWorkspaceContract"]
    if effective.get("previewWorkspaceContract") in ("v3", "v4"):
        registration["previewWorkspaceChecks"] = deepcopy(effective["previewWorkspaceChecks"])
    if effective.get("previewWorkspaceContract") == "v4":
        registration["previewUpgradeBaseline"] = deepcopy(effective["previewUpgradeBaseline"])
    if pointer_bytes is not None:
        registration["artifacts"]["frozen-default-pointer.json"] = _sha(pointer_bytes)
    if "codeTreeHash" in source:
        registration["codeTreeHash"] = source["codeTreeHash"]
    documents = {"config.json": effective, "source-snapshot.json": source, "expected-identities.json": manifest,
                 "test-change-audit.json": audit, "identity-diff.json": identity_diff, "local-prerequisites.json": local_summary,
                 "historical-evidence.json": historical, "source-hashes.json": source_hashes,
                 "protected-tracked-data.json": protected, "contract.json": contract}
    # Preparation can parse substantial historical inputs. Recheck every live
    # binding before either caller creates its destination.
    assert_frozen(project, source)
    _verify_default_pointer(project, pointer)
    _need(protected_data_snapshot(project) == protected, "PROTECTED_DATA_METADATA_CHANGED")
    _historical_unchanged(project, historical)
    for reference in local_summary["bindings"]:
        _checked_reference(project, reference)
    _fresh_outputs(project, effective)
    lock.verify()
    return {"destination": destination, "registration": registration, "documents": documents,
            "pointerBytes": pointer_bytes}


def _publish_prepared(destination: Path, prepared: Mapping[str, Any]) -> None:
    ensure_directory(destination.parent)
    destination.mkdir(mode=0o700)
    canonical_directory(destination)
    for name, data in prepared["documents"].items():
        exclusive_json(destination / name, data)
    if prepared["pointerBytes"] is not None:
        with (destination / "frozen-default-pointer.json").open("xb") as stream:
            stream.write(prepared["pointerBytes"])
            stream.flush()
            os.fsync(stream.fileno())
    exclusive_json(destination / "registration.json", prepared["registration"])


def freeze(root: str | Path, package: str, config: Mapping[str, Any], report_dir: str | Path,
           expected_contract_sha256: str | None = None) -> dict:
    project = Path(root).resolve(strict=True)
    with ExecutionLock(project) as lock:
        prepared = _prepare_registration(project, package, config, report_dir, lock)
        registration = prepared["registration"]
        if expected_contract_sha256 is not None:
            _need(isinstance(expected_contract_sha256, str) and
                  re.fullmatch(r"[0-9a-f]{64}", expected_contract_sha256), "EXPECTED_CONTRACT_SHA256_INVALID")
            if registration["contractSha256"] != expected_contract_sha256:
                mismatch = _rehearsal_interpreter_mismatch(project, package, expected_contract_sha256,
                                                          registration["interpreter"])
                if mismatch is not None:
                    raise RegistrationError("REHEARSAL_INTERPRETER_MISMATCH:" + _bytes({**mismatch,
                        "expectedContractSha256": expected_contract_sha256,
                        "currentContractSha256": registration["contractSha256"]}).decode().strip())
                raise RegistrationError("REGISTRATION_CONTRACT_SHA256_MISMATCH")
        destination = prepared["destination"]
        _publish_prepared(destination, prepared)
        RegistrationState(project, lock).freeze(registration["registrationId"], {
            "reportDirectory": str(destination.relative_to(project)),
            "registrationSha256": _sha((destination / "registration.json").read_bytes()),
            "configSha256": registration["configSha256"], "contractSha256": registration["contractSha256"],
            "sourceTreeHash": registration["sourceTreeHash"], "codeTreeHash": registration.get("codeTreeHash"),
            "toolCommit": registration["toolCommit"]})
        return registration


def rehearsal(root: str | Path, package: str, config: Mapping[str, Any], report_dir: str | Path,
              output_dir: str | Path) -> dict:
    """Save all proposed freeze materials under a fresh local package child.

    No registration report directory or active-registration marker is created.
    This operation supplies no approval to run a registered batch.
    """
    project = Path(root).resolve(strict=True)
    package_name(package)
    with ExecutionLock(project) as lock:
        output = _project_path(project, output_dir)
        _need(output.parent == project / ".tools/local" / package, "REHEARSAL_LOCAL_PACKAGE_DIRECTORY_REQUIRED")
        package_name(output.name)
        _need(not output.exists() and not output.is_symlink(), "FRESH_REHEARSAL_DIRECTORY_REQUIRED")
        prepared = _prepare_registration(project, package, config, report_dir, lock)
        _publish_prepared(output, prepared)
        registration = prepared["registration"]
        result = {"schema": REHEARSAL_SCHEMA, "package": package,
                  "registrationId": registration["registrationId"], "createdUtc": now(),
                  "interpreter": deepcopy(registration["interpreter"]),
                  "contractSha256": registration["contractSha256"],
                  "proposedReportDirectory": str(prepared["destination"].relative_to(project)),
                  "outputDirectory": str(output.relative_to(project)),
                  "registrationCreated": False, "activeMarkerCreated": False,
                  "sourceHead": registration["sourceHead"], "sourceTreeHash": registration["sourceTreeHash"],
                  "codeTreeHash": registration.get("codeTreeHash"),
                  "localRunSequences": prepared["documents"]["contract.json"]["localRunSequences"],
                  "expectedUnitCounts": prepared["documents"]["config.json"].get("expectedUnitCounts", {})}
        exclusive_json(output / "rehearsal.json", result)
        return result


freeze_registration = freeze
rehearse_registration = rehearsal


def _load_frozen(root: Path, report_dir: str | Path, state: RegistrationState) -> tuple[Path, dict, dict, dict, dict]:
    directory = _project_path(root, report_dir)
    registration, payload = _read(directory / "registration.json")
    _need(registration.get("schema") == SCHEMA, "UNSUPPORTED_REGISTRATION_SCHEMA")
    marker = state.require(registration["registrationId"])
    metadata = marker.get("metadata", {})
    _need(metadata.get("reportDirectory") == str(directory.relative_to(root)) and
          metadata.get("registrationSha256") == _sha(payload), "REGISTRATION_ACTIVE_MARKER_HASH_MISMATCH")
    data = {}
    for name, expected in registration["artifacts"].items():
        _need(Path(name).name == name, "REGISTRATION_ARTIFACT_PATH_INVALID")
        value, raw = _read(directory / name)
        _need(_sha(raw) == expected, "REGISTRATION_FROZEN_ARTIFACT_CHANGED:" + name)
        data[name] = value
    for reference in data["local-prerequisites.json"]["bindings"]:
        _checked_reference(root, reference)
    _need(data["config.json"]["protectedTrackedData"] == data["protected-tracked-data.json"],
          "REGISTRATION_PROTECTED_MANIFEST_BINDING_CHANGED")
    _need(_sha((directory / "config.json").read_bytes()) == registration["configSha256"], "REGISTRATION_CONFIG_HASH_CHANGED")
    return directory, registration, data["config.json"], data["source-snapshot.json"], data["expected-identities.json"]


def authorize_registration(root: str | Path, report_dir: str | Path, user_approval_text: str) -> dict:
    """Persist a caller-supplied explicit approval once; never infer approval."""
    _need(isinstance(user_approval_text, str) and bool(user_approval_text.strip()), "EXPLICIT_REGISTRATION_APPROVAL_REQUIRED")
    project = Path(root).resolve(strict=True)
    with ExecutionLock(project) as lock:
        state = RegistrationState(project, lock)
        directory, registration, _, source, _ = _load_frozen(project, report_dir, state)
        _require_registration_interpreter(registration)
        assert_frozen(project, source)
        _need(not (directory / "run-claim.json").exists() and not (directory / "void.json").exists(), "REGISTRATION_ALREADY_CONSUMED")
        value = {"schema": AUTH_SCHEMA, "registrationId": registration["registrationId"], "approved": True,
                 "approvedUtc": now(), "userApprovalText": user_approval_text,
                 "registrationSha256": _sha((directory / "registration.json").read_bytes()),
                 **{key: registration[key] for key in ("configSha256", "toolCommit", "sourceHead", "sourceTreeHash")}}
        exclusive_json(directory / "authorization.json", value)
        return value


def _authorization(directory: Path, registration: Mapping[str, Any], expected_bytes: bytes | None = None) -> tuple[dict, bytes]:
    value, payload = _read(directory / "authorization.json")
    _need(expected_bytes is None or payload == expected_bytes, "REGISTERED_AUTHORIZATION_BYTES_CHANGED")
    _need(value.get("schema") == AUTH_SCHEMA and value.get("approved") is True and
          isinstance(value.get("userApprovalText"), str) and bool(value["userApprovalText"].strip()) and
          bool(value.get("approvedUtc")), "REGISTERED_EXPLICIT_APPROVAL_REQUIRED")
    binding = {"registrationId": registration["registrationId"], "registrationSha256": _sha((directory / "registration.json").read_bytes()),
               **{key: registration[key] for key in ("configSha256", "toolCommit", "sourceHead", "sourceTreeHash")}}
    _need(all(value.get(key) == expected for key, expected in binding.items()), "REGISTERED_APPROVAL_BINDING_MISMATCH")
    return value, payload


def _registration_cleanup_confirmed(engine, isolation, *, attempt_claimed: bool, engine_returned: bool,
                                    completion_recorded: bool) -> bool:
    if not attempt_claimed or not completion_recorded:
        return False  # An existing claim may belong to a crashed, live batch.
    if engine is None or engine.ledger is None:
        return isolation is None or isolation.removed  # Pure prelaunch failure.
    if not engine_returned:
        return False  # Includes failure to durably publish the final ledger.
    ledger = engine.ledger
    runs = ledger.get("runs")
    return (type(ledger.get("ownedProcessesRemaining")) is int and ledger["ownedProcessesRemaining"] == 0 and
            ledger.get("unitScratchRemoved") is True and isinstance(runs, list) and
            all(row.get("processGroupGone") is True for row in runs
                if row.get("spawnAttempted") or row.get("ownedProcessGroup") is not None))


def run_registered(root: str | Path, report_dir: str | Path) -> dict:
    from .engine import Engine
    from .stages import load_runtime_config, plan
    from .state import LocalRunState
    project = Path(root).resolve(strict=True)
    with ExecutionLock(project) as lock:
        LocalRunState(project, lock).assert_no_active()
        state = RegistrationState(project, lock)
        directory = _project_path(project, report_dir)
        marker = state.active()
        _need(marker is not None and marker.get("metadata", {}).get("reportDirectory") == str(directory.relative_to(project)),
              "REGISTRATION_ACTIVE_REPORT_BINDING_MISMATCH")
        registration_id = marker["registrationId"]
        registration = {"registrationId": registration_id, "sourceHead": None, "runKind": None}
        engine, isolation = None, None
        attempt_claimed, engine_returned, completion_recorded = False, False, False
        try:
            _need(not (directory / "run-ledger.json").exists() and not (directory / "void.json").exists(), "REGISTRATION_ALREADY_CONSUMED")
            # An exclusive durable claim consumes the attempt before any source,
            # approval or artifact check. No failed state can later be retried.
            exclusive_json(directory / "run-claim.json", {"registrationId": registration_id, "startedUtc": now(),
                "configSha256": marker["metadata"].get("configSha256"), "ownerToken": lock.owner})
            attempt_claimed = True
            directory, registration, config, source, expected = _load_frozen(project, directory, state)
            _require_registration_interpreter(registration)
            _, approval_bytes = _authorization(directory, registration)
            assert_frozen(project, source)
            _verify_default_pointer(project, config["defaultPointer"])
            _fresh_outputs(project, config)
            _validated_config(project, config)
            require_confirmed_audit(_read(directory / "test-change-audit.json")[0])
            isolation = IsolationContext.create(project)
            stages = plan(project, directory, config, isolation.env, "registered", None)
            runtime = load_runtime_config(directory)
            runtime_bytes = _read(directory / "runtime-config.json")[1]
            runtime_sha256 = _sha(runtime_bytes)
            def verify_bindings(label, ledger, *, adopted_pointer=None):
                _load_frozen(project, directory, state)
                _require_registration_interpreter(registration)
                _authorization(directory, registration, approval_bytes)
                _need(_read(directory / "runtime-config.json")[1] == runtime_bytes,
                      "REGISTERED_RUNTIME_CONFIG_BYTES_CHANGED")
                assert_frozen(project, source)
                observed_protected = protected_data_snapshot(project)
                _need(observed_protected == config["protectedTrackedData"], "PROTECTED_DATA_METADATA_CHANGED")
                if adopted_pointer is None:
                    _verify_default_pointer(project, config["defaultPointer"])
                else:
                    _, actual_pointer = _default_pointer(project)
                    _need(actual_pointer == adopted_pointer, "REGISTERED_ADOPTED_POINTER_BYTES_CHANGED")
                baseline = registration["baseline"]
                baseline_directory = _project_path(project, baseline["directory"])
                _need(_sha(_read(baseline_directory / "registration.json")[1]) == baseline["registrationSha256"] and
                      _sha(_read(baseline_directory / "run-ledger.json")[1]) == baseline["ledgerSha256"], "SIGNED_BASELINE_BINDINGS_CHANGED")
                historical_count = _historical_unchanged(project, config["historicalEvidence"])
                ledger.update(sourceHead=source["head"], sourceTreeHash=source["treeHash"],
                              toolCommit=registration["toolCommit"], configSha256=registration["configSha256"],
                              authorizationSha256=_sha(approval_bytes), sourceUnchanged=True,
                              historicalBaselineBindingsUnchanged=True, historicalEvidenceUnchanged=True,
                              historicalEvidenceFiles=historical_count, runtimeConfigSha256=runtime_sha256,
                              protectedDataMetadataUnchanged=True, protectedTrackedDataFiles=len(observed_protected))
                ledger.setdefault("bindingChecks", []).append({"label": label, "at": now(),
                    "protectedDataMetadataUnchanged": True, "verifiedManifests": ["sourceHashManifest",
                        "protectedTrackedDataManifest", "historicalEvidenceManifest", "unitExpectationManifest"]})
            def frozen(label, ledger):
                verify_bindings(label, ledger)
            def finalize(instance):
                actual = collect_saved_outputs(directory, runtime, project)
                require_actual_collection(actual)
                require_all_passed(actual)
                difference = compare_manifests(expected, actual)
                _need(difference["identitiesMatch"] and not difference["statusChanges"], "REGISTERED_ACTUAL_IDENTITIES_CHANGED")
                exclusive_json(directory / "actual-identities.json", actual)
                return {"identityManifest": {"path": str((directory / "actual-identities.json").relative_to(project)),
                                              "sha256": _sha((directory / "actual-identities.json").read_bytes())},
                        "identityMultiplicitiesMatch": True}
            def adoption(instance):
                frozen("before-adoption", instance.ledger)
                _need(instance.ledger.get("unitScratchRemoved") is True and
                      instance.ledger.get("ownedProcessesRemaining") == 0, "REGISTERED_ADOPTION_REQUIRES_CLEANUP")
                _need(isinstance(instance.captured_pointer, bytes), "REGISTERED_CAPTURED_POINTER_REQUIRED")
                pointer = load_json_bytes(instance.captured_pointer)
                candidate = _project_path(project, config["candidateDirectory"])
                manifest_path = candidate / "build.json"
                regular_file(manifest_path)
                _need(isinstance(pointer, dict) and pointer.get("directory") == str(candidate) and
                      pointer.get("buildManifestSha256") == _sha(manifest_path.read_bytes()), "REGISTERED_ADOPTION_CANDIDATE_BINDING")
                with (directory / "sdk-default-pointer.json").open("xb") as stream:
                    stream.write(instance.captured_pointer)
                    stream.flush()
                    os.fsync(stream.fileno())
                return instance.captured_pointer
            def post_adopt(instance):
                verify_bindings("at-end", instance.ledger, adopted_pointer=instance.captured_pointer)
                instance.ledger["postAdoptionBindingsVerified"] = True
            engine = Engine(project, directory, kind=registration["runKind"], limits=config["budgets"],
                            frozen=frozen, environment=isolation.env, isolation=isolation, lock=lock,
                            registration_id=registration_id)
            result = engine.run(stages, finalize=finalize,
                                adopt=adoption if registration["runKind"] == "formal" and registration["adoptCandidate"] else None,
                                post_adopt=post_adopt if registration["runKind"] == "formal" and registration["adoptCandidate"] else None)
            engine_returned = True
            completion_recorded = True
            return result
        except BaseException as error:
            if not (directory / "run-ledger.json").exists():
                exclusive_json(directory / "run-ledger.json", {"schema": "reverie.shared-run.ledger.v1", "registrationId": registration_id,
                    "sourceHead": registration["sourceHead"], "kind": registration["runKind"], "startedUtc": now(), "endedUtc": now(),
                    "passed": False, "runs": [], "used": {}, "frozenChecks": [], "stopReason": str(error) or type(error).__name__,
                    "error": str(error) or type(error).__name__, "ownedProcessesRemaining": 0})
                completion_recorded = True
            raise
        finally:
            try:
                if isolation is not None and not isolation.removed and (engine is None or engine.ledger is None):
                    isolation.cleanup()
            finally:
                # Never discover/alter old registrations or another marker.
                marker = state.active()
                if (marker and marker.get("registrationId") == registration_id and
                        _registration_cleanup_confirmed(engine, isolation, attempt_claimed=attempt_claimed,
                                                        engine_returned=engine_returned, completion_recorded=completion_recorded)):
                    state.finish(registration_id)


def void_registration(root: str | Path, registration_id: str, reason: str) -> dict:
    _need(isinstance(reason, str) and bool(reason.strip()), "REGISTRATION_VOID_REASON_REQUIRED")
    project = Path(root).resolve(strict=True)
    package_name(registration_id)
    with ExecutionLock(project) as lock:
        state = RegistrationState(project, lock)
        marker = state.require(registration_id)
        directory = _project_path(project, marker.get("metadata", {}).get("reportDirectory", ""))
        _, registration, _, _, _ = _load_frozen(project, directory, state)
        _need(not (directory / "run-claim.json").exists(), "RUNNING_OR_CONSUMED_REGISTRATION_CANNOT_BE_VOIDED")
        value = {"schema": "reverie.registered-run.void.v1", "registrationId": registration_id,
                 "voidedUtc": now(), "reason": reason, "registrationSha256": _sha((directory / "registration.json").read_bytes())}
        exclusive_json(directory / "void.json", value)
        state.finish(registration["registrationId"])
        return value
