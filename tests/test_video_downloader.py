"""Gates + concurrent downloader + AES-128 tests (src/video_download)."""

import asyncio

import httpx
import pytest

from src.video_download.downloader import (
    HlsDownloader,
    _decrypt_aes128,
    download_media_playlist,
)
from src.video_download.gates import (
    DownloadLimits,
    SizeGuard,
    VideoDownloadDenied,
    assert_public_media_url,
    check_consent,
    check_duration,
    check_quota,
)
from src.video_download.hls import parse_media

BASE = "https://cdn.example.com/v/index.m3u8"


class _Features:
    def __init__(self, **kw):
        self.video_download_enabled = kw.get("enabled", True)
        self.video_download_disclaimer_acknowledged = kw.get("ack", True)
        self.video_max_size_mb = kw.get("size_mb", 500)
        self.video_max_duration_seconds = kw.get("dur_s", 1800)
        self.video_total_quota_mb = kw.get("quota_mb", 4096)


# ── Gate 1: consent ───────────────────────────────────────────────────────


def test_consent_requires_both_flags():
    check_consent(_Features(enabled=True, ack=True))  # ok
    with pytest.raises(VideoDownloadDenied):
        check_consent(_Features(enabled=False, ack=True))
    with pytest.raises(VideoDownloadDenied):
        check_consent(_Features(enabled=True, ack=False))


# ── Gate 3: SSRF ──────────────────────────────────────────────────────────


async def test_ssrf_gate_rejects_private_and_loopback_and_bad_scheme():
    for bad in (
        "http://127.0.0.1/seg.ts",
        "https://localhost/seg.ts",
        "http://10.0.0.5/seg.ts",
        "http://192.168.1.10/seg.ts",
        "http://169.254.1.1/seg.ts",  # link-local
        "http://[::1]/seg.ts",
        "ftp://cdn.example.com/seg.ts",
        "http://user:pass@cdn.example.com/seg.ts",  # embedded creds
    ):
        with pytest.raises(VideoDownloadDenied):
            await assert_public_media_url(bad)


async def test_ssrf_gate_allows_public_http_and_https_literals():
    # Public IP literals skip DNS and must pass for both schemes (design §3.2).
    await assert_public_media_url("http://93.184.216.34/seg.ts")
    await assert_public_media_url("https://93.184.216.34/seg.ts")


# ── Gate 4: budget (duration / quota / running size) ──────────────────────


def test_duration_gate():
    limits = DownloadLimits.from_features(_Features(dur_s=60))
    check_duration(59.0, limits)  # ok
    with pytest.raises(VideoDownloadDenied):
        check_duration(61.0, limits)


def test_quota_gate_full_store_refuses_new_download():
    limits = DownloadLimits.from_features(_Features(quota_mb=1))
    check_quota(0, limits)  # ok
    with pytest.raises(VideoDownloadDenied):
        check_quota(1024 * 1024, limits)  # exactly full


def test_size_guard_trips_on_per_download_cap():
    limits = DownloadLimits(max_size_bytes=100, max_duration_seconds=9999, total_quota_bytes=10**9)
    guard = SizeGuard(limits)
    guard.add(60)
    with pytest.raises(VideoDownloadDenied):
        guard.add(50)  # 110 > 100


def test_size_guard_respects_remaining_quota():
    # 200-byte per-download cap, but only 80 bytes of quota remain.
    limits = DownloadLimits(max_size_bytes=200, max_duration_seconds=9999, total_quota_bytes=1000)
    guard = SizeGuard(limits, existing_bytes=920)
    with pytest.raises(VideoDownloadDenied):
        guard.add(81)


# ── AES-128 decryption ────────────────────────────────────────────────────


def test_aes128_decrypt_roundtrip_with_padding():
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7

    key = b"0123456789abcdef"
    iv = (5).to_bytes(16, "big")
    plaintext = b"hello reverie video segment payload"
    padder = PKCS7(128).padder()
    padded = padder.update(plaintext) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()

    assert _decrypt_aes128(ciphertext, key, iv) == plaintext


# ── Downloader end-to-end via httpx.MockTransport ─────────────────────────


