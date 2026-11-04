"""Collect test identities from saved runtime output, without executing tests.

Identity lists are multisets represented as lists: inherited duplicate names and
QTest data tags are deliberately retained. A parsed failure/skip remains a case;
``require_all_passed`` is the separate registration gate. No default report path
or user-data path is opened by this module.
"""
from __future__ import annotations

import json
import hashlib
import re
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

SCHEMA = "reverie.registered-run.identities.v1"
STATUSES = ("passed", "failed", "error", "skipped", "todo", "cancelled", "xpass", "xfail", "blacklisted")


class IdentityError(ValueError):
    def __init__(self, code: str, **details: Any):
        self.code, self.details = code, details
        super().__init__(code + ": " + json.dumps(details, sort_keys=True, ensure_ascii=False))


def _need(condition: Any, code: str, **details: Any) -> None:
    if not condition:
        raise IdentityError(code, **details)


def safe_relative_path(value: str) -> str:
    _need(isinstance(value, str) and value and "\\" not in value and
          not any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value),
          "INVALID_SOURCE_PATH", path=value)
    path = PurePosixPath(value)
    _need(bool(path.parts) and not path.is_absolute() and ".." not in path.parts and path.parts[0] != "data",
          "FORBIDDEN_SOURCE_PATH", path=value)
    return path.as_posix()


def _report(framework: str, cases: list[dict], **extra: Any) -> dict:
    counts = {status: sum(case["status"] == status for case in cases) for status in STATUSES}
    counts["total"] = len(cases)
    return {"schema": SCHEMA, "framework": framework, "cases": cases, "counts": counts,
            "allPassed": bool(cases) and counts["passed"] == len(cases), **extra}


def _xml(value: str | bytes | ET.Element) -> ET.Element:
    try:
        root = value if isinstance(value, ET.Element) else ET.fromstring(value)
    except ET.ParseError as error:
        raise IdentityError("INVALID_JUNIT_XML", reason=str(error)) from error
    _need(root.tag in ("testsuite", "testsuites"), "INVALID_JUNIT_ROOT", tag=root.tag)
    return root


def _integer(value: Any, code: str) -> int:
    _need(isinstance(value, (int, str)) and not isinstance(value, bool) and str(value).isdigit(), code, value=value)
    return int(value)


def _junit_status(case: ET.Element) -> str:
    observed = [tag for tag in ("failure", "error", "skipped") if case.find(tag) is not None]
    _need(len(observed) <= 1, "AMBIGUOUS_JUNIT_STATUS", name=case.get("name"), statuses=observed)
    status = {"failure": "failed", "error": "error", "skipped": "skipped"}.get(observed[0] if observed else "", "passed")
    attr = case.get("status")
    _need(attr in (None, "run", "passed", "failed", "notrun", "disabled", "skipped"), "UNKNOWN_JUNIT_STATUS", status=attr)
    if attr in ("notrun", "disabled", "skipped"):
        _need(status in ("passed", "skipped"), "CONFLICTING_JUNIT_STATUS", status=attr)
        status = "skipped"
    if attr == "failed":
        _need(status in ("passed", "failed"), "CONFLICTING_JUNIT_STATUS", status=attr)
        status = "failed"
    return status


def _check_junit_totals(root: ET.Element, cases: list[dict]) -> None:
    # Validate each suite against its descendants; never add nested suite totals.
    for suite in root.iter("testsuite"):
        rows = list(suite.iter("testcase"))
        statuses = Counter(_junit_status(row) for row in rows)
        for attr, expected in (("tests", len(rows)), ("failures", statuses["failed"]),
                               ("errors", statuses["error"]), ("skipped", statuses["skipped"])):
            if attr in suite.attrib:
                actual = _integer(suite.get(attr), "INVALID_JUNIT_COUNT")
                _need(actual == expected, "JUNIT_COUNT_MISMATCH", attribute=attr, declared=actual, observed=expected)
    if root.tag == "testsuites" and "tests" in root.attrib:
        _need(_integer(root.get("tests"), "INVALID_JUNIT_COUNT") == len(cases), "JUNIT_ROOT_COUNT_MISMATCH")


