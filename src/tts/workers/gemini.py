"""Gemini TTS provider worker (hosted).

Protocol adapted from airi's google-gemini-speech provider (MIT): POST
``models/{model}:generateContent`` with ``responseModalities: ['AUDIO']`` and
a prebuilt voice, returning base64 inline audio. All code is original.
"""

from __future__ import annotations

import base64
from typing import Any

import httpx

from ..registry import SynthesizeFn, TTSProvider, register

GEMINI_TTS_MODELS = (
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
    "gemini-3.1-flash-tts-preview",
)

GEMINI_TTS_VOICES = (
    "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
    "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
    "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
)

DEFAULT_MODEL = "gemini-2.5-flash-preview-tts"
DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_VOICE = "Kore"

_MAX_TEXT_CHARS = 5_000


def build_gemini_worker(settings: dict[str, Any]) -> SynthesizeFn:
    """Build a configured Gemini synthesizer from TTS settings."""
    from ..registry import TTSUnavailableError

    api_key = str(settings.get("api_key") or "").strip()
    model = str(settings.get("model") or DEFAULT_MODEL)
    base_url = str(settings.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    default_voice = str(settings.get("voice") or DEFAULT_VOICE)
    timeout = float(settings.get("timeout") or 30.0)

    async def synthesize(text: str, voice: str) -> bytes:
        if not api_key:
            raise TTSUnavailableError("Gemini TTS API key is not configured")
        if len(text) > _MAX_TEXT_CHARS:
            text = text[:_MAX_TEXT_CHARS]
        body = {
            "contents": [{"parts": [{"text": text}]}],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {"voiceName": voice or default_voice}
                    }
                },
            },
        }
        headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{base_url}/models/{model}:generateContent",
                json=body,
                headers=headers,
            )
            response.raise_for_status()
        candidates = response.json().get("candidates") or []
        parts = (candidates[0].get("content", {}).get("parts") or []) if candidates else []
        for part in parts:
            # The REST API returns snake_case inline_data; SDK-shaped adapters
            # may surface camelCase inlineData. Accept both (Murphy-proof).
            inline = part.get("inline_data") or part.get("inlineData") or {}
            data = inline.get("data")
            if isinstance(data, str) and data:
                return base64.b64decode(data)
        raise RuntimeError("Gemini TTS response contained no audio")

    return synthesize


def register_gemini() -> None:
    register(
        TTSProvider(
            key="gemini",
            label="Gemini TTS",
            kind="hosted",
            voice_options=GEMINI_TTS_VOICES,
            is_selected=lambda s: str(s.get("provider") or "") == "gemini",
            build=build_gemini_worker,
        )
    )
