"""Gemini/OpenAI TTS worker protocol tests (S3 regression)."""

from __future__ import annotations

import base64
import asyncio

from src.tts.workers.gemini import build_gemini_worker
from src.tts.workers.openai import build_openai_worker

GEMINI_SETTINGS = {
    "api_key": "test-key",
    "model": "gemini-2.5-flash-preview-tts",
    "base_url": "https://example.invalid/v1beta",
    "voice": "Kore",
    "timeout": 5.0,
}


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._payload


class FakeClient:
    def __init__(self, responses: list[dict]) -> None:
        self._responses = responses
        self.posted: list[tuple[str, dict, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        pass

    async def post(self, url: str, *, json: dict, headers: dict):
        self.posted.append((url, json, headers))
        return FakeResponse(self._responses.pop(0))


async def _run_with_client(worker, payload: dict) -> tuple[bytes, FakeClient]:
    fake = FakeClient([payload])
    import httpx

    original = httpx.AsyncClient
    httpx.AsyncClient = lambda **_: fake
    try:
        audio = await worker("你好。", "Kore")
    finally:
        httpx.AsyncClient = original
    return audio, fake


def test_gemini_worker_reads_snake_case_inline_data() -> None:
    expected = b"fake-wav-bytes"
    payload = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": "audio/wav",
                                "data": base64.b64encode(expected).decode("ascii"),
                            }
                        }
                    ]
                }
            }
        ]
    }
    audio, fake = asyncio.run(_run_with_client(build_gemini_worker(GEMINI_SETTINGS), payload))
    assert audio == expected
    assert fake.posted[0][1]["generationConfig"]["speechConfig"]["voiceConfig"][
        "prebuiltVoiceConfig"
    ]["voiceName"] == "Kore"


def test_gemini_worker_reads_camel_case_inline_data() -> None:
    expected = b"camel-bytes"
    payload = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": "audio/wav",
                                "data": base64.b64encode(expected).decode("ascii"),
                            }
                        }
                    ]
                }
            }
        ]
    }
    audio, _fake = asyncio.run(_run_with_client(build_gemini_worker(GEMINI_SETTINGS), payload))
    assert audio == expected


def test_gemini_worker_raises_when_audio_missing() -> None:
    payload = {"candidates": [{"content": {"parts": [{"text": "nothing here"}]}}]}
    try:
        asyncio.run(_run_with_client(build_gemini_worker(GEMINI_SETTINGS), payload))
    except RuntimeError as exc:
        assert "no audio" in str(exc)
    else:
        raise AssertionError("missing audio must raise")


def test_openai_worker_sends_wav_request() -> None:
    expected = b"wav-data"

    class WavFakeResponse:
        def raise_for_status(self) -> None:
            pass

        @property
        def content(self) -> bytes:
            return expected

    class OpenAiFakeClient:
        def __init__(self):
            self.posted: list[tuple[str, dict, dict]] = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> None:
            pass

        async def post(self, url: str, *, json: dict, headers: dict):
            self.posted.append((url, json, headers))
            return WavFakeResponse()

    import httpx

    fake = OpenAiFakeClient()
    original = httpx.AsyncClient
    httpx.AsyncClient = lambda **_: fake
    try:
        audio = asyncio.run(build_openai_worker({
            "api_key": "k",
            "model": "gpt-4o-mini-tts",
            "base_url": "https://example.invalid/v1",
            "voice": "nova",
            "timeout": 5.0,
        })("测试。", "nova"))
    finally:
        httpx.AsyncClient = original
    assert audio == expected
    assert fake.posted[0][1]["voice"] == "nova"
    assert fake.posted[0][1]["response_format"] == "wav"
