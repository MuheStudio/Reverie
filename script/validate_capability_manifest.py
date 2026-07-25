"""Validate the immutable product-to-architecture capability traceability map."""

from __future__ import annotations

from pathlib import Path
import sys

import yaml


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "config" / "capability-manifest.yaml"
EXPECTED_IDS = set(range(1, 111))


def validate(path: Path = MANIFEST) -> list[str]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    fields = payload.get("fields")
    rows = payload.get("capabilities")
    allowed = payload.get("allowed_values", {})
    if not isinstance(fields, list) or not isinstance(rows, list):
        return ["manifest fields and capabilities must be lists"]
    if len(fields) != len(set(fields)):
        errors.append("manifest field names must be unique")

    records: list[dict] = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, list) or len(row) != len(fields):
            errors.append(f"capability row {index} does not match the declared fields")
            continue
        records.append(dict(zip(fields, row, strict=True)))

    ids = [record.get("id") for record in records]
    if len(ids) != len(set(ids)):
        errors.append("capability ids must be unique")
    missing = sorted(EXPECTED_IDS.difference(ids))
    extra = sorted(set(ids).difference(EXPECTED_IDS))
    if missing:
        errors.append(f"missing capability ids: {missing}")
    if extra:
        errors.append(f"unexpected capability ids: {extra}")

    default_values = set(allowed.get("default", []))
    api_values = set(allowed.get("api_consumption", []))
    for record in records:
        capability_id = record.get("id")
        for key in ("title", "module", "data_owner", "acceptance"):
            if not str(record.get(key, "")).strip():
                errors.append(f"capability {capability_id} has no {key}")
        if record.get("default") not in default_values:
            errors.append(f"capability {capability_id} has an invalid default")
        if record.get("api_consumption") not in api_values:
            errors.append(f"capability {capability_id} has an invalid api_consumption")
        if (
            record.get("api_consumption") == "automatic"
            and record.get("default") != "disabled"
        ):
            errors.append(
                f"capability {capability_id} consumes automatic API usage but is not disabled"
            )

    for extra_capability in payload.get("extra_api_capabilities", []):
        if extra_capability.get("default") != "disabled":
            errors.append(
                f"extra API capability {extra_capability.get('id')} must default to disabled"
            )
        if not str(extra_capability.get("consent", "")).strip():
            errors.append(
                f"extra API capability {extra_capability.get('id')} has no consent policy"
            )
    return errors


def main() -> int:
    errors = validate()
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("capability manifest: 110/110 entries valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
