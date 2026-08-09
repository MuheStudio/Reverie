"""Reverie text-to-speech package.

Design derived from N.E.K.O's tts_client (Apache-2.0): declarative provider
registry + ordered sentence synthesis. Providers:

- ``gemini``: Google Gemini TTS (protocol from airi, MIT)
- ``openai``: OpenAI-compatible audio/speech endpoint

Usage::

    synthesize = tts.build_selected(settings)
    audio = await synthesize("你好，今天过得怎么样？", "Kore")
"""

from __future__ import annotations

from .registry import (
    SynthesizeFn,
    TTSProvider,
    TTSUnavailableError,
    build_selected,
    register,
    registered_providers,
    resolve_selected,
)
from .runner import split_sentences, synthesize_ordered
from .workers.gemini import build_gemini_worker, register_gemini
from .workers.openai import build_openai_worker, register_openai

__all__ = [
    "SynthesizeFn",
    "TTSProvider",
    "TTSUnavailableError",
    "build_gemini_worker",
    "build_openai_worker",
    "build_selected",
    "register",
    "register_gemini",
    "register_openai",
    "registered_providers",
    "resolve_selected",
    "split_sentences",
    "synthesize_ordered",
]


def _register_defaults() -> None:
    register_gemini()
    register_openai()


_register_defaults()
