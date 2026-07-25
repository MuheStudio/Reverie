"""Compatibility shim for environments without `charset_normalizer`."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator


@dataclass
class _Result:
    encoding: str | None


class _Results(Iterable[_Result]):
    def __init__(self, items: list[_Result]) -> None:
        self._items = items

    def __iter__(self) -> Iterator[_Result]:
        return iter(self._items)


def from_bytes(data: bytes | bytearray | memoryview) -> _Results:
    raw = bytes(data)
    candidates = ("utf-8", "cp932", "shift_jis", "gbk", "gb18030", "gb2312", "big5", "euc-kr")
    items: list[_Result] = []
    for encoding in candidates:
        try:
            raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        items.append(_Result(encoding=encoding))
    return _Results(items)