def parse_pytest_junit(value: str | bytes | ET.Element, targets: Sequence[str]) -> dict:
    root = _xml(value)
    targets = [safe_relative_path(path) for path in targets]
    _need(len(targets) == len(set(targets)) and all(path.endswith(".py") for path in targets), "INVALID_PYTEST_TARGETS")
    cases = []
    for case in root.iter("testcase"):
        classname, name = case.get("classname", ""), case.get("name", "")
        _need(bool(classname and name), "MISSING_PYTEST_IDENTITY")
        matches = []
        for target in targets:
            module = target[:-3].replace("/", ".")
            if classname == module or classname.startswith(module + "."):
                suffix = classname[len(module):].lstrip(".")
                matches.append((target, suffix))
        _need(len(matches) == 1, "AMBIGUOUS_PYTEST_FILE", classname=classname, matches=matches)
        target, suffix = matches[0]
        # Nested pytest classes are represented by dotted classname suffixes.
        identity = target + "::" + (suffix.replace(".", "::") + "::" if suffix else "") + name
        cases.append({"identity": identity, "file": target, "name": name, "status": _junit_status(case)})
    _need(bool(cases), "EMPTY_PYTEST_OUTPUT")
    _check_junit_totals(root, cases)
    return _report("python", cases)


def parse_ctest_junit(value: str | bytes | ET.Element, targets: Sequence[str] | None = None) -> dict:
    root = _xml(value)
    cases = []
    for row in root.iter("testcase"):
        name = row.get("name", "")
        _need(bool(name), "MISSING_CTEST_TARGET")
        cases.append({"identity": name, "file": None, "name": name, "target": name, "status": _junit_status(row)})
    _need(bool(cases), "EMPTY_CTEST_OUTPUT")
    _check_junit_totals(root, cases)
    if targets is not None:
        _need(Counter(row["name"] for row in cases) == Counter(targets), "CTEST_SELECTION_MISMATCH")
    return _report("ctest", cases)


def parse_node_tap(text: str, *, expected_names_by_file: Mapping[str, Sequence[str]] | None = None,
                   source_file: str | None = None) -> dict:
    """Parse flat Node TAP. Attribute historical combined logs only unambiguously.

    New runs should save one TAP output per explicit file (``source_file``).
    Historical TAP has no file locations on successful rows: its signed name
    index can attribute a name only when all occurrences belong to one file.
    Shared names across files fail closed; their source must never be guessed
    from runner order, test numbering, or a global name-only multiset.
    """
    _need(isinstance(text, str) and text.startswith("TAP version 13"), "INVALID_NODE_TAP_HEADER")
    _need(not re.search(r"^\s+Bail out!|^Bail out!|^\s+(?:not )?ok \d+", text, re.M), "UNSUPPORTED_NESTED_OR_BAILED_TAP")
    owners: dict[str, list[str]] = {}
    if source_file is not None:
        source_file = safe_relative_path(source_file)
    if expected_names_by_file is not None:
        for file, names in expected_names_by_file.items():
            safe_relative_path(file)
            _need(isinstance(names, (list, tuple)) and all(isinstance(n, str) and n for n in names), "INVALID_NODE_NAME_INDEX")
            for name in set(names):
                owners.setdefault(name, []).append(file)
    subtests = re.findall(r"^# Subtest: (.+)\r?$", text, re.M)
    cases, numbers = [], []
    for line in text.splitlines():
        match = re.match(r"^(not ok|ok) (\d+) - (.+)$", line)
        if not match:
            _need(not re.match(r"^(?:not ok|ok)\b", line), "MALFORMED_TAP_CASE", line=line)
            continue
        outcome, number, payload = match.groups()
        directive = re.search(r"\s+#\s*(SKIP|TODO)\b(?:\s+.*)?$", payload, re.I)
        name = payload[:directive.start()] if directive else payload
        status = "skipped" if directive and directive.group(1).upper() == "SKIP" else (
            "todo" if directive else ("passed" if outcome == "ok" else "failed"))
        file = source_file
        if file is None:
            found = owners.get(name, [])
            _need(len(found) == 1, "AMBIGUOUS_NODE_FILE", name=name, files=found)
            file = found[0]
        numbers.append(int(number))
        cases.append({"identity": file + "::" + name, "file": file, "name": name, "status": status})
    _need(bool(cases) and numbers == list(range(1, len(cases) + 1)), "TAP_CASE_NUMBER_MISMATCH", numbers=numbers)
    _need(Counter(subtests) == Counter(row["name"] for row in cases), "TAP_SUBTEST_RESULT_MISMATCH")
    plans = re.findall(r"^1\.\.(\d+)(?:\s+#.*)?$", text, re.M)
    _need(plans == [str(len(cases))], "TAP_PLAN_MISMATCH", plans=plans)
    summary: dict[str, int] = {}
    for key, value in re.findall(r"^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\r?$", text, re.M):
        _need(key not in summary, "DUPLICATE_TAP_SUMMARY", field=key)
        summary[key] = int(value)
    _need(set(summary) == {"tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"}, "INCOMPLETE_TAP_SUMMARY")
    status_counts = Counter(row["status"] for row in cases)
    _need(summary["tests"] == len(cases) and summary["suites"] == 0 and summary["cancelled"] == 0,
          "TAP_SUMMARY_MISMATCH", summary=summary)
    for key, status in (("pass", "passed"), ("fail", "failed"), ("skipped", "skipped"), ("todo", "todo")):
        _need(summary[key] == status_counts[status], "TAP_STATUS_COUNT_MISMATCH", field=key,
              declared=summary[key], observed=status_counts[status])
    return _report("node", cases, runtimeSummary=summary)


