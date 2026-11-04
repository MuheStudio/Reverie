"""The signed r1 guard for indexed default-data placeholder metadata.

The working ``data/`` contents are never opened, read or hashed. The only Git
operations are index listing and object-size lookup; working paths receive
lstat only. This intentionally observes the same metadata as the original
formal runner, rather than claiming to validate working-copy content.
"""
from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess


PLACEHOLDER = "data/persona/.gitkeep"


class ProtectedDataError(RuntimeError):
    pass


def _need(condition, code):
    if not condition:
        raise ProtectedDataError(code)


def _git(root: Path, *arguments: str) -> str:
    environment = dict(os.environ)
    environment.pop("GIT_INDEX_FILE", None)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    completed = subprocess.run(["git", "-C", str(root), *arguments], env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               check=True, timeout=30)
    return completed.stdout.decode("utf-8")


def protected_data_snapshot(root: str | Path) -> dict:
    """Return r1's exact index identity, Git size and lstat mode/size record."""
    project = Path(root).resolve(strict=True)
    result = {}
    for row in _git(project, "ls-files", "--stage", "-z", "--", "data").split("\0"):
        if not row:
            continue
        try:
            header, relative = row.split("\t", 1)
            mode, blob, stage = header.split()
        except ValueError as error:
            raise ProtectedDataError("PROTECTED_TRACKED_INDEX_ROW_INVALID") from error
        path = PurePosixPath(relative)
        _need(not path.is_absolute() and ".." not in path.parts and relative == PLACEHOLDER,
              "PROTECTED_TRACKED_DATA_SET_CHANGED")
        _need(re.fullmatch(r"[0-7]{6}", mode) and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", blob) and
              re.fullmatch(r"[0-3]", stage), "PROTECTED_TRACKED_INDEX_ROW_INVALID")
        # Reject an ancestor alias with metadata alone. No default-data target
        # is resolved or opened, even when an indexed path has been replaced.
        for parent in (project / "data", project / "data/persona"):
            info = parent.lstat()
            _need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
                  "PROTECTED_TRACKED_DATA_ANCESTOR_ALIAS")
        value = (project / relative).lstat()
        count_text = _git(project, "cat-file", "-s", blob).strip()
        _need(count_text.isdigit(), "PROTECTED_TRACKED_BLOB_SIZE_INVALID")
        count = int(count_text)
        # Retain the original r1 comparison expression and fixed placeholder
        # contract. Full mode/OID/index/stat equality is checked by the caller.
        _need(stage == "0" and stat.S_ISREG(value.st_mode) and value.st_size == count == 58,
              "PROTECTED_TRACKED_PLACEHOLDER_CHANGED:" + relative)
        _need(relative not in result, "PROTECTED_TRACKED_INDEX_ROW_REPEATED")
        result[relative] = {"indexMode": mode, "indexBlobOid": blob, "stage": stage,
                            "gitBlobBytes": count, "stat": {"mode": value.st_mode, "bytes": value.st_size}}
    _need(set(result) == {PLACEHOLDER}, "PROTECTED_TRACKED_DATA_SET_CHANGED")
    return result


def assert_protected_data(root: str | Path, expected: dict) -> dict:
    actual = protected_data_snapshot(root)
    _need(isinstance(expected, dict) and actual == expected, "PROTECTED_DATA_METADATA_CHANGED")
    return actual
