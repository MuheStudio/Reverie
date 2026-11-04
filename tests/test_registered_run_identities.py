"""Synthetic parser checks and read-only replay of the signed formal r1 output."""
from collections import Counter
import json
from pathlib import Path
import subprocess

import pytest

from script.registered_run.identities import (
    IdentityError, NODE_EVENT_SCHEMA, collect_saved_outputs, combine_reports,
    compare_manifests, parse_ctest_junit, parse_frontend_json,
    parse_historical_node_tap, parse_node_identity_events, parse_node_tap,
    parse_pytest_junit, parse_qtest_transcript, require_actual_collection,
    require_all_passed, safe_relative_path, signed_baseline,
)

ROOT = Path(__file__).resolve().parents[1]
FORMAL = ROOT / ".tools/reports/p1-worldbook-injection-r1-20261026"


def tap(rows):
    counts = Counter(status for _, status in rows)
    return "\n".join(["TAP version 13", *[
        line for index, (name, status) in enumerate(rows, 1)
        for line in (f"# Subtest: {name}", f"{'not ok' if status == 'failed' else 'ok'} {index} - {name}" +
                     (" # SKIP reason" if status == "skipped" else " # TODO later" if status == "todo" else ""))],
        f"1..{len(rows)}", f"# tests {len(rows)}", "# suites 0", f"# pass {counts['passed']}",
        f"# fail {counts['failed']}", "# cancelled 0", f"# skipped {counts['skipped']}", f"# todo {counts['todo']}"])


def qtest(rows, totals=None):
    counts = Counter(status for status, _ in rows)
    totals = totals or (counts["PASS"], counts["FAIL!"], counts["SKIP"], 0)
    return "\n".join(["1/1 Testing: target", "********* Start testing of Case *********",
                      *[f"{status}   : Case::{name}" for status, name in rows],
                      "Totals: %d passed, %d failed, %d skipped, %d blacklisted, 1ms" % totals,
                      "********* Finished testing of Case *********", "<end of output>"])


def node_events(root, rows):
    counts = Counter(row.get("status", "passed") for row in rows)
    events = [{"schema": NODE_EVENT_SCHEMA, "type": "stream:start", "nodeVersion": "v24.19.0"}]
    for index, row in enumerate(rows, 1):
        status = row.get("status", "passed")
        events.append({"schema": NODE_EVENT_SCHEMA, "sequence": index,
                       "type": "test:fail" if status in ("failed", "cancelled") else "test:pass",
                       "data": {"file": str(root / row["file"]), "name": row["name"], "nesting": row.get("nesting", 0),
                                "testNumber": index, "skip": "reason" if status == "skipped" else None,
                                "todo": "later" if status == "todo" else None,
                                "reportedType": "test", "failureType": "cancelledByParent" if status == "cancelled" else None}})
    events.append({"schema": NODE_EVENT_SCHEMA, "sequence": len(rows) + 1, "type": "test:summary",
                   "data": {"file": None, "counts": {"tests": len(rows), "suites": 0, "passed": counts["passed"],
                            "failed": counts["failed"], "cancelled": counts["cancelled"], "skipped": counts["skipped"], "todo": counts["todo"]},
                            "success": counts["failed"] == counts["cancelled"] == 0}})
    events.append({"schema": NODE_EVENT_SCHEMA, "type": "stream:end", "events": len(rows) + 1,
                   "cases": len(rows), "summaries": 1})
    return "\n".join(json.dumps(event) for event in events)


def test_pytest_retains_nested_class_and_parameter_id():
    value = '<testsuite tests="2" failures="0"><testcase classname="tests.test_x.TestOuter.TestInner" name="test_row[a.b]"/><testcase classname="tests.test_x" name="test_other"/></testsuite>'
    result = parse_pytest_junit(value, ["tests/test_x.py"])
    assert [row["identity"] for row in result["cases"]] == [
        "tests/test_x.py::TestOuter::TestInner::test_row[a.b]", "tests/test_x.py::test_other"]
    assert result["counts"]["total"] == 2


def test_pytest_failure_error_skip_are_visible():
    result = parse_pytest_junit('<testsuite tests="3" failures="1" errors="1" skipped="1"><testcase classname="tests.test_x" name="test_a"><failure/></testcase><testcase classname="tests.test_x" name="test_b"><error/></testcase><testcase classname="tests.test_x" name="test_c"><skipped/></testcase></testsuite>', ["tests/test_x.py"])
    assert [row["status"] for row in result["cases"]] == ["failed", "error", "skipped"]
    with pytest.raises(IdentityError, match="IDENTITIES_NOT_ALL_PASSED"):
        require_all_passed(result)


def test_junit_nested_suite_counts_are_not_double_added():
    value = '<testsuites tests="1"><testsuite tests="1"><testsuite tests="1"><testcase classname="tests.test_x" name="test_a"/></testsuite></testsuite></testsuites>'
    assert parse_pytest_junit(value, ["tests/test_x.py"])["counts"]["total"] == 1


