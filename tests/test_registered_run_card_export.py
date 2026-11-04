"""Independent card-export contract tests; no GUI, build or collector runs."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from script.registered_run.config import ConfigError, validate_config
from script.registered_run.contract import registration_contract, contract_sha256
from script.registered_run.export_config import CONFIG_SCHEMA, STAGE_BUDGETS
from script.registered_run.modes.context import RunContext
from script.registered_run.registration import _validated_config
from script.registered_run.stages import runtime_config


def configuration():
    return {"configSchema": CONFIG_SCHEMA, "runKind": "development", "adoptCandidate": False,
        "stopOnFirstFailure": True, "retries": 0, "sequence": ["python-unit"],
        "budgets": {STAGE_BUDGETS["python-unit"]: 1}, "timeoutsSeconds": {"python-unit": 30},
        "pythonTargets": ["tests/test_synthetic.py"], "nodeTests": ["native-ui/synthetic.test.cjs"],
        "frontendTests": ["frontend/synthetic.test.ts"], "nativeTargets": ["runtime-bridge"],
        "python": ".venv/bin/python", "node": ".tools/node/bin/node", "localSdk": ".tools/sdk",
        "candidateDirectory": ".tools/qt-candidates/synthetic-card-export", "candidateName": "synthetic-card-export",
        "cmakeDirectory": ".tools/qt-builds/synthetic-card-export", "requiredGuiModes": [],
        "nodeIdentityReport": "node-identities.jsonl"}


def context(tmp_path):
    return RunContext(Path(__file__).resolve().parents[1], tmp_path, {"node": ".tools/node/bin/node"})


def test_card_export_missing_contract_preserves_legacy_result_without_process_or_file_access(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Legacy card-export replay must not read files or launch a verifier")
    monkeypatch.setattr("subprocess.run", forbidden)
    current = context(tmp_path)
    legacy = {"reports": [{"archiveInteraction": {}}, {"personaRestart": {}}]}
    before = deepcopy(legacy)
    assert current.invoke("verify_card_export", legacy, {}, tmp_path / "removed-summary.json") is None
    assert legacy == before


def test_card_export_config_validates_explicit_v1_and_preserves_missing_legacy_field():
    legacy = configuration()
    assert "cardExportContract" not in validate_config(legacy)
    current = {**legacy, "cardExportContract": "v1"}
    assert validate_config(current)["cardExportContract"] == "v1"
    with pytest.raises(ConfigError, match="CONFIG_CARD_EXPORT_CONTRACT"):
        validate_config({**legacy, "cardExportContract": "v2"})


def test_card_export_new_registration_defaults_v1_without_rewriting_input(tmp_path):
    original = configuration()
    validated = _validated_config(tmp_path, original)
    assert validated["cardExportContract"] == "v1"
    assert "cardExportContract" not in original


def test_card_export_local_current_source_defaults_v1_and_registered_legacy_remains_absent(tmp_path):
    root = tmp_path / "repository"
    report = root / ".tools/local/synthetic/report"
    report.mkdir(parents=True)
    wrapper = root / "script/registered_run/native_stage.py"
    wrapper.parent.mkdir(parents=True)
    wrapper.write_text("# Synthetic planner input, never executed.\n")
    config = {**configuration(), "package": "synthetic-card-export"}
    assert runtime_config(root, report, config, local=True)["cardExportContract"] == "v1"
    assert "cardExportContract" not in runtime_config(root, report, config, local=False)
    assert "cardExportContract" not in config


def test_card_export_contract_version_is_bound_without_changing_legacy_projection():
    def project(config):
        return registration_contract(config, {}, {}, {},
            {"requiredGuiRuns": {}, "unitRun": {"sequence": 1}}, {}, code_tree_hash="a" * 40)
    legacy = project(configuration())
    current = project({**configuration(), "cardExportContract": "v1"})
    assert "cardExportContract" not in legacy["runtime"]
    assert current["runtime"]["cardExportContract"] == "v1"
    assert contract_sha256(current) != contract_sha256(legacy)


def test_card_export_current_contract_rejects_missing_runtime_proof_before_process(tmp_path, monkeypatch):
    monkeypatch.setattr("subprocess.run", lambda *a, **k: pytest.fail("Missing proof must fail before Node"))
    with pytest.raises(RuntimeError, match="CARD_EXPORT_RESULT_CONTRACT_CHANGED"):
        context(tmp_path).invoke("verify_card_export", {}, {"cardExportContract": "v1"}, tmp_path / "summary.json")


def test_card_export_current_contract_invokes_only_readonly_saved_artifact_verifier(tmp_path, monkeypatch):
    proof = {"passed": True, "contract": "v1", "checks": 2, "cycleChecks": [2, 0]}
    calls = []
    def verified(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(stdout=json.dumps(proof))
    monkeypatch.setattr("subprocess.run", verified)
    result = {"cardExportContract": "v1", "cardExportEvidence": proof}
    current = context(tmp_path)
    assert current.invoke("verify_card_export", result, {"cardExportContract": "v1", "node": ".tools/node/bin/node"},
                          tmp_path / "summary.json") == proof
    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command[-2:] == [str(current.root / "native-ui/card-export-verdicts.cjs"), str(tmp_path / "summary.json")]
    assert "verifySavedCardExport" in command[2] and kwargs["check"] is True


def test_card_export_recomputed_host_proof_must_equal_saved_summary(tmp_path, monkeypatch):
    returned = {"passed": True, "contract": "v1", "checks": 2, "cycleChecks": [2, 0], "sha256": "a" * 64}
    monkeypatch.setattr("subprocess.run", lambda *a, **k: SimpleNamespace(stdout=json.dumps(returned)))
    result = {"cardExportContract": "v1", "cardExportEvidence": {**returned, "sha256": "b" * 64}}
    with pytest.raises(RuntimeError, match="CARD_EXPORT_HOST_PROOF_CHANGED"):
        context(tmp_path).invoke("verify_card_export", result,
            {"cardExportContract": "v1", "node": ".tools/node/bin/node"}, tmp_path / "summary.json")