def parse_frontend_json(value: Mapping[str, Any], targets: Sequence[str], repository_root: str | Path) -> dict:
    _need(isinstance(value, Mapping) and isinstance(value.get("testResults"), list), "INVALID_FRONTEND_REPORT")
    root = Path(repository_root).absolute()
    target_map = {str(root / safe_relative_path(target)): target for target in targets}
    cases, seen = [], []
    for file_result in value["testResults"]:
        _need(isinstance(file_result, dict), "INVALID_FRONTEND_FILE")
        file = target_map.get(file_result.get("name"))
        _need(file is not None and file not in seen, "UNKNOWN_OR_DUPLICATE_FRONTEND_FILE", name=file_result.get("name"))
        seen.append(file)
        assertions = file_result.get("assertionResults")
        _need(isinstance(assertions, list) and assertions, "EMPTY_FRONTEND_ASSERTIONS", file=file)
        _need(file_result.get("status") in ("passed", "failed", "pending", "skipped"), "UNKNOWN_FRONTEND_FILE_STATUS")
        for row in assertions:
            _need(isinstance(row, dict) and isinstance(row.get("ancestorTitles"), list) and
                  all(isinstance(x, str) for x in row["ancestorTitles"]) and isinstance(row.get("title"), str) and row["title"],
                  "INVALID_FRONTEND_ASSERTION")
            name = " ".join([*row["ancestorTitles"], row["title"]])
            _need(row.get("fullName") == name, "FRONTEND_FULL_NAME_MISMATCH")
            status = {"passed": "passed", "failed": "failed", "pending": "skipped", "skipped": "skipped", "todo": "todo"}.get(row.get("status"))
            _need(status is not None and isinstance(row.get("failureMessages", []), list), "UNKNOWN_FRONTEND_ASSERTION_STATUS")
            _need(status != "passed" or not row.get("failureMessages"), "FRONTEND_PASSED_WITH_FAILURE")
            cases.append({"identity": file + "::" + name, "file": file, "name": name, "status": status})
        _need(file_result["status"] != "passed" or all(row["status"] == "passed" for row in cases if row["file"] == file),
              "FRONTEND_FILE_STATUS_CONFLICT")
    _need(set(seen) == set(targets), "FRONTEND_SELECTION_MISMATCH")
    counts = Counter(row["status"] for row in cases)
    for key, expected in (("numTotalTests", len(cases)), ("numPassedTests", counts["passed"]),
                          ("numFailedTests", counts["failed"]), ("numPendingTests", counts["skipped"]),
                          ("numTodoTests", counts["todo"])):
        _need(type(value.get(key)) is int and value[key] == expected, "FRONTEND_COUNT_MISMATCH", field=key, expected=expected)
    _need(type(value.get("success")) is bool and value["success"] == all(row["status"] == "passed" for row in cases),
          "FRONTEND_SUCCESS_CONFLICT")
    return _report("frontend", cases)


