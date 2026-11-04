from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_registry", ROOT / "native-ui/tests/native_registry.py")
registry = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(registry)

TRANSCRIPT = """\
Start testing: Oct 18 23:53 CST
1/2 Testing: runtime-bridge
Test command: /x/RuntimeBridgeTest
PASS   : RuntimeBridgeTest::initTestCase()
PASS   : RuntimeBridgeTest::malformedProviderReadCannotReconcileUnknownSave(empty-provider)
PASS   : RuntimeBridgeTest::malformedProviderReadCannotReconcileUnknownSave(empty-provider)
PASS   : RuntimeBridgeTest::malformedProviderReadCannotReconcileUnknownSave(null-provider)
PASS   : RuntimeBridgeTest::cleanupTestCase()
Test Passed.
2/2 Testing: control-readiness
Test command: /x/ControlReadinessTest
PASS   : ControlReadinessTest::initTestCase()
PASS   : ControlReadinessTest::observationsAreBounded()
PASS   : ControlReadinessTest::cleanupTestCase()
Test Passed.
"""


def test_lifecycle_rows_count_toward_every_target_total() -> None:
    targets = registry.parse_transcript(TRANSCRIPT)
    summary = registry.summarize(targets)
    assert summary["control-readiness"] == {
        "rows": 3, "lifecycleRows": 2, "functionalRows": 1, "uniqueIdentities": 3, "duplicates": {},
    }
    assert summary["runtime-bridge"]["rows"] == 5
    assert summary["runtime-bridge"]["lifecycleRows"] == 2


def test_inherited_duplicate_tags_are_compared_by_multiplicity() -> None:
    targets = registry.parse_transcript(TRANSCRIPT)
    duplicate = "RuntimeBridgeTest::malformedProviderReadCannotReconcileUnknownSave(empty-provider)"
    assert registry.summarize(targets)["runtime-bridge"]["duplicates"] == {duplicate: 2}
    added = {"control-readiness": ["ControlReadinessTest::checkInputContractTable(button-one-click)"]}
    expected = registry.plan(targets, added)
    assert expected["runtime-bridge"][duplicate] == 2
    assert registry.totals(expected) == {"runtime-bridge": 5, "control-readiness": 4}
    observed = dict(targets)
    observed["control-readiness"] = targets["control-readiness"] + added["control-readiness"]
    assert registry.compare(expected, observed) == []


def test_a_lost_duplicate_row_is_reported_with_both_counts() -> None:
    targets = registry.parse_transcript(TRANSCRIPT)
    expected = registry.plan(targets)
    duplicate = "RuntimeBridgeTest::malformedProviderReadCannotReconcileUnknownSave(empty-provider)"
    observed = {target: list(rows) for target, rows in targets.items()}
    observed["runtime-bridge"].remove(duplicate)
    assert registry.compare(expected, observed) == [{
        "target": "runtime-bridge", "kind": "count", "identity": duplicate, "expected": 2, "observed": 1,
    }]


def test_added_identities_must_be_unique_and_new() -> None:
    targets = registry.parse_transcript(TRANSCRIPT)
    with pytest.raises(registry.RegistrationError) as repeated:
        registry.plan(targets, {"control-readiness": ["ControlReadinessTest::a()", "ControlReadinessTest::a()"]})
    assert repeated.value.code == "ADDED_IDENTITY_REPEATED"
    assert repeated.value.details["identities"] == {"ControlReadinessTest::a()": 2}
    with pytest.raises(registry.RegistrationError) as collision:
        registry.plan(targets, {"control-readiness": ["ControlReadinessTest::observationsAreBounded()"]})
    assert collision.value.code == "ADDED_IDENTITY_ALREADY_REGISTERED"
    with pytest.raises(registry.RegistrationError) as unknown:
        registry.plan(targets, {"scene-director": ["SceneDirectorTest::a()"]})
    assert unknown.value.code == "TARGET_NOT_IN_BASELINE"


def test_removed_rows_must_exist_with_enough_multiplicity() -> None:
    targets = registry.parse_transcript(TRANSCRIPT)
    duplicate = "RuntimeBridgeTest::malformedProviderReadCannotReconcileUnknownSave(empty-provider)"
    expected = registry.plan(targets, removed={"runtime-bridge": [duplicate]})
    assert expected["runtime-bridge"][duplicate] == 1
    with pytest.raises(registry.RegistrationError) as short:
        registry.plan(targets, removed={"runtime-bridge": [duplicate, duplicate, duplicate]})
    assert short.value.details["identities"] == {duplicate: {"remove": 3, "registered": 2}}


def test_missing_and_unexpected_targets_are_differences() -> None:
    targets = registry.parse_transcript(TRANSCRIPT)
    expected = registry.plan(targets)
    observed = {"runtime-bridge": targets["runtime-bridge"], "scene-director": ["SceneDirectorTest::initTestCase()"]}
    kinds = {(row["target"], row["kind"]) for row in registry.compare(expected, observed)}
    assert kinds == {("control-readiness", "target-missing"), ("scene-director", "target-unexpected")}


def test_repeated_target_block_is_rejected() -> None:
    with pytest.raises(registry.RegistrationError) as repeated:
        registry.parse_transcript(TRANSCRIPT + "3/3 Testing: control-readiness\nPASS   : X::initTestCase()\n")
    assert repeated.value.code == "TARGET_REPEATED"


def test_plan_command_reads_files_and_reports_values(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    log = tmp_path / "LastTest.log"
    log.write_text(TRANSCRIPT, encoding="utf-8")
    added = tmp_path / "added.json"
    added.write_text(json.dumps({"control-readiness": ["ControlReadinessTest::a()"]}), encoding="utf-8")
    assert registry.main(["plan", "--baseline-log", str(log), "--added", str(added)]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is True
    assert result["targets"] == {"control-readiness": 4, "runtime-bridge": 5}
    assert result["qtTestTotals"] == 9
    assert result["lifecycleRows"] == {"control-readiness": 2, "runtime-bridge": 2}
    added.write_text(json.dumps({"control-readiness": ["ControlReadinessTest::initTestCase()"]}), encoding="utf-8")
    assert registry.main(["plan", "--baseline-log", str(log), "--added", str(added)]) == 1
    failure = json.loads(capsys.readouterr().out)
    assert failure == {"ok": False, "code": "ADDED_IDENTITY_ALREADY_REGISTERED",
                       "details": {"target": "control-readiness", "identities": ["ControlReadinessTest::initTestCase()"]}}
