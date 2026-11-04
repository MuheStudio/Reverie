"""Independent edit-contract coverage; old immutable reports stay untouched."""
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
        "candidateDirectory": ".tools/qt-candidates/synthetic-card-edit", "candidateName": "synthetic-card-edit",
        "cmakeDirectory": ".tools/qt-builds/synthetic-card-edit", "requiredGuiModes": [],
        "nodeIdentityReport": "node-identities.jsonl"}


def context(tmp_path):
    return RunContext(Path(__file__).resolve().parents[1], tmp_path, {"node": ".tools/node/bin/node"})


def test_card_edit_missing_contract_preserves_legacy_without_process_or_artifact_access(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Historical card reports must not invoke the new verifier")
    monkeypatch.setattr("subprocess.run", forbidden)
    current = context(tmp_path)
    legacy = {"reports": [{"archiveInteraction": {}}, {"personaRestart": {}}],
              "cardExportContract": "v1", "cardExportEvidence": {"passed": True}}
    before = deepcopy(legacy)
    assert current.invoke("verify_card_edit", legacy, {}, tmp_path / "missing-summary.json") is None
    assert legacy == before


def test_card_edit_validator_keeps_missing_historical_contract_and_accepts_explicit_v1():
    old = configuration()
    assert "cardEditContract" not in validate_config(old)
    assert validate_config({**old, "cardEditContract": "v1"})["cardEditContract"] == "v1"
    assert "cardEditContract" not in old


@pytest.mark.parametrize("version", [None, "v2", 1, True])
def test_card_edit_validator_rejects_unknown_or_nonstring_contract(version):
    with pytest.raises(ConfigError, match="CONFIG_CARD_EDIT_CONTRACT"):
        validate_config({**configuration(), "cardEditContract": version})


def test_card_edit_new_registration_defaults_v1_without_rewriting_input(tmp_path):
    old = configuration()
    result = _validated_config(tmp_path, old)
    assert result["cardEditContract"] == "v1"
    assert result["cardExportContract"] == "v1"
    assert result["memoryActionContract"] == "v2"
    assert "cardEditContract" not in old


def test_card_edit_local_current_source_defaults_v1_while_registered_legacy_stays_absent(tmp_path):
    root = tmp_path / "repository"
    report = root / ".tools/local/synthetic/report"
    report.mkdir(parents=True)
    wrapper = root / "script/registered_run/native_stage.py"
    wrapper.parent.mkdir(parents=True)
    wrapper.write_text("# Planner input only; never executed.\n")
    config = {**configuration(), "package": "synthetic-card-edit"}
    assert runtime_config(root, report, config, local=True)["cardEditContract"] == "v1"
    assert "cardEditContract" not in runtime_config(root, report, config, local=False)
    assert "cardEditContract" not in config


def test_card_edit_contract_version_is_hashed_and_other_contracts_are_unchanged():
    def project(config):
        return registration_contract(config, {}, {}, {},
            {"requiredGuiRuns": {}, "unitRun": {"sequence": 1}}, {}, code_tree_hash="a" * 40)
    config = {**configuration(), "memoryActionContract": "v2", "cardExportContract": "v1"}
    before = project(config)
    after = project({**config, "cardEditContract": "v1"})
    assert "cardEditContract" not in before["runtime"]
    assert after["runtime"].pop("cardEditContract") == "v1"
    assert after == before
    assert contract_sha256(project({**config, "cardEditContract": "v1"})) != contract_sha256(before)


def test_card_edit_missing_current_proof_is_rejected_before_subprocess(tmp_path, monkeypatch):
    monkeypatch.setattr("subprocess.run", lambda *a, **k: pytest.fail("Missing proof must fail first"))
    with pytest.raises(RuntimeError, match="CARD_EDIT_RESULT_CONTRACT_CHANGED"):
        context(tmp_path).invoke("verify_card_edit", {}, {"cardEditContract": "v1"}, tmp_path / "summary.json")


def test_card_edit_current_contract_uses_readonly_saved_verifier_and_exact_result(tmp_path, monkeypatch):
    proof = {"passed": True, "contract": "v1", "writes": [2, 0], "switches": [2, 2]}
    calls = []
    def verified(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(stdout=json.dumps(proof))
    monkeypatch.setattr("subprocess.run", verified)
    result = {"cardEditContract": "v1", "cardEditEvidence": proof}
    current = context(tmp_path)
    assert current.invoke("verify_card_edit", result,
        {"cardEditContract": "v1", "node": ".tools/node/bin/node"}, tmp_path / "summary.json") == proof
    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command[-2:] == [str(current.root / "native-ui/card-edit-verdicts.cjs"), str(tmp_path / "summary.json")]
    assert "verifySavedCardEdit" in command[2] and kwargs["check"] is True


@pytest.mark.parametrize("failure", ["unpassed", "wrong-version", "changed-summary"])
def test_card_edit_recomputed_proof_must_pass_and_equal_saved_result(tmp_path, monkeypatch, failure):
    baseline = {"passed": True, "contract": "v1", "writes": [2, 0]}
    returned = deepcopy(baseline)
    saved = deepcopy(baseline)
    if failure == "unpassed":
        returned["passed"] = False
    elif failure == "wrong-version":
        returned["contract"] = "v0"
    else:
        saved["writes"] = [1, 0]
    monkeypatch.setattr("subprocess.run", lambda *a, **k: SimpleNamespace(stdout=json.dumps(returned)))
    with pytest.raises(RuntimeError, match="CARD_EDIT_HOST_PROOF_CHANGED"):
        context(tmp_path).invoke("verify_card_edit", {"cardEditContract": "v1", "cardEditEvidence": saved},
            {"cardEditContract": "v1", "node": ".tools/node/bin/node"}, tmp_path / "summary.json")
