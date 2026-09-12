"""Concurrent HLS/direct downloader with AES-128 decryption and four gates.

Design constraints (待实施计划 §3.2–3.4):

* ``asyncio.Semaphore(<=6)`` bounded concurrency, per-segment retry with
  exponential backoff, and a cancellation-friendly structure.
* Every outbound request passes the four gates (consent already checked by the
  caller once; local-mode + SSRF are re-checked per URL here; the size cap runs
  continuously through :class:`SizeGuard`).
* ``trust_env=False`` and ``follow_redirects=False`` so ambient proxies are
  ignored and every redirect target would have to be re-validated (we simply
  refuse redirects for segments/keys — media CDNs serve 200s).
* AES-128-CBC decryption only, using keys fetched from the (validated) key URI.
  ``SAMPLE-AES``/DRM never reach here — the parser refuses them.
* Segments are fetched concurrently but assembled in playlist order; the raw
  ordered byte buffers are returned for the merge step (P0-4) to write to disk.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

import httpx

from src.video_download.gates import (
    DownloadLimits,
    SizeGuard,
    VideoDownloadDenied,
    assert_public_media_url,
    check_duration,
    require_remote_ok,
)
from src.video_download.hls import (
    InitSection,
    MediaPlaylist,
    Segment,
    SegmentKey,
)

MAX_CONCURRENCY = 6
MAX_RETRIES = 3
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 60.0
MAX_KEY_BYTES = 64  # An AES-128 key is 16 bytes; anything larger is bogus.

ProgressCallback = Callable[[int, int], None]


@dataclass
class DownloadResult:
    """The ordered, decrypted output of a media playlist download."""

    init_bytes: Optional[bytes]
    segment_buffers: list[bytes]
    total_bytes: int
    is_fmp4: bool


def _decrypt_aes128(data: bytes, key: bytes, iv: bytes) -> bytes:
    """AES-128-CBC decrypt one segment, removing PKCS#7 padding when present.

    HLS segments are AES-128-CBC (RFC 8216 §5.2). We strip a trailing PKCS#7
    pad only when it is self-consistent; MPEG-TS payloads are not always padded
    (some packagers cipher whole 188-byte-aligned payloads), so an
    inconsistent trailer is left untouched rather than corrupting the stream.
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    plaintext = decryptor.update(data) + decryptor.finalize()
    if plaintext:
        pad = plaintext[-1]
        if 1 <= pad <= 16 and len(plaintext) >= pad and plaintext[-pad:] == bytes([pad]) * pad:
            plaintext = plaintext[:-pad]
    return plaintext


