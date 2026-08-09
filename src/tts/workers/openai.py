"""OpenAI-compatible TTS provider worker (hosted).

Uses the standard OpenAI audio/speech endpoint; also compatible with
DeepSeek-style compatible endpoints that expose the same API shape.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..registry import SynthesizeFn, TTSProvider, register

OPENAI_TTS_MODELS = ("gpt-4o-mini-tts", "tts-1", "tts-1-hd")
OPENAI_TTS_VOICES = (
    "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx",
    "nova", "sage", "shimmer", "verse", "marin", "cedar",
)

DEFAULT_MODEL = "gpt-4o-mini-tts"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_VOICE = "nova"

_MAX_TEXT_CHARS = 4_096


def build_openai_worker(settings: dict[str, Any]) -> SynthesizeFn:
    """Build a configured OpenAI-compatible synthesizer from TTS settings."""
    from ..registry import TTSUnavailableError

    api_key = str(settings.get("api_key") or "").strip()
    model = str(settings.get("model") or DEFAULT_MODEL)
    base_url = str(settings.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    default_voice = str(settings.get("voice") or DEFAULT_VOICE)
    timeout = float(settings.get("timeout") or 30.0)

    async def synthesize(text: str, voice: str) -> bytes:
        if not api_key:
            raise TTSUnavailableError("OpenAI TTS API key is not configured")
        if len(text) > _MAX_TEXT_CHARS:
            text = text[:_MAX_TEXT_CHARS]
        body = {
            "model": model,
            "input": text,
            "voice": voice or default_voice,
            "response_format": "wav",
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{base_url}/audio/speech",
                json=body,
                headers=headers,
            )
            response.raise_for_status()
        return response.content

    return synthesize


def register_openai() -> None:
    register(
        TTSProvider(
            key="openai",
            label="OpenAI Compatible TTS",
            kind="hosted",
            voice_options=OPENAI_TTS_VOICES,
            is_selected=lambda s: str(s.get("provider") or "") == "openai",
            build=build_openai_worker,
        )
    )
