"""Compatibility shim for environments without the `ormsgpack` package."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

_THIS_FILE = Path(__file__).resolve()
_THIS_DIR = _THIS_FILE.parent
_SEARCH_PATHS = [p for p in sys.path if Path(p or ".").resolve() != _THIS_DIR]
_SPEC = importlib.machinery.PathFinder.find_spec("ormsgpack", _SEARCH_PATHS)

if _SPEC and _SPEC.loader and _SPEC.origin and Path(_SPEC.origin).resolve() != _THIS_FILE:
    _MODULE = importlib.util.module_from_spec(_SPEC)
    _SPEC.loader.exec_module(_MODULE)
    globals().update(
        {name: value for name, value in _MODULE.__dict__.items() if not name.startswith("__")}
    )
else:
    def packb(obj: Any, *args: Any, **kwargs: Any) -> bytes:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


    def unpackb(data: bytes | bytearray | memoryview | str, *args: Any, **kwargs: Any) -> Any:
        if isinstance(data, (bytes, bytearray, memoryview)):
            text = bytes(data).decode("utf-8")
        else:
            text = str(data)
        return json.loads(text)

