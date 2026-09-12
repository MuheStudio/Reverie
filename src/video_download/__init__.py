"""Native video download pipeline (disclaimer-gated, offline-first).

This package is Reverie's own implementation of the sniff → HLS-parse →
concurrent-download → local-merge flow. It is *inspired by* the vendored
cat-catch browser extension (GPL-3.0, ``src/download_service/``) but shares no
runtime code with it and deliberately drops cat-catch's two external-server
dependencies (hosted ffmpeg / StreamSaver MITM): merging is a local, pure
binary concatenation with zero external binaries.

Every outbound request in this package must pass four independent gates,
enforced in :mod:`src.video_download.gates`:

1. consent   — ``features.video_download_enabled`` + acknowledged disclaimer
2. local_mode — ``get_local_mode_gate().require_remote(...)`` (offline gate)
3. SSRF       — per-URL public-http(s) validation (no loopback/private/link-local)
4. budget     — per-download size / duration / running-quota limits

The compliance disclaimer is the user's consent (see the MvpRoom settings
gate). This package must never bundle or invoke DRM circumvention: a playlist
whose key METHOD is anything other than ``NONE`` / ``AES-128`` is refused.
"""

from __future__ import annotations

from src.video_download.gates import (
    DownloadLimits,
    VideoDownloadDenied,
)
from src.video_download.hls import (
    HlsError,
    MediaPlaylist,
    MasterPlaylist,
    Segment,
    SegmentKey,
    VariantStream,
    parse_playlist,
    resolve_url,
)
from src.video_download.pipeline import (
    PipelineResult,
    download_video,
)

__all__ = [
    "DownloadLimits",
    "HlsError",
    "MediaPlaylist",
    "MasterPlaylist",
    "PipelineResult",
    "Segment",
    "SegmentKey",
    "VariantStream",
    "VideoDownloadDenied",
    "download_video",
    "parse_playlist",
    "resolve_url",
]
