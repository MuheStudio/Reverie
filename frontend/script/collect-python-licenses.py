"""Collect installed Python package metadata and bundled license texts."""

from __future__ import annotations

import json
import re
import shutil
import sys
from importlib import metadata
from pathlib import Path


LICENSE_NAME = re.compile(r"^(licen[cs]e|copying|notice)(\..*)?$", re.IGNORECASE)


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "__", value)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: collect-python-licenses.py OUTPUT_DIR")

    output_dir = Path(sys.argv[1]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    inventory: list[dict[str, object]] = []

    for distribution in sorted(
        metadata.distributions(),
        key=lambda item: (item.metadata.get("Name") or "").lower(),
    ):
        name = distribution.metadata.get("Name") or "unknown"
        version = distribution.version or "unknown"
        classifiers = distribution.metadata.get_all("Classifier") or []
        license_classifiers = [
            item.removeprefix("License :: ")
            for item in classifiers
            if item.startswith("License :: ")
        ]
        package_dir = output_dir / f"{safe_name(name)}@{safe_name(version)}"
        copied: list[str] = []

        for relative in distribution.files or []:
            relative_path = Path(str(relative))
            if not LICENSE_NAME.match(relative_path.name):
                continue
            source = Path(distribution.locate_file(relative)).resolve()
            if not source.is_file():
                continue
            package_dir.mkdir(parents=True, exist_ok=True)
            target = package_dir / relative_path.name
            shutil.copyfile(source, target)
            copied.append(relative_path.name)

        inventory.append(
            {
                "name": name,
                "version": version,
                "license": distribution.metadata.get("License") or "",
                "license_classifiers": license_classifiers,
                "home_page": distribution.metadata.get("Home-page") or "",
                "license_files": sorted(set(copied)),
            }
        )

    (output_dir / "inventory.json").write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
