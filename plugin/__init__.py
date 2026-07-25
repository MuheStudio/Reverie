from __future__ import annotations

from pathlib import Path
from pkgutil import extend_path

__path__ = extend_path(__path__, __name__)

_real_package = Path(__file__).resolve().parent.parent / "src" / "neko_core" / "plugin"
if _real_package.is_dir():
    __path__.append(str(_real_package))

