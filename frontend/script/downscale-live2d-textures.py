"""Deterministically cap staged Live2D textures for desktop GPU compatibility."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    limit = int(sys.argv[2])
    if not root.is_dir() or limit < 256 or limit > 8192:
        raise ValueError("invalid Live2D texture transform input")
    model_files = list(root.rglob("*.model3.json"))
    if len(model_files) != 1:
        raise ValueError("expected exactly one model3.json")
    model = json.loads(model_files[0].read_text(encoding="utf-8"))
    transforms: list[dict[str, object]] = []
    for relative_value in model.get("FileReferences", {}).get("Textures", []):
        relative = Path(str(relative_value).replace("\\", "/"))
        target = (model_files[0].parent / relative).resolve()
        if os.path.commonpath([str(root), str(target)]) != str(root):
            raise ValueError("texture path escaped the model root")
        stat = target.lstat()
        if target.is_symlink() or not target.is_file() or stat.st_size < 1:
            raise ValueError("texture must be a non-empty regular file")
        with Image.open(target) as source:
            source.load()
            before = [source.width, source.height]
            if max(before) <= limit:
                continue
            scale = limit / max(before)
            size = (
                max(1, round(source.width * scale)),
                max(1, round(source.height * scale)),
            )
            converted = source.convert("RGBA").resize(size, Image.Resampling.LANCZOS)
            temporary = target.with_name(f".{target.name}.reverie-resize")
            converted.save(
                temporary,
                format="PNG",
                compress_level=9,
                optimize=False,
            )
            os.replace(temporary, target)
            transforms.append({
                "path": target.relative_to(root).as_posix(),
                "before": before,
                "after": [size[0], size[1]],
                "filter": "lanczos",
            })
    sys.stdout.write(json.dumps(transforms, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
