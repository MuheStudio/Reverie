"""W1 isolated preview lifecycle producer. Never opens the real preview workspace."""
from __future__ import annotations

import argparse
from datetime import datetime
from collections import deque
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import secrets
import stat
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
READY_PREFIX = b"REVERIE_PREVIEW_READY "
LIMITS = {"readyMs": 30000, "normalMs": 10000, "duplicateMs": 5000, "forcedMs": 10000}
CHECKS = [("first-start", "firstStart"), ("second-instance-rejected", "secondInstance"),
          ("sigterm-exit", "sigterm"), ("restart-same-storage", "restart"),
          ("forced-host-exit-and-lock-recovery", "forcedExit")]
SERVICES = {
    "previewStorage": "com.muhe.reverie.qt.preview.storage.v1",
    "previewCredentials": "com.muhe.reverie.qt.preview.credentials.v1",
    "testStorage": "com.muhe.reverie.qt.local.storage.v1",
    "testCredentials": "com.muhe.reverie.qt.local.credentials.v1",
}
ATTRIBUTE_TIMEOUT_SECONDS = 5
SCOPE_CHECKS = [*CHECKS, ("version-snapshot", "versionSnapshot"), ("sanitized-diagnostics", "diagnostics")]
MAX_INVENTORY_ENTRIES = 50_000
MAX_INVENTORY_BYTES = 64 * 1024 * 1024


def checkpoint(phase):
    print(json.dumps({"phase": phase, "monotonicNs": time.monotonic_ns()}, ensure_ascii=False), flush=True)


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def owned_directory(path):
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid(),
         "PREVIEW_SMOKE_DIRECTORY_OWNER")
    need(path.resolve(strict=True) == path, "PREVIEW_SMOKE_DIRECTORY_ALIAS")
    return (info.st_dev, info.st_ino, info.st_uid)


def isolation_root(value, environ):
    # Compare to the runner's explicit scratch before resolving any supplied path.
    data = environ.get("REVERIE_DATA_DIR", "")
    need(bool(data) and Path(data).is_absolute(), "PREVIEW_SMOKE_RUNNER_REQUIRED")
    expected = Path(data).parent
    path = Path(value)
    need(path == expected and path.is_absolute() and str(path) == os.path.abspath(value)
         and path.name.startswith("reverie-local-"), "PREVIEW_SMOKE_ISOLATION_BINDING")
    need(Path(environ.get("TMPDIR", "")) == path / "tmp", "PREVIEW_SMOKE_TMP_BINDING")
    owned_directory(path)
    need(stat.S_IMODE(path.stat().st_mode) == 0o700, "PREVIEW_SMOKE_ISOLATION_MODE")
    return path


def database_identity(workspace):
    relative = "data/runtime/kernel.sqlite3"
    path = workspace / relative
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_uid == os.getuid()
         and info.st_nlink == 1 and info.st_size > 0 and path.resolve() == path,
         "PREVIEW_SMOKE_DATABASE_INVALID")
    return {"relativePath": relative, "device": info.st_dev, "inode": info.st_ino}


def lock_available(path):
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1,
             "PREVIEW_SMOKE_LOCK_FILE")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return True
    finally:
        os.close(descriptor)


def parse_keychain_attributes(stdout, stderr, returncode, service, account):
    """Three states: verified attributes, explicit not-found, or an error."""
    need(service in SERVICES.values() and re.fullmatch(r"[0-9a-f]{64}", account),
         "PREVIEW_SMOKE_ATTRIBUTE_SCOPE")
    need(len(stdout) <= 65536 and len(stderr) <= 65536, "PREVIEW_SMOKE_ATTRIBUTE_OUTPUT_LIMIT")
    text, error = stdout.decode("utf-8", "strict"), stderr.decode("utf-8", "strict")
    need(not re.search(r"(?im)^\s*(?:password|data):", text + "\n" + error),
         "PREVIEW_SMOKE_UNEXPECTED_SECRET_OUTPUT")
    if returncode == 44 and not text.strip() and re.fullmatch(
            r"security: (?:SecKeychainSearchCopyNext|SecItemCopyMatching): The specified item could not be found in the keychain\.",
            error.strip()):
        return None
    need(returncode == 0, "PREVIEW_SMOKE_ATTRIBUTE_QUERY:" + str(returncode))
    need(not error.strip() and len(re.findall(r'^class:\s*"genp"\s*$', text, re.MULTILINE)) == 1,
         "PREVIEW_SMOKE_ATTRIBUTE_CLASS")
    def blob(name):
        matches = re.findall(r'^\s*"' + name + r'"<blob>="([^"\r\n]*)"\s*$', text, re.MULTILINE)
        need(len(matches) == 1, "PREVIEW_SMOKE_ATTRIBUTE_FIELD:" + name)
        return matches[0]
    def timestamp(name):
        matches = re.findall(r'^\s*"' + name + r'"<timedate>=(?:0x([0-9a-fA-F]+)\s+)?"([0-9]{14}Z(?:\\000)?)"\s*$',
                             text, re.MULTILINE)
        need(len(matches) == 1, "PREVIEW_SMOKE_ATTRIBUTE_FIELD:" + name)
        hexadecimal, quoted = matches[0]
        value = quoted.removesuffix(r"\000")
        try:
            valid_date = datetime.strptime(value, "%Y%m%d%H%M%SZ").strftime("%Y%m%d%H%M%SZ") == value
        except ValueError as error:
            raise RuntimeError("PREVIEW_SMOKE_ATTRIBUTE_DATE") from error
        need(valid_date, "PREVIEW_SMOKE_ATTRIBUTE_DATE")
        if hexadecimal:
            need(bytes.fromhex(hexadecimal).rstrip(b"\0") == value.encode("ascii"),
                 "PREVIEW_SMOKE_ATTRIBUTE_DATE_ENCODING")
        return value
    need(blob("svce") == service and blob("acct") == account, "PREVIEW_SMOKE_ATTRIBUTE_IDENTITY")
    return {"service": service, "account": account,
            "creationTime": timestamp("cdat"), "modificationTime": timestamp("mdat")}


