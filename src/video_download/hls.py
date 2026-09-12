"""RFC 8216 HLS playlist parser (master + media).

A deliberately small, dependency-free parser that extracts exactly what the
downloader needs: the ordered segment list, per-segment byte ranges, the
optional fMP4 init segment (``EXT-X-MAP``), and AES-128 key material with a
correctly derived IV. It intentionally understands only ``NONE`` and
``AES-128`` encryption; ``SAMPLE-AES`` and any vendor DRM method are rejected
(see the package docstring — Reverie must not circumvent DRM).

Reference (structure only, no code reuse): cat-catch ``src/download_service``
``electron_adapter.js`` / ``js/background.js`` m3u8 handling. This is an
independent rewrite against RFC 8216 §4.3.

The parser is pure: it takes already-fetched playlist text plus the URL it was
fetched from, and returns typed structures. Network fetching, gating, and
decryption live elsewhere so this module stays trivially testable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urljoin


class HlsError(ValueError):
    """Raised when a playlist is malformed or uses an unsupported feature."""


@dataclass(frozen=True)
class SegmentKey:
    """Decryption key descriptor for one or more segments.

    ``method`` is always ``"AES-128"`` when this object exists; ``NONE`` is
    represented by the absence of a key (``Segment.key is None``). ``iv`` is the
    16-byte initialisation vector, already derived: either the explicit
    ``IV=0x...`` attribute or, per RFC 8216 §5.2, the segment's media sequence
    number encoded big-endian into 16 bytes.
    """

    method: str
    uri: str
    iv: bytes


@dataclass(frozen=True)
class ByteRange:
    """A resolved ``EXT-X-BYTERANGE`` (length + absolute start offset)."""

    length: int
    offset: int


@dataclass(frozen=True)
class Segment:
    """One media segment to download."""

    uri: str
    duration: float
    sequence: int
    key: Optional[SegmentKey] = None
    byte_range: Optional[ByteRange] = None


@dataclass(frozen=True)
class InitSection:
    """An ``EXT-X-MAP`` fMP4 initialisation section."""

    uri: str
    byte_range: Optional[ByteRange] = None


@dataclass
class MediaPlaylist:
    """A parsed media playlist (the thing that actually lists segments)."""

    segments: list[Segment] = field(default_factory=list)
    init_section: Optional[InitSection] = None
    target_duration: float = 0.0
    is_encrypted: bool = False

    @property
    def total_duration(self) -> float:
        return sum(s.duration for s in self.segments)

    @property
    def is_fmp4(self) -> bool:
        return self.init_section is not None


@dataclass(frozen=True)
class VariantStream:
    """One ``EXT-X-STREAM-INF`` entry in a master playlist."""

    uri: str
    bandwidth: int
    resolution: str = ""
    codecs: str = ""


@dataclass
class MasterPlaylist:
    """A parsed master playlist (a menu of variant streams)."""

    variants: list[VariantStream] = field(default_factory=list)

    def best_by_bandwidth(self) -> Optional[VariantStream]:
        """Return the highest-bandwidth variant, or ``None`` if empty."""
        if not self.variants:
            return None
        return max(self.variants, key=lambda v: v.bandwidth)


def resolve_url(base_url: str, ref: str) -> str:
    """Resolve a possibly-relative playlist/segment reference against a base."""
    ref = (ref or "").strip()
    if not ref:
        raise HlsError("empty URI reference")
    return urljoin(base_url, ref)


def _parse_attributes(text: str) -> dict[str, str]:
    """Parse an HLS attribute list (RFC 8216 §4.2).

    Handles quoted values that may contain commas (e.g. ``CODECS="a,b"``) and
    hex/decimal/enumerated bare values. Keys are upper-cased attribute names.
    """
    attrs: dict[str, str] = {}
    i = 0
    n = len(text)
    while i < n:
        # Skip separators / whitespace.
        while i < n and text[i] in ", \t":
            i += 1
        if i >= n:
            break
        key_start = i
        while i < n and text[i] != "=":
            i += 1
        key = text[key_start:i].strip().upper()
        if i >= n or not key:
            break
        i += 1  # skip '='
        if i < n and text[i] == '"':
            i += 1
            val_start = i
            while i < n and text[i] != '"':
                i += 1
            value = text[val_start:i]
            i += 1  # skip closing quote
        else:
            val_start = i
            while i < n and text[i] != ",":
                i += 1
            value = text[val_start:i].strip()
        attrs[key] = value
    return attrs


def _parse_hex_iv(raw: str) -> bytes:
    """Parse a ``0x...`` / ``0X...`` 128-bit IV into 16 bytes."""
    token = (raw or "").strip()
    if token[:2].lower() != "0x":
        raise HlsError("IV must be a 0x-prefixed hex string")
    hex_digits = token[2:]
    if len(hex_digits) == 0 or len(hex_digits) > 32:
        raise HlsError("IV must be at most 128 bits")
    try:
        value = int(hex_digits, 16)
    except ValueError as exc:
        raise HlsError("IV is not valid hexadecimal") from exc
    return value.to_bytes(16, "big")


def _iv_from_sequence(sequence: int) -> bytes:
    """Derive the implicit IV from a media sequence number (RFC 8216 §5.2)."""
    return int(sequence).to_bytes(16, "big")


def _parse_byte_range(raw: str, previous_end: Optional[int]) -> ByteRange:
    """Parse ``EXT-X-BYTERANGE`` value ``<length>[@<offset>]`` (§4.3.2.2)."""
    token = (raw or "").strip()
    if "@" in token:
        length_str, offset_str = token.split("@", 1)
        length = int(length_str)
        offset = int(offset_str)
    else:
        length = int(token)
        if previous_end is None:
            raise HlsError("EXT-X-BYTERANGE without offset must follow a sub-range")
        offset = previous_end
    if length < 0 or offset < 0:
        raise HlsError("byte range must be non-negative")
    return ByteRange(length=length, offset=offset)


def is_master_playlist(text: str) -> bool:
    """True if the playlist advertises variant streams (a master playlist)."""
    for line in text.splitlines():
        if line.strip().startswith("#EXT-X-STREAM-INF"):
            return True
    return False


def parse_master(text: str, base_url: str) -> MasterPlaylist:
    """Parse a master playlist into its variant streams."""
    master = MasterPlaylist()
    pending: Optional[dict[str, str]] = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-STREAM-INF:"):
            pending = _parse_attributes(line[len("#EXT-X-STREAM-INF:"):])
        elif not line.startswith("#"):
            if pending is None:
                # A URI with no preceding STREAM-INF: ignore per spec leniency.
                continue
            try:
                bandwidth = int(pending.get("BANDWIDTH", "0"))
            except ValueError:
                bandwidth = 0
            master.variants.append(
                VariantStream(
                    uri=resolve_url(base_url, line),
                    bandwidth=bandwidth,
                    resolution=pending.get("RESOLUTION", ""),
                    codecs=pending.get("CODECS", ""),
                )
            )
            pending = None
    return master


def parse_media(text: str, base_url: str) -> MediaPlaylist:
    """Parse a media playlist into an ordered, key-annotated segment list."""
    playlist = MediaPlaylist()
    current_key: Optional[SegmentKey] = None
    key_uri_iv_explicit: Optional[bytes] = None
    key_uri: Optional[str] = None
    key_method: str = "NONE"
    pending_duration: float = 0.0
    pending_byte_range: Optional[ByteRange] = None
    media_sequence = 0
    sequence = 0
    seen_first_segment = False
    previous_range_end: Optional[int] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("#EXT-X-TARGETDURATION:"):
            try:
                playlist.target_duration = float(line.split(":", 1)[1])
            except (ValueError, IndexError):
                playlist.target_duration = 0.0

        elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_sequence = int(line.split(":", 1)[1])
            except (ValueError, IndexError):
                media_sequence = 0
            if not seen_first_segment:
                sequence = media_sequence

        elif line.startswith("#EXT-X-KEY:"):
            attrs = _parse_attributes(line[len("#EXT-X-KEY:"):])
            key_method = (attrs.get("METHOD", "NONE") or "NONE").upper()
            if key_method == "NONE":
                key_uri = None
                key_uri_iv_explicit = None
            elif key_method == "AES-128":
                uri = attrs.get("URI")
                if not uri:
                    raise HlsError("EXT-X-KEY AES-128 requires a URI")
                key_uri = resolve_url(base_url, uri)
                iv_attr = attrs.get("IV")
                key_uri_iv_explicit = _parse_hex_iv(iv_attr) if iv_attr else None
            else:
                # SAMPLE-AES and any vendor DRM: refuse rather than attempt to
                # circumvent. This is a hard compliance boundary.
                raise HlsError(
                    f"unsupported/DRM encryption method: {key_method}"
                )

        elif line.startswith("#EXT-X-MAP:"):
            attrs = _parse_attributes(line[len("#EXT-X-MAP:"):])
            uri = attrs.get("URI")
            if not uri:
                raise HlsError("EXT-X-MAP requires a URI")
            map_range: Optional[ByteRange] = None
            if attrs.get("BYTERANGE"):
                map_range = _parse_byte_range(attrs["BYTERANGE"], None)
            playlist.init_section = InitSection(
                uri=resolve_url(base_url, uri), byte_range=map_range
            )

        elif line.startswith("#EXTINF:"):
            value = line[len("#EXTINF:"):]
            duration_str = value.split(",", 1)[0].strip()
            try:
                pending_duration = float(duration_str)
            except ValueError:
                pending_duration = 0.0

        elif line.startswith("#EXT-X-BYTERANGE:"):
            pending_byte_range = _parse_byte_range(
                line[len("#EXT-X-BYTERANGE:"):], previous_range_end
            )

        elif not line.startswith("#"):
            seen_first_segment = True
            if key_method == "AES-128" and key_uri is not None:
                iv = (
                    key_uri_iv_explicit
                    if key_uri_iv_explicit is not None
                    else _iv_from_sequence(sequence)
                )
                current_key = SegmentKey(method="AES-128", uri=key_uri, iv=iv)
                playlist.is_encrypted = True
            else:
                current_key = None
            if pending_byte_range is not None:
                previous_range_end = (
                    pending_byte_range.offset + pending_byte_range.length
                )
            playlist.segments.append(
                Segment(
                    uri=resolve_url(base_url, line),
                    duration=pending_duration,
                    sequence=sequence,
                    key=current_key,
                    byte_range=pending_byte_range,
                )
            )
            sequence += 1
            pending_duration = 0.0
            pending_byte_range = None

    return playlist


def parse_playlist(text: str, base_url: str) -> MediaPlaylist | MasterPlaylist:
    """Parse either playlist flavour, dispatching on ``EXT-X-STREAM-INF``.

    Raises :class:`HlsError` if the text is not an ``#EXTM3U`` document.
    """
    # Be lenient about a leading BOM / whitespace but require the tag.
    stripped = (text or "").lstrip("\ufeff \t\r\n")
    if not stripped.startswith("#EXTM3U"):
        raise HlsError("not an HLS playlist (missing #EXTM3U)")
    if is_master_playlist(text):
        return parse_master(text, base_url)
    return parse_media(text, base_url)


__all__ = [
    "ByteRange",
    "HlsError",
    "InitSection",
    "MasterPlaylist",
    "MediaPlaylist",
    "Segment",
    "SegmentKey",
    "VariantStream",
    "is_master_playlist",
    "parse_master",
    "parse_media",
    "parse_playlist",
    "resolve_url",
]
