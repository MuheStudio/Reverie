"""Chat VIDEO attachments: validation, content-addressed storage, read-back.

Unlike :mod:`src.chat.media` (images), videos are **not** re-encoded — a
downloaded/merged video is a conversation artifact stored byte-for-byte under
``REVERIE_DATA_DIR/chat-media/video/<sha256>.<ext>`` and referenced by
``media_id`` everywhere else. Re-encoding would need a bundled transcoder,
which the offline-first / open-box red line forbids.

Acceptance is defence-in-depth:

* **MIME whitelist** — only ``video/mp4`` and ``video/webm``, the containers
  Electron's ``<video>`` plays natively.
* **Magic-byte verification** — the container is confirmed from the bytes (mp4
  ``ftyp`` box / WebM EBML header), so a ``.mp4``-named non-video is refused.
* **Size / duration / quota limits** — sourced from ``FeatureSettings`` (the
  disclaimer-gated caps) so a stored video can never exceed what the user
  agreed to.
* **sha256 addressing** — content-addressed, so identical downloads dedupe and
  a ``media_id`` cannot be forged to escape the store directory.

The read-back path is streaming-oriented: :func:`open_video` yields a file
handle + metadata so the transport can stream bytes (Range requests) rather
than base64-inlining a multi-hundred-MB video into a data URL.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import BinaryIO, Optional

MEDIA_ID_RE = re.compile(r"^[A-Fa-f0-9]{64}$")

# MIME → canonical on-disk extension. Kept tiny on purpose: these are the
# containers <video> can play without a bundled codec pack.
ALLOWED_VIDEO_MIME = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}

# Absolute ceiling regardless of settings, so a corrupted config can never let
# an unbounded file through. Mirrors the settings field upper bound (4096 MB).
HARD_MAX_BYTES = 4096 * 1024 * 1024


class ChatVideoError(ValueError):
    """Raised when a video attachment cannot be accepted."""


def _video_dir() -> Path:
    from src.config.settings import DATA_DIR

    return Path(DATA_DIR) / "chat-media" / "video"


def sniff_video_mime(raw: bytes) -> Optional[str]:
    """Return the canonical MIME for a byte payload, or ``None`` if unknown.

    * MP4 / ISO-BMFF: bytes 4–8 are the ``ftyp`` box type.
    * WebM / Matroska: the EBML header ``1A 45 DF A3``.
    """
    if len(raw) < 12:
        return None
    if raw[4:8] == b"ftyp":
        return "video/mp4"
    if raw[0:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    return None


def _limits_from_features(features: object) -> tuple[int, int]:
    """Return ``(max_size_bytes, total_quota_bytes)`` from settings features."""
    size_mb = int(getattr(features, "video_max_size_mb", 500))
    quota_mb = int(getattr(features, "video_total_quota_mb", 4096))
    return size_mb * 1024 * 1024, quota_mb * 1024 * 1024


def current_store_bytes() -> int:
    """Total bytes currently occupied by stored chat videos (for quota checks)."""
    directory = _video_dir()
    if not directory.is_dir():
        return 0
    total = 0
    for child in directory.iterdir():
        if child.is_file() and not child.name.startswith("."):
            try:
                total += child.stat().st_size
            except OSError:
                continue
    return total


def store_video_bytes(
    raw: bytes,
    *,
    declared_mime: Optional[str] = None,
    features: object = None,
    duration_seconds: Optional[float] = None,
) -> dict[str, object]:
    """Validate and persist one video byte-for-byte; return its media record.

    ``declared_mime`` (if given) must agree with the sniffed container. When
    ``features`` is supplied, the per-video size cap, total quota, and duration
    cap are enforced against the disclaimer-gated settings.
    """
    if not raw:
        raise ChatVideoError("empty video payload")
    if len(raw) > HARD_MAX_BYTES:
        raise ChatVideoError("video exceeds the maximum allowed size")

    sniffed = sniff_video_mime(raw)
    if sniffed is None or sniffed not in ALLOWED_VIDEO_MIME:
        raise ChatVideoError("payload is not a supported video (mp4/webm)")
    if declared_mime and declared_mime not in ALLOWED_VIDEO_MIME:
        raise ChatVideoError(f"unsupported video mime: {declared_mime}")
    if declared_mime and declared_mime != sniffed:
        # A mismatch means the container was mislabelled; trust the bytes and
        # refuse rather than store under a lie.
        raise ChatVideoError("declared mime does not match video contents")

    if features is not None:
        max_bytes, quota_bytes = _limits_from_features(features)
        if len(raw) > max_bytes:
            raise ChatVideoError("video exceeds the configured per-video size limit")
        if current_store_bytes() + len(raw) > quota_bytes:
            raise ChatVideoError("storing this video would exceed the total quota")
        if duration_seconds is not None:
            max_duration = int(getattr(features, "video_max_duration_seconds", 1800))
            if duration_seconds > max_duration:
                raise ChatVideoError("video exceeds the configured duration limit")

    extension = ALLOWED_VIDEO_MIME[sniffed]
    digest = hashlib.sha256(raw).hexdigest()
    directory = _video_dir()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{digest}{extension}"
    if not target.exists():
        temporary = directory / f".{digest}.{os.getpid()}.tmp"
        temporary.write_bytes(raw)
        os.replace(temporary, target)
    return {
        "media_id": digest,
        "mime": sniffed,
        "bytes": len(raw),
        "path": str(target),
        "kind": "video",
    }


def store_from_file(
    path: str,
    *,
    features: object = None,
    duration_seconds: Optional[float] = None,
) -> dict[str, object]:
    """Store a merged video from an absolute local path (the downloader output)."""
    if not path or "\x00" in path:
        raise ChatVideoError("invalid video path")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ChatVideoError("video path must be absolute")
    resolved = candidate.resolve()
    if not resolved.is_file():
        raise ChatVideoError("video file not found")
    if resolved.stat().st_size > HARD_MAX_BYTES:
        raise ChatVideoError("video exceeds the maximum allowed size")
    return store_video_bytes(
        resolved.read_bytes(), features=features, duration_seconds=duration_seconds
    )


def _resolve_media_path(media_id: str) -> Path:
    if not MEDIA_ID_RE.fullmatch(media_id or ""):
        raise ChatVideoError("invalid media id")
    directory = _video_dir().resolve()
    lowered = media_id.lower()
    for extension in ALLOWED_VIDEO_MIME.values():
        target = (directory / f"{lowered}{extension}").resolve()
        if target.parent != directory:
            raise ChatVideoError("invalid media id")
        if target.is_file():
            return target
    raise ChatVideoError("video not found")


def video_info(media_id: str) -> dict[str, object]:
    """Return ``{media_id, mime, bytes, path}`` for a stored video."""
    target = _resolve_media_path(media_id)
    extension = target.suffix.lower()
    mime = next(
        (m for m, ext in ALLOWED_VIDEO_MIME.items() if ext == extension),
        "application/octet-stream",
    )
    return {
        "media_id": media_id.lower(),
        "mime": mime,
        "bytes": target.stat().st_size,
        "path": str(target),
    }


def open_video(media_id: str) -> tuple[BinaryIO, dict[str, object]]:
    """Open a stored video for streaming read; return ``(handle, info)``.

    The caller owns the handle and must close it. Streaming keeps a large video
    off the base64/data-URL path entirely.
    """
    info = video_info(media_id)
    handle = open(info["path"], "rb")  # noqa: SIM115 — caller-owned handle
    return handle, info


__all__ = [
    "ALLOWED_VIDEO_MIME",
    "ChatVideoError",
    "current_store_bytes",
    "open_video",
    "sniff_video_mime",
    "store_from_file",
    "store_video_bytes",
    "video_info",
]