class KeychainAttributes:
    """Attributes only. There is no password-read or deletion API here."""
    def __init__(self, account):
        need(isinstance(account, str) and re.fullmatch(r"[0-9a-f]{64}", account),
             "PREVIEW_SMOKE_ACCOUNT")
        self.account = account

    def read_attributes(self, service):
        need(service in SERVICES.values(), "PREVIEW_SMOKE_SERVICE")
        name = next(k for k, v in SERVICES.items() if v == service)
        checkpoint("keychain-attributes-" + name + "-start")
        command = ["/usr/bin/security", "find-generic-password", "-s", service, "-a", self.account]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=ATTRIBUTE_TIMEOUT_SECONDS, check=False)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("PREVIEW_SMOKE_ATTRIBUTE_TIMEOUT:" + name) from error
        attributes = parse_keychain_attributes(result.stdout, result.stderr, result.returncode, service, self.account)
        checkpoint("keychain-attributes-" + name + "-complete")
        return attributes


def directory_record(path):
    owned_directory(path)
    info = path.lstat()
    return {"path": str(path), "device": str(info.st_dev), "inode": str(info.st_ino), "uid": info.st_uid}


def cleanup_context(isolation, workspace):
    need(workspace == isolation / "preview-workspace" and workspace.resolve(strict=True) == workspace,
         "PREVIEW_SMOKE_CLEANUP_WORKSPACE_SCOPE")
    value = {"schema": "reverie.qt.isolation.v1", "purpose": "reverie.qt.preview-test-cleanup.v1",
             "root": directory_record(isolation), "data": directory_record(isolation / "data"),
             "previewWorkspace": directory_record(workspace)}
    path = isolation / "preview-cleanup-context.json"
    write_json(path, value)
    return path


def process_table():
    value = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,lstart=,stat=,comm="], text=True, timeout=2)
    result = {}
    for line in value.splitlines():
        fields = line.split(None, 8)
        if len(fields) == 9 and fields[0].isdigit() and fields[1].isdigit():
            result[int(fields[0])] = {"parent": int(fields[1]),
                                      "identity": (" ".join(fields[2:7]), fields[8])}
    return result


def update_descendants(table, roots, known):
    parents = set(roots) | {pid for pid, identity in known.items()
                            if pid in table and table[pid]["identity"] == identity}
    for _ in range(32):
        found = {pid for pid, row in table.items() if row["parent"] in parents}
        if found <= parents:
            break
        parents |= found
    else:
        raise RuntimeError("PREVIEW_SMOKE_PROCESS_DEPTH")
    for pid in parents - set(roots):
        if pid in table:
            known.setdefault(pid, table[pid]["identity"])
    need(len(known) <= 64, "PREVIEW_SMOKE_PROCESS_COUNT")


def remaining_processes(table, known):
    return sorted(pid for pid, identity in known.items()
                  if pid in table and table[pid]["identity"] == identity)


