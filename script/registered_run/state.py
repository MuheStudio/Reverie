"""Persistent locks, explicit active registration, authorization and local ledger."""

from __future__ import annotations

from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import uuid

from .isolation import canonical_directory


class StateError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json_bytes(payload: bytes):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise StateError("DUPLICATE_JSON_KEY:" + key)
            value[key] = item
        return value
    return json.loads(payload, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(StateError("NONFINITE_JSON:" + value)))


def package_name(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[a-z0-9][a-z0-9-]{1,63}", value) is None:
        raise StateError("INVALID_PACKAGE_NAME")
    return value


def selection_key(category: str, selection) -> str:
    if category == "gui":
        selection = sorted(gui_selection_options(selection))
    elif isinstance(selection, (tuple, list)):
        selection = sorted(selection, key=lambda item: json.dumps(item, sort_keys=True))
    value = json.dumps([category, selection], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(value.encode()).hexdigest()


def gui_selection_options(selection) -> list[str]:
    """Expand the planner's default/all or mode list before checking scope."""
    from .coverage import MODE_OPTIONS
    aliases = {identity: " ".join(options) for identity, options in MODE_OPTIONS}
    canonical = list(aliases.values())
    # Explicit preview selections are new; the old empty/default remains seven.
    from .preview import MODE, OPTION
    aliases[MODE] = OPTION
    by_tokens = {tuple(sorted(options.split())): options for options in aliases.values()}

    def single(value):
        if not isinstance(value, str) or not value.strip():
            raise StateError("LOCAL_GUI_SELECTION_INVALID")
        value = " ".join(value.split())
        value = aliases.get(value.removesuffix("-check"), value)
        return by_tokens.get(tuple(sorted(value.split())), value)

    if selection is None or selection == [] or selection == () or selection == "":
        return canonical
    if isinstance(selection, str):
        values = [single(selection)]
    elif isinstance(selection, (list, tuple)):
        # Also accept one mode supplied as its argv token list.
        if all(isinstance(value, str) and value.startswith("--") for value in selection):
            joined = single(" ".join(selection))
            values = [joined] if joined in aliases.values() else [single(value) for value in selection]
        else:
            values = [single(value) for value in selection]
    else:
        raise StateError("LOCAL_GUI_SELECTION_INVALID")
    if len(values) != len(set(values)):
        raise StateError("LOCAL_GUI_SELECTION_REPEATED")
    return values


def selection_checks(category: str, selection) -> list[tuple[str, tuple[str, ...]]]:
    """Normalize a request into checks whose selection hierarchies can overlap."""
    if category == "full":
        keys = {"pythonTargets": "python", "nodeTests": "node", "frontendTests": "frontend", "nativeTargets": "native"}
        if isinstance(selection, dict) and any(key in selection for key in keys):
            return [check for key, child in keys.items() if key in selection
                    for check in selection_checks(child, selection[key])]
        return [(child, ()) for child in keys.values()]
    if category == "gui":
        return [(category, (mode,)) for mode in gui_selection_options(selection)]
    if selection is None or selection == [] or selection == () or selection == "":
        return [(category, ())]  # An omitted selector means the complete category.
    values = list(selection) if isinstance(selection, (tuple, list)) else [selection]
    result = []
    for value in values:
        if not isinstance(value, str):
            result.append((category, (json.dumps(value, sort_keys=True),)))
            continue
        parts = value.split("::")
        if category == "native":
            from .measurement import TARGET_EXECUTABLES
            aliases = {executable: target for target, executable in TARGET_EXECUTABLES.items()}
            target = aliases.get(parts[0], parts[0])
            normalized = [target]
            if len(parts) > 1:
                function = parts[-1]  # Optional QTest class does not change the target.
                match = re.fullmatch(r"([A-Za-z_]\w*)(?:\((.*)\)|:(.*))?", function)
                if match:
                    normalized.append(match.group(1))
                    tag = match.group(2) if match.group(2) is not None else match.group(3)
                    if tag:
                        normalized.append(tag)
                else:
                    normalized.append(function)
        else:
            if category == "python" and "[" in value and value.endswith("]"):
                prefix, tag = value.split("[", 1)
                parts = prefix.split("::")
                normalized = [PurePosixPath(parts[0]).as_posix(), *parts[1:], tag[:-1]]
            else:
                normalized = [PurePosixPath(parts[0]).as_posix(), *parts[1:]]
        result.append((category, tuple(normalized)))
    return result


def selections_intersect(left_category: str, left_selection, right_category: str, right_selection) -> bool:
    left, right = selection_checks(left_category, left_selection), selection_checks(right_category, right_selection)
    return any(left_kind == right_kind and (left_parts[:len(right_parts)] == right_parts or
                                           right_parts[:len(left_parts)] == left_parts)
               for left_kind, left_parts in left for right_kind, right_parts in right)


def ensure_directory(path: Path | str) -> Path:
    directory = Path(path)
    if not directory.is_absolute():
        raise StateError("STATE_ABSOLUTE_PATH_REQUIRED")
    missing = []
    current = directory
    while not current.exists() and not current.is_symlink():
        missing.append(current)
        current = current.parent
    canonical_directory(current)
    for new in reversed(missing):
        new.mkdir(mode=0o700)
        canonical_directory(new)
    canonical_directory(directory)
    return directory


def regular_file(path: Path | str, *, missing: bool = False):
    path = Path(path)
    canonical_directory(path.parent)
    try:
        info = path.lstat()
    except FileNotFoundError:
        if missing:
            return None
        raise
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
        raise StateError("STATE_FILE_ALIAS_OR_OWNER:" + str(path))
    return info


def exclusive_json(path: Path, value: dict) -> None:
    ensure_directory(path.parent)
    with path.open("xb") as stream:
        stream.write((json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode())
        stream.flush()
        os.fsync(stream.fileno())


class ExecutionLock:
    """One permanent flock inode for all local and registered execution."""

    def __init__(self, root: Path | str):
        self.root = Path(root).resolve(strict=True)
        self.path = self.root / ".tools/registered-run/execution.lock"
        self.fd = None
        self.owner = uuid.uuid4().hex

    @property
    def held(self):
        return self.fd is not None

    def __enter__(self):
        if self.held:
            raise StateError("EXECUTION_LOCK_ALREADY_HELD")
        ensure_directory(self.path.parent)
        regular_file(self.path, missing=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if info.st_nlink != 1 or info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
                raise StateError("EXECUTION_LOCK_IDENTITY_INVALID")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise StateError("ANOTHER_EXECUTION_ACTIVE") from error
            self.fd, self.identity = fd, (info.st_dev, info.st_ino)
            self.verify()
            return self
        except BaseException:
            os.close(fd)
            self.fd = None
            raise

    def verify(self):
        if not self.held:
            raise StateError("EXECUTION_LOCK_REQUIRED")
        info = regular_file(self.path)
        if (info.st_dev, info.st_ino) != self.identity:
            raise StateError("EXECUTION_LOCK_REPLACED")

    def __exit__(self, *_):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None
        # Never unlink this file: all future callers must flock the same inode.


class RegistrationState:
    def __init__(self, root: Path | str, lock: ExecutionLock | None = None):
        self.root = Path(root).resolve(strict=True)
        self.path = self.root / ".tools/registered-run/active-registration.json"
        self.lock = lock

    def _locked(self):
        if self.lock is None or self.lock.root != self.root:
            raise StateError("EXECUTION_LOCK_REQUIRED")
        self.lock.verify()

    def active(self):
        if not self.path.parent.exists():
            return None
        if regular_file(self.path, missing=True) is None:
            return None
        value = load_json_bytes(self.path.read_bytes())
        if not isinstance(value, dict) or value.get("schema") != "reverie.active-registration.v1":
            raise StateError("ACTIVE_REGISTRATION_MARKER_INVALID")
        return value

    def assert_no_active(self):
        self._locked()
        if self.active() is not None:
            raise StateError("ACTIVE_REGISTRATION_BLOCKS_LOCAL")

    def freeze(self, registration_id: str, metadata: dict | None = None):
        self._locked()
        LocalRunState(self.root, self.lock).assert_no_active()
        if self.active() is not None:
            raise StateError("ACTIVE_REGISTRATION_EXISTS")
        package_name(registration_id)
        value = {"schema": "reverie.active-registration.v1", "registrationId": registration_id,
                 "state": "frozen", "createdUtc": now(), "ownerPid": os.getpid(),
                 "ownerToken": self.lock.owner, "metadata": metadata or {}}
        exclusive_json(self.path, value)
        return value

    def require(self, registration_id: str):
        self._locked()
        LocalRunState(self.root, self.lock).assert_no_active()
        value = self.active()
        if not value or value.get("registrationId") != registration_id or value.get("state") != "frozen":
            raise StateError("ACTIVE_REGISTRATION_BINDING_MISMATCH")
        return value

    def finish(self, registration_id: str):
        self.require(registration_id)
        identity = regular_file(self.path)
        current = self.path.lstat()
        if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
            raise StateError("ACTIVE_REGISTRATION_MARKER_REPLACED")
        self.path.unlink()


class LocalRunState:
    """Durable global local-run ownership, including the Popen unknown window.

    An abandoned marker is never automatically removed, even when its original
    launcher is dead. The file is the guard after a crash releases flock.
    """

    def __init__(self, root: Path | str, lock: ExecutionLock):
        self.root = Path(root).resolve(strict=True)
        self.path = self.root / ".tools/registered-run/active-local.json"
        self.lock = lock
        self.identity = None

    def _locked(self):
        if self.lock.root != self.root:
            raise StateError("EXECUTION_LOCK_REQUIRED")
        self.lock.verify()

    def active(self):
        if not self.path.parent.exists() or regular_file(self.path, missing=True) is None:
            return None
        value = load_json_bytes(self.path.read_bytes())
        if not isinstance(value, dict) or value.get("schema") != "reverie.active-local-run.v1":
            raise StateError("ACTIVE_LOCAL_MARKER_INVALID")
        return value

    def assert_no_active(self):
        self._locked()
        if self.active() is not None:
            raise StateError("ACTIVE_LOCAL_RUN_REQUIRES_REVIEW")

    def require_owner(self):
        self._locked()
        value = self.active()
        if not value or value.get("ownerToken") != self.lock.owner or value.get("ownerPid") != os.getpid():
            raise StateError("ACTIVE_LOCAL_OWNER_MISMATCH")
        info = regular_file(self.path)
        actual = (info.st_dev, info.st_ino)
        if self.identity is not None and actual != self.identity:
            raise StateError("ACTIVE_LOCAL_MARKER_REPLACED")
        self.identity = actual
        return value

    def begin(self, metadata: dict):
        self.assert_no_active()
        value = {"schema": "reverie.active-local-run.v1", "runId": uuid.uuid4().hex,
                 "createdUtc": now(), "ownerPid": os.getpid(), "ownerToken": self.lock.owner,
                 "metadata": metadata, "processGroups": []}
        exclusive_json(self.path, value)
        self.require_owner()
        return value

    def _update(self, value):
        self.require_owner()
        temporary = self.path.with_name(".active-local-" + uuid.uuid4().hex + ".tmp")
        try:
            exclusive_json(temporary, value)
            self.require_owner()
            os.replace(temporary, self.path)
            info = regular_file(self.path)
            self.identity = (info.st_dev, info.st_ino)
        finally:
            if temporary.exists():
                temporary.unlink()

    def prepare_spawn(self, stage_id: str, command: list[str]) -> str:
        value = self.require_owner()
        token = uuid.uuid4().hex
        value["processGroups"].append({"attempt": token, "stage": stage_id, "command": command,
                                       "state": "spawning", "preparedUtc": now()})
        self._update(value)  # Durable before Popen: a crash here remains unknown.
        return token

    def record_group(self, token: str, pgid: int):
        if type(pgid) is not int or pgid <= 0:
            raise StateError("ACTIVE_LOCAL_PGID_INVALID")
        value = self.require_owner()
        rows = [row for row in value["processGroups"] if row.get("attempt") == token]
        if len(rows) != 1 or rows[0].get("state") != "spawning":
            raise StateError("ACTIVE_LOCAL_SPAWN_BINDING_CHANGED")
        rows[0].update(state="running", pgid=pgid, spawnedUtc=now())
        self._update(value)

    def confirm_gone(self, token: str):
        value = self.require_owner()
        rows = [row for row in value["processGroups"] if row.get("attempt") == token]
        if len(rows) != 1 or rows[0].get("state") != "running":
            raise StateError("ACTIVE_LOCAL_GROUP_BINDING_CHANGED")
        try:
            os.killpg(rows[0]["pgid"], 0)
        except ProcessLookupError:
            pass
        else:
            raise StateError("ACTIVE_LOCAL_GROUP_NOT_CONFIRMED_GONE")
        rows[0].update(state="gone", goneUtc=now())
        self._update(value)

    def finish(self, *, cleanup_confirmed: bool, completion_recorded: bool):
        value = self.require_owner()
        if cleanup_confirmed is not True or completion_recorded is not True:
            raise StateError("ACTIVE_LOCAL_CLEANUP_OR_COMPLETION_UNCONFIRMED")
        if any(row.get("state") != "gone" for row in value["processGroups"]):
            raise StateError("ACTIVE_LOCAL_SPAWN_OR_GROUP_UNCONFIRMED")
        self.require_owner()
        self.path.unlink()


def validate_authorization(root: Path | str, package: str, category: str, selection,
                           expected_sha256: str | None = None) -> dict:
    package_name(package)
    path = Path(root) / ".tools/local" / package / "authorization.json"
    try:
        regular_file(path)
    except FileNotFoundError as error:
        raise StateError("LOCAL_AUTHORIZATION_MISSING") from error
    payload = path.read_bytes()
    sha = hashlib.sha256(payload).hexdigest()
    if expected_sha256 is not None and sha != expected_sha256:
        raise StateError("LOCAL_AUTHORIZATION_BYTES_CHANGED")
    value = load_json_bytes(payload)
    if (not isinstance(value, dict) or value.get("schema") != "reverie.local-iteration.authorization.v1"
            or value.get("package") != package or not value.get("userApprovalText")
            or not value.get("recordedUtc") or not value.get("validUntil")):
        raise StateError("LOCAL_AUTHORIZATION_INVALID")
    for key in ("revoked", "withdrawn", "completed", "signedOff", "voided", "revokedUtc", "completedUtc", "voidedUtc"):
        if value.get(key):
            raise StateError("LOCAL_AUTHORIZATION_NO_LONGER_VALID:" + key)
    if value.get("valid") is False or value.get("status", "active") not in ("active", "authorized"):
        raise StateError("LOCAL_AUTHORIZATION_NO_LONGER_VALID")
    for key in ("expiresUtc", "validUntilUtc"):
        if value.get(key) and datetime.fromisoformat(value[key].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
            raise StateError("LOCAL_AUTHORIZATION_EXPIRED")
    scope = value.get("scope")
    if not isinstance(scope, dict):
        raise StateError("LOCAL_AUTHORIZATION_SCOPE_MISSING")
    if category in ("python", "node", "frontend", "native", "full"):
        allowed = bool(scope.get("unitsAndNative"))
    elif category == "build":
        allowed = scope.get("localBuildDirectory") == f".tools/qt-builds/local-{package}"
    elif category == "replay":
        allowed = bool(scope.get("readOnlyReplay"))
    elif category == "gui":
        selected = gui_selection_options(selection)
        authorized = [*scope.get("guiModes", []), *scope.get("newGuiModes", [])]
        allowed = bool(selected) and all(mode in authorized for mode in selected)
    else:
        allowed = False
    if not allowed:
        raise StateError("LOCAL_AUTHORIZATION_SCOPE_EXCEEDED:" + category)
    return {"path": str(path), "sha256": sha, "value": value}


class LocalLedger:
    """One immutable completion row per run; pending files retain crash context."""

    def __init__(self, package_dir: Path | str):
        self.directory = ensure_directory(package_dir)
        self.path = self.directory / "ledger.jsonl"
        regular_file(self.path, missing=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(self.fd)
        self.identity = (info.st_dev, info.st_ino)
        self.pending = None
        try:
            regular_file(self.path)
            os.fsync(self.fd)  # Fail before execution if this filesystem refuses ledger durability.
            self.rows = self._read_rows(self.path)
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _read_rows(path: Path):
        if not path.exists():
            return []
        regular_file(path)
        payload = path.read_bytes()
        if payload and not payload.endswith(b"\n"):
            raise StateError("LOCAL_LEDGER_INCOMPLETE_ROW")
        return [load_json_bytes(line) for line in payload.splitlines() if line]

    def verify(self):
        info = regular_file(self.path)
        if (info.st_dev, info.st_ino) != self.identity:
            raise StateError("LOCAL_LEDGER_REPLACED")

    def begin(self, payload: dict) -> dict:
        self.verify()
        sequence = len(self.rows) + 1
        if any(row.get("sequence") != index for index, row in enumerate(self.rows, 1)):
            raise StateError("LOCAL_LEDGER_SEQUENCE_INVALID")
        value = {**payload, "sequence": sequence, "startedUtc": now()}
        self.pending = self.directory / f"pending-{sequence:06d}-{uuid.uuid4().hex}.json"
        exclusive_json(self.pending, value)
        self.pending_identity = self.pending.stat()
        return value

    def append_complete(self, value: dict):
        self.verify()
        if self.pending is None or value.get("sequence") != len(self.rows) + 1:
            raise StateError("LOCAL_LEDGER_RUN_NOT_BEGUN")
        payload = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        if os.write(self.fd, payload) != len(payload):
            raise StateError("LOCAL_LEDGER_PARTIAL_APPEND")
        os.fsync(self.fd)
        self.rows.append(value)
        info = regular_file(self.pending)
        if (info.st_dev, info.st_ino) != (self.pending_identity.st_dev, self.pending_identity.st_ino):
            raise StateError("LOCAL_PENDING_REPLACED")
        self.pending.unlink()
        self.pending = None

    def failures(self, *, tree_hash: str | None = None, code_tree_hash: str | None = None,
                 unresolved_only: bool = False):
        rows = [row for row in self.rows if not row.get("passed") and
                (tree_hash is None or row.get("sourceTreeHash") == tree_hash) and
                (code_tree_hash is None or row.get("codeTreeHash") == code_tree_hash)]
        if unresolved_only:
            analyses = self._read_rows(self.directory / "analyses.jsonl")
            addressed = {sequence for row in analyses if row.get("reportedToUser") is True
                         for sequence in row.get("failureSequences", [])}
            rows = [row for row in rows if row.get("sequence") not in addressed]
        return rows

    def prior_code_failures(self, code_tree_hash: str, category: str, selection):
        """Match explicit code identities only; never upgrade historical rows."""
        if not isinstance(code_tree_hash, str) or not code_tree_hash:
            raise StateError("LOCAL_CODE_TREE_HASH_REQUIRED")
        return self._intersecting_failures(self.failures(code_tree_hash=code_tree_hash), category, selection)

    @staticmethod
    def _intersecting_failures(rows, category: str, selection):
        matches = []
        for row in rows:
            failed = row.get("failedStages") or [{"category": row.get("category"), "selection": row.get("selection")}]
            if any(selections_intersect(check.get("category", row.get("category")), check.get("selection"),
                                        category, selection) for check in failed):
                matches.append(row)
        return matches

    def append_analysis(self, failure_sequences: list[int], note: str, *, reported_to_user: bool):
        if not note.strip() or not failure_sequences or reported_to_user is not True:
            raise StateError("LOCAL_FAILURE_ANALYSIS_AND_REPORT_REQUIRED")
        failures = {row["sequence"] for row in self.rows if not row.get("passed") or row.get("unstable")}
        if not set(failure_sequences).issubset(failures):
            raise StateError("LOCAL_ANALYSIS_UNKNOWN_FAILURE")
        path = self.directory / "analyses.jsonl"
        regular_file(path, missing=True)
        payload = {"at": now(), "failureSequences": failure_sequences, "note": note, "reportedToUser": True}
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            data = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode()
            if os.write(fd, data) != len(data):
                raise StateError("LOCAL_ANALYSIS_PARTIAL_APPEND")
            os.fsync(fd)
        finally:
            os.close(fd)

    def close(self):
        if getattr(self, "fd", None) is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
