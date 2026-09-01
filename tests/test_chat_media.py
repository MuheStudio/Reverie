from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from src.api.budget import ApiBudgetTracker
from src.chat.media import (
    ChatMediaError,
    load_data_url,
    resolve_sticker_asset,
    store_from_data_url,
    store_from_file,
    store_image_bytes,
)
from src.chat.session import _build_vision_user_turn, _provider_rejected_content
from src.bridge.ws_bridge import _resolve_chat_attachment


def _png_bytes(color=(200, 80, 120), size=(64, 48)) -> bytes:
    image = Image.new("RGB", size, color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _data_url(raw: bytes, mime: str = "image/png") -> str:
    import base64

    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def test_store_image_bytes_normalizes_and_dedupes(tmp_path, monkeypatch) -> None:
    from src.config import settings as settings_module

    monkeypatch.setattr(settings_module, "DATA_DIR", tmp_path / "data")
    first = store_image_bytes(_png_bytes())
    second = store_image_bytes(_png_bytes())
    assert first["media_id"] == second["media_id"]
    assert first["mime"] == "image/jpeg"
    stored = Path(str(first["path"]))
    assert stored.is_file() and stored.parent.name == "chat-media"
    assert stored.stat().st_size == int(first["bytes"])


def test_store_rejects_oversize_and_non_images(tmp_path, monkeypatch) -> None:
    from src.config import settings as settings_module

    monkeypatch.setattr(settings_module, "DATA_DIR", tmp_path / "data")
    with pytest.raises(ChatMediaError):
        store_image_bytes(b"")
    with pytest.raises(ChatMediaError):
        store_image_bytes(b"not an image at all")
    with pytest.raises(ChatMediaError):
        store_image_bytes(b"\x00" * (5 * 1024 * 1024 + 1))


def test_store_from_file_requires_absolute_existing_image(tmp_path, monkeypatch) -> None:
    from src.config import settings as settings_module

    monkeypatch.setattr(settings_module, "DATA_DIR", tmp_path / "data")
    with pytest.raises(ChatMediaError):
        store_from_file("relative/picture.png")
    with pytest.raises(ChatMediaError):
        store_from_file(str(tmp_path / "missing.png"))
    image_path = tmp_path / "pic.png"
    image_path.write_bytes(_png_bytes())
    media = store_from_file(str(image_path))
    assert str(media["media_id"]).strip()


def test_store_and_load_round_trip(tmp_path, monkeypatch) -> None:
    from src.config import settings as settings_module

    monkeypatch.setattr(settings_module, "DATA_DIR", tmp_path / "data")
    media = store_image_bytes(_png_bytes())
    data_url = load_data_url(str(media["media_id"]))
    assert data_url.startswith("data:image/jpeg;base64,")
    with pytest.raises(ChatMediaError):
        load_data_url("../escape")
    with pytest.raises(ChatMediaError):
        load_data_url("z" * 64)


def test_data_url_resolution_returns_durable_path_for_chat_session(tmp_path, monkeypatch) -> None:
    from src.config import settings as settings_module

    monkeypatch.setattr(settings_module, "DATA_DIR", tmp_path / "data")
    payload = {"image_data_url": _data_url(_png_bytes())}
    media = _resolve_chat_attachment(payload, None)
    assert media is not None
    assert Path(str(media["path"])).is_file()
    assert "image_data_url" not in payload


def test_sticker_asset_resolution_stays_inside_store(tmp_path, monkeypatch) -> None:
    from src.config import settings as settings_module

    data_dir = tmp_path / "data"
    monkeypatch.setattr(settings_module, "DATA_DIR", data_dir)
    asset_dir = data_dir / "stickers" / "assets"
    asset_dir.mkdir(parents=True)
    raw = _png_bytes(color=(10, 120, 200))
    import hashlib

    name = f"{hashlib.sha256(raw).hexdigest()}.png"
    (asset_dir / name).write_bytes(raw)

    media = resolve_sticker_asset(f"reverie-sticker://asset/{name}")
    assert media["media_id"]

    with pytest.raises(ChatMediaError):
        resolve_sticker_asset("reverie-sticker://asset/../../etc/passwd")
    with pytest.raises(ChatMediaError):
        resolve_sticker_asset("https://example.com/asset/x.png")


def test_vision_user_turn_shapes_openai_content_parts(tmp_path) -> None:
    from src.chat.media import store_image_bytes

    media = store_image_bytes(_png_bytes())
    turn = _build_vision_user_turn("看看这个", str(media["path"]))
    assert turn["role"] == "user"
    assert isinstance(turn["content"], list)
    assert turn["content"][0] == {"type": "text", "text": "看看这个"}
    assert turn["content"][1]["type"] == "image_url"
    assert turn["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")

    plain = _build_vision_user_turn("只有文字", "")
    assert plain == {"role": "user", "content": "只有文字"}

    missing = _build_vision_user_turn("图不见了", str(tmp_path / "gone.jpg"))
    assert isinstance(missing["content"], str)
    assert "图片" in missing["content"]


def test_provider_rejected_content_only_matches_definitive_4xx() -> None:
    class WithResponse(Exception):
        response = type("Resp", (), {"status_code": 400})()

    assert _provider_rejected_content(WithResponse()) is True

    class Timeout(Exception):
        pass

    assert _provider_rejected_content(Timeout()) is False
    assert _provider_rejected_content(None) is False


def test_budget_estimate_handles_multimodal_parts() -> None:
    image_url = "data:image/jpeg;base64," + "A" * 200_000
    messages = [
        {"role": "system", "content": "系统提示"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "看这张图"},
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        },
    ]
    estimate = ApiBudgetTracker.estimate_tokens(messages, max_tokens=512)
    # The base64 payload must not dominate the estimate: 4 text chars + 512
    # output + one fixed image allowance keeps the estimate bounded.
    assert estimate < 4_000
