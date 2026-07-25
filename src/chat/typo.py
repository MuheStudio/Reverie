"""Typo mechanism — occasional minor typing errors for realism.

Per requirements #55-56: the character may occasionally make small
typographical errors (letter swaps, repeated letters, etc.).

Applied to the character's output messages at a low rate (~3% per message).
Only affects display, never stored in memory/history.
"""

from __future__ import annotations

import logging
import random
import re

logger = logging.getLogger("reverie.chat.typo")

# Per-message typo probability (0.0 - 1.0)
TYPO_RATE = 0.03

_CJK_CONFUSIONS = {
    "的": "得", "得": "的", "地": "的", "在": "再", "再": "在",
    "那": "哪", "哪": "那", "吗": "嘛", "嘛": "吗", "已": "以",
    "以": "已", "做": "作", "作": "做", "呢": "呐", "呐": "呢",
}
_PROTECTED_PATTERN = re.compile(
    r"https?://\S+|www\.\S+|`[^`]*`|\b\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?\b",
    re.IGNORECASE,
)


def apply_typos(text: str, rate: float = TYPO_RATE) -> str:
    """Apply occasional minor typos to a text string.

    Supports both Chinese and alphabetic input. URLs, inline code, dates and
    numbers are protected, and each message receives at most one small error.
    """
    if not text or rate <= 0:
        return text

    if random.random() >= min(1.0, rate):
        return text

    protected: set[int] = set()
    for match in _PROTECTED_PATTERN.finditer(text):
        protected.update(range(match.start(), match.end()))

    confusion_candidates = [
        index for index, char in enumerate(text)
        if index not in protected and char in _CJK_CONFUSIONS
    ]
    cjk_candidates = [
        index for index, char in enumerate(text)
        if index not in protected and "\u4e00" <= char <= "\u9fff"
    ]

    if confusion_candidates:
        index = random.choice(confusion_candidates)
        replacement = _CJK_CONFUSIONS[text[index]]
        return text[:index] + replacement + text[index + 1:]

    if cjk_candidates:
        index = random.choice(cjk_candidates)
        # A duplicated character models a light IME/input slip while keeping
        # the clean source available for a possible retract-and-resend.
        return text[:index] + text[index] + text[index:]

    word_matches = [
        match for match in re.finditer(r"[A-Za-z]{3,}", text)
        if not any(index in protected for index in range(match.start(), match.end()))
    ]
    if not word_matches:
        return text
    match = random.choice(word_matches)
    changed = _apply_one_typo(match.group(0))
    return text[:match.start()] + changed + text[match.end():]


def _apply_one_typo(word: str) -> str:
    """Apply exactly one small typographic error to a word.

    Error types (chosen randomly):
      1. swap adjacent letters: "thinking" → "thniking"
      2. repeat a letter:       "hello" → "helllo"
      3. drop a letter:         "morning" → "morning" (skip mid char)
    """
    if len(word) < 3:
        return word

    error_type = random.randint(1, 3)

    if error_type == 1:  # Swap adjacent letters
        pos = random.randint(1, len(word) - 2)  # avoid first/last
        chars = list(word)
        chars[pos], chars[pos + 1] = chars[pos + 1], chars[pos]
        return "".join(chars)

    elif error_type == 2:  # Repeat a letter
        pos = random.randint(0, len(word) - 1)
        return word[:pos] + word[pos] + word[pos:]

    else:  # Drop a letter (from middle)
        pos = random.randint(1, len(word) - 2)
        return word[:pos] + word[pos + 1:]