class HlsDownloader:
    """Downloads a parsed media playlist to ordered in-memory buffers.

    The caller is responsible for the consent gate (checked once against the
    live settings) and for persisting the returned bytes via the merge step.
    This class enforces the remaining per-request gates.
    """

    def __init__(
        self,
        limits: DownloadLimits,
        *,
        existing_bytes: int = 0,
        client: Optional[httpx.AsyncClient] = None,
        concurrency: int = MAX_CONCURRENCY,
    ) -> None:
        self._limits = limits
        self._guard = SizeGuard(limits, existing_bytes=existing_bytes)
        self._client = client
        self._owns_client = client is None
        self._semaphore = asyncio.Semaphore(max(1, min(concurrency, MAX_CONCURRENCY)))
        self._key_cache: dict[str, bytes] = {}
        self._key_lock = asyncio.Lock()

    async def __aenter__(self) -> "HlsDownloader":
        if self._client is None:
            self._client = httpx.AsyncClient(
                trust_env=False,
                follow_redirects=False,
                timeout=httpx.Timeout(READ_TIMEOUT, connect=CONNECT_TIMEOUT),
                headers={"User-Agent": "Reverie/1.0"},
            )
        return self

    async def __aexit__(self, *_exc: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _get(self, url: str, *, headers: Optional[dict[str, str]] = None) -> bytes:
        """Fetch one URL after re-validating both the offline and SSRF gates."""
        require_remote_ok("video download")
        await assert_public_media_url(url)
        assert self._client is not None
        last_error: Optional[Exception] = None
        for attempt in range(MAX_RETRIES):
            try:
                response = await self._client.get(url, headers=headers)
                if response.status_code >= 300:
                    raise VideoDownloadDenied(
                        f"segment fetch failed: HTTP {response.status_code} for {url!r}"
                    )
                return response.content
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_error = exc
                if attempt < MAX_RETRIES - 1:
                    await asyncio.sleep(0.5 * (2 ** attempt))
        raise VideoDownloadDenied(
            f"segment fetch failed after {MAX_RETRIES} attempts: {last_error}"
        )

    async def _fetch_key(self, key: SegmentKey) -> bytes:
        async with self._key_lock:
            cached = self._key_cache.get(key.uri)
        if cached is not None:
            return cached
        raw = await self._get(key.uri)
        if not raw or len(raw) > MAX_KEY_BYTES:
            raise VideoDownloadDenied("AES key response is not a valid key")
        if len(raw) != 16:
            raise VideoDownloadDenied("AES-128 key must be exactly 16 bytes")
        async with self._key_lock:
            self._key_cache[key.uri] = raw
        return raw

    @staticmethod
    def _range_header(segment_or_init: Segment | InitSection) -> Optional[dict[str, str]]:
        br = segment_or_init.byte_range
        if br is None:
            return None
        return {"Range": f"bytes={br.offset}-{br.offset + br.length - 1}"}

    async def _fetch_segment(self, index: int, segment: Segment) -> tuple[int, bytes]:
        async with self._semaphore:
            payload = await self._get(segment.uri, headers=self._range_header(segment))
            if segment.key is not None:
                key_bytes = await self._fetch_key(segment.key)
                payload = _decrypt_aes128(payload, key_bytes, segment.key.iv)
            # Size accounting happens on decrypted bytes: that is what lands on
            # disk. The guard raises the moment the running total crosses the
            # per-download / remaining-quota limit.
            self._guard.add(len(payload))
            return index, payload

    async def download(
        self,
        playlist: MediaPlaylist,
        *,
        on_progress: Optional[ProgressCallback] = None,
    ) -> DownloadResult:
        """Fetch every segment concurrently, decrypt, and return in order."""
        if not playlist.segments:
            raise VideoDownloadDenied("playlist contains no segments")
        check_duration(playlist.total_duration, self._limits)

        init_bytes: Optional[bytes] = None
        if playlist.init_section is not None:
            init_bytes = await self._get(
                playlist.init_section.uri,
                headers=self._range_header(playlist.init_section),
            )
            self._guard.add(len(init_bytes))

        total = len(playlist.segments)
        buffers: list[Optional[bytes]] = [None] * total
        completed = 0

        async def run(index: int, segment: Segment) -> None:
            nonlocal completed
            idx, data = await self._fetch_segment(index, segment)
            buffers[idx] = data
            completed += 1
            if on_progress is not None:
                on_progress(completed, total)

        tasks = [asyncio.create_task(run(i, seg)) for i, seg in enumerate(playlist.segments)]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

        ordered = [buf for buf in buffers if buf is not None]
        if len(ordered) != total:
            raise VideoDownloadDenied("one or more segments failed to download")

        return DownloadResult(
            init_bytes=init_bytes,
            segment_buffers=ordered,
            total_bytes=self._guard.total,
            is_fmp4=playlist.is_fmp4,
        )


async def download_media_playlist(
    playlist: MediaPlaylist,
    limits: DownloadLimits,
    *,
    existing_bytes: int = 0,
    on_progress: Optional[ProgressCallback] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> DownloadResult:
    """Convenience wrapper: download a parsed media playlist end to end."""
    async with HlsDownloader(
        limits, existing_bytes=existing_bytes, client=client
    ) as downloader:
        return await downloader.download(playlist, on_progress=on_progress)


__all__ = [
    "DownloadResult",
    "HlsDownloader",
    "download_media_playlist",
]
