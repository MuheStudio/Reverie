"""Cloud service abstraction layer.

Only the local-only implementation is active today. Cloud mode is accepted as a
future-facing setting, but it degrades explicitly to local-only until the real
service exists.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger("reverie.cloud")


class CloudService(ABC):
    """Abstract interface for cloud sync and backup services."""

    @abstractmethod
    def get_status(self) -> str:
        """Return human-readable service status."""
        ...

    @abstractmethod
    async def sync_memory(self, memory_data: dict[str, Any]) -> bool:
        """Sync local memory data to the cloud. Returns True on success."""
        ...

    @abstractmethod
    async def sync_backup(self, backup_data: dict[str, Any]) -> bool:
        """Sync a full backup to the cloud. Returns True on success."""
        ...

    @abstractmethod
    async def restore(self) -> dict[str, Any] | None:
        """Restore the latest backup from the cloud."""
        ...


class LocalOnly(CloudService):
    """No-op cloud service; all data stays local."""

    def get_status(self) -> str:
        return "local"

    async def sync_memory(self, memory_data: dict[str, Any]) -> bool:
        logger.debug("Cloud sync disabled; data is local only")
        return True

    async def sync_backup(self, backup_data: dict[str, Any]) -> bool:
        logger.debug("Cloud backup disabled; data is local only")
        return True

    async def restore(self) -> dict[str, Any] | None:
        logger.debug("Cloud restore disabled")
        return None


class OfficialCloud(CloudService):
    """Placeholder for the future official Reverie Cloud service."""

    def __init__(self) -> None:
        raise NotImplementedError(
            "OfficialCloud is under development. Use LocalOnly for now."
        )

    def get_status(self) -> str:
        return "cloud (under development)"

    async def sync_memory(self, memory_data: dict[str, Any]) -> bool:
        raise NotImplementedError("OfficialCloud is under development.")

    async def sync_backup(self, backup_data: dict[str, Any]) -> bool:
        raise NotImplementedError("OfficialCloud is under development.")

    async def restore(self) -> dict[str, Any] | None:
        raise NotImplementedError("OfficialCloud is under development.")


def create_cloud_service(mode: str = "local") -> CloudService:
    """Create the configured cloud service, explicitly degrading unsupported modes."""
    if mode == "cloud":
        logger.warning("OfficialCloud is not available yet; falling back to local-only mode")
    return LocalOnly()
