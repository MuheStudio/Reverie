"""Chat image attachments: validation, content-addressed storage, read-back.

Images sent through chat are conversation artifacts, so each one is stored
exactly once (sha256-addressed under ``REVERIE_DATA_DIR/chat-media``) and
referenced by ``media_id`` everywhere else — kernel rows, history pages, and
renderer fetches. Pillow re-encodes every attachment to a bounded JPEG so a
provider payload never carries multi-megabyte originals, and decoding is
guarded the same way as sticker assets (magic-byte verification plus a
DecompressionBomb pixel ceiling).
"""

from __future__ import annotations

import base64
import binascii
from pathlib import Path
import hashlib
import io
import os
import re

from PIL import Image, ImageFile

MAX_RAW_BYTES = 5 * 1024 * 1024
MAX_EDGE = 1600
JPEG_QUALITY = 85
# DecompressionBomb ceiling: an image that decodes beyond this is refused
# before Pillow can allocate the pixels.
MAX_PIXELS = 24_000_000
MEDIA_ID_RE = re.compile(r"^[A-Fa-f0-9]{64}$")
_STICKER_PROTOCOL_PREFIX = "reverie-sticker://asset/"
_STICKER_ASSET_RE = re.compile(r"^[A-Fa-f0-9]{64}\.(?:png|jpe?g|webp|gif)$")
_DATA_URL_RE = re.compile(
    r"data:image/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)"
)

# Refuse truncated files outright instead of silently repairing them.
ImageFile.LOAD_TRUNCATED_IMAGES = False
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ChatMediaError(ValueError):
    """Raised when an attachment cannot be accepted."""


def _media_dir() -> Path:
    from src.config.settings import DATA_DIR

    return Path(DATA_DIR) / "chat-media"


def _encode_jpeg(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return buffer.getvalue()


def store_image_bytes(raw: bytes) -> dict[str, object]:
    """Validate, normalize, and persist one image; return its media record."""
    if not raw:
        raise ChatMediaError("empty image payload")
    if len(raw) > MAX_RAW_BYTES:
        raise ChatMediaError("image exceeds the 5MB attachment limit")
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            probe.verify()
    except Exception as exc:
        raise ChatMediaError("payload is not a readable image") from exc
    try:
        with Image.open(io.BytesIO(raw)) as image:
            fmt = (image.format or "").upper()
            if fmt not in {"JPEG", "PNG", "WEBP", "GIF"}:
                raise ChatMediaError(f"unsupported image format: {fmt or 'unknown'}")
            if getattr(image, "n_frames", 1) > 1:
                image.seek(0)
            normalized = image.convert("RGB")
            normalized.thumbnail((MAX_EDGE, MAX_EDGE))
            encoded = _encode_jpeg(normalized)
    except ChatMediaError:
        raise
    except Exception as exc:
        raise ChatMediaError("image could not be decoded") from exc
    digest = hashlib.sha256(encoded).hexdigest()
    directory = _media_dir()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{digest}.jpg"
    if not target.exists():
        temporary = directory / f".{digest}.{os.getpid()}.tmp"
        temporary.write_bytes(encoded)
        os.replace(temporary, target)
    return {
        "media_id": digest,
        "mime": "image/jpeg",
        "bytes": len(encoded),
        "path": str(target),
    }


def store_from_file(path: str) -> dict[str, object]:
    """Read an absolute local path (from an Electron file dialog) as media."""
    if not path or "\x00" in path:
        raise ChatMediaError("invalid image path")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise ChatMediaError("image path must be absolute")
    resolved = candidate.resolve()
    if not resolved.is_file():
        raise ChatMediaError("image file not found")
    if resolved.stat().st_size > MAX_RAW_BYTES:
        raise ChatMediaError("image exceeds the 5MB attachment limit")
    return store_image_bytes(resolved.read_bytes())


def store_from_data_url(url: str) -> dict[str, object]:
    """Decode a renderer-supplied base64 data URL into stored media."""
    match = _DATA_URL_RE.fullmatch(url or "")
    if not match:
        raise ChatMediaError("unsupported image data URL")
    try:
        raw = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ChatMediaError("image data URL is not valid base64") from exc
    return store_image_bytes(raw)


def resolve_sticker_asset(url: str) -> dict[str, object]:
    """Map a ``reverie-sticker://asset`` URL to freshly stored chat media.

    Sticker assets live in the Python-owned ``stickers/assets`` store, so the
    resolution is done locally — the renderer never needs to hand over bytes
    it originally received from us.
    """
    if not (url or "").startswith(_STICKER_PROTOCOL_PREFIX):
        raise ChatMediaError("unsupported sticker url")
    name = url[len(_STICKER_PROTOCOL_PREFIX):]
    if not _STICKER_ASSET_RE.fullmatch(name):
        raise ChatMediaError("invalid sticker asset reference")
    from src.config.settings import DATA_DIR

    root = (Path(DATA_DIR) / "stickers" / "assets").resolve()
    target = (root / name).resolve()
    if target.parent != root or not target.is_file():
        raise ChatMediaError("sticker asset not found")
    return store_image_bytes(target.read_bytes())


def load_data_url(media_id: str) -> str:
    """Read one stored attachment back as a data URL for the renderer."""
    if not MEDIA_ID_RE.fullmatch(media_id or ""):
        raise ChatMediaError("invalid media id")
    directory = _media_dir().resolve()
    target = (directory / f"{media_id.lower()}.jpg").resolve()
    if target.parent != directory:
        raise ChatMediaError("invalid media id")
    if not target.is_file():
        raise ChatMediaError("media not found")
    if target.stat().st_size > MAX_RAW_BYTES:
        raise ChatMediaError("media exceeds the size limit")
    encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


__all__ = [
    "ChatMediaError",
    "load_data_url",
    "resolve_sticker_asset",
    "store_from_data_url",
    "store_from_file",
    "store_image_bytes",
]