def _mock_client(routes: dict[str, bytes]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = routes.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        return httpx.Response(200, content=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_downloader_plain_ts_concatenates_in_order():
    # Use a public IP literal host so the real SSRF gate passes without DNS.
    text = (
        "#EXTM3U\n"
        "#EXT-X-TARGETDURATION:6\n"
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/a.ts\n"
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/b.ts\n"
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/c.ts\n"
    )
    playlist = parse_media(text, BASE)
    routes = {
        "https://93.184.216.34/v/a.ts": b"AAAA",
        "https://93.184.216.34/v/b.ts": b"BBBB",
        "https://93.184.216.34/v/c.ts": b"CCCC",
    }
    limits = DownloadLimits.from_features(_Features())
    progress: list[tuple[int, int]] = []
    async with _mock_client(routes) as client:
        result = await download_media_playlist(
            playlist, limits, client=client, on_progress=lambda c, t: progress.append((c, t))
        )
    # Concurrency must not reorder output: a,b,c in playlist order.
    assert result.segment_buffers == [b"AAAA", b"BBBB", b"CCCC"]
    assert result.total_bytes == 12
    assert result.is_fmp4 is False
    assert progress[-1] == (3, 3)


async def test_downloader_decrypts_aes128_segments():
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7

    key = b"YELLOW SUBMARINE"
    iv = (0).to_bytes(16, "big")

    def enc(plaintext: bytes) -> bytes:
        padder = PKCS7(128).padder()
        padded = padder.update(plaintext) + padder.finalize()
        e = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
        return e.update(padded) + e.finalize()

    # Use public IP literal hosts so the SSRF gate passes without DNS.
    text = (
        "#EXTM3U\n"
        "#EXT-X-MEDIA-SEQUENCE:0\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="https://93.184.216.34/v/k.bin",'
        "IV=0x00000000000000000000000000000000\n"
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/e0.ts\n"
    )
    playlist = parse_media(text, BASE)
    routes = {
        "https://93.184.216.34/v/k.bin": key,
        "https://93.184.216.34/v/e0.ts": enc(b"decrypted-video-bytes"),
    }
    limits = DownloadLimits.from_features(_Features())
    async with _mock_client(routes) as client:
        result = await download_media_playlist(playlist, limits, client=client)
    assert result.segment_buffers == [b"decrypted-video-bytes"]


async def test_downloader_rejects_oversize_key():
    text = (
        "#EXTM3U\n"
        '#EXT-X-KEY:METHOD=AES-128,URI="https://93.184.216.34/v/k.bin"\n'
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/e0.ts\n"
    )
    playlist = parse_media(text, BASE)
    routes = {
        "https://93.184.216.34/v/k.bin": b"this key is not sixteen bytes long!!",
        "https://93.184.216.34/v/e0.ts": b"whatever",
    }
    limits = DownloadLimits.from_features(_Features())
    async with _mock_client(routes) as client:
        with pytest.raises(VideoDownloadDenied):
            await download_media_playlist(playlist, limits, client=client)


async def test_downloader_size_cap_aborts_large_stream():
    text = (
        "#EXTM3U\n"
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/a.ts\n"
        "#EXTINF:6.0,\nhttps://93.184.216.34/v/b.ts\n"
    )
    playlist = parse_media(text, BASE)
    routes = {
        "https://93.184.216.34/v/a.ts": b"X" * 40,
        "https://93.184.216.34/v/b.ts": b"Y" * 40,
    }
    # 50-byte per-download cap: the second segment must trip the guard.
    limits = DownloadLimits(max_size_bytes=50, max_duration_seconds=9999, total_quota_bytes=10**9)
    async with _mock_client(routes) as client:
        with pytest.raises(VideoDownloadDenied):
            await download_media_playlist(playlist, limits, client=client)


async def test_downloader_refuses_empty_playlist():
    playlist = parse_media("#EXTM3U\n#EXT-X-TARGETDURATION:6\n", BASE)
    limits = DownloadLimits.from_features(_Features())
    async with _mock_client({}) as client:
        with pytest.raises(VideoDownloadDenied):
            await download_media_playlist(playlist, limits, client=client)
