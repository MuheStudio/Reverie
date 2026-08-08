"""Failure-isolated capability module registry."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
import logging
import threading
from typing import Protocol, runtime_checkable

from .contracts import DomainEventV4
from .storage import KernelStore


logger = logging.getLogger("reverie.kernel.modules")


class ModuleState(StrEnum):
    REGISTERED = "registered"
    RUNNING = "running"
    DISABLED = "disabled"
    DEGRADED = "degraded"
    STOPPED = "stopped"


@dataclass(frozen=True)
class CapabilityManifest:
    module_id: str
    version: str
    api_consuming: bool = False
    default_enabled: bool = True
    dependencies: tuple[str, ...] = ()
    data_permissions: tuple[str, ...] = ()


@runtime_checkable
class CapabilityModule(Protocol):
    manifest: CapabilityManifest

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def handle_event(self, event: DomainEventV4) -> None: ...

    def health(self) -> dict: ...


@dataclass
class ModuleStatus:
    module_id: str
    state: ModuleState
    failures: int = 0
    last_error_code: str = ""
    last_error_at_utc: str = ""
    details: dict = field(default_factory=dict)


class ModuleRegistry:
    """Catches every feature failure before it reaches the persona kernel."""

    def __init__(self, store: KernelStore) -> None:
        self.store = store
        self._modules: dict[str, CapabilityModule] = {}
        self._status: dict[str, ModuleStatus] = {}
        self._lock = threading.RLock()

    def register(self, module: CapabilityModule) -> None:
        manifest = module.manifest
        if not manifest.module_id or manifest.module_id in self._modules:
            raise ValueError("module id is empty or already registered")
        with self._lock:
            self._modules[manifest.module_id] = module
            self._status[manifest.module_id] = ModuleStatus(
                module_id=manifest.module_id,
                state=(
                    ModuleState.REGISTERED
                    if manifest.default_enabled
                    else ModuleState.DISABLED
                ),
            )

    def start(self, module_id: str) -> ModuleStatus:
        module = self._require(module_id)
        with self._lock:
            status = self._status[module_id]
            if status.state == ModuleState.RUNNING:
                return self.status(module_id)
            try:
                module.start()
                status.state = ModuleState.RUNNING
                status.last_error_code = ""
                status.details = self._safe_health(module)
            except Exception as error:
                self._degrade(status, error)
            return self.status(module_id)

    def stop(self, module_id: str, *, disable: bool = False) -> ModuleStatus:
        module = self._require(module_id)
        with self._lock:
            status = self._status[module_id]
            try:
                module.stop()
            except Exception as error:
                logger.warning("Capability module stop failed: %s", module_id, exc_info=error)
            status.state = ModuleState.DISABLED if disable else ModuleState.STOPPED
            return self.status(module_id)

    def retry(self, module_id: str) -> ModuleStatus:
        with self._lock:
            status = self._status.get(module_id)
            if status is None:
                raise KeyError(module_id)
            if status.state != ModuleState.DEGRADED:
                return self.status(module_id)
        return self.start(module_id)

    def dispatch_pending(
        self,
        module_id: str,
        persona_id: str,
        *,
        batch_size: int = 100,
    ) -> int:
        module = self._require(module_id)
        with self._lock:
            status = self._status[module_id]
            if status.state != ModuleState.RUNNING:
                return 0
        sequence = self.store.checkpoint(module_id, persona_id)
        processed = 0
        for event_sequence, event in self.store.events_after(
            persona_id,
            sequence=sequence,
            limit=batch_size,
        ):
            try:
                module.handle_event(event)
                self.store.save_checkpoint(module_id, persona_id, event_sequence)
                processed += 1
            except Exception as error:
                with self._lock:
                    self._degrade(status, error)
                break
        return processed

    def status(self, module_id: str) -> ModuleStatus:
        with self._lock:
            value = self._status.get(module_id)
            if value is None:
                raise KeyError(module_id)
            return ModuleStatus(
                module_id=value.module_id,
                state=value.state,
                failures=value.failures,
                last_error_code=value.last_error_code,
                last_error_at_utc=value.last_error_at_utc,
                details=dict(value.details),
            )

    def statuses(self) -> list[ModuleStatus]:
        with self._lock:
            ids = tuple(self._status)
        return [self.status(module_id) for module_id in ids]

    def _require(self, module_id: str) -> CapabilityModule:
        with self._lock:
            module = self._modules.get(module_id)
        if module is None:
            raise KeyError(module_id)
        return module

    @staticmethod
    def _safe_health(module: CapabilityModule) -> dict:
        try:
            result = module.health()
            return dict(result) if isinstance(result, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _degrade(status: ModuleStatus, error: Exception) -> None:
        status.state = ModuleState.DEGRADED
        status.failures += 1
        status.last_error_code = error.__class__.__name__
        status.last_error_at_utc = datetime.now(timezone.utc).isoformat()
        status.details = {}
        logger.exception("Capability module degraded: %s", status.module_id, exc_info=error)