_TARGET = re.compile(r"^\d+/\d+ Testing: ([^\r\n]+)\r?$", re.M)
_QROW = re.compile(r"^(PASS|FAIL!|SKIP|XPASS|XFAIL|BPASS|BFAIL)\s*:\s+([^\s]+)::([^\r\n]+)$", re.M)


def parse_qtest_transcript(text: str) -> dict:
    _need(not re.search(r"Maximum amount of warnings exceeded|Further warnings will be omitted", text, re.I), "TRUNCATED_QTEST_OUTPUT")
    blocks = list(_TARGET.finditer(text))
    _need(bool(blocks), "MISSING_QTEST_TARGET_BLOCKS")
    cases, seen = [], []
    for index, block in enumerate(blocks):
        target = block.group(1)
        _need(target not in seen, "DUPLICATE_QTEST_TARGET", target=target)
        seen.append(target)
        body = text[block.end():blocks[index + 1].start() if index + 1 < len(blocks) else len(text)]
        rows = []
        for match in _QROW.finditer(body):
            raw, cls, suffix = match.groups()
            _need(re.fullmatch(r"[A-Za-z_]\w*\([^\r\n]*\)", suffix) is not None, "MALFORMED_QTEST_IDENTITY", identity=suffix)
            status = {"PASS": "passed", "FAIL!": "failed", "SKIP": "skipped", "XPASS": "xpass", "XFAIL": "xfail", "BPASS": "blacklisted", "BFAIL": "blacklisted"}[raw]
            identity = cls + "::" + suffix
            rows.append({"identity": target + "::" + identity, "file": None, "target": target,
                         "name": identity, "status": status, "rawStatus": raw,
                         "lifecycle": suffix in ("initTestCase()", "cleanupTestCase()")})
        _need(rows, "EMPTY_QTEST_TARGET", target=target)
        # Diagnostic lines after a SKIP or XFAIL are not cases. Unknown result
        # labels must not silently disappear from the identity list.
        _need(len(re.findall(r"^(?:PASS|FAIL!|SKIP|XPASS|XFAIL|BPASS|BFAIL)\s*:", body, re.M)) == len(rows), "UNPARSED_QTEST_ROW", target=target)
        totals = re.findall(r"^Totals: (\d+) passed, (\d+) failed, (\d+) skipped, (\d+) blacklisted,.*$", body, re.M)
        _need(len(totals) == 1, "QTEST_TOTALS_MISSING_OR_REPEATED", target=target)
        passed, failed, skipped, blacklisted = map(int, totals[0])
        # Qt includes XFAIL among passed, XPASS among failed. Preserve their
        # actual status while reconciling Qt's own arithmetic.
        observed = Counter(row["status"] for row in rows)
        expected = (observed["passed"] + observed["xfail"], observed["failed"] + observed["xpass"], observed["skipped"], observed["blacklisted"])
        _need((passed, failed, skipped, blacklisted) == expected, "QTEST_COUNT_MISMATCH", target=target,
              declared=[passed, failed, skipped, blacklisted], observed=list(expected))
        _need("********* Finished testing of " in body and "<end of output>" in body, "INCOMPLETE_QTEST_TARGET", target=target)
        cases.extend(rows)
    return _report("qtest", cases)


