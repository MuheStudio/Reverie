"""Correction 1 uses disposable Git repositories and owned local-run output only."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

from script.registered_run.engine import EngineError, StageSpec, run_local
from script.registered_run.source import SourceError, assert_frozen, snapshot_source
from script.registered_run.state import LocalLedger


PACKAGE = "code-state-fixture"


def git(root, *arguments):
    return subprocess.run(["git", "-C", str(root), *arguments], check=True,
                          capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repository(tmp_path):
    root = tmp_path.resolve() / "repository"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.name", "Code state fixture")
    git(root, "config", "user.email", "code-state@example.invalid")
    (root / ".gitignore").write_text(".tools/\nignored*\n")
    (root / "source.py").write_text("VALUE = 1\n")
    (root / "docs").mkdir()
    (root / "docs/status.md").write_text("Initial documentation.\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "fixture source and documentation")
    directory = root / ".tools/local" / PACKAGE
    directory.mkdir(parents=True)
    authorization = {
        "schema": "reverie.local-iteration.authorization.v1", "package": PACKAGE,
        "userApprovalText": "Approved disposable fixture local iteration",
        "recordedUtc": "2026-10-27T00:00:00Z", "validUntil": "fixture completion",
        "scope": {"unitsAndNative": "disposable fixture checks", "readOnlyReplay": "fixture only"},
    }
    (directory / "authorization.json").write_text(json.dumps(authorization) + "\n")
    return root


def documentation_commit(root):
    (root / "docs/status.md").write_text("Documentation changed after local execution.\n")
    (root / "docs/nested").mkdir()
    (root / "docs/nested/registration.json").write_text('{"documentation":true}\n')
    git(root, "add", "docs")
    git(root, "commit", "-qm", "documentation only")


def test_documentation_commit_preserves_code_identity_and_full_snapshot_semantics(repository):
    before = snapshot_source(repository)
    documentation_commit(repository)
    after = snapshot_source(repository)
    assert before["head"] != after["head"]
    assert before["treeHash"] != after["treeHash"]
    assert before["files"] != after["files"]
    assert before["codeTreeHash"] == after["codeTreeHash"]
    assert before["dirty"] is after["dirty"] is False
    assert "docs/nested/registration.json" in {row["path"] for row in after["files"]}
    with pytest.raises(SourceError, match="FROZEN_SOURCE_CHANGED"):
        assert_frozen(repository, before)


def test_both_private_indexes_preserve_real_index_bytes_identity_and_staged_content(repository):
    (repository / "source.py").write_text("VALUE = 2\n")
    git(repository, "add", "source.py")
    (repository / "source.py").write_text("VALUE = 3\n")
    (repository / "docs/status.md").write_text("Unstaged documentation.\n")
    index = Path(git(repository, "rev-parse", "--git-path", "index"))
    if not index.is_absolute():
        index = repository / index
    before = (index.read_bytes(), index.stat().st_ino, index.stat().st_mtime_ns)
    snapshot = snapshot_source(repository)
    assert snapshot["dirty"] is True
    assert snapshot["treeHash"] != snapshot["codeTreeHash"]
    assert (index.read_bytes(), index.stat().st_ino, index.stat().st_mtime_ns) == before
    assert git(repository, "show", ":source.py") == "VALUE = 2"


@pytest.mark.parametrize("name", ["script/check.py", "tests/test_case.py", "native-ui/tests/contract.json",
                                  "docsish/status.md", "README.md"])
def test_any_new_path_outside_docs_changes_code_identity(repository, name):
    before = snapshot_source(repository)
    path = repository / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("new non-documentation source\n")
    after = snapshot_source(repository)
    assert before["codeTreeHash"] != after["codeTreeHash"]
    assert before["treeHash"] != after["treeHash"]
    assert after["dirty"] is True


@pytest.mark.parametrize("change", ["content", "mode", "delete", "symlink"])
def test_code_identity_retains_full_snapshot_file_and_mode_rules(repository, change):
    before = snapshot_source(repository)
    path = repository / "source.py"
    if change == "content":
        path.write_text("VALUE = 9\n")
    elif change == "mode":
        path.chmod(0o755)
    elif change == "delete":
        path.unlink()
    else:
        path.unlink()
        path.symlink_to("docs/status.md")
    after = snapshot_source(repository)
    assert before["codeTreeHash"] != after["codeTreeHash"]
    assert before["treeHash"] != after["treeHash"]


def test_code_identity_keeps_existing_snapshot_exclusions(repository):
    before = snapshot_source(repository)
    for directory in ("data", "outputs"):
        (repository / directory).mkdir()
        (repository / directory / "fixture.txt").write_text("excluded fixture\n")
    (repository / ".c2cignore").write_text("source.py\n")
    (repository / "ignored-fixture").write_text("excluded fixture\n")
    after = snapshot_source(repository)
    assert after["codeTreeHash"] == before["codeTreeHash"]
    assert after["treeHash"] == before["treeHash"]
    assert after["files"] == before["files"]


def test_new_local_row_engine_ledger_snapshot_and_active_marker_share_both_identities(repository):
    source = snapshot_source(repository)
    observed = []

    def inspect(root, output, environment):
        marker = json.loads((root / ".tools/registered-run/active-local.json").read_bytes())
        metadata = marker["metadata"]
        pending = json.loads(Path(metadata["pendingLedger"]).read_bytes())
        observed.extend((metadata, pending))
        assert Path(environment["REVERIE_DATA_DIR"]).is_dir()
        return {"counts": {"fixture": 1}}

    result = run_local(repository, PACKAGE, "replay", "metadata", action=inspect, command=["fixture-inspect"])
    assert result["passed"] is True
    output = Path(result["outputDirectory"])
    observed.extend((result, result["localRun"], json.loads((output / "run-ledger.json").read_bytes())))
    for record in observed:
        assert record["codeTreeHash"] == source["codeTreeHash"]
        assert record["sourceTreeHash"] == source["treeHash"]
        assert record["sourceHead"] == source["head"]
    assert json.loads((output / "source-snapshot.json").read_bytes()) == source
    assert not (repository / ".tools/registered-run/active-local.json").exists()


@pytest.mark.parametrize(("failed_category", "failed_selection", "next_category", "next_selection"), [
    ("replay", "saved-output", "replay", "saved-output"),
    ("python", ["tests/a.py::test_one"], "python", ["tests/a.py"]),
    ("python", ["tests/a.py::test_one"], "full", {"pythonTargets": ["tests/a.py", "tests/b.py"]}),
    ("native", ["persona-card-confirmation::case(row)"], "native", ["persona-card-confirmation"]),
])
def test_docs_only_commit_cannot_evade_failure_or_overlapping_selection_guard(
        repository, failed_category, failed_selection, next_category, next_selection):
    def fail(*_):
        raise RuntimeError("disposable fixture failure")

    first = run_local(repository, PACKAGE, failed_category, failed_selection,
                      action=fail, command=["fixture-failure"])
    assert first["passed"] is False
    ledger_path = repository / ".tools/local" / PACKAGE / "ledger.jsonl"
    before_bytes = ledger_path.read_bytes()
    documentation_commit(repository)
    current = snapshot_source(repository)
    assert current["treeHash"] != first["localRun"]["sourceTreeHash"]
    assert current["codeTreeHash"] == first["localRun"]["codeTreeHash"]
    with pytest.raises(EngineError, match="REQUIRES_DIAGNOSTIC"):
        run_local(repository, PACKAGE, next_category, next_selection,
                  action=lambda *_: pytest.fail("normal rerun reached execution"), command=["must-not-execute"])
    assert ledger_path.read_bytes() == before_bytes
    diagnostic = run_local(repository, PACKAGE, next_category, next_selection, diagnostic=True,
                           action=lambda *_: {"counts": {"fixture": 1}}, command=["fixture-diagnostic"])
    assert diagnostic["passed"] is True
    assert diagnostic["localRun"]["unstable"] is True
    assert diagnostic["localRun"]["diagnostic"] is True
    assert diagnostic["localRun"]["sourceTreeHash"] == current["treeHash"]
    assert diagnostic["localRun"]["codeTreeHash"] == first["localRun"]["codeTreeHash"]
    assert ledger_path.read_bytes().startswith(before_bytes)
    with LocalLedger(ledger_path.parent) as journal:
        assert [row["sequence"] for row in journal.prior_code_failures(
            current["codeTreeHash"], next_category, next_selection)] == [1]


def test_expanded_stage_selection_uses_code_identity_after_documentation_commit(repository):
    def fail(*_):
        raise RuntimeError("disposable unit failure")

    first = run_local(repository, PACKAGE, "python", ["tests/a.py::test_one"],
                      action=fail, command=["fixture-failure"])
    documentation_commit(repository)
    spec = StageSpec("actual-unit", [sys.executable, "-I", "-c", "pass"], timeout=3,
                     check_category="python", selection=["tests/a.py"])
    refused = run_local(repository, PACKAGE, "replay", "unrelated-wrapper-selection", [spec])
    assert refused["passed"] is False
    assert "REQUIRES_DIAGNOSTIC" in refused["stopReason"]
    assert refused["runs"] == []
    assert refused["localRun"]["unstable"] is True
    assert refused["localRun"]["codeTreeHash"] == first["localRun"]["codeTreeHash"]
    diagnostic = run_local(repository, PACKAGE, "replay", "diagnostic-wrapper-selection", [spec], diagnostic=True)
    assert diagnostic["passed"] is True and diagnostic["localRun"]["unstable"] is True


def test_documentation_change_during_local_run_still_fails_full_snapshot_boundary(repository):
    before = snapshot_source(repository)

    def change_documentation(root, *_):
        (root / "docs/status.md").write_text("Documentation changed during execution.\n")
        return {"counts": {"fixture": 1}}

    result = run_local(repository, PACKAGE, "replay", "boundary", action=change_documentation,
                       command=["fixture-documentation-edit"])
    after = snapshot_source(repository)
    assert result["passed"] is False
    assert result["localRun"]["passed"] is False
    assert result["stopReason"] == "FROZEN_SOURCE_CHANGED"
    assert after["codeTreeHash"] == before["codeTreeHash"] == result["codeTreeHash"]
    assert after["treeHash"] != before["treeHash"] == result["sourceTreeHash"]
    assert result["unitScratchRemoved"] is True
    assert not (repository / ".tools/registered-run/active-local.json").exists()


def test_legacy_rows_are_not_rewritten_or_inferred_as_code_records(repository):
    source = snapshot_source(repository)
    directory = repository / ".tools/local" / PACKAGE
    ledger_path = directory / "ledger.jsonl"
    legacy_rows = [dict(sequence=number, sourceHead=source["head"], sourceTreeHash=source["treeHash"],
                        sourceDirty=False, category="replay", selection="legacy", passed=number != 1)
                   for number in range(1, 22)]
    original = b"".join((json.dumps(row, separators=(", ", ": ")) + "\n").encode() for row in legacy_rows)
    ledger_path.write_bytes(original)
    with LocalLedger(directory) as journal:
        assert journal.failures() == [legacy_rows[0]]
        assert not journal.prior_code_failures(source["codeTreeHash"], "replay", "legacy")
        assert not journal.prior_code_failures(source["treeHash"], "replay", "legacy")
        assert all("codeTreeHash" not in row for row in journal.rows)
    assert ledger_path.read_bytes() == original
    result = run_local(repository, PACKAGE, "replay", "new-record", action=lambda *_: {}, command=["fixture-new"])
    assert result["passed"] is True and result["localRun"]["sequence"] == 22
    assert result["localRun"]["codeTreeHash"] == source["codeTreeHash"]
    assert ledger_path.read_bytes().startswith(original)
    assert all("codeTreeHash" not in row for row in LocalLedger._read_rows(ledger_path)[:21])
