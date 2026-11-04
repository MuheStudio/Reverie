"""Real Git ancestry and commit-independent, data-only freeze preparation.

Saved engine outputs are explicit synthetic fixtures. Git commits and source
snapshots are real; these tests never execute a project test/build/GUI command.
"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess

import pytest

from script.registered_run import registration as reg
from script.registered_run import source as source_module
from script.registered_run.contract import contract_sha256, registration_contract
from script.registered_run.state import ExecutionLock, LocalRunState, RegistrationState
from tests.test_registered_run_registration import prepared, dump


def git(root, *arguments):
    return subprocess.run(["git", "-C", str(root), *arguments], check=True, capture_output=True,
                          text=True, timeout=30).stdout.strip()


def commit(root, message):
    git(root, "add", ".")
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "commit", "-qm", message)
    return git(root, "rev-parse", "HEAD")


def refresh_source(value):
    current = source_module.snapshot_source(value.root)
    value.source.clear()
    value.source.update(current)
    return current


@pytest.fixture
def git_prepared(prepared, monkeypatch):
    value = prepared
    if not (value.root / ".git").exists():
        git(value.root, "init", "-q")
    (value.root / ".gitignore").write_text(".tools/\n")
    for filename, text in {
        "tests/test_a.py": "def test_a():\n    assert True\n",
        "script/tool.py": "VALUE = 1\n",
        "native-ui/tests/contract.json": '{"threshold": 1}\n',
        "docs/plan.md": "Confirmed direction.\n",
    }.items():
        path = value.root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    commit(value.root, "synthetic source and immutable baseline metadata")
    current = refresh_source(value)
    assert current["dirty"] is False
    value.local_source = deepcopy(current)
    for row, output in zip(value.rows, (value.output, value.gui_output)):
        row.update(sourceHead=current["head"], sourceTreeHash=current["treeHash"], codeTreeHash=current["codeTreeHash"])
        ledger_path = output / "run-ledger.json"
        ledger = json.loads(ledger_path.read_text())
        ledger.update(sourceHead=current["head"], sourceTreeHash=current["treeHash"], codeTreeHash=current["codeTreeHash"])
        runtime_path = output / "runtime-config.json"
        runtime = json.loads(runtime_path.read_text())
        runtime["sourceHead"] = current["head"]
        runtime_digest = dump(runtime_path, runtime)
        ledger["runtimeConfigBinding"].update(sha256=runtime_digest, bytes=runtime_path.stat().st_size)
        if row["category"] == "gui":
            summary_path = value.gui_report / "summary.json"
            summary = json.loads(summary_path.read_text())
            summary["sourceHead"] = current["head"]
            summary_digest = dump(summary_path, summary)
            ledger["guiResults"]["persona-check"]["summarySha256"] = summary_digest
            ledger["runs"][0]["evidence"]["guiResults"]["persona-check"]["summarySha256"] = summary_digest
        dump(ledger_path, ledger)
    value.write_rows()
    monkeypatch.setattr(reg, "snapshot_source", source_module.snapshot_source)
    monkeypatch.setattr(reg, "assert_frozen", source_module.assert_frozen)
    return value


def run_rehearsal(value, name="freeze-rehearsal"):
    output = value.ledger.parent / name
    return reg.rehearsal(value.root, "process-tools", value.config, value.report, output)


def run_freeze(value, expected=None):
    return reg.freeze(value.root, "process-tools", value.config, value.report, expected_contract_sha256=expected)


def assert_not_frozen(value):
    assert not value.report.exists()
    assert not (value.root / ".tools/registered-run/active-registration.json").exists()
    assert not (value.root / ".tools/registered-run/active-local.json").exists()


def test_docs_only_commit_accepts_previous_clean_runs_and_records_each_source_link(git_prepared):
    value = git_prepared
    before = run_rehearsal(value)
    docs = value.root / "docs/registration-preparation.md"
    docs.write_text("Contract " + before["contractSha256"] + "\n")
    commit(value.root, "docs-only registration preparation")
    current = refresh_source(value)
    assert current["head"] != value.local_source["head"]
    assert current["treeHash"] != value.local_source["treeHash"]
    assert current["codeTreeHash"] == value.local_source["codeTreeHash"]
    frozen = run_freeze(value, before["contractSha256"])
    assert frozen["contractSha256"] == before["contractSha256"]
    assert frozen["sourceHead"] == current["head"]
    assert frozen["sourceTreeHash"] == current["treeHash"]
    assert frozen["localPrerequisiteSourceLinks"] == [
        {"sequence": sequence, "sourceHead": value.local_source["head"],
         "interveningDocumentationPaths": ["docs/registration-preparation.md"]} for sequence in (1, 2)]
    prerequisites = json.loads((value.report / "local-prerequisites.json").read_text())
    for record in (prerequisites["unitRun"], prerequisites["requiredGuiRuns"]["persona"]):
        assert record["sourceHead"] == value.local_source["head"]
        assert record["interveningDocumentationPaths"] == ["docs/registration-preparation.md"]
    assert json.loads((value.report / "source-snapshot.json").read_text()) == current
    assert frozen["artifacts"]["contract.json"] == hashlib.sha256((value.report / "contract.json").read_bytes()).hexdigest()


@pytest.mark.parametrize("path", ["tests/test_a.py", "script/tool.py", "native-ui/tests/contract.json"])
def test_any_non_docs_commit_rejects_even_if_a_row_claims_equal_code(git_prepared, path):
    value = git_prepared
    target = value.root / path
    target.write_text(target.read_text() + "\n")
    commit(value.root, "non-document change")
    current = refresh_source(value)
    assert current["codeTreeHash"] != value.local_source["codeTreeHash"]
    with pytest.raises(reg.RegistrationError, match="LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED"):
        run_freeze(value)
    forged = {**value.rows[0], "codeTreeHash": current["codeTreeHash"]}
    assert reg._local_source_link(value.root, forged, current) is None
    assert_not_frozen(value)


def test_nonancestor_head_rejects_despite_equal_code_and_only_docs_diff(git_prepared):
    value = git_prepared
    base = value.local_source["head"]
    (value.root / "docs/left.md").write_text("left\n")
    sibling = commit(value.root, "unrelated left documentation")
    git(value.root, "checkout", "--detach", base)
    (value.root / "docs/right.md").write_text("right\n")
    commit(value.root, "unrelated right documentation")
    current = refresh_source(value)
    assert current["codeTreeHash"] == value.local_source["codeTreeHash"]
    for row in value.rows:
        row["sourceHead"] = sibling
    value.write_rows()
    assert reg._local_source_link(value.root, value.rows[0], current) is None
    with pytest.raises(reg.RegistrationError, match="LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED"):
        run_freeze(value)
    assert_not_frozen(value)


@pytest.mark.parametrize("failed_head,dirty", [("unrelated", True), ("ancestor", False)])
def test_unresolved_equal_code_failure_includes_ineligible_history(git_prepared, failed_head, dirty):
    value = git_prepared
    failed = {**value.rows[0], "sequence": 3, "passed": False, "exitCode": 1, "sourceDirty": dirty}
    if failed_head == "unrelated":
        failed["sourceHead"] = "f" * 40
    value.rows.append(failed)
    value.write_rows()
    (value.root / "docs/failure-analysis-pending.md").write_text("Documentation alone does not erase failure.\n")
    commit(value.root, "docs after failure")
    refresh_source(value)
    with pytest.raises(reg.RegistrationError, match=r"LOCAL_UNANALYSED_FAILURE_OR_INSTABILITY:\[3\]"):
        run_rehearsal(value)
    assert_not_frozen(value)
    assert not (value.ledger.parent / "freeze-rehearsal").exists()


def test_only_full_tree_old_rows_never_qualify(git_prepared):
    value = git_prepared
    for row in value.rows:
        del row["codeTreeHash"]
    value.write_rows()
    assert value.rows[0]["sourceTreeHash"] == value.source["treeHash"]
    assert value.rows[0]["sourceHead"] == value.source["head"]
    with pytest.raises(reg.RegistrationError, match="LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED"):
        run_freeze(value)
    assert_not_frozen(value)


@pytest.mark.parametrize("row_index,expected", [
    (0, "LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED"),
    (1, "LOCAL_FROZEN_GUI_PASS_REQUIRED:persona"),
])
def test_same_clean_head_requires_identical_full_source_tree(git_prepared, row_index, expected):
    value = git_prepared
    row = value.rows[row_index]
    assert row["sourceHead"] == value.source["head"]
    assert row["sourceDirty"] is False and value.source["dirty"] is False
    assert row["codeTreeHash"] == value.source["codeTreeHash"]
    row["sourceTreeHash"] = "d" * 40
    value.write_rows()
    assert reg._local_source_link(value.root, row, value.source) is None
    with pytest.raises(reg.RegistrationError, match=expected):
        run_freeze(value)
    assert_not_frozen(value)


def test_code_tree_mismatch_independently_rejects_same_head_and_full_tree(git_prepared):
    value = git_prepared
    row = value.rows[0]
    assert row["sourceHead"] == value.source["head"]
    assert row["sourceTreeHash"] == value.source["treeHash"]
    row["codeTreeHash"] = "d" * 40
    value.write_rows()
    with pytest.raises(reg.RegistrationError, match="LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED"):
        run_freeze(value)
    assert_not_frozen(value)


@pytest.mark.parametrize("missing", [None, "invalid", "absent"])
def test_source_requires_code_hash_unconditionally_even_for_api_call(git_prepared, monkeypatch, missing):
    value = git_prepared
    fake = deepcopy(value.source)
    if missing == "absent":
        del fake["codeTreeHash"]
    else:
        fake["codeTreeHash"] = missing
    monkeypatch.setattr(reg, "snapshot_source", lambda *_: deepcopy(fake))
    with pytest.raises(reg.RegistrationError, match="REGISTRATION_CODE_TREE_HASH_REQUIRED"):
        run_rehearsal(value)
    with pytest.raises(reg.RegistrationError, match="REGISTRATION_CODE_TREE_HASH_REQUIRED"):
        run_freeze(value)
    assert_not_frozen(value)


def test_rehearsal_writes_only_new_local_materials_and_never_claims_approval(git_prepared):
    value = git_prepared
    preserved = {str(path): path.read_bytes() for path in value.root.rglob("*")
                 if path.is_file() and ".git" not in path.parts}
    result = run_rehearsal(value)
    assert result["registrationCreated"] is False and result["activeMarkerCreated"] is False
    assert result["proposedReportDirectory"] == str(value.report.relative_to(value.root))
    output = value.root / result["outputDirectory"]
    assert output.parent == value.ledger.parent
    assert {path.name for path in output.iterdir()} == {
        "registration.json", "config.json", "contract.json", "source-snapshot.json", "expected-identities.json",
        "test-change-audit.json", "identity-diff.json", "local-prerequisites.json", "historical-evidence.json",
        "source-hashes.json", "protected-tracked-data.json", "rehearsal.json"}
    assert not (output / "authorization.json").exists()
    assert_not_frozen(value)
    assert all(Path(path).read_bytes() == payload for path, payload in preserved.items())
    with pytest.raises(reg.RegistrationError, match="FRESH_REHEARSAL_DIRECTORY_REQUIRED"):
        run_rehearsal(value)
    with pytest.raises(reg.RegistrationError, match="REHEARSAL_LOCAL_PACKAGE_DIRECTORY_REQUIRED"):
        reg.rehearsal(value.root, "process-tools", value.config, value.report, value.root / ".tools/reports/rehearsal")


def test_contract_mismatch_refuses_before_registration_directory_or_marker(git_prepared):
    value = git_prepared
    expected = run_rehearsal(value)["contractSha256"]
    value.config["timeoutsSeconds"]["python-unit"] += 1
    with pytest.raises(reg.RegistrationError, match="REGISTRATION_CONTRACT_SHA256_MISMATCH"):
        run_freeze(value, expected)
    assert_not_frozen(value)
    value.config["timeoutsSeconds"]["python-unit"] -= 1
    assert run_freeze(value, expected)["contractSha256"] == expected


@pytest.mark.parametrize("guard,expected", [
    ("dirty", "REGISTRATION_REQUIRES_CLEAN_FROZEN_SOURCE"),
    ("row-dirty", "LOCAL_FROZEN_GUI_PASS_REQUIRED:persona"),
    ("pending", "LOCAL_PREREQUISITE_PENDING_RUN"),
    ("missing-code-row", "LOCAL_FROZEN_COMPLETE_ACTUAL_UNIT_PASS_REQUIRED"),
    ("candidate", "REGISTRATION_CANDIDATE_ALREADY_EXISTS"),
    ("active-local", "ACTIVE_LOCAL_RUN_REQUIRES_REVIEW"),
    ("active-registration", "ACTIVE_REGISTRATION_BLOCKS_LOCAL"),
])
def test_rehearsal_and_freeze_apply_identical_preparation_guards(git_prepared, guard, expected):
    value = git_prepared
    if guard == "dirty":
        (value.root / "docs/plan.md").write_text("uncommitted change\n")
    elif guard == "row-dirty":
        value.rows[1]["sourceDirty"] = True
        value.write_rows()
    elif guard == "pending":
        dump(value.ledger.parent / "pending-synthetic.json", {})
    elif guard == "missing-code-row":
        value.rows[0].pop("codeTreeHash")
        value.write_rows()
    elif guard == "candidate":
        (value.root / value.config["candidateDirectory"]).mkdir(parents=True)
    elif guard == "active-local":
        with ExecutionLock(value.root) as lock:
            LocalRunState(value.root, lock).begin({"package": "other-tools", "category": "python"})
    elif guard == "active-registration":
        with ExecutionLock(value.root) as lock:
            RegistrationState(value.root, lock).freeze("other-registration")
    with pytest.raises(Exception, match=expected):
        run_rehearsal(value)
    with pytest.raises(Exception, match=expected):
        run_freeze(value)
    assert not value.report.exists()
    assert not (value.ledger.parent / "freeze-rehearsal").exists()


def contract_inputs():
    return dict(config={"runKind": "tool-validation", "sequence": ["python-unit", "persona-check"],
        "budgets": {"pythonBatch": 1, "personaCheck": 1}, "timeoutsSeconds": {"python-unit": 30, "persona-check": None},
        "pythonTargets": ["tests/test_a.py"], "nodeTests": ["native-ui/a.test.cjs"],
        "frontendTests": ["frontend/a.test.ts"], "nativeTargets": ["target"],
        "guiModes": [{"stage": "persona-check", "option": "--p1-persona"}, {"stage": "settings-check", "option": "--p1-settings"}],
        "requiredGuiModes": ["persona", "settings"], "candidateName": "candidate-one", "candidateDirectory": ".tools/qt-candidates/candidate-one",
        "cmakeDirectory": ".tools/qt-builds/build-one", "adoptCandidate": False},
        manifest={"schema": "identities", "framework": "combined", "cases": [{"identity": "a", "status": "passed"}],
                  "counts": {"total": 1}, "allPassed": True},
        identity_diff={"added": [], "deleted": [], "identitiesMatch": True},
        audit={"schema": "audit", "signedChanges": [], "otherChanges": [], "changedFiles": [],
               "confirmationsAccepted": [], "rejectedChangeIds": [], "registrationAllowed": True},
        local_summary={"unitRun": {"sequence": 4, "sourceHead": "a" * 40},
                       "requiredGuiRuns": {"persona": {"sequence": 5}, "settings": {"sequence": 6}}},
        historical={"docs/evidence/old-result.json": "1" * 64}, code_tree_hash="2" * 40)


@pytest.mark.parametrize("field,replacement", [
    ("runKind", "formal"), ("sequence", ["persona-check", "python-unit"]),
    ("budgets", {"pythonBatch": 2, "personaCheck": 1}), ("timeoutsSeconds", {"python-unit": 31, "persona-check": None}),
    ("pythonTargets", ["tests/test_b.py"]), ("nodeTests", ["native-ui/b.test.cjs"]),
    ("frontendTests", ["frontend/b.test.ts"]), ("nativeTargets", ["other-target"]),
    ("requiredGuiModes", ["settings", "persona"]),
    ("guiModes", [{"stage": "settings-check", "option": "--p1-settings"}, {"stage": "persona-check", "option": "--p1-persona"}]),
    ("candidateName", "candidate-two"), ("candidateDirectory", ".tools/qt-candidates/candidate-two"),
    ("cmakeDirectory", ".tools/qt-builds/build-two"), ("adoptCandidate", True),
])
def test_each_config_contract_dimension_changes_hash(field, replacement):
    inputs = contract_inputs()
    before = contract_sha256(registration_contract(**inputs))
    inputs["config"][field] = replacement
    assert contract_sha256(registration_contract(**inputs)) != before


@pytest.mark.parametrize("part", ["manifest", "identity-diff", "audit", "unit-sequence", "gui-sequence", "code", "history"])
def test_each_derived_contract_dimension_changes_hash(part):
    inputs = contract_inputs()
    before = contract_sha256(registration_contract(**inputs))
    if part == "manifest":
        inputs["manifest"]["cases"][0]["identity"] = "b"
    elif part == "identity-diff":
        inputs["identity_diff"]["added"] = [{"identity": "b"}]
    elif part == "audit":
        inputs["audit"]["otherChanges"] = [{"kind": "helper-or-fixture-code-changed", "afterHash": "4" * 64}]
    elif part == "unit-sequence":
        inputs["local_summary"]["unitRun"]["sequence"] += 1
    elif part == "gui-sequence":
        inputs["local_summary"]["requiredGuiRuns"]["persona"]["sequence"] += 1
    elif part == "code":
        inputs["code_tree_hash"] = "3" * 40
    else:
        inputs["historical"]["docs/evidence/old-result.json"] = "2" * 64
    assert contract_sha256(registration_contract(**inputs)) != before


def test_incidental_commit_and_source_hash_metadata_do_not_change_contract():
    """Projection stability alone never makes an inconsistent local row eligible."""
    inputs = contract_inputs()
    before = contract_sha256(registration_contract(**inputs))
    inputs["config"].update(sourceHead="b" * 40, sourceTreeHash="c" * 40, toolCommit="b" * 40,
        sourceHashes={"docs/plan.md": "d" * 64}, createdUtc="later", latestDocumentationHashes={"docs/plan.md": "d" * 64},
        sourceHashManifest={"sha256": "e" * 64}, implementationCommits=["b" * 40],
        testChangeDirectionDocument={"path": "docs/plan.md", "sha256": "f" * 64, "section": "10"})
    inputs["local_summary"]["unitRun"].update(sourceHead="b" * 40, interveningDocumentationPaths=["docs/new.md"])
    inputs["audit"]["directionDocument"] = inputs["config"]["testChangeDirectionDocument"]
    inputs["audit"]["scopePaths"] = {"before": ["incidental"], "after": ["incidental"]}
    inputs["manifest"]["rawOutputs"] = [{"path": "incidental", "sha256": "f" * 64}]
    assert contract_sha256(registration_contract(**inputs)) == before


@pytest.mark.parametrize("field", ["direction-hash", "confirmation-authorization", "confirmation-time", "confirmation-hash", "audit-hash"])
def test_real_signed_change_confirmations_and_hashes_remain_bound(field):
    inputs = contract_inputs()
    direction = {"path": "docs/plan.md", "sha256": "3" * 64, "section": "10"}
    confirmation = {"changeId": "exact-change", "beforeHash": "4" * 64, "afterHash": "5" * 64,
                    "directionDocument": deepcopy(direction), "authorization": "confirmed change", "confirmedAt": "2026-10-27"}
    inputs["config"].update(testChangeDirectionDocument=direction, confirmedTestChanges=[confirmation])
    inputs["audit"].update(directionDocument=deepcopy(direction), confirmationsAccepted=["exact-change"],
        signedChanges=[{"changeId": "exact-change", "beforeHash": "4" * 64, "afterHash": "5" * 64, "confirmed": True}])
    before = contract_sha256(registration_contract(**inputs))
    if field == "direction-hash":
        inputs["config"]["testChangeDirectionDocument"]["sha256"] = "6" * 64
    elif field == "confirmation-authorization":
        confirmation["authorization"] = "different authorization"
    elif field == "confirmation-time":
        confirmation["confirmedAt"] = "2026-10-28"
    elif field == "confirmation-hash":
        confirmation["afterHash"] = "6" * 64
    else:
        inputs["audit"]["signedChanges"][0]["afterHash"] = "6" * 64
    assert contract_sha256(registration_contract(**inputs)) != before