def signed_baseline(registration: Mapping[str, Any]) -> dict:
    cases = []
    for identity in registration["expectedPythonIdentities"]:
        file, name = identity.split("::", 1)
        cases.append({"framework": "python", "identity": identity, "file": file, "name": name, "status": "passed"})
    for framework, key in (("node", "expectedNodeNames"), ("frontend", "expectedFrontendNames")):
        for file, names in registration[key].items():
            for name in names:
                cases.append({"framework": framework, "identity": file + "::" + name, "file": file, "name": name, "status": "passed"})
    for target in registration["nativeTargets"]:
        cases.append({"framework": "ctest", "identity": target, "target": target, "file": None, "name": target, "status": "passed"})
        for name in registration["expectedNativeIdentities"][target]:
            cases.append({"framework": "qtest", "identity": target + "::" + name, "target": target, "file": None, "name": name, "status": "passed"})
    return _report("combined", cases, provenance={"registrationId": registration.get("registrationId"), "sourceHead": registration.get("sourceHead")})


def combine_reports(reports: Sequence[Mapping[str, Any]]) -> dict:
    cases = []
    for report in reports:
        _need(report.get("schema") == SCHEMA and report.get("framework") != "combined", "INVALID_IDENTITY_REPORT")
        cases.extend({**row, "framework": report["framework"]} for row in report["cases"])
    return _report("combined", cases)


def compare_manifests(baseline: Mapping[str, Any], current: Mapping[str, Any]) -> dict:
    def counts(report: Mapping[str, Any]) -> Counter:
        return Counter((row.get("framework", report["framework"]), row["identity"]) for row in report["cases"])
    before, after = counts(baseline), counts(current)
    def rows(delta: Counter) -> list[dict]:
        return [{"framework": framework, "identity": identity, "count": count}
                for (framework, identity), count in sorted(delta.items()) if count > 0]
    added, deleted = rows(after - before), rows(before - after)
    # Output alone cannot prove a rename. The source audit can establish exact
    # unchanged-body candidates; here deletions/additions remain fully visible.
    return {"schema": "reverie.registered-run.identity-diff.v1", "added": added, "deleted": deleted,
            "renameCandidates": [], "renameInference": "Runtime output alone does not establish renames; consult test-change audit.",
            "identitiesMatch": before == after,
            "statusChanges": [{"framework": row.get("framework", current["framework"]), "identity": row["identity"], "status": row["status"]}
                              for row in current["cases"] if row["status"] != "passed"]}


def require_all_passed(report: Mapping[str, Any]) -> None:
    bad = [row for row in report["cases"] if row["status"] != "passed"]
    _need(bool(report["cases"]) and not bad, "IDENTITIES_NOT_ALL_PASSED", nonPassed=bad)


def collect_saved_outputs(report_directory: str | Path, selection: Mapping[str, Any], repository_root: str | Path,
                          *, historical_replay: bool = False) -> dict:
    """Read explicitly chosen saved outputs. This never starts a test process.

    New runs require ``nodeIdentityReport``: the JSONL destination of the
    actual Node event reporter. ``historical_replay=True`` explicitly permits
    signed historical TAP replay and labels its attribution limitations.
    """
    directory = Path(report_directory)
    project = Path(repository_root).absolute()
    raw_outputs = []
    def read(name: str) -> str:
        path = directory / name
        _need(path.is_file() and not path.is_symlink(), "INVALID_SAVED_OUTPUT", path=str(path))
        payload = path.read_bytes()
        _need(path.absolute().is_relative_to(project), "SAVED_OUTPUT_OUTSIDE_REPOSITORY", path=str(path))
        raw_outputs.append({"path": str(path.absolute().relative_to(project)), "bytes": len(payload),
                            "sha256": hashlib.sha256(payload).hexdigest()})
        return payload.decode("utf-8")
    reports = [parse_pytest_junit(read("python-unit.xml"), selection["pythonTargets"])]
    if selection.get("nodeIdentityReport"):
        reports.append(parse_node_identity_events(read(safe_relative_path(selection["nodeIdentityReport"])),
                                                  selection["nodeTests"], repository_root))
    elif historical_replay:
        reports.append(parse_historical_node_tap(read("node-unit.log"), selection["expectedNodeNames"]))
    elif selection.get("nodeTapFiles"):
        for file, filename in selection["nodeTapFiles"].items():
            reports.append(parse_node_tap(read(safe_relative_path(filename)), source_file=file))
    else:
        raise IdentityError("ACTUAL_NODE_IDENTITY_REPORT_REQUIRED")
    reports.extend([parse_frontend_json(json.loads(read("frontend-unit.json")), selection["frontendTests"], repository_root),
                    parse_ctest_junit(read("native-unit.xml"), selection["nativeTargets"]),
                    parse_qtest_transcript(read("native-lasttest.log"))])
    qtest = reports[-1]
    _need(Counter(list(dict.fromkeys(row["target"] for row in qtest["cases"]))) == Counter(selection["nativeTargets"]), "QTEST_SELECTION_MISMATCH")
    result = combine_reports(reports)
    result["source"] = "historical-replay" if historical_replay else "actual-runtime-outputs"
    result["rawOutputs"] = raw_outputs
    result["historicAttributionAmbiguities"] = [ambiguity for report in reports for ambiguity in report.get("historicAttributionAmbiguities", [])]
    return result


