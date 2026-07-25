"""Compatibility package that exposes `src/neko_core/app` as `app`."""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent
_NEKO_CORE_ROOT = (_PACKAGE_ROOT.parent / "src" / "neko_core").resolve()
_REAL_PACKAGE = (_NEKO_CORE_ROOT / "app").resolve()

# The legacy server modules still use top-level imports such as
# `main_routers.*`. Keep those imports available when tests import `app`
# through this repository-root compatibility package.
_neko_core_root_str = str(_NEKO_CORE_ROOT)
if _neko_core_root_str not in sys.path:
    sys.path.insert(0, _neko_core_root_str)

__path__ = [str(_REAL_PACKAGE)]  # type: ignore[assignment]

_real_init = _REAL_PACKAGE / "__init__.py"
with _real_init.open("r", encoding="utf-8") as _handle:
    _code = compile(_handle.read(), str(_real_init), "exec")
exec(_code, globals(), globals())
