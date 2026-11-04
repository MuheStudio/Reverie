"""Bounded isolated preview producer helpers; no real workspace or keychain use."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading

import pytest

from script import check_preview_workspace as smoke


def scratch(tmp_path):
    root = tmp_path.resolve() / "reverie-local-fixture"
    root.mkdir(mode=0o700)
    return root, {"REVERIE_DATA_DIR": str(root / "data"), "TMPDIR": str(root / "tmp") + "/"}


def test_preview_smoke_isolation_accepts_only_bound_owned_scratch(tmp_path):
    root, env = scratch(tmp_path)
    assert smoke.isolation_root(str(root), env) == root


@pytest.mark.parametrize("change", ["missing-data", "relative", "wrong-root", "wrong-tmp"])
def test_preview_smoke_rejects_binding_before_filesystem_probe(tmp_path, monkeypatch, change):
    root, env = scratch(tmp_path)
    value = str(root)
    if change == "missing-data":
        env.pop("REVERIE_DATA_DIR")
    elif change == "relative":
        value = "reverie-local-relative"
    elif change == "wrong-root":
        value = str(root.parent / "reverie-local-unrelated")
    else:
        env["TMPDIR"] = str(root.parent)
    monkeypatch.setattr(smoke, "owned_directory", lambda _: pytest.fail("must reject before probing"))
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_(RUNNER_REQUIRED|ISOLATION_BINDING|TMP_BINDING)"):
        smoke.isolation_root(value, env)


def test_preview_smoke_rejects_permissive_scratch(tmp_path):
    root, env = scratch(tmp_path)
    root.chmod(0o755)
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_ISOLATION_MODE"):
        smoke.isolation_root(str(root), env)


def test_preview_smoke_rejects_symlink_scratch(tmp_path):
    target, _ = scratch(tmp_path)
    alias = tmp_path.resolve() / "reverie-local-alias"
    alias.symlink_to(target, target_is_directory=True)
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_DIRECTORY_OWNER"):
        smoke.isolation_root(str(alias), {"REVERIE_DATA_DIR": str(alias / "data"), "TMPDIR": str(alias / "tmp")})


def test_preview_smoke_database_identity_has_no_contents(tmp_path):
    root, _ = scratch(tmp_path)
    file = root / "data/runtime/kernel.sqlite3"
    file.parent.mkdir(parents=True)
    file.write_bytes(b"isolated encrypted fixture")
    value = smoke.database_identity(root)
    assert set(value) == {"relativePath", "device", "inode"}
    assert value == smoke.database_identity(root)
    old = value
    other = file.with_name("other")
    other.write_bytes(b"different database")
    os.replace(other, file)
    assert smoke.database_identity(root) != old


@pytest.mark.parametrize("kind", ["symlink", "hardlink", "empty"])
def test_preview_smoke_database_rejects_alias_or_empty(tmp_path, kind):
    root, _ = scratch(tmp_path)
    file = root / "data/runtime/kernel.sqlite3"
    file.parent.mkdir(parents=True)
    source = root / "fixture"
    source.write_bytes(b"isolated")
    if kind == "symlink":
        file.symlink_to(source)
    elif kind == "hardlink":
        os.link(source, file)
    else:
        file.touch()
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_DATABASE_INVALID"):
        smoke.database_identity(root)


def test_preview_smoke_lock_release_uses_kernel_lock_not_file_absence(tmp_path):
    file = tmp_path / "workspace.lock"
    file.write_text("99\n")
    fd = os.open(file, os.O_RDWR)
    try:
        smoke.fcntl.flock(fd, smoke.fcntl.LOCK_EX | smoke.fcntl.LOCK_NB)
        assert smoke.lock_available(file) is False
        smoke.fcntl.flock(fd, smoke.fcntl.LOCK_UN)
        assert file.exists()
        assert smoke.lock_available(file) is True
    finally:
        os.close(fd)


def test_preview_smoke_tracks_descendants_after_parent_reparenting():
    table = {100: {"parent": 1, "identity": ("A", "host")},
             101: {"parent": 100, "identity": ("B", "backend")},
             102: {"parent": 101, "identity": ("C", "worker")}}
    known = {}
    smoke.update_descendants(table, [100], known)
    assert sorted(known) == [101, 102]
    table.pop(100)
    table[101]["parent"] = 1
    table[103] = {"parent": 101, "identity": ("D", "new-worker")}
    smoke.update_descendants(table, [], known)
    assert smoke.remaining_processes(table, known) == [101, 102, 103]


def test_preview_smoke_never_claims_reused_pid_as_owned():
    known = {101: ("old-time", "backend")}
    table = {101: {"parent": 1, "identity": ("new-time", "unrelated")},
             102: {"parent": 101, "identity": ("new-time", "unrelated-child")}}
    smoke.update_descendants(table, [], known)
    assert smoke.remaining_processes(table, known) == []
    assert 102 not in known


def test_preview_smoke_process_bounds_fail_closed():
    table = {pid: {"parent": 1, "identity": (str(pid), "worker")} for pid in range(2, 67)}
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_PROCESS_COUNT"):
        smoke.update_descendants(table, [1], {})
    table = {pid: {"parent": pid - 1, "identity": (str(pid), "worker")} for pid in range(2, 40)}
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_PROCESS_DEPTH"):
        smoke.update_descendants(table, [1], {})


def test_preview_smoke_ps_parser_preserves_process_birth_identity(monkeypatch):
    output = " 101 100 Sat Oct 31 08:00:00 2026 S /private/tmp/runtime/bin/python\n"
    monkeypatch.setattr(smoke.subprocess, "check_output", lambda *args, **kwargs: output)
    assert smoke.process_table() == {101: {"parent": 100, "identity": ("Sat Oct 31 08:00:00 2026", "/private/tmp/runtime/bin/python")}}


def test_preview_smoke_invalid_account_is_rejected_before_attribute_query(monkeypatch):
    monkeypatch.setattr(smoke.subprocess, "run", lambda *a, **k: pytest.fail("must not query"))
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_ACCOUNT"):
        smoke.KeychainAttributes("unbounded account")


def test_preview_smoke_never_deletes_local_test_namespace(monkeypatch):
    monkeypatch.setattr(smoke.subprocess, "run", lambda *a, **k: pytest.fail("must not query"))
    query = smoke.KeychainAttributes("a" * 64)
    assert not hasattr(query, "delete_preview")
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_SERVICE"):
        query.read_attributes("unrelated.service")


def test_preview_smoke_json_artifacts_are_exclusive_and_bounded(tmp_path):
    file = tmp_path / "summary.json"
    original = smoke.write_json(file, {"passed": False})
    with pytest.raises(FileExistsError):
        smoke.write_json(file, {"passed": True})
    assert file.read_bytes() == original
    huge = tmp_path / "huge.json"
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_REPORT_TOO_LARGE"):
        smoke.write_json(huge, {"value": "x" * (256 * 1024)})
    assert not huge.exists()


def test_preview_smoke_reads_only_bounded_ready_lines():
    host = object.__new__(smoke.Host)
    host.guard = threading.Lock()
    host.tail = smoke.deque(maxlen=80)
    host.ready_events, host.errors = [], []
    data = b'ordinary output\nREVERIE_PREVIEW_READY {"schema":"fixture"}\n'
    read, write = os.pipe()
    os.write(write, data)
    os.close(write)
    with os.fdopen(read, "rb") as stream:
        host.read("stdout", stream)
    assert host.errors == []
    assert len(host.ready_events) == 1
    assert host.ready_events[0][1] == {"schema": "fixture"}


def test_preview_smoke_node_method_allowlist_rejects_before_spawn(monkeypatch):
    monkeypatch.setattr(smoke.subprocess, "run", lambda *a, **k: pytest.fail("must not spawn"))
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_NODE_METHOD"):
        smoke.node_call("startRuntime", {})


def attribute_fixture(account="a" * 64, service=smoke.SERVICES["previewStorage"]):
    date = "20261031014752Z"
    encoded = (date + "\0").encode().hex()
    output = (f'class: "genp"\n'
              f'    "acct"<blob>="{account}"\n'
              f'    "svce"<blob>="{service}"\n'
              f'    "cdat"<timedate>=0x{encoded}  "{date}\\000"\n'
              f'    "mdat"<timedate>=0x{encoded}  "{date}\\000"\n')
    return output.encode()


def test_preview_smoke_attribute_command_never_requests_password_or_deletion(monkeypatch):
    from types import SimpleNamespace
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout=attribute_fixture(), stderr=b"")
    monkeypatch.setattr(smoke.subprocess, "run", run)
    value = smoke.KeychainAttributes("a" * 64).read_attributes(smoke.SERVICES["previewStorage"])
    assert calls[0][0] == ["/usr/bin/security", "find-generic-password", "-s",
                           smoke.SERVICES["previewStorage"], "-a", "a" * 64]
    assert calls[0][1]["timeout"] == 5
    assert value == {"service": smoke.SERVICES["previewStorage"], "account": "a" * 64,
                     "creationTime": "20261031014752Z", "modificationTime": "20261031014752Z"}


def test_preview_smoke_attribute_query_timeout_fails_without_retry(monkeypatch):
    calls = []
    def run(command, **kwargs):
        calls.append((command, kwargs))
        raise smoke.subprocess.TimeoutExpired(command, kwargs["timeout"])
    monkeypatch.setattr(smoke.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_ATTRIBUTE_TIMEOUT:previewStorage"):
        smoke.KeychainAttributes("a" * 64).read_attributes(smoke.SERVICES["previewStorage"])
    assert len(calls) == 1 and calls[0][1]["timeout"] == 5


@pytest.mark.parametrize("code", [36, 51, -15])
def test_preview_smoke_attribute_query_error_preserves_code(monkeypatch, code):
    from types import SimpleNamespace
    monkeypatch.setattr(smoke.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=code, stdout=b"", stderr=b"authentication unavailable"))
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_ATTRIBUTE_QUERY:" + str(code)):
        smoke.KeychainAttributes("a" * 64).read_attributes(smoke.SERVICES["previewStorage"])


def test_preview_smoke_only_explicit_not_found_is_absent():
    service, account = smoke.SERVICES["previewStorage"], "a" * 64
    error = b"security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n"
    assert smoke.parse_keychain_attributes(b"", error, 44, service, account) is None
    for stdout, stderr in [(b"", b"unknown error"), (attribute_fixture(), error)]:
        with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_ATTRIBUTE_QUERY:44"):
            smoke.parse_keychain_attributes(stdout, stderr, 44, service, account)


@pytest.mark.parametrize("change,reason", [
    ("wrong-service", "PREVIEW_SMOKE_ATTRIBUTE_IDENTITY"),
    ("wrong-account", "PREVIEW_SMOKE_ATTRIBUTE_IDENTITY"),
    ("wrong-class", "PREVIEW_SMOKE_ATTRIBUTE_CLASS"),
    ("missing-date", "PREVIEW_SMOKE_ATTRIBUTE_FIELD:cdat"),
    ("duplicate-account", "PREVIEW_SMOKE_ATTRIBUTE_FIELD:acct"),
    ("hex-mismatch", "PREVIEW_SMOKE_ATTRIBUTE_DATE_ENCODING"),
    ("password", "PREVIEW_SMOKE_UNEXPECTED_SECRET_OUTPUT"),
])
def test_preview_smoke_attribute_negative_cases_preserve_a_valid_baseline(change, reason):
    service, account = smoke.SERVICES["previewStorage"], "a" * 64
    baseline = attribute_fixture()
    assert smoke.parse_keychain_attributes(baseline, b"", 0, service, account)["account"] == account
    value = baseline
    if change == "wrong-service":
        value = value.replace(service.encode(), b"other.service")
    elif change == "wrong-account":
        value = value.replace(account.encode(), b"b" * 64)
    elif change == "wrong-class":
        value = value.replace(b'"genp"', b'"inet"')
    elif change == "missing-date":
        value = b"\n".join(line for line in value.splitlines() if b'"cdat"' not in line)
    elif change == "duplicate-account":
        value += f'    "acct"<blob>="{account}"\n'.encode()
    elif change == "hex-mismatch":
        value = value.replace(b"0x32", b"0x33", 1)
    else:
        value += b'password: "never-log-this"\n'
    with pytest.raises(RuntimeError, match=reason):
        smoke.parse_keychain_attributes(value, b"", 0, service, account)


def test_preview_smoke_attribute_output_is_not_forwarded_to_log(monkeypatch, capsys):
    from types import SimpleNamespace
    monkeypatch.setattr(smoke.subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stdout=attribute_fixture() + b'password: "never-log-this"\n', stderr=b""))
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_UNEXPECTED_SECRET_OUTPUT"):
        smoke.KeychainAttributes("a" * 64).read_attributes(smoke.SERVICES["previewStorage"])
    assert "never-log-this" not in capsys.readouterr().out


def test_preview_smoke_cleanup_context_has_scope_and_directory_identities(tmp_path):
    root, _ = scratch(tmp_path)
    (root / "data").mkdir(mode=0o700)
    workspace = root / "preview-workspace"
    workspace.mkdir(mode=0o700)
    file = smoke.cleanup_context(root, workspace)
    value = json.loads(file.read_bytes())
    assert value["purpose"] == "reverie.qt.preview-test-cleanup.v1"
    assert value["root"] == smoke.directory_record(root)
    assert value["data"] == smoke.directory_record(root / "data")
    assert value["previewWorkspace"] == smoke.directory_record(workspace)
    assert file.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        smoke.cleanup_context(root, workspace)


def test_preview_smoke_cleanup_context_rejects_unrelated_workspace(tmp_path):
    root, _ = scratch(tmp_path)
    unrelated = tmp_path / "other"
    unrelated.mkdir()
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_CLEANUP_WORKSPACE_SCOPE"):
        smoke.cleanup_context(root, unrelated)


def test_preview_smoke_attribute_dates_accept_quoted_form_but_reject_bad_calendar():
    import re
    value = re.sub(rb'0x[0-9a-f]+  ', b'', attribute_fixture())
    service, account = smoke.SERVICES["previewStorage"], "a" * 64
    assert smoke.parse_keychain_attributes(value, b"", 0, service, account)["creationTime"] == "20261031014752Z"
    invalid = value.replace(b"20261031", b"20260231")
    with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_ATTRIBUTE_DATE"):
        smoke.parse_keychain_attributes(invalid, b"", 0, service, account)


@pytest.mark.parametrize("outcome", ["success", "scope-rejected", "delete-rejected", "timeout", "unexpected-ready", "unexpected-child"])
def test_preview_smoke_host_cleanup_is_bounded_and_always_reaps(tmp_path, monkeypatch, outcome):
    root, _ = scratch(tmp_path)
    (root / "data").mkdir(mode=0o700)
    workspace = root / "preview-workspace"
    workspace.mkdir(mode=0o700)
    events = []
    class FakeProcess:
        def wait(self, timeout):
            events.append(("wait", timeout))
            if outcome == "timeout":
                raise smoke.subprocess.TimeoutExpired("synthetic-cleanup", timeout)
            return {"scope-rejected": 68, "delete-rejected": 69}.get(outcome, 0)
    class FakeHost:
        def __init__(self, runtime, target, *, cleanup_file):
            assert target == workspace and cleanup_file == root / "preview-cleanup-context.json"
            self.started, self.pid = 1000, 9001
            self.process = FakeProcess()
            self.ready_events = [(1100, {})] if outcome == "unexpected-ready" else []
            self.descendants = {9002: ("synthetic", "child")} if outcome == "unexpected-child" else {}
        def finish_threads(self):
            events.append("joined")
        def cleanup(self):
            events.append("reaped")
            return []
    monkeypatch.setattr(smoke, "Host", FakeHost)
    monkeypatch.setattr(smoke.time, "monotonic_ns", lambda: 2000)
    hosts = []
    if outcome == "success":
        value = smoke.host_cleanup({}, workspace, root, "a" * 64, hosts)
        assert value["exitCode"] == 0 and value["backendPids"] == [] and value["readyEvents"] == []
        assert value["services"] == [smoke.SERVICES["previewStorage"], smoke.SERVICES["previewCredentials"]]
    else:
        with pytest.raises(RuntimeError, match="PREVIEW_SMOKE_HOST_CLEANUP_(REJECTED|TIMEOUT)"):
            smoke.host_cleanup({}, workspace, root, "a" * 64, hosts)
    assert len(hosts) == 1 and events[-1] == "reaped"
    assert 0 < events[0][1] <= 10


def test_preview_smoke_cleanup_host_argv_has_only_isolated_cleanup(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from io import BytesIO
    calls = []
    class NoThread:
        def __init__(self, *args, **kwargs):
            pass
        def start(self):
            pass
    def popen(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(pid=9001, stdout=BytesIO(), stderr=BytesIO())
    monkeypatch.setattr(smoke.threading, "Thread", NoThread)
    monkeypatch.setattr(smoke.subprocess, "Popen", popen)
    context = tmp_path / "preview-cleanup-context.json"
    smoke.Host({"hostExecutable": "/synthetic/host", "runtimeRoot": "/synthetic/runtime"},
               tmp_path / "preview-workspace", cleanup_file=context)
    assert calls == [["/synthetic/host", "--remove-preview-test-key", "--context", str(context),
                      "--data-dir", str(tmp_path / "data")]]
