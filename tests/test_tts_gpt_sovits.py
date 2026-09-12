"""Local GPT-SoVITS worker: loopback-only URL, active pack, HTTP synthesis."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from src.tts.registry import TTSUnavailableError
from src.tts.workers.gpt_sovits import (
    build_gpt_sovits_worker,
    infer_lang,
    load_active_voice_pack,
    loopback_base_url,
)


def test_loopback_base_url_accepts_localhost_and_rejects_lan() -> None:
    assert loopback_base_url("http://127.0.0.1:9880") == "http://127.0.0.1:9880"
    assert loopback_base_url("http://localhost:9880/") == "http://127.0.0.1:9880"
    with pytest.raises(TTSUnavailableError):
        loopback_base_url("http://192.168.1.8:9880")
    with pytest.raises(TTSUnavailableError):
        loopback_base_url("https://127.0.0.1:9880")
    with pytest.raises(TTSUnavailableError):
        loopback_base_url("http://127.0.0.1:9880/tts")


def test_infer_lang_zh_en() -> None:
    assert infer_lang("你好，今天过得怎么样") == "zh"
    assert infer_lang("hello there") == "en"


def _write_pack(root: Path) -> Path:
    pack_id = "11111111-1111-4111-8111-111111111111"
    record = root / pack_id
    payload = record / "payload"
    payload.mkdir(parents=True)
    (payload / "model.ckpt").write_bytes(b"ckpt")
    (payload / "model.pth").write_bytes(b"pth")
    (payload / "reference.wav").write_bytes(b"RIFF")
    (payload / "reference.txt").write_text("参考台词", encoding="utf-8")
    manifest = {
        "schema": "reverie.voice-pack.v1",
        "id": pack_id,
        "runtime": {"family": "gpt-sovits", "version": "v2"},
        "files": [
            {"role": "gptCheckpoint", "originalName": "model.ckpt"},
            {"role": "sovitsCheckpoint", "originalName": "model.pth"},
            {"role": "referenceAudio", "originalName": "reference.wav"},
            {"role": "transcript", "originalName": "reference.txt"},
        ],
    }
    (record / "reverie.voice-pack.v1.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "active.json").write_text(
        json.dumps({"schema": "reverie.voice-pack-active.v1", "id": pack_id}),
        encoding="utf-8",
    )
    return payload


def test_load_active_voice_pack(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    packs = tmp_path / "voice-packs"
    payload = _write_pack(packs)
    loaded = load_active_voice_pack(data_dir)
    assert loaded is not None
    assert loaded["gpt"] == payload / "model.ckpt"
    assert loaded["prompt_text"] == "参考台词"
    assert loaded["prompt_lang"] == "zh"


def test_gpt_sovits_worker_posts_tts(monkeypatch, tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write_pack(tmp_path / "voice-packs")

    class FakeResponse:
        def __init__(self, content: bytes, status_code: int = 200, content_type: str = "audio/wav"):
            self.content = content
            self.status_code = status_code
            self.headers = {"content-type": content_type}

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise RuntimeError("http error")

    class FakeClient:
        def __init__(self):
            self.gets: list[tuple[str, dict]] = []
            self.posts: list[tuple[str, dict]] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> None:
            return None

        async def get(self, url: str, params=None, timeout=None):
            self.gets.append((url, dict(params or {})))
            return FakeResponse(b"ok")

        async def post(self, url: str, json=None):
            self.posts.append((url, dict(json or {})))
            return FakeResponse(b"RIFFWAV")

    fake = FakeClient()
    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda **_: fake)
    worker = build_gpt_sovits_worker({
        "provider": "gpt-sovits",
        "base_url": "http://127.0.0.1:9880",
        "data_dir": str(data_dir),
    })
    audio = asyncio.run(worker("你好。", ""))
    assert audio == b"RIFFWAV"
    assert any(url.endswith("/set_gpt_weights") for url, _ in fake.gets)
    assert fake.posts[0][1]["text"] == "你好。"
    assert fake.posts[0][1]["media_type"] == "wav"
    assert fake.posts[0][1]["streaming_mode"] is False
