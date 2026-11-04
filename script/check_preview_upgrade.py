"""Disposable v4 producer. The old installed host is never launched or changed."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import threading
import time

from script import check_preview_workspace as smoke
from script.registered_run import preview_v4 as contract
from script.registered_run import preview_memory_seed as memory_contract
from script.registered_run import preview_v4_files as files

_unconfirmed_commands = set()


def context(isolation, workspace, name, upgrade=None, *, identity=None, public_sha=None):
    value = {"schema": "reverie.qt.isolation.v1", "purpose": "reverie.qt.preview-test-cleanup.v1",
             "root": smoke.directory_record(isolation), "data": smoke.directory_record(isolation / "data"),
             "previewWorkspace": smoke.directory_record(workspace)}
    if upgrade is not None:
        value["previewUpgrade"] = upgrade
        value["previewUpgradeIdentity"] = identity
        value["previewUpgradePublicResultSha256"] = public_sha
    path = isolation / ("preview-upgrade-context-" + name + ".json")
    smoke.write_json(path, value)
    return path


def owned_command(command, *, cwd, timeout, environment=None):
    """Bounded owner observation, including short-lived descendants and teardown."""
    started = time.monotonic_ns()
    process = subprocess.Popen(command, cwd=cwd, env=environment or dict(os.environ), stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    known = {}
    root_identity = None
    output = error = b""
    failure = None
    try:
        while True:
            table = smoke.process_table()
            if root_identity is None and process.pid in table:
                root_identity = table[process.pid]["identity"]
            roots = {process.pid} if process.pid in table and table[process.pid]["identity"] == root_identity else set()
            smoke.update_descendants(table, roots, known)
            try:
                output, error = process.communicate(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic_ns() - started > timeout * 1_000_000_000:
                    raise RuntimeError("PREVIEW_V4_COMMAND_TIMEOUT")
        exited = time.monotonic_ns()
        deadline = exited + 10_000_000_000
        while time.monotonic_ns() < deadline:
            table = smoke.process_table()
            smoke.update_descendants(table, set(), known)
            remaining = smoke.remaining_processes(table, known)
            if not remaining:
                break
            time.sleep(0.02)
        smoke.need(not remaining, "PREVIEW_V4_COMMAND_DESCENDANTS_REMAIN")
        smoke.need(len(output) <= 256 * 1024 and len(error) <= 256 * 1024, "PREVIEW_V4_COMMAND_OUTPUT_LIMIT")
        return {"hostPid": process.pid, "startedNs": started, "exitedNs": exited, "exitCode": process.returncode,
                "stdout": output.decode("utf-8", "replace"), "stderr": error.decode("utf-8", "replace"),
                "remainingPids": [], "descendantPids": sorted(known),
                "descendantExecutables": sorted({identity[1] for identity in known.values()})}
    except Exception as caught:
        failure = caught
        raise
    finally:
        if failure is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)
            # Identity-check every PID before a bounded emergency teardown.
            table = smoke.process_table()
            smoke.update_descendants(table, set(), known)
            for pid in smoke.remaining_processes(table, known):
                if pid in table and table[pid]["identity"] == known[pid]:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 5
            while smoke.remaining_processes(smoke.process_table(), known) and time.monotonic() < deadline:
                time.sleep(0.05)
            table = smoke.process_table()
            for pid in smoke.remaining_processes(table, known):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 5
            while smoke.remaining_processes(smoke.process_table(), known) and time.monotonic() < deadline:
                time.sleep(0.05)
            if smoke.remaining_processes(smoke.process_table(), known):
                _unconfirmed_commands.add(process.pid)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()


def native(runtime, backend, isolation, workspace, action, *, identity, public_sha, endpoint=None, model=None, label=None):
    label = label or action
    output = isolation / ("preview-upgrade-" + label + ".json")
    args = {"--backend-root": backend["runtimeRoot"], "--backend-python": backend["python"],
            "--upgrade-action": action, "--upgrade-report": str(output)}
    if action == "seed":
        args.update({"--upgrade-endpoint": endpoint, "--upgrade-model": str(model)})
    file = context(isolation, workspace, label, args, identity=identity, public_sha=public_sha)
    command = [runtime["hostExecutable"], "--preview-upgrade-check", "--context", str(file),
               "--data-dir", str(isolation / "data")]
    for key, value in args.items():
        command.extend((key, value))
    execution = owned_command(command, cwd=runtime["runtimeRoot"], timeout=240)
    smoke.need(execution["exitCode"] == 0, "PREVIEW_V4_NATIVE_FAILED:" + execution["stderr"][-1000:])
    payload = smoke.read_owned_bytes(output, private=True)
    return {key: execution[key] for key in ("hostPid", "startedNs", "exitedNs", "exitCode", "remainingPids", "descendantPids")} | {
        "json": payload.decode(), "bytes": len(payload), "sha256": contract.sha(payload)}


def saved_snapshot(workspace, name):
    directory = workspace / "snapshots" / name
    payload = smoke.read_owned_bytes(directory / "manifest.json", private=True)
    return {"name": name, "manifestJson": payload.decode(), "manifestSha256": contract.sha(payload),
            "copiedInventory": smoke.inventory(directory, copied=True)}


def refusal_inventory(workspace):
    """All workspace bytes, with only the two explicitly permitted exceptions."""
    files, directories, total = [], [], 0
    for path in sorted(workspace.rglob("*")):
        relative = path.relative_to(workspace).as_posix()
        if relative in ("workspace.lock", "preview-events.jsonl"):
            continue
        info = path.lstat()
        smoke.need(info.st_uid == os.getuid() and not stat.S_ISLNK(info.st_mode), "PREVIEW_V4_FORMAT_INVENTORY_UNSAFE")
        if stat.S_ISDIR(info.st_mode):
            directories.append(relative)
        else:
            payload = smoke.read_owned_bytes(path, smoke.MAX_INVENTORY_BYTES)
            files.append({"path": relative, "size": str(len(payload)), "sha256": contract.sha(payload)})
            total += len(payload)
        smoke.need(len(files) + len(directories) <= 50000 and total <= smoke.MAX_INVENTORY_BYTES, "PREVIEW_V4_FORMAT_INVENTORY_LIMIT")
    return {"files": files, "directories": directories, "totalBytes": str(total)}


def captured_memory_requests(mock, report):
    """Called while the mock lock is held; no hidden/dropped HTTP records."""
    chats = report["seedProof"]["memory"]["chats"]
    probe_count = sum(row["probe"] for row in mock.rows)
    return {"rows": list(mock.rows), "chatRequestIds": [report["seedProof"]["chat"]["requestId"]], "unknownCount": mock.unknown_count,
            "memoryRows": list(mock.memory_rows), "memoryBindings": [
                {"requestId": chat["requestId"], "userMessageId": chat["user"]["id"], "modelRequests": 1} for chat in chats],
            "httpOrder": list(mock.http_order), "connectionProbe": {"requestCount": probe_count,
                "condition": "provider-test-issued-probe" if probe_count else "no-provider-test-command"}}


class Mock:
    def __init__(self):
        self.requests = 0
        self.unknown_count = 0
        self.rows = []
        self.memory_rows = []
        self.http_order = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def unsupported(self):
                with owner.lock:
                    owner.unknown_count += 1
                self.send_error(501, "Unsupported method")

            do_GET = do_HEAD = do_OPTIONS = do_PUT = do_DELETE = do_PATCH = unsupported

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    self.send_error(400); return
                raw = self.rfile.read(length)
                body = json.loads(raw)
                if not isinstance(body, dict):
                    self.send_error(400); return
                reply = contract.mock_response_bytes()
                users = [message.get("content") for message in body.get("messages", [])
                         if isinstance(message, dict) and message.get("role") == "user"]
                user = users[-1] if users and isinstance(users[-1], str) else ""
                model = str(body.get("model") or "")
                with owner.lock:
                    owner.requests += 1
                    memory_index = memory_contract.INPUTS.index(user) if user in memory_contract.INPUTS and model == contract.MODEL else None
                    rows = owner.memory_rows if memory_index is not None else owner.rows
                    row = {"sequence": len(rows) + 1, "chat": (user == contract.USER_MARKER or memory_index is not None) and model == contract.MODEL,
                        "probe": user == contract.PROBE_PROMPT and model == contract.MODEL,
                        "requestSha256": contract.sha(raw), "requestBytes": len(raw), "responseSha256": contract.sha(reply), "responseBytes": len(reply),
                        "userSha256": contract.sha(user.encode()), "userBytes": len(user.encode()), "modelSha256": contract.sha(model.encode()),
                        "responseTextSha256": contract.sha(contract.ASSISTANT_MARKER.encode()), "responseTextBytes": len(contract.ASSISTANT_MARKER.encode()),
                        "statusCode": 200}
                    rows.append(row)
                    owner.http_order.append({"sequence": owner.requests, "kind": "memory" if memory_index is not None else "probe" if row["probe"] else "chat", "index": row["sequence"]})
                self.send_response(200); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply))); self.end_headers(); self.wfile.write(reply)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = "http://127.0.0.1:" + str(self.server.server_port) + "/v1"

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=5)
        smoke.need(not self.thread.is_alive(), "PREVIEW_V4_MOCK_REMAINS")


def cleanup_keys(runtime, workspace, isolation, account):
    file = context(isolation, workspace, "cleanup")
    result = owned_command([runtime["hostExecutable"], "--remove-preview-test-key", "--context", str(file),
                            "--data-dir", str(isolation / "data")], cwd=runtime["runtimeRoot"], timeout=10)
    smoke.need(result["exitCode"] == 0 and "REVERIE_PREVIEW_READY" not in result["stdout"], "PREVIEW_V4_KEY_CLEANUP_FAILED")
    return {"hostPid": result["hostPid"], "exitCode": result["exitCode"], "workspaceId": account, "startedNs": result["startedNs"], "exitedNs": result["exitedNs"],
            "services": [smoke.SERVICES["previewStorage"], smoke.SERVICES["previewCredentials"]], "backendPids": [], "readyEvents": []}


def _run(args, progress):
    smoke.need(args.previous_binding is not None, "PREVIEW_V4_PREVIOUS_BINDING_REQUIRED")
    binding = json.loads(args.previous_binding)
    contract.previous_binding(binding)
    smoke.need(contract.bind_previous(smoke.ROOT, binding["model"]) == binding, "PREVIEW_V4_PREVIOUS_INPUT_CHANGED")
    isolation = smoke.isolation_root(args.isolation_root, os.environ)
    report = args.report_dir
    smoke.need(report.is_absolute() and smoke.owned_directory(report) and not any(report.iterdir()), "PREVIEW_V4_FRESH_REPORT")
    # Freeze raw old-version inputs into the report. Replay reads only these copies.
    for role, filename in contract.INPUT_COPIES.items():
        payload = smoke.read_owned_bytes(smoke.ROOT / binding[role]["path"], 32 * 1024 * 1024)
        smoke.need(len(payload) == binding[role]["bytes"] and contract.sha(payload) == binding[role]["sha256"], "PREVIEW_V4_PREVIOUS_INPUT_CHANGED")
        descriptor = os.open(report / filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
    progress["lifecycle"] = "started"
    lifecycle_dir = report / "lifecycle"
    lifecycle_dir.mkdir(mode=0o700)
    # The registered stage advertises exactly its outer report root. The nested
    # original lifecycle report remains on disk with its unmodified raw proof.
    with redirect_stdout(io.StringIO()):
        lifecycle_code = smoke.main(["--preview-workspace-smoke", "--build-dir", str(args.build_dir), "--report-dir", str(lifecycle_dir),
                                     "--isolation-root", str(isolation), "--contract", "v2"])
    smoke.need(lifecycle_code == 0, "PREVIEW_V4_LIFECYCLE_FAILED")
    progress["lifecycle"] = "complete"
    lifecycle = json.loads(smoke.read_owned_bytes(lifecycle_dir / "summary.json"))
    workspace, runtime_path = isolation / "preview-workspace", isolation / "preview-runtime"
    smoke.need(not workspace.exists() and not runtime_path.exists(), "PREVIEW_V4_LIFECYCLE_NOT_CLEAN")
    build_bytes = smoke.read_owned_bytes(args.build_dir / "build.json")
    build = json.loads(build_bytes)
    current = {"sourceHead": build["source"]["head"], "candidate": build.get("candidate") or "local-" + build["localIteration"]["package"],
               "buildManifestSha256": contract.sha(build_bytes)}
    result = {"schema": "reverie.preview-workspace.smoke.v4", "contract": "v4", "passed": False, "checks": [],
              **current, "isolationRoot": str(isolation), "workspaceRelativePath": "preview-workspace", "runtimeRelativePath": "preview-runtime",
              "limits": dict(smoke.LIMITS), "observations": {"lifecycle": lifecycle, "previousBefore": binding}, "cleanup": {}}
    obs = result["observations"]
    account = hashlib.sha256(str(workspace).encode()).hexdigest()
    keychain = smoke.KeychainAttributes(account)
    runtime = None; workspace_identity = runtime_identity = None; mock = None; hosts = []
    attributes_before = None; own_account = False; error = None
    try:
        attributes_before = {name: keychain.read_attributes(service) for name, service in smoke.SERVICES.items()}
        smoke.need(all(value is None for value in attributes_before.values()), "PREVIEW_V4_ACCOUNT_ALREADY_EXISTS")
        own_account = True
        previous = smoke.node_call("verifyRuntime", str(smoke.ROOT / binding["runtimeRoot"]))
        runtime = smoke.node_call("installIsolatedRuntime", {"projectRoot": str(smoke.ROOT), "buildDirectory": str(args.build_dir),
                                  "destination": str(runtime_path), "isolationRoot": str(isolation)})
        runtime_identity = smoke.owned_directory(runtime_path)
        workspace.mkdir(mode=0o700); workspace_identity = smoke.owned_directory(workspace)
        for name in ("data", "avatars"):
            (workspace / name).mkdir(mode=0o700)
        descriptor = os.open(workspace / "workspace.lock", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600); os.close(descriptor)
        mock = Mock()
        old_identity = {key: binding[key] for key in ("candidate", "sourceHead", "buildManifestSha256")}
        progress["seed"] = "started"
        obs["seed"] = native(runtime, previous, isolation, workspace, "seed", identity=old_identity, public_sha=binding["evidence"]["sha256"], endpoint=mock.endpoint,
                             model=smoke.ROOT / binding["model"])
        progress["seed"] = "complete"
        seed_report = json.loads(obs["seed"]["json"])
        smoke.need(seed_report.get("schema") == "reverie.preview.upgrade-host.v2", "PREVIEW_MEMORY_PRODUCT_REPORT_REQUIRED")
        progress["modelRequests"] = "started"
        with mock.lock:
            obs["modelRequests"] = captured_memory_requests(mock, seed_report)
        memory_contract.model_requests(obs["modelRequests"], seed_report)
        progress["modelRequests"] = "complete"
        progress["upgrade"] = "started"
        # New host published all user data through old production interfaces. The
        # runner now records that old data baseline; this is not an old host ready.
        baseline = {"schema": "reverie.preview.ready-candidate.v1", "readyId": os.urandom(16).hex(),
                    **{key: binding[key] for key in ("candidate", "sourceHead", "buildManifestSha256")}}
        smoke.write_json(workspace / "ready-candidate.json", baseline)
        before = smoke.inventory(workspace)
        host = smoke.Host(runtime, workspace); hosts.append(host)
        start = host.ready(runtime, account)
        names = smoke.snapshot_names(workspace)
        smoke.need(len(names) == 1, "PREVIEW_V4_UPGRADE_SNAPSHOT_COUNT")
        snapshot = saved_snapshot(workspace, names[0])
        events = smoke.startup_events(workspace, host.pid)
        obs["diagnostics"] = smoke.export_diagnostics(runtime, workspace, isolation)
        progress["diagnostics"] = "complete"
        exit = host.exit(signal.SIGTERM)
        obs["upgrade"] = {"baselineReady": baseline, "beforeInventory": before, "start": start, "startupEvents": events, "snapshot": snapshot,
                          "readyRecord": smoke.read_ready_candidate(workspace), "exit": exit,
                          "readback": native(runtime, runtime, isolation, workspace, "read", identity=current, public_sha=binding["evidence"]["sha256"], label="upgraded")}
        progress["upgrade"] = "complete"
        progress["restore"] = "started"
        restore_before = smoke.inventory(workspace)
        restored = owned_command([str(smoke.ROOT / "script/preview-qt-macos.sh"), "restore", "--snapshot", names[0],
                                  "--runtime-root", runtime["runtimeRoot"], "--workspace", str(workspace)], cwd=str(smoke.ROOT), timeout=30)
        smoke.need(restored["exitCode"] == 0, "PREVIEW_V4_RESTORE_FAILED:" + restored["stderr"][-1000:])
        lines = restored["stdout"].splitlines()
        receipts = [json.loads(line) for line in lines if line.startswith('{')]
        receipt = next((row for row in receipts if row.get("schema") == "reverie.preview.restore-result.v1"), None)
        smoke.need(receipt is not None, "PREVIEW_V4_RESTORE_RECEIPT_MISSING")
        obs["restore"] = {key: restored[key] for key in ("exitCode", "startedNs", "exitedNs")} | {
            "beforeInventory": restore_before, "afterInventory": smoke.inventory(workspace),
            "preSnapshot": saved_snapshot(workspace, receipt["preRestoreSnapshot"]),
            "readyRecord": smoke.read_ready_candidate(workspace), "result": receipt}
        progress["restore"] = "complete"
        progress["rollback"] = "started"
        obs["rollback"] = native(runtime, previous, isolation, workspace, "read", identity=old_identity, public_sha=binding["evidence"]["sha256"], label="rollback")
        progress["rollback"] = "complete"
        progress["formatProtection"] = "started"
        format_path = workspace / "data/preview-data-format.json"
        original_format = smoke.read_owned_bytes(format_path, private=True) if format_path.exists() else None
        if original_format is not None:
            format_path.unlink()
        smoke.write_json(format_path, {"schema": "reverie.preview.data-format.v1", "formatVersion": 2})
        format_record_json = smoke.read_owned_bytes(format_path, private=True).decode()
        obs["formatProtection"] = {}
        commands = {
            "launcher": [str(smoke.ROOT / "script/preview-qt-macos.sh"), "start", "--runtime-root", previous["runtimeRoot"], "--workspace", str(workspace)],
            "host": [runtime["hostExecutable"], "--workspace", str(workspace), "--project-root", runtime["runtimeRoot"], "--python", runtime["python"]]}
        for role, command in commands.items():
            before_format = refusal_inventory(workspace)
            refused = owned_command(command, cwd=str(smoke.ROOT), timeout=10)
            obs["formatProtection"][role] = {key: refused[key] for key in ("exitCode", "stdout", "stderr", "startedNs", "exitedNs", "descendantPids", "descendantExecutables")} | {
                "beforeInventory": before_format, "afterInventory": refusal_inventory(workspace), "formatRecordJson": format_record_json}
            smoke.need(refused["exitCode"] != 0 and "PREVIEW_DATA_FORMAT_TOO_NEW" in refused["stderr"], "PREVIEW_V4_FORMAT_NOT_REFUSED")
        format_path.unlink()
        if original_format is not None:
            descriptor = os.open(format_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(original_format)
        progress["formatProtection"] = "complete"
        smoke.node_call("verifyRuntime", previous["runtimeRoot"])
        obs["previousAfter"] = contract.bind_previous(smoke.ROOT, binding["model"])
        smoke.need(obs["previousAfter"] == binding, "PREVIEW_V4_OLD_INSTALL_CHANGED")
        with mock.lock:
            smoke.need(captured_memory_requests(mock, seed_report) == obs["modelRequests"], "PREVIEW_V4_LATE_OR_EXTRA_MODEL_REQUEST")
    except Exception as caught:
        error = str(caught)
    finally:
        progress["cleanup"] = "started"
        remaining = []; cleanup_errors = []
        for host in hosts:
            try:
                remaining += host.cleanup()
            except Exception as caught:
                cleanup_errors.append(str(caught))
        cleanup = {"account": account, "attributesBefore": attributes_before, "attributesAfter": {}, "hostCleanup": None,
                   "remainingPids": sorted(set(remaining)), "workspaceRemoved": False, "runtimeRemoved": False}
        if mock:
            try:
                mock.close()
                with mock.lock:
                    smoke.need("modelRequests" not in obs or (captured_memory_requests(mock, seed_report) == obs["modelRequests"] and mock.unknown_count == 0),
                               "PREVIEW_V4_LATE_OR_EXTRA_MODEL_REQUEST")
            except Exception as caught:
                cleanup_errors.append(str(caught))
        if not remaining and not cleanup_errors and not _unconfirmed_commands and own_account and runtime and workspace_identity:
            try:
                smoke.need(smoke.owned_directory(workspace) == workspace_identity, "PREVIEW_V4_CLEANUP_WORKSPACE_IDENTITY")
                cleanup["hostCleanup"] = cleanup_keys(runtime, workspace, isolation, account)
                cleanup["attributesAfter"] = {name: keychain.read_attributes(service) for name, service in smoke.SERVICES.items()}
            except Exception as caught:
                cleanup_errors.append(str(caught))
        # Key cleanup must be confirmed before deleting the evidence-bearing
        # scratch. Never remove the old installed runtime, including on failure.
        if not remaining and not cleanup_errors and cleanup["hostCleanup"] is not None and all(value is None for value in cleanup["attributesAfter"].values()):
            for path, identity, role in ((workspace, workspace_identity, "workspaceRemoved"), (runtime_path, runtime_identity, "runtimeRemoved")):
                try:
                    smoke.need(smoke.owned_directory(path) == identity, "PREVIEW_V4_CLEANUP_IDENTITY")
                    shutil.rmtree(path); cleanup[role] = not path.exists()
                except Exception as caught:
                    cleanup_errors.append(str(caught))
        result["cleanup"] = cleanup
        if remaining or cleanup_errors or not all(cleanup[role] for role in ("workspaceRemoved", "runtimeRemoved")):
            error = error or "PREVIEW_V4_CLEANUP_UNCONFIRMED:" + repr(cleanup_errors or remaining)
        result["passed"] = error is None
        if error:
            result["error"] = error
        result["checks"] = [{"name": name, "observation": observation, "passed": True} for name, observation in contract.CHECKS] if not error else []
        progress["cleanup"] = "complete" if not remaining and not cleanup_errors and all(cleanup[role] for role in ("workspaceRemoved", "runtimeRemoved")) else "failed"
        result = files.write_current_bundle(report, result, progress, write_json=smoke.write_json)
        error = result.get("error")
    print(json.dumps({"reportRoot": str(report), "passed": result["passed"], "error": error}))
    return 0 if result["passed"] else 1


def run(args):
    progress = {}
    try:
        return _run(args, progress)
    except Exception as caught:
        # Only an owned, already-created report directory may receive a record.
        # Early lifecycle/input failures have no fabricated cleanup proof.
        try:
            directory = args.report_dir
            if directory.is_absolute() and smoke.owned_directory(directory) and not (directory / files.RESULT).exists():
                files.failure_record(directory, caught, progress)
        except Exception as record_error:
            print(json.dumps({"firstErrorCode": files.error_code(caught), "recordErrorCode": files.error_code(record_error)}))
        print(json.dumps({"reportRoot": str(args.report_dir), "passed": False, "error": str(caught)}))
        return 1
