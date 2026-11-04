"""Real-output replay and single-field rejection tests for extracted checks.

These tests never launch a build, application, Qt test or evidence producer.
The positive fixtures are the original passed formal outputs, read in place.
GUI host verifiers may invoke their existing read-only Node proof verifier.
"""

from copy import deepcopy
import json
import os
from pathlib import Path

import pytest

from script.registered_run.catalog import (
    GUI_MODES, NATIVE_PROOFS, native_stage_plan, replay_saved,
)
from script.registered_run.export_config import BASELINE_REPORT, equivalence, export_baseline
from script.registered_run.modes.context import RunContext


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def formal():
    report = Path(os.environ.get("REVERIE_FORMAL_R1_REPORT", ROOT / BASELINE_REPORT))
    if not (report / "run-ledger.json").is_file():
        pytest.skip("Original formal r1 saved output is required for real-output replay")
    config = export_baseline(report, ROOT)
    ledger = json.loads((report / "run-ledger.json").read_text())
    return report, config, ledger


@pytest.fixture
def context(formal):
    report, config, _ = formal
    return RunContext(ROOT, report, config)


def _gui(formal, mode):
    _, _, ledger = formal
    summary = Path(ledger["guiResults"][mode + "-check"]["reportRoot"]) / "summary.json"
    return json.loads(summary.read_text()), summary


def test_baseline_export_exactly_retains_registered_order_limits_targets_and_identities(formal):
    report, config, ledger = formal
    registration = json.loads((report / "registration.json").read_text())
    assert equivalence(config, registration, ledger) == []
    assert len(config["sequence"]) == 12
    assert [row["stage"].removesuffix("-check") for row in config["guiModes"]] == list(GUI_MODES)
    assert [len(ledger[key]["caseIds"]) for key in NATIVE_PROOFS] == [4, 3, 2, 3, 6, 8]
    assert config["stages"][4]["command"][-1] == str(ROOT / "script/registered_run/native_stage.py")


@pytest.mark.parametrize("stage", ["sdk-build", "python-unit", "node-unit", "frontend-unit", "native-unit",
                                    *[mode + "-check" for mode in GUI_MODES]])
def test_original_formal_saved_output_replays_with_identical_verdict(context, stage):
    replay = replay_saved(context, [stage])
    assert replay["verdictsMatchOriginal"] is True
    assert list(replay["stages"]) == [stage]
    assert "no current PID query" in replay["observations"]["regexWorkerOwnership"]


def test_common_module_preserves_strict_types_and_duplicate_key_rejection(context, tmp_path):
    assert context.invoke("integer", 1) is True
    assert context.invoke("integer", True) is False
    assert context.invoke("numeric", True) is False
    source = tmp_path / "duplicate-negative.json"
    source.write_text('{"passed":true,"passed":false}')
    with pytest.raises(RuntimeError, match="DUPLICATE_JSON_KEY"):
        context.invoke("load_json", source)


def test_contexts_do_not_share_round_paths_config_or_contract_mutations(formal, tmp_path):
    report, config, _ = formal
    first = RunContext(ROOT, report, config)
    second_config = deepcopy(config)
    second_config["candidateName"] = "independent-negative-context"
    second = RunContext(tmp_path, tmp_path / "report", second_config)
    assert first._namespace["ROOT"] == ROOT
    assert second._namespace["ROOT"] == tmp_path
    assert first._namespace["NAME"] == config["candidateName"]
    assert second._namespace["NAME"] == "independent-negative-context"
    second._namespace["FORCED_CLEANUP_SPEC"]["forcedCleanup"] = True
    assert first._namespace["FORCED_CLEANUP_SPEC"]["forcedCleanup"] is False
    assert config["candidateName"] != second_config["candidateName"]


def test_units_module_rejects_one_changed_expected_count(context):
    reg = deepcopy(context.config)
    reg["expectedPythonCount"] += 1
    with pytest.raises(RuntimeError, match="PYTHON_FILE_OR_CASE_COUNTS_CHANGED"):
        context.invoke("verify_python", reg)


def test_backup_module_rejects_one_changed_contract_field(context):
    reg = deepcopy(context.config)
    reg["pairedControlReceiptDiagnostics"]["producer"] += ".changed"
    with pytest.raises(RuntimeError, match="PAIRED_CONTROL_RECEIPT_CONTRACT_CHANGED"):
        context.invoke("verify_control_receipt", context.report_dir / "control-receipt", reg)


@pytest.mark.parametrize(("check", "contract", "field", "replacement", "code"), [
    ("verify_feedback_probe_diagnostics", "memoryFeedbackProbeDiagnostics", "expectedOperationsByCase", {},
     "MEMORY_FEEDBACK_PROBE_REGISTRATION_IDENTITY_CHANGED"),
    ("verify_summary_input_probe_diagnostics", "summaryInputProbeDiagnostics", "schemaValue", "changed",
     "SUMMARY_INPUT_REGISTERED_CONTRACT_CHANGED"),
    ("verify_directory_diagnostics", "directoryDiagnosticsContract", "schema", "changed",
     "SUMMARY_DIRECTORY_REGISTERED_CONTRACT_CHANGED"),
])
def test_each_native_diagnostics_module_rejects_single_changed_contract_field(
        context, check, contract, field, replacement, code):
    reg = deepcopy(context.config)
    reg[contract][field] = replacement
    transcript = (context.report_dir / "native-lasttest.log").read_text()
    with pytest.raises(RuntimeError, match=code):
        context.invoke(check, transcript, reg)


