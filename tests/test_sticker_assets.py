from __future__ import annotations

import base64
import io
import json

import pytest
from PIL import Image

from src.stickers import StickerManager


def data_url(image: Image.Image, image_format: str, **save_options: object) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format=image_format, **save_options)
    mime = "jpeg" if image_format.upper() == "JPEG" else image_format.lower()
    return f"data:image/{mime};base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


def test_bmp_import_is_content_addressed_and_library_contains_no_embedded_binary(tmp_path) -> None:
    manager = StickerManager(data_dir=tmp_path)
    payload = data_url(Image.new("RGB", (24, 16), "navy"), "BMP")

    sticker = manager.collect("蓝色", image_data_url=payload)
    public = sticker.to_dict()

    assert sticker.image_path.endswith(".bmp")
    assert public["image_path"] == ""
    assert public["image_data_url"] == f"reverie-sticker://asset/{sticker.image_path}"
    assert (tmp_path / "assets" / sticker.image_path).is_file()
    persisted = (tmp_path / "library.json").read_text(encoding="utf-8")
    assert "data:image" not in persisted
    assert json.loads(persisted)


def test_duplicate_sticker_images_reuse_the_same_hash_asset(tmp_path) -> None:
    manager = StickerManager(data_dir=tmp_path)
    payload = data_url(Image.new("RGBA", (8, 8), "red"), "PNG")

    first = manager.collect("一", image_data_url=payload)
    second = manager.collect("二", image_data_url=payload)

    assert first.image_path == second.image_path
    assert len(list((tmp_path / "assets").iterdir())) == 1


def test_native_file_import_keeps_binary_data_out_of_the_public_library(tmp_path) -> None:
    source = tmp_path / "owner-selected.png"
    image = Image.new("RGBA", (12, 9), "blue")
    image.save(source, format="PNG")
    manager = StickerManager(data_dir=tmp_path / "library")

    sticker = manager.collect_from_file(
        source,
        text="蓝色",
        style_tags=["用户导入"],
    )

    public = sticker.to_dict()
    assert public["image_data_url"].startswith("reverie-sticker://asset/")
    assert str(source) not in json.dumps(public, ensure_ascii=False)
    persisted = (tmp_path / "library" / "library.json").read_text(encoding="utf-8")
    assert "data:image" not in persisted
    assert str(source) not in persisted


def test_native_file_import_rejects_extension_content_mismatch(tmp_path) -> None:
    source = tmp_path / "forged.gif"
    image = Image.new("RGBA", (4, 4), "green")
    image.save(source, format="PNG")
    manager = StickerManager(data_dir=tmp_path / "library")

    with pytest.raises(ValueError):
        manager.collect_from_file(source)


def test_gif_duration_bomb_and_declared_type_mismatch_are_rejected(tmp_path) -> None:
    manager = StickerManager(data_dir=tmp_path)
    first = Image.new("P", (4, 4), 0)
    second = Image.new("P", (4, 4), 1)
    buffer = io.BytesIO()
    first.save(
        buffer,
        format="GIF",
        save_all=True,
        append_images=[second],
        duration=[60_100, 60_100],
        loop=0,
    )
    long_gif = "data:image/gif;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    with pytest.raises(ValueError, match="时长"):
        manager.collect("too long", image_data_url=long_gif)

    png = data_url(Image.new("RGB", (4, 4), "white"), "PNG")
    with pytest.raises(ValueError, match="内容与声明"):
        manager.collect("fake jpeg", image_data_url=png.replace("data:image/png", "data:image/jpeg"))
