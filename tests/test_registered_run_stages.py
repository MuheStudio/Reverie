"""Planning/parser tests only: no build, GUI, Qt test or consumer runs."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

import pytest

from script.registered_run.catalog import NATIVE_GROUPS
from script.registered_run.measurement import (
    MeasurementError, cache_environment, ctest_commands, parse_qtest_xml,
    run_selected, split_native_selection, summarize_measurements,
)
from script.registered_run.modes.context import RunContext
from script.registered_run.native_stage import run_native
from script.registered_run.stages import PlanError, load_runtime_config, plan, runtime_config


def test_real_signed_config_plans_all_twelve_stages_without_executing_them():
    from script.registered_run.export_config import export_baseline
    root = Path(__file__).resolve().parents[1]
    baseline = export_baseline(root / '.tools/reports/p1-worldbook-injection-r1-20261026', root)
    assert 'native-ui/tests/test_p1_profile_bootstrap.py' in baseline['pythonTargets']
    with tempfile.TemporaryDirectory(prefix='tool-plan-only-', dir=root / '.tools/local') as temp:
        report = Path(temp).resolve()
        for name in ['data', 'tmp', 'cache', 'hf']:
            (report / name).mkdir()
        env = {'REVERIE_DATA_DIR': str(report / 'data'), 'TMPDIR': str(report / 'tmp'),
               'XDG_CACHE_HOME': str(report / 'cache'), 'HF_HOME': str(report / 'hf')}
        stages = plan(root, report, baseline, env, 'registered', None)
        assert [stage.id for stage in stages] == baseline['sequence']
        assert len(stages) == 12
        python = next(stage for stage in stages if stage.id == 'python-unit')
        assert 'native-ui/tests/test_p1_profile_bootstrap.py' in python.command[-1]
        assert not (report / 'run-ledger.json').exists()


@pytest.fixture
def workspace(tmp_path):
    root = (tmp_path / "repository").resolve()
    root.mkdir()
    files = ["script/registered_run/native_stage.py", "tests/test_existing.py", "native-ui/example.test.cjs",
             "frontend/src/example.test.ts"]
    for name in files:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Planning fixture only; never executed.\n")
    (root / ".tools/reports").mkdir(parents=True)
    report = root / ".tools/local/package/run-1"
    report.mkdir(parents=True)
    isolation = root / ".tools/local/package/isolated"
    for name in ("data", "tmp", "cache", "hf"):
        (isolation / name).mkdir(parents=True)
    config = {
        "package": "process-test", "runKind": "formal", "sourceHead": "a" * 40,
        "python": ".venv/bin/python", "node": ".tools/node/bin/node", "ctest": "/usr/bin/ctest",
        "pythonTargets": ["tests/test_existing.py"], "nodeTests": ["native-ui/example.test.cjs"],
        "frontendTests": ["frontend/src/example.test.ts"],
        "nativeTargets": ["persona-card-confirmation", "runtime-bridge"],
        "nativeExecutionOrder": ["persona-card-confirmation", "runtime-bridge"],
        "nativeSelector": "^(persona-card-confirmation|runtime-bridge)$",
        "candidateName": "registered-fixture", "candidateDirectory": ".tools/qt-candidates/registered-fixture",
        "cmakeDirectory": ".tools/qt-builds/registered-fixture", "localSdk": ".tools/sdk",
        "timeoutsSeconds": {"sdk-build": 600, "python-unit": 300, "node-unit": 120,
                            "frontend-unit": 120, "native-unit": 300},
        "guiModes": [{"stage": mode + "-check", "option": option,
                      **({"modifier": "--candidate-paging"} if mode == "candidate" else {})}
                     for mode, option in [("injection", "--p1-worldbook-injection"),
                         ("regex", "--p1-worldbook-regex"), ("entry", "--p1-worldbook-entry"),
                         ("persona", "--p1-persona"), ("candidate", "--p1-memory"),
                         ("ordinary", "--p1-memory"), ("settings", "--p1-settings")]],
        "sequence": ["sdk-build", "python-unit", "node-unit", "frontend-unit", "native-unit",
                     "injection-check", "regex-check", "entry-check", "persona-check", "candidate-check",
                     "ordinary-check", "settings-check"],
    }
    for key, name, variable, _ in NATIVE_GROUPS:
        config[key] = {"path": "native-ui/contract.json", "sha256": "0" * 64,
                       "outputDirectory": ".tools/reports/OLD/" + name,
                       "verdictPath": ".tools/reports/OLD/" + name + "-verdict.json",
                       "environmentVariable": variable,
                       "nativeStageWrapper": {"path": ".tools/reports/OLD/native-stage.py", "sha256": "0" * 64},
                       "pairedConsumer": {"path": "native-ui/joint-consumer.cjs"}}
    env = {"REVERIE_DATA_DIR": str(isolation / "data"), "TMPDIR": str(isolation / "tmp") + "/",
           "XDG_CACHE_HOME": str(isolation / "cache"), "HF_HOME": str(isolation / "hf"),
           "QT_QPA_PLATFORM": "offscreen", "QML_DISABLE_DISK_CACHE": "1"}
    return root, report, config, env


def test_local_full_plans_only_four_unit_stages_and_actual_node_identity_report(workspace):
    root, report, config, env = workspace
    specs = plan(root, report, config, env, "full", None)
    assert [spec.id for spec in specs] == ["python-unit", "node-unit", "frontend-unit", "native-unit"]
    assert all(not spec.capture_pointer for spec in specs)
    python = specs[0]
    assert python.command[1:4] == ["-I", "-B", "-c"]
    assert "'-x'" in python.command[-1] and "junit_family=legacy" in python.command[-1]
    node = specs[1]
    assert node.command.count("--test") == 1
    assert "--test-reporter=tap" in node.command
    assert sum(value.startswith("--test-reporter=") for value in node.command) == 2
    assert sum(value.startswith("--test-reporter-destination=") for value in node.command) == 2
    runtime = load_runtime_config(report)
    assert runtime["runKind"] == "local" and runtime["candidateName"] is None
    assert runtime["cmakeDirectory"] == runtime["candidateDirectory"] == ".tools/qt-builds/local-process-test"
    assert runtime["nodeIdentityReport"] == "node-identities.jsonl"


def test_registered_plan_retains_twelve_stage_order_and_sdk_pointer_capture(workspace):
    root, report, config, env = workspace
    specs = plan(root, report, config, env, "registered")
    assert [spec.id for spec in specs] == config["sequence"]
    assert specs[0].capture_pointer is True
    assert all(not spec.capture_pointer for spec in specs[1:])
    assert specs[4].timeout == 300
    assert "script/registered_run/native_stage.py" in specs[4].command[3]
    assert ".tools/reports/OLD" not in " ".join(specs[4].command)


def test_local_build_uses_incremental_package_argument_without_candidate_or_cmake_flag(workspace):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "build")
    assert spec.command[1:3] == ["--local-package", "process-test"]
    assert "--candidate" not in spec.command and "--cmake-dir" not in spec.command
    assert spec.capture_pointer is False


def test_runtime_config_rebases_all_native_output_references_and_binds_tracked_wrapper(workspace):
    root, report, config, _ = workspace
    rebound = runtime_config(root, report, config, local=False)
    for key, name, _, _ in NATIVE_GROUPS:
        assert root / rebound[key]["outputDirectory"] == report / name
        assert root / rebound[key]["verdictPath"] == report / (name + "-verdict.json")
        assert rebound[key]["nativeStageWrapper"]["path"] == "script/registered_run/native_stage.py"
        assert len(rebound[key]["nativeStageWrapper"]["sha256"]) == 64
    assert config["nativeEvidenceContract"]["outputDirectory"].startswith(".tools/reports/OLD")


def test_arbitrary_config_commands_are_never_used(workspace):
    root, report, config, env = workspace
    config["command"] = ["/bin/sh", "-c", "untrusted"]
    config["stages"] = [{"id": "python-unit", "command": config["command"]}]
    spec, = plan(root, report, config, env, "python", ["tests/test_existing.py::test_one"])
    assert spec.command[0] == str(root / ".venv/bin/python")
    assert "/bin/sh" not in spec.command and "untrusted" not in spec.command


@pytest.mark.parametrize(("category", "selection"), [
    ("python", ["../outside.py"]), ("python", ["--override"]),
    ("node", ["tests/test_existing.py"]), ("native", ["missing-target"]),
    ("native", ["runtime-bridge::--help"]), ("gui", ["missing-mode"]),
    ("full", ["tests/test_existing.py"]), ("registered", ["python-unit"]),
])
def test_planner_rejects_invalid_or_scope_changing_selection(workspace, category, selection):
    root, report, config, env = workspace
    with pytest.raises((PlanError, MeasurementError)):
        plan(root, report, config, env, category, selection)


def test_focused_native_plans_measurement_without_full_consumer_callback(workspace):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "native", ["runtime-bridge::RuntimeBridgeTest::caseName(data-row)"])
    assert spec.command[3] == str(root / "script/registered_run/measurement.py")
    assert spec.command[-2:] == ["--select", "runtime-bridge::RuntimeBridgeTest::caseName(data-row)"]
    engine, row = SimpleNamespace(ledger={}), {}
    spec.before_start(engine, row)
    spec.after_exit(engine, row)
    assert row["runtimeConfigBinding"]["checks"][-2:] == ["after-exit:before", "after-exit:after"]
    assert all(not (report / name).exists() for _, name, _, _ in NATIVE_GROUPS)
    assert "native_stage.py" not in " ".join(spec.command)


def test_cache_contrast_is_explicit_and_uses_only_current_run_isolated_cache(workspace):
    root, report, config, env = workspace
    config["measurement"] = {"qmlCacheEnabled": True}
    spec, = plan(root, report, config, env, "native", ["persona-card-confirmation"])
    assert "--cache-enabled" in spec.command
    cache = Path(env["XDG_CACHE_HOME"]) / "qml-disk"
    assert spec.command[spec.command.index("--cache-dir") + 1] == str(cache)
    assert not cache.exists()
    spec.before_start(SimpleNamespace(ledger={}), {})
    assert cache.is_dir()


def test_gui_snapshot_is_captured_immediately_before_launch_and_failure_provenance_remains(workspace):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "gui", ["regex"])
    snapshot_path = report / "regex-check-report-roots-before.json"
    assert not snapshot_path.exists()
    (root / ".tools/reports/qt-before-launch").mkdir()
    engine = SimpleNamespace(ledger={})
    row = {}
    spec.before_start(engine, row)
    snapshot = json.loads(snapshot_path.read_text())
    assert snapshot["roots"] == [".tools/reports/qt-before-launch"]
    (report / "regex-check.log").write_text("failed before producing a Qt report\n")
    spec.after_exit(engine, row)
    assert "summaryLocateError" in engine.ledger["guiResults"]["regex-check"]


def test_native_wrapper_stops_before_joint_consumer_when_ctest_fails(workspace, monkeypatch):
    root, report, config, env = workspace
    runtime = runtime_config(root, report, config, local=False)
    for _, name, variable, _ in NATIVE_GROUPS:
        env[variable] = str(report / name)
    calls = []
    def failed_ctest(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=7)
    monkeypatch.setattr("script.registered_run.native_stage.subprocess.run", failed_ctest)
    assert run_native(RunContext(root, report, runtime), env) == 7
    assert len(calls) == 1 and calls[0][0] == config["ctest"]
    assert all((report / name).is_dir() for _, name, _, _ in NATIVE_GROUPS)


def test_native_wrapper_rejects_one_unbound_environment_path_before_running(workspace, monkeypatch):
    root, report, config, env = workspace
    runtime = runtime_config(root, report, config, local=False)
    for _, name, variable, _ in NATIVE_GROUPS:
        env[variable] = str(report / name)
    env["REVERIE_P1_NATIVE_EVIDENCE_DIR"] += "-wrong"
    monkeypatch.setattr("script.registered_run.native_stage.subprocess.run",
                        lambda *args, **kwargs: pytest.fail("No process may start"))
    with pytest.raises(RuntimeError, match="ENVIRONMENT_NOT_BOUND"):
        run_native(RunContext(root, report, runtime), env)


def test_ctest_mapping_uses_actual_generated_target_executable_and_known_options(tmp_path):
    build = (tmp_path / "build").resolve()
    build.mkdir()
    executable = build / "PersonaCardConfirmationTest"
    executable.write_bytes(b"not an executable; parser fixture only")
    (build / "CTestTestfile.cmake").write_text(
        'add_test("persona-card-confirmation" "' + str(executable) + '" "-maxwarnings" "0")\n')
    assert ctest_commands(build, ["persona-card-confirmation"]) == {
        "persona-card-confirmation": [str(executable), "-maxwarnings", "0"]}
    (build / "CTestTestfile.cmake").write_text(
        'add_test("persona-card-confirmation" "/bin/sh" "-c" "anything")\n')
    with pytest.raises(MeasurementError, match="CTEST_EXECUTABLE_OUTSIDE_BUILD"):
        ctest_commands(build, ["persona-card-confirmation"])


@pytest.mark.parametrize(("value", "expected"), [
    ("runtime-bridge", ("runtime-bridge", None)),
    ("runtime-bridge::myFunction", ("runtime-bridge", "myFunction")),
    ("runtime-bridge::RuntimeBridgeTest::myFunction(591x546)", ("runtime-bridge", "myFunction:591x546")),
])
def test_native_selection_preserves_function_and_real_data_tag(value, expected):
    assert split_native_selection(value, ["runtime-bridge"]) == expected


def _xml(tmp_path, duration="12.5", incident="pass"):
    path = tmp_path / "qtest.xml"
    path.write_text('<TestCase name="PersonaCardConfirmationTest">'
                    '<TestFunction name="manyRows"><Incident type="' + incident + '"><DataTag>a</DataTag></Incident>'
                    '<Incident type="pass"><DataTag>b</DataTag></Incident><Duration msecs="' + duration + '"/>'
                    '</TestFunction><TestFunction name="initTestCase"><Incident type="pass"/>'
                    '<Duration msecs="1.25"/></TestFunction><Duration msecs="15"/></TestCase>')
    return path


def test_measurement_reads_actual_xml_function_duration_without_inventing_per_row_cost(tmp_path):
    path = _xml(tmp_path)
    report = parse_qtest_xml(path, "persona-card-confirmation")
    first = report["functions"][0]
    assert first["function"] == "manyRows" and first["durationMs"] == 12.5
    assert first["observedDataTags"] == ["a", "b"]
    assert "whole-test-function" in first["durationGranularity"]
    assert "QML compilation" in report["unmeasured"]
    summary = summarize_measurements([("persona-card-confirmation", path)])
    assert summary["costBreakdownAvailable"] is False and summary["acceptanceEligible"] is False


def test_measurement_rejects_nonfinite_duration(tmp_path):
    with pytest.raises(MeasurementError, match="DURATION_INVALID"):
        parse_qtest_xml(_xml(tmp_path, duration="nan"))


def test_measurement_keeps_failure_status_instead_of_claiming_pass(tmp_path):
    assert parse_qtest_xml(_xml(tmp_path, incident="fail"))["allPassed"] is False


def test_cache_comparison_requires_explicit_isolated_subdirectory(workspace):
    root, _, _, env = workspace
    cache = Path(env["XDG_CACHE_HOME"]) / "qml"
    cache.mkdir()
    enabled = cache_environment(env, cache, enabled=True, root=root)
    assert "QML_DISABLE_DISK_CACHE" not in enabled
    assert enabled["QML_DISK_CACHE_PATH"] == str(cache)
    assert env["QML_DISABLE_DISK_CACHE"] == "1"
    outside = root / ".tools/outside-cache"
    outside.mkdir()
    with pytest.raises(MeasurementError, match="NOT_INSIDE_ISOLATED_CACHE"):
        cache_environment(env, outside, enabled=True, root=root)


@pytest.mark.parametrize("callback", ["after_exit", "verify"])
def test_runtime_config_binding_rejects_modification_between_launch_and_exit(workspace, callback):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "python", ["tests/test_existing.py::test_one"])
    engine, row = SimpleNamespace(ledger={}), {}
    spec.before_start(engine, row)
    path = report / "runtime-config.json"
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(PlanError, match="RUNTIME_CONFIG_BYTES_CHANGED"):
        getattr(spec, callback)(engine, row)
    assert row["runtimeConfigBinding"]["sha256"] == engine.ledger["runtimeConfigBinding"]["sha256"]
    assert row["runtimeConfigBinding"]["checks"] == ["before-start:before", "before-start:after"]


def test_runtime_config_binding_runs_before_gui_snapshot_callback(workspace):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "gui", ["regex"])
    path = report / "runtime-config.json"
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(PlanError, match="RUNTIME_CONFIG_BYTES_CHANGED"):
        spec.before_start(SimpleNamespace(ledger={}), {})
    assert not (report / "regex-check-report-roots-before.json").exists()


def test_runtime_config_binding_rechecks_after_host_verifier_callback(workspace, monkeypatch):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "python", ["tests/test_existing.py::test_one"])
    path = report / "runtime-config.json"
    def mutate_config_during_parse(*args, **kwargs):
        path.write_bytes(path.read_bytes() + b"\n")
        return {"counts": {"total": 1}}
    monkeypatch.setattr("script.registered_run.stages._actual_report", mutate_config_during_parse)
    with pytest.raises(PlanError, match="RUNTIME_CONFIG_BYTES_CHANGED"):
        spec.verify(SimpleNamespace(ledger={}), {})


def test_runtime_config_binding_records_exact_expected_bytes_and_checks(workspace):
    root, report, config, env = workspace
    spec, = plan(root, report, config, env, "python", ["tests/test_existing.py::test_one"])
    engine, row = SimpleNamespace(ledger={}), {}
    spec.before_start(engine, row)
    spec.after_exit(engine, row)
    binding = row["runtimeConfigBinding"]
    assert binding["path"] == str((report / "runtime-config.json").relative_to(root))
    assert binding["bytes"] == (report / "runtime-config.json").stat().st_size
    assert len(binding["sha256"]) == 64
    assert binding["checks"] == ["before-start:before", "before-start:after", "after-exit:before", "after-exit:after"]


def _focused_fake_target(workspace):
    """Non-executable files and a generated CTest record; child is mocked."""
    root, report, config, environment = workspace
    config = deepcopy(config)
    config["nativeTargets"] = ["persona-card-confirmation"]
    build = root / config["cmakeDirectory"]
    build.mkdir(parents=True)
    executable = build / "PersonaCardConfirmationTest"
    executable.write_bytes(b"Unit fixture only; never executed")
    (build / "CTestTestfile.cmake").write_text(
        'add_test("persona-card-confirmation" "' + str(executable) + '" "-maxwarnings" "0")\n')
    environment = dict(environment)
    environment["REVERIE_P1_CONTROL_RECEIPT_DIR"] = str(report / "control-receipt")
    for _, name, variable, _ in NATIVE_GROUPS:
        environment[variable] = str(report / name)
    return root, report, config, environment


def _fake_qtest_xml(argv):
    xml = Path(argv[-1].removesuffix(",xml"))
    xml.write_text('<TestCase name="RuntimeBridgeTest"><TestFunction name="unitFixtureOnly">'
                   '<Incident type="pass"/><Duration msecs="1"/></TestFunction><Duration msecs="1"/></TestCase>')


def test_whole_persona_measurement_prepares_all_six_fresh_capture_directories_before_child(workspace, monkeypatch):
    root, report, config, environment = _focused_fake_target(workspace)
    calls = []
    def fake_qtest(argv, *, cwd, env):
        calls.append(argv)
        assert cwd == root
        for _, name, variable, _ in NATIVE_GROUPS:
            assert env[variable] == str(report / name)
            assert (report / name).is_dir()
        assert "REVERIE_P1_CONTROL_RECEIPT_DIR" not in env
        _fake_qtest_xml(argv)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr("script.registered_run.measurement.subprocess.run", fake_qtest)
    assert run_selected(root, report, config, ["persona-card-confirmation"], environment) == 0
    assert len(calls) == 1
    summary = json.loads((report / "qtest-measurements.json").read_text())
    assert summary["nativeEvidenceExportsPrepared"] is True
    assert len(summary["nativeEvidenceExportDirectories"]) == 6
    assert summary["invocations"][0]["nativeEvidenceCaptureEnabled"] is True
    assert summary["jointEvidenceConsumerExecuted"] is False
    assert summary["fullNativeContractExecuted"] is False
    assert not list(report.glob("*-verdict.json"))


def test_whole_persona_measurement_refuses_existing_capture_directory_without_overwriting(workspace, monkeypatch):
    root, report, config, environment = _focused_fake_target(workspace)
    existing = report / "native-regex-evidence"
    existing.mkdir()
    original = existing / "preserved-negative-fixture.json"
    original.write_bytes(b"preserve original bytes")
    monkeypatch.setattr("script.registered_run.measurement.subprocess.run",
                        lambda *args, **kwargs: pytest.fail("Freshness failure must precede child launch"))
    with pytest.raises(MeasurementError, match="EVIDENCE_NOT_FRESH"):
        run_selected(root, report, config, ["persona-card-confirmation"], environment)
    assert original.read_bytes() == b"preserve original bytes"
    assert all(not (report / name).exists() for _, name, _, _ in NATIVE_GROUPS if name != existing.name)


def test_persona_function_data_row_measurement_disables_optional_capture_environment(workspace, monkeypatch):
    root, report, config, environment = _focused_fake_target(workspace)
    def fake_qtest(argv, *, cwd, env):
        assert "nativeInputEvidenceProducedForHost:persona-row-default-success" in argv
        assert all(variable not in env for _, _, variable, _ in NATIVE_GROUPS)
        assert "REVERIE_P1_CONTROL_RECEIPT_DIR" not in env
        _fake_qtest_xml(argv)
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr("script.registered_run.measurement.subprocess.run", fake_qtest)
    selection = "persona-card-confirmation::RuntimeBridgeTest::nativeInputEvidenceProducedForHost(persona-row-default-success)"
    assert run_selected(root, report, config, [selection], environment) == 0
    summary = json.loads((report / "qtest-measurements.json").read_text())
    assert summary["nativeEvidenceExportsPrepared"] is False
    assert summary["nativeEvidenceExportDirectories"] == []
    assert summary["invocations"][0]["nativeEvidenceCaptureEnabled"] is False
    assert summary["jointEvidenceConsumerExecuted"] is False
    assert all(not (report / name).exists() for _, name, _, _ in NATIVE_GROUPS)


@pytest.mark.parametrize("selection", ["runtime-bridge",
    "runtime-bridge::RuntimeBridgeTest::realPythonInspectionFramePreservesEnvelopeAndCompletesPendingRequest()"])
def test_unpaired_runtime_backup_consumer_is_refused_before_any_child(workspace, monkeypatch, selection):
    root, report, config, environment = workspace
    monkeypatch.setattr("script.registered_run.measurement.subprocess.run",
                        lambda *args, **kwargs: pytest.fail("Paired producer is required before child launch"))
    with pytest.raises(MeasurementError, match="REQUIRES_FULL_PAIRED_BATCH"):
        run_selected(root, report, config, [selection], environment)


@pytest.mark.parametrize(("target", "name"), [
    ("header-open-observation", "HeaderOpenObservationTest"),
    ("preview-workspace", "PreviewWorkspaceTest"),
    ("preview-snapshot", "PreviewSnapshotTest"),
    ("preview-events", "PreviewEventsTest"),
    ("preview-platform", "PreviewPlatformTest"),
    ("preview-data-format", "PreviewDataFormatTest"),
    ("preview-restore", "PreviewRestoreTest"),
])
def test_preview_focused_targets_bind_their_actual_executable_and_reject_substitution(tmp_path, target, name):
    build = (tmp_path / "build").resolve()
    build.mkdir()
    executable = build / name
    executable.write_bytes(b"parser fixture; never executed")
    registration = build / "CTestTestfile.cmake"
    registration.write_text('add_test("' + target + '" "' + str(executable) + '")\n')
    assert ctest_commands(build, [target]) == {target: [str(executable)]}
    wrong = build / "AnotherTest"
    wrong.write_bytes(b"unregistered parser fixture; never executed")
    registration.write_text('add_test("' + target + '" "' + str(wrong) + '")\n')
    with pytest.raises(MeasurementError, match="CTEST_EXECUTABLE_OUTSIDE_BUILD"):
        ctest_commands(build, [target])


def test_platform_contract_focused_target_binds_real_executable_and_rejects_substitution(tmp_path):
    build = (tmp_path / "build").resolve()
    build.mkdir()
    executable = build / "PlatformContractTest"
    executable.write_bytes(b"parser fixture; never executed")
    registration = build / "CTestTestfile.cmake"
    registration.write_text('add_test("platform-contract" "' + str(executable) + '")\n')
    assert ctest_commands(build, ["platform-contract"]) == {"platform-contract": [str(executable)]}
    substitute = build / "AnotherTest"
    substitute.write_bytes(b"unregistered parser fixture; never executed")
    registration.write_text('add_test("platform-contract" "' + str(substitute) + '")\n')
    with pytest.raises(MeasurementError, match="^CTEST_EXECUTABLE_OUTSIDE_BUILD$"):
        ctest_commands(build, ["platform-contract"])
