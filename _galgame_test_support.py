"""Compatibility wrapper for galgame test helpers."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SRC = Path(__file__).resolve().parent / "src" / "neko_core" / "plugin" / "tests" / "unit" / "plugins" / "_galgame_test_support.py"
_SPEC = importlib.util.spec_from_file_location("_galgame_test_support_impl", _SRC)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError(f"Cannot load {_SRC}")
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
globals().update({name: value for name, value in _MODULE.__dict__.items() if not name.startswith("__")})

for _helper in (
    "_galgame_bridge_support.py",
    "_galgame_ocr_support.py",
    "_galgame_agent_support.py",
    "_galgame_install_support.py",
):
    _helper_src = Path(__file__).resolve().parent / "src" / "neko_core" / "plugin" / "tests" / "unit" / "plugins" / _helper
    _helper_spec = importlib.util.spec_from_file_location(f"{_helper}_impl", _helper_src)
    if _helper_spec is None or _helper_spec.loader is None:
        raise ImportError(f"Cannot load {_helper_src}")
    _helper_module = importlib.util.module_from_spec(_helper_spec)
    _helper_spec.loader.exec_module(_helper_module)
    globals().update({name: value for name, value in _helper_module.__dict__.items() if not name.startswith("__")})
__all__ = [name for name in globals() if not name.startswith("__")]
