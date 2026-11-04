"""Versioned host checks use explicit synthetic, in-memory unit fixtures.

These records are never exported as runtime evidence. Existing signed tests
and their helpers remain unchanged; real GUI acquisition belongs to local CLI
runs performed after the source commit.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from script.registered_run import catalog, export_config, registration
from script.registered_run.config import ConfigError, validate_config
from script.registered_run.contract import contract_sha256, registration_contract
from script.registered_run.export_config import CONFIG_SCHEMA
from script.registered_run.modes.context import RunContext


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def context(tmp_path):
    return RunContext(ROOT, tmp_path, {"memoryActionContract": "v2"})


@pytest.fixture
def synthetic_acquisition(context):
    spec = context.invoke("memory_action_spec_v2")
    entries, previous_request = [], "synthetic-prior-action"
    changes = {1: (0.5, 0.6), 2: (0.6, 0.5), 3: (0.5, 0.65)}
    for index, name in enumerate(spec["names"]):
        subject = "synthetic-candidate" if index == 0 else (
            "synthetic-revised-memory" if index >= 9 else "synthetic-memory")
        step_at = 1400 if index == 8 else index * 200
        elapsed = 170 if index == 8 else 60
        stable = {"ready": True, "layoutStable": True, "rowId": subject,
            "scope": "synthetic-scope", "control": spec["controls"][index],
            "elapsedMs": 60, "stableSinceMs": 0, "frameSerial": 2, "stableFrameSerial": 1,
            "centerX": 10, "centerY": 20,
            **{key: True for key in ("found", "enabled", "visible", "inputPointInsideClip",
                                     "surfaceClosed", "geometryValid", "integerCenterInsideClip")}}
        sequence_names = spec["names"][7:9] if index in (7, 8) else [name]
        sequence = {"expired": False, "failed": False, "actions": [
            {"name": part, "attempted": True, "performed": True, "failed": False,
             "actionElapsedMs": 170 if part == "edit-save" else 60} for part in sequence_names]}
        terminal = {"layout": {"ready": True, "minimumStableMs": 40, "last": stable},
                    "sequence": sequence}
        first = {"listId": "synthetic-list-before-" + str(index),
                 "candidateReadId": "synthetic-candidate-before-" + str(index)}
        entry = {"action": name, "subjectId": subject, "scope": "synthetic-scope", "generation": 3,
            "control": spec["controls"][index], "verb": spec["verbs"][index],
            "inputStep": spec["steps"][index], "stepAt": step_at, "inputDeadlineMs": 4000,
            "inputElapsedMs": elapsed, "terminalOverallMs": step_at + 190,
            "status": "success", "attempted": True, "performed": True,
            "inputPoint": {"x": 10, "y": 20}, "clickCount": 0 if index == 7 else 1,
            "commitCount": 1 if index == 7 else 0,
            "diagnostic": {"sampleLimit": 6, "terminalCount": 1, "observations": 2,
                           "samples": [first, deepcopy(first)], "terminal": terminal}}
        if index in spec["backend"]:
            request = "synthetic-action-" + str(index)
            receipt = {"armed": True, "complete": True, "failed": False, "status": "success",
                "actionSuccess": True, "newActionCount": 1, "scope": entry["scope"],
                "verb": entry["verb"], "subjectId": subject, "requestId": request,
                "oldActionId": previous_request, "listSuccess": True, "candidateSuccess": True,
                "listId": "synthetic-list-after-" + str(index),
                "armedListId": "synthetic-list-armed-" + str(index),
                "successListId": "synthetic-list-barrier-" + str(index),
                "candidateReadId": "synthetic-candidate-after-" + str(index),
                "armedCandidateReadId": "synthetic-candidate-armed-" + str(index),
                "successCandidateReadId": "synthetic-candidate-barrier-" + str(index)}
            previous_request = request
            terminal["receipt"] = receipt
            terminal["feedbackValidation"] = {"phase": "first-validation", "requestId": request,
                "scope": entry["scope"], "enabled": False, "textLength": 8, "expectedLength": 8,
                "elapsedMs": 180, "frameSerial": 3,
                **{key: True for key in ("found", "visible", "textMatches", "fullyVisible", "validated")},
                **{key: 1 for key in ("sceneX", "sceneY", "sceneWidth", "sceneHeight",
                                      "clipX", "clipY", "clipWidth", "clipHeight")}}
            if index in changes:
                before, after = changes[index]
                receipt.update(generation=3, changed=True, op=name, memoryId=subject,
                               importanceBefore=before, importanceAfter=after)
                terminal["adjustment"] = {"op": name, "memoryId": subject, "scope": entry["scope"],
                    "generation": 3, "requestId": request, "beforeImportance": before,
                    "afterImportance": after, "readbackImportance": after,
                    "importanceText": context.invoke("memory_importance_text_v2", after)}
        if index in (6, 7, 8):
            entry["editingIdMatches"] = True
        if index in (9, 10):
            entry["deletingIdMatches"] = True
        if index == 7:
            entry.update(focusInTarget=True, inputMatchesFixture=True, inputLength=12)
        entries.append(entry)
    return {"memoryActionAcquisition": entries}


def test_v2_accepts_eleven_inputs_and_eight_correlated_writes(context, synthetic_acquisition):
    entries = context.invoke("verify_memory_actions_v2", synthetic_acquisition)
    context.invoke("verify_memory_feedback_v2", entries)
    assert len(entries) == 11
    assert sum("receipt" in entry["diagnostic"]["terminal"] for entry in entries) == 8
    assert [entry["inputStep"] for entry in entries if entry["action"] in
            ("candidate-confirm", "pin", "unpin", "open-edit", "edit-input", "edit-save", "open-delete", "delete-confirm")] == [
                210, 211, 212, 213, 214, 214, 215, 216]


@pytest.mark.parametrize(("field", "value", "error"), [
    ("beforeImportance", True, "IMPORTANCE_INVALID"),
    ("afterImportance", 1.1, "IMPORTANCE_INVALID"),
    ("readbackImportance", 0.6000001, "IMPORTANCE_INVALID"),
    ("beforeImportance", float("nan"), "UNSUPPORTED_VALUE"),
    ("afterImportance", 0.7, "BACKEND_VALUES_CHANGED"),
    ("readbackImportance", 0.5, "READBACK_OR_UI_MISMATCH"),
    ("importanceText", "重要度 0.60", "READBACK_OR_UI_MISMATCH"),
    ("generation", 4, "ADJUSTMENT_NOT_BOUND"),
    ("scope", "another-scope", "ADJUSTMENT_NOT_BOUND"),
    ("requestId", "stale-action", "ADJUSTMENT_NOT_BOUND"),
    ("memoryId", "another-memory", "ADJUSTMENT_NOT_BOUND"),
    ("op", "weaken", "ADJUSTMENT_NOT_BOUND"),
])
def test_v2_rejects_changed_adjustment_metadata(context, synthetic_acquisition, field, value, error):
    synthetic_acquisition["memoryActionAcquisition"][1]["diagnostic"]["terminal"]["adjustment"][field] = value
    with pytest.raises(RuntimeError, match=error):
        context.invoke("verify_memory_actions_v2", synthetic_acquisition)


@pytest.mark.parametrize(("index", "field", "value", "error"), [
    (1, "generation", 4, "ADJUSTMENT_NOT_BOUND"),
    (1, "importanceBefore", 0.4, "BACKEND_VALUES_CHANGED"),
    (1, "importanceAfter", 0.7, "BACKEND_VALUES_CHANGED"),
    (1, "oldActionId", "stale-chain", "BACKEND_ACTION_CHAIN_CHANGED"),
    (1, "listId", "synthetic-list-barrier-1", "READBACK_NOT_NEW_AFTER_ACTION_SUCCESS"),
    (1, "candidateReadId", "synthetic-candidate-before-1", "READBACK_NOT_NEW_AFTER_ACTION_SUCCESS"),
    (3, "changed", False, "DEFAULT_OPERATION_CHANGED"),
])
def test_v2_rejects_unbound_or_stale_backend_receipt(context, synthetic_acquisition, index, field, value, error):
    synthetic_acquisition["memoryActionAcquisition"][index]["diagnostic"]["terminal"]["receipt"][field] = value
    with pytest.raises(RuntimeError, match=error):
        context.invoke("verify_memory_actions_v2", synthetic_acquisition)


def test_v2_rejects_default_delta_change_even_when_receipt_and_readback_agree(context, synthetic_acquisition):
    terminal = synthetic_acquisition["memoryActionAcquisition"][1]["diagnostic"]["terminal"]
    terminal["receipt"]["importanceAfter"] = 0.7
    terminal["adjustment"].update(afterImportance=0.7, readbackImportance=0.7, importanceText="重要度 0.7")
    with pytest.raises(RuntimeError, match="DEFAULT_OPERATION_CHANGED"):
        context.invoke("verify_memory_actions_v2", synthetic_acquisition)


@pytest.mark.parametrize(("index", "before", "after", "changed"), [
    (1, 0.95, 1.0, True), (1, 1.0, 1.0, False), (1, 0.123456, 0.223456, True),
    (2, 0.05, 0.0, True), (2, 0.0, 0.0, False), (3, 1.0, 1.0, True),
])
def test_v2_default_adjustments_clamp_and_reactivate_at_upper_bound(
        context, synthetic_acquisition, index, before, after, changed):
    entry = synthetic_acquisition["memoryActionAcquisition"][index]
    terminal = entry["diagnostic"]["terminal"]
    terminal["receipt"].update(importanceBefore=before, importanceAfter=after, changed=changed)
    terminal["adjustment"].update(beforeImportance=before, afterImportance=after,
        readbackImportance=after, importanceText=context.invoke("memory_importance_text_v2", after))
    context.invoke("verify_memory_adjustment_v2", entry)


def test_v2_requires_each_adjustment_to_start_from_previous_readback(context, synthetic_acquisition):
    terminal = synthetic_acquisition["memoryActionAcquisition"][2]["diagnostic"]["terminal"]
    terminal["receipt"].update(importanceBefore=0.4, importanceAfter=0.3)
    terminal["adjustment"].update(beforeImportance=0.4, afterImportance=0.3,
                                  readbackImportance=0.3, importanceText="重要度 0.3")
    with pytest.raises(RuntimeError, match="IMPORTANCE_CHAIN_CHANGED"):
        context.invoke("verify_memory_actions_v2", synthetic_acquisition)


def test_v2_rejects_reordered_or_missing_actions_and_new_body_fields(context, synthetic_acquisition):
    original = deepcopy(synthetic_acquisition)
    synthetic_acquisition["memoryActionAcquisition"][1:3] = reversed(synthetic_acquisition["memoryActionAcquisition"][1:3])
    with pytest.raises(RuntimeError, match="ORDER_OR_COUNT"):
        context.invoke("verify_memory_actions_v2", synthetic_acquisition)
    original["memoryActionAcquisition"][1]["diagnostic"]["terminal"]["adjustment"]["body"] = "private"
    with pytest.raises(RuntimeError, match="UNKNOWN_OR_BODY_FIELD"):
        context.invoke("verify_memory_actions_v2", original)


def test_v2_requires_eight_first_feedback_receipts(context, synthetic_acquisition):
    entries = context.invoke("verify_memory_actions_v2", synthetic_acquisition)
    entries[2]["diagnostic"]["terminal"]["feedbackValidation"]["requestId"] = "stale-feedback"
    with pytest.raises(RuntimeError, match="NOT_BOUND_TO_NEW_ACTION"):
        context.invoke("verify_memory_feedback_v2", entries)


def test_v1_dispatch_retains_original_verifiers_and_rejects_v2_rows(context, synthetic_acquisition):
    sentinel = object()
    context._namespace["verify_memory_actions"] = lambda archive: sentinel
    context._namespace["verify_memory_feedback"] = lambda entries: ("v1", entries)
    assert context.invoke("verify_memory_actions_for_contract", {}, {}) is sentinel
    assert context.invoke("verify_memory_feedback_for_contract", sentinel, {}) == ("v1", sentinel)
    original = RunContext(ROOT, context.report_dir, {})
    with pytest.raises(RuntimeError, match="ORDER_OR_COUNT"):
        original.invoke("verify_memory_actions", synthetic_acquisition)


@pytest.mark.parametrize("mode", catalog.GUI_MODES)
def test_every_gui_mode_consumes_v2_acquisition_proof(mode, tmp_path):
    config = {"memoryActionContract": "v2", catalog.GUI_FIELDS[mode]: {}}
    context = RunContext(ROOT, tmp_path, config)
    proof = [{"syntheticUnitFixture": True}]
    context._namespace["load_json"] = lambda path: {}
    context._namespace["load_report_roots"] = lambda snapshot: []
    context._namespace["verify_memory_action_result_v2"] = lambda result: proof
    for name in ("verify_gui_report_binding", "verify_archive_control_inputs", "verify_forced_cleanup",
                 "verify_injection", "verify_regex", "verify_regex_worker_ownership", "verify_entry_settings",
                 "verify_candidate_batch", "verify_settings_ordinary", "verify_settings", "verify_memory_batch_delete",
                 "verify_summary_acquisition", "verify_summary_view", "verify_reply_start", "verify_pin",
                 "verify_persona_priority"):
        context._namespace[name] = lambda *args: {}
    context._namespace["verify_persona_row_inputs"] = lambda *args: {"row": {}, "author": {}}
    context._namespace["verify_candidate_paging_gui"] = lambda *args: {}
    context._namespace["verify_gui"] = lambda *args: {}
    context.config.update(candidateDirectory="synthetic-build", cmakeDirectory="synthetic-cmake")
    assert catalog.verify_mode(context, mode, tmp_path / "summary.json", snapshot={}, run_record={})[
        "memoryActionAcquisition"] is proof


def minimal_config():
    return {"configSchema": CONFIG_SCHEMA, "runKind": "formal", "adoptCandidate": False,
        "sequence": ["python-unit"], "budgets": {"pythonBatch": 1}, "timeoutsSeconds": {"python-unit": 30},
        "stopOnFirstFailure": True, "retries": 0, "pythonTargets": ["tests/synthetic.py"],
        "nodeTests": ["synthetic.test.cjs"], "frontendTests": ["synthetic.test.ts"], "nativeTargets": ["synthetic"],
        "python": ".venv/bin/python", "node": ".tools/node/bin/node", "localSdk": ".tools/sdk",
        "cmakeDirectory": ".tools/qt-builds/synthetic", "candidateDirectory": ".tools/qt-candidates/synthetic",
        "candidateName": "synthetic", "requiredGuiModes": [], "nodeIdentityReport": "node-identities.jsonl"}


def test_config_keeps_absent_legacy_version_and_rejects_unknown_versions(tmp_path):
    config = minimal_config()
    assert "memoryActionContract" not in validate_config(config)
    assert registration._validated_config(tmp_path, config)["memoryActionContract"] == "v2"
    assert "memoryActionContract" not in config
    for version in (None, "v3", {}, True):
        with pytest.raises(ConfigError, match="MEMORY_ACTION_CONTRACT"):
            validate_config({**config, "memoryActionContract": version})


def test_contract_hash_binds_explicit_memory_action_version():
    config = minimal_config()
    local = {"unitRun": {"sequence": 1}, "requiredGuiRuns": {}}
    first = registration_contract(config, {}, {}, {}, local, {}, code_tree_hash="a" * 40)
    second = registration_contract({**config, "memoryActionContract": "v2"}, {}, {}, {}, local, {},
                                   code_tree_hash="a" * 40)
    assert "memoryActionContract" not in first["runtime"]
    assert second["runtime"]["memoryActionContract"] == "v2"
    assert contract_sha256(first) != contract_sha256(second)


def test_new_registration_requires_v2_while_legacy_config_loading_retains_v1(tmp_path):
    config = minimal_config()
    legacy = {**config, "memoryActionContract": "v1"}
    assert validate_config(legacy)["memoryActionContract"] == "v1"
    with pytest.raises(registration.RegistrationError, match="REGISTRATION_MEMORY_ACTION_CONTRACT_V2_REQUIRED"):
        registration._validated_config(tmp_path, legacy)
    assert registration._validated_config(tmp_path, {**config, "memoryActionContract": "v2"})[
        "memoryActionContract"] == "v2"
    assert registration._validated_config(tmp_path, config)["memoryActionContract"] == "v2"
    assert "memoryActionContract" not in config


@pytest.mark.parametrize("version", [None, "v1", "v2"])
def test_baseline_export_retains_memory_action_version_without_inventing_one(tmp_path, monkeypatch, version):
    config = minimal_config()
    if version is not None:
        config["memoryActionContract"] = version
    report = tmp_path / ".tools/reports/synthetic-export"
    report.mkdir(parents=True)
    ledger = {"passed": True, "sourceHead": "a" * 40, "runs": [{"id": "python-unit",
        "exitCode": 0, "state": "completed", "command": ["synthetic-only"], "timeoutSeconds": 30}]}
    payload = (json.dumps(ledger) + "\n").encode()
    (report / "run-ledger.json").write_bytes(payload)
    metadata = {"schema": export_config.REGISTRATION_SCHEMA, "_verification": {
        "registrationSha256": "b" * 64, "ledgerSha256": hashlib.sha256(payload).hexdigest(),
        "publicResult": {"path": "synthetic-result.json", "sha256": "c" * 64}}}
    monkeypatch.setattr(export_config, "load_signed_baseline", lambda *args: (deepcopy(config), metadata))
    exported = export_config.export_baseline(report, tmp_path)
    if version is None:
        assert "memoryActionContract" not in exported
    else:
        assert exported["memoryActionContract"] == version
    assert exported["sequence"] == config["sequence"]
    assert exported["budgets"] == config["budgets"]
    assert exported["timeoutsSeconds"] == config["timeoutsSeconds"]
