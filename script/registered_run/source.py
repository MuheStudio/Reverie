"""Working-source snapshots using a private Git index, never the user's index."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tempfile

from .isolation import default_data_paths


class SourceError(RuntimeError):
    pass


def _git(root: Path, *arguments: str, env=None, input=None) -> bytes:
    base = dict(os.environ)
    base.pop("GIT_INDEX_FILE", None)
    base["GIT_OPTIONAL_LOCKS"] = "0"
    return subprocess.run(["git", "-C", str(root), *arguments], env=base if env is None else env, input=input,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30).stdout


def _check_source_path(root: Path, name: str):
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or "\\" in name or any(ord(c) < 32 for c in name):
        raise SourceError("SOURCE_PATH_ESCAPES_REPOSITORY")
    path = root / name
    current = path.parent
    while current != root:
        if current.is_symlink():
            raise SourceError("SOURCE_SYMLINK_ANCESTOR:" + name)
        current = current.parent
    for protected in default_data_paths(root):
        resolved = path.resolve(strict=False)
        target = protected.resolve(strict=False)
        if resolved == target or resolved.is_relative_to(target):
            raise SourceError("SOURCE_DATA_ALIAS_FORBIDDEN:" + name)


def snapshot_source(root: Path | str) -> dict:
    project = Path(root).resolve(strict=True)
    if (project / "data").is_symlink():
        raise SourceError("SOURCE_DATA_DIRECTORY_SYMLINK_FORBIDDEN")
    head = _git(project, "rev-parse", "HEAD").decode().strip()
    names = set(filter(None, _git(project, "ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")))
    # These are the existing formal audit exclusions, not the unrelated C2C
    # connector's ignore patterns. All other tracked/new source participates.
    names = {name for name in names if name != ".c2cignore" and name != "data" and not name.startswith("data/")
             and name != "outputs" and not name.startswith("outputs/")}
    files, index_rows, code_index_rows, regular_paths, regular_oids = [], [], [], [], []
    object_format = _git(project, "rev-parse", "--show-object-format").decode().strip()
    for name in sorted(names):
        _check_source_path(project, name)
        path = project / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue  # Working-tree deletions are represented by absence.
        if stat.S_ISLNK(info.st_mode):
            payload, mode = os.fsencode(os.readlink(path)), "120000"
        elif stat.S_ISREG(info.st_mode):
            payload, mode = path.read_bytes(), "100755" if info.st_mode & 0o111 else "100644"
        else:
            raise SourceError("SOURCE_NOT_FILE_OR_LINK:" + name)
        oid = hashlib.new(object_format, b"blob " + str(len(payload)).encode() + b"\0" + payload).hexdigest()
        if mode == "120000":
            stored = _git(project, "hash-object", "-w", "--stdin", input=payload).decode().strip()
            if stored != oid:
                raise SourceError("SOURCE_BLOB_CHANGED:" + name)
        else:
            regular_paths.append(str(path))
            regular_oids.append(oid)
        files.append({"path": name, "mode": mode, "bytes": len(payload),
                      "sha256": hashlib.sha256(payload).hexdigest(), "gitBlob": oid})
        index_row = f"{mode} {oid}\t{name}\0".encode()
        index_rows.append(index_row)
        if not name.startswith("docs/"):
            code_index_rows.append(index_row)
    if regular_paths:
        stored = _git(project, "hash-object", "-w", "--no-filters", "--stdin-paths",
                      input=("\n".join(regular_paths) + "\n").encode()).decode().splitlines()
        if stored != regular_oids:
            raise SourceError("SOURCE_CHANGED_DURING_SNAPSHOT")
    with tempfile.TemporaryDirectory(prefix="reverie-source-index-") as scratch:
        trees = []
        # Both identities use the very same captured file bytes and modes.
        # Only the second private index omits documentation paths.
        for index_name, rows in (("source-index", index_rows), ("code-index", code_index_rows)):
            temporary_index = Path(scratch) / index_name
            env = {**os.environ, "GIT_INDEX_FILE": str(temporary_index), "GIT_OPTIONAL_LOCKS": "0"}
            _git(project, "read-tree", "--empty", env=env)
            if rows:
                _git(project, "update-index", "-z", "--index-info", env=env, input=b"".join(rows))
            trees.append(_git(project, "write-tree", env=env).decode().strip())
        tree, code_tree = trees
    status_rows = _git(project, "status", "--porcelain=v1", "-z", "--untracked-files=normal").decode().split("\0")
    dirty = any(row and not (row.startswith("?? ") and
                (row[3:] == ".c2cignore" or row[3:] == "outputs/" or row[3:].startswith("outputs/")))
                for row in status_rows)
    return {"head": head, "treeHash": tree, "codeTreeHash": code_tree, "dirty": dirty, "files": files,
            "scope": "tracked-plus-nonignored-untracked-minus-data-c2cignore-file-and-outputs"}


def assert_frozen(root: Path | str, expected: dict, *, require_clean: bool = True) -> dict:
    actual = snapshot_source(root)
    if require_clean and actual["dirty"]:
        raise SourceError("FROZEN_WORKTREE_DIRTY")
    if any(actual[key] != expected[key] for key in ("head", "treeHash", "files")):
        raise SourceError("FROZEN_SOURCE_CHANGED")
    return actual
