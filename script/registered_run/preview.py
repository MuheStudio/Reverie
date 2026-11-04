"""Explicit W1 preview contract; absent versions retain the seven old modes.

This consumer reads saved metadata only. It never starts an application, queries
a live PID/keychain, or probes a preview workspace while verifying or replaying.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from datetime import datetime


LEGACY_VERSION = "v1"
VERSION = CURRENT_VERSION = "v2"
SUPPORTED_VERSIONS = (LEGACY_VERSION, CURRENT_VERSION)
SCOPE_VERSION = "v3"
SUPPORTED_VERSIONS += (SCOPE_VERSION,)
UPGRADE_VERSION = "v4"
SUPPORTED_VERSIONS += (UPGRADE_VERSION,)
SCOPE_ADDITIONS = ("version-snapshot", "sanitized-diagnostics")
MODE = "preview"
STAGE = "preview-check"
BUDGET = "previewCheck"
OPTION = "--preview-workspace-smoke"
SCRIPT = "script/check_preview_workspace.py"
TIMEOUT_SECONDS = 600
SUMMARY_SCHEMA = "reverie.preview-workspace.smoke.v2"
OBSERVATION_SCHEMA = "reverie.preview-workspace.observations.v2"
PROOF_SCHEMA = "reverie.preview-workspace.proof.v2"
READY_SCHEMA = "reverie.qt.preview.ready.v1"
LIMITS = {"readyMs": 30000, "normalMs": 10000, "duplicateMs": 5000, "forcedMs": 10000}
LEGACY_MODES = ("injection", "regex", "entry", "persona", "candidate", "ordinary", "settings")
CHECKS = (
    ("first-start", "firstStart"),
    ("second-instance-rejected", "secondInstance"),
    ("sigterm-exit", "sigterm"),
    ("restart-same-storage", "restart"),
    ("forced-host-exit-and-lock-recovery", "forcedExit"),
)
MAX_REPORT_BYTES = 256 * 1024
MAX_PIDS = 64
STORAGE_SERVICE = "com.muhe.reverie.qt.preview.storage.v1"
CREDENTIALS_SERVICE = "com.muhe.reverie.qt.preview.credentials.v1"
ATTRIBUTE_ROLES = ("previewStorage", "previewCredentials", "testStorage", "testCredentials")


class PreviewError(ValueError):
    pass


def need(condition, code):
    if not condition:
        raise PreviewError(code)


def enabled(config):
    if "previewWorkspaceContract" not in config:
        return False
    need(config["previewWorkspaceContract"] in SUPPORTED_VERSIONS, "PREVIEW_CONTRACT_VERSION")
    return True


def require_current(config):
    need(enabled(config) and config["previewWorkspaceContract"] in (CURRENT_VERSION, SCOPE_VERSION, UPGRADE_VERSION),
         "PREVIEW_CURRENT_CONTRACT_REQUIRED")
    if config["previewWorkspaceContract"] == SCOPE_VERSION:
        need(config.get("previewWorkspaceChecks") == list(SCOPE_ADDITIONS), "PREVIEW_V3_CHECK_SELECTION")

    if config["previewWorkspaceContract"] == UPGRADE_VERSION:
        from . import preview_v4
        need(config.get("previewWorkspaceChecks") == list(preview_v4.SELECTION), "PREVIEW_V4_CHECK_SELECTION")
        preview_v4.previous_binding(config.get("previewUpgradeBaseline"))


def effective_modes(config, legacy=LEGACY_MODES):
    return (*legacy, MODE) if enabled(config) else tuple(legacy)


def stage_budgets(config, legacy):
    return {**legacy, **({STAGE: BUDGET} if enabled(config) else {})}


def stage_budget(stage, legacy):
    """Describe saved stages without upgrading a legacy default stage table."""
    return BUDGET if stage == STAGE else legacy[stage]


def validate_extension(config, legacy_stages):
    if not enabled(config):
        # Reserved preview selectors must never be silently ignored as legacy.
        rows = config.get("guiModes", [])
        sequence, modes = config.get("sequence"), config.get("requiredGuiModes")
        budgets, timeouts = config.get("budgets"), config.get("timeoutsSeconds")
        need(not (isinstance(sequence, list) and STAGE in sequence) and
             not (isinstance(modes, list) and MODE in modes) and
             not (isinstance(rows, list) and any(isinstance(row, dict) and row.get("stage") == STAGE for row in rows)) and
             not (isinstance(budgets, dict) and BUDGET in budgets) and
             not (isinstance(timeouts, dict) and STAGE in timeouts),
             "PREVIEW_CONTRACT_REQUIRED")
        return
    if config["previewWorkspaceContract"] == SCOPE_VERSION:
        need(config.get("previewWorkspaceChecks") == list(SCOPE_ADDITIONS), "PREVIEW_V3_CHECK_SELECTION")
    expected_timeout = TIMEOUT_SECONDS
    if config["previewWorkspaceContract"] == UPGRADE_VERSION:
        from . import preview_v4
        need(config.get("previewWorkspaceChecks") == list(preview_v4.SELECTION), "PREVIEW_V4_CHECK_SELECTION")
        preview_v4.previous_binding(config.get("previewUpgradeBaseline"))
        expected_timeout = preview_v4.TIMEOUT_SECONDS
    else:
        need("previewUpgradeBaseline" not in config, "PREVIEW_V4_INPUT_REQUIRES_V4")
    need(config.get("sequence") == [*legacy_stages, STAGE], "PREVIEW_STAGE_SEQUENCE")
    need(config.get("requiredGuiModes") == [*LEGACY_MODES, MODE], "PREVIEW_REQUIRED_MODES")
    rows = config.get("guiModes")
    need(isinstance(rows, list) and len(rows) == 8 and
         [row.get("stage") if isinstance(row, dict) else None for row in rows] ==
         [mode + "-check" for mode in (*LEGACY_MODES, MODE)], "PREVIEW_GUI_SEQUENCE")
    need(rows[-1] == {"stage": STAGE, "option": OPTION}, "PREVIEW_GUI_OPTION")
    need(config.get("budgets", {}).get(BUDGET) == 1 and
         type(config.get("budgets", {}).get(BUDGET)) is int, "PREVIEW_BUDGET")
    need(config.get("timeoutsSeconds", {}).get(STAGE) == expected_timeout and
         type(config.get("timeoutsSeconds", {}).get(STAGE)) is int, "PREVIEW_TIMEOUT")


def command(root, config, report_dir, isolation_root):
    result = [str(Path(root) / config["python"]), "-I", "-B", str(Path(root) / SCRIPT), OPTION,
            "--build-dir", str(Path(root) / config["candidateDirectory"]),
            "--report-dir", str(Path(report_dir) / STAGE),
            "--isolation-root", str(isolation_root)]
    if config.get("previewWorkspaceContract") == UPGRADE_VERSION:
        require_current(config)
        return result + ["--contract", UPGRADE_VERSION, "--previous-binding",
                         json.dumps(config["previewUpgradeBaseline"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)]
    return result + (["--contract", SCOPE_VERSION] if config.get("previewWorkspaceContract") == SCOPE_VERSION else [])


def _keys(value, keys, code):
    need(isinstance(value, dict) and set(value) == set(keys), code)


def _integer(value, minimum=0):
    return type(value) is int and value >= minimum


def _sha(value, width=64):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(width) + r"}", value) is not None


def _absolute(value):
    # Lexical checks only: a replay must never resolve/probe a workspace path.
    need(isinstance(value, str) and value and len(value) <= 4096 and
         not any(char in value for char in "\0\r\n\\"), "PREVIEW_ISOLATION_PATH")
    path = Path(value)
    need(path.is_absolute() and str(path) == value and os.path.abspath(value) == value,
         "PREVIEW_ISOLATION_PATH")
    return path


def _relative(value):
    need(isinstance(value, str) and 0 < len(value) <= 256 and
         not any(char in value for char in "\0\r\n\\"), "PREVIEW_RELATIVE_PATH")
    path = PurePosixPath(value)
    need(not path.is_absolute() and path.parts and ".." not in path.parts and
         path.as_posix() == value and value not in (".", ".."), "PREVIEW_RELATIVE_PATH")
    return path


def _pids(value):
    need(isinstance(value, list) and len(value) <= MAX_PIDS and
         all(_integer(pid, 1) for pid in value) and len(value) == len(set(value)), "PREVIEW_PID_LIST")
    return value


def _duration(start, end, limit_ms, code):
    need(_integer(start) and _integer(end) and end >= start and
         end - start <= limit_ms * 1_000_000, code)
    return (end - start) / 1_000_000


def _database(value):
    _keys(value, ("relativePath", "device", "inode"), "PREVIEW_DATABASE_FIELDS")
    need(value["relativePath"] == "data/runtime/kernel.sqlite3" and
         _integer(value["device"]) and _integer(value["inode"], 1), "PREVIEW_DATABASE_IDENTITY")
    return value


def _ready(value, metadata):
    _keys(value, ("schema", "hostPid", "backendPid", "workspaceId", "sourceHead", "candidate",
                  "recoveryState", "runtimeWritable"), "PREVIEW_READY_FIELDS")
    need(value["schema"] == READY_SCHEMA and _integer(value["hostPid"], 1) and
         _integer(value["backendPid"], 1) and value["hostPid"] != value["backendPid"], "PREVIEW_READY_PID")
    need(value["workspaceId"] == metadata["workspaceId"] and
         value["sourceHead"] == metadata["sourceHead"] and value["candidate"] == metadata["candidate"],
         "PREVIEW_READY_BUILD_OR_WORKSPACE")
    need(value["recoveryState"] == "clean" and value["runtimeWritable"] is True, "PREVIEW_READY_NOT_WRITABLE")
    return value


def _attributes_absent(value):
    _keys(value, ATTRIBUTE_ROLES, "PREVIEW_ATTRIBUTE_ROLES")
    need(all(value[role] is None for role in ATTRIBUTE_ROLES), "PREVIEW_ATTRIBUTES_NOT_ABSENT")


def _storage_item(value, workspace_id):
    _keys(value, ("service", "account", "creationTime", "modificationTime"), "PREVIEW_STORAGE_ATTRIBUTE_FIELDS")
    need(value["service"] == STORAGE_SERVICE and value["account"] == workspace_id,
         "PREVIEW_STORAGE_ATTRIBUTE_SCOPE")
    for field in ("creationTime", "modificationTime"):
        stamp = value[field]
        need(isinstance(stamp, str) and re.fullmatch(r"[0-9]{14}Z", stamp) is not None,
             "PREVIEW_STORAGE_ATTRIBUTE_DATE")
        try:
            datetime.strptime(stamp, "%Y%m%d%H%M%SZ")
        except ValueError as error:
            raise PreviewError("PREVIEW_STORAGE_ATTRIBUTE_DATE") from error
    return value


def _start(value, metadata, kind, version):
    if version == LEGACY_VERSION:
        extra = {"keyCreated"} if kind == "first" else {"keyUnchanged"}
    else:
        extra = {"storageItem", "attributesBefore"} if kind == "first" else {"storageItem"}
    if kind == "recovery":
        extra |= {"staleLockObserved", "lockRecovered"}
    _keys(value, {"startedNs", "readyNs", "ready", "database"} | extra, "PREVIEW_START_FIELDS")
    _duration(value["startedNs"], value["readyNs"], LIMITS["readyMs"], "PREVIEW_READY_DEADLINE")
    _ready(value["ready"], metadata)
    _database(value["database"])
    if version == LEGACY_VERSION:
        need(all(value[key] is True for key in extra), "PREVIEW_KEY_OR_LOCK_OBSERVATION")
    else:
        _storage_item(value["storageItem"], metadata["workspaceId"])
        if kind == "first":
            _attributes_absent(value["attributesBefore"])
        if kind == "recovery":
            need(value["staleLockObserved"] is True and value["lockRecovered"] is True,
                 "PREVIEW_KEY_OR_LOCK_OBSERVATION")
    return value


def _verify_lifecycle_observations(result, *, expected_source, expected_candidate, expected_build_sha, isolation_root,
                                   expected_version=None):
    """Recompute all five verdicts from independently bound raw observations."""
    metadata_keys = {"sourceHead", "candidate", "buildManifestSha256", "isolationRoot",
                     "workspaceRelativePath", "runtimeRelativePath", "limits"}
    required = {"schema", "contract", "passed", "checks", "observations", "cleanup", "observationBinding"} | metadata_keys
    need(isinstance(result, dict) and set(result) in (required, required | {"error"}), "PREVIEW_SUMMARY_FIELDS")
    version = result["contract"]
    need(version in SUPPORTED_VERSIONS and result["schema"] == "reverie.preview-workspace.smoke." + version,
         "PREVIEW_SUMMARY_SCHEMA")
    need(expected_version is None or version == expected_version, "PREVIEW_SUMMARY_VERSION")
    need(result["passed"] is True and result.get("error") in (None, ""), "PREVIEW_SMOKE_NOT_PASSED")
    need(_sha(result["sourceHead"], 40) and result["sourceHead"] == expected_source and
         result["candidate"] == expected_candidate and _sha(result["buildManifestSha256"]) and
         result["buildManifestSha256"] == expected_build_sha, "PREVIEW_BUILD_BINDING")
    root = _absolute(result["isolationRoot"])
    need(str(root) == str(isolation_root), "PREVIEW_ISOLATION_BINDING")
    workspace, runtime = _relative(result["workspaceRelativePath"]), _relative(result["runtimeRelativePath"])
    need(not workspace.is_relative_to(runtime) and not runtime.is_relative_to(workspace), "PREVIEW_RUNTIME_WORKSPACE_OVERLAP")
    workspace_id = hashlib.sha256(str(root / workspace).encode("utf-8")).hexdigest()
    metadata = {"workspaceId": workspace_id, "sourceHead": expected_source, "candidate": expected_candidate}
    need(result["limits"] == LIMITS and all(type(value) is int for value in result["limits"].values()), "PREVIEW_LIMITS")
    expected_checks = [{"name": name, "passed": True, "observation": observation} for name, observation in CHECKS]
    need(result["checks"] == expected_checks and all(type(row["passed"]) is bool for row in result["checks"]),
         "PREVIEW_ORDERED_CHECKS")
    observations = result["observations"]
    _keys(observations, (observation for _, observation in CHECKS), "PREVIEW_OBSERVATION_SET")
    first = _start(observations["firstStart"], metadata, "first", version)
    duplicate = observations["secondInstance"]
    _keys(duplicate, ("hostPid", "startedNs", "exitedNs", "exitCode", "readyEvents",
                      "backendPidsBefore", "backendPidsAfter"), "PREVIEW_DUPLICATE_FIELDS")
    duplicate_ms = _duration(duplicate["startedNs"], duplicate["exitedNs"], LIMITS["duplicateMs"], "PREVIEW_DUPLICATE_DEADLINE")
    need(_integer(duplicate["hostPid"], 1) and type(duplicate["exitCode"]) is int and
         duplicate["exitCode"] == 66 and duplicate["readyEvents"] == [], "PREVIEW_DUPLICATE_NOT_REJECTED")
    need(_pids(duplicate["backendPidsBefore"]) == [first["ready"]["backendPid"]] and
         _pids(duplicate["backendPidsAfter"]) == duplicate["backendPidsBefore"], "PREVIEW_DUPLICATE_STARTED_BACKEND")
    normal = observations["sigterm"]
    _keys(normal, ("hostPid", "signal", "sentNs", "hostExitedNs", "hostExitCode", "allGoneNs",
                   "descendantPidsBefore", "remainingPids", "lockReleased"), "PREVIEW_NORMAL_EXIT_FIELDS")
    need(_integer(normal["hostPid"], 1) and normal["hostPid"] == first["ready"]["hostPid"] and normal["signal"] == "SIGTERM" and
         type(normal["hostExitCode"]) is int and normal["hostExitCode"] == 0 and
         normal["remainingPids"] == [] and normal["lockReleased"] is True, "PREVIEW_NORMAL_EXIT")
    normal_ms = _duration(normal["sentNs"], normal["allGoneNs"], LIMITS["normalMs"], "PREVIEW_NORMAL_DEADLINE")
    _duration(normal["sentNs"], normal["hostExitedNs"], LIMITS["normalMs"], "PREVIEW_NORMAL_HOST_DEADLINE")
    need(normal["hostExitedNs"] <= normal["allGoneNs"] and
         first["ready"]["backendPid"] in _pids(normal["descendantPidsBefore"]) and
         normal["hostPid"] not in normal["descendantPidsBefore"], "PREVIEW_NORMAL_DESCENDANTS")
    restart = _start(observations["restart"], metadata, "restart", version)
    forced = observations["forcedExit"]
    _keys(forced, ("hostPid", "signal", "sentNs", "hostExitedNs", "hostExitCode", "allGoneNs",
                   "descendantPidsBefore", "remainingPids", "recovery"), "PREVIEW_FORCED_EXIT_FIELDS")
    need(_integer(forced["hostPid"], 1) and forced["hostPid"] == restart["ready"]["hostPid"] and forced["signal"] == "SIGKILL" and
         type(forced["hostExitCode"]) is int and forced["hostExitCode"] == -9 and
         forced["remainingPids"] == [], "PREVIEW_FORCED_EXIT")
    # The clarified limit starts at observed host death, not signal dispatch.
    forced_ms = _duration(forced["hostExitedNs"], forced["allGoneNs"], LIMITS["forcedMs"], "PREVIEW_FORCED_DEADLINE")
    need(_integer(forced["sentNs"]) and forced["sentNs"] <= forced["hostExitedNs"] and
         restart["ready"]["backendPid"] in _pids(forced["descendantPidsBefore"]) and
         forced["hostPid"] not in forced["descendantPidsBefore"], "PREVIEW_FORCED_DESCENDANTS")
    recovery = _start(forced["recovery"], metadata, "recovery", version)
    need(first["database"] == restart["database"] == recovery["database"], "PREVIEW_DATABASE_CHANGED")
    if version == CURRENT_VERSION:
        need(first["storageItem"] == restart["storageItem"] == recovery["storageItem"],
             "PREVIEW_STORAGE_ATTRIBUTES_CHANGED")
    need(first["readyNs"] <= duplicate["startedNs"] <= duplicate["exitedNs"] <= normal["sentNs"] and
         normal["allGoneNs"] <= restart["startedNs"] and restart["readyNs"] <= forced["sentNs"] and
         forced["allGoneNs"] <= recovery["startedNs"], "PREVIEW_PHASE_ORDER")
    host_pids = [entry["ready"]["hostPid"] for entry in (first, restart, recovery)]
    backend_pids = [entry["ready"]["backendPid"] for entry in (first, restart, recovery)]
    distinct = [*host_pids, *backend_pids, duplicate["hostPid"]]
    need(len(distinct) == len(set(distinct)), "PREVIEW_PROCESS_IDENTITIES_REUSED")
    cleanup = result["cleanup"]
    common_cleanup = {"account", "workspaceRemoved", "runtimeRemoved", "remainingPids", "finalHostPid",
                      "finalHostExitCode", "finalHostExitedNs", "finalAllGoneNs"}
    false_keys = {"previewStorageItemRemaining", "previewCredentialsItemRemaining", "testStorageItemBefore",
                  "testStorageItemAfter", "testCredentialsItemBefore", "testCredentialsItemAfter"}
    extra_cleanup = false_keys if version == LEGACY_VERSION else {"attributesAfter", "hostCleanup"}
    _keys(cleanup, common_cleanup | extra_cleanup, "PREVIEW_CLEANUP_FIELDS")
    if version == LEGACY_VERSION:
        need(all(cleanup[key] is False for key in false_keys), "PREVIEW_TEMPORARY_CLEANUP")
    else:
        _attributes_absent(cleanup["attributesAfter"])
    need(cleanup["account"] == workspace_id and
         cleanup["workspaceRemoved"] is True and cleanup["runtimeRemoved"] is True and
         cleanup["remainingPids"] == [], "PREVIEW_TEMPORARY_CLEANUP")
    need(_integer(cleanup["finalHostPid"], 1) and cleanup["finalHostPid"] == recovery["ready"]["hostPid"] and
         type(cleanup["finalHostExitCode"]) is int and cleanup["finalHostExitCode"] == 0 and
         _integer(cleanup["finalHostExitedNs"]) and recovery["readyNs"] <= cleanup["finalHostExitedNs"],
         "PREVIEW_FINAL_HOST_EXIT")
    _duration(cleanup["finalHostExitedNs"], cleanup["finalAllGoneNs"], LIMITS["normalMs"], "PREVIEW_FINAL_CLEANUP_DEADLINE")
    cleanup_host = None
    if version == CURRENT_VERSION:
        cleanup_host = cleanup["hostCleanup"]
        _keys(cleanup_host, ("hostPid", "startedNs", "exitedNs", "exitCode", "workspaceId", "services",
                             "backendPids", "readyEvents"), "PREVIEW_HOST_CLEANUP_FIELDS")
        need(_integer(cleanup_host["hostPid"], 1) and cleanup_host["hostPid"] not in distinct and
             type(cleanup_host["exitCode"]) is int and cleanup_host["exitCode"] == 0 and
             cleanup_host["workspaceId"] == workspace_id and
             cleanup_host["services"] == [STORAGE_SERVICE, CREDENTIALS_SERVICE] and
             cleanup_host["backendPids"] == [] and cleanup_host["readyEvents"] == [],
             "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT")
        _duration(cleanup_host["startedNs"], cleanup_host["exitedNs"], LIMITS["normalMs"],
                  "PREVIEW_HOST_CLEANUP_DEADLINE")
        need(cleanup["finalAllGoneNs"] <= cleanup_host["startedNs"], "PREVIEW_HOST_CLEANUP_PHASE_ORDER")
    proof = {"schema": "reverie.preview-workspace.proof." + version, "contract": version, "passed": True, "checks": 5,
            "checkNames": [name for name, _ in CHECKS], "workspaceId": workspace_id,
            "hostPids": host_pids, "backendPids": backend_pids, "duplicateHostPid": duplicate["hostPid"],
            "duplicateExitCode": duplicate["exitCode"],
            "timingsMs": {"ready": [(entry["readyNs"] - entry["startedNs"]) / 1_000_000 for entry in (first, restart, recovery)],
                          "duplicate": duplicate_ms, "normal": normal_ms, "forced": forced_ms},
            "sameDatabase": True, "staleLockRecovered": True,
            "previewAccountsRemoved": True, "testAccountsUntouched": True,
            "temporaryDirectoriesRemoved": True, "ownedProcessesRemaining": 0}
    if version == LEGACY_VERSION:
        proof["keyPreserved"] = True  # Historical v1 evidence only; never projected as v2.
    else:
        proof.update(keychainAttributesUnchanged=True, readyWritable=True, storageItem=dict(first["storageItem"]),
                     hostCleanupPid=cleanup_host["hostPid"],
                     hostCleanupMs=(cleanup_host["exitedNs"] - cleanup_host["startedNs"]) / 1_000_000)
    return proof


def verify_observations(result, *, expected_source, expected_candidate, expected_build_sha, isolation_root,
                        expected_version=None, expected_previous=None):
    arguments = dict(expected_source=expected_source, expected_candidate=expected_candidate,
                     expected_build_sha=expected_build_sha, isolation_root=isolation_root,
                     expected_version=expected_version)
    if isinstance(result, dict) and result.get("contract") == UPGRADE_VERSION:
        from .preview_v4 import verify_observations_v4
        return verify_observations_v4(result, **arguments, expected_previous=expected_previous)
    if isinstance(result, dict) and result.get("contract") == SCOPE_VERSION:
        from .preview_v3 import verify_observations_v3
        return verify_observations_v3(result, **arguments)
    return _verify_lifecycle_observations(result, **arguments)


def _read_json(path, maximum=MAX_REPORT_BYTES):
    from .state import load_json_bytes, regular_file
    before = regular_file(path)
    need(before.st_size <= maximum, "PREVIEW_REPORT_TOO_LARGE")
    identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid,
                             info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        opened = os.fstat(stream.fileno())
        need(stat.S_ISREG(opened.st_mode) and identity(opened) == identity(before), "PREVIEW_FILE_IDENTITY_CHANGED")
        payload = stream.read(maximum + 1)
        need(identity(os.fstat(stream.fileno())) == identity(before), "PREVIEW_FILE_CHANGED_DURING_READ")
    need(identity(regular_file(path)) == identity(before), "PREVIEW_FILE_CHANGED_DURING_READ")
    need(len(payload) <= maximum, "PREVIEW_REPORT_TOO_LARGE")
    value = load_json_bytes(payload)
    need(isinstance(value, dict), "PREVIEW_REPORT_OBJECT")
    return value, payload


def verify_saved(context, summary, run_record, saved_record=None):
    """Bind report/build/raw observations and derive the independent proof."""
    need(enabled(context.config), "PREVIEW_CONTRACT_REQUIRED")
    if context.config["previewWorkspaceContract"] == SCOPE_VERSION:
        need(context.config.get("previewWorkspaceChecks") == list(SCOPE_ADDITIONS), "PREVIEW_V3_CHECK_SELECTION")
    summary = Path(summary)
    expected_root = context.report_dir / STAGE
    need((context.report_dir.is_relative_to(context.root / ".tools/local") or
          context.report_dir.is_relative_to(context.root / ".tools/reports")) and
         summary == expected_root / "summary.json", "PREVIEW_REPORT_PATH_BINDING")
    need(isinstance(run_record, dict) and isinstance(run_record.get("previewIsolationRoot"), str), "PREVIEW_ISOLATION_RECORD")
    isolation_root = _absolute(run_record["previewIsolationRoot"])
    need(run_record.get("command") == command(context.root, context.config, context.report_dir, isolation_root) and
         run_record.get("cwd") == str(context.root), "PREVIEW_STAGE_COMMAND_BINDING")
    result, payload = _read_json(summary)
    if saved_record is not None:
        need(isinstance(saved_record, dict) and saved_record.get("reportRoot") == str(expected_root) and
             saved_record.get("summarySha256") == hashlib.sha256(payload).hexdigest(), "PREVIEW_SUMMARY_BYTE_BINDING")
    build_relative = _relative(context.config["candidateDirectory"])
    need(len(build_relative.parts) >= 3 and build_relative.parts[:2] in
         ((".tools", "qt-builds"), (".tools", "qt-candidates")), "PREVIEW_BUILD_PATH")
    build, build_bytes = _read_json(context.root / build_relative / "build.json", 32 * 1024 * 1024)
    source = build.get("source", {}).get("head")
    candidate = build.get("candidate") or Path(context.config["candidateDirectory"]).name
    need(source == context.config.get("sourceHead"), "PREVIEW_BUILD_SOURCE_CHANGED")
    binding = result.get("observationBinding")
    _keys(binding, ("path", "sha256", "bytes"), "PREVIEW_OBSERVATION_BINDING_FIELDS")
    need(binding["path"] == "observations.json" and _sha(binding["sha256"]) and
         _integer(binding["bytes"]), "PREVIEW_OBSERVATION_BINDING")
    raw_path = expected_root / binding["path"]
    raw, raw_bytes = _read_json(raw_path)
    need(hashlib.sha256(raw_bytes).hexdigest() == binding["sha256"] and len(raw_bytes) == binding["bytes"],
         "PREVIEW_RAW_OBSERVATION_CHANGED")
    split_references = []
    if context.config["previewWorkspaceContract"] == UPGRADE_VERSION and raw.get("storage") in ("split-v1", "split-v2"):
        from .preview_v4_files import read_bundle
        result, raw, split_references = read_bundle(expected_root, result, raw)
    shared = ("sourceHead", "candidate", "buildManifestSha256", "isolationRoot", "workspaceRelativePath",
              "runtimeRelativePath", "limits", "observations", "cleanup")
    _keys(raw, {"schema", *shared}, "PREVIEW_RAW_OBSERVATION_FIELDS")
    version = context.config["previewWorkspaceContract"]
    need(raw["schema"] == "reverie.preview-workspace.observations." + version and
         all(raw[key] == result.get(key) for key in shared),
         "PREVIEW_RAW_SUMMARY_MISMATCH")
    proof = verify_observations(result, expected_source=source, expected_candidate=candidate,
                                expected_build_sha=hashlib.sha256(build_bytes).hexdigest(), isolation_root=isolation_root,
                                expected_version=version, expected_previous=context.config.get("previewUpgradeBaseline"))
    reference = {"path": str(raw_path.relative_to(context.root)), "sha256": binding["sha256"], "bytes": len(raw_bytes)}
    references = [reference]
    for item in split_references:
        references.append({**item, "path": str((expected_root / item["path"]).relative_to(context.root))})
    if version == UPGRADE_VERSION:
        from .preview_v4 import verify_saved_inputs
        for item in verify_saved_inputs(expected_root, context.config.get("previewUpgradeBaseline")):
            references.append({**item, "path": str((expected_root / item["path"]).relative_to(context.root))})
    return {"rawReportBinding": references, "previewWorkspaceEvidence": proof,
            "isolationRoot": str(isolation_root)}
