"""Advisory GUI coverage for local iteration; never selects formal stages."""

from __future__ import annotations

import copy
import fnmatch
import json
from pathlib import Path, PurePosixPath
from typing import Iterable


MODE_OPTIONS = (
    ("injection", ("--p1-worldbook-injection",)),
    ("regex", ("--p1-worldbook-regex",)),
    ("entry", ("--p1-worldbook-entry",)),
    ("persona", ("--p1-persona",)),
    ("candidate", ("--p1-memory", "--candidate-paging")),
    ("ordinary", ("--p1-memory",)),
    ("settings", ("--p1-settings",)),
)
_FIELDS = ("directions", "productSources", "fixtures", "checkSources")
_SHARED = {"productSources": "sharedProductSources", "fixtures": "sharedFixtures",
           "checkSources": "sharedCheckSources"}


def _relative_path(value: str, *, pattern: bool = False) -> str:
    if (not isinstance(value, str) or not value or "\\" in value or ":" in value
            or "\x00" in value or any(ord(character) < 32 for character in value)
            or value.startswith("/") or "//" in value
            or any(part in (".", "..") for part in value.split("/"))):
        raise ValueError("GUI coverage paths must be repository-relative POSIX paths")
    if not pattern and any(character in value for character in "*?[]"):
        raise ValueError("Changed GUI coverage paths must be literal paths")
    return str(PurePosixPath(value))


def validate_coverage(coverage: dict) -> dict:
    """Validate closed mode identities and paths, returning an independent copy."""
    if not isinstance(coverage, dict) or coverage.get("schema") != "reverie.gui-mode-coverage.v1":
        raise ValueError("Unknown GUI coverage schema")
    if coverage.get("advisoryOnly") is not True or coverage.get("formalRegressionUnchanged") is not True:
        raise ValueError("GUI coverage must remain advisory and preserve formal regression")
    if coverage.get("command") != "script/check-qt-macos.sh":
        raise ValueError("GUI coverage must use the isolated GUI checker")
    if coverage.get("requiredOptions") != ["--build-dir", "ABS_LOCAL_BUILD_DIRECTORY"]:
        raise ValueError("GUI coverage requires an explicit build directory")
    modes = coverage.get("modes")
    if not isinstance(modes, list) or len(modes) != len(MODE_OPTIONS):
        raise ValueError("GUI coverage must describe all seven existing modes")
    for field in _SHARED.values():
        paths = coverage.get(field)
        if not isinstance(paths, list) or not paths:
            raise ValueError(f"GUI coverage requires {field}")
        for value in paths:
            _relative_path(value, pattern=True)
    for mode, (identity, options) in zip(modes, MODE_OPTIONS):
        if (not isinstance(mode, dict) or mode.get("id") != identity
                or mode.get("stage") != f"{identity}-check" or mode.get("options") != list(options)):
            raise ValueError("GUI coverage mode identities, order and options must stay unchanged")
        for field in _FIELDS:
            paths = mode.get(field)
            if not isinstance(paths, list) or (field != "checkSources" and not paths):
                raise ValueError(f"GUI coverage mode requires {field}")
            for value in paths:
                _relative_path(value, pattern=field != "directions")
                if field == "directions" and (not value.startswith("docs/") or not value.endswith(".md")):
                    raise ValueError("GUI coverage directions must reference repository documents")
    return copy.deepcopy(coverage)


def load_coverage(root: Path | str | None = None, metadata_path: Path | str | None = None) -> dict:
    project = Path(root) if root is not None else Path(__file__).resolve().parents[2]
    source = Path(metadata_path) if metadata_path is not None else project / "native-ui/tests/gui-mode-coverage.json"
    return validate_coverage(json.loads(source.read_text(encoding="utf-8")))


def suggest_modes(changed_paths: Iterable[str], coverage: dict | None = None,
                  root: Path | str | None = None) -> dict:
    """Return ordered local-run hints, including why each mode was suggested.

    Patterns use case-sensitive fnmatch over repository-relative POSIX paths;
    ``**`` covers all descendants. Deleted paths can still produce a hint.
    The caller retains its explicit selection and all formal configuration.
    """
    data = load_coverage(root) if coverage is None else validate_coverage(coverage)
    paths = sorted({_relative_path(value) for value in changed_paths})
    suggested = []
    metadata_name = "native-ui/tests/gui-mode-coverage.json"
    for mode in data["modes"]:
        reasons = []
        for path in paths:
            if path == metadata_name:
                reasons.append({"path": path, "area": "coverageMetadata", "pattern": metadata_name})
            for field in _FIELDS:
                patterns = mode[field] + data.get(_SHARED.get(field), [])
                for pattern in patterns:
                    if fnmatch.fnmatchcase(path, pattern):
                        reasons.append({"path": path, "area": field, "pattern": pattern})
        if reasons:
            suggested.append({"id": mode["id"], "options": list(mode["options"]),
                              "matchedPaths": sorted({reason["path"] for reason in reasons}),
                              "reasons": reasons})
    return {"advisoryOnly": True, "formalRegressionUnchanged": True, "modes": suggested}
