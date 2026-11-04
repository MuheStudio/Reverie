"""Serial fail-stop stage engine shared by local and registered execution."""

from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Callable, Mapping, Sequence
import uuid

from .isolation import IsolationContext, assert_not_data_path, canonical_directory
from .source import assert_frozen, snapshot_source
from .state import (ExecutionLock, LocalLedger, LocalRunState, RegistrationState, StateError, ensure_directory,
                    exclusive_json, now, package_name, regular_file, validate_authorization)
from .state import selection_key


class EngineError(RuntimeError):
    pass


@dataclass(frozen=True)
class StageSpec:
    id: str
    command: Sequence[str]
    cwd: Path | str | None = None
    env: Mapping[str, str | None] = field(default_factory=dict)
    budget: str | None = None
    timeout: float | None = None
    after_exit: Callable | None = None
    verify: Callable | None = None
    log_name: str | None = None
    capture_pointer: bool = False
    before_start: Callable | None = None
    check_category: str | None = None
    selection: object = None


def validate_local_output(root: Path, package: str, output: Path | str) -> Path:
    """Validate an uncreated output without creating or adopting any directory."""
    output = Path(output)
    base = root / ".tools/local" / package / "runs"
    if (not output.is_absolute() or output != Path(os.path.abspath(output))
            or output.parent != base or any(part.lower().endswith(".app") for part in output.parts)):
        raise EngineError("LOCAL_OUTPUT_MUST_BE_NEW_PACKAGE_RUN_CHILD")
    assert_not_data_path(output, root)
    if output.resolve(strict=False) != output:
        raise EngineError("LOCAL_OUTPUT_SYMLINK_OR_ALIAS_FORBIDDEN")
    current = output
    while not current.exists() and not current.is_symlink():
        current = current.parent
    canonical_directory(current)
    return output


def _stage_selection(stage, category, selection):
    if stage.check_category is not None:
        return stage.check_category, stage.selection
    unit_kind = {"python-unit": ("python", "pythonTargets"), "node-unit": ("node", "nodeTests"),
                 "frontend-unit": ("frontend", "frontendTests"), "native-unit": ("native", "nativeTargets")}
    if stage.id in unit_kind:
        kind, key = unit_kind[stage.id]
        selected = selection.get(key) if category == "full" and isinstance(selection, dict) else selection
        return kind, selected
    from .coverage import MODE_OPTIONS
    from .preview import MODE as PREVIEW_MODE
    mode = stage.id.removesuffix("-check")
    if stage.id.endswith("-check") and (mode in dict(MODE_OPTIONS) or mode == PREVIEW_MODE):
        return "gui", [mode]
    return category, selection


