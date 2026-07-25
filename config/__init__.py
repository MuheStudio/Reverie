"""Compatibility package that exposes `src/neko_core/config` as `config`."""

from __future__ import annotations

from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent
_REAL_PACKAGE = (_PACKAGE_ROOT.parent / "src" / "neko_core" / "config").resolve()

# Let `import config.prompts...` resolve against the real package directory.
__path__ = [str(_REAL_PACKAGE)]  # type: ignore[assignment]

_real_init = _REAL_PACKAGE / "__init__.py"
with _real_init.open("r", encoding="utf-8") as _handle:
    _code = compile(_handle.read(), str(_real_init), "exec")
exec(_code, globals(), globals())

