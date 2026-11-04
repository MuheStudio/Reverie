"""Strict saved-only W2 additions; the W1 five-check reader stays unchanged.

No function in this module probes a workspace, starts a process, or reads a
keychain. Snapshot bytes and the diagnostics document are bound observations.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import PurePosixPath
import re

from . import preview as base


VERSION = "v3"
ADDITIONS = (("version-snapshot", "versionSnapshot"), ("sanitized-diagnostics", "diagnostics"))
CHECKS = (*base.CHECKS, *ADDITIONS)
MAX_ENTRIES = 50_000
MAX_SAFE_INTEGER = 2**53 - 1
READY_CANDIDATE_SCHEMA = "reverie.preview.ready-candidate.v1"
SNAPSHOT_SCHEMA = "reverie.preview.snapshot.v1"
DIAGNOSTICS_SCHEMA = "reverie.qt.preview-diagnostics.v1"
DIRECTORIES = ("data", "avatars", "qml-cache", "logs", "snapshots")
STATUSES = ("ok", "missing", "unsafe", "limit", "changed")
EVENT_NAMES = ("startup", "snapshot_skipped", "snapshot_created", "snapshot_reused", "snapshot_failed",
               "snapshot_warning", "keychain_read_started", "keychain_ready", "backend_starting", "ready",
               "startup_failed", "backend_exit", "restore_state", "service_failure", "exit")
EVENT_CODES = ("OK", "UNKNOWN", "FIRST_LAUNCH", "UNCHANGED", "CREATED", "REUSED", "UNMANAGED",
               "INVALID_SNAPSHOT", "KEYCHAIN_UNAVAILABLE", "KEYCHAIN_KEY_INVALID", "PREVIEW_SNAPSHOT_FAILED",
               "PREVIEW_READY_RECORD_FAILED", "KEY_MISSING_EXISTING_DATABASE", "CLEAN", "RECOVERY_REQUIRED", "READ_ONLY",
               "PROVIDER_UNAUTHORIZED", "PROVIDER_AUTH_FAILED", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT",
               "PROVIDER_UNREACHABLE", "PROVIDER_CONNECTION_FAILED", "PROVIDER_INVALID_RESPONSE",
               "PROVIDER_INVALID_RESPONSE_SCHEMA", "PROVIDER_EMPTY_RESPONSE", "PROVIDER_REASONING_ONLY_RESPONSE",
               "PROVIDER_OUTPUT_TRUNCATED", "PROVIDER_CONTENT_FILTERED", "PROVIDER_TOOL_ONLY_RESPONSE",
               "PROVIDER_REJECTED", "PROVIDER_FAILURE")


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _count(value, code):
    base.need(base._integer(value) and value <= MAX_SAFE_INTEGER, code)


def _decimal(value, code):
    base.need(isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]{0,15}", value) is not None and
              int(value) <= MAX_SAFE_INTEGER, code)
    return int(value)


def identity(value):
    base._keys(value, ("candidate", "sourceHead", "buildManifestSha256"), "PREVIEW_V3_IDENTITY_FIELDS")
    base.need(isinstance(value["candidate"], str) and
              re.fullmatch(r"[A-Za-z0-9._-]{1,128}", value["candidate"]) is not None and
              value["candidate"] not in (".", "..") and
              base._sha(value["sourceHead"], 40) and base._sha(value["buildManifestSha256"]),
              "PREVIEW_V3_IDENTITY")
    return value


def ready_candidate(value):
    base._keys(value, ("schema", "readyId", "candidate", "sourceHead", "buildManifestSha256"),
               "PREVIEW_V3_READY_CANDIDATE_FIELDS")
    base.need(value["schema"] == READY_CANDIDATE_SCHEMA and base._sha(value["readyId"], 32),
              "PREVIEW_V3_READY_CANDIDATE")
    return identity({key: value[key] for key in ("candidate", "sourceHead", "buildManifestSha256")})


def _snapshot_path(value, directory=False):
    base.need(isinstance(value, str) and 0 < len(value) <= 1024 and
              re.search(r"[\x00\\]", value) is None, "PREVIEW_V3_SNAPSHOT_PATH")
    parts = value.split("/")
    base.need(parts[0] in ("data", "avatars") and (directory or len(parts) > 1) and
              all(part not in ("", ".", "..") for part in parts) and
              value != "data/cache" and not value.startswith("data/cache/"), "PREVIEW_V3_SNAPSHOT_PATH")


def inventory(value):
    base._keys(value, ("files", "directories", "totalBytes"), "PREVIEW_V3_INVENTORY_FIELDS")
    files, directories = value["files"], value["directories"]
    base.need(isinstance(files, list) and isinstance(directories, list) and
              len(files) + len(directories) <= MAX_ENTRIES, "PREVIEW_V3_INVENTORY_LIMIT")
    directory_set = set()
    for entry in directories:
        _snapshot_path(entry, True)
        base.need(entry not in directory_set, "PREVIEW_V3_DUPLICATE_SNAPSHOT_PATH")
        directory_set.add(entry)
    base.need({"data", "avatars"} <= directory_set and all("/" not in entry or
              str(PurePosixPath(entry).parent) in directory_set for entry in directory_set),
              "PREVIEW_V3_SNAPSHOT_DIRECTORIES")
    file_map, total = {}, 0
    for entry in files:
        base._keys(entry, ("path", "size", "sha256"), "PREVIEW_V3_SNAPSHOT_FILE_FIELDS")
        _snapshot_path(entry["path"])
        base.need(entry["path"] not in file_map and entry["path"] not in directory_set and
                  str(PurePosixPath(entry["path"]).parent) in directory_set and base._sha(entry["sha256"]),
                  "PREVIEW_V3_SNAPSHOT_FILE")
        total += _decimal(entry["size"], "PREVIEW_V3_SNAPSHOT_SIZE")
        base.need(total <= MAX_SAFE_INTEGER, "PREVIEW_V3_SNAPSHOT_SIZE")
        file_map[entry["path"]] = entry
    base.need(total == _decimal(value["totalBytes"], "PREVIEW_V3_SNAPSHOT_SIZE"), "PREVIEW_V3_SNAPSHOT_TOTAL")
    return {"files": sorted(files, key=lambda entry: entry["path"]),
            "directories": sorted(directory_set), "totalBytes": str(total)}


def snapshot(value, previous, current):
    base._keys(value, ("name", "manifestJson", "manifestSha256", "copiedInventory"), "PREVIEW_V3_SNAPSHOT_FIELDS")
    raw = value["manifestJson"]
    base.need(isinstance(raw, str) and len(raw.encode()) <= base.MAX_REPORT_BYTES and
              base._sha(value["manifestSha256"]) and hashlib.sha256(raw.encode()).hexdigest() ==
              value["manifestSha256"], "PREVIEW_V3_MANIFEST_BINDING")
    from .state import load_json_bytes
    manifest = load_json_bytes(raw.encode())
    base._keys(manifest, ("schema", "name", "createdAt", "fromReadyId", "from", "to", "transitionSha256",
                          "files", "directories", "totalBytes"), "PREVIEW_V3_MANIFEST_FIELDS")
    before_identity = ready_candidate(previous)
    identity(manifest["from"]); identity(manifest["to"])
    base.need(manifest["schema"] == SNAPSHOT_SCHEMA and manifest["fromReadyId"] == previous["readyId"] and
              manifest["from"] == before_identity and manifest["to"] == current and before_identity != current,
              "PREVIEW_V3_SNAPSHOT_TRANSITION")
    transition = hashlib.sha256(canonical_json({"fromReadyId": previous["readyId"],
                                              "from": before_identity, "to": current})).hexdigest()
    stamp = manifest["createdAt"]
    base.need(isinstance(stamp, str) and re.fullmatch(r"[0-9]{8}T[0-9]{9}Z", stamp) is not None,
              "PREVIEW_V3_SNAPSHOT_TIME")
    try:
        datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ")
    except ValueError as error:
        raise base.PreviewError("PREVIEW_V3_SNAPSHOT_TIME") from error
    prefix = (f"snapshot-{stamp}-{before_identity['candidate'][:32]}--{current['candidate'][:32]}-"
              f"{transition[:32]}-")
    name = value["name"]
    base.need(isinstance(name, str) and name == manifest["name"] and name.startswith(prefix) and
              re.fullmatch(r"[0-9a-f]{8}", name[len(prefix):]) is not None and
              manifest["transitionSha256"] == transition, "PREVIEW_V3_SNAPSHOT_NAME_OR_HASH")
    manifest_inventory = inventory({key: manifest[key] for key in ("files", "directories", "totalBytes")})
    base.need(manifest_inventory == inventory(value["copiedInventory"]), "PREVIEW_V3_SNAPSHOT_COPY_MISMATCH")
    return manifest_inventory


def _exit(value, start, code="PREVIEW_V3_NORMAL_EXIT"):
    base._keys(value, ("hostPid", "signal", "sentNs", "hostExitedNs", "hostExitCode", "allGoneNs",
                       "descendantPidsBefore", "remainingPids"), code + "_FIELDS")
    base.need(value["hostPid"] == start["ready"]["hostPid"] and value["signal"] == "SIGTERM" and
              type(value["hostExitCode"]) is int and value["hostExitCode"] == 0 and
              value["remainingPids"] == [] and start["readyNs"] <= value["sentNs"] and
              start["ready"]["backendPid"] in base._pids(value["descendantPidsBefore"]) and
              value["hostPid"] not in value["descendantPidsBefore"], code)
    base._duration(value["sentNs"], value["hostExitedNs"], base.LIMITS["normalMs"], code + "_DEADLINE")
    base._duration(value["sentNs"], value["allGoneNs"], base.LIMITS["normalMs"], code + "_DEADLINE")
    base.need(value["hostExitedNs"] <= value["allGoneNs"], code)


def event(value):
    base._keys(value, ("schema", "event", "hostPid", "sequence", "timeMs", "elapsedMs", "code", "value"),
               "PREVIEW_V3_EVENT_FIELDS")
    base.need(value["schema"] == "reverie.qt.preview-event.v1" and value["event"] in EVENT_NAMES and
              value["code"] in EVENT_CODES and base._integer(value["hostPid"], 1) and
              base._integer(value["sequence"], 1) and value["hostPid"] <= MAX_SAFE_INTEGER and
              value["sequence"] <= MAX_SAFE_INTEGER and type(value["value"]) is int and
              abs(value["value"]) <= MAX_SAFE_INTEGER, "PREVIEW_V3_EVENT_VALUE")
    _count(value["timeMs"], "PREVIEW_V3_EVENT_VALUE")
    _count(value["elapsedMs"], "PREVIEW_V3_EVENT_VALUE")
    base.need(value["event"] != "service_failure" or 0 <= value["value"] <= 9, "PREVIEW_V3_EVENT_VALUE")
    base.need(len(canonical_json(value)) <= 1024, "PREVIEW_V3_EVENT_LIMIT")
    return value


def verify_startup_events(value, start):
    base.need(isinstance(value, list) and 1 <= len(value) <= 128, "PREVIEW_V3_STARTUP_EVENT_LIMIT")
    rows = [event(row) for row in value]
    base.need(all(row["hostPid"] == start["ready"]["hostPid"] for row in rows) and
              [row["sequence"] for row in rows] == list(range(1, len(rows) + 1)) and
              all(left["elapsedMs"] <= right["elapsedMs"] for left, right in zip(rows, rows[1:])),
              "PREVIEW_V3_STARTUP_EVENT_BINDING")
    names = [row["event"] for row in rows]
    required = ("startup", "snapshot_created", "keychain_read_started", "keychain_ready", "backend_starting", "ready")
    base.need(all(names.count(name) == 1 for name in required) and names[0] == "startup" and names[-1] == "ready" and
              [names.index(name) for name in required] == sorted(names.index(name) for name in required) and
              not any(name in names for name in ("snapshot_reused", "snapshot_failed", "startup_failed", "exit")),
              "PREVIEW_V3_SNAPSHOT_NOT_BEFORE_KEYCHAIN_OR_BACKEND")
    base.need(rows[names.index("snapshot_created")]["code"] == "CREATED" and
              rows[-1]["code"] == "CLEAN", "PREVIEW_V3_SNAPSHOT_EVENT_RESULT")


def _no_absolute_paths(value):
    if isinstance(value, dict):
        for key, entry in value.items():
            _no_absolute_paths(key); _no_absolute_paths(entry)
    elif isinstance(value, list):
        for entry in value:
            _no_absolute_paths(entry)
    elif isinstance(value, str):
        base.need(not value.startswith(("/", "\\")) and re.match(r"[A-Za-z]:[/\\]", value) is None,
                  "PREVIEW_V3_DIAGNOSTICS_ABSOLUTE_PATH")


def diagnostics_document(value, current, expected_snapshot):
    _no_absolute_paths(value)
    base._keys(value, ("schema", "runtime", "system", "directories", "snapshots", "logs", "events"),
               "PREVIEW_V3_DIAGNOSTICS_FIELDS")
    base.need(value["schema"] == DIAGNOSTICS_SCHEMA, "PREVIEW_V3_DIAGNOSTICS_SCHEMA")
    base._keys(value["runtime"], ("candidate", "sourceShortHash", "runtimeDirectoryCheck"),
               "PREVIEW_V3_DIAGNOSTICS_RUNTIME_FIELDS")
    base.need(value["runtime"] == {"candidate": current["candidate"], "sourceShortHash": current["sourceHead"][:8],
                                    "runtimeDirectoryCheck": "verified"}, "PREVIEW_V3_DIAGNOSTICS_RUNTIME")
    system = value["system"]
    base._keys(system, ("macOSVersion", "architecture"), "PREVIEW_V3_DIAGNOSTICS_SYSTEM_FIELDS")
    base.need(isinstance(system["macOSVersion"], str) and (system["macOSVersion"] == "unknown" or
              re.fullmatch(r"[0-9]{1,3}(\.[0-9]{1,3}){1,2}", system["macOSVersion"]) is not None) and
              system["architecture"] in ("arm64", "x64", "unknown"), "PREVIEW_V3_DIAGNOSTICS_SYSTEM")
    directories = value["directories"]
    base.need(isinstance(directories, list) and len(directories) == len(DIRECTORIES),
              "PREVIEW_V3_DIAGNOSTICS_DIRECTORY_SET")
    for name, row in zip(DIRECTORIES, directories):
        base._keys(row, ("name", "exists", "bytes", "fileCount", "directoryCount", "skippedLinks", "status"),
                   "PREVIEW_V3_DIAGNOSTICS_DIRECTORY_FIELDS")
        base.need(row["name"] == name and row["exists"] is True and row["status"] == "ok" and
                  row["skippedLinks"] == 0, "PREVIEW_V3_DIAGNOSTICS_DIRECTORY")
        for key in ("bytes", "fileCount", "directoryCount", "skippedLinks"):
            _count(row[key], "PREVIEW_V3_DIAGNOSTICS_DIRECTORY")
    logs = value["logs"]
    base._keys(logs, ("fileCount", "bytes", "skippedLinks", "status"), "PREVIEW_V3_DIAGNOSTICS_LOG_FIELDS")
    logs_directory = next(row for row in directories if row["name"] == "logs")
    base.need(logs == {key: logs_directory[key] for key in ("fileCount", "bytes", "skippedLinks", "status")},
              "PREVIEW_V3_DIAGNOSTICS_LOG_MISMATCH")
    snapshots = value["snapshots"]
    base._keys(snapshots, ("entries", "unmanagedCount", "rejectedCount", "truncated", "status"),
               "PREVIEW_V3_DIAGNOSTICS_SNAPSHOT_FIELDS")
    base.need(snapshots["status"] == "ok" and snapshots["truncated"] is False and
              type(snapshots["unmanagedCount"]) is int and snapshots["unmanagedCount"] == 0 and
              type(snapshots["rejectedCount"]) is int and snapshots["rejectedCount"] == 0 and
              isinstance(snapshots["entries"], list) and len(snapshots["entries"]) == 1,
              "PREVIEW_V3_DIAGNOSTICS_SNAPSHOTS")
    row = snapshots["entries"][0]
    base._keys(row, ("name", "bytes", "fileCount", "checkStatus"), "PREVIEW_V3_DIAGNOSTICS_SNAPSHOT_ENTRY_FIELDS")
    source_inventory = inventory(expected_snapshot["copiedInventory"])
    base.need(row["name"] == expected_snapshot["name"] and row["checkStatus"] == "verified" and
              type(row["bytes"]) is int and row["bytes"] == int(source_inventory["totalBytes"]) and
              type(row["fileCount"]) is int and row["fileCount"] == len(source_inventory["files"]),
              "PREVIEW_V3_DIAGNOSTICS_SNAPSHOT_MISMATCH")
    events = value["events"]
    base._keys(events, ("entries", "rejectedRecords", "truncated", "status"), "PREVIEW_V3_DIAGNOSTICS_EVENT_FIELDS")
    base.need(events["status"] == "ok" and events["truncated"] is False and
              type(events["rejectedRecords"]) is int and events["rejectedRecords"] == 0 and
              isinstance(events["entries"], list) and 1 <= len(events["entries"]) <= 128,
              "PREVIEW_V3_DIAGNOSTICS_EVENTS")
    for row in events["entries"]:
        event(row)
    base.need(len({(row["hostPid"], row["sequence"]) for row in events["entries"]}) == len(events["entries"]),
              "PREVIEW_V3_DIAGNOSTICS_EVENT_DUPLICATE")
    return events["entries"]


def verify_diagnostics(value, current, expected_snapshot, start, same, final_exit, recorded_events):
    base._keys(value, ("exportJson", "sha256", "bytes", "outputMode", "exportedNs"),
               "PREVIEW_V3_DIAGNOSTICS_OBSERVATION_FIELDS")
    raw = value["exportJson"]
    base.need(isinstance(raw, str) and 0 < len(raw.encode()) <= base.MAX_REPORT_BYTES and
              base._sha(value["sha256"]) and hashlib.sha256(raw.encode()).hexdigest() == value["sha256"] and
              type(value["bytes"]) is int and value["bytes"] == len(raw.encode()) and
              type(value["outputMode"]) is int and value["outputMode"] == 0o600 and
              base._integer(value["exportedNs"]) and same["readyNs"] <= value["exportedNs"] <= final_exit["sentNs"],
              "PREVIEW_V3_DIAGNOSTICS_EXPORT_BINDING")
    from .state import load_json_bytes
    rows = diagnostics_document(load_json_bytes(raw.encode()), current, expected_snapshot)
    host_rows = [row for row in rows if row["hostPid"] == start["ready"]["hostPid"]]
    ready_indexes = [index for index, row in enumerate(host_rows) if row["event"] == "ready"]
    base.need(len(ready_indexes) == 1, "PREVIEW_V3_DIAGNOSTICS_STARTUP_EVENTS")
    startup_rows = host_rows[:ready_indexes[0] + 1]
    verify_startup_events(startup_rows, start)
    base.need(startup_rows == recorded_events, "PREVIEW_V3_DIAGNOSTICS_STARTUP_EVENTS")
    base.need(any(row["hostPid"] == same["ready"]["hostPid"] and row["event"] == "snapshot_skipped" and
                  row["code"] == "UNCHANGED" for row in rows) and
              any(row["hostPid"] == same["ready"]["hostPid"] and row["event"] == "ready" and row["code"] == "CLEAN"
                  for row in rows), "PREVIEW_V3_DIAGNOSTICS_SAME_CANDIDATE_EVENTS")


def verify_observations_v3(result, *, expected_source, expected_candidate, expected_build_sha,
                           isolation_root, expected_version=None):
    base.need(expected_version in (None, VERSION), "PREVIEW_SUMMARY_VERSION")
    required = {"schema", "contract", "passed", "checks", "observations", "cleanup", "observationBinding",
                "sourceHead", "candidate", "buildManifestSha256", "isolationRoot", "workspaceRelativePath",
                "runtimeRelativePath", "limits"}
    base.need(isinstance(result, dict) and set(result) in (required, required | {"error"}), "PREVIEW_SUMMARY_FIELDS")
    base.need(result["contract"] == VERSION and result["schema"] == "reverie.preview-workspace.smoke.v3",
              "PREVIEW_SUMMARY_SCHEMA")
    base.need(result["passed"] is True and result.get("error") in (None, ""), "PREVIEW_SMOKE_NOT_PASSED")
    expected_checks = [{"name": name, "passed": True, "observation": observation} for name, observation in CHECKS]
    base.need(result.get("checks") == expected_checks and all(type(row["passed"]) is bool
              for row in result["checks"]), "PREVIEW_ORDERED_CHECKS")
    observations = result.get("observations")
    base._keys(observations, (observation for _, observation in CHECKS), "PREVIEW_OBSERVATION_SET")
    added = observations["versionSnapshot"]
    base._keys(added, ("previousReady", "beforeInventory", "preparedNs", "snapshotNamesBefore", "start", "snapshot",
                       "readyRecord", "startupEvents", "recoveryExit", "sameCandidate",
                       "snapshotNamesAfterSame", "sameReadyRecord", "changedExit", "finalExit"),
               "PREVIEW_V3_VERSION_SNAPSHOT_FIELDS")
    current = {"candidate": expected_candidate, "sourceHead": expected_source,
               "buildManifestSha256": expected_build_sha}
    identity(current)
    base.need(added["snapshotNamesBefore"] == [], "PREVIEW_V3_PREEXISTING_SNAPSHOT")
    before = inventory(added["beforeInventory"])
    base.need(any(row["path"] == "data/runtime/kernel.sqlite3" for row in before["files"]),
              "PREVIEW_V3_PRELAUNCH_DATABASE_MISSING")
    base.need(before == snapshot(added["snapshot"], added["previousReady"], current),
              "PREVIEW_V3_PRELAUNCH_SNAPSHOT_MISMATCH")
    base.need(ready_candidate(added["readyRecord"]) == current and
              ready_candidate(added["sameReadyRecord"]) == current and
              added["sameReadyRecord"] == added["readyRecord"] and
              added["readyRecord"]["readyId"] != added["previousReady"]["readyId"],
              "PREVIEW_V3_CURRENT_CANDIDATE_NOT_RECORDED")
    base.need(added["snapshotNamesAfterSame"] == [added["snapshot"]["name"]],
              "PREVIEW_V3_SAME_CANDIDATE_SNAPSHOTTED")
    # Reuse the original five-check reader with an exact v2 projection. Its
    # timing, ordering, storage-attribute and teardown assertions are unchanged.
    projected = deepcopy(result)
    projected.update(schema="reverie.preview-workspace.smoke.v2", contract="v2",
                     checks=expected_checks[:len(base.CHECKS)],
                     observations={key: deepcopy(observations[key]) for _, key in base.CHECKS})
    recovery_exit = added["recoveryExit"]
    base._keys(recovery_exit, ("hostPid", "signal", "sentNs", "hostExitedNs", "hostExitCode", "allGoneNs",
                               "descendantPidsBefore", "remainingPids"), "PREVIEW_V3_NORMAL_EXIT_FIELDS")
    base._keys(projected["cleanup"], ("account", "workspaceRemoved", "runtimeRemoved", "remainingPids", "finalHostPid",
               "finalHostExitCode", "finalHostExitedNs", "finalAllGoneNs", "attributesAfter", "hostCleanup"),
               "PREVIEW_CLEANUP_FIELDS")
    projected["cleanup"].update(finalHostPid=recovery_exit.get("hostPid"),
        finalHostExitCode=recovery_exit.get("hostExitCode"), finalHostExitedNs=recovery_exit.get("hostExitedNs"),
        finalAllGoneNs=recovery_exit.get("allGoneNs"))
    proof = base._verify_lifecycle_observations(projected, expected_source=expected_source,
        expected_candidate=expected_candidate, expected_build_sha=expected_build_sha,
        isolation_root=isolation_root, expected_version="v2")
    metadata = {"workspaceId": proof["workspaceId"], "sourceHead": expected_source, "candidate": expected_candidate}
    start = base._start(added["start"], metadata, "restart", "v2")
    same = base._start(added["sameCandidate"], metadata, "restart", "v2")
    recovery = observations["forcedExit"]["recovery"]
    _exit(recovery_exit, recovery)
    _exit(added["changedExit"], start)
    _exit(added["finalExit"], same)
    base.need(base._integer(added["preparedNs"]) and recovery_exit["allGoneNs"] <= added["preparedNs"] <= start["startedNs"] and
              added["changedExit"]["allGoneNs"] <= same["startedNs"], "PREVIEW_V3_PHASE_ORDER")
    base.need(recovery["database"] == start["database"] == same["database"] and
              recovery["storageItem"] == start["storageItem"] == same["storageItem"],
              "PREVIEW_V3_STORAGE_CHANGED")
    all_pids = [*proof["hostPids"], *proof["backendPids"], proof["duplicateHostPid"], proof["hostCleanupPid"],
                start["ready"]["hostPid"], start["ready"]["backendPid"], same["ready"]["hostPid"], same["ready"]["backendPid"]]
    base.need(len(all_pids) == len(set(all_pids)), "PREVIEW_PROCESS_IDENTITIES_REUSED")
    cleanup = result["cleanup"]
    base.need(cleanup["finalHostPid"] == same["ready"]["hostPid"] and
              type(cleanup["finalHostExitCode"]) is int and cleanup["finalHostExitCode"] == 0 and
              base._integer(cleanup["finalHostExitedNs"]) and same["readyNs"] <= cleanup["finalHostExitedNs"],
              "PREVIEW_FINAL_HOST_EXIT")
    base._duration(cleanup["finalHostExitedNs"], cleanup["finalAllGoneNs"], base.LIMITS["normalMs"],
                   "PREVIEW_FINAL_CLEANUP_DEADLINE")
    base.need(cleanup["finalAllGoneNs"] <= cleanup["hostCleanup"]["startedNs"], "PREVIEW_HOST_CLEANUP_PHASE_ORDER")
    base.need(all(cleanup[field] == added["finalExit"][key] for field, key in (
        ("finalHostPid", "hostPid"), ("finalHostExitCode", "hostExitCode"),
        ("finalHostExitedNs", "hostExitedNs"), ("finalAllGoneNs", "allGoneNs"))), "PREVIEW_V3_FINAL_EXIT_BINDING")
    verify_startup_events(added["startupEvents"], start)
    verify_diagnostics(observations["diagnostics"], current, added["snapshot"], start, same, added["finalExit"],
                       added["startupEvents"])
    proof.update(schema="reverie.preview-workspace.proof.v3", contract=VERSION, checks=len(CHECKS),
                 checkNames=[name for name, _ in CHECKS], versionSnapshotVerified=True,
                 snapshotBeforeKeychainAndBackend=True, currentCandidateRecorded=True,
                 sameCandidateNoNewSnapshot=True, diagnosticsSanitized=True, diagnosticsWhileHostRunning=True,
                 snapshotName=added["snapshot"]["name"], snapshotManifestSha256=added["snapshot"]["manifestSha256"])
    proof["hostPids"] += [start["ready"]["hostPid"], same["ready"]["hostPid"]]
    proof["backendPids"] += [start["ready"]["backendPid"], same["ready"]["backendPid"]]
    proof["timingsMs"]["ready"] += [(entry["readyNs"] - entry["startedNs"]) / 1_000_000 for entry in (start, same)]
    return proof