class Host:
    def __init__(self, runtime, workspace, *, cleanup_file=None):
        self.started = time.monotonic_ns()
        self.ready_events = []
        self.errors = []
        self.tail = deque(maxlen=80)
        self.descendants = {}
        self.workspace = workspace
        self.workspace_identity = None
        self.guard = threading.Lock()
        self.stop = threading.Event()
        env = dict(os.environ)
        env["QML_DISABLE_DISK_CACHE"] = "1"
        # No fixture endpoint/bridge/bootstrap is provided to the preview host.
        if cleanup_file is None:
            command = [runtime["hostExecutable"], "--workspace", str(workspace),
                       "--project-root", runtime["runtimeRoot"], "--python", runtime["python"]]
        else:
            command = [runtime["hostExecutable"], "--remove-preview-test-key", "--context", str(cleanup_file),
                       "--data-dir", str(cleanup_file.parent / "data")]
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        env=env, cwd=runtime["runtimeRoot"])
        self.pid = self.process.pid
        self.threads = []
        for source, stream in (("stdout", self.process.stdout), ("stderr", self.process.stderr)):
            thread = threading.Thread(target=self.read, args=(source, stream), daemon=True)
            thread.start()
            self.threads.append(thread)
        self.observer = threading.Thread(target=self.observe, daemon=True)
        self.observer.start()

    def read(self, source, stream):
        pending = b""
        try:
            while True:
                chunk = os.read(stream.fileno(), 4096)
                if not chunk:
                    break
                pending += chunk
                need(len(pending) <= 65536, "PREVIEW_SMOKE_OUTPUT_LINE_LIMIT")
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    with self.guard:
                        self.tail.append(source + ": " + line.decode("utf-8", "replace")[:2000])
                        if source == "stdout" and line.startswith(READY_PREFIX):
                            need(len(self.ready_events) < 4, "PREVIEW_SMOKE_READY_OVERFLOW")
                            self.ready_events.append((time.monotonic_ns(), json.loads(line[len(READY_PREFIX):])))
        except Exception as error:
            with self.guard:
                self.errors.append(str(error))

    def observe(self):
        while not self.stop.is_set():
            try:
                table = process_table()
                with self.guard:
                    update_descendants(table, [self.pid] if self.process.poll() is None else [], self.descendants)
            except Exception as error:
                with self.guard:
                    self.errors.append(str(error))
                return
            self.stop.wait(0.04)

    def ready(self, runtime, account):
        deadline = self.started + LIMITS["readyMs"] * 1_000_000
        while time.monotonic_ns() <= deadline:
            if self.workspace_identity is None and self.workspace.exists():
                self.workspace_identity = owned_directory(self.workspace)
            with self.guard:
                need(not self.errors, "PREVIEW_SMOKE_OBSERVER:" + repr(self.errors))
                if self.ready_events:
                    when, value = self.ready_events[0]
                    need(len(self.ready_events) == 1 and value.get("schema") == "reverie.qt.preview.ready.v1"
                         and value.get("hostPid") == self.pid and value.get("workspaceId") == account
                         and value.get("candidate") == runtime["candidate"]
                         and value.get("sourceHead") == runtime["sourceHead"]
                         and value.get("recoveryState") == "clean" and value.get("runtimeWritable") is True,
                         "PREVIEW_SMOKE_READY_INVALID")
                    table = process_table()
                    backend = value.get("backendPid")
                    need(type(backend) is int and backend in table and table[backend]["parent"] == self.pid,
                         "PREVIEW_SMOKE_BACKEND_PID")
                    self.descendants[backend] = table[backend]["identity"]
                    return {"startedNs": self.started, "readyNs": when, "ready": value}
            need(self.process.poll() is None, "PREVIEW_SMOKE_HOST_EXIT_BEFORE_READY:" + str(self.process.returncode))
            time.sleep(0.02)
        raise RuntimeError("PREVIEW_SMOKE_READY_TIMEOUT")

    def finish_threads(self):
        self.stop.set()
        self.observer.join(timeout=2)
        for thread in self.threads:
            thread.join(timeout=2)
        need(not self.observer.is_alive() and all(not thread.is_alive() for thread in self.threads),
             "PREVIEW_SMOKE_OBSERVER_CLEANUP")
        for stream in (self.process.stdout, self.process.stderr):
            stream.close()
        need(not self.errors, "PREVIEW_SMOKE_OBSERVER:" + repr(self.errors))

    def exit(self, sig):
        before = process_table()
        with self.guard:
            update_descendants(before, [self.pid], self.descendants)
            original = sorted(remaining_processes(before, self.descendants))
        need(self.process.poll() is None, "PREVIEW_SMOKE_HOST_ALREADY_EXITED")
        sent = time.monotonic_ns()
        self.process.send_signal(sig)
        limit = LIMITS["forcedMs"] if sig == signal.SIGKILL else LIMITS["normalMs"]
        deadline = sent + limit * 1_000_000
        try:
            code = self.process.wait(timeout=limit / 1000)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("PREVIEW_SMOKE_HOST_EXIT_TIMEOUT") from error
        exited = time.monotonic_ns()
        if sig == signal.SIGKILL:
            # Contract starts at observed host death, not signal dispatch.
            deadline = exited + LIMITS["forcedMs"] * 1_000_000
        while True:
            table = process_table()
            with self.guard:
                update_descendants(table, [], self.descendants)
                remaining = remaining_processes(table, self.descendants)
            gone = time.monotonic_ns()
            if not remaining:
                break
            need(gone <= deadline, "PREVIEW_SMOKE_BACKEND_EXIT_TIMEOUT:" + repr(remaining))
            time.sleep(0.02)
        need(gone <= deadline, "PREVIEW_SMOKE_EXIT_DEADLINE")
        self.finish_threads()
        return {"hostPid": self.pid, "signal": "SIGKILL" if sig == signal.SIGKILL else "SIGTERM",
                "sentNs": sent, "hostExitedNs": exited, "hostExitCode": code, "allGoneNs": gone,
                "descendantPidsBefore": original, "remainingPids": remaining}

    def cleanup(self):
        # A failed check remains failed; these signals only clean our own identities.
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)
        self.stop.set()
        self.observer.join(timeout=2)
        for _ in range(2):
            table = process_table()
            with self.guard:
                update_descendants(table, [], self.descendants)
                remaining = remaining_processes(table, self.descendants)
            for pid in remaining:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if not remaining:
                break
            time.sleep(0.2)
        self.finish_threads()
        return remaining_processes(process_table(), self.descendants)


