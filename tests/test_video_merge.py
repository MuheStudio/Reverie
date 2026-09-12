"""Local merge tests (src/video_download/merge.py) — pure concatenation."""

import pytest

from src.video_download.downloader import DownloadResult
from src.video_download.merge import (
    MergeError,
    guess_extension,
    merge_to_bytes,
    merge_to_file,
)


def _ts_result(*segs: bytes) -> DownloadResult:
    return DownloadResult(
        init_bytes=None,
        segment_buffers=list(segs),
        total_bytes=sum(len(s) for s in segs),
        is_fmp4=False,
    )


def _fmp4_result(init: bytes, *segs: bytes) -> DownloadResult:
    return DownloadResult(
        init_bytes=init,
        segment_buffers=list(segs),
        total_bytes=len(init) + sum(len(s) for s in segs),
        is_fmp4=True,
    )


def test_ts_merge_is_plain_ordered_concatenation():
    result = _ts_result(b"AAA", b"BBB", b"CCC")
    assert merge_to_bytes(result) == b"AAABBBCCC"


def test_fmp4_merge_prepends_init_section():
    result = _fmp4_result(b"INIT", b"seg1", b"seg2")
    assert merge_to_bytes(result) == b"INITseg1seg2"


def test_fmp4_without_init_is_an_error():
    broken = DownloadResult(init_bytes=None, segment_buffers=[b"x"], total_bytes=1, is_fmp4=True)
    with pytest.raises(MergeError):
        merge_to_bytes(broken)


def test_merge_to_file_writes_atomically_and_returns_size(tmp_path):
    result = _ts_result(b"1234", b"5678")
    target = tmp_path / "out" / "video.ts"
    written = merge_to_file(result, target)
    assert written == 8
    assert target.read_bytes() == b"12345678"
    # No temp files left behind.
    assert list(target.parent.glob(".*.tmp")) == []


def test_empty_result_refused():
    empty = DownloadResult(init_bytes=None, segment_buffers=[], total_bytes=0, is_fmp4=False)
    with pytest.raises(MergeError):
        merge_to_bytes(empty)
    with pytest.raises(MergeError):
        merge_to_file(empty, "unused.ts")


def test_guess_extension():
    assert guess_extension(_fmp4_result(b"i", b"s")) == ".mp4"
    assert guess_extension(_ts_result(b"s")) == ".ts"
    assert guess_extension(_ts_result(b"s"), source_mime="video/mp4") == ".mp4"
