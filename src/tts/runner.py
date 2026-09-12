"""Sentence-buffered, ordered TTS synthesis runner.

Adapted from the N.E.K.O ``_run_sentence_tts_worker`` design: text is split
into sentences, synthesized concurrently (bounded), and audio is delivered in
sentence order regardless of completion order. All code is original.
"""

from __future__ import annotations

import asyncio
import logging
import re

from .registry import SynthesizeFn, TTSUnavailableError

logger = logging.getLogger("reverie.tts")

_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;…~])\s*|\n+")

MAX_CONCURRENT = 3
MAX_SENTENCE_CHARS = 500


def split_sentences(text: str) -> list[str]:
    parts = [part.strip() for part in _SENTENCE_SPLIT.split(text) if part.strip()]
    merged: list[str] = []
    for part in parts:
        # Merge only reply-noise fragments (1-2 chars plus punctuation, e.g.
        # "嗯。", "对呀。") into the previous sentence. Real sentences must
        # stay separate to preserve intonation and keep synthesis concurrent.
        if merged and len(merged[-1]) < MAX_SENTENCE_CHARS and len(part) <= 3:
            merged[-1] += part
        else:
            merged.append(part)
    return [part for part in merged if part]


async def synthesize_ordered(
    synthesize: SynthesizeFn,
    text: str,
    voice: str,
) -> list[bytes]:
    """Synthesize sentences concurrently but return audio in text order."""
    sentences = split_sentences(text)
    if not sentences:
        return []
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    results: dict[int, bytes] = {}

    async def one(index: int, sentence: str) -> None:
        async with semaphore:
            try:
                audio = await synthesize(sentence, voice)
                if audio:
                    results[index] = audio
            except TTSUnavailableError:
                raise
            except Exception:
                logger.exception("TTS sentence %d failed; skipping", index)

    await asyncio.gather(*(one(i, s) for i, s in enumerate(sentences)))
    return [results[i] for i in sorted(results) if i in results]