def node_call(method, argument):
    need(method in ("installIsolatedRuntime", "verifyRuntime"), "PREVIEW_SMOKE_NODE_METHOD")
    script = "const m=require(process.argv[1]);const v=JSON.parse(process.argv[3]);const r=m[process.argv[2]](v);console.log(JSON.stringify(r));"
    completed = subprocess.run([str(ROOT / ".tools/node/bin/node"), "-e", script,
                                str(ROOT / "native-ui/preview-runtime.cjs"), method,
                                json.dumps(argument)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=300, check=False)
    need(completed.returncode == 0, "PREVIEW_SMOKE_RUNTIME:" + completed.stderr.decode("utf-8", "replace")[-3000:])
    return json.loads(completed.stdout)


def write_json(path, value):
    payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    need(len(payload) <= 256 * 1024, "PREVIEW_SMOKE_REPORT_TOO_LARGE")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(payload)
    return payload


def read_owned_bytes(path, maximum=256 * 1024, *, private=False):
    """Read bounded isolated evidence without following links or accepting races."""
    before = path.lstat()
    identity = lambda row: (row.st_dev, row.st_ino, row.st_mode, row.st_nlink, row.st_uid,
                             row.st_size, row.st_mtime_ns, row.st_ctime_ns)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1 and
         before.st_size <= maximum and (not private or stat.S_IMODE(before.st_mode) == 0o600),
         "PREVIEW_SMOKE_EVIDENCE_FILE")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        need(identity(os.fstat(stream.fileno())) == identity(before), "PREVIEW_SMOKE_EVIDENCE_CHANGED")
        payload = stream.read(maximum + 1)
        need(identity(os.fstat(stream.fileno())) == identity(before), "PREVIEW_SMOKE_EVIDENCE_CHANGED")
    need(len(payload) <= maximum and identity(path.lstat()) == identity(before), "PREVIEW_SMOKE_EVIDENCE_CHANGED")
    return payload


def inventory(root, *, copied=False):
    """Hash original/copy bytes separately; only originals exclude data/cache."""
    owned_directory(root)
    if copied:
        need(stat.S_IMODE(root.stat().st_mode) == 0o700 and
             sorted(child.name for child in root.iterdir()) == ["avatars", "data", "manifest.json"],
             "PREVIEW_SMOKE_SNAPSHOT_ROOT")
    files, directories, total, nodes = [], [], 0, 0

    def visit(path, relative, depth):
        nonlocal total, nodes
        nodes += 1
        need(nodes <= MAX_INVENTORY_ENTRIES and depth <= 64, "PREVIEW_SMOKE_INVENTORY_LIMIT")
        before = path.lstat()
        need(before.st_uid == os.getuid() and not stat.S_ISLNK(before.st_mode), "PREVIEW_SMOKE_INVENTORY_UNSAFE")
        if stat.S_ISDIR(before.st_mode):
            need(not copied or stat.S_IMODE(before.st_mode) == 0o700, "PREVIEW_SMOKE_SNAPSHOT_DIRECTORY_MODE")
            directories.append(relative)
            for child in sorted(path.iterdir()):
                child_relative = relative + "/" + child.name
                if not copied and child_relative == "data/cache":
                    continue
                visit(child, child_relative, depth + 1)
            after = path.lstat()
            need((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) ==
                 (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns), "PREVIEW_SMOKE_INVENTORY_CHANGED")
        else:
            need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                 (not copied or stat.S_IMODE(before.st_mode) == 0o600), "PREVIEW_SMOKE_INVENTORY_UNSAFE")
            total += before.st_size
            need(total <= MAX_INVENTORY_BYTES, "PREVIEW_SMOKE_INVENTORY_LIMIT")
            payload = read_owned_bytes(path, MAX_INVENTORY_BYTES, private=copied)
            need(len(payload) == before.st_size, "PREVIEW_SMOKE_INVENTORY_CHANGED")
            after = path.lstat()
            need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                 (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                 "PREVIEW_SMOKE_INVENTORY_CHANGED")
            files.append({"path": relative, "size": str(len(payload)), "sha256": hashlib.sha256(payload).hexdigest()})

    for name in ("data", "avatars"):
        visit(root / name, name, 0)
    return {"files": sorted(files, key=lambda row: row["path"]), "directories": sorted(directories), "totalBytes": str(total)}


def snapshot_names(workspace):
    root = workspace / "snapshots"
    if not root.exists() and not root.is_symlink():
        return []
    owned_directory(root)
    names = sorted(child.name for child in root.iterdir())
    need(len(names) <= 3 and all(re.fullmatch(r"snapshot-[A-Za-z0-9._-]{1,200}", name) for name in names),
         "PREVIEW_SMOKE_SNAPSHOT_NAMES")
    for name in names:
        owned_directory(root / name)
    return names


def read_ready_candidate(workspace):
    return json.loads(read_owned_bytes(workspace / "ready-candidate.json", 4096, private=True))


