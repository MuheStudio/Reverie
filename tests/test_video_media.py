"""Chat video storage tests (src/chat/video_media.py) — no re-encoding."""

import pytest

from src.chat import video_media
from src.chat.video_media import (
    ChatVideoError,
    sniff_video_mime,
    store_video_bytes,
    video_info,
)

# Minimal container headers the sniffer recognises.
MP4_HEADER = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
WEBM_HEADER = b"\x1a\x45\xdf\xa3\x01\x00\x00\x00\x00\x00\x00\x1f"


class _Features:
    def __init__(self, size_mb=500, quota_mb=4096, dur_s=1800):
        self.video_max_size_mb = size_mb
        self.video_total_quota_mb = quota_mb
        self.video_max_duration_seconds = dur_s


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr("src.config.settings.DATA_DIR", str(tmp_path))
    return tmp_path


def test_sniff_recognises_mp4_and_webm():
    assert sniff_video_mime(MP4_HEADER) == "video/mp4"
    assert sniff_video_mime(WEBM_HEADER) == "video/webm"


def test_sniff_rejects_non_video_bytes():
    assert sniff_video_mime(b"\xff\xd8\xff\xe0" + b"\x00" * 20) is None  # JPEG
    assert sniff_video_mime(b"too short") is None


def test_store_mp4_is_byte_for_byte(data_dir):
    payload = MP4_HEADER + b"\x11" * 100
    record = store_video_bytes(payload)
    assert record["mime"] == "video/mp4"
    assert record["bytes"] == len(payload)
    assert record["kind"] == "video"
    # Stored byte-for-byte, no re-encoding.
    from pathlib import Path

    assert Path(str(record["path"])).read_bytes() == payload
    # Round-trip metadata.
    info = video_info(str(record["media_id"]))
    assert info["mime"] == "video/mp4"
    assert info["bytes"] == len(payload)


def test_store_rejects_disguised_non_video(data_dir):
    with pytest.raises(ChatVideoError):
        store_video_bytes(b"PK\x03\x04" + b"\x00" * 40)  # zip pretending


def test_declared_mime_mismatch_is_refused(data_dir):
    with pytest.raises(ChatVideoError):
        store_video_bytes(MP4_HEADER + b"\x00" * 20, declared_mime="video/webm")


def test_declared_mime_unsupported_is_refused(data_dir):
    with pytest.raises(ChatVideoError):
        store_video_bytes(MP4_HEADER + b"\x00" * 20, declared_mime="video/x-matroska")


def test_per_video_size_cap_enforced(data_dir):
    payload = MP4_HEADER + b"\x00" * (2 * 1024 * 1024)
    with pytest.raises(ChatVideoError):
        store_video_bytes(payload, features=_Features(size_mb=1))


def test_total_quota_enforced(data_dir):
    # First store fills most of a 1MB quota; second store overflows it.
    first = MP4_HEADER + b"\x00" * (600 * 1024)
    store_video_bytes(first, features=_Features(size_mb=500, quota_mb=1))
    second = MP4_HEADER + b"\x01" * (600 * 1024)
    with pytest.raises(ChatVideoError):
        store_video_bytes(second, features=_Features(size_mb=500, quota_mb=1))


def test_duration_cap_enforced(data_dir):
    with pytest.raises(ChatVideoError):
        store_video_bytes(
            MP4_HEADER + b"\x00" * 20,
            features=_Features(dur_s=60),
            duration_seconds=120.0,
        )


def test_dedup_same_content_same_media_id(data_dir):
    payload = MP4_HEADER + b"\xab" * 50
    a = store_video_bytes(payload)
    b = store_video_bytes(payload)
    assert a["media_id"] == b["media_id"]


def test_video_info_rejects_bad_media_id(data_dir):
    with pytest.raises(ChatVideoError):
        video_info("../etc/passwd")
    with pytest.raises(ChatVideoError):
        video_info("nothex")


def test_empty_payload_refused(data_dir):
    with pytest.raises(ChatVideoError):
        store_video_bytes(b"")
