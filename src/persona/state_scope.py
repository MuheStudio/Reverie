"""Authoritative, epoch-bound durable state namespaces for one persona.

Persona-coupled state must satisfy two independent properties:

* it lives below a directory derived from the sealed ``persona_id``; and
* every read or commit is rejected after the bound persona epoch goes stale.

Legacy, unscoped data is copied only for an exact, compiled identity
fingerprint allowlist.  For every other identity the legacy source is left
untouched and an empty scoped namespace is created.  This avoids silently
attributing one character's history to a newly imported character.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TypeVar

from .identity import (
    PersonaEpochRegistry,
    PersonaEpochToken,
    PersonaIdentityEnvelope,
    StalePersonaEpoch,
)
from .persona_card import Persona


_Result = TypeVar("_Result")
_MODULE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_ROOT_MANIFEST = "persona-state.json"
_MODULE_MARKER = ".persona-scope"
_SCHEMA = "reverie.persona-state.v1"
_MAX_LEGACY_FILES = 100_000
_MAX_LEGACY_BYTES = 2 * 1024 * 1024 * 1024


class PersonaStateScopeViolation(RuntimeError):
    """A durable namespace cannot be proven to belong to this persona."""


@dataclass(frozen=True)
class PersonaModuleState:
    """One module directory bound permanently to a persona epoch."""

    name: str
    path: Path
    token: PersonaEpochToken
    registry: PersonaEpochRegistry
    migration_status: str

    def capture(self) -> PersonaEpochToken:
        """Return the bound token after proving that it is still current."""

        self.require_current(self.token)
        return self.token

    def require_current(self, token: PersonaEpochToken | None = None) -> None:
        """Reject both stale epochs and tokens borrowed from another scope."""

        candidate = token or self.token
        if candidate != self.token:
            raise StalePersonaEpoch("Token does not belong to this persona state namespace")
        self.registry.require_current(self.token)

    def commit(
        self,
        token: PersonaEpochToken,
        callback: Callable[[], _Result],
    ) -> _Result:
        """Linearize a synchronous durable side effect against persona switch."""

        if token != self.token:
            raise StalePersonaEpoch("Token does not belong to this persona state namespace")
        return self.registry.commit_if_current(self.token, callback)

    def commit_bound(self, callback: Callable[[], _Result]) -> _Result:
        """Commit using this module's immutable bound epoch token."""

        return self.commit(self.token, callback)

    def file(self, filename: str) -> Path:
        """Resolve a simple file name inside the module namespace."""

        if (
            not filename
            or filename in {".", ".."}
            or Path(filename).name != filename
            or "/" in filename
            or "\\" in filename
        ):
            raise ValueError("Persona module file name must be a simple basename")
        return self.path / filename


