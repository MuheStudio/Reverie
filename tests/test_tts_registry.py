"""S3 TTS registry and runner tests."""

from __future__ import annotations

import asyncio

from src.tts import build_selected, registered_providers, resolve_selected, split_sentences, synthesize_ordered


def test_provider_registry_registers_hosted_backends() -> None:
    keys = {provider.key for provider in registered_providers()}
    assert {"gemini", "openai", "gpt-sovits"} <= keys


def test_resolve_selected_by_provider() -> None:
    assert resolve_selected({"provider": "gemini"}).key == "gemini"
    assert resolve_selected({"provider": "openai"}).key == "openai"
    assert resolve_selected({"provider": "gpt-sovits"}).key == "gpt-sovits"
    assert resolve_selected({"provider": "unknown"}) is None
    assert resolve_selected({}) is None


def test_build_selected_creates_synthesizer() -> None:
    synthesize = build_selected({"provider": "gemini", "api_key": "k"})
    assert callable(synthesize)
    assert build_selected({"provider": "nope"}) is None


def test_split_sentences_basic() -> None:
    text = "你好。今天天气不错！我们去散步吧？好呀；就这么定了。"
    parts = split_sentences(text)
    assert parts, "must split into at least one sentence"
    assert "".join(parts).replace(" ", "") == text


def test_split_sentences_merges_short_fragments() -> None:
    parts = split_sentences("嗯。对呀。确实如此，你说得很有道理。")
    assert len(parts) <= 2


def test_synthesize_ordered_keeps_text_order() -> None:
    async def slow_synth(index: int):
        async def synth(text: str, voice: str) -> bytes:
            # Reverse completion order: first sentence finishes last.
            delay = 0.05 * (2 - index)
            await asyncio.sleep(delay)
            return text.encode("utf-8")

        return synth

    async def run() -> None:
        synth = await slow_synth(1)
        audio = await synthesize_ordered(synth, "第一句。第二句。第三句。", "v")
        assert len(audio) == 3
        assert audio[0] == "第一句。".encode("utf-8")
        assert audio[1] == "第二句。".encode("utf-8")
        assert audio[2] == "第三句。".encode("utf-8")

    asyncio.run(run())


def test_synthesize_ordered_skips_failed_sentences() -> None:
    async def synth(text: str, voice: str) -> bytes:
        if "失败" in text:
            raise RuntimeError("boom")
        return text.encode("utf-8")

    audio = asyncio.run(synthesize_ordered(synth, "正常句。失败句。收尾句。", "v"))
    assert len(audio) == 2
    assert audio[0] == "正常句。".encode("utf-8")
