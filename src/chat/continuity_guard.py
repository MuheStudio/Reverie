"""Local post-generation checks for hard persona and world contradictions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class ContinuityResult:
    text: str
    allowed: bool
    violations: tuple[str, ...] = ()


def enforce_continuity(
    text: str,
    *,
    persona: Any,
    now: datetime,
    intimacy: int,
    emotions: dict[str, float],
    affairs_context: str = "",
) -> ContinuityResult:
    """Veto explicit hard contradictions while leaving free expression intact."""
    violations: list[str] = []
    age = 0
    if not getattr(persona, "identity", {}).get("age_unknown"):
        try:
            age = int(persona.age_on(now))
        except Exception:
            age = int(getattr(persona, "age", 0) or 0)
    for match in re.finditer(r"我(?:今年)?\s*(\d{1,3})\s*岁", text):
        if age and int(match.group(1)) != age:
            violations.append("persona_age")

    birthday = str(getattr(persona, "birthday", "") or "")
    birthday_match = re.search(r"我的?生日(?:是|在)?\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*日?", text)
    if birthday and birthday_match:
        try:
            expected = datetime.fromisoformat(birthday).date()
            if (int(birthday_match.group(1)), int(birthday_match.group(2))) != (expected.month, expected.day):
                violations.append("persona_birthday")
        except ValueError:
            pass

    claimed_name = re.search(r"我叫\s*([\u3400-\u9fffA-Za-z·]{2,24})", text)
    persona_name = str(getattr(persona, "name", "") or "")
    if claimed_name and persona_name and claimed_name.group(1).strip() != persona_name:
        violations.append("persona_name")

    if intimacy < 500 and re.search(r"(?:你是我(?:老公|老婆|爱人)|老公[呀啊，,！!]|老婆[呀啊，,！!])", text):
        violations.append("relationship_stage")

    stripped = text.strip()
    if now.hour >= 12 and stripped.startswith(("早上好", "早安")):
        violations.append("time_of_day")
    if (now.hour < 11 or now.hour >= 19) and stripped.startswith("下午好"):
        violations.append("time_of_day")
    if now.hour < 17 and stripped.startswith("晚上好"):
        violations.append("time_of_day")

    emotion_negations = {
        "joy": ("我一点也不开心", "我完全不开心"),
        "anger": ("我一点也不生气", "我完全没生气"),
        "sadness": ("我一点也不难过", "我完全不难过"),
        "anxiety": ("我一点也不紧张", "我完全不紧张"),
    }
    for emotion, phrases in emotion_negations.items():
        if float(emotions.get(emotion, 0.0) or 0.0) >= 75 and any(phrase in text for phrase in phrases):
            violations.append(f"emotion_{emotion}")

    for line in affairs_context.splitlines():
        if "：已完成" not in line:
            continue
        title = line.removeprefix("- ").split("：", 1)[0].strip()
        if title and title in text and any(mark in text for mark in ("还没开始", "准备开始", "尚未开始")):
            violations.append("affair_regression")

    if not violations:
        return ContinuityResult(text=text, allowed=True)
    fallback = _safe_fallback(persona_name, emotions, intimacy)
    return ContinuityResult(
        text=fallback,
        allowed=False,
        violations=tuple(dict.fromkeys(violations)),
    )


def _safe_fallback(persona_name: str, emotions: dict[str, float], intimacy: int) -> str:
    if float(emotions.get("anger", 0.0) or 0.0) >= 55:
        return "唔，我刚才说乱了，还是按我们记得的来"
    if float(emotions.get("sadness", 0.0) or 0.0) >= 55:
        return "刚刚那句不太对……我不想把记得的事说乱"
    if intimacy >= 500:
        return "等等，我刚才说岔了，还是按我们之前记得的来呀"
    return f"唔，我刚才说错了……我是{persona_name}，还是按之前的事来吧"
