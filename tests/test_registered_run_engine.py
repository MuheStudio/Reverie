"""Disposable tool fixtures; never launch the app, Qt, repository tests or GUI."""

from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

from script.registered_run.engine import Engine, EngineError, PointerGuard, StageSpec, run_local
from script.registered_run.isolation import IsolationContext, IsolationError, canonical_directory
from script.registered_run.source import SourceError, assert_frozen, snapshot_source
from script.registered_run.state import (ExecutionLock, LocalLedger, LocalRunState, RegistrationState, StateError,
                                         gui_selection_options, selection_key, selections_intersect, validate_authorization)


def git(root, *arguments):
    return subprocess.run(["git", "-C", str(root), *arguments], check=True,
                          capture_output=True, text=True).stdout.strip()


@pytest.fixture
def project(tmp_path):
    root = tmp_path.resolve() / "project"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.name", "Engine fixture")
    git(root, "config", "user.email", "engine@example.invalid")
    (root / ".gitignore").write_text(".tools/\nignored*\n")
    (root / "source.txt").write_text("source one\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "fixture")
    pointer = root / ".tools/qt-candidates/last-local-sdk.json"
    pointer.parent.mkdir(parents=True)
    pointer.write_bytes(b'{"prior":true}\n')
    return root


def authorize(root, package="test-package", **changes):
    directory = root / ".tools/local" / package
    directory.mkdir(parents=True, exist_ok=True)
    value = {"schema": "reverie.local-iteration.authorization.v1", "package": package,
             "userApprovalText": "Approved fixture local iteration", "recordedUtc": "2026-10-27T00:00:00Z",
             "validUntil": "package signed off, revoked or voided", "scope": {
                 "localBuildDirectory": f".tools/qt-builds/local-{package}", "unitsAndNative": "repository units",
                 "guiModes": ["--p1-worldbook-injection", "--p1-worldbook-regex", "--p1-worldbook-entry",
                              "--p1-persona", "--p1-memory --candidate-paging", "--p1-memory", "--p1-settings"],
                 "newGuiModes": [], "readOnlyReplay": "saved output only"}, **changes}
    payload = (json.dumps(value) + "\n").encode()
    (directory / "authorization.json").write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def stage(identity, code="print('fixture')", **kwargs):
    return StageSpec(identity, [sys.executable, "-I", "-c", code], timeout=3, **kwargs)


def engine(project, tmp_path, specs, **kwargs):
    report = tmp_path.resolve() / ("report-" + str(len(list(tmp_path.glob("report-*")))))
    return Engine(project, report, limits={row.budget or row.id: 1 for row in specs},
                  cleanup_grace=0.2, **kwargs)


def test_source_private_index_includes_tracked_dirty_and_new_source_and_preserves_real_index(project):
    index = Path(git(project, "rev-parse", "--git-path", "index"))
    if not index.is_absolute():
        index = project / index
    before = (index.read_bytes(), index.stat().st_mtime_ns, index.stat().st_ino)
    first = snapshot_source(project)
    assert first["dirty"] is False
    (project / "source.txt").write_text("source two\n")
    (project / "new.py").write_text("new source\n")
    (project / "ignored-secret").write_text("ignored\n")
    (project / ".c2cignore").write_text("*.py\n")
    (project / "outputs").mkdir()
    (project / "outputs/private.txt").write_text("audit only\n")
    changed = snapshot_source(project)
    names = {row["path"] for row in changed["files"]}
    assert "new.py" in names
    assert ".c2cignore" not in names and "outputs/private.txt" not in names and "ignored-secret" not in names
    assert changed["dirty"] is True and changed["treeHash"] != first["treeHash"]
    assert changed["head"] == first["head"]
    assert (index.read_bytes(), index.stat().st_mtime_ns, index.stat().st_ino) == before
    assert not list(project.glob(".git/index.lock"))


def test_source_audit_only_untracked_entries_do_not_make_frozen_source_dirty(project):
    before = snapshot_source(project)
    (project / ".c2cignore").write_text("source.txt\n")
    (project / "outputs").mkdir()
    (project / "outputs/audit.json").write_text("{}")
    after = snapshot_source(project)
    assert after["dirty"] is False and after["treeHash"] == before["treeHash"]
    assert_frozen(project, before)
    (project / "source.txt").write_text("changed")
    with pytest.raises(SourceError, match="DIRTY"):
        assert_frozen(project, before)


def test_source_never_reads_data_content_and_rejects_source_aliases_into_data(project, monkeypatch):
    (project / "data").mkdir()
    (project / "data/private").write_text("never read")
    original = Path.read_bytes

    def guarded(path):
        assert not path.resolve().is_relative_to(project / "data")
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", guarded)
    snapshot_source(project)
    (project / "leak").symlink_to(project / "data/private")
    with pytest.raises(SourceError, match="DATA_ALIAS"):
        snapshot_source(project)


def test_source_rejects_symlink_data_root_and_tracks_deletions(project, tmp_path):
    before = snapshot_source(project)
    (project / "source.txt").unlink()
    after = snapshot_source(project)
    assert after["treeHash"] != before["treeHash"]
    assert "source.txt" not in {row["path"] for row in after["files"]}
    (project / "data").symlink_to(tmp_path.resolve())
    with pytest.raises(SourceError, match="DATA_DIRECTORY_SYMLINK"):
        snapshot_source(project)


def test_permanent_execution_lock_rejects_concurrency_and_retains_inode(project):
    with ExecutionLock(project) as first:
        inode = first.path.stat().st_ino
        with pytest.raises(StateError, match="ANOTHER_EXECUTION"):
            with ExecutionLock(project):
                pytest.fail("concurrent lock")
    with ExecutionLock(project) as second:
        assert second.path.stat().st_ino == inode


def test_active_registration_is_explicit_and_stale_owner_is_never_silently_removed(project):
    old = project / ".tools/reports/historical"
    old.mkdir(parents=True)
    (old / "registration.json").write_text('{"state":"frozen"}')
    with ExecutionLock(project) as lock:
        state = RegistrationState(project, lock)
        state.assert_no_active()
        marker = state.freeze("fixture-registration", {"frozenTree": "a"})
    with ExecutionLock(project) as lock:
        state = RegistrationState(project, lock)
        assert state.active() == marker
        with pytest.raises(StateError, match="BLOCKS_LOCAL"):
            state.assert_no_active()
        with pytest.raises(StateError, match="BINDING_MISMATCH"):
            state.finish("unrelated-registration")
        assert state.path.exists()
        state.finish("fixture-registration")
        state.assert_no_active()
    assert (old / "registration.json").exists()


@pytest.mark.parametrize("changes", [{"revoked": True}, {"completed": True}, {"voidedUtc": "now"},
                                     {"valid": False}, {"status": "withdrawn"},
                                     {"expiresUtc": "2000-01-01T00:00:00Z"}])
def test_authorization_rejects_revoked_completed_and_expired_packages(project, changes):
    authorize(project, **changes)
    with pytest.raises(StateError):
        validate_authorization(project, "test-package", "python", ["fixture.py"])


def test_authorization_missing_wrong_package_scope_or_hash_is_refused_without_mutation(project):
    with pytest.raises(StateError, match="MISSING"):
        validate_authorization(project, "test-package", "python", [])
    sha = authorize(project)
    path = project / ".tools/local/test-package/authorization.json"
    before = path.read_bytes()
    for category, selection in [("browser", []), ("gui", "--interactive"), ("gui", "--p1-provider")]:
        with pytest.raises(StateError, match="SCOPE"):
            validate_authorization(project, "test-package", category, selection)
    with pytest.raises(StateError, match="BYTES_CHANGED"):
        validate_authorization(project, "test-package", "full", [], "0" * 64)
    for mode in ("injection", "regex", "entry", "persona", "candidate", "ordinary", "settings"):
        validate_authorization(project, "test-package", "gui", mode, sha)
    for category in ("python", "node", "frontend", "native", "full", "build", "replay"):
        validate_authorization(project, "test-package", category, [], sha)
    assert path.read_bytes() == before


def test_isolation_uses_distinct_owned_dirs_and_original_offline_environment(project, tmp_path):
    parent = tmp_path.resolve() / "scratch"
    parent.mkdir()
    context = IsolationContext.create(project, parent)
    assert len(set(context.directories.values())) == 4
    assert all(path.stat().st_mode & 0o777 == 0o700 for path in context.directories.values())
    env = context.env
    assert env["TMPDIR"] == str(context.directories["tmp"]) + "/"
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE"):
        assert env[name] == "1"
    with pytest.raises(IsolationError, match="OVERRIDE"):
        context.validate_environment({**env, "REVERIE_DATA_DIR": str(project / "data")})
    assert context.cleanup() is True


def test_isolation_rejects_symlink_app_default_data_and_replaced_owned_inode(project, tmp_path):
    parent = tmp_path.resolve() / "scratch"
    parent.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(parent)
    with pytest.raises(IsolationError):
        IsolationContext.create(project, alias)
    bundle = parent / "Fixture.app"
    bundle.mkdir()
    with pytest.raises(IsolationError, match="BUNDLE"):
        canonical_directory(bundle)
    (project / "data").mkdir()
    with pytest.raises(IsolationError, match="OVERLAPS"):
        IsolationContext.create(project, project / "data")
    context = IsolationContext.create(project, parent)
    context.directories["data"].rename(context.run_root / "data-original")
    context.directories["data"].mkdir()
    with pytest.raises(IsolationError, match="IDENTITY_CHANGED"):
        context.cleanup()
    assert context.run_root.exists()


def test_engine_stops_on_first_failure_and_preserves_order_budget_and_fact_fields(project, tmp_path):
    specs = [stage("first", "raise SystemExit(7)"), stage("never")]
    result = engine(project, tmp_path, specs).run(specs)
    assert result["passed"] is False
    assert [row["id"] for row in result["runs"]] == ["first"]
    assert result["used"] == {"first": 1}
    assert result["runs"][0]["exitCode"] == 7
    assert result["runs"][0]["processGroupGone"] is True
    assert result["unitScratchRemoved"] is True
    assert result["ownedProcessesRemaining"] == 0
    assert result["startedUtc"] and result["endedUtc"]
    assert result["runs"][0]["timeoutSeconds"] == 3


def test_engine_budget_exhaustion_freeze_and_environment_fail_before_launch(project, tmp_path):
    first, second = stage("first", budget="shared"), stage("second", budget="shared")
    result = engine(project, tmp_path, [first, second]).run([first, second])
    assert result["passed"] is False and "BUDGET_EXHAUSTED" in result["stopReason"]
    assert [row["id"] for row in result["runs"]] == ["first"]

    def frozen(label, ledger):
        if label == "before-second":
            raise EngineError("fixture frozen mismatch")

    result = engine(project, tmp_path, [first, second], frozen=frozen).run([first, second])
    assert result["passed"] is False and "frozen mismatch" in result["stopReason"]
    assert [row["id"] for row in result["runs"]] == ["first"]
    bad_env = stage("unsafe", env={"REVERIE_DATA_DIR": str(project / "data")})
    result = engine(project, tmp_path, [bad_env]).run([bad_env])
    assert result["passed"] is False and "OVERRIDE" in result["stopReason"]
    assert "ownedProcessGroup" not in result["runs"][0]


def test_engine_timeout_signals_only_owned_session_and_records_cleanup(project, tmp_path):
    spec = replace(stage("timeout", "import time; time.sleep(30)"), timeout=0.1)
    result = engine(project, tmp_path, [spec]).run([spec])
    row = result["runs"][0]
    assert result["passed"] is False and "TIMEOUT" in result["stopReason"]
    assert row["ownedGroupRequiredCleanup"] is True
    assert row["cleanupProcessGroupGone"] is True
    assert row["cleanupSignals"] and all(item["processGroup"] == row["ownedProcessGroup"] for item in row["cleanupSignals"])
    assert row["ownedProcessGroup"] != os.getpgrp()


def test_engine_callbacks_and_sdk_pointer_restore_precede_verifier(project, tmp_path):
    pointer = project / ".tools/qt-candidates/last-local-sdk.json"
    prior, candidate, seen = pointer.read_bytes(), b'{"candidate":true}\n', []

    def before(instance, row):
        seen.append("before")

    def after(instance, row):
        assert pointer.read_bytes() == prior
        seen.append("after")

    def verify(instance, row):
        assert pointer.read_bytes() == prior
        seen.append("verify")
        return {"pythonEvidence": {"tests": 3}}

    spec = stage("sdk", f"from pathlib import Path; Path({str(pointer)!r}).write_bytes({candidate!r})",
                 capture_pointer=True, before_start=before, after_exit=after, verify=verify)
    instance = engine(project, tmp_path, [spec], kind="tool-validation")
    result = instance.run([spec])
    assert result["passed"] is True and seen == ["before", "after", "verify"]
    assert result["pythonEvidence"] == {"tests": 3}
    assert instance.captured_pointer == candidate and pointer.read_bytes() == prior


@pytest.mark.parametrize("kind", ["development", "tool-validation"])
def test_nonformal_engine_never_adopts_and_failed_stage_always_restores(project, tmp_path, kind):
    pointer = project / ".tools/qt-candidates/last-local-sdk.json"
    prior = pointer.read_bytes()
    spec = stage("sdk", f"from pathlib import Path; Path({str(pointer)!r}).write_bytes(b'candidate'); raise SystemExit(2)",
                 capture_pointer=True)
    instance = engine(project, tmp_path, [spec], kind=kind)
    with pytest.raises(EngineError, match="ONLY_FORMAL"):
        instance.run([spec], adopt=b"candidate")
    result = instance.run([spec])
    assert result["passed"] is False and pointer.read_bytes() == prior


@pytest.mark.parametrize("late_failure", [False, True])
def test_formal_adopts_only_after_all_success_cleanup_and_rolls_back_late_failure(project, tmp_path, late_failure):
    pointer = project / ".tools/qt-candidates/last-local-sdk.json"
    prior, candidate = pointer.read_bytes(), b"candidate pointer bytes\n"
    spec = stage("sdk", f"from pathlib import Path; Path({str(pointer)!r}).write_bytes({candidate!r})", capture_pointer=True)

    def adopt(instance):
        assert instance.ledger["unitScratchRemoved"] is True
        assert all(row["passed"] for row in instance.ledger["runs"])
        assert pointer.read_bytes() == prior
        return candidate

    def late(instance):
        if late_failure:
            raise RuntimeError("late failure")

    result = engine(project, tmp_path, [spec], kind="formal").run([spec], adopt=adopt, post_adopt=late)
    assert result["passed"] is not late_failure
    assert pointer.read_bytes() == (prior if late_failure else candidate)


def test_local_engine_never_calls_pointer_writer_even_when_external_stage_mutates_pointer(project, tmp_path, monkeypatch):
    pointer = project / ".tools/qt-candidates/last-local-sdk.json"

    def forbidden(*args):
        pytest.fail("local engine attempted pointer write or restore")

    monkeypatch.setattr(PointerGuard, "_write", forbidden)
    normal = stage("normal")
    assert engine(project, tmp_path, [normal]).run([normal])["passed"] is True
    changed = stage("change", f"from pathlib import Path; Path({str(pointer)!r}).write_bytes(b'external mutation')")
    result = engine(project, tmp_path, [changed]).run([changed])
    assert result["passed"] is False and result["defaultPointerUnchanged"] is False
    assert pointer.read_bytes() == b"external mutation"


def test_cleanup_failure_prevents_formal_adoption_and_restores_original_pointer(project, tmp_path, monkeypatch):
    pointer = project / ".tools/qt-candidates/last-local-sdk.json"
    prior = pointer.read_bytes()
    spec = stage("sdk", f"from pathlib import Path; Path({str(pointer)!r}).write_bytes(b'candidate')", capture_pointer=True)
    original = IsolationContext.cleanup

    def failing_cleanup(context):
        original(context)
        return False

    monkeypatch.setattr(IsolationContext, "cleanup", failing_cleanup)
    result = engine(project, tmp_path, [spec], kind="formal").run(
        [spec], adopt=lambda instance: pytest.fail("adopted before successful cleanup"))
    assert result["passed"] is False and "CLEANUP_FAILED" in result["stopReason"]
    assert pointer.read_bytes() == prior


def test_local_wrapper_factory_gets_owned_output_and_completes_one_full_ledger_row(project):
    sha = authorize(project)
    seen = []

    def factory(root, output, env):
        assert root == project and output.exists()
        assert Path(env["REVERIE_DATA_DIR"]).exists()
        seen.append(output)
        return [stage("fixture", verify=lambda instance, row: {"pythonEvidence": {"tests": 2}})]

    result = run_local(project, "test-package", "python", ["fixture"], stage_factory=factory, expected_auth_sha256=sha)
    assert result["passed"] is True and len(seen) == 1
    path = project / ".tools/local/test-package/ledger.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(rows) == 1 and rows[0]["sequence"] == 1
    row = rows[0]
    assert row["head"] and row["treeHash"] and row["dirty"] is False
    assert row["startedUtc"] and row["endedUtc"] and row["command"]
    assert row["counts"]["pythonEvidence"] == {"tests": 2}
    assert row["unitScratchRemoved"] is True and row["exitCode"] == 0
    assert not list(path.parent.glob("pending-*.json"))


def test_local_wrapper_replay_callable_success_exception_and_immutable_failure_history(project):
    authorize(project)

    def fail(root, output, env):
        raise RuntimeError("fixture replay rejection")

    first = run_local(project, "test-package", "replay", "saved-fixture", action=fail, command=["replay", "saved-fixture"])
    assert first["passed"] is False
    ledger_path = project / ".tools/local/test-package/ledger.jsonl"
    prior_bytes = ledger_path.read_bytes()
    with pytest.raises(EngineError, match="REQUIRES_DIAGNOSTIC"):
        run_local(project, "test-package", "replay", "saved-fixture", action=fail, command=["replay", "saved-fixture"])
    assert ledger_path.read_bytes() == prior_bytes
    result = run_local(project, "test-package", "replay", "saved-fixture", diagnostic=True,
                       action=lambda root, output, env: {"counts": {"cases": 2}, "identityManifest": "manifest.json",
                                                        "identityManifestSha256": "a" * 64, "unitSelection": ["fixture"]},
                       command=["replay", "saved-fixture"])
    assert result["passed"] is True and result["localRun"]["unstable"] is True
    assert result["localRun"]["identityManifest"] == "manifest.json"
    assert ledger_path.read_bytes().startswith(prior_bytes)
    with LocalLedger(ledger_path.parent) as journal:
        assert len(journal.failures(unresolved_only=True)) == 1
        journal.append_analysis([1], "failure analyzed and reported", reported_to_user=True)
        assert not journal.failures(unresolved_only=True)
        assert len(journal.failures()) == 1


def test_local_wrapper_refuses_active_registration_and_unappendable_ledger_before_action(project, monkeypatch):
    authorize(project)
    with ExecutionLock(project) as lock:
        RegistrationState(project, lock).freeze("fixture-registration")
    action = lambda *args: pytest.fail("refused action executed")
    with pytest.raises(StateError, match="BLOCKS_LOCAL"):
        run_local(project, "test-package", "replay", "fixture", action=action, command=["replay"])
    with ExecutionLock(project) as lock:
        RegistrationState(project, lock).finish("fixture-registration")
    original = os.open

    def opened(path, *args, **kwargs):
        if str(path).endswith("ledger.jsonl"):
            raise PermissionError("fixture append denied")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", opened)
    with pytest.raises(PermissionError, match="append denied"):
        run_local(project, "test-package", "replay", "fixture", action=action, command=["replay"])


def test_factory_pointer_change_is_detected_without_restoration_and_recorded_as_failure(project):
    authorize(project)
    pointer = project / ".tools/qt-candidates/last-local-sdk.json"

    def factory(root, output, env):
        pointer.write_bytes(b"factory mutation")
        return [stage("must-not-run")]

    result = run_local(project, "test-package", "python", ["fixture"], stage_factory=factory)
    assert result["passed"] is False and not result["runs"]
    assert "POINTER_BYTES_CHANGED" in result["localRun"]["stopReason"]
    assert pointer.read_bytes() == b"factory mutation"


@pytest.mark.parametrize("selection", ["persona", ["persona"], ["persona-check"],
                                       ["persona", "settings"], ["--p1-memory", "--candidate-paging"],
                                       [], None])
def test_gui_authorization_expands_single_multiple_and_default_all_modes(project, selection):
    authorize(project)
    validate_authorization(project, "test-package", "gui", selection)
    requested = gui_selection_options(selection)
    assert requested
    if selection is None or selection == []:
        assert len(requested) == 7


@pytest.mark.parametrize("selection", [[], None, ["persona", "settings"], ["ordinary"], ["candidate"]])
def test_gui_authorization_checks_every_expanded_mode_and_empty_default_cannot_bypass_scope(project, selection):
    authorize(project, scope={"guiModes": ["--p1-persona"], "newGuiModes": []})
    with pytest.raises(StateError, match="SCOPE_EXCEEDED"):
        validate_authorization(project, "test-package", "gui", selection)
    validate_authorization(project, "test-package", "gui", ["persona"])
    assert selection_key("gui", ["settings", "persona"]) == selection_key("gui", ["persona-check", "settings-check"])
    assert selection_key("gui", []) == selection_key("gui", ["injection", "regex", "entry", "persona", "candidate", "ordinary", "settings"])


def test_global_local_marker_retains_unknown_spawn_window_and_blocks_freeze_and_other_packages(project):
    authorize(project)
    authorize(project, "other-package")
    with ExecutionLock(project) as lock:
        marker = LocalRunState(project, lock)
        marker.begin({"package": "test-package"})
        marker.prepare_spawn("unknown", ["inert-fixture"])
        with pytest.raises(StateError, match="UNCONFIRMED"):
            marker.finish(cleanup_confirmed=True, completion_recorded=True)
    with ExecutionLock(project) as lock:
        marker = LocalRunState(project, lock)
        assert marker.active()["processGroups"][0]["state"] == "spawning"
        with pytest.raises(StateError, match="REQUIRES_REVIEW"):
            marker.assert_no_active()
        with pytest.raises(StateError, match="REQUIRES_REVIEW"):
            RegistrationState(project, lock).freeze("must-not-freeze")
    with pytest.raises(StateError, match="REQUIRES_REVIEW"):
        run_local(project, "other-package", "replay", "saved", command=["replay"],
                  action=lambda *args: pytest.fail("abandoned marker allowed another package"))


def test_popen_exception_is_unconfirmed_cleanup_and_retains_global_local_marker(project, tmp_path, monkeypatch):
    scratch = tmp_path.resolve() / "scratch"
    scratch.mkdir()
    isolation = IsolationContext.create(project, scratch)

    def failed_spawn(*args, **kwargs):
        raise RuntimeError("fixture Popen did not return ownership")

    monkeypatch.setattr(subprocess, "Popen", failed_spawn)
    spec = stage("unknown")
    result = engine(project, tmp_path, [spec], isolation=isolation).run([spec])
    assert result["passed"] is False
    assert result["ownedProcessesRemaining"] == 1
    assert result["processCleanupConfirmed"] is False and result["unitScratchRemoved"] is False
    assert result["runs"][0]["spawnAttempted"] is True
    assert result["runs"][0]["processGroupGone"] is False
    marker = json.loads((project / ".tools/registered-run/active-local.json").read_text())
    assert marker["processGroups"][0]["state"] == "spawning"
    # The fixture adapter proves no real process was created. Production has
    # no such proof and deliberately keeps both marker and isolation intact.
    isolation.cleanup()


def test_killed_launcher_leaves_live_child_but_durable_marker_blocks_local_freeze_and_registered_run(project, tmp_path):
    authorize(project)
    authorize(project, "other-package")
    ready = project / ".tools/child-ready"
    scratch = project / ".tools/fixture-scratch"
    scratch.mkdir()
    child_code = f"import os,time;from pathlib import Path;Path({str(ready)!r}).write_text(str(os.getpid()));time.sleep(30)"
    repository = Path(__file__).resolve().parents[1]
    launcher_code = (
        f"import sys;sys.path.insert(0,{str(repository)!r});"
        "from script.registered_run import engine;"
        "from script.registered_run.isolation import IsolationContext;"
        "original=IsolationContext.create;"
        f"IsolationContext.create=classmethod(lambda cls,root,parent=None,**kw:original(root,{str(scratch)!r},**kw));"
        f"spec=engine.StageSpec('survivor',[sys.executable,'-I','-c',{child_code!r}],timeout=30);"
        f"engine.run_local({str(project)!r},'test-package','python',['sleep-fixture'],[spec])"
    )
    child_pid, launcher = None, None
    with (tmp_path / "fake-launcher.log").open("wb") as stream:
        try:
            launcher = subprocess.Popen([sys.executable, "-I", "-B", "-c", launcher_code],
                                        stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + 10
            marker_path = project / ".tools/registered-run/active-local.json"
            while time.monotonic() < deadline:
                if ready.exists() and marker_path.exists():
                    marker = json.loads(marker_path.read_text())
                    ready_pid = ready.read_text().strip()
                    if ready_pid.isdigit() and marker["processGroups"] and marker["processGroups"][0].get("state") == "running":
                        child_pid = int(ready_pid)
                        break
                assert launcher.poll() is None, "fixture launcher exited before ownership record"
                time.sleep(0.01)
            assert child_pid is not None, "fixture child readiness deadline"
            assert os.getpgid(child_pid) == child_pid and child_pid != launcher.pid
            launcher.kill()
            launcher.wait(timeout=3)
            os.kill(child_pid, 0)  # Child remains alive after the launcher releases flock.
            with ExecutionLock(project) as lock:
                retained = LocalRunState(project, lock)
                assert retained.active()["processGroups"][0]["pgid"] == child_pid
                with pytest.raises(StateError, match="REQUIRES_REVIEW"):
                    retained.assert_no_active()
                with pytest.raises(StateError, match="REQUIRES_REVIEW"):
                    RegistrationState(project, lock).freeze("must-not-freeze")
            with pytest.raises(StateError, match="REQUIRES_REVIEW"):
                run_local(project, "other-package", "replay", "saved", command=["replay"],
                          action=lambda *args: pytest.fail("live orphan allowed another local run"))
            blocked = stage("registered-must-not-start")
            with pytest.raises(StateError, match="REQUIRES_REVIEW"):
                engine(project, tmp_path, [blocked], kind="tool-validation").run([blocked])
            assert list((project / ".tools/local/test-package").glob("pending-*.json"))
            assert not (project / ".tools/local/test-package/ledger.jsonl").read_bytes()
        finally:
            if launcher is not None and launcher.poll() is None:
                launcher.kill()
                launcher.wait(timeout=3)
            if child_pid is None and ready.exists():
                ready_pid = ready.read_text().strip()
                child_pid = int(ready_pid) if ready_pid.isdigit() else None
            if child_pid is not None:
                try:
                    if os.getpgid(child_pid) == child_pid:
                        os.killpg(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def test_local_marker_is_removed_only_after_confirmed_cleanup_and_durable_completion_row(project, monkeypatch):
    authorize(project)
    marker_path = project / ".tools/registered-run/active-local.json"
    original = LocalLedger.append_complete

    def recorded(journal, row):
        assert marker_path.exists()
        marker = json.loads(marker_path.read_text())
        assert marker["processGroups"] and all(group["state"] == "gone" for group in marker["processGroups"])
        assert row["unitScratchRemoved"] is True
        original(journal, row)

    monkeypatch.setattr(LocalLedger, "append_complete", recorded)
    result = run_local(project, "test-package", "python", ["fixture"], [stage("fixture")])
    assert result["passed"] is True
    assert not marker_path.exists()


def test_unconfirmed_isolation_cleanup_retains_global_marker_even_when_owned_groups_are_gone(project, tmp_path, monkeypatch):
    original = IsolationContext.cleanup

    def unconfirmed(context):
        original(context)
        return False

    monkeypatch.setattr(IsolationContext, "cleanup", unconfirmed)
    spec = stage("fixture")
    result = engine(project, tmp_path, [spec]).run([spec])
    assert result["passed"] is False
    assert result["ownedProcessesRemaining"] == 0 and result["unitScratchRemoved"] is False
    assert (project / ".tools/registered-run/active-local.json").exists()


def test_planning_exception_before_any_spawn_releases_marker_after_cleanup_and_failed_ledger_append(project):
    authorize(project)

    def factory(*args):
        raise ValueError("fixture planner failed before spawn")

    result = run_local(project, "test-package", "python", ["fixture"], stage_factory=factory)
    assert result["passed"] is False and "planner failed" in result["localRun"]["stopReason"]
    assert result["localRun"]["unitScratchRemoved"] is True
    assert result["localRun"]["failedStages"] == [{"stage": None, "category": "python", "selection": ["fixture"]}]
    assert not (project / ".tools/registered-run/active-local.json").exists()
    assert not list((project / ".tools/local/test-package").glob("pending-*.json"))
    rows = [json.loads(line) for line in (project / ".tools/local/test-package/ledger.jsonl").read_text().splitlines()]
    assert len(rows) == 1 and rows[0]["passed"] is False
    next_run = run_local(project, "test-package", "replay", "unrelated", command=["replay"],
                         action=lambda *args: {"counts": {"replayed": 1}})
    assert next_run["passed"] is True and next_run["localRun"]["sequence"] == 2


@pytest.mark.parametrize("destination", ["repository-data", "application-data", "outside", "relative"])
def test_local_output_override_is_rejected_before_creating_any_destination_directory(project, tmp_path, destination):
    authorize(project)
    if destination == "repository-data":
        report = project / "data/never-create/run"
        sentinel = project / "data"
    elif destination == "application-data":
        report = Path.home().resolve() / "Library/Application Support/Reverie Scene/never-create-fixture"
        sentinel = report
    elif destination == "outside":
        report = tmp_path.resolve() / "never-create/run"
        sentinel = report.parent
    else:
        report = Path("relative-output")
        sentinel = project / "relative-output"
    existed = sentinel.exists()
    with pytest.raises(EngineError, match="LOCAL_OUTPUT"):
        run_local(project, "test-package", "replay", "fixture", report_dir=report, command=["replay"],
                  action=lambda *args: pytest.fail("invalid output reached the action"))
    assert sentinel.exists() is existed
    assert not (project / ".tools/local/test-package/ledger.jsonl").exists()
    assert not (project / ".tools/registered-run/active-local.json").exists()


def test_local_output_rejects_symlink_parent_before_writing_data_and_accepts_owned_runs_child(project, tmp_path):
    authorize(project)
    runs = project / ".tools/local/test-package/runs"
    outside = tmp_path.resolve() / "outside"
    outside.mkdir()
    runs.symlink_to(outside)
    with pytest.raises(EngineError, match="SYMLINK"):
        run_local(project, "test-package", "replay", "fixture", report_dir=runs / "never-create", command=["replay"],
                  action=lambda *args: pytest.fail("aliased output reached action"))
    assert not list(outside.iterdir())
    runs.unlink()
    owned = runs / "owned-override"
    result = run_local(project, "test-package", "replay", "fixture", report_dir=owned, command=["replay"],
                       action=lambda *args: {"counts": {"replayed": 1}})
    assert result["passed"] is True and result["outputDirectory"] == str(owned)


@pytest.mark.parametrize(("left_category", "left", "right_category", "right"), [
    ("python", ["tests/a.py::test_one"], "python", ["tests/a.py"]),
    ("python", ["tests/a.py::test_one[tag::with-colons]"], "python", ["tests/a.py::test_one"]),
    ("python", ["tests/a.py"], "full", {"pythonTargets": ["tests/a.py", "tests/b.py"]}),
    ("node", ["script/a.test.cjs"], "full", {"nodeTests": ["script/a.test.cjs"]}),
    ("frontend", ["frontend/src/a.test.ts"], "frontend", []),
    ("gui", ["persona"], "gui", ["persona-check", "settings"]),
    ("gui", ["candidate"], "gui", []),
    ("native", ["persona-card-confirmation::PersonaCardConfirmationTest::slowCase(tag)"], "native", ["persona-card-confirmation"]),
    ("native", ["PersonaCardConfirmationTest::slowCase:tag"], "native", ["persona-card-confirmation::slowCase"]),
])
def test_failure_selection_intersection_normalizes_full_modes_files_functions_and_data_rows(left_category, left, right_category, right):
    assert selections_intersect(left_category, left, right_category, right)
    assert selections_intersect(right_category, right, left_category, left)


@pytest.mark.parametrize(("category", "left", "right"), [
    ("python", ["tests/a.py::test_one[tag]"], ["tests/a.py::test_one[other]"]),
    ("python", ["tests/a.py"], ["tests/b.py"]),
    ("native", ["persona-card-confirmation::slowCase(tag)"], ["persona-card-confirmation::otherCase"]),
    ("gui", ["persona"], ["settings"]),
])
def test_failure_selection_intersection_keeps_unrelated_checks_separate(category, left, right):
    assert not selections_intersect(category, left, category, right)


@pytest.mark.parametrize(("category", "failed_selection", "broader_category", "broader_selection"), [
    ("python", ["tests/a.py::test_one"], "full", {"pythonTargets": ["tests/a.py", "tests/b.py"]}),
    ("gui", ["persona"], "gui", ["persona", "settings"]),
    ("native", ["persona-card-confirmation::slowCase(tag)"], "native", ["persona-card-confirmation"]),
])
def test_same_source_failure_cannot_be_rerun_normally_through_broader_selection(project, category, failed_selection, broader_category, broader_selection):
    authorize(project)
    failed = stage("actual-failed-stage", "raise SystemExit(7)", check_category=category, selection=failed_selection)
    first = run_local(project, "test-package", category, failed_selection, [failed])
    assert first["passed"] is False
    assert first["localRun"]["failedStages"] == [{"stage": "actual-failed-stage", "category": category, "selection": failed_selection}]
    with pytest.raises(EngineError, match="REQUIRES_DIAGNOSTIC"):
        run_local(project, "test-package", broader_category, broader_selection, [stage("must-not-run")])
    diagnostic_spec = stage("diagnostic", check_category=category, selection=failed_selection)
    diagnostic = run_local(project, "test-package", broader_category, broader_selection, [diagnostic_spec], diagnostic=True)
    assert diagnostic["passed"] is True and diagnostic["localRun"]["unstable"] is True
    with LocalLedger(project / ".tools/local/test-package") as journal:
        assert len(journal.failures()) == 1
        assert journal.prior_code_failures(first["localRun"]["codeTreeHash"], broader_category, broader_selection)


def test_full_failure_guard_uses_actual_failed_stage_and_legacy_manual_rows_keep_original_selection(project):
    directory = project / ".tools/local/test-package"
    with LocalLedger(directory) as journal:
        begin = journal.begin({"sourceTreeHash": "same-tree", "codeTreeHash": "same-code", "category": "full", "selection": {
            "pythonTargets": ["tests/a.py"], "nodeTests": ["script/a.test.cjs"]}})
        journal.append_complete({**begin, "passed": False, "failedStages": [
            {"stage": "python-unit", "category": "python", "selection": ["tests/a.py"]}]})
        assert journal.prior_code_failures("same-code", "python", ["tests/a.py::test_one"])
        assert not journal.prior_code_failures("same-code", "node", ["script/a.test.cjs"])
        manual = journal.begin({"sourceTreeHash": "same-tree", "codeTreeHash": "same-code", "category": "native", "selection": ["persona-card-confirmation::slowCase(tag)"]})
        journal.append_complete({**manual, "passed": False})
        assert journal.prior_code_failures("same-code", "native", ["persona-card-confirmation"])
