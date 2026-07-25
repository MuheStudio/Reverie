"""Compatibility wrapper for galgame install test helpers."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SRC = Path(__file__).resolve().parent / "src" / "neko_core" / "plugin" / "tests" / "unit" / "plugins" / "_galgame_install_support.py"
_SPEC = importlib.util.spec_from_file_location("_galgame_install_support_impl", _SRC)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Cannot load {_SRC}")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
globals().update({name: value for name, value in _MODULE.__dict__.items() if not name.startswith("__")})
