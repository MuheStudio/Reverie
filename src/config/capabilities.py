"""Fault-isolated capability registry for optional Reverie modules.

The registry is intentionally independent from the persona identity kernel.
Optional modules are loaded lazily, may be absent from an installation, and
may fail during startup or calls without replacing or mutating core identity.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

logger = logging.getLogger("reverie.capabilities")


class CapabilityState(str, Enum):
    REGISTERED = "registered"
    DISABLED = "disabled"
    READY = "ready"
    UNAVAILABLE = "unavailable"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass
class CapabilityRecord:
    name: str
    loader: Callable[[], Any]
    enabled: bool = True
    instance: Any = None
    state: CapabilityState = CapabilityState.REGISTERED
    error: str = ""
    failures: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


class CapabilityUnavailable(RuntimeError):
    pass


class CapabilityRegistry:
    """Own optional modules behind narrow, failure-containing boundaries."""

    def __init__(self, *, identity_provider: Callable[[], Any] | None = None) -> None:
        self._records: dict[str, CapabilityRecord] = {}
        self._lock = threading.RLock()
        self._identity_provider = identity_provider

    def register(
        self,
        name: str,
        loader: Callable[[], Any],
        *,
        enabled: bool = True,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        key = self._normalize_name(name)
        with self._lock:
            if key in self._records:
                raise ValueError(f"Capability already registered: {key}")
            self._records[key] = CapabilityRecord(
                name=key,
                loader=loader,
                enabled=bool(enabled),
                state=CapabilityState.REGISTERED if enabled else CapabilityState.DISABLED,
                metadata=dict(metadata or {}),
            )

    def register_module(
        self,
        name: str,
        module_name: str,
        factory_name: str | None = None,
        *,
        enabled: bool = True,
    ) -> None:
        """Register an optional import without importing it at application boot."""

        def loader() -> Any:
            module = importlib.import_module(module_name)
            return getattr(module, factory_name)() if factory_name else module

        self.register(
            name,
            loader,
            enabled=enabled,
            metadata={"module": module_name, "factory": factory_name or ""},
        )

    def start(self, name: str) -> Any | None:
        key = self._normalize_name(name)
        with self._lock:
            record = self._require_record(key)
            if not record.enabled:
                record.state = CapabilityState.DISABLED
                return None
            if record.state == CapabilityState.READY:
                return record.instance
            loader = record.loader
        try:
            instance = loader()
            start = getattr(instance, "start", None)
            if callable(start):
                result = start()
                if inspect.isawaitable(result):
                    raise TypeError("Async capability start must be performed by start_async")
        except ModuleNotFoundError as exc:
            self._mark_failure(key, CapabilityState.UNAVAILABLE, exc)
            return None
        except Exception as exc:
            self._mark_failure(key, CapabilityState.FAILED, exc)
            return None
        with self._lock:
            record = self._require_record(key)
            record.instance = instance
            record.state = CapabilityState.READY
            record.error = ""
        return instance

    async def start_async(self, name: str) -> Any | None:
        key = self._normalize_name(name)
        with self._lock:
            record = self._require_record(key)
            if not record.enabled:
                record.state = CapabilityState.DISABLED
                return None
            if record.state == CapabilityState.READY:
                return record.instance
            loader = record.loader
        try:
            instance = loader()
            if inspect.isawaitable(instance):
                instance = await instance
            start = getattr(instance, "start", None)
            if callable(start):
                result = start()
                if inspect.isawaitable(result):
                    await result
        except ModuleNotFoundError as exc:
            self._mark_failure(key, CapabilityState.UNAVAILABLE, exc)
            return None
        except Exception as exc:
            self._mark_failure(key, CapabilityState.FAILED, exc)
            return None
        with self._lock:
            record = self._require_record(key)
            record.instance = instance
            record.state = CapabilityState.READY
            record.error = ""
        return instance

    def call(self, name: str, method: str, *args: Any, default: Any = None, **kwargs: Any) -> Any:
        """Invoke one capability; failures are contained and return ``default``."""

        instance = self.start(name)
        if instance is None:
            return default
        try:
            target = getattr(instance, method)
            result = target(*args, **kwargs)
            if inspect.isawaitable(result):
                raise TypeError("Async capability method must be invoked with call_async")
            return result
        except Exception as exc:
            self._mark_failure(self._normalize_name(name), CapabilityState.FAILED, exc)
            return default

    async def call_async(
        self,
        name: str,
        method: str,
        *args: Any,
        default: Any = None,
        **kwargs: Any,
    ) -> Any:
        instance = await self.start_async(name)
        if instance is None:
            return default
        try:
            result = getattr(instance, method)(*args, **kwargs)
            return await result if inspect.isawaitable(result) else result
        except Exception as exc:
            self._mark_failure(self._normalize_name(name), CapabilityState.FAILED, exc)
            return default

    def set_enabled(self, name: str, enabled: bool) -> None:
        key = self._normalize_name(name)
        if not enabled:
            self.stop(key)
        with self._lock:
            record = self._require_record(key)
            record.enabled = bool(enabled)
            record.state = CapabilityState.REGISTERED if enabled else CapabilityState.DISABLED
            if enabled:
                record.error = ""

    def stop(self, name: str) -> None:
        key = self._normalize_name(name)
        with self._lock:
            record = self._require_record(key)
            instance = record.instance
            record.instance = None
        if instance is not None:
            try:
                stop = getattr(instance, "stop", None) or getattr(instance, "close", None)
                if callable(stop):
                    result = stop()
                    if inspect.isawaitable(result):
                        logger.warning("Async stop skipped for capability %s; use stop_async", key)
            except Exception:
                logger.exception("Capability %s failed while stopping", key)
        with self._lock:
            record.state = CapabilityState.STOPPED

    def identity_snapshot(self) -> Any:
        """Core identity is read independently of every optional capability."""

        if self._identity_provider is None:
            raise CapabilityUnavailable("No identity provider configured")
        return self._identity_provider()

    def status(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {
                name: {
                    "enabled": record.enabled,
                    "state": record.state.value,
                    "error": record.error,
                    "failures": record.failures,
                    "metadata": dict(record.metadata),
                }
                for name, record in self._records.items()
            }

    def _mark_failure(self, key: str, state: CapabilityState, exc: Exception) -> None:
        with self._lock:
            record = self._require_record(key)
            record.instance = None
            record.state = state
            record.error = f"{type(exc).__name__}: {exc}"[:500]
            record.failures += 1
        logger.warning("Optional capability %s isolated after failure: %s", key, exc)

    def _require_record(self, key: str) -> CapabilityRecord:
        try:
            return self._records[key]
        except KeyError as exc:
            raise CapabilityUnavailable(f"Capability is not registered: {key}") from exc

    @staticmethod
    def _normalize_name(name: str) -> str:
        value = str(name).strip().lower().replace("-", "_")
        if not value or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789_" for ch in value):
            raise ValueError("Capability name must be a non-empty ASCII identifier")
        return value

