"""W1's eighth check is opt-in, authorization-bound, and recomputed from facts.

All inputs are disposable metadata. These tests never launch the host/backend,
query a keychain/PID, install a runtime, or inspect a preview workspace.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from script.registered_run import baseline, catalog, cli, engine, preview, registration, stages
from script.registered_run.config import ConfigError, unit_selection, validate_config
from script.registered_run.contract import registration_contract
from script.registered_run.coverage import MODE_OPTIONS
from script.registered_run.export_config import CONFIG_SCHEMA, STAGE_BUDGETS
from script.registered_run.modes.context import RunContext
from script.registered_run.state import StateError, gui_selection_options, selection_key, validate_authorization


SOURCE = "a" * 40


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()
    path.write_bytes(payload)
    return {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}


def config_value(*, enabled=False, version="v2"):
    value = {"configSchema": CONFIG_SCHEMA, "runKind": "development", "adoptCandidate": False,
        "stopOnFirstFailure": True, "retries": 0, "sequence": list(STAGE_BUDGETS),
        "budgets": {name: 1 for name in STAGE_BUDGETS.values()},
        "timeoutsSeconds": {name: None if name.endswith("-check") else 300 for name in STAGE_BUDGETS},
        "pythonTargets": ["tests/synthetic_test.py"], "nodeTests": ["native-ui/synthetic.test.cjs"],
        "frontendTests": ["frontend/synthetic.test.ts"], "nativeTargets": ["synthetic-target"],
        "nativeExecutionOrder": ["synthetic-target"], "nativeSelector": "^(synthetic-target)$",
        "python": ".venv/bin/python", "node": ".tools/node/bin/node", "localSdk": ".tools/qt-sdk",
        "candidateName": "synthetic-preview", "candidateDirectory": ".tools/qt-candidates/synthetic-preview",
        "cmakeDirectory": ".tools/qt-builds/synthetic-preview", "package": "preview-fixture",
        "guiModes": [{"stage": mode + "-check", "option": options[0],
                      **({"modifier": options[1]} if len(options) > 1 else {})} for mode, options in MODE_OPTIONS],
        "requiredGuiModes": list(catalog.GUI_MODES), "sourceHead": SOURCE,
        "memoryActionContract": "v2", "cardExportContract": "v1", "cardEditContract": "v1"}
    if enabled:
        value["previewWorkspaceContract"] = version
        value["sequence"].append("preview-check")
        value["budgets"]["previewCheck"] = 1
        value["timeoutsSeconds"]["preview-check"] = 600
        value["guiModes"].append({"stage": "preview-check", "option": "--preview-workspace-smoke"})
        value["requiredGuiModes"].append("preview")
    return value


def ready(host, backend, workspace, candidate):
    return {"schema": "reverie.qt.preview.ready.v1", "hostPid": host, "backendPid": backend,
            "workspaceId": workspace, "sourceHead": SOURCE, "candidate": candidate,
            "recoveryState": "clean", "runtimeWritable": True}


def report_value(isolation, *, candidate="synthetic-preview", build_sha="b" * 64):
    workspace = hashlib.sha256(str(isolation / "preview-workspace").encode()).hexdigest()
    database = {"relativePath": "data/runtime/kernel.sqlite3", "device": 1, "inode": 11}
    return {"schema": "reverie.preview-workspace.smoke.v1", "contract": "v1", "passed": True,
        "sourceHead": SOURCE, "candidate": candidate, "buildManifestSha256": build_sha,
        "isolationRoot": str(isolation), "workspaceRelativePath": "preview-workspace",
        "runtimeRelativePath": "preview-runtime",
        "limits": {"readyMs": 30000, "normalMs": 10000, "duplicateMs": 5000, "forcedMs": 10000},
        "checks": [{"name": name, "passed": True, "observation": observation} for name, observation in (
            ("first-start", "firstStart"), ("second-instance-rejected", "secondInstance"),
            ("sigterm-exit", "sigterm"), ("restart-same-storage", "restart"),
            ("forced-host-exit-and-lock-recovery", "forcedExit"))],
        "observationBinding": {"path": "observations.json", "sha256": "0" * 64, "bytes": 0},
        "observations": {
            "firstStart": {"startedNs": 1_000_000_000, "readyNs": 2_000_000_000,
                "ready": ready(101, 102, workspace, candidate), "keyCreated": True, "database": deepcopy(database)},
            "secondInstance": {"hostPid": 103, "startedNs": 2_100_000_000, "exitedNs": 2_200_000_000,
                "exitCode": 66, "readyEvents": [], "backendPidsBefore": [102], "backendPidsAfter": [102]},
            "sigterm": {"hostPid": 101, "signal": "SIGTERM", "sentNs": 3_000_000_000,
                "hostExitedNs": 3_100_000_000, "hostExitCode": 0, "allGoneNs": 3_200_000_000,
                "descendantPidsBefore": [102], "remainingPids": [], "lockReleased": True},
            "restart": {"startedNs": 4_000_000_000, "readyNs": 5_000_000_000,
                "ready": ready(104, 105, workspace, candidate), "keyUnchanged": True, "database": deepcopy(database)},
            "forcedExit": {"hostPid": 104, "signal": "SIGKILL", "sentNs": 6_000_000_000,
                "hostExitedNs": 6_010_000_000, "hostExitCode": -9, "allGoneNs": 6_200_000_000,
                "descendantPidsBefore": [105], "remainingPids": [],
                "recovery": {"startedNs": 7_000_000_000, "readyNs": 8_000_000_000,
                    "ready": ready(106, 107, workspace, candidate), "staleLockObserved": True,
                    "lockRecovered": True, "keyUnchanged": True, "database": deepcopy(database)}}},
        "cleanup": {"account": workspace, "previewStorageItemRemaining": False,
            "previewCredentialsItemRemaining": False, "testStorageItemBefore": False,
            "testStorageItemAfter": False, "testCredentialsItemBefore": False,
            "testCredentialsItemAfter": False, "workspaceRemoved": True, "runtimeRemoved": True,
            "remainingPids": [], "finalHostPid": 106, "finalHostExitCode": 0,
            "finalHostExitedNs": 9_100_000_000, "finalAllGoneNs": 9_200_000_000}}


def report_value_v2(isolation, **kwargs):
    value = report_value(isolation, **kwargs)
    value.update(schema="reverie.preview-workspace.smoke.v2", contract="v2")
    workspace = value["cleanup"]["account"]
    item = {"service": "com.muhe.reverie.qt.preview.storage.v1", "account": workspace,
            "creationTime": "20261101033445Z", "modificationTime": "20261101033445Z"}
    absent = {"previewStorage": None, "previewCredentials": None, "testStorage": None, "testCredentials": None}
    first = value["observations"]["firstStart"]
    del first["keyCreated"]
    first.update(attributesBefore=deepcopy(absent), storageItem=deepcopy(item))
    for start in (value["observations"]["restart"], value["observations"]["forcedExit"]["recovery"]):
        del start["keyUnchanged"]
        start["storageItem"] = deepcopy(item)
    cleanup = value["cleanup"]
    for field in ("previewStorageItemRemaining", "previewCredentialsItemRemaining", "testStorageItemBefore",
                  "testStorageItemAfter", "testCredentialsItemBefore", "testCredentialsItemAfter"):
        del cleanup[field]
    cleanup.update(attributesAfter=deepcopy(absent), hostCleanup={"hostPid": 108,
        "startedNs": 9_300_000_000, "exitedNs": 9_400_000_000, "exitCode": 0,
        "workspaceId": workspace, "services": ["com.muhe.reverie.qt.preview.storage.v1",
                                                "com.muhe.reverie.qt.preview.credentials.v1"],
        "backendPids": [], "readyEvents": []})
    return value


def derive(value):
    return preview.verify_observations(value, expected_source=SOURCE,
        expected_candidate=value["candidate"], expected_build_sha=value["buildManifestSha256"],
        isolation_root=Path(value["isolationRoot"]))


def replace(value, path, replacement):
    keys = path.split(".")
    for key in keys[:-1]:
        value = value[int(key)] if isinstance(value, list) else value[key]
    value[int(keys[-1]) if isinstance(value, list) else keys[-1]] = replacement


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    root = tmp_path.resolve() / "repository"
    report = root / ".tools/local/preview-fixture/runs/synthetic"
    report.mkdir(parents=True)
    scratch = root / "owned-scratch"
    for name in ("data", "tmp", "cache", "hf"):
        (scratch / name).mkdir(parents=True)
    config = config_value(enabled=True)
    build_dir = root / ".tools/qt-builds/local-preview-fixture"
    write_json(build_dir / "build.json", {"candidate": None,
        "localIteration": {"package": "preview-fixture", "acceptanceEligible": False},
        "source": {"head": SOURCE}, "compilation": {"cmakeDirectory": str(build_dir)}})
    for filename in ("script/registered_run/native_stage.py", *config["pythonTargets"],
                     *config["nodeTests"], *config["frontendTests"]):
        path = root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("synthetic source; never execute\n")
    environment = {"REVERIE_DATA_DIR": str(scratch / "data"), "TMPDIR": str(scratch / "tmp"),
                   "XDG_CACHE_HOME": str(scratch / "cache"), "HF_HOME": str(scratch / "hf")}
    def forbidden(*_args, **_kwargs):
        raise AssertionError("Synthetic preview metadata must never launch a process")
    monkeypatch.setattr("subprocess.Popen", forbidden)
    return SimpleNamespace(root=root, report=report, scratch=scratch, config=config, environment=environment)


def save_observations(directory, value):
    shared = ("sourceHead", "candidate", "buildManifestSha256", "isolationRoot", "workspaceRelativePath",
              "runtimeRelativePath", "limits", "observations", "cleanup")
    raw = {"schema": "reverie.preview-workspace.observations." + value["contract"],
           **{key: deepcopy(value[key]) for key in shared}}
    binding = write_json(directory / "observations.json", raw)
    value["observationBinding"] = {"path": "observations.json", **binding}
    write_json(directory / "summary.json", value)
    return raw


def complete_stage(env):
    spec, = stages.plan(env.root, env.report, env.config, env.environment, "gui", ["preview"])
    runtime = stages.load_runtime_config(env.report)
    instance = SimpleNamespace(ledger={"guiResults": {}})
    row = {"id": "preview-check", "command": list(spec.command), "cwd": str(env.root),
           "passed": True, "exitCode": 0, "state": "completed", "processGroupGone": True}
    spec.before_start(instance, row)
    directory = env.report / "preview-check"
    build = env.root / runtime["candidateDirectory"] / "build.json"
    make_report = report_value_v2 if runtime["previewWorkspaceContract"] == "v2" else report_value
    value = make_report(env.scratch, candidate=build.parent.name,
                        build_sha=hashlib.sha256(build.read_bytes()).hexdigest())
    save_observations(directory, value)
    (env.report / "preview-check.log").write_text(json.dumps({"reportRoot": str(directory), "passed": True}) + "\n")
    spec.after_exit(instance, row)
    row["evidence"] = spec.verify(instance, row)
    return runtime, instance, row, value


def test_preview_feature_leaves_legacy_public_defaults_and_authorization_key_unchanged():
    assert len(STAGE_BUDGETS) == 12
    assert len(catalog.GUI_MODES) == len(registration.GUI_MODES) == len(MODE_OPTIONS) == 7
    assert list(preview.effective_modes(config_value())) == list(catalog.GUI_MODES)
    assert len(gui_selection_options(None)) == len(gui_selection_options([])) == 7
    assert selection_key("gui", []) == selection_key("gui", list(catalog.GUI_MODES))
    assert selection_key("gui", list(preview.effective_modes(config_value(enabled=True)))) != selection_key("gui", [])


def test_preview_extension_preserves_all_inherited_unit_selection_and_contracts():
    old, new = config_value(), config_value(enabled=True)
    result = validate_config(new)
    assert unit_selection(result) == unit_selection(old)
    for key in ("memoryActionContract", "cardExportContract", "cardEditContract", "nativeExecutionOrder", "nativeSelector"):
        assert result[key] == old[key]
    assert result["sequence"][:-1] == old["sequence"]
    assert result["guiModes"][:-1] == old["guiModes"]


@pytest.mark.parametrize("field,value", [
    ("previewWorkspaceContract", "v3"), ("previewWorkspaceContract", None),
    ("sequence", list(STAGE_BUDGETS)), ("requiredGuiModes", list(catalog.GUI_MODES)),
    ("guiModes", config_value()["guiModes"]), ("timeoutsSeconds.preview-check", 601),
    ("budgets.previewCheck", 2), ("guiModes.7.option", "--arbitrary-command"),
])
def test_preview_config_rejects_partial_or_changed_new_contract(field, value):
    config = config_value(enabled=True)
    replace(config, field, value)
    with pytest.raises(ConfigError):
        validate_config(config)


def test_legacy_config_cannot_select_preview_without_the_version():
    config = config_value(enabled=True)
    del config["previewWorkspaceContract"]
    with pytest.raises(ConfigError, match="CONFIG_STAGE_SEQUENCE"):
        validate_config(config)


@pytest.mark.parametrize("field", ["guiModes", "requiredGuiModes", "budgets", "timeoutsSeconds"])
def test_legacy_config_rejects_preview_selectors_instead_of_silently_omitting_the_check(field):
    config = config_value()
    if field == "guiModes":
        config[field].append({"stage": "preview-check", "option": "--preview-workspace-smoke"})
    elif field == "requiredGuiModes":
        config[field].append("preview")
    elif field == "budgets":
        config[field]["previewCheck"] = 1
    else:
        config[field]["preview-check"] = 600
    with pytest.raises(ConfigError, match="PREVIEW_CONTRACT_REQUIRED"):
        validate_config(config)


@pytest.mark.parametrize("enabled", [False, True])
def test_gui_default_plans_seven_or_explicit_eight_and_uses_closed_preview_argv(workspace, enabled):
    env = workspace
    config = config_value(enabled=enabled)
    planned = stages.plan(env.root, env.report, config, env.environment, "gui")
    expected = [mode + "-check" for mode in catalog.GUI_MODES] + (["preview-check"] if enabled else [])
    assert [spec.id for spec in planned] == expected
    if enabled:
        spec = planned[-1]
        assert spec.command == [str(env.root / ".venv/bin/python"), "-I", "-B",
            str(env.root / "script/check_preview_workspace.py"), "--preview-workspace-smoke",
            "--build-dir", str(env.root / ".tools/qt-builds/local-preview-fixture"),
            "--report-dir", str(env.report / "preview-check"), "--isolation-root", str(env.scratch)]
        assert spec.budget == "previewCheck" and spec.timeout == 600
        assert spec.check_category == "gui" and spec.selection == ["preview"]
        assert spec.capture_pointer is False


@pytest.mark.parametrize("enabled", [False, True])
def test_registered_plan_preserves_old_twelve_and_appends_only_opt_in_preview(workspace, enabled):
    env = workspace
    config = config_value(enabled=enabled)
    planned = stages.plan(env.root, env.report, config, env.environment, "registered")
    assert [spec.id for spec in planned] == list(STAGE_BUDGETS) + (["preview-check"] if enabled else [])
    assert planned[0].capture_pointer is True
    assert all(spec.capture_pointer is False for spec in planned[1:])


@pytest.mark.parametrize("enabled", [False, True])
def test_cli_default_binds_effective_selection_before_authorization_and_journal(workspace, monkeypatch, enabled):
    env = workspace
    config = config_value(enabled=enabled)
    monkeypatch.setattr(cli, "load_config", lambda _path: deepcopy(config))
    captured = {}
    def run_local(_root, _package, category, selection, **kwargs):
        captured.update(category=category, selection=selection, command=kwargs["command"])
        return {"passed": True, "localRun": {"sequence": 1, "counts": {}}, "outputDirectory": str(env.report)}
    monkeypatch.setattr(engine, "run_local", run_local)
    args = SimpleNamespace(config=Path("synthetic-config.json"), package="preview-fixture", category="gui",
                           select=None, diagnostic=False, qml_cache=None)
    assert cli.run_local_command(args, env.root) == 0
    assert captured["selection"] == ([*catalog.GUI_MODES, "preview"] if enabled else [])
    if enabled:
        assert captured["command"].count("--select") == 8
        assert captured["command"][-2:] == ["--select", "preview"]


def test_preview_selection_requires_explicit_new_mode_authorization(workspace):
    env = workspace
    path = env.root / ".tools/local/preview-fixture/authorization.json"
    authorization = {"schema": "reverie.local-iteration.authorization.v1", "package": "preview-fixture",
        "userApprovalText": "Synthetic W1 local authorization", "recordedUtc": "2026-10-31T00:00:00Z",
        "validUntil": "synthetic completion or revocation", "scope": {
            "guiModes": [" ".join(options) for _mode, options in MODE_OPTIONS], "newGuiModes": []}}
    write_json(path, authorization)
    selected = [*catalog.GUI_MODES, "preview"]
    with pytest.raises(StateError, match="SCOPE_EXCEEDED"):
        validate_authorization(env.root, "preview-fixture", "gui", selected)
    authorization["scope"]["newGuiModes"] = ["--preview-workspace-smoke"]
    write_json(path, authorization)
    validate_authorization(env.root, "preview-fixture", "gui", selected)
    assert gui_selection_options(["preview-check"]) == ["--preview-workspace-smoke"]
    assert len(gui_selection_options(None)) == 7


def test_preview_contract_projection_binds_version_only_when_explicit():
    args = ({"cases": [], "counts": {}}, {}, {},
            {"unitRun": {"sequence": 1}, "requiredGuiRuns": {}}, {})
    old = registration_contract(config_value(), *args, code_tree_hash="c" * 40)
    new = registration_contract(config_value(enabled=True), *args, code_tree_hash="c" * 40)
    assert "previewWorkspaceContract" not in old["runtime"]
    assert new["runtime"]["previewWorkspaceContract"] == "v2"
    assert new["runtime"]["pythonTargets"] == old["runtime"]["pythonTargets"]


def test_verdict_recomputes_all_five_phases_from_metadata(tmp_path):
    result = derive(report_value(tmp_path.resolve()))
    assert result["passed"] is True and result["checks"] == 5
    assert result["hostPids"] == [101, 104, 106] and result["backendPids"] == [102, 105, 107]
    assert result["timingsMs"] == {"ready": [1000.0, 1000.0, 1000.0], "duplicate": 100.0,
                                    "normal": 200.0, "forced": 190.0}


def test_v1_reader_keeps_the_original_proof_and_never_projects_attribute_evidence(tmp_path):
    value = report_value(tmp_path.resolve())
    proof = derive(value)
    assert proof["schema"] == "reverie.preview-workspace.proof.v1" and proof["contract"] == "v1"
    assert proof["keyPreserved"] is True
    assert set(proof) == {"schema", "contract", "passed", "checks", "checkNames", "workspaceId",
        "hostPids", "backendPids", "duplicateHostPid", "duplicateExitCode", "timingsMs", "sameDatabase",
        "keyPreserved", "staleLockRecovered", "previewAccountsRemoved", "testAccountsUntouched",
        "temporaryDirectoriesRemoved", "ownedProcessesRemaining"}


def test_v2_continuity_uses_only_attributes_same_database_and_writable_ready(tmp_path):
    value = report_value_v2(tmp_path.resolve())
    proof = derive(value)
    assert proof["schema"] == "reverie.preview-workspace.proof.v2" and proof["contract"] == "v2"
    assert proof["keychainAttributesUnchanged"] is proof["sameDatabase"] is proof["readyWritable"] is True
    assert proof["storageItem"] == value["observations"]["firstStart"]["storageItem"]
    assert proof["hostCleanupPid"] == 108 and proof["hostCleanupMs"] == 100.0
    assert "keyPreserved" not in proof
    assert "keyCreated" not in value["observations"]["firstStart"]
    assert "keyUnchanged" not in value["observations"]["restart"]


@pytest.mark.parametrize("version", ["v1", "v2"])
def test_preview_report_cannot_be_relabelled_as_the_other_contract(tmp_path, version):
    value = report_value(tmp_path.resolve()) if version == "v1" else report_value_v2(tmp_path.resolve())
    with pytest.raises(preview.PreviewError, match="PREVIEW_SUMMARY_VERSION"):
        preview.verify_observations(value, expected_source=SOURCE, expected_candidate=value["candidate"],
            expected_build_sha=value["buildManifestSha256"], isolation_root=tmp_path.resolve(),
            expected_version="v2" if version == "v1" else "v1")


def test_new_preview_execution_rejects_v1_before_authorization_or_spawning(workspace, monkeypatch):
    env = workspace
    monkeypatch.setattr(cli, "load_config", lambda _path: config_value(enabled=True, version="v1"))
    monkeypatch.setattr(engine, "run_local", lambda *_a, **_k: pytest.fail("v1 execution created a run"))
    args = SimpleNamespace(config=Path("synthetic-config.json"), package="preview-fixture", category="gui",
                           select=None, diagnostic=False, qml_cache=None)
    with pytest.raises(preview.PreviewError, match="PREVIEW_CURRENT_CONTRACT_REQUIRED"):
        cli.run_local_command(args, env.root)
    with pytest.raises(preview.PreviewError, match="PREVIEW_CURRENT_CONTRACT_REQUIRED"):
        registration._validated_config(env.root, config_value(enabled=True, version="v1"))


@pytest.mark.parametrize("path,value,code", [
    ("observations.firstStart.attributesBefore.previewStorage", {}, "PREVIEW_ATTRIBUTES_NOT_ABSENT"),
    ("observations.firstStart.storageItem.service", "com.muhe.reverie.qt.local.storage.v1", "PREVIEW_STORAGE_ATTRIBUTE_SCOPE"),
    ("observations.firstStart.storageItem.account", "0" * 64, "PREVIEW_STORAGE_ATTRIBUTE_SCOPE"),
    ("observations.firstStart.storageItem.creationTime", "20260230000000Z", "PREVIEW_STORAGE_ATTRIBUTE_DATE"),
    ("observations.firstStart.storageItem.modificationTime", "2026-11-01T03:34:45Z", "PREVIEW_STORAGE_ATTRIBUTE_DATE"),
    ("observations.firstStart.storageItem.secretData", "synthetic-forbidden-key-material", "PREVIEW_STORAGE_ATTRIBUTE_FIELDS"),
    ("observations.firstStart.keyCreated", True, "PREVIEW_START_FIELDS"),
    ("observations.restart.storageItem.creationTime", "20261101033446Z", "PREVIEW_STORAGE_ATTRIBUTES_CHANGED"),
    ("observations.forcedExit.recovery.storageItem.modificationTime", "20261101033446Z", "PREVIEW_STORAGE_ATTRIBUTES_CHANGED"),
    ("cleanup.attributesAfter.previewStorage", {}, "PREVIEW_ATTRIBUTES_NOT_ABSENT"),
    ("cleanup.attributesAfter.testStorage", {}, "PREVIEW_ATTRIBUTES_NOT_ABSENT"),
    ("cleanup.previewStorageItemRemaining", False, "PREVIEW_CLEANUP_FIELDS"),
    ("cleanup.hostCleanup.exitCode", 69, "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT"),
    ("cleanup.hostCleanup.hostPid", 101, "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT"),
    ("cleanup.hostCleanup.workspaceId", "0" * 64, "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT"),
    ("cleanup.hostCleanup.services", ["com.muhe.reverie.qt.local.storage.v1"], "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT"),
    ("cleanup.hostCleanup.backendPids", [999], "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT"),
    ("cleanup.hostCleanup.readyEvents", [{}], "PREVIEW_HOST_CLEANUP_SCOPE_OR_EXIT"),
    ("cleanup.hostCleanup.exitedNs", 19_300_000_001, "PREVIEW_HOST_CLEANUP_DEADLINE"),
    ("cleanup.hostCleanup.startedNs", 9_199_999_999, "PREVIEW_HOST_CLEANUP_PHASE_ORDER"),
])
def test_v2_rejects_changed_attributes_or_unscoped_host_cleanup(tmp_path, path, value, code):
    result = report_value_v2(tmp_path.resolve())
    replace(result, path, value)
    with pytest.raises(preview.PreviewError, match=code):
        derive(result)


def test_forced_exit_limit_starts_at_host_death_and_accepts_exactly_ten_seconds(tmp_path):
    result = report_value(tmp_path.resolve())
    forced = result["observations"]["forcedExit"]
    forced.update(hostExitedNs=7_000_000_000, allGoneNs=17_000_000_000)
    forced["recovery"].update(startedNs=18_000_000_000, readyNs=19_000_000_000)
    result["cleanup"].update(finalHostExitedNs=20_100_000_000, finalAllGoneNs=20_200_000_000)
    assert derive(result)["timingsMs"]["forced"] == 10000.0


@pytest.mark.parametrize("path,value,code", [
    ("observations.firstStart.ready.hostPid", True, "PREVIEW_READY_PID"),
    ("observations.firstStart.ready.runtimeWritable", False, "PREVIEW_READY_NOT_WRITABLE"),
    ("observations.firstStart.ready.workspaceId", "0" * 64, "PREVIEW_READY_BUILD_OR_WORKSPACE"),
    ("observations.firstStart.keyCreated", False, "PREVIEW_KEY_OR_LOCK_OBSERVATION"),
    ("observations.firstStart.readyNs", 31_000_000_001, "PREVIEW_READY_DEADLINE"),
    ("observations.secondInstance.exitCode", 0, "PREVIEW_DUPLICATE_NOT_REJECTED"),
    ("observations.secondInstance.readyEvents", [{}], "PREVIEW_DUPLICATE_NOT_REJECTED"),
    ("observations.secondInstance.backendPidsAfter", [102, 999], "PREVIEW_DUPLICATE_STARTED_BACKEND"),
    ("observations.secondInstance.exitedNs", 7_100_000_001, "PREVIEW_DUPLICATE_DEADLINE"),
    ("observations.sigterm.hostExitCode", -15, "PREVIEW_NORMAL_EXIT"),
    ("observations.sigterm.lockReleased", False, "PREVIEW_NORMAL_EXIT"),
    ("observations.sigterm.descendantPidsBefore", [], "PREVIEW_NORMAL_DESCENDANTS"),
    ("observations.sigterm.allGoneNs", 13_000_000_001, "PREVIEW_NORMAL_DEADLINE"),
    ("observations.restart.keyUnchanged", False, "PREVIEW_KEY_OR_LOCK_OBSERVATION"),
    ("observations.restart.database.inode", 12, "PREVIEW_DATABASE_CHANGED"),
    ("observations.forcedExit.hostExitCode", 0, "PREVIEW_FORCED_EXIT"),
    ("observations.forcedExit.remainingPids", [105], "PREVIEW_FORCED_EXIT"),
    ("observations.forcedExit.allGoneNs", 16_010_000_001, "PREVIEW_FORCED_DEADLINE"),
    ("observations.forcedExit.recovery.staleLockObserved", False, "PREVIEW_KEY_OR_LOCK_OBSERVATION"),
    ("observations.forcedExit.recovery.ready.hostPid", 101, "PREVIEW_PROCESS_IDENTITIES_REUSED"),
    ("cleanup.testStorageItemAfter", True, "PREVIEW_TEMPORARY_CLEANUP"),
    ("cleanup.previewCredentialsItemRemaining", True, "PREVIEW_TEMPORARY_CLEANUP"),
    ("cleanup.runtimeRemoved", False, "PREVIEW_TEMPORARY_CLEANUP"),
    ("cleanup.remainingPids", [107], "PREVIEW_TEMPORARY_CLEANUP"),
    ("cleanup.finalHostPid", 104, "PREVIEW_FINAL_HOST_EXIT"),
    ("cleanup.finalAllGoneNs", 19_100_000_001, "PREVIEW_FINAL_CLEANUP_DEADLINE"),
    ("limits.forcedMs", 10001, "PREVIEW_LIMITS"),
    ("checks.0.passed", 1, "PREVIEW_ORDERED_CHECKS"),
])
def test_success_flags_cannot_override_bad_raw_observations(tmp_path, path, value, code):
    result = report_value(tmp_path.resolve())
    replace(result, path, value)
    with pytest.raises(preview.PreviewError, match=code):
        derive(result)


def test_preview_hook_owns_fresh_reports_and_binds_independent_raw_file(workspace):
    runtime, instance, row, _value = complete_stage(workspace)
    saved = instance.ledger["guiResults"]["preview-check"]
    assert saved["previewWorkspaceEvidence"]["checks"] == 5
    assert len(saved["rawReportBinding"]) == 1
    assert saved["rawReportBinding"][0]["path"].endswith("preview-check/observations.json")
    assert "archiveControlReadinessEvidence" not in saved
    assert row["previewIsolationRoot"] == str(workspace.scratch)
    assert runtime["previewWorkspaceContract"] == "v2"


def test_summary_byte_changes_are_rejected_between_stage_hooks(workspace):
    env = workspace
    runtime, instance, row, _value = complete_stage(env)
    summary = env.report / "preview-check/summary.json"
    with summary.open("ab") as stream:
        stream.write(b" \n")  # Same JSON facts, different bytes after the exit hook.
    with pytest.raises(preview.PreviewError, match="PREVIEW_SUMMARY_BYTE_BINDING"):
        catalog.verify_mode(RunContext(env.root, env.report, runtime), "preview", summary,
                            run_record=row, saved_record=instance.ledger["guiResults"]["preview-check"])


def test_raw_observation_binding_cannot_read_outside_the_owned_report(workspace, monkeypatch):
    env = workspace
    runtime, _instance, row, value = complete_stage(env)
    value["observationBinding"]["path"] = "../../outside.json"
    summary = env.report / "preview-check/summary.json"
    write_json(summary, value)
    original = preview._read_json
    outside = (summary.parent / "../../outside.json").resolve()
    def read(path, *args, **kwargs):
        assert Path(path).resolve() != outside, "A rejected binding accessed another report's file"
        return original(path, *args, **kwargs)
    monkeypatch.setattr(preview, "_read_json", read)
    with pytest.raises(preview.PreviewError, match="PREVIEW_OBSERVATION_BINDING"):
        catalog.verify_mode(RunContext(env.root, env.report, runtime), "preview", summary, run_record=row)


@pytest.mark.parametrize("rewrite_binding", [False, True])
def test_changed_raw_file_is_rejected_even_with_a_passing_summary(workspace, rewrite_binding):
    env = workspace
    runtime, _instance, row, value = complete_stage(env)
    directory = env.report / "preview-check"
    raw = json.loads((directory / "observations.json").read_text())
    raw["observations"]["secondInstance"]["exitCode"] = 64
    binding = write_json(directory / "observations.json", raw)
    if rewrite_binding:
        value["observationBinding"] = {"path": "observations.json", **binding}
        write_json(directory / "summary.json", value)
    with pytest.raises(preview.PreviewError, match="PREVIEW_RAW_SUMMARY_MISMATCH" if rewrite_binding else "PREVIEW_RAW_OBSERVATION_CHANGED"):
        catalog.verify_mode(RunContext(env.root, env.report, runtime), "preview", directory / "summary.json", run_record=row)


def test_saved_preview_replay_never_probes_workspace_or_live_processes(workspace, monkeypatch):
    env = workspace
    runtime, instance, row, _value = complete_stage(env)
    write_json(env.report / "run-ledger.json", {"passed": True, "runs": [row],
        "guiResults": instance.ledger["guiResults"]})
    def guard(original):
        def checked(path, *args, **kwargs):
            if path.is_relative_to(env.scratch / "preview-workspace") or path.is_relative_to(env.scratch / "preview-runtime"):
                pytest.fail("Saved verification accessed the disposable workspace/runtime")
            return original(path, *args, **kwargs)
        return checked
    for name in ("exists", "stat", "lstat", "resolve", "is_file", "is_dir", "is_symlink", "open",
                 "read_bytes", "read_text", "write_bytes", "write_text", "mkdir", "unlink", "rmdir"):
        monkeypatch.setattr(Path, name, guard(getattr(Path, name)))
    def no_pid_query(*_args, **_kwargs):
        pytest.fail("Saved verification queried/signalled a live process")
    monkeypatch.setattr(os, "kill", no_pid_query)
    monkeypatch.setattr(os, "killpg", no_pid_query)
    replay = catalog.replay_saved(RunContext(env.root, env.report, runtime), ["preview-check"])
    assert replay["verdictsMatchOriginal"] is True
    assert replay["stages"]["preview-check"]["previewWorkspaceEvidence"]["checks"] == 5


def test_saved_v1_replay_remains_read_only_and_cannot_satisfy_v2(workspace):
    env = workspace
    env.config = config_value(enabled=True, version="v1")
    runtime, instance, row, _value = complete_stage(env)
    summary = env.report / "preview-check/summary.json"
    observed = catalog.verify_mode(RunContext(env.root, env.report, runtime), "preview", summary,
        run_record=row, saved_record=instance.ledger["guiResults"]["preview-check"])
    assert observed["previewWorkspaceEvidence"]["contract"] == "v1"
    with pytest.raises(preview.PreviewError, match="PREVIEW_RAW_SUMMARY_MISMATCH"):
        catalog.verify_mode(RunContext(env.root, env.report, {**runtime, "previewWorkspaceContract": "v2"}),
                            "preview", summary, run_record=row)


def test_local_preview_prerequisite_rechecks_engine_raw_and_source_bindings(workspace):
    env = workspace
    runtime, instance, run, _value = complete_stage(env)
    binding = {"path": str((env.report / "runtime-config.json").relative_to(env.root)),
               **{"sha256": hashlib.sha256((env.report / "runtime-config.json").read_bytes()).hexdigest(),
                  "bytes": (env.report / "runtime-config.json").stat().st_size}}
    ledger = {"schema": "reverie.shared-run.ledger.v1", "kind": "local", "passed": True,
        "sourceHead": SOURCE, "sourceTreeHash": "b" * 40, "codeTreeHash": "c" * 40,
        "unitScratchRemoved": True, "ownedProcessesRemaining": 0, "unitIsolation": {"scratch": str(env.scratch)},
        "runtimeConfigBinding": binding, "runs": [run], "guiResults": instance.ledger["guiResults"]}
    write_json(env.report / "run-ledger.json", ledger)
    row = {"sequence": 1, "outputDirectory": str(env.report), "sourceHead": SOURCE,
           "sourceTreeHash": "b" * 40, "codeTreeHash": "c" * 40}
    proof = registration._gui_prerequisite(env.root, row, "preview", preview_workspace_contract=runtime["previewWorkspaceContract"])
    assert proof["hostProofs"]["previewWorkspaceEvidence"]["checks"] == 5
    assert len(proof["rawReports"]) == 1
    assert proof["reportRoot"] == str((env.report / "preview-check").relative_to(env.root))
    # The new baseline branch consumes the same saved proof, with no app/PID probe.
    baseline._gui_results(env.root, env.report, {**runtime, "sequence": ["preview-check"]}, ledger)
    ledger["unitIsolation"]["scratch"] = str(env.root / "unrelated-scratch")
    write_json(env.report / "run-ledger.json", ledger)
    with pytest.raises(registration.RegistrationError, match="LOCAL_PREVIEW_ISOLATION_BINDING"):
        registration._gui_prerequisite(env.root, row, "preview", preview_workspace_contract=runtime["previewWorkspaceContract"])