NODE_EVENT_SCHEMA = "reverie.registered-run.node-events.v1"


def parse_node_identity_events(text: str, targets: Sequence[str], repository_root: str | Path) -> dict:
    """Collect source file/name/status from actual Node reporter events.

    The current registration contract is flat Node tests. Nested registrations
    and suites reject explicitly rather than collapsing different ancestry.
    A future nested contract must extend the reporter and identity schema.
    """
    try:
        events = [json.loads(line) for line in text.splitlines() if line.strip()]
    except (ValueError, TypeError) as error:
        raise IdentityError("INVALID_NODE_EVENT_JSON") from error
    _need(len(events) >= 3 and all(isinstance(event, dict) and event.get("schema") == NODE_EVENT_SCHEMA for event in events), "INVALID_NODE_EVENT_STREAM")
    _need(events[0].get("type") == "stream:start" and events[-1].get("type") == "stream:end", "INCOMPLETE_NODE_EVENT_STREAM")
    _need(isinstance(events[0].get("nodeVersion"), str), "MISSING_NODE_EVENT_VERSION")
    root = Path(repository_root).absolute()
    target_map = {str(root / safe_relative_path(target)): target for target in targets}
    _need(len(target_map) == len(targets), "DUPLICATE_NODE_TARGETS")
    cases, summaries = [], []
    for sequence, event in enumerate(events[1:-1], 1):
        _need(event.get("sequence") == sequence, "NODE_EVENT_SEQUENCE_MISMATCH")
        data = event.get("data")
        _need(isinstance(data, dict), "INVALID_NODE_EVENT_DATA")
        if event["type"] == "test:summary":
            summaries.append(data)
            continue
        _need(event["type"] in ("test:pass", "test:fail"), "UNKNOWN_NODE_IDENTITY_EVENT")
        file = target_map.get(data.get("file"))
        _need(file is not None, "NODE_ACTUAL_FILE_UNREGISTERED", file=data.get("file"))
        _need(isinstance(data.get("name"), str) and data["name"] and type(data.get("nesting")) is int and data["nesting"] == 0,
              "UNSUPPORTED_OR_INVALID_NODE_NESTING", nesting=data.get("nesting"), name=data.get("name"))
        _need(data.get("reportedType") in (None, "test") and type(data.get("testNumber")) is int and data["testNumber"] > 0,
              "UNSUPPORTED_NODE_SUITE_OR_NUMBER")
        _need(data.get("skip") is None or isinstance(data["skip"], (str, bool)), "INVALID_NODE_SKIP")
        _need(data.get("todo") is None or isinstance(data["todo"], (str, bool)), "INVALID_NODE_TODO")
        _need(data.get("skip") is None or data.get("todo") is None, "AMBIGUOUS_NODE_DIRECTIVES")
        failure_type = data.get("failureType")
        status = "skipped" if data.get("skip") is not None else ("todo" if data.get("todo") is not None else (
            "cancelled" if failure_type in ("cancelledByParent", "testAborted", "testTimeoutFailure") else (
                "passed" if event["type"] == "test:pass" else "failed")))
        _need(event["type"] != "test:pass" or failure_type is None, "NODE_PASS_WITH_FAILURE_TYPE")
        cases.append({"identity": file + "::" + data["name"], "file": file, "name": data["name"],
                      "status": status, "nesting": data["nesting"], "testNumber": data["testNumber"],
                      "line": data.get("line"), "column": data.get("column"), "failureType": failure_type})
    end = events[-1]
    _need(end.get("events") == len(events) - 2 and end.get("cases") == len(cases) and end.get("summaries") == len(summaries), "NODE_EVENT_TRAILER_MISMATCH")
    _need(cases and {row["file"] for row in cases} == set(targets), "NODE_ACTUAL_FILE_SET_MISMATCH")
    global_summaries = [summary for summary in summaries if summary.get("file") is None]
    _need(len(global_summaries) == 1 and summaries[-1] is global_summaries[0], "NODE_FINAL_SUMMARY_MISSING_OR_REPEATED")
    summary = global_summaries[0]
    counts = summary.get("counts")
    observed = Counter(row["status"] for row in cases)
    _need(isinstance(counts, dict), "NODE_SUMMARY_COUNTS_MISSING")
    for field, expected in (("tests", len(cases)), ("suites", 0), ("passed", observed["passed"]),
                            ("failed", observed["failed"]), ("cancelled", observed["cancelled"]),
                            ("skipped", observed["skipped"]), ("todo", observed["todo"])):
        _need(type(counts.get(field)) is int and counts[field] == expected, "NODE_EVENT_COUNT_MISMATCH", field=field, expected=expected, observed=counts.get(field))
    _need(type(summary.get("success")) is bool and summary["success"] == (observed["failed"] == observed["cancelled"] == 0), "NODE_SUMMARY_SUCCESS_CONFLICT")
    return _report("node", cases, source="actual-node-test-events", nodeVersion=events[0]["nodeVersion"], runtimeSummary=counts)