class PersonaStateScope:
    """Create and attest per-persona module namespaces."""

    def __init__(
        self,
        persona: Persona,
        *,
        registry: PersonaEpochRegistry,
        base_dir: Path,
        legacy_fingerprint_allowlist: set[str] | frozenset[str] = frozenset(),
    ) -> None:
        envelope = persona.seal_identity()
        token = registry.token()
        if (
            token.persona_id != envelope.persona_id
            or token.fingerprint != envelope.fingerprint
        ):
            raise PersonaStateScopeViolation(
                "Persona state scope must be created for the authoritative active identity"
            )
        registry.require_current(token)
        self.envelope = envelope
        self.token = token
        self.registry = registry
        self.base_dir = Path(base_dir).expanduser().resolve()
        self.root = self.base_dir / hashlib.sha256(
            envelope.persona_id.encode("utf-8")
        ).hexdigest()
        self._legacy_fingerprint_allowlist = frozenset(
            str(item) for item in legacy_fingerprint_allowlist
        )
        self._lock = threading.RLock()
        self._manifest = self._load_or_initialize_root()

    def module(
        self,
        name: str,
        *,
        legacy_path: Path | None = None,
    ) -> PersonaModuleState:
        """Return an attested module directory, migrating legacy data if safe."""

        if not _MODULE_NAME_RE.fullmatch(str(name)):
            raise ValueError(f"Invalid persona state module name: {name!r}")
        self.registry.require_current(self.token)
        module_name = str(name)
        module_dir = self.root / module_name
        source = (
            Path(os.path.abspath(os.fspath(Path(legacy_path).expanduser())))
            if legacy_path is not None
            else None
        )

        with self._lock:
            self.registry.require_current(self.token)
            if module_dir.exists():
                self._validate_module_marker(module_dir, module_name)
                status = str(
                    self._manifest.get("modules", {})
                    .get(module_name, {})
                    .get("status", "existing")
                )
            else:
                source_has_payload = source is not None and _has_payload(source)
                if (
                    source_has_payload
                    and self.envelope.fingerprint in self._legacy_fingerprint_allowlist
                ):
                    self._migrate_legacy_module(source, module_dir, module_name)
                    status = "migrated_known_legacy"
                else:
                    status = (
                        "quarantined_unscoped"
                        if source_has_payload
                        else "initialized_empty"
                    )
                    self._initialize_empty_module(module_dir, module_name, status)

            modules = self._manifest.setdefault("modules", {})
            previous = modules.get(module_name)
            record = {
                "status": status,
                "path": module_name,
                "legacy_source_present": bool(source is not None and _has_payload(source)),
                "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            }
            if previous != record:
                modules[module_name] = record
                self._write_root_manifest()

        return PersonaModuleState(
            name=module_name,
            path=module_dir,
            token=self.token,
            registry=self.registry,
            migration_status=status,
        )

    def _load_or_initialize_root(self) -> dict:
        self.registry.require_current(self.token)
        manifest_path = self.root / _ROOT_MANIFEST
        if self.root.exists():
            if not self.root.is_dir() or not manifest_path.is_file():
                raise PersonaStateScopeViolation(
                    "Existing persona state root has no authoritative manifest"
                )
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise PersonaStateScopeViolation(
                    "Persona state manifest is unreadable"
                ) from exc
            self._validate_root_manifest(data)
            stored_version = int(data.get("identity_version", 0) or 0)
            stored_fingerprint = str(data.get("fingerprint", ""))
            if (
                stored_fingerprint != self.envelope.fingerprint
                and self.envelope.version <= stored_version
            ):
                raise PersonaStateScopeViolation(
                    "Changed identity cannot reuse state without a newer identity version"
                )
            data["identity_version"] = self.envelope.version
            data["fingerprint"] = self.envelope.fingerprint
            data["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
            self._manifest = data
            self._write_root_manifest()
            return data

        self.root.parent.mkdir(parents=True, exist_ok=True)
        staging = self.root.parent / f".persona-state-{uuid.uuid4().hex}.tmp"
        staging.mkdir(parents=False, exist_ok=False)
        data = {
            "schema": _SCHEMA,
            "persona_id": self.envelope.persona_id,
            "identity_version": self.envelope.version,
            "fingerprint": self.envelope.fingerprint,
            "modules": {},
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        _atomic_json_write(staging / _ROOT_MANIFEST, data)
        try:
            os.replace(staging, self.root)
        except OSError:
            if staging.exists():
                shutil.rmtree(staging)
            if not manifest_path.is_file():
                raise
            try:
                existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise PersonaStateScopeViolation(
                    "Concurrent persona state initialization was not trustworthy"
                ) from exc
            self._validate_root_manifest(existing)
            return existing
        return data

    def _validate_root_manifest(self, data: object) -> None:
        if not isinstance(data, dict):
            raise PersonaStateScopeViolation("Persona state manifest must be an object")
        if data.get("schema") != _SCHEMA:
            raise PersonaStateScopeViolation("Unsupported persona state manifest schema")
        if data.get("persona_id") != self.envelope.persona_id:
            raise PersonaStateScopeViolation("Persona state root belongs to another identity")
        if not isinstance(data.get("modules", {}), dict):
            raise PersonaStateScopeViolation("Persona state module manifest is invalid")

    def _initialize_empty_module(
        self,
        module_dir: Path,
        module_name: str,
        status: str,
    ) -> None:
        staging = self.root / f".{module_name}-{uuid.uuid4().hex}.tmp"
        staging.mkdir(parents=False, exist_ok=False)
        self._write_module_marker(staging, module_name, status)
        self._publish_module(staging, module_dir, module_name)

    def _migrate_legacy_module(
        self,
        source: Path,
        module_dir: Path,
        module_name: str,
    ) -> None:
        _assert_legacy_source_safe(source)
        staging = self.root / f".{module_name}-{uuid.uuid4().hex}.tmp"
        try:
            if source.is_dir():
                shutil.copytree(source, staging)
            else:
                staging.mkdir(parents=False, exist_ok=False)
                shutil.copy2(source, staging / source.name)
            self._write_module_marker(staging, module_name, "migrated_known_legacy")
            self._publish_module(staging, module_dir, module_name)
        except Exception:
            if staging.exists():
                shutil.rmtree(staging)
            raise

    def _publish_module(
        self,
        staging: Path,
        module_dir: Path,
        module_name: str,
    ) -> None:
        try:
            os.replace(staging, module_dir)
        except OSError:
            if staging.exists():
                shutil.rmtree(staging)
            if not module_dir.is_dir():
                raise
            self._validate_module_marker(module_dir, module_name)

    def _write_module_marker(
        self,
        directory: Path,
        module_name: str,
        status: str,
    ) -> None:
        _atomic_json_write(
            directory / _MODULE_MARKER,
            {
                "schema": _SCHEMA,
                "persona_id": self.envelope.persona_id,
                "module": module_name,
                "migration_status": status,
                "created_at_utc": datetime.now(timezone.utc).isoformat(),
            },
        )

    def _validate_module_marker(self, module_dir: Path, module_name: str) -> None:
        marker = module_dir / _MODULE_MARKER
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PersonaStateScopeViolation(
                f"Persona module {module_name!r} has no valid scope marker"
            ) from exc
        if (
            not isinstance(data, dict)
            or data.get("schema") != _SCHEMA
            or data.get("persona_id") != self.envelope.persona_id
            or data.get("module") != module_name
        ):
            raise PersonaStateScopeViolation(
                f"Persona module {module_name!r} belongs to another scope"
            )

    def _write_root_manifest(self) -> None:
        self.registry.require_current(self.token)
        _atomic_json_write(self.root / _ROOT_MANIFEST, self._manifest)


def _has_payload(path: Path) -> bool:
    if not path.exists():
        return False
    if path.is_file():
        return path.name != ".gitkeep" and path.stat().st_size > 0
    if not path.is_dir():
        return True
    return any(item.name != ".gitkeep" for item in path.iterdir())


def _assert_legacy_source_safe(source: Path) -> None:
    if not source.exists():
        raise FileNotFoundError(source)
    if source.is_symlink() or _is_junction(source):
        raise PersonaStateScopeViolation("Legacy persona state cannot be a link or junction")
    if source.is_file():
        if source.stat().st_size > _MAX_LEGACY_BYTES:
            raise PersonaStateScopeViolation("Legacy persona state exceeds migration size limit")
        return
    if not source.is_dir():
        raise PersonaStateScopeViolation("Legacy persona state is not a regular file or directory")

    file_count = 0
    byte_count = 0
    for root, directories, files in os.walk(source, followlinks=False):
        root_path = Path(root)
        for name in [*directories, *files]:
            child = root_path / name
            if child.is_symlink() or _is_junction(child):
                raise PersonaStateScopeViolation(
                    "Legacy persona state contains a link or junction"
                )
        for name in files:
            child = root_path / name
            file_count += 1
            byte_count += child.stat().st_size
            if file_count > _MAX_LEGACY_FILES or byte_count > _MAX_LEGACY_BYTES:
                raise PersonaStateScopeViolation(
                    "Legacy persona state exceeds migration safety limits"
                )


def _is_junction(path: Path) -> bool:
    checker = getattr(os.path, "isjunction", None)
    return bool(checker(path)) if checker is not None else False


def _atomic_json_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2)
    try:
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
