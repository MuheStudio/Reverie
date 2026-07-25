"""Length-prefixed JSON transport for Electron parent ↔ Python child.

The renderer never receives this pipe.  A development-only WebSocket adapter
may translate to the same V3 envelopes without becoming a second domain API.
"""

from __future__ import annotations

import io
import json
import struct
from typing import Any, BinaryIO


MAX_FRAME_BYTES = 16 * 1024 * 1024
_HEADER = struct.Struct(">I")


class FrameProtocolError(ValueError):
    pass


def encode_frame(payload: dict[str, Any]) -> bytes:
    if not isinstance(payload, dict):
        raise TypeError("framed payload must be an object")
    body = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    if not body or len(body) > MAX_FRAME_BYTES:
        raise FrameProtocolError("frame size is outside the safe range")
    return _HEADER.pack(len(body)) + body


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise EOFError("framed stream ended mid-message")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(_HEADER.size)
    if header == b"":
        return None
    if len(header) != _HEADER.size:
        raise EOFError("framed stream ended mid-header")
    (size,) = _HEADER.unpack(header)
    if size < 2 or size > MAX_FRAME_BYTES:
        raise FrameProtocolError("frame size is outside the safe range")
    body = _read_exact(stream, size)
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FrameProtocolError("frame is not valid UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise FrameProtocolError("frame root must be an object")
    return payload


def write_frame(stream: BinaryIO, payload: dict[str, Any]) -> None:
    stream.write(encode_frame(payload))
    stream.flush()


def round_trip(payload: dict[str, Any]) -> dict[str, Any]:
    stream = io.BytesIO(encode_frame(payload))
    value = read_frame(stream)
    assert value is not None
    return value
