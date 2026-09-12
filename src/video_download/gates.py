"""The four independent safety gates for video download.

Every outbound video-download request must clear all four, in this order:

1. :func:`check_consent`      — the disclaimer-gated feature flags.
2. :func:`require_remote_ok`  — the offline/local-mode gate.
3. :func:`assert_public_media_url` — per-URL SSRF validation.
4. :class:`SizeGuard` / :func:`check_duration` / :func:`check_quota` — budget.

These mirror the ordering the LLM adapter uses (consent → local_mode →
destination → budget, see ``src/api/adapter.py``) so the whole codebase fails
closed the same way. The gates are deliberately small and independently
testable; the downloader composes them.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse


class VideoDownloadDenied(Exception):
    """Raised when a video-download gate refuses an operation."""


# ── Gate 1: consent (disclaimer-gated feature flags) ──────────────────────


def check_consent(features: object) -> None:
    """Refuse unless the feature is enabled AND the disclaimer acknowledged.

    This is the fail-closed pairing the backend already enforces on settings
    save (``ws_bridge`` features branch) and the frontend surfaces in the
    MvpRoom disclaimer gate. Re-checking here means a download can never run
    from a stale/forced flag: both booleans must be true at call time.
    """
    enabled = bool(getattr(features, "video_download_enabled", False))
    acknowledged = bool(
        getattr(features, "video_download_disclaimer_acknowledged", False)
    )
    if not acknowledged:
        raise VideoDownloadDenied(
            "video download disclaimer has not been acknowledged"
        )
    if not enabled:
        raise VideoDownloadDenied("video download feature is disabled")


# ── Gate 2: offline / local-mode ──────────────────────────────────────────


def require_remote_ok(operation: str = "video download") -> None:
    """Refuse when privacy/local mode blocks non-loopback network access.

    Delegates to the process-wide local-mode gate so video download honours the
    same offline switch as every other outbound feature. Raises the gate's own
    ``LocalModeBlocked`` (a subclass-agnostic caller can also catch
    :class:`VideoDownloadDenied` — we do not translate, to preserve the
    existing error contract).
    """
    from src.local_mode import get_local_mode_gate

    get_local_mode_gate().require_remote(operation)


# ── Gate 3: SSRF / destination validation ─────────────────────────────────


async def assert_public_media_url(url: str) -> None:
    """Validate a media/segment/key URL points at a public http(s) host.

    Mirrors the IP-safety logic of ``src.web._is_public_https_url`` (rejects
    embedded credentials and any host whose literal or resolved addresses are
    not ``is_global`` — covering private, loopback, link-local, CGNAT,
    benchmark and IPv4-mapped IPv6 ranges), but permits both ``http`` and
    ``https`` because HLS media is commonly served over plain HTTP (design
    §3.2, "协议仅 http(s)"). Residual risk: for a plain-HTTP target a hostile
    on-path attacker could tamper with segments, and a resolver that changes
    answers between this check and the connect remains possible; the size/merge
    validation downstream is the backstop.
    """
    if not await _is_public_http_url(url):
        raise VideoDownloadDenied(f"refused non-public or unsafe URL: {url!r}")


async def _is_public_http_url(url: str) -> bool:
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        return False
    if not parsed.hostname or parsed.username or parsed.password:
        return False
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"}:
        return False
    try:
        literal = ipaddress.ip_address(host)
        return literal.is_global
    except ValueError:
        pass
    default_port = 443 if scheme == "https" else 80
    try:
        records = await asyncio.to_thread(
            socket.getaddrinfo,
            host,
            parsed.port or default_port,
            type=socket.SOCK_STREAM,
        )
    except OSError:
        return False
    addresses = {record[4][0] for record in records if record[4]}
    if not addresses:
        return False
    try:
        return all(ipaddress.ip_address(addr).is_global for addr in addresses)
    except ValueError:
        return False


# ── Gate 4: budget (size / duration / running quota) ──────────────────────


@dataclass(frozen=True)
class DownloadLimits:
    """Per-download and cumulative limits sourced from ``FeatureSettings``."""

    max_size_bytes: int
    max_duration_seconds: int
    total_quota_bytes: int

    @classmethod
    def from_features(cls, features: object) -> "DownloadLimits":
        size_mb = int(getattr(features, "video_max_size_mb", 500))
        duration_s = int(getattr(features, "video_max_duration_seconds", 1800))
        quota_mb = int(getattr(features, "video_total_quota_mb", 4096))
        return cls(
            max_size_bytes=size_mb * 1024 * 1024,
            max_duration_seconds=duration_s,
            total_quota_bytes=quota_mb * 1024 * 1024,
        )


def check_duration(total_seconds: float, limits: DownloadLimits) -> None:
    """Refuse a playlist longer than the per-download duration cap.

    Checked up front from the summed ``EXTINF`` values so we never begin
    fetching a multi-hour stream that would blow the size cap mid-way.
    """
    if total_seconds > limits.max_duration_seconds:
        raise VideoDownloadDenied(
            f"video duration {total_seconds:.0f}s exceeds the "
            f"{limits.max_duration_seconds}s limit"
        )


def check_quota(existing_bytes: int, limits: DownloadLimits) -> None:
    """Refuse a new download when the media store already fills the quota."""
    if existing_bytes >= limits.total_quota_bytes:
        raise VideoDownloadDenied(
            "video storage quota is full; delete some videos first"
        )


class SizeGuard:
    """Running byte accountant that aborts a download past the size cap.

    Enforces both the per-download ``max_size_bytes`` and the remaining share
    of the cumulative ``total_quota_bytes`` (given how much is already stored),
    so a single download can neither exceed its own cap nor overflow the store.
    """

    def __init__(self, limits: DownloadLimits, existing_bytes: int = 0) -> None:
        self._limit = min(
            limits.max_size_bytes,
            max(0, limits.total_quota_bytes - existing_bytes),
        )
        self._total = 0

    @property
    def total(self) -> int:
        return self._total

    def add(self, chunk_len: int) -> None:
        self._total += int(chunk_len)
        if self._total > self._limit:
            raise VideoDownloadDenied(
                f"download exceeded the {self._limit} byte size/quota limit"
            )


__all__ = [
    "DownloadLimits",
    "SizeGuard",
    "VideoDownloadDenied",
    "assert_public_media_url",
    "check_consent",
    "check_duration",
    "check_quota",
    "require_remote_ok",
]
