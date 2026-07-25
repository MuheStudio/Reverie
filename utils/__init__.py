"""Compatibility package that exposes `src/neko_core/utils` as `utils`."""

from __future__ import annotations

from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent
_REAL_PACKAGE = (_PACKAGE_ROOT.parent / "src" / "neko_core" / "utils").resolve()

__path__ = [str(_REAL_PACKAGE)]  # type: ignore[assignment]

