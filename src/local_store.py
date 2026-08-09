"""Small local-first persistence helpers shared by world-state managers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4


def atomic_write_json(path: Path, payload: Any) -> None:
    """Write JSON through a unique sibling temp file so interruption keeps
    the old state and concurrent writers never clobber each other's temp
    file mid-write (os.replace is atomic, last committed writer wins)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + f".{uuid4().hex}.tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temp_path.replace(path)


def read_json_object(path: Path) -> dict[str, Any] | None:
    """Read a JSON object, returning None for missing or non-object data."""
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else None