@pytest.mark.parametrize(("check", "contract"), [
    ("verify_native_pair", "nativeEvidenceContract"),
    ("verify_native_focus_pair", "nativeFocusEvidenceContract"),
    ("verify_native_regex_pair", "nativeRegexEvidenceContract"),
    ("verify_native_injection_depth_pair", "nativeInjectionDepthEvidenceContract"),
    ("verify_native_injection_navigation_pair", "nativeInjectionNavigationEvidenceContract"),
    ("verify_native_injection_hit_pair", "nativeInjectionHitEvidenceContract"),
])
def test_each_native_evidence_group_rejects_single_changed_source_hash(context, check, contract):
    reg = deepcopy(context.config)
    reg[contract]["sha256"] = "0" * 64
    with pytest.raises(RuntimeError, match="CHANGED"):
        context.invoke(check, reg)


def test_gui_common_module_rejects_boolean_in_integer_cleanup_field(context, formal):
    result, _ = _gui(formal, "injection")
    result["forcedCleanupTargets"] = False
    with pytest.raises(RuntimeError, match="ORDINARY_FORCED_CLEANUP_NOT_EXPLICIT_NORMAL"):
        context.invoke("verify_forced_cleanup", result, context.config)


@pytest.mark.parametrize(("mode", "check", "contract", "field", "replacement", "code"), [
    ("injection", "verify_injection", "injectionGui", "cycles", 3, "INJECTION_GUI_CONTRACT_CHANGED"),
    ("regex", "verify_regex", "regexGui", "cycles", 3, "REGEX_GUI_CONTRACT_CHANGED"),
    ("entry", "verify_entry_settings", "entryGui", "cycles", 3, "ENTRY_GUI_CONTRACT_CHANGED"),
    ("persona", "verify_persona_priority", "personaGui", "cycles", 3, "PERSONA_GUI_CONTRACT_CHANGED"),
])
def test_each_named_gui_module_rejects_one_changed_contract_field(
        context, formal, mode, check, contract, field, replacement, code):
    result, summary = _gui(formal, mode)
    reg = deepcopy(context.config)
    reg[contract][field] = replacement
    with pytest.raises(RuntimeError, match=code):
        context.invoke(check, result, reg, summary)


def test_candidate_module_rejects_one_changed_model_request_count(context, formal):
    result, _ = _gui(formal, "candidate")
    result["requests"] = True
    view = {**context.config, "gui": context.config["candidateGui"]}
    with pytest.raises(RuntimeError, match="ORDINARY_MODEL_REQUEST_COUNTS_CHANGED"):
        context.invoke("verify_candidate_paging_gui", result, view)


def test_ordinary_module_rejects_one_changed_pass_flag(context, formal):
    result, _ = _gui(formal, "ordinary")
    result["passed"] = False
    with pytest.raises(RuntimeError, match="ORDINARY_NOT_PASSED"):
        context.invoke("verify_gui", result, context.config)


def test_summary_acquisition_module_rejects_one_changed_contract_field(context, formal):
    result, _ = _gui(formal, "ordinary")
    reg = deepcopy(context.config)
    reg["summaryAcquisitionDiagnostics"]["records"] += 1
    with pytest.raises(RuntimeError, match="SUMMARY_ACQUISITION_REGISTERED_CONTRACT_CHANGED"):
        context.invoke("verify_summary_acquisition", result, reg)


def test_summary_view_module_rejects_one_changed_contract_field(context, formal):
    result, summary = _gui(formal, "ordinary")
    reg = deepcopy(context.config)
    reg["summaryViewContract"]["schema"] = "changed"
    with pytest.raises(RuntimeError, match="SUMMARY_VIEW_REGISTERED_CONTRACT_CHANGED"):
        context.invoke("verify_summary_view", result, reg, summary, [], result["build"])


def test_settings_module_rejects_one_changed_contract_field(context, formal):
    result, _ = _gui(formal, "settings")
    reg = deepcopy(context.config)
    reg["settingsContract"]["changeChecks"][0] += "-changed"
    with pytest.raises(RuntimeError, match="REGISTERED_SETTINGS_CONTRACT_CHANGED"):
        context.invoke("verify_settings", result, reg,
                       context.root / reg["candidateDirectory"], context.root / reg["cmakeDirectory"])


def test_replay_rejects_a_single_changed_expected_identity(formal):
    report, config, _ = formal
    config = deepcopy(config)
    config["expectedPythonIdentities"][0] += "_changed"
    with pytest.raises(RuntimeError, match="PYTHON_IDENTITIES_MISMATCH"):
        replay_saved(RunContext(ROOT, report, config), ["python-unit"])


def test_native_stage_plan_preserves_one_ctest_and_one_joint_consumer(context, formal):
    _, _, ledger = formal
    plan = native_stage_plan(context)
    assert plan["ctest"][plan["ctest"].index("--parallel") + 1] == "1"
    assert plan["nativeTargets"] == context.config["nativeExecutionOrder"]
    assert plan["timeoutSeconds"] == 300
    assert len(plan["groups"]) == 6
    assert len(plan["consumer"]) == 2 + 6 * 3
    assert [len(ledger[key]["caseIds"]) for key in NATIVE_PROOFS] == [4, 3, 2, 3, 6, 8]
    assert len(set(plan["environment"])) == 6