def previous_candidate(workspace, current):
    record = read_ready_candidate(workspace)
    need({key: record.get(key) for key in current} == current, "PREVIEW_SMOKE_READY_RECORD_NOT_CURRENT")
    previous = {"schema": "reverie.preview.ready-candidate.v1", "readyId": secrets.token_hex(16),
                "candidate": "smoke-previous-candidate", "sourceHead": "f" * 40, "buildManifestSha256": "e" * 64}
    need({key: previous[key] for key in current} != current, "PREVIEW_SMOKE_PREVIOUS_IS_CURRENT")
    temporary = workspace / (".smoke-ready-" + secrets.token_hex(16) + ".tmp")
    write_json(temporary, previous)
    try:
        need(read_ready_candidate(workspace) == record, "PREVIEW_SMOKE_READY_RECORD_CHANGED")
        os.replace(temporary, workspace / "ready-candidate.json")
    finally:
        if temporary.exists():
            temporary.unlink()
    return previous


def startup_events(workspace, host_pid):
    payload = read_owned_bytes(workspace / "preview-events.jsonl", 65536, private=True)
    rows = []
    for line in payload.splitlines():
        need(len(line) <= 1024, "PREVIEW_SMOKE_EVENT_LINE_LIMIT")
        value = json.loads(line)
        if value.get("hostPid") == host_pid:
            rows.append(value)
    need(1 <= len(rows) <= 128, "PREVIEW_SMOKE_EVENT_COUNT")
    return rows


