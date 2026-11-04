"""Closed argv planners shared by local and registered orchestration.

Configuration is data: command strings or prior runner argv are never executed.
The fixed tools below construct every stage argument list. Only the registered
category includes SDK build and all GUI stages; local full means four unit
stages and requires an earlier explicit local package build.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

from .catalog import (GUI_MODES, NATIVE_GROUPS, capture_report_roots, locate_summary,
                      verify_mode, verify_native_evidence, verify_stage)
from .engine import StageSpec
from . import identities
from .isolation import assert_not_data_path
from .measurement import split_native_selection, summarize_measurements, validate_unpaired_selection
from .modes.context import RunContext
from .preview import (MODE as PREVIEW_MODE, STAGE as PREVIEW_STAGE, BUDGET as PREVIEW_BUDGET,
                      command as preview_command, effective_modes, _read_json as read_preview_json,
                      PreviewError, validate_extension)
from .export_config import STAGE_BUDGETS


class PlanError(ValueError):
    pass


def _need(condition, code):
    if not condition:
        raise PlanError(code)


def _relative(value, code="SELECTION_PATH_INVALID"):
    _need(isinstance(value, str) and value and not any(c in value for c in "\0\n\r\\"), code)
    path = PurePosixPath(value)
    _need(not path.is_absolute() and ".." not in path.parts and path.parts[0] != "data", code)
    return path.as_posix()


def _source_file(root, name):
    path = root / _relative(name)
    assert_not_data_path(path, root)
    _need(path.resolve().is_relative_to(root) and path.is_file() and not path.is_symlink(),
          "TEST_SOURCE_FILE_INVALID")
    return path


def _selections(selection):
    if selection is None:
        return []
    values = [selection] if isinstance(selection, str) else list(selection)
    _need(all(isinstance(value, str) and value and not value.startswith("-") and
              not any(c in value for c in "\0\n\r") for value in values), "SELECTION_INVALID")
    _need(len(values) == len(set(values)), "SELECTION_REPEATED")
    return values


def runtime_config(root, report_dir, config, *, local):
    """Rebind run-owned output references; preserve all immutable contracts."""
    root, report = Path(root).resolve(strict=True), Path(report_dir).absolute()
    _need(report.is_relative_to(root), "REPORT_OUTSIDE_REPOSITORY")
    result = deepcopy(dict(config))
    result["nodeIdentityReport"] = "node-identities.jsonl"
    result.pop("baselineSource", None)
    if local:
        # Local runs of current source use the new independent addition. This
        # does not mutate exported baseline configs or old registered replays.
        result.setdefault("cardExportContract", "v1")
        result.setdefault("cardEditContract", "v1")
        package = result.get("package", result.get("localPackage"))
        _need(isinstance(package, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,63}", package),
              "LOCAL_PACKAGE_REQUIRED")
        result["package"] = package
        result["runKind"] = "local"
        result["adoptCandidate"] = False
        result["cmakeDirectory"] = ".tools/qt-builds/local-" + package
        result["candidateDirectory"] = result["cmakeDirectory"]
        result["candidateName"] = None
        record = root / result["candidateDirectory"] / "build.json"
        if record.is_file():
            build = json.loads(record.read_text())
            _need(build.get("localIteration", {}).get("package") == package and
                  build.get("localIteration", {}).get("acceptanceEligible") is False,
                  "LOCAL_BUILD_PACKAGE_BINDING_CHANGED")
            _need(build.get("candidate") is None, "LOCAL_BUILD_CANDIDATE_FORBIDDEN")
            result["sourceHead"] = build.get("source", {}).get("head")
    wrapper = root / "script/registered_run/native_stage.py"
    wrapper_record = {"path": str(wrapper.relative_to(root)),
                      "sha256": hashlib.sha256(wrapper.read_bytes()).hexdigest(),
                      "bytes": wrapper.stat().st_size}
    for key, name, _, _ in NATIVE_GROUPS:
        if key not in result:
            continue
        spec = result[key]
        spec["outputDirectory"] = str((report / name).relative_to(root))
        spec["verdictPath"] = str((report / (name + "-verdict.json")).relative_to(root))
        if "nativeStageWrapper" in spec:
            spec["nativeStageWrapper"] = deepcopy(wrapper_record)
    return result


def load_runtime_config(report_dir):
    return json.loads((Path(report_dir) / "runtime-config.json").read_text())


def _save_config(report, config):
    path = report / "runtime-config.json"
    payload = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    if os.path.lexists(path):
        _need(path.is_file() and not path.is_symlink() and path.read_text() == payload,
              "RUNTIME_CONFIG_ALREADY_BOUND_DIFFERENTLY")
    else:
        with path.open("x", encoding="utf-8") as stream:
            stream.write(payload)
    return path


def _actual_report(context, kind, targets):
    report, root = context.report_dir, context.root
    if kind == "python":
        parsed = identities.parse_pytest_junit((report / "python-unit.xml").read_text(),
                                              list(dict.fromkeys(value.split("::", 1)[0] for value in targets)))
    elif kind == "node":
        parsed = identities.parse_node_identity_events((report / "node-identities.jsonl").read_text(), targets, root)
    elif kind == "frontend":
        parsed = identities.parse_frontend_json(json.loads((report / "frontend-unit.json").read_text()), targets, root)
    elif kind == "native":
        ctest = identities.parse_ctest_junit((report / "native-unit.xml").read_text(), targets)
        qtest = identities.parse_qtest_transcript((report / "native-lasttest.log").read_text())
        _need(set(row["target"] for row in qtest["cases"]) == set(targets), "LOCAL_NATIVE_TARGET_SET_CHANGED")
        parsed = identities.combine_reports([ctest, qtest])
    else:
        raise PlanError("UNKNOWN_ACTUAL_IDENTITY_KIND")
    identities.require_all_passed(parsed)
    return parsed


def plan(root, report_dir, config, environment, category, selection=None):
    """Return fixed StageSpec objects and save the exact runtime data config.

    Native focus selectors use target::function or
    target::TestClass::function(data-tag). No focused result claims the complete
    six-group/backup native contract. Stages never read an old report directory.
    """
    root, report = Path(root).resolve(strict=True), Path(report_dir).absolute()
    _need(report.is_dir() and not report.is_symlink(), "REPORT_DIRECTORY_REQUIRED")
    _need(category in ("registered", "build", "python", "node", "frontend", "native", "gui", "full"),
          "UNKNOWN_RUN_CATEGORY")
    selected = _selections(selection)
    local = category != "registered"
    reg = runtime_config(root, report, config, local=local)
    try:
        validate_extension(reg, list(STAGE_BUDGETS))
    except PreviewError as error:
        raise PlanError(str(error)) from error
    config_path = _save_config(report, reg)
    bound_config_bytes = config_path.read_bytes()
    config_binding = {"path": str(config_path.relative_to(root)), "bytes": len(bound_config_bytes),
                      "sha256": hashlib.sha256(bound_config_bytes).hexdigest()}
    context = RunContext(root, report, reg)
    env = dict(environment)
    evidence_env = {"REVERIE_P1_CONTROL_RECEIPT_DIR": str(report / "control-receipt"),
                    **{variable: str(report / name) for _, name, variable, _ in NATIVE_GROUPS}}
    env.update(evidence_env)
    py = str(root / _relative(reg["python"], "PYTHON_EXECUTABLE_PATH_INVALID"))
    node = str(root / _relative(reg["node"], "NODE_EXECUTABLE_PATH_INVALID"))
    timeouts = reg["timeoutsSeconds"]

    def verify_runtime_binding(engine, row, label):
        metadata = row.setdefault("runtimeConfigBinding", {**config_binding, "checks": []})
        _need(all(metadata.get(key) == value for key, value in config_binding.items()),
              "RUNTIME_CONFIG_BINDING_METADATA_CHANGED")
        ledger_binding = engine.ledger.setdefault("runtimeConfigBinding", deepcopy(config_binding))
        _need(ledger_binding == config_binding, "RUNTIME_CONFIG_LEDGER_BINDING_CHANGED")
        _need(config_path.is_file() and not config_path.is_symlink(), "RUNTIME_CONFIG_FILE_CHANGED")
        observed = config_path.read_bytes()
        _need(observed == bound_config_bytes and len(observed) == config_binding["bytes"] and
              hashlib.sha256(observed).hexdigest() == config_binding["sha256"],
              "RUNTIME_CONFIG_BYTES_CHANGED")
        metadata["checks"].append(label)

    def stage(id, command, *, budget=None, verify=None, after_exit=None, before_start=None,
              cwd=root, stage_env=env, capture_pointer=False, check_category=None, check_selection=None):
        def guarded_before(engine, row):
            verify_runtime_binding(engine, row, "before-start:before")
            if before_start is not None:
                before_start(engine, row)
            verify_runtime_binding(engine, row, "before-start:after")
        def guarded_after(engine, row):
            verify_runtime_binding(engine, row, "after-exit:before")
            if after_exit is not None:
                after_exit(engine, row)
            verify_runtime_binding(engine, row, "after-exit:after")
        def guarded_verify(engine, row):
            verify_runtime_binding(engine, row, "verify:before")
            evidence = verify(engine, row) if verify is not None else None
            verify_runtime_binding(engine, row, "verify:after")
            return evidence
        return StageSpec(id=id, command=command, cwd=cwd, env=stage_env, budget=budget,
                         timeout=timeouts.get(id, 300), verify=guarded_verify, after_exit=guarded_after,
                         log_name=id + ".log", capture_pointer=capture_pointer, before_start=guarded_before,
                         check_category=check_category, selection=deepcopy(check_selection))

    def unit_verifier(kind, targets, complete=False):
        def verify(engine, row):
            if not local:
                observed = verify_stage(context, kind + "-unit")
                if kind == "native":
                    _need(observed["capturedControlReceipt"] == engine.ledger.get("capturedControlReceipt"),
                          "PAIRED_CONTROL_RECEIPT_CHANGED_DURING_CONSUMER")
                    observed["pairedControlReceiptUnchangedAfterNative"] = True
                # New actual file-qualified Node identities supplement the old
                # strict TAP/global-name contract in the same process.
                actual = _actual_report(context, kind, targets)
                observed[kind + "ActualIdentities"] = actual
                return observed
            actual = _actual_report(context, kind, targets)
            observed = {kind + "ActualIdentities": actual,
                        kind + "LocalEvidence": {"counts": actual["counts"], "allPassed": True,
                                                  "fullSelection": complete, "acceptanceEligible": False}}
            if kind == "python" and complete:
                observed["capturedControlReceipt"] = context.invoke("verify_control_receipt", report / "control-receipt", reg)
            elif kind == "native" and complete:
                observed.update(verify_native_evidence(context))
                captured = context.invoke("verify_control_receipt", report / "control-receipt", reg)
                _need(captured == engine.ledger.get("capturedControlReceipt"),
                      "PAIRED_CONTROL_RECEIPT_CHANGED_DURING_CONSUMER")
                observed["pairedControlReceiptUnchangedAfterNative"] = True
                transcript = (report / "native-lasttest.log").read_text()
                observed["nativeDiagnostics"] = {
                    "memoryFeedbackProbeDiagnostics": context.invoke("verify_feedback_probe_diagnostics", transcript, reg),
                    "summaryInputProbeDiagnostics": context.invoke("verify_summary_input_probe_diagnostics", transcript, reg),
                    "summaryDirectoryDiagnostics": context.invoke("verify_directory_diagnostics", transcript, reg)}
            return observed
        return verify

    def python_stage(targets, complete):
        for target in targets:
            file, *suffix = target.split("::")
            _need(_relative(file).startswith(("tests/", "native-ui/tests/")) and file.endswith(".py") and _source_file(root, file) and
                  all(part and not part.startswith("-") for part in suffix), "PYTHON_SELECTION_INVALID")
        scratch = Path(environment["REVERIE_DATA_DIR"]).parent
        arguments = ["-x", "-q", "-p", "no:cacheprovider", *targets,
                     "--basetemp", str(scratch / "pytest"), "-o", "junit_family=legacy",
                     "--junitxml", str(report / "python-unit.xml")]
        code = ("import sys;sys.path.insert(0," + repr(str(root)) +
                ");import pytest;raise SystemExit(pytest.main(" + repr(arguments) + "))")
        return stage("python-unit", [py, "-I", "-B", "-c", code], budget="pythonBatch",
                     verify=unit_verifier("python", targets, complete), check_category="python", check_selection=list(targets))

    def node_stage(targets, complete):
        for target in targets:
            _need(_relative(target).endswith((".test.cjs", ".test.js", ".test.mjs")) and _source_file(root, target),
                  "NODE_SELECTION_INVALID")
        argv = [node, "--test", "--test-reporter=tap",
                "--test-reporter=" + str(root / "script/registered_run/node_identity_reporter.cjs"),
                "--test-reporter-destination=stdout", "--test-reporter-destination=" + str(report / "node-identities.jsonl"),
                *targets]
        return stage("node-unit", argv, budget="nodeBatch", verify=unit_verifier("node", targets, complete),
                     check_category="node", check_selection=list(targets))

    def frontend_stage(targets, complete):
        for target in targets:
            _need(_relative(target).startswith("frontend/") and _source_file(root, target), "FRONTEND_SELECTION_INVALID")
        argv = [node, str(root / "frontend/node_modules/vitest/vitest.mjs"), "run",
                *[str(PurePosixPath(path).relative_to("frontend")) for path in targets],
                "--reporter=json", "--outputFile", str(report / "frontend-unit.json"), "--bail=1",
                "--maxWorkers=1", "--no-file-parallelism", "--no-cache"]
        return stage("frontend-unit", argv, budget="frontendBatch", cwd=root / "frontend",
                     verify=unit_verifier("frontend", targets, complete), check_category="frontend", check_selection=list(targets))

    def copy_lasttest(engine, row):
        original = root / reg["cmakeDirectory"] / "Testing/Temporary/LastTest.log"
        if original.exists():
            with (report / "native-lasttest.log").open("xb") as stream:
                stream.write(original.read_bytes())

    def native_stage(targets, complete):
        if complete:
            argv = [py, "-I", "-B", str(root / "script/registered_run/native_stage.py"),
                    "--root", str(root), "--report", str(report), "--config", str(config_path)]
            return stage("native-unit", argv, budget="nativeBatch", after_exit=copy_lasttest,
                         verify=unit_verifier("native", reg["nativeTargets"], True),
                         check_category="native", check_selection=list(targets))
        focused_selections = []
        for value in targets:
            target, function = split_native_selection(value, reg["nativeTargets"])
            validate_unpaired_selection(target, function)
            focused_selections.append((target, function))
        focused_env = dict(env)
        focused_env["REVERIE_P1_CONTROL_RECEIPT_DIR"] = None
        if not any(function is None for _, function in focused_selections):
            for _, _, variable, _ in NATIVE_GROUPS:
                focused_env[variable] = None
        argv = [py, "-I", "-B", str(root / "script/registered_run/measurement.py"),
                "--root", str(root), "--report", str(report), "--config", str(config_path)]
        for value in targets:
            argv.extend(["--select", value])
        measurement = reg.get("measurement", {})
        _need(isinstance(measurement, dict) and set(measurement) <= {"qmlCacheEnabled"},
              "MEASUREMENT_CONFIGURATION_INVALID")
        prepare_cache = None
        if "qmlCacheEnabled" in measurement:
            enabled = measurement["qmlCacheEnabled"]
            _need(type(enabled) is bool, "QML_CACHE_ENABLED_MUST_BE_BOOLEAN")
            cache = Path(environment["XDG_CACHE_HOME"]) / "qml-disk"
            argv.extend(["--cache-dir", str(cache)])
            if enabled:
                argv.append("--cache-enabled")
            def prepare_cache(engine, row):
                _need(not os.path.lexists(cache), "QML_CACHE_DIRECTORY_NOT_FRESH")
                cache.mkdir(mode=0o700)
        def verify(engine, row):
            measurements = json.loads((report / "qtest-measurements.json").read_text())
            _need(measurements.get("allPassed") is True and measurements.get("fullNativeContractExecuted") is False and
                  measurements.get("jointEvidenceConsumerExecuted") is False, "FOCUSED_NATIVE_MEASUREMENT_INVALID")
            return {"nativeFocusedMeasurement": measurements, "measurements": measurements}
        return stage("native-unit", argv, budget="nativeBatch", verify=verify, before_start=prepare_cache,
                     check_category="native", check_selection=list(targets), stage_env=focused_env)

    def gui_stage(mode):
        _need(mode in effective_modes(reg, GUI_MODES), "GUI_MODE_NOT_REGISTERED")
        if mode == PREVIEW_MODE:
            output = report / PREVIEW_STAGE
            summary = output / "summary.json"
            isolation_root = Path(environment["REVERIE_DATA_DIR"]).parent
            saved = {"reportRoot": str(output)}

            def before_preview(engine, row):
                _need(not os.path.lexists(output), "PREVIEW_FRESH_REPORT_REQUIRED")
                output.mkdir(mode=0o700)
                row["previewIsolationRoot"] = str(isolation_root)
                engine.ledger.setdefault("guiResults", {})[PREVIEW_STAGE] = saved

            def after_preview(engine, row):
                if os.path.lexists(summary):
                    try:
                        _result, payload = read_preview_json(summary)
                        saved["summarySha256"] = hashlib.sha256(payload).hexdigest()
                    except Exception as error:
                        saved["summaryLocateError"] = type(error).__name__

            def verify_preview(engine, row):
                _need("summarySha256" in saved, "PREVIEW_SUMMARY_MISSING")
                saved.update(verify_mode(context, mode, summary, run_record=row, saved_record=saved))
                return {"guiResults": engine.ledger["guiResults"]}

            return stage(PREVIEW_STAGE, preview_command(root, reg, report, isolation_root),
                         budget=PREVIEW_BUDGET, stage_env=environment,
                         before_start=before_preview, after_exit=after_preview, verify=verify_preview,
                         check_category="gui", check_selection=[PREVIEW_MODE])
        id = mode + "-check"
        configured = [row for row in reg["guiModes"] if row["stage"] == id]
        _need(len(configured) == 1, "GUI_MODE_CONFIGURATION_MISSING")
        options = {"injection": ["--p1-worldbook-injection"], "regex": ["--p1-worldbook-regex"],
                   "entry": ["--p1-worldbook-entry"], "persona": ["--p1-persona"],
                   "candidate": ["--p1-memory", "--candidate-paging"], "ordinary": ["--p1-memory"],
                   "settings": ["--p1-settings"]}[mode]
        expected_options = [configured[0]["option"], *([configured[0]["modifier"]] if configured[0].get("modifier") else [])]
        _need(expected_options == options, "GUI_OPTIONS_CHANGED")
        saved = {}
        def before(engine, row):
            roots, snapshot = capture_report_roots(context, id)
            saved.update({"reportRootsBefore": len(roots), "reportRootsBeforeManifest": snapshot})
            engine.ledger.setdefault("guiResults", {})[id] = saved
        def after(engine, row):
            if (report / (id + ".log")).exists():
                try:
                    summary = locate_summary(context, id, saved["reportRootsBeforeManifest"])
                    saved.update({"reportRoot": str(summary.parent), "summarySha256": context.invoke("sha", summary)})
                except BaseException as error:
                    saved["summaryLocateError"] = str(error)
        def verify(engine, row):
            _need("reportRoot" in saved, id + ":SUMMARY_MISSING")
            saved.update(verify_mode(context, mode, Path(saved["reportRoot"]) / "summary.json",
                                     snapshot=saved["reportRootsBeforeManifest"], run_record=row))
            return {"guiResults": engine.ledger["guiResults"]}
        return stage(id, [str(root / "script/check-qt-macos.sh"), "--build-dir",
                          str(root / reg["candidateDirectory"]), *options],
                     budget={"injection": "injectionCheck", "regex": "regexCheck", "entry": "entryCheck",
                             "persona": "personaCheck", "candidate": "candidateCheck", "ordinary": "ordinaryCheck",
                             "settings": "settingsCheck"}[mode], stage_env=environment,
                     before_start=before, after_exit=after, verify=verify, check_category="gui", check_selection=[mode])

    def sdk_stage():
        argv = [str(root / "script/build-qt-macos.sh"), "--candidate", reg["candidateName"], "--cmake-dir",
                str(root / reg["cmakeDirectory"]), "--local-sdk", str(root / _relative(reg["localSdk"]))]
        return stage("sdk-build", argv, budget="sdkBuild", capture_pointer=True,
                     verify=lambda engine, row: verify_stage(context, "sdk-build"), stage_env=environment,
                     check_category="build", check_selection=[reg["cmakeDirectory"]])

    full_units = lambda: [python_stage(reg["pythonTargets"], True), node_stage(reg["nodeTests"], True),
                          frontend_stage(reg["frontendTests"], True), native_stage(reg["nativeTargets"], True)]
    if category == "registered":
        _need(not selected, "REGISTERED_SELECTION_OVERRIDE_FORBIDDEN")
        units = {spec.id: spec for spec in full_units()}
        units["sdk-build"] = sdk_stage()
        units.update({mode + "-check": gui_stage(mode) for mode in effective_modes(reg, GUI_MODES)})
        _need(set(reg["sequence"]) == set(units) and len(reg["sequence"]) == len(units), "REGISTERED_SEQUENCE_INVALID")
        return [units[id] for id in reg["sequence"]]
    if category == "full":
        _need(not selected, "FULL_SELECTION_OVERRIDE_FORBIDDEN")
        return full_units()
    if category == "build":
        _need(not selected, "BUILD_SELECTION_OVERRIDE_FORBIDDEN")
        argv = [str(root / "script/build-qt-macos.sh"), "--local-package", reg["package"]]
        if reg.get("localSdk"):
            argv.extend(["--local-sdk", str(root / _relative(reg["localSdk"]))])
        def verify_build(engine, row):
            record = context.invoke("load_json", root / reg["cmakeDirectory"] / "build.json")
            _need(record.get("candidate") is None and
                  record.get("localIteration", {}).get("package") == reg["package"] and
                  record.get("localIteration", {}).get("acceptanceEligible") is False and
                  record.get("compilation", {}).get("cmakeDirectory") == str(root / reg["cmakeDirectory"]),
                  "LOCAL_BUILD_RECORD_NOT_BOUND")
            return {"localBuildEvidence": {"directory": reg["cmakeDirectory"], "acceptanceEligible": False,
                                            "buildManifestSha256": context.invoke("sha", root / reg["cmakeDirectory"] / "build.json")}}
        return [stage("sdk-build", argv, budget="sdkBuild", stage_env=environment,
                      verify=verify_build, check_category="build", check_selection=[reg["cmakeDirectory"]])]
    if category == "python":
        return [python_stage(selected or reg["pythonTargets"], not selected)]
    if category == "node":
        return [node_stage(selected or reg["nodeTests"], not selected)]
    if category == "frontend":
        return [frontend_stage(selected or reg["frontendTests"], not selected)]
    if category == "native":
        _need(bool(selected), "FOCUSED_NATIVE_SELECTION_REQUIRED")
        return [native_stage(selected, False)]
    return [gui_stage(value.removesuffix("-check")) for value in (selected or list(effective_modes(reg, GUI_MODES)))]
