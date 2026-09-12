"""Local segment merge — pure binary concatenation, zero external binaries.

Design red line (待实施计划 §3.3, notes/07): no external ffmpeg server, no
ffmpeg.wasm default path, no StreamSaver. Merging is a local, streaming binary
concatenation:

* **MPEG-TS**: transport-stream segments are self-framing (188-byte packets),
  so ordered concatenation yields a directly playable ``.ts`` stream. This is
  the common HLS case and needs no container rewrite.
* **fMP4**: the ``EXT-X-MAP`` initialisation section (ftyp+moov) is written
  first, followed by each media segment (moof+mdat) in order. Concatenation is
  the correct assembly for fragmented MP4 — no transcoding.

Output is written to a caller-provided path via a streaming write so a large
download never has to be fully re-buffered in memory beyond the segment list
the downloader already holds.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Optional

from src.video_download.downloader import DownloadResult


class MergeError(Exception):
    """Raised when merged output cannot be produced."""


def _iter_parts(result: DownloadResult) -> Iterable[bytes]:
    if result.is_fmp4:
        if result.init_bytes is None:
            raise MergeError("fMP4 stream is missing its initialisation section")
        yield result.init_bytes
    yield from result.segment_buffers


def merge_to_file(result: DownloadResult, target_path: str | os.PathLike[str]) -> int:
    """Concatenate ordered segments to ``target_path``; return bytes written.

    Writes atomically via a sibling temp file + ``os.replace`` so a crash mid
    merge never leaves a half-written video at the final path.
    """
    if not result.segment_buffers:
        raise MergeError("nothing to merge: no segments")
    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{target.name}.{os.getpid()}.tmp"
    written = 0
    try:
        with open(temporary, "wb") as handle:
            for part in _iter_parts(result):
                handle.write(part)
                written += len(part)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    return written


def merge_to_bytes(result: DownloadResult) -> bytes:
    """Concatenate ordered segments into a single ``bytes`` object.

    Convenience for callers (and tests) that want the merged stream in memory;
    prefer :func:`merge_to_file` for real downloads to keep peak memory bounded.
    """
    if not result.segment_buffers:
        raise MergeError("nothing to merge: no segments")
    return b"".join(_iter_parts(result))


def guess_extension(result: DownloadResult, *, source_mime: Optional[str] = None) -> str:
    """Pick the output container extension.

    fMP4 concatenation yields an MP4; TS concatenation yields a ``.ts`` stream,
    which ``<video>`` cannot always play — but the media-storage layer decides
    acceptance by magic bytes, so this is only a filename hint.
    """
    if result.is_fmp4:
        return ".mp4"
    if source_mime == "video/mp4":
        return ".mp4"
    return ".ts"


__all__ = [
    "MergeError",
    "guess_extension",
    "merge_to_bytes",
    "merge_to_file",
]