class PointerGuard:
    def __init__(self, path: Path | str, *, writable: bool):
        self.path, self.writable = Path(path), writable
        self.prior = self.read()
        self.captured = None

    def read(self):
        if not self.path.parent.exists():
            return None
        return self.path.read_bytes() if regular_file(self.path, missing=True) is not None else None

    def unchanged(self):
        return self.read() == self.prior

    def compare(self):
        if not self.unchanged():
            raise EngineError("DEFAULT_POINTER_BYTES_CHANGED")

    def _write(self, payload: bytes | None):
        if not self.writable:
            raise EngineError("LOCAL_POINTER_WRITE_FORBIDDEN")
        if self.read() == payload:
            return
        if payload is None:
            regular_file(self.path)
            self.path.unlink()
            return
        ensure_directory(self.path.parent)
        temporary = self.path.with_name(self.path.name + ".registered-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            regular_file(self.path, missing=True)
            os.replace(temporary, self.path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def capture_restore(self):
        if not self.writable:
            raise EngineError("LOCAL_POINTER_CAPTURE_FORBIDDEN")
        self.captured = self.read()
        if self.captured is None:
            raise EngineError("SDK_POINTER_NOT_PUBLISHED")
        self.restore()

    def restore(self):
        self._write(self.prior)
        self.compare()

    def adopt(self, payload: bytes):
        if not isinstance(payload, bytes) or self.captured != payload:
            raise EngineError("ADOPTION_MUST_MATCH_CAPTURED_SDK_POINTER")
        self.compare()
        self._write(payload)
        if self.read() != payload:
            raise EngineError("DEFAULT_POINTER_ADOPTION_FAILED")


def group_gone(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def cleanup_process_group(process, row: dict, *, grace: float = 10.0):
    """Signal only the process group created by this engine's Popen session."""
    row.setdefault("cleanupSignals", [])
    row.setdefault("cleanupErrors", [])
    for value, label in ((signal.SIGTERM, "SIGTERM"), (signal.SIGKILL, "SIGKILL")):
        if group_gone(process.pid):
            break
        try:
            os.killpg(process.pid, value)
            row["cleanupSignals"].append({"signal": label, "processGroup": process.pid, "sent": True})
        except ProcessLookupError:
            break
        except BaseException as error:
            row["cleanupErrors"].append(str(error))
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            process.poll()
            if group_gone(process.pid):
                break
            time.sleep(0.02)
    process.poll()
    row["cleanupProcessExited"] = process.returncode is not None
    row["cleanupProcessGroupGone"] = group_gone(process.pid)


class Engine:
    def __init__(self, root: Path | str, report_dir: Path | str, *, kind: str = "local",
                 limits: Mapping[str, int] | None = None, pointer: Path | str | None = None,
                 frozen=None, before_stage=None, after_stage=None, environment=None,
                 isolation: IsolationContext | None = None, lock: ExecutionLock | None = None,
                 registration_id: str | None = None, cleanup_grace: float = 10.0):
        if kind not in ("local", "development", "tool-validation", "formal"):
            raise EngineError("UNKNOWN_RUN_KIND")
        self.root = Path(root).resolve(strict=True)
        self.report_dir = Path(report_dir)
        self.kind, self.limits = kind, dict(limits or {})
        self.pointer = Path(pointer) if pointer is not None else self.root / ".tools/qt-candidates/last-local-sdk.json"
        self.frozen, self.before_stage, self.after_stage = frozen, before_stage, after_stage
        self.environment = dict(environment or {})
        self.isolation, self.lock, self.registration_id = isolation, lock, registration_id
        self.cleanup_grace = cleanup_grace
        self.ledger = None

    @property
    def captured_pointer(self):
        return self.pointer_guard.captured

    def capture_sdk_pointer(self):
        self.pointer_guard.capture_restore()
        self.ledger["sdkPointerCaptured"] = True
        self.ledger["priorDefaultPointerRestored"] = True

    def _save(self):
        destination = self.report_dir / "run-ledger.json"
        regular_file(destination, missing=True)
        temporary = self.report_dir / (".run-ledger-" + uuid.uuid4().hex + ".tmp")
        try:
            exclusive_json(temporary, self.ledger)
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _boundary(self, label):
        self.lock.verify()
        if self.kind == "local":
            self.local_state.require_owner()
        else:
            LocalRunState(self.root, self.lock).assert_no_active()
        if self.registration_id is not None:
            RegistrationState(self.root, self.lock).require(self.registration_id)
        if callable(self.frozen):
            self.frozen(label, self.ledger)
        elif self.frozen is not None:
            assert_frozen(self.root, self.frozen, require_clean=self.kind != "local")
        self.pointer_guard.compare()
        self.isolation.verify()
        self.ledger["frozenChecks"].append({"label": label, "at": now()})

    def _stage(self, stage: StageSpec):
        if not stage.id or Path(stage.id).name != stage.id or stage.id in (".", ".."):
            raise EngineError("INVALID_STAGE_ID")
        if not stage.command or any(not isinstance(value, str) or not value for value in stage.command):
            raise EngineError("STAGE_ARGV_REQUIRED")
        if stage.timeout is not None and (isinstance(stage.timeout, bool) or stage.timeout <= 0):
            raise EngineError("INVALID_STAGE_TIMEOUT")
        if self.kind == "local" and stage.capture_pointer:
            raise EngineError("LOCAL_POINTER_CAPTURE_FORBIDDEN")
        self._boundary("before-" + stage.id)
        budget = stage.budget or stage.id
        maximum = self.limits.get(budget)
        used = self.ledger["used"].get(budget, 0)
        if type(maximum) is not int or maximum < 0 or used >= maximum:
            raise EngineError("BUDGET_EXHAUSTED:" + budget)
        self.ledger["used"][budget] = used + 1
        row = {"id": stage.id, "command": list(stage.command), "cwd": str(stage.cwd or self.root),
               "startedUtc": now(), "timeoutSeconds": stage.timeout, "state": "running", "budget": budget}
        if stage.check_category is not None:
            row.update(checkCategory=stage.check_category, selection=stage.selection)
        self.ledger["runs"].append(row)
        self._save()
        process, error = None, None
        started = time.monotonic()
        try:
            if self.before_stage is not None:
                self.before_stage(self, row)
            if stage.before_start is not None:
                stage.before_start(self, row)
            env = {**self.isolation.env, **self.environment}
            for key, value in stage.env.items():
                if value is None:
                    env.pop(key, None)
                else:
                    env[key] = value
            self.isolation.validate_environment(env)
            log_name = stage.log_name or stage.id + ".log"
            if Path(log_name).name != log_name or log_name in (".", ".."):
                raise EngineError("STAGE_LOG_MUST_BE_DIRECT_CHILD")
            with (self.report_dir / log_name).open("xb") as stream:
                attempt = self.local_state.prepare_spawn(stage.id, list(stage.command)) if self.kind == "local" else None
                row["spawnAttempted"] = True
                self._save()  # Also protects registered execution's unknown-spawn window.
                process = subprocess.Popen(list(stage.command), cwd=stage.cwd or self.root, env=env,
                                           stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                row["ownedProcessGroup"] = process.pid
                if self.kind == "local":
                    self.local_state.record_group(attempt, process.pid)
                self._save()
                remaining = None if stage.timeout is None else max(0, started + stage.timeout - time.monotonic())
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired as timeout_error:
                    row["deadlineExceeded"] = True
                    raise EngineError("STOP_AFTER_TIMEOUT:" + stage.id) from timeout_error
        except BaseException as caught:
            error = caught
        finally:
            row["processGroupGone"] = process is None and not row.get("spawnAttempted", False)
            if process is not None:
                # Allow normal descendants their original bounded exit grace.
                deadline = time.monotonic() + min(5.0, self.cleanup_grace)
                if stage.timeout is not None:
                    deadline = min(deadline, started + stage.timeout)
                while process.poll() is not None and not group_gone(process.pid) and time.monotonic() < deadline:
                    time.sleep(0.02)
                needed = process.poll() is None or not group_gone(process.pid)
                row["ownedGroupRequiredCleanup"] = needed
                if needed:
                    cleanup_process_group(process, row, grace=self.cleanup_grace)
                    if error is None:
                        error = EngineError("OWNED_PROCESS_GROUP_REQUIRED_CLEANUP:" + stage.id)
                row["processGroupGone"] = group_gone(process.pid)
                if row["processGroupGone"] and self.kind == "local":
                    try:
                        self.local_state.confirm_gone(attempt)
                    except BaseException as caught:
                        row["processGroupGone"] = False
                        row["markerConfirmationError"] = str(caught) or type(caught).__name__
                        error = error or caught
                if not row["processGroupGone"] or row.get("cleanupErrors"):
                    error = error or EngineError("OWNED_PROCESS_CLEANUP_FAILED:" + stage.id)
            if row["processGroupGone"]:
                try:
                    if stage.capture_pointer:
                        self.capture_sdk_pointer()
                    if stage.after_exit is not None:
                        stage.after_exit(self, row)
                except BaseException as caught:
                    error = error or caught
            row.update(endedUtc=now(), outerElapsedSeconds=round(time.monotonic() - started, 3),
                       exitCode=process.poll() if process is not None else None, state="completed")
            if error is None and row["exitCode"] != 0:
                error = EngineError("STOP_AFTER_EXIT:" + stage.id + ":" + str(row["exitCode"]))
            if error is None and stage.timeout is not None and time.monotonic() >= started + stage.timeout:
                row["deadlineExceeded"] = True
                error = EngineError("STOP_AFTER_TIMEOUT:" + stage.id)
            if self.kind != "local" and row["processGroupGone"] and not self.pointer_guard.unchanged():
                try:
                    self.pointer_guard.restore()
                    error = error or EngineError("UNEXPECTED_STAGE_POINTER_CHANGE:" + stage.id)
                except BaseException as caught:
                    error = error or caught
            try:
                self._boundary("after-" + stage.id)
                if error is None and stage.verify is not None:
                    evidence = stage.verify(self, row)
                    if evidence is not None:
                        row["evidence"] = dict(evidence)
                        self.ledger.update(evidence)
                if error is None and self.after_stage is not None:
                    self.after_stage(self, row)
                self.pointer_guard.compare()
            except BaseException as caught:
                error = error or caught
            row["passed"] = error is None
            if error is not None:
                row["error"] = str(error) or type(error).__name__
            self._save()
        if error is not None:
            raise error

    def run(self, stages: Sequence[StageSpec], *, adopt=None, finalize=None, post_adopt=None) -> dict:
        if self.kind != "formal" and adopt is not None:
            raise EngineError("ONLY_FORMAL_MAY_ADOPT")
        if len({stage.id for stage in stages}) != len(stages):
            raise EngineError("DUPLICATE_STAGE_ID")
        context = nullcontext(self.lock) if self.lock is not None else ExecutionLock(self.root)
        with context as lock:
            self.lock = lock
            lock.verify()
            if self.kind == "local":
                RegistrationState(self.root, lock).assert_no_active()
                if getattr(self, "local_state", None) is None:
                    self.local_state = LocalRunState(self.root, lock)
                    self.local_state.assert_no_active()
                    owns_local_marker = True
                else:
                    self.local_state.require_owner()
                    owns_local_marker = False
            else:
                LocalRunState(self.root, lock).assert_no_active()
                owns_local_marker = False
            ensure_directory(self.report_dir)
            if (self.report_dir / "run-ledger.json").exists():
                raise EngineError("FRESH_RUN_LEDGER_REQUIRED")
            self.pointer_guard = getattr(self, "pointer_guard", None) or PointerGuard(self.pointer, writable=self.kind != "local")
            self.isolation = self.isolation or IsolationContext.create(self.root)
            if owns_local_marker:
                self.local_state.begin({"reportDirectory": str(self.report_dir), "internalEngine": True})
            self.ledger = {"schema": "reverie.shared-run.ledger.v1", "kind": self.kind,
                           "registrationId": self.registration_id, "startedUtc": now(), "sourceHead": None,
                           "passed": False, "runs": [], "used": {}, "frozenChecks": [],
                           "unitIsolation": {"scratch": str(self.isolation.run_root),
                                             **{name: str(path) for name, path in self.isolation.directories.items()}}}
            if isinstance(self.frozen, dict):
                self.ledger["sourceHead"] = self.frozen["head"]
            error = None
            try:
                self._save()
                self._boundary("before-attempt")
                for stage in stages:
                    self._stage(stage)
                if finalize is not None:
                    evidence = finalize(self)
                    if evidence is not None:
                        self.ledger.update(evidence)
                self._boundary("after-all-stages")
                self.ledger["sourceUnchanged"] = self.frozen is not None
                self.ledger["ownedProcessesRemaining"] = sum(not row.get("processGroupGone", False)
                                                              for row in self.ledger["runs"])
                if self.ledger["ownedProcessesRemaining"]:
                    raise EngineError("OWNED_PROCESSES_REMAIN")
                self.ledger["unitScratchRemoved"] = self.isolation.cleanup()
                self.ledger["scratchRemoved"] = self.ledger["unitScratchRemoved"]
                if not self.ledger["unitScratchRemoved"]:
                    raise EngineError("UNIT_SCRATCH_CLEANUP_FAILED")
                self.pointer_guard.compare()
                if adopt is not None:
                    payload = adopt(self) if callable(adopt) else adopt
                    self.pointer_guard.adopt(payload)
                    self.ledger["defaultPointerCandidateVerified"] = True
                    self.ledger["adoptedPointerSha256"] = hashlib.sha256(payload).hexdigest()
                    if post_adopt is not None:
                        post_adopt(self)
                self.ledger["passed"] = True
            except BaseException as caught:
                error = caught
                self.ledger["stopReason"] = str(caught) or type(caught).__name__
                self.ledger["error"] = self.ledger["stopReason"]
            finally:
                groups_confirmed = all(row.get("processGroupGone") is True for row in self.ledger["runs"])
                self.ledger["processCleanupConfirmed"] = groups_confirmed
                if not groups_confirmed:
                    self.ledger["cleanupDeferredUnconfirmedProcess"] = True
                    self.ledger["unitScratchRemoved"] = False
                elif not self.isolation.removed:
                    try:
                        self.ledger["unitScratchRemoved"] = self.isolation.cleanup()
                        self.ledger["scratchRemoved"] = self.ledger["unitScratchRemoved"]
                    except BaseException as caught:
                        self.ledger["cleanupError"] = str(caught) or type(caught).__name__
                        error = error or caught
                        self.ledger["passed"] = False
                if self.kind != "local":
                    if error is not None or adopt is None:
                        try:
                            if not groups_confirmed:
                                self.ledger["pointerRestoreDeferredUnconfirmedProcess"] = True
                                raise EngineError("POINTER_RESTORE_REQUIRES_CONFIRMED_PROCESS_CLEANUP")
                            self.pointer_guard.restore()
                            self.ledger["priorDefaultPointerRestored"] = True
                            if error is not None and self.ledger.get("adoptedPointerSha256"):
                                self.ledger["adoptionRolledBack"] = True
                                self.ledger["defaultPointerCandidateVerified"] = False
                        except BaseException as caught:
                            self.ledger["pointerRestoreError"] = str(caught) or type(caught).__name__
                            self.ledger["passed"] = False
                            error = error or caught
                else:
                    try:
                        self.pointer_guard.compare()
                        self.ledger["defaultPointerUnchanged"] = True
                    except BaseException as caught:
                        self.ledger["defaultPointerUnchanged"] = False
                        self.ledger["passed"] = False
                        error = error or caught
                if error is not None:
                    self.ledger["passed"] = False
                    self.ledger.setdefault("stopReason", str(error) or type(error).__name__)
                self.ledger["endedUtc"] = now()
                self.ledger["ownedProcessesRemaining"] = sum(not row.get("processGroupGone", False)
                                                              for row in self.ledger["runs"])
                try:
                    self._save()
                except BaseException:
                    # A publication is provisional until the result is durable.
                    if self.kind != "local" and groups_confirmed:
                        self.pointer_guard.restore()
                    raise
                if owns_local_marker and groups_confirmed and self.ledger.get("unitScratchRemoved") is True:
                    self.local_state.finish(cleanup_confirmed=True, completion_recorded=True)
            return self.ledger


def run_local(root: Path | str, package: str, category: str, selection, stages=None, *,
              report_dir: Path | str | None = None, diagnostic: bool = False,
              expected_auth_sha256: str | None = None, limits=None, frozen=None,
              stage_factory=None, action=None, command=None, environment=None) -> dict:
    """Guard one local run, including pure replay, and append its completion once."""
    project = Path(root).resolve(strict=True)
    package_name(package)
    explicit_output = validate_local_output(project, package, report_dir) if report_dir is not None else None
    selection = json.loads(json.dumps(selection, ensure_ascii=False, sort_keys=True))
    if stages is not None and stage_factory is not None:
        raise EngineError("STAGES_AND_FACTORY_CONFLICT")
    if action is not None and command is None:
        raise EngineError("CALLABLE_ACTION_REQUIRES_EXPLICIT_COMMAND")
    with ExecutionLock(project) as lock:
        state = RegistrationState(project, lock)
        state.assert_no_active()
        local_state = LocalRunState(project, lock)
        local_state.assert_no_active()
        auth = validate_authorization(project, package, category, selection, expected_auth_sha256)
        source = snapshot_source(project)
        local_pointer = PointerGuard(project / ".tools/qt-candidates/last-local-sdk.json", writable=False)
        package_dir = project / ".tools/local" / package
        with LocalLedger(package_dir) as journal:
            prior = journal.prior_code_failures(source["codeTreeHash"], category, selection)
            if prior and not diagnostic:
                raise EngineError("SAME_SOURCE_FAILED_CHECK_REQUIRES_DIAGNOSTIC_RUN")
            output = explicit_output if explicit_output is not None else package_dir / "runs" / (
                f"{len(journal.rows) + 1:06d}-" + uuid.uuid4().hex)
            validate_local_output(project, package, output)
            begin = journal.begin({"schema": "reverie.local-iteration.run.v1", "package": package,
                                   "sourceHead": source["head"], "sourceTreeHash": source["treeHash"],
                                   "codeTreeHash": source["codeTreeHash"],
                                   "sourceDirty": source["dirty"], "head": source["head"],
                                   "treeHash": source["treeHash"], "dirty": source["dirty"],
                                   "category": category, "selection": selection, "diagnostic": diagnostic,
                                   "checkKey": selection_key(category, selection),
                                   "unstable": bool(prior), "authorizationSha256": auth["sha256"],
                                   "command": command or []})
            local_state.begin({"package": package, "sequence": begin["sequence"],
                               "sourceHead": source["head"], "sourceTreeHash": source["treeHash"],
                               "codeTreeHash": source["codeTreeHash"],
                               "pendingLedger": str(journal.pending), "outputDirectory": str(output)})
            isolation, result, instance, selected = None, None, None, []
            wrapper_completed = False
            try:
                # Never adopt existing paths as this local run's output.
                ensure_directory(output.parent)
                output.mkdir(mode=0o700)
                canonical_directory(output)
                exclusive_json(output / "source-snapshot.json", source)
                isolation = IsolationContext.create(project)
                env = {**isolation.env, **dict(environment or {})}
                isolation.validate_environment(env)
                selected = list(stage_factory(project, output, env) if stage_factory is not None else stages or [])
                expanded_prior = {row["sequence"]: row for row in prior}
                for spec in selected:
                    check_category, check_selection = _stage_selection(spec, category, selection)
                    for failure in journal.prior_code_failures(source["codeTreeHash"], check_category, check_selection):
                        expanded_prior[failure["sequence"]] = failure
                prior = list(expanded_prior.values())
                if prior and not diagnostic:
                    raise EngineError("SAME_SOURCE_FAILED_CHECK_REQUIRES_DIAGNOSTIC_RUN")

                def boundary(label, ledger):
                    ledger.update(sourceHead=source["head"], sourceTreeHash=source["treeHash"],
                                  codeTreeHash=source["codeTreeHash"], sourceDirty=source["dirty"])
                    lock.verify()
                    state.assert_no_active()
                    validate_authorization(project, package, category, selection, auth["sha256"])
                    assert_frozen(project, source, require_clean=False)
                    if frozen is not None:
                        frozen(label, ledger)

                effective_limits = {stage.budget or stage.id: 1 for stage in selected} if limits is None else limits
                engine = Engine(project, output, kind="local", limits=effective_limits, frozen=boundary,
                    isolation=isolation, lock=lock, environment=env)
                instance = engine
                engine.local_state = local_state
                engine.pointer_guard = local_pointer
                finalize = (lambda instance: action(project, output, env)) if action is not None else None
                result = engine.run(selected, finalize=finalize)
                wrapper_completed = True
            except BaseException as error:
                result = dict(instance.ledger) if instance is not None and instance.ledger is not None else {
                    "runs": [], "unitScratchRemoved": False, "ownedProcessesRemaining": 0}
                result.update(passed=False, stopReason=str(error) or type(error).__name__)
            finally:
                groups_confirmed = all(run.get("processGroupGone") is True for run in result.get("runs", []))
                no_spawn_attempts = (not local_state.require_owner()["processGroups"] and
                                     not any(run.get("spawnAttempted") or run.get("ownedProcessGroup")
                                             for run in result.get("runs", [])))
                if isolation is None and no_spawn_attempts:
                    result["unitScratchRemoved"] = True
                if isolation is not None and not isolation.removed and groups_confirmed:
                    try:
                        result["unitScratchRemoved"] = isolation.cleanup()
                    except BaseException as error:
                        result["passed"] = False
                        result["cleanupError"] = str(error) or type(error).__name__
                try:
                    local_pointer.compare()
                    result["defaultPointerUnchanged"] = True
                except BaseException as error:
                    result["passed"] = False
                    result["defaultPointerUnchanged"] = False
                    result["stopReason"] = str(error) or type(error).__name__
                counts = result.get("counts", {"stages": len(result.get("runs", [])),
                                               "passedStages": sum(bool(run.get("passed")) for run in result.get("runs", [])),
                                               "used": result.get("used", {})})
                for key, value in result.items():
                    if key.endswith("Evidence") and isinstance(value, dict):
                        if isinstance(value.get("counts"), dict):
                            counts[key] = dict(value["counts"])
                        numbers = {name: count for name, count in value.items()
                                   if type(count) in (int, float) and count >= 0}
                        if numbers:
                            counts[key] = numbers
                failed_exit = next((run.get("exitCode") for run in result.get("runs", [])
                                    if not run.get("passed") and run.get("exitCode")), 1)
                row = {**begin, "endedUtc": now(), "outputDirectory": str(output),
                       "command": command or [run["command"] for run in result.get("runs", [])],
                       "exitCode": 0 if result.get("passed") else failed_exit,
                       "counts": counts, "passed": bool(result.get("passed")),
                       "diagnostic": diagnostic, "unstable": bool(prior),
                       "stopReason": result.get("stopReason"), "unitScratchRemoved": result.get("unitScratchRemoved"),
                       "ownedProcessesRemaining": result.get("ownedProcessesRemaining", 0)}
                row["processCleanupConfirmed"] = groups_confirmed
                specs_by_id = {spec.id: spec for spec in selected}
                failed_stages = []
                for run in result.get("runs", []):
                    if run.get("passed") is True:
                        continue
                    spec = specs_by_id.get(run.get("id"))
                    fallback = _stage_selection(spec, category, selection) if spec is not None else (category, selection)
                    failed_stages.append({"stage": run.get("id"), "category": run.get("checkCategory", fallback[0]),
                                          "selection": run.get("selection", fallback[1])})
                if not row["passed"] and not failed_stages:
                    failed_stages = [{"stage": None, "category": category, "selection": selection}]
                row["failedStages"] = failed_stages
                for key in ("identityManifest", "identityManifestSha256", "unitSelection", "unitSelections",
                            "guiModes", "selectionManifest", "replayInputs", "measurements"):
                    if key in result:
                        row[key] = result[key]
                journal.append_complete(row)
                if (wrapper_completed or no_spawn_attempts) and groups_confirmed and result.get("unitScratchRemoved") is True:
                    local_state.finish(cleanup_confirmed=True, completion_recorded=True)
            return {**result, "localRun": row, "outputDirectory": str(output)}