@pytest.mark.parametrize("value,code", [
    ('<testsuite tests="2"><testcase classname="tests.test_x" name="test_a"/></testsuite>', "JUNIT_COUNT_MISMATCH"),
    ('<testsuite><testcase classname="unknown" name="test_a"/></testsuite>', "AMBIGUOUS_PYTEST_FILE"),
    ('<testsuite><testcase classname="tests.test_x" name="test_a"><failure/><skipped/></testcase></testsuite>', "AMBIGUOUS_JUNIT_STATUS"),
])
def test_junit_rejects_incomplete_or_ambiguous_output(value, code):
    with pytest.raises(IdentityError, match=code):
        parse_pytest_junit(value, ["tests/test_x.py"])


def test_node_tap_keeps_duplicate_names_and_nonpassing_status():
    result = parse_node_tap(tap([("same", "passed"), ("same", "passed"), ("fail", "failed"), ("skip", "skipped"), ("todo", "todo")]), source_file="tests/a.cjs")
    assert Counter(row["identity"] for row in result["cases"])["tests/a.cjs::same"] == 2
    assert result["counts"]["failed"] == result["counts"]["skipped"] == result["counts"]["todo"] == 1


def test_node_tap_cannot_guess_shared_source_file():
    with pytest.raises(IdentityError, match="AMBIGUOUS_NODE_FILE"):
        parse_node_tap(tap([("same", "passed"), ("same", "passed")]), expected_names_by_file={"a.cjs": ["same"], "b.cjs": ["same"]})


def test_historical_tap_labels_cross_file_ambiguity_and_cannot_be_expectation():
    result = parse_historical_node_tap(tap([("same", "passed"), ("same", "passed")]), {"a.cjs": ["same"], "b.cjs": ["same"]})
    assert result["actualFileAttribution"] is False
    assert result["historicAttributionAmbiguities"] == [{"name": "same", "files": ["a.cjs", "b.cjs"], "count": 2}]
    with pytest.raises(IdentityError, match="HISTORICAL_IDENTITIES_NOT_REGISTRATION_EXPECTATIONS"):
        require_actual_collection(result)


@pytest.mark.parametrize("mutate", [
    lambda value: value.replace("1..1", "1..2"),
    lambda value: value.replace("# pass 1", "# pass 0"),
    lambda value: value.replace("ok 1 -", "ok 2 -"),
    lambda value: value + "\nBail out! stopped",
])
def test_node_tap_truncation_counts_and_bailout_reject(mutate):
    with pytest.raises(IdentityError):
        parse_node_tap(mutate(tap([("a", "passed")])), source_file="a.cjs")


def test_actual_node_events_distinguish_shared_file_names(tmp_path):
    result = parse_node_identity_events(node_events(tmp_path, [{"file": "a.cjs", "name": "same"}, {"file": "b.cjs", "name": "same"}, {"file": "a.cjs", "name": "same"}]), ["a.cjs", "b.cjs"], tmp_path)
    assert Counter(row["identity"] for row in result["cases"]) == {"a.cjs::same": 2, "b.cjs::same": 1}
    require_actual_collection(result)


def test_actual_node_events_preserve_fail_skip_todo_and_cancelled(tmp_path):
    result = parse_node_identity_events(node_events(tmp_path, [{"file": "a.cjs", "name": status, "status": status} for status in ("failed", "skipped", "todo", "cancelled")]), ["a.cjs"], tmp_path)
    assert result["counts"]["failed"] == result["counts"]["skipped"] == result["counts"]["todo"] == result["counts"]["cancelled"] == 1


@pytest.mark.parametrize("mutation", ["trailer", "summary", "file", "nesting"])
def test_actual_node_events_fail_closed(tmp_path, mutation):
    text = node_events(tmp_path, [{"file": "a.cjs", "name": "x"}])
    if mutation == "trailer":
        text = "\n".join(text.splitlines()[:-1])
    elif mutation == "summary":
        text = text.replace('"passed": 1', '"passed": 2')
    elif mutation == "file":
        text = text.replace("a.cjs", "unknown.cjs")
    else:
        text = text.replace('"nesting": 0', '"nesting": 1')
    with pytest.raises(IdentityError):
        parse_node_identity_events(text, ["a.cjs"], tmp_path)


def test_custom_node_reporter_emits_real_event_file_without_running_tests(tmp_path):
    # This is the new reporter's unit test: a fake async event stream is the
    # input. No node --test, project import, application, or build is started.
    reporter = ROOT / "script/registered_run/node_identity_reporter.cjs"
    events = [{"type": "test:pass", "data": {"file": str(tmp_path / "a.cjs"), "name": "x", "nesting": 0,
               "testNumber": 1, "details": {"type": "test"}}},
              {"type": "test:summary", "data": {"counts": {"tests": 1, "suites": 0, "passed": 1,
               "failed": 0, "cancelled": 0, "skipped": 0, "todo": 0}, "success": True}}]
    script = "const r=require(" + json.dumps(str(reporter)) + ");const e=" + json.dumps(events) + ";(async()=>{for await(const line of r((async function*(){yield* e;})()))process.stdout.write(line);})().catch(e=>{console.error(e);process.exitCode=1});"
    completed = subprocess.run([str(ROOT / ".tools/node/bin/node"), "-e", script], capture_output=True, text=True, check=False)
    assert completed.returncode == 0, completed.stderr
    result = parse_node_identity_events(completed.stdout, ["a.cjs"], tmp_path)
    assert result["cases"][0]["identity"] == "a.cjs::x"


