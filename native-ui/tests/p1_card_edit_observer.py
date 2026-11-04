"""Optional metadata-only observer for the owned persona GUI tail.

It observes the real dispatch and immutable files. It never edits production
state, changes a result, seeds a version, or wraps model scheduling.
"""
from __future__ import annotations

import functools
import hashlib
import json
import os
from pathlib import Path
import re
import stat


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _read(path: Path, maximum=262144, *, private=False):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
            or (private and info.st_mode & 0o077) or not 0 < info.st_size <= maximum or path.resolve() != path):
        raise ValueError("card edit evidence requires an owned private regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("card edit evidence file identity changed")
        chunks = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        value = b"".join(chunks)
        after = os.fstat(fd)
        named = path.lstat()
        if (len(value) != opened.st_size or after.st_size != opened.st_size
                or after.st_mtime_ns != opened.st_mtime_ns or after.st_ctime_ns != opened.st_ctime_ns
                or (named.st_dev, named.st_ino, named.st_nlink) != (opened.st_dev, opened.st_ino, 1)):
            raise ValueError("card edit evidence file changed while reading")
        return value
    finally:
        os.close(fd)


def _digest(path: Path, *, private=False):
    value = _read(path, private=private)
    return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}


def _registered_version_path(root: Path, profile_id: str, selected: dict):
    """Validate the registry's actual path; never search for an orphan file."""
    version, fingerprint, relative = (selected.get(key) for key in
                                      ("identity_version", "identity_fingerprint", "persona_path"))
    if (not isinstance(profile_id, str) or not re.fullmatch(r"st_[a-f0-9]{20}", profile_id)
            or type(version) is not int or version < 1 or not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint) or not isinstance(relative, str)):
        raise ValueError("card edit registry version path invalid")
    expected_name = "persona.json" if version == 1 else f"persona.v{version}-{fingerprint[:16]}.json"
    if relative != f"imported/{profile_id}/{expected_name}":
        raise ValueError("card edit registry version path invalid")
    actual = root / relative
    if actual.resolve() != actual:
        raise ValueError("card edit registry version path outside isolation")
    return actual


def install(data: Path, cycle: int):
    from src.bridge import ws_bridge
    from src.config.settings import PERSONA_DIR

    root = Path(PERSONA_DIR).resolve()
    if root != data / "data" / "persona" or cycle not in (1, 2):
        raise ValueError("card edit observer outside owned isolation")
    evidence = data / "p1-card-edit-metadata.jsonl"
    original = ws_bridge.dispatch_authenticated_message
    retained_versions = {}

    def snapshot(profile_id):
        registry = json.loads(_read(root / "registry.json"))
        selected = registry["profiles"][profile_id]
        if selected.get("name") != "测试人格·晴":
            raise ValueError("card edit target is not the registered seeded persona")
        actual = _registered_version_path(root, profile_id, selected)
        version = selected["identity_version"]
        if version in (2, 3):
            previous = retained_versions.setdefault(version, actual)
            if previous != actual:
                raise ValueError("card edit registered version path changed")
        directory = root / "imported" / profile_id
        others = {**registry, "profiles": {key: value for key, value in registry["profiles"].items() if key != profile_id}}

        def retained(number):
            path = retained_versions.get(number)
            return ({**_digest(path, private=True), "path": path.relative_to(root).as_posix()}
                    if path is not None else None)

        return {"scope": ws_bridge._active_persona_scope(), "activeId": registry["active_id"],
                "profile": {key: selected.get(key) for key in ("id", "name", "persona_id", "source_format", "source_sha256", "identity_version", "identity_fingerprint", "persona_path")},
                "otherRegistrySha256": hashlib.sha256(_canonical(others)).hexdigest(),
                "original": _digest(directory / "persona.json"),
                "importReport": _digest(directory / "import-report.json"),
                "v2": retained(2),
                "v3": retained(3),
                "cache": _digest(root / "active.json")}

    @functools.wraps(original)
    async def dispatch(message, endpoint, **kwargs):
        if message.get("type") != "persona:profile:update":
            return await original(message, endpoint, **kwargs)
        request_id = message.get("request_id")
        profile_id = (message.get("payload") or {}).get("profile_id")
        if (not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id)
                or not isinstance(profile_id, str) or not re.fullmatch(r"st_[a-f0-9]{20}", profile_id)):
            raise ValueError("card edit observer request identity invalid")
        before = snapshot(profile_id)
        result = await original(message, endpoint, **kwargs)
        after = snapshot(profile_id)
        result = result if isinstance(result, dict) else {}
        entry = {"schema": "reverie.native.card-edit.backend-evidence.v1", "event": "update", "cycle": cycle,
                 "requestId": request_id, "profileId": profile_id, "before": before, "after": after,
                 "result": {"ok": result.get("ok"), "version": result.get("identity_version"),
                            "fingerprint": result.get("identity_fingerprint"), "active": result.get("active"),
                            "fieldsSha256": hashlib.sha256(_canonical(result.get("fields"))).hexdigest()}}
        if evidence.exists():
            _read(evidence, 65536, private=True)
        fd = os.open(evidence, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size >= 65536:
                raise ValueError("card edit observer evidence identity invalid")
            os.write(fd, _canonical(entry) + b"\n")
            os.fsync(fd)
        finally:
            os.close(fd)
        return result

    ws_bridge.dispatch_authenticated_message = dispatch

    def undo():
        ws_bridge.dispatch_authenticated_message = original
    return undo
