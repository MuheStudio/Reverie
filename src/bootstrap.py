"""Local-first startup helpers and lazy optional capability registration.

Nothing in this module imports an optional subsystem at module-import time.
That property is deliberate: a missing plugin, cloud package, image service, or
background feature must not prevent the persona kernel and local chat history
from starting.
"""

from __future__ import annotations

import importlib
import logging
from typing import Any, Callable, Mapping

from .config.capabilities import CapabilityRegistry

logger = logging.getLogger("reverie.bootstrap")


OPTIONAL_CAPABILITY_MODULES: dict[str, str] = {
    "proactive_chat": "src.chat.proactive",
    "diary": "src.diary",
    "timeline": "src.timeline",
    "web": "src.web",
}


class LocalOnlyCloudFallback:
    """Cloud-shaped no-op used even when the cloud package cannot import."""

    def __init__(self, reason: str = "") -> None:
        self.reason = str(reason)[:500]

    def get_status(self) -> str:
        return "local"

    async def sync_memory(self, _memory_data: dict[str, Any]) -> bool:
        return True

    async def sync_backup(self, _backup_data: dict[str, Any]) -> bool:
        return True

    async def restore(self) -> None:
        return None


class _UnavailableRuntimeCapability:
    """False-y runtime placeholder with an explicit diagnostic reason."""

    available = False

    def __init__(self, reason: str) -> None:
        self.unavailable_reason = str(reason)[:500]

    def __bool__(self) -> bool:
        return False


class UnavailableDiary(_UnavailableRuntimeCapability):
    privacy_enabled = False
    peek_enabled = False
    usage_policy = None
    emotion = None

    def export_all(self) -> dict[str, Any]:
        return {"entries": [], "missed": [], "unavailable": True}

    def import_all(self, payload: dict[str, Any]) -> int:
        if payload.get("entries") or payload.get("missed"):
            raise RuntimeError("Diary restore refused while the diary capability is unavailable")
        return 0

    def list_entries_with_metadata(self, **_kwargs: Any) -> list[Any]:
        return []

    def get_recent_entries(self, _limit: int = 1) -> list[Any]:
        return []

    def list_missed(self) -> list[str]:
        return []

    def load_entry(self, _date: str) -> None:
        return None

    def privacy_status(self, **_kwargs: Any) -> str:
        return "Diary capability unavailable"

    def can_peek(self, **_kwargs: Any) -> bool:
        return False

    def record_missed(self, _event_date: str) -> None:
        return None

    def discard_missed(self) -> int:
        return 0

    def record_external_highlight(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def handle_sleep_event(self, *_args: Any, **_kwargs: Any) -> list[Any]:
        return []


class UnavailableTimeline(_UnavailableRuntimeCapability):
    feature_settings = None

    def export_all(self) -> dict[str, Any]:
        return {"posts": [], "unavailable": True}

    def import_all(self, payload: dict[str, Any]) -> int:
        if payload.get("posts"):
            raise RuntimeError("Timeline restore refused while timeline is unavailable")
        return 0

    def get_recent(self, _limit: int = 20) -> list[Any]:
        return []

    def record_event_fact(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def maybe_generate(self) -> None:
        return None


class UnavailableProactiveChat(_UnavailableRuntimeCapability):
    running = False
    late_night_enabled = False
    late_night_probability = 0.0
    manage_status = False
    daily_limit = 0
    min_interval_minutes = 0
    event_stories_enabled = False
    local_reflex_probability = 0.0
    web_surfing = None

    def start(self) -> None:
        return None

    def stop(self) -> None:
        return None

    def drain_pending(self) -> list[Any]:
        return []

    def mark_user_replied(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    async def enqueue_late_night_checkin(self, **_kwargs: Any) -> bool:
        return False


class UnavailableBackupManager(_UnavailableRuntimeCapability):
    """Avoid claiming a complete backup when a required section is absent."""

    def recover_interrupted_restore(self) -> bool:
        return False

    def checkpoint(self) -> None:
        return None

    def export_payload(self) -> dict[str, Any]:
        raise RuntimeError(self.unavailable_reason)

    def import_payload(self, *_args: Any, **_kwargs: Any) -> dict[str, int]:
        raise RuntimeError(self.unavailable_reason)


def create_cloud_service_or_local(mode: str = "local") -> Any:
    """Load cloud support lazily and fail closed to local-only storage."""

    try:
        module = importlib.import_module("src.cloud")
        factory = getattr(module, "create_cloud_service")
        return factory(mode)
    except Exception as exc:
        logger.warning("Cloud capability unavailable; continuing local-only: %s", exc)
        return LocalOnlyCloudFallback(f"{type(exc).__name__}: {exc}")


def optional_symbol(
    module_name: str,
    symbol_name: str,
    *,
    default: Any = None,
) -> Any:
    """Resolve one optional symbol without allowing import failure to escape."""

    try:
        return getattr(importlib.import_module(module_name), symbol_name)
    except Exception as exc:
        logger.warning(
            "Optional symbol %s.%s unavailable: %s",
            module_name,
            symbol_name,
            exc,
        )
        return default


def build_optional_capability_registry(
    *,
    identity_provider: Callable[[], Any] | None = None,
    enabled: Mapping[str, bool] | None = None,
    modules: Mapping[str, str] | None = None,
) -> CapabilityRegistry:
    """Register optional subsystems without importing any of them."""

    registry = CapabilityRegistry(identity_provider=identity_provider)
    enabled_map = dict(enabled or {})
    for name, module_name in dict(modules or OPTIONAL_CAPABILITY_MODULES).items():
        registry.register_module(
            name,
            module_name,
            enabled=enabled_map.get(name, True),
        )
    return registry
