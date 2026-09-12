"""End-to-end pipeline tests (src/video_download/pipeline.py)."""

from pathlib import Path

import httpx
import pytest

from src.video_download.gates import VideoDownloadDenied
from src.video_download.pipeline import download_video

HOST = "https://93.184.216.34"


class _Features:
    def __init__(self, enabled=True, ack=True, size_mb=500, dur_s=1800, quota_mb=4096):
        self.video_download_enabled = enabled
        self.video_download_disclaimer_acknowledged = ack
        self.video_max_size_mb = size_mb
        self.video_max_duration_seconds = dur_s
        self.video_total_quota_mb = quota_mb


def _mock_client(routes: dict[str, bytes], content_types: dict[str, str] | None = None):
    content_types = content_types or {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = routes.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        headers = {}
        ct = content_types.get(str(request.url))
        if ct:
            headers["content-type"] = ct
        return httpx.Response(200, content=body, headers=headers)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_consent_gate_blocks_before_any_fetch():
    async with _mock_client({}) as client:
        with pytest.raises(VideoDownloadDenied):
            await download_video(f"{HOST}/v.m3u8", _Features(ack=False), client=client)
        with pytest.raises(VideoDownloadDenied):
            await download_video(f"{HOST}/v.m3u8", _Features(enabled=False), client=client)


async def test_hls_master_resolves_best_variant_and_merges(tmp_path):
    master = (
        "#EXTM3U\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n"
        f"{HOST}/low.m3u8\n"
        "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n"
        f"{HOST}/high.m3u8\n"
    )
    media = (
        "#EXTM3U\n"
        "#EXT-X-TARGETDURATION:6\n"
        f"#EXTINF:6.0,\n{HOST}/s0.ts\n"
        f"#EXTINF:6.0,\n{HOST}/s1.ts\n"
    )
    routes = {
        f"{HOST}/v.m3u8": master.encode(),
        f"{HOST}/high.m3u8": media.encode(),
        f"{HOST}/low.m3u8": media.encode(),
        f"{HOST}/s0.ts": b"TS0-",
        f"{HOST}/s1.ts": b"TS1-",
    }
    async with _mock_client(routes) as client:
        result = await download_video(
            f"{HOST}/v.m3u8", _Features(), client=client, temp_dir=str(tmp_path)
        )
    assert result.is_hls is True
    assert result.duration_seconds == pytest.approx(12.0)
    assert Path(result.path).read_bytes() == b"TS0-TS1-"
    assert result.total_bytes == 8


async def test_direct_mp4_download(tmp_path):
    payload = b"\x00\x00\x00\x18ftypmp42" + b"\x11" * 64
    routes = {f"{HOST}/clip.mp4": payload}
    async with _mock_client(routes) as client:
        result = await download_video(
            f"{HOST}/clip.mp4", _Features(), client=client, temp_dir=str(tmp_path)
        )
    assert result.is_hls is False
    assert Path(result.path).read_bytes() == payload
    assert result.path.endswith(".mp4")


async def test_direct_download_size_cap(tmp_path):
    routes = {f"{HOST}/big.mp4": b"X" * (2 * 1024 * 1024)}
    async with _mock_client(routes) as client:
        with pytest.raises(VideoDownloadDenied):
            await download_video(
                f"{HOST}/big.mp4", _Features(size_mb=1), client=client, temp_dir=str(tmp_path)
            )


async def test_hls_duration_cap_refused(tmp_path):
    media = (
        "#EXTM3U\n"
        "#EXT-X-TARGETDURATION:6\n"
        f"#EXTINF:60.0,\n{HOST}/s0.ts\n"
        f"#EXTINF:60.0,\n{HOST}/s1.ts\n"
    )
    routes = {
        f"{HOST}/v.m3u8": media.encode(),
        f"{HOST}/s0.ts": b"x",
        f"{HOST}/s1.ts": b"y",
    }
    async with _mock_client(routes) as client:
        with pytest.raises(VideoDownloadDenied):
            await download_video(
                f"{HOST}/v.m3u8", _Features(dur_s=60), client=client, temp_dir=str(tmp_path)
            )
