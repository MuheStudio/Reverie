"""Deterministic suggestions from the built-in kaomoji library."""

from collections.abc import Iterable
import re

from ..stickers import DEFAULT_KAOMOJI


_SPLIT_CHARACTERS = frozenset("，,！!？?。.<>\r\n")
_LIBRARY_ENTRIES = sorted({entry for entries in DEFAULT_KAOMOJI.values() for entry in entries},
                          key=lambda entry: (-len(entry), entry))
_LIBRARY_PATTERN = re.compile("|".join(re.escape(entry) for entry in _LIBRARY_ENTRIES))


def kaomoji_palette(emotion: str) -> tuple[str, ...]:
    entries = DEFAULT_KAOMOJI.get(emotion, DEFAULT_KAOMOJI["calm"])
    return tuple(entry for entry in entries if _SPLIT_CHARACTERS.isdisjoint(entry))[:3]


def recent_kaomoji_used(texts: Iterable[str]) -> bool:
    return any(entry in text for text in texts for entries in DEFAULT_KAOMOJI.values() for entry in entries)


def kaomoji_spans(text: str) -> list[tuple[int, int]]:
    """Return leftmost, longest non-overlapping spans of built-in entries."""
    return [match.span() for match in _LIBRARY_PATTERN.finditer(text)]
