"""End-to-end video download orchestration: fetch → parse → download → merge.

This is the single entry point the bridge calls. It ties the pure pieces
together and keeps every network fetch behind the four gates:

* consent is checked once, up front, against the live settings features;
* the manifest fetch, every segment/key fetch, and any direct-file fetch all
  run the offline + SSRF gates per request (in the downloader / here);
* size + duration + quota are enforced continuously.

It supports two source kinds, dispatched by content:

* **HLS** (``.m3u8`` / ``application/vnd.apple.mpegurl``): parse, resolve a
  master playlist to its best variant, download + decrypt + merge.
* **Direct** (``.mp4`` / ``.webm``): a single bounded, gated GET.

The merged bytes are written to a temp file and returned; the caller stores
them via :mod:`src.chat.video_media` (which re-validates by magic bytes).
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import Optional

import httpx

from src.video_download.downloader import HlsDownloader, ProgressCallback
from src.video_download.gates import (
    DownloadLimits,
    SizeGuard,
    VideoDownloadDenied,
    assert_public_media_url,
    check_consent,
    require_remote_ok,
)
from src.video_download.hls import (
    MasterPlaylist,
    MediaPlaylist,
    parse_playlist,
)
from src.video_download.merge import guess_extension, merge_to_file

CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 60.0
MAX_MANIFEST_BYTES = 8 * 1024 * 1024  # A playlist this large is pathological.


@dataclass
class PipelineResult:
    """Outcome of a successful download: a temp file plus basic metadata."""

    path: str
    total_bytes: int
    duration_seconds: float
    is_hls: bool


def _looks_like_hls(url: str, content_type: str) -> bool:
    lowered = url.split("?", 1)[0].lower()
    if lowered.endswith(".m3u8"):
        return True
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    return ct in {"application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"}


async def _fetch_text(client: httpx.AsyncClient, url: str) -> tuple[str, str]:
    require_remote_ok("video manifest")
    await assert_public_media_url(url)
    response = await client.get(url)
    if response.status_code >= 300:
        raise VideoDownloadDenied(f"manifest fetch failed: HTTP {response.status_code}")
    if len(response.content) > MAX_MANIFEST_BYTES:
        raise VideoDownloadDenied("manifest exceeds the maximum allowed size")
    content_type = response.headers.get("content-type", "")
    return response.text, content_type


async def _download_direct(
    client: httpx.AsyncClient,
    url: str,
    limits: DownloadLimits,
    existing_bytes: int,
    on_progress: Optional[ProgressCallback],
) -> bytes:
    """Stream a single direct mp4/webm through the offline + SSRF + size gates."""
    require_remote_ok("video download")
    await assert_public_media_url(url)
    guard = SizeGuard(limits, existing_bytes=existing_bytes)
    chunks: list[bytes] = []
    async with client.stream("GET", url) as response:
        if response.status_code >= 300:
            raise VideoDownloadDenied(f"video fetch failed: HTTP {response.status_code}")
        async for chunk in response.aiter_bytes():
            guard.add(len(chunk))
            chunks.append(chunk)
            if on_progress is not None:
                on_progress(guard.total, 0)
    if not chunks:
        raise VideoDownloadDenied("video response was empty")
    return b"".join(chunks)


async def download_video(
    source_url: str,
    features: object,
    *,
    existing_bytes: int = 0,
    on_progress: Optional[ProgressCallback] = None,
    client: Optional[httpx.AsyncClient] = None,
    temp_dir: Optional[str] = None,
) -> PipelineResult:
    """Download ``source_url`` to a merged temp file after all four gates.

    ``features`` is the live ``settings.features`` object; consent (enabled +
    acknowledged disclaimer) is checked first and raises
    :class:`VideoDownloadDenied` when not satisfied.
    """
    check_consent(features)
    limits = DownloadLimits.from_features(features)

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(READ_TIMEOUT, connect=CONNECT_TIMEOUT),
            headers={"User-Agent": "Reverie/1.0"},
        )

    try:
        # Peek the source: HLS manifests are text and small; direct files are
        # binary. We decide by extension first, then by a manifest fetch.
        is_hls = _looks_like_hls(source_url, "")
        duration_seconds = 0.0
        merged_ext = ".mp4"

        if is_hls or source_url.split("?", 1)[0].lower().endswith(".m3u8"):
            text, _ct = await _fetch_text(client, source_url)
            playlist = parse_playlist(text, source_url)
            if isinstance(playlist, MasterPlaylist):
                best = playlist.best_by_bandwidth()
                if best is None:
                    raise VideoDownloadDenied("master playlist has no variants")
                text, _ct = await _fetch_text(client, best.uri)
                playlist = parse_playlist(text, best.uri)
                if not isinstance(playlist, MediaPlaylist):
                    raise VideoDownloadDenied("variant did not resolve to a media playlist")
            assert isinstance(playlist, MediaPlaylist)
            duration_seconds = playlist.total_duration
            async with HlsDownloader(
                limits, existing_bytes=existing_bytes, client=client
            ) as downloader:
                result = await downloader.download(playlist, on_progress=on_progress)
            merged_ext = guess_extension(result)
            fd, temp_path = tempfile.mkstemp(suffix=merged_ext, dir=temp_dir)
            os.close(fd)
            written = merge_to_file(result, temp_path)
            return PipelineResult(
                path=temp_path,
                total_bytes=written,
                duration_seconds=duration_seconds,
                is_hls=True,
            )

        # Direct file.
        raw = await _download_direct(client, source_url, limits, existing_bytes, on_progress)
        lowered = source_url.split("?", 1)[0].lower()
        merged_ext = ".webm" if lowered.endswith(".webm") else ".mp4"
        fd, temp_path = tempfile.mkstemp(suffix=merged_ext, dir=temp_dir)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
        return PipelineResult(
            path=temp_path,
            total_bytes=len(raw),
            duration_seconds=0.0,
            is_hls=False,
        )
    finally:
        if owns_client:
            await client.aclose()


__all__ = ["PipelineResult", "download_video"]
