"""Read real QTest XML function timings and run explicitly selected Qt tests.

Qt 6.11.2 emits one Duration from leaveTestFunction(), including every data row
executed by that function. These values do not isolate QML loading, compilation
or waits. No cost breakdown is inferred here.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import xml.etree.ElementTree as ET

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from script.registered_run.isolation import assert_not_data_path, canonical_directory
from script.registered_run.catalog import NATIVE_GROUPS


SCHEMA = "reverie.registered-run.qtest-measurement.v1"
QML_CACHE_DOCUMENTATION = "https://doc.qt.io/qt-6.11/qmldiskcache.html"
QTEST_XML_SOURCE = "https://raw.githubusercontent.com/qt/qtbase/v6.11.2/src/testlib/qxmltestlogger.cpp"
TARGET_EXECUTABLES = {
    "timing-trace-off": "TimingTraceOffTest", "transition-diagnostics-off": "TransitionDiagnosticsOffTest",
    "avatar-transform": "AvatarTransformTest", "glass-pane-observer": "GlassPaneObserverTest",
    "chat-panel-virtualization": "ChatPanelVirtualizationTest", "shortcut-activation": "ShortcutActivationTest",
    "persona-card-confirmation": "PersonaCardConfirmationTest", "archive-drawer-scroll": "ArchiveDrawerScrollTest",
    "scene-director": "SceneDirectorTest", "control-readiness": "ControlReadinessTest",
    "archive-editor": "ArchiveEditorTest", "runtime-bridge": "RuntimeBridgeTest",
    "header-open-observation": "HeaderOpenObservationTest", "preview-workspace": "PreviewWorkspaceTest",
    "preview-snapshot": "PreviewSnapshotTest", "preview-events": "PreviewEventsTest",
    "preview-platform": "PreviewPlatformTest", "preview-data-format": "PreviewDataFormatTest",
    "preview-restore": "PreviewRestoreTest",
    "platform-contract": "PlatformContractTest",
}


class MeasurementError(ValueError):
    pass


def _need(condition, code):
    if not condition:
        raise MeasurementError(code)


def _msecs(element, code):
    _need(element is not None and set(element.attrib) == {"msecs"}, code)
    try:
        value = float(element.get("msecs"))
    except (TypeError, ValueError) as error:
        raise MeasurementError(code) from error
    _need(math.isfinite(value) and value >= 0, code)
    return value


def parse_qtest_xml(path, target=None):
    path = Path(path)
    _need(path.is_file() and not path.is_symlink(), "QTEST_XML_FILE_INVALID")
    root = ET.fromstring(path.read_bytes())
    _need(root.tag == "TestCase" and root.get("name"), "QTEST_XML_ROOT_INVALID")
    functions = []
    for function in root.findall("TestFunction"):
        name = function.get("name")
        _need(isinstance(name, str) and re.fullmatch(r"[A-Za-z_]\w*", name), "QTEST_FUNCTION_NAME_INVALID")
        durations = function.findall("Duration")
        _need(len(durations) == 1, "QTEST_FUNCTION_DURATION_MISSING_OR_REPEATED")
        incidents = function.findall("Incident")
        _need(incidents and all(incident.get("type") in
             ("pass", "fail", "skip", "xfail", "xpass", "bpass", "bfail") for incident in incidents),
             "QTEST_INCIDENT_MISSING_OR_UNKNOWN")
        tags = list(dict.fromkeys((incident.findtext("DataTag") or "") for incident in incidents))
        counts = dict(Counter(incident.get("type") for incident in incidents))
        functions.append({"target": target, "class": root.get("name"), "function": name,
                          "durationMs": _msecs(durations[0], "QTEST_FUNCTION_DURATION_INVALID"),
                          "durationGranularity": "whole-test-function-including-selected-data-rows",
                          "observedDataTags": tags, "incidents": counts,
                          "allPassed": counts == {"pass": len(incidents)},
                          "lifecycle": name in ("initTestCase", "cleanupTestCase")})
    _need(functions and len({row["function"] for row in functions}) == len(functions),
          "QTEST_FUNCTIONS_MISSING_OR_REPEATED")
    durations = root.findall("Duration")
    _need(len(durations) == 1, "QTEST_TOTAL_DURATION_MISSING_OR_REPEATED")
    return {"schema": SCHEMA, "sourceXml": str(path), "target": target, "class": root.get("name"),
            "totalDurationMs": _msecs(durations[0], "QTEST_TOTAL_DURATION_INVALID"),
            "functions": sorted(functions, key=lambda row: (-row["durationMs"], row["function"])),
            "allPassed": all(row["allPassed"] for row in functions),
            "unmeasured": ["QML loading", "QML compilation", "waiting", "other work inside each function"],
            "timingSource": {"qtVersion": "6.11.2", "source": QTEST_XML_SOURCE,
                             "emitter": "QXmlTestLogger::leaveTestFunction / QTestLog::msecsFunctionTime"}}


def summarize_measurements(paths):
    """Read (target, XML path) pairs without launching any process."""
    reports = [parse_qtest_xml(path, target) for target, path in paths]
    return {"schema": SCHEMA, "reports": reports,
            "functionsByDuration": sorted([row for report in reports for row in report["functions"]],
                                          key=lambda row: (-row["durationMs"], row["target"] or "", row["function"])),
            "allPassed": bool(reports) and all(report["allPassed"] for report in reports),
            "acceptanceEligible": False, "costBreakdownAvailable": False}


def ctest_commands(build_directory, registered_targets):
    """Parse generated add_test records as data, never evaluate CMake code."""
    build = Path(build_directory).resolve(strict=True)
    source = build / "CTestTestfile.cmake"
    _need(source.is_file() and not source.is_symlink(), "CTEST_TESTFILE_INVALID")
    result = {}
    for line in source.read_text().splitlines():
        if not line.startswith("add_test("):
            continue
        _need(line.endswith(")"), "CTEST_COMMAND_SYNTAX_UNSUPPORTED")
        args = shlex.split(line[len("add_test("):-1], posix=True)
        _need(len(args) >= 2 and args[0] not in result, "CTEST_COMMAND_DUPLICATE_OR_EMPTY")
        target, executable, *options = args
        if target not in registered_targets:
            continue
        _need(target in TARGET_EXECUTABLES and Path(executable).is_absolute(), "CTEST_TARGET_NOT_REGISTERED")
        resolved = Path(executable).resolve(strict=True)
        _need(resolved.parent == build and resolved.name == TARGET_EXECUTABLES[target] and
              not Path(executable).is_symlink() and resolved.is_file(), "CTEST_EXECUTABLE_OUTSIDE_BUILD")
        _need(options in ([], ["-maxwarnings", "0"]), "CTEST_OPTIONS_NOT_REGISTERED")
        result[target] = [str(resolved), *options]
    _need(set(result) == set(registered_targets), "CTEST_REGISTERED_TARGETS_MISSING")
    return result


def split_native_selection(selection, targets):
    _need(isinstance(selection, str) and selection and not any(c in selection for c in "\n\r\0"),
          "NATIVE_SELECTION_INVALID")
    parts = selection.split("::")
    target = parts[0]
    _need(target in targets and len(parts) in (1, 2, 3), "NATIVE_TARGET_NOT_REGISTERED")
    if len(parts) == 1:
        return target, None
    if len(parts) == 3:
        _need(re.fullmatch(r"[A-Za-z_]\w*", parts[1]), "NATIVE_CLASS_INVALID")
    function = parts[-1]
    _need(not function.startswith("-") and bool(re.fullmatch(r"[A-Za-z_]\w*(?:\([^\r\n]*\)|:[^\r\n]+)?", function)),
          "NATIVE_FUNCTION_SELECTION_INVALID")
    if "(" in function:
        name, tag = function.split("(", 1)
        tag = tag[:-1]
        function = name + (":" + tag if tag else "")
    return target, function


def cache_environment(environment, cache_directory, *, enabled=False, root):
    """Explicit cache comparison only, with an existing isolated cache path."""
    cache = Path(cache_directory)
    canonical_directory(cache)
    assert_not_data_path(cache, root)
    parent = Path(environment.get("XDG_CACHE_HOME", ""))
    _need(parent.is_absolute() and cache.resolve().is_relative_to(parent.resolve()) and cache != parent,
          "QML_CACHE_NOT_INSIDE_ISOLATED_CACHE")
    result = dict(environment)
    result.pop("QML_FORCE_DISK_CACHE", None)
    result["QML_DISK_CACHE_PATH"] = str(cache)
    if enabled:
        result.pop("QML_DISABLE_DISK_CACHE", None)
    else:
        result["QML_DISABLE_DISK_CACHE"] = "1"
    return result


def validate_unpaired_selection(target, function):
    """The real backup consumer may only run in the producer-paired full batch."""
    name = function.split(":", 1)[0] if function is not None else None
    _need(not (target == "runtime-bridge" and
               (name is None or name == "realPythonInspectionFramePreservesEnvelopeAndCompletesPendingRequest")),
          "FOCUSED_RUNTIME_BACKUP_REQUIRES_FULL_PAIRED_BATCH")


def prepare_whole_target_exports(root, report, environment):
    """Prepare the same fresh Qt export directories as the complete stage.

    A whole target executes every export row and its original cleanup assertions.
    It still does not run the joint consumer or establish the full native contract.
    """
    root, report = Path(root), Path(report)
    canonical_directory(report)
    assert_not_data_path(report, root)
    directories = {}
    for _, name, variable, prefix in NATIVE_GROUPS:
        directory, verdict = report / name, report / (name + "-verdict.json")
        _need(environment.get(variable) == str(directory), prefix + "_EVIDENCE_ENVIRONMENT_NOT_BOUND")
        _need(not os.path.lexists(directory) and not os.path.lexists(verdict), prefix + "_EVIDENCE_NOT_FRESH")
        directories[variable] = str(directory)
    for directory in reversed(list(directories.values())):
        Path(directory).mkdir(mode=0o700)
    return directories


def focused_environment(environment, export_directories=None):
    """Optional exports stay off for function/data-row selection.

    The original Qt tests retain all behavioral assertions when these optional
    variables are absent. In particular cleanup does not demand unselected rows.
    """
    result = dict(environment)
    for _, _, variable, _ in NATIVE_GROUPS:
        result.pop(variable, None)
    result.pop("REVERIE_P1_CONTROL_RECEIPT_DIR", None)
    if export_directories is not None:
        result.update(export_directories)
    return result


def run_selected(root, report_directory, config, selections, environment):
    """One sequential focused measurement; no CTest or joint consumer claim."""
    root, report = Path(root), Path(report_directory)
    canonical_directory(report)
    assert_not_data_path(report, root)
    assert_not_data_path(root / config["cmakeDirectory"], root)
    selected = [split_native_selection(value, config["nativeTargets"]) for value in selections]
    _need(selected and len(selected) == len(set(selected)), "NATIVE_SELECTIONS_MISSING_OR_REPEATED")
    for target, function in selected:
        validate_unpaired_selection(target, function)
    commands = ctest_commands(root / config["cmakeDirectory"], config["nativeTargets"])
    outputs = []
    export_directories = None
    invocations = []
    for index, (target, function) in enumerate(selected, 1):
        xml = report / ("qtest-" + str(index) + "-" + target + ".xml")
        _need(not os.path.lexists(xml), "QTEST_XML_OUTPUT_NOT_FRESH")
        if function is None and export_directories is None:
            export_directories = prepare_whole_target_exports(root, report, environment)
        child_environment = focused_environment(environment, export_directories if function is None else None)
        argv = [*commands[target], *([function] if function else []), "-o", "-,txt", "-o", str(xml) + ",xml"]
        invocation = {"target": target, "selection": function, "xml": str(xml),
                      "nativeEvidenceCaptureEnabled": function is None, "jointEvidenceConsumerExecuted": False}
        invocations.append(invocation)
        print("REVERIE_FOCUSED_QTEST " + json.dumps(invocation), flush=True)
        completed = subprocess.run(argv, cwd=root, env=child_environment)
        outputs.append((target, xml))
        if completed.returncode:
            return completed.returncode
        parsed = parse_qtest_xml(xml, target)
        _need(parsed["allPassed"], "FOCUSED_QTEST_NONPASS")
    summary = summarize_measurements(outputs)
    summary.update({"selection": list(selections), "fullNativeContractExecuted": False,
                    "jointEvidenceConsumerExecuted": False, "backupReceiptConsumerClaimed": False,
                    "nativeEvidenceExportsPrepared": export_directories is not None,
                    "nativeEvidenceExportDirectories": list((export_directories or {}).values()),
                    "invocations": invocations,
                    "qmlDiskCache": {"disabled": environment.get("QML_DISABLE_DISK_CACHE") == "1",
                                     "path": environment.get("QML_DISK_CACHE_PATH"),
                                     "documentation": QML_CACHE_DOCUMENTATION,
                                     "cacheHitsMeasured": False}})
    with (report / "qtest-measurements.json").open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--select", action="append", required=True)
    parser.add_argument("--cache-enabled", action="store_true")
    parser.add_argument("--cache-dir", type=Path)
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text())
    environment = dict(os.environ)
    if args.cache_enabled or args.cache_dir is not None:
        _need(args.cache_dir is not None, "QML_CACHE_DIRECTORY_REQUIRED")
        environment = cache_environment(environment, args.cache_dir, enabled=args.cache_enabled, root=args.root)
    return run_selected(args.root, args.report, config, args.select, environment)


if __name__ == "__main__":
    raise SystemExit(main())
