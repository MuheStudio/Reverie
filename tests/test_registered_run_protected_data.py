"""The original protected-data guard observes synthetic index/stat metadata only."""
import builtins
import hashlib
import os
from pathlib import Path
import stat
import subprocess

import pytest

from script.registered_run import protected_data as guard


def git(root, *arguments, input=None):
    return subprocess.run(["git", "-C", str(root), *arguments], input=input, capture_output=True, check=True).stdout


@pytest.fixture
def protected_repo(tmp_path):
    root = tmp_path.resolve()
    git(root, "init", "--quiet")
    path = root / guard.PLACEHOLDER
    path.parent.mkdir(parents=True)
    # Fixture setup creates and indexes synthetic bytes before installing the
    # no-content-read sentinel. The guard itself never hashes these bytes.
    payload = b"x" * 58
    path.write_bytes(payload)
    path.chmod(0o644)
    git(root, "add", "--", guard.PLACEHOLDER)
    oid = git(root, "rev-parse", ":" + guard.PLACEHOLDER).decode().strip()
    expected = {guard.PLACEHOLDER: {"indexMode": "100644", "indexBlobOid": oid, "stage": "0", "gitBlobBytes": 58,
                                  "stat": {"mode": stat.S_IFREG | 0o644, "bytes": 58}}}
    return root, path, expected


def forbid_data_reads(monkeypatch, root):
    directory = root / "data"
    def forbidden(path):
        if isinstance(path, (str, bytes, os.PathLike)):
            value = Path(os.fsdecode(path))
            return value.is_absolute() and value.is_relative_to(directory)
        return False
    for name in ("open", "read_bytes", "read_text"):
        original = getattr(Path, name)
        def wrapped(path, *arguments, original=original, **kwargs):
            if forbidden(path):
                raise AssertionError("protected working-data contents were opened")
            return original(path, *arguments, **kwargs)
        monkeypatch.setattr(Path, name, wrapped)
    original_open, original_os_open = builtins.open, os.open
    def file_open(path, *arguments, **kwargs):
        if forbidden(path):
            raise AssertionError("protected working-data contents were opened")
        return original_open(path, *arguments, **kwargs)
    def descriptor_open(path, *arguments, **kwargs):
        if forbidden(path):
            raise AssertionError("protected working-data contents were opened")
        return original_os_open(path, *arguments, **kwargs)
    monkeypatch.setattr(builtins, "open", file_open)
    monkeypatch.setattr(os, "open", descriptor_open)
    def no_hash(*args, **kwargs):
        raise AssertionError("protected-data metadata guard must not hash contents")
    monkeypatch.setattr(hashlib, "sha1", no_hash)
    monkeypatch.setattr(hashlib, "sha256", no_hash)
    monkeypatch.setattr(hashlib, "new", no_hash)


def test_original_metadata_record_uses_only_allowed_git_commands_and_lstat(protected_repo, monkeypatch):
    root, _, expected = protected_repo
    commands = []
    original = guard.subprocess.run
    def metadata_command(command, **kwargs):
        assert command[:3] == ["git", "-C", str(root)]
        arguments = command[3:]
        assert arguments == ["ls-files", "--stage", "-z", "--", "data"] or (
            len(arguments) == 3 and arguments[:2] == ["cat-file", "-s"] and arguments[2] == expected[guard.PLACEHOLDER]["indexBlobOid"])
        assert "GIT_INDEX_FILE" not in kwargs["env"]
        assert kwargs["env"]["GIT_OPTIONAL_LOCKS"] == "0"
        commands.append(arguments)
        return original(command, **kwargs)
    monkeypatch.setenv("GIT_INDEX_FILE", "/synthetic-unrelated-index-must-not-be-used")
    monkeypatch.setattr(guard.subprocess, "run", metadata_command)
    forbid_data_reads(monkeypatch, root)
    assert guard.protected_data_snapshot(root) == expected
    assert len(commands) == 2


def test_same_size_unindexed_working_contents_are_not_read_or_hashed(protected_repo, monkeypatch):
    root, path, expected = protected_repo
    path.write_bytes(b"different-working-content".ljust(58, b"!"))
    forbid_data_reads(monkeypatch, root)
    # This is the original guard's precise boundary: index identity and lstat
    # match. It makes no content-verification claim about an unindexed rewrite.
    assert guard.assert_protected_data(root, expected) == expected


@pytest.mark.parametrize("change", ["missing", "extra"])
def test_indexed_data_set_changes_are_rejected(protected_repo, change):
    root, _, _ = protected_repo
    if change == "missing":
        git(root, "rm", "--cached", "--", guard.PLACEHOLDER)
    else:
        extra = root / "data/extra.bin"
        extra.write_bytes(b"z" * 58)
        git(root, "add", "--", "data/extra.bin")
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_TRACKED_DATA_SET_CHANGED"):
        guard.protected_data_snapshot(root)


def test_index_blob_identity_change_is_rejected_without_reading_working_contents(protected_repo, monkeypatch):
    root, path, expected = protected_repo
    path.write_bytes(b"y" * 58)
    git(root, "add", "--", guard.PLACEHOLDER)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_DATA_METADATA_CHANGED"):
        guard.assert_protected_data(root, expected)


def test_lstat_mode_change_is_rejected(protected_repo, monkeypatch):
    root, path, expected = protected_repo
    path.chmod(0o600)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_DATA_METADATA_CHANGED"):
        guard.assert_protected_data(root, expected)


def test_lstat_size_change_retains_original_58_byte_comparison(protected_repo, monkeypatch):
    root, path, _ = protected_repo
    path.write_bytes(b"x" * 57)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_TRACKED_PLACEHOLDER_CHANGED"):
        guard.protected_data_snapshot(root)


def test_git_blob_size_change_retains_original_58_byte_comparison(protected_repo, monkeypatch):
    root, _, _ = protected_repo
    oid = git(root, "hash-object", "-w", "--stdin", input=b"z" * 57).decode().strip()
    git(root, "update-index", "--cacheinfo", "100644", oid, guard.PLACEHOLDER)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_TRACKED_PLACEHOLDER_CHANGED"):
        guard.protected_data_snapshot(root)


def test_unmerged_index_stage_is_rejected(protected_repo, monkeypatch):
    root, _, expected = protected_repo
    oid = expected[guard.PLACEHOLDER]["indexBlobOid"]
    rows = ("0 " + "0" * len(oid) + "\t" + guard.PLACEHOLDER + "\n100644 " + oid + " 2\t" + guard.PLACEHOLDER + "\n").encode()
    git(root, "update-index", "--index-info", input=rows)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_TRACKED_PLACEHOLDER_CHANGED"):
        guard.protected_data_snapshot(root)


def test_index_mode_change_is_rejected(protected_repo, monkeypatch):
    root, _, expected = protected_repo
    git(root, "update-index", "--chmod=+x", "--", guard.PLACEHOLDER)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_DATA_METADATA_CHANGED"):
        guard.assert_protected_data(root, expected)


def test_symlink_placeholder_is_rejected_without_reading_its_target(protected_repo, monkeypatch):
    root, path, _ = protected_repo
    target = root / "not-data-readable-target"
    target.write_bytes(b"x" * 58)
    path.unlink()
    path.symlink_to(target)
    forbid_data_reads(monkeypatch, root)
    with pytest.raises(guard.ProtectedDataError, match="PROTECTED_TRACKED_PLACEHOLDER_CHANGED"):
        guard.protected_data_snapshot(root)