def parse_historical_node_tap(text: str, expected_names_by_file: Mapping[str, Sequence[str]]) -> dict:
    """Replay old TAP without claiming independent actual file attribution.

    Cross-file equal names are explicitly ambiguous. Once the *global* signed
    multiplicities and passing outcomes are proved, signed-index identities are
    copied as historical baseline data; this report is barred from a new
    registration by ``require_actual_collection``.
    """
    parsed = parse_node_tap(text, source_file="__historical_combined__.cjs")
    actual = Counter(row["name"] for row in parsed["cases"])
    expected = Counter(name for names in expected_names_by_file.values() for name in names)
    _need(actual == expected, "HISTORICAL_NODE_MULTIPLICITIES_CHANGED")
    owners: dict[str, list[str]] = {}
    for file, names in expected_names_by_file.items():
        safe_relative_path(file)
        for name in set(names):
            owners.setdefault(name, []).append(file)
    ambiguities = [{"name": name, "files": files, "count": actual[name]} for name, files in sorted(owners.items()) if len(files) > 1]
    _need(parsed["allPassed"], "HISTORICAL_NODE_NONPASS_CANNOT_ATTRIBUTE", nonPassed=[row for row in parsed["cases"] if row["status"] != "passed"])
    cases = [{"identity": file + "::" + name, "file": file, "name": name, "status": "passed",
              "fileAttribution": "signed-index-historical-only"} for file, names in expected_names_by_file.items() for name in names]
    return _report("node", cases, source="historical-tap-and-signed-index", actualFileAttribution=False,
                   historicAttributionAmbiguities=ambiguities, runtimeNameMultiplicitiesMatch=True)


def require_actual_collection(report: Mapping[str, Any]) -> None:
    _need(report.get("source") not in ("historical-tap-and-signed-index", "historical-replay") and not report.get("historicAttributionAmbiguities") and
          not any(row.get("fileAttribution") == "signed-index-historical-only" for row in report["cases"]),
          "HISTORICAL_IDENTITIES_NOT_REGISTRATION_EXPECTATIONS")