def test_qtest_keeps_duplicate_tags_and_lifecycle():
    result = parse_qtest_transcript(qtest([("PASS", "initTestCase()"), ("PASS", "case(same)"), ("PASS", "case(same)"), ("PASS", "cleanupTestCase()")]))
    assert len(result["cases"]) == 4
    assert sum(row["lifecycle"] for row in result["cases"]) == 2
    assert Counter(row["name"] for row in result["cases"])["Case::case(same)"] == 2


def test_qtest_failures_and_skips_do_not_disappear():
    result = parse_qtest_transcript(qtest([("PASS", "initTestCase()"), ("FAIL!", "case(a)"), ("SKIP", "case(b)"), ("PASS", "cleanupTestCase()")]))
    assert [row["status"] for row in result["cases"]] == ["passed", "failed", "skipped", "passed"]


def test_qtest_truncated_or_incorrect_totals_reject():
    text = qtest([("PASS", "case()")])
    with pytest.raises(IdentityError):
        parse_qtest_transcript(text.replace("<end of output>", ""))
    with pytest.raises(IdentityError):
        parse_qtest_transcript(text.replace("Totals: 1 passed", "Totals: 2 passed"))


def test_ctest_target_status_is_preserved():
    value = '<testsuite tests="2" failures="1" skipped="0"><testcase name="a" status="run"/><testcase name="b" status="run"><failure/></testcase></testsuite>'
    result = parse_ctest_junit(value, ["a", "b"])
    assert [row["status"] for row in result["cases"]] == ["passed", "failed"]


def test_frontend_full_name_status_and_multiplicity(tmp_path):
    assertion = {"title": "x", "ancestorTitles": ["suite"], "fullName": "suite x", "status": "passed", "failureMessages": []}
    value = {"success": True, "numTotalTests": 2, "numPassedTests": 2, "numFailedTests": 0, "numPendingTests": 0, "numTodoTests": 0,
             "testResults": [{"name": str(tmp_path / "a.test.ts"), "status": "passed", "assertionResults": [assertion, assertion]}]}
    result = parse_frontend_json(value, ["a.test.ts"], tmp_path)
    assert Counter(row["identity"] for row in result["cases"]) == {"a.test.ts::suite x": 2}
    value["testResults"][0]["assertionResults"][0] = {**assertion, "fullName": "invented"}
    with pytest.raises(IdentityError, match="FRONTEND_FULL_NAME_MISMATCH"):
        parse_frontend_json(value, ["a.test.ts"], tmp_path)


def test_manifest_diff_uses_multiplicities_and_statuses():
    before = combine_reports([parse_node_tap(tap([("same", "passed"), ("same", "passed")]), source_file="a.cjs")])
    after = combine_reports([parse_node_tap(tap([("same", "failed"), ("new", "passed")]), source_file="a.cjs")])
    diff = compare_manifests(before, after)
    assert diff["deleted"] == [{"framework": "node", "identity": "a.cjs::same", "count": 1}]
    assert diff["added"] == [{"framework": "node", "identity": "a.cjs::new", "count": 1}]
    assert diff["statusChanges"][0]["status"] == "failed"


@pytest.mark.parametrize("path", ["data/private.json", "../a.py", "/tmp/a.py", "a/../../data/x", ".", "a\\b.py",
    "tests/a\nname.py", "tests/a\rname.py", "tests/a\tname.py", "tests/a\x1bname.py", "tests/a\x7fname.py", "tests/a\x85name.py", "tests/a\x9fname.py"])
def test_default_data_or_escaping_source_paths_reject(path):
    with pytest.raises(IdentityError):
        safe_relative_path(path)


def test_signed_formal_r1_read_only_replay_preserves_every_identity_and_duplicate():
    registration = json.loads((FORMAL / "registration.json").read_text())
    actual = collect_saved_outputs(FORMAL, registration, ROOT, historical_replay=True)
    expected = signed_baseline(registration)
    assert compare_manifests(expected, actual)["identitiesMatch"] is True
    assert actual["counts"]["total"] == 1565 + 548 + 24 + 12 + 2104
    assert actual["allPassed"] is True
    assert actual["historicAttributionAmbiguities"]
    counts = Counter((row["framework"], row["identity"]) for row in actual["cases"])
    assert any(count > 1 for (framework, _), count in counts.items() if framework == "qtest")
    with pytest.raises(IdentityError, match="HISTORICAL_IDENTITIES_NOT_REGISTRATION_EXPECTATIONS"):
        require_actual_collection(actual)