def export_diagnostics(runtime, workspace, isolation):
    output = isolation / "preview-diagnostics.json"
    command = [str(ROOT / "script/preview-qt-macos.sh"), "diagnostics", "--runtime-root", runtime["runtimeRoot"],
               "--workspace", str(workspace), "--output", str(output)]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    need(completed.returncode == 0, "PREVIEW_SMOKE_DIAGNOSTICS_EXPORT_FAILED")
    payload = read_owned_bytes(output, private=True)
    need(bool(payload), "PREVIEW_SMOKE_DIAGNOSTICS_EMPTY")
    return {"exportJson": payload.decode("utf-8", "strict"), "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload), "outputMode": stat.S_IMODE(output.lstat().st_mode), "exportedNs": time.monotonic_ns()}


def host_cleanup(runtime, workspace, isolation, account, hosts):
    path = cleanup_context(isolation, workspace)
    checkpoint("host-keychain-cleanup-start")
    cleaner = Host(runtime, workspace, cleanup_file=path)
    hosts.append(cleaner)
    try:
        timeout = (cleaner.started + LIMITS["normalMs"] * 1_000_000 - time.monotonic_ns()) / 1e9
        need(timeout > 0, "PREVIEW_SMOKE_HOST_CLEANUP_TIMEOUT")
        try:
            code = cleaner.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("PREVIEW_SMOKE_HOST_CLEANUP_TIMEOUT") from error
        exited = time.monotonic_ns()
        cleaner.finish_threads()
        need(code == 0 and not cleaner.ready_events and not cleaner.descendants,
             "PREVIEW_SMOKE_HOST_CLEANUP_REJECTED:" + str(code))
        need(exited - cleaner.started <= LIMITS["normalMs"] * 1_000_000, "PREVIEW_SMOKE_HOST_CLEANUP_TIMEOUT")
        checkpoint("host-keychain-cleanup-complete")
        return {"hostPid": cleaner.pid, "startedNs": cleaner.started, "exitedNs": exited, "exitCode": code,
                "workspaceId": account, "services": [SERVICES["previewStorage"], SERVICES["previewCredentials"]],
                "backendPids": [], "readyEvents": []}
    finally:
        need(not cleaner.cleanup(), "PREVIEW_SMOKE_HOST_CLEANUP_PROCESSES_REMAIN")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview-workspace-smoke", action="store_true", required=True)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--isolation-root", required=True)
    parser.add_argument("--contract", choices=("v2", "v3", "v4"), default="v2")
    parser.add_argument("--previous-binding")
    args = parser.parse_args(argv)
    if args.contract == "v4":
        sys.path.insert(0, str(ROOT))
        from script.check_preview_upgrade import run
        return run(args)
    need(args.previous_binding is None, "PREVIEW_V4_PREVIOUS_REQUIRES_V4")
    isolation = isolation_root(args.isolation_root, os.environ)
    report = args.report_dir
    need(report.is_absolute() and owned_directory(report) and not any(report.iterdir()), "PREVIEW_SMOKE_FRESH_REPORT")
    workspace, runtime_path = isolation / "preview-workspace", isolation / "preview-runtime"
    need(not workspace.exists() and not workspace.is_symlink() and not runtime_path.exists()
         and not runtime_path.is_symlink(), "PREVIEW_SMOKE_FRESH_SCRATCH")
    account = hashlib.sha256(str(workspace).encode()).hexdigest()
    build = json.loads((args.build_dir / "build.json").read_bytes())
    result = {"schema": "reverie.preview-workspace.smoke." + args.contract, "contract": args.contract, "passed": False,
              "sourceHead": build["source"]["head"], "candidate": build.get("candidate") or "local-" + build["localIteration"]["package"],
              "buildManifestSha256": hashlib.sha256((args.build_dir / "build.json").read_bytes()).hexdigest(),
              "isolationRoot": str(isolation), "workspaceRelativePath": workspace.name,
              "runtimeRelativePath": runtime_path.name, "limits": dict(LIMITS), "checks": [],
              "observations": {}, "cleanup": {}}
    observed = result["observations"]
    hosts = []
    keychain = None
    own_account = False
    runtime_identity = workspace_identity = None
    error = None
    final_exit = None
    runtime = None
    initial = {name: None for name in SERVICES}
    try:
        checkpoint("initial-keychain-check")
        keychain = KeychainAttributes(account)
        initial = {name: keychain.read_attributes(service) for name, service in SERVICES.items()}
        need(all(value is None for value in initial.values()), "PREVIEW_SMOKE_ACCOUNT_ALREADY_EXISTS")
        own_account = True
        checkpoint("install-runtime-start")
        runtime = node_call("installIsolatedRuntime", {"projectRoot": str(ROOT), "buildDirectory": str(args.build_dir),
                             "destination": str(runtime_path), "isolationRoot": str(isolation)})
        checkpoint("install-runtime-complete")
        runtime_identity = owned_directory(runtime_path)
        need(runtime["runtimeRoot"] == str(runtime_path) and runtime["candidate"] == result["candidate"]
             and runtime["sourceHead"] == result["sourceHead"], "PREVIEW_SMOKE_INSTALL_BINDING")
        checkpoint("first-runtime-verify-start")
        node_call("verifyRuntime", str(runtime_path))
        checkpoint("first-host-start")
        first = Host(runtime, workspace); hosts.append(first)
        observed["firstStart"] = first.ready(runtime, account)
        checkpoint("first-host-ready")
        workspace_identity = owned_directory(workspace)
        first_item = keychain.read_attributes(SERVICES["previewStorage"])
        need(first_item is not None, "PREVIEW_SMOKE_KEY_NOT_CREATED")
        database = database_identity(workspace)
        observed["firstStart"].update(attributesBefore=initial, storageItem=first_item, database=database)
        result["checks"].append({"name": CHECKS[0][0], "observation": CHECKS[0][1], "passed": True})

        backend = observed["firstStart"]["ready"]["backendPid"]
        before_duplicate = process_table()
        need(backend in before_duplicate and before_duplicate[backend]["parent"] == first.pid,
             "PREVIEW_SMOKE_BACKEND_MISSING_BEFORE_DUPLICATE")
        backend_before = [backend]
        checkpoint("duplicate-host-start")
        duplicate = Host(runtime, workspace); hosts.append(duplicate)
        try:
            remaining_time = (duplicate.started + LIMITS["duplicateMs"] * 1_000_000 - time.monotonic_ns()) / 1e9
            need(remaining_time > 0, "PREVIEW_SMOKE_DUPLICATE_TIMEOUT")
            code = duplicate.process.wait(timeout=remaining_time)
        except subprocess.TimeoutExpired as caught:
            raise RuntimeError("PREVIEW_SMOKE_DUPLICATE_TIMEOUT") from caught
        duplicate_end = time.monotonic_ns()
        need(duplicate_end - duplicate.started <= LIMITS["duplicateMs"] * 1_000_000,
             "PREVIEW_SMOKE_DUPLICATE_TIMEOUT")
        duplicate.finish_threads()
        need(code == 66 and not duplicate.ready_events and not duplicate.descendants,
             "PREVIEW_SMOKE_DUPLICATE_STARTED")
        need(first.process.poll() is None and backend in process_table(), "PREVIEW_SMOKE_ORIGINAL_STOPPED")
        observed["secondInstance"] = {"hostPid": duplicate.pid, "startedNs": duplicate.started,
                                       "exitedNs": duplicate_end, "exitCode": code, "readyEvents": [],
                                       "backendPidsBefore": backend_before, "backendPidsAfter": [backend]}
        result["checks"].append({"name": CHECKS[1][0], "observation": CHECKS[1][1], "passed": True})

        checkpoint("normal-exit-start")
        observed["sigterm"] = first.exit(signal.SIGTERM)
        checkpoint("normal-exit-complete")
        observed["sigterm"]["lockReleased"] = lock_available(workspace / "workspace.lock")
        need(observed["sigterm"]["hostExitCode"] == 0 and observed["sigterm"]["lockReleased"], "PREVIEW_SMOKE_NORMAL_EXIT")
        result["checks"].append({"name": CHECKS[2][0], "observation": CHECKS[2][1], "passed": True})

        checkpoint("restart-runtime-verify-start")
        node_call("verifyRuntime", str(runtime_path))
        checkpoint("restart-host-start")
        restart = Host(runtime, workspace); hosts.append(restart)
        observed["restart"] = restart.ready(runtime, account)
        checkpoint("restart-host-ready")
        restored_item = keychain.read_attributes(SERVICES["previewStorage"])
        need(restored_item == first_item, "PREVIEW_SMOKE_KEY_ATTRIBUTES_CHANGED")
        need(database_identity(workspace) == database, "PREVIEW_SMOKE_DATABASE_CHANGED")
        observed["restart"].update(storageItem=restored_item, database=database_identity(workspace))
        result["checks"].append({"name": CHECKS[3][0], "observation": CHECKS[3][1], "passed": True})

        checkpoint("forced-exit-start")
        observed["forcedExit"] = restart.exit(signal.SIGKILL)
        checkpoint("forced-exit-complete")
        need(observed["forcedExit"]["hostExitCode"] == -signal.SIGKILL, "PREVIEW_SMOKE_FORCED_EXIT_CODE")
        need((workspace / "workspace.lock").is_file(), "PREVIEW_SMOKE_NO_STALE_LOCK")
        checkpoint("recovery-runtime-verify-start")
        node_call("verifyRuntime", str(runtime_path))
        checkpoint("recovery-host-start")
        recovery = Host(runtime, workspace); hosts.append(recovery)
        resumed = recovery.ready(runtime, account)
        checkpoint("recovery-host-ready")
        lock_text = (workspace / "workspace.lock").read_text()
        need(lock_text.strip() == str(recovery.pid), "PREVIEW_SMOKE_LOCK_NOT_REACQUIRED")
        recovered_item = keychain.read_attributes(SERVICES["previewStorage"])
        need(recovered_item == first_item, "PREVIEW_SMOKE_RECOVERY_KEY_ATTRIBUTES_CHANGED")
        need(database_identity(workspace) == database, "PREVIEW_SMOKE_RECOVERY_DATABASE_CHANGED")
        resumed.update(staleLockObserved=True, lockRecovered=True, storageItem=recovered_item, database=database_identity(workspace))
        observed["forcedExit"]["recovery"] = resumed
        result["checks"].append({"name": CHECKS[4][0], "observation": CHECKS[4][1], "passed": True})
        checkpoint("final-normal-exit-start")
        final_exit = recovery.exit(signal.SIGTERM)
        checkpoint("final-normal-exit-complete")
        need(final_exit["hostExitCode"] == 0, "PREVIEW_SMOKE_FINAL_EXIT")
        if args.contract == "v3":
            # The producer runs with -I; add only this explicit trusted project
            # root to reuse the saved-only validators for the new observations.
            sys.path.insert(0, str(ROOT))
            from script.registered_run import preview_v3
            current = {"candidate": result["candidate"], "sourceHead": result["sourceHead"],
                       "buildManifestSha256": result["buildManifestSha256"]}
            checkpoint("version-snapshot-prepare")
            names_before = snapshot_names(workspace)
            need(names_before == [], "PREVIEW_SMOKE_UNEXPECTED_INITIAL_SNAPSHOT")
            previous = previous_candidate(workspace, current)
            before = inventory(workspace)
            prepared_ns = time.monotonic_ns()
            checkpoint("version-snapshot-runtime-verify-start")
            node_call("verifyRuntime", str(runtime_path))
            checkpoint("version-snapshot-host-start")
            changed = Host(runtime, workspace); hosts.append(changed)
            changed_start = changed.ready(runtime, account)
            changed_start.update(storageItem=keychain.read_attributes(SERVICES["previewStorage"]),
                                 database=database_identity(workspace))
            need(changed_start["storageItem"] == first_item and changed_start["database"] == database,
                 "PREVIEW_SMOKE_VERSION_SNAPSHOT_STORAGE_CHANGED")
            names = snapshot_names(workspace)
            need(len(names) == 1, "PREVIEW_SMOKE_VERSION_SNAPSHOT_NOT_CREATED")
            snapshot_root = workspace / "snapshots" / names[0]
            manifest_bytes = read_owned_bytes(snapshot_root / "manifest.json", private=True)
            snapshot_value = {"name": names[0], "manifestJson": manifest_bytes.decode("utf-8", "strict"),
                              "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
                              "copiedInventory": inventory(snapshot_root, copied=True)}
            need(preview_v3.inventory(before) == preview_v3.snapshot(snapshot_value, previous, current),
                 "PREVIEW_SMOKE_PRELAUNCH_SNAPSHOT_MISMATCH")
            current_record = read_ready_candidate(workspace)
            need(preview_v3.ready_candidate(current_record) == current, "PREVIEW_SMOKE_CANDIDATE_NOT_RECORDED")
            events = startup_events(workspace, changed.pid)
            preview_v3.verify_startup_events(events, changed_start)
            recovery_exit = final_exit
            checkpoint("version-snapshot-host-normal-exit")
            changed_exit = changed.exit(signal.SIGTERM)
            need(changed_exit["hostExitCode"] == 0, "PREVIEW_SMOKE_VERSION_SNAPSHOT_EXIT")
            checkpoint("same-candidate-runtime-verify-start")
            node_call("verifyRuntime", str(runtime_path))
            checkpoint("same-candidate-host-start")
            same = Host(runtime, workspace); hosts.append(same)
            same_start = same.ready(runtime, account)
            same_start.update(storageItem=keychain.read_attributes(SERVICES["previewStorage"]),
                              database=database_identity(workspace))
            need(same_start["storageItem"] == first_item and same_start["database"] == database,
                 "PREVIEW_SMOKE_SAME_CANDIDATE_STORAGE_CHANGED")
            same_names = snapshot_names(workspace)
            same_record = read_ready_candidate(workspace)
            need(same_names == names and same_record == current_record,
                 "PREVIEW_SMOKE_SAME_CANDIDATE_CHANGED_SNAPSHOT_OR_RECORD")
            observed["versionSnapshot"] = {"previousReady": previous, "beforeInventory": before, "preparedNs": prepared_ns,
                "snapshotNamesBefore": names_before, "start": changed_start, "snapshot": snapshot_value,
                "readyRecord": current_record, "startupEvents": events, "recoveryExit": recovery_exit,
                "sameCandidate": same_start, "snapshotNamesAfterSame": same_names, "sameReadyRecord": same_record,
                "changedExit": changed_exit}
            result["checks"].append({"name": SCOPE_CHECKS[5][0], "observation": SCOPE_CHECKS[5][1], "passed": True})
            checkpoint("diagnostics-export-while-running-start")
            need(same.process.poll() is None, "PREVIEW_SMOKE_SAME_HOST_NOT_RUNNING")
            observed["diagnostics"] = export_diagnostics(runtime, workspace, isolation)
            need(same.process.poll() is None, "PREVIEW_SMOKE_HOST_EXIT_DURING_DIAGNOSTICS")
            preview_v3.diagnostics_document(json.loads(observed["diagnostics"]["exportJson"]), current, snapshot_value)
            result["checks"].append({"name": SCOPE_CHECKS[6][0], "observation": SCOPE_CHECKS[6][1], "passed": True})
            checkpoint("same-candidate-final-normal-exit-start")
            final_exit = same.exit(signal.SIGTERM)
            observed["versionSnapshot"]["finalExit"] = final_exit
            need(final_exit["hostExitCode"] == 0, "PREVIEW_SMOKE_FINAL_EXIT")
            checkpoint("same-candidate-final-normal-exit-complete")
    except Exception as caught:
        error = str(caught) or type(caught).__name__
    finally:
        checkpoint("cleanup-start")
        cleanup_errors = []
        remaining = []
        for host in hosts:
            try:
                remaining += host.cleanup()
            except Exception as caught:
                cleanup_errors.append(str(caught))
        if workspace_identity is None:
            workspace_identity = next((h.workspace_identity for h in hosts if h.workspace_identity is not None), None)
        cleanup = {"account": account, "attributesAfter": {name: {"unconfirmed": True} for name in SERVICES},
                   "hostCleanup": None, "workspaceRemoved": False, "runtimeRemoved": False,
                   "remainingPids": sorted(set(remaining)), "finalHostPid": final_exit["hostPid"] if final_exit else None,
                   "finalHostExitCode": final_exit["hostExitCode"] if final_exit else None,
                   "finalHostExitedNs": final_exit["hostExitedNs"] if final_exit else None,
                   "finalAllGoneNs": final_exit["allGoneNs"] if final_exit else None}
        processes_confirmed_gone = not remaining and not cleanup_errors
        if processes_confirmed_gone and own_account and keychain and runtime and workspace_identity is not None:
            try:
                need(owned_directory(workspace) == workspace_identity, "PREVIEW_SMOKE_CLEANUP_IDENTITY")
                cleanup["hostCleanup"] = host_cleanup(runtime, workspace, isolation, account, hosts)
                cleanup["attributesAfter"] = {name: keychain.read_attributes(service) for name, service in SERVICES.items()}
            except Exception as caught:
                cleanup_errors.append(str(caught))
                processes_confirmed_gone = False
        for path, identity, field in ((workspace, workspace_identity, "workspaceRemoved"),
                                      (runtime_path, runtime_identity, "runtimeRemoved")):
            try:
                need(processes_confirmed_gone, "PREVIEW_SMOKE_LIVE_PROCESS_CLEANUP_REFUSED")
                if path.exists():
                    need(identity is not None and owned_directory(path) == identity, "PREVIEW_SMOKE_CLEANUP_IDENTITY")
                    shutil.rmtree(path)
                cleanup[field] = not path.exists()
            except Exception as caught:
                cleanup_errors.append(str(caught))
        result["cleanup"] = cleanup
        if remaining or cleanup_errors:
            error = error or "PREVIEW_SMOKE_CLEANUP:" + repr(cleanup_errors or remaining)
        if any(value is not None for value in cleanup["attributesAfter"].values()) or cleanup["hostCleanup"] is None or not all(
                cleanup[k] is True for k in ("workspaceRemoved", "runtimeRemoved")):
            error = error or "PREVIEW_SMOKE_CLEANUP_UNCONFIRMED"
        result["passed"] = error is None
        if error:
            result["error"] = error
        checkpoint("cleanup-complete-report-start")
        raw = {k: v for k, v in result.items() if k not in ("schema", "contract", "passed", "checks", "error")}
        raw["schema"] = "reverie.preview-workspace.observations." + args.contract
        raw_bytes = write_json(report / "observations.json", raw)
        result["observationBinding"] = {"path": "observations.json", "bytes": len(raw_bytes),
                                        "sha256": hashlib.sha256(raw_bytes).hexdigest()}
        write_json(report / "summary.json", result)
        if error:
            write_json(report / "failure-diagnostics.json", {"error": error,
                       "hosts": [{"pid": h.pid, "tail": list(h.tail), "observerErrors": h.errors} for h in hosts]})
    print(json.dumps({"reportRoot": str(report), "passed": result["passed"], "error": error}, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
