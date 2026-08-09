from __future__ import annotations

from pathlib import Path
from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)

# Keep the vendored N.E.K.O plugin package importable if it is ever restored.
# The current src/neko_core/plugin directory is an empty git-ignored shell
# (the vendored code was removed with the V4 migration), so this append is
# inert today and exists only for forward compatibility.
_real_package = Path(__file__).resolve().parent.parent / "src" / "neko_core" / "plugin"
if _real_package.is_dir():
    __path__.append(str(_real_package))

