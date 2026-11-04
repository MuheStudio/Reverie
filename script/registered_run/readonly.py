"""Repository-owned files used only as immutable, read-only evidence.

Application bundles may contain historical evidence.  Writable directory
checks remain in isolation/state and deliberately do not use this module.
"""
from __future__ import annotations

import os
from pathlib import Path
import stat

from .isolation import assert_not_data_path


class ReadOnlyFileError(RuntimeError):
    pass


def _absolute_path(value: Path | str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ReadOnlyFileError("READ_ONLY_PATH_NOT_ABSOLUTE")
    if path != Path(os.path.abspath(path)):
        raise ReadOnlyFileError("READ_ONLY_PATH_NOT_CANONICAL")
    return path


def _repository_path(root: Path | str, path: Path | str) -> tuple[Path, Path]:
    project, filename = _absolute_path(root), _absolute_path(path)
    if not filename.is_relative_to(project):
        raise ReadOnlyFileError("READ_ONLY_PATH_ESCAPES_ROOT")
    assert_not_data_path(filename, project)
    return project, filename


def _directory_chain(root: Path, directory: Path) -> os.stat_result:
    current = directory
    identity = directory.lstat()
    while True:
        info = identity if current == directory else current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ReadOnlyFileError("READ_ONLY_PARENT_SYMLINK_FORBIDDEN")
        if not stat.S_ISDIR(info.st_mode):
            raise ReadOnlyFileError("READ_ONLY_PARENT_NOT_DIRECTORY")
        # System ancestors (for example /Volumes) need not belong to this
        # user.  Every evidence parent within the repository does.
        if current.is_relative_to(root) and info.st_uid != os.getuid():
            raise ReadOnlyFileError("READ_ONLY_PARENT_OWNER_MISMATCH")
        if current == current.parent:
            break
        current = current.parent
    if directory.resolve(strict=True) != directory:
        raise ReadOnlyFileError("READ_ONLY_PATH_NOT_CANONICAL")
    return identity


def readonly_directory(root: Path | str, path: Path | str) -> os.stat_result:
    """Validate an evidence directory for read-only inventory traversal."""
    project, directory = _repository_path(root, path)
    return _directory_chain(project, directory)


def readonly_regular_file(root: Path | str, path: Path | str) -> os.stat_result:
    """Check a canonical in-repository file without applying writable rules.

    This function only inspects metadata.  Callers must open with O_NOFOLLOW
    and compare the returned identity with descriptor and post-read metadata.
    """
    project, filename = _repository_path(root, path)
    _directory_chain(project, filename.parent)
    info = filename.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise ReadOnlyFileError("READ_ONLY_FILE_SYMLINK_FORBIDDEN")
    if not stat.S_ISREG(info.st_mode):
        raise ReadOnlyFileError("READ_ONLY_NOT_REGULAR_FILE")
    if info.st_nlink != 1:
        raise ReadOnlyFileError("READ_ONLY_HARDLINK_FORBIDDEN")
    if info.st_uid != os.getuid():
        raise ReadOnlyFileError("READ_ONLY_FILE_OWNER_MISMATCH")
    if filename.resolve(strict=True) != filename:
        raise ReadOnlyFileError("READ_ONLY_PATH_NOT_CANONICAL")
    return info
