"""Small local-first persistence helpers shared by world-state managers."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4


def backup_path(path: Path) -> Path:
    """Return the stable sibling backup path used by JSON persistence."""
    return path.with_suffix(path.suffix + ".bak")


def _read_valid_json(path: Path, validator: Callable[[Any], None] | None = None) -> Any:
    data = path.read_bytes()
    payload = json.loads(data.decode("utf-8"))
    if validator is not None:
        validator(payload)
    return payload


def _write_synced(path: Path, data: bytes) -> None:
    with open(path, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def _durable_replace(source: Path, destination: Path) -> None:
    """Atomically replace a sibling file, requesting write-through on Windows."""
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        move_file_ex = kernel32.MoveFileExW
        move_file_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        move_file_ex.restype = ctypes.c_int
        # MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
        if not move_file_ex(str(source.resolve()), str(destination.resolve()), 0x9):
            raise ctypes.WinError(ctypes.get_last_error())
        return
    os.replace(source, destination)


def _fsync_directory(path: Path) -> None:
    """Persist rename metadata on systems that support syncing directories."""
    if os.name == "nt":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _install_bytes(
    path: Path,
    data: bytes,
    validator: Callable[[Any], None] | None = None,
) -> None:
    temp_path = path.with_suffix(path.suffix + f".{uuid4().hex}.tmp")
    try:
        _write_synced(temp_path, data)
        # Verify bytes as read from the filesystem before making them authoritative.
        _read_valid_json(temp_path, validator)
        _durable_replace(temp_path, path)
        _fsync_directory(path.parent)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def atomic_write_json(
    path: Path,
    payload: Any,
    *,
    validator: Callable[[Any], None] | None = None,
) -> None:
    """Durably replace JSON while retaining one verified prior generation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    # Validate before touching either authoritative copy.
    candidate = json.loads(data.decode("utf-8"))
    if validator is not None:
        validator(candidate)

    prior_data: bytes | None = None
    try:
        _read_valid_json(path, validator)
        prior_data = path.read_bytes()
    except Exception:
        pass

    backup = backup_path(path)
    backup_is_valid = False
    try:
        _read_valid_json(backup, validator)
        backup_is_valid = True
    except Exception:
        pass

    # A corrupt primary must never replace the only known-good backup.
    if prior_data is not None:
        _install_bytes(backup, prior_data, validator)
    elif not backup_is_valid:
        # Establish recovery before the first primary commit.
        _install_bytes(backup, data, validator)

    _install_bytes(path, data, validator)


def read_json_object(path: Path) -> dict[str, Any] | None:
    """Read an object from the primary, falling back to its verified backup."""
    for candidate in (path, backup_path(path)):
        try:
            payload = _read_valid_json(candidate)
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            return payload
    return None
