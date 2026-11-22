"""W22 preview prompt hints and ordinary text delivery."""

import asyncio
from datetime import datetime
import random
import re

import pytest

from src.api.adapter import ChatResponse, LLMAdapter
from src.bridge import ws_bridge
from src.chat.kaomoji import kaomoji_palette, kaomoji_spans, recent_kaomoji_used
from src.chat.scheduler import MessageScheduler
from src.chat.typo import apply_typos
from src.persona.persona_card import default_persona
from src.persona.prompt_builder import build_system_prompt
from src import stickers
from tests.test_preview_chat_image import PreviewClient, desktop, mounted


KAOMOJI = "(◡‿◡✿)"
RULE_PREFIX = "- Occasionally, at most about one reply in five and never in consecutive replies, "
CALM_RULE = (
    RULE_PREFIX
    + "you may end one message with exactly one of these kaomoji when it fits your mood: "
      "(´-ω-`) (￣▽￣*)ゞ (◡‿◡✿). Skip it for serious, sad or urgent topics, and never explain it."
)


@pytest.mark.parametrize("emotion", ["joy", "calm", "excitement", "sadness", "anger", "anxiety", "grievance", "touched"])
def test_palette_uses_first_three_safe_entries_in_library_order(emotion):
    banned = "，,！!？?。.<>\r\n"
    expected = [entry for entry in stickers.DEFAULT_KAOMOJI[emotion] if not any(ch in entry for ch in banned)][:3]
    assert len(expected) == 3
    assert kaomoji_palette(emotion) == kaomoji_palette(emotion) == tuple(expected)


def test_unknown_emotion_and_recent_matching_use_the_builtin_library():
    assert kaomoji_palette("unknown") == ("(´-ω-`)", "(￣▽￣*)ゞ", KAOMOJI)
    assert recent_kaomoji_used(["好呀", f"也可以 {KAOMOJI}"])
    assert recent_kaomoji_used(["zzz...(_ _).｡o○"])
    assert not recent_kaomoji_used(["好呀", "(◡‿◡)"])
    assert not recent_kaomoji_used([])


def test_prompt_adds_only_the_optional_formatting_rule():
    persona = default_persona()
    now = datetime(2026, 11, 18, 12)
    anchor = "- Use emojis naturally but sparingly\n"
    original = build_system_prompt(persona, current_time=now)
    assert build_system_prompt(persona, current_time=now, kaomoji=()) == original
    actual = build_system_prompt(persona, current_time=now, kaomoji=kaomoji_palette("calm"))
    assert original.count(anchor) == 1
    assert actual == original.replace(anchor, anchor + CALM_RULE + "\n")


@pytest.mark.asyncio
async def test_preview_assembly_and_session_hint_switch(desktop, monkeypatch):
    monkeypatch.setattr(stickers, "STICKERS_DIR", desktop.root / "stickers")
    async with mounted(desktop) as runtime:
        session = runtime._session
        assert session.kaomoji_hints is True
        assert session.stickers is None
        assert desktop.config.features.emotion_system_enabled is False
        session.emotion.values["calm"] = 100
        text = "来聊聊今天读到的小说"

        session.kaomoji_hints = False
        await session.send_message(text, request_id="kaomoji_disabled", defer_side_effects=True)
        session.kaomoji_hints = True
        await session.send_message(text, request_id="kaomoji_enabled", defer_side_effects=True)
        off, on = [messages[0]["content"] for messages in desktop.model_calls]
        assert RULE_PREFIX not in off
        assert CALM_RULE in on
        proactive = runtime._proactive._build_proactive_prompt(
            "合成上下文", "calm", {"source": "history", "detail": "书签"},
        )
        assert RULE_PREFIX not in proactive


def _sticker_files(root):
    return {path.relative_to(root): path.read_bytes() for path in root.rglob("*") if path.is_file()}


@pytest.mark.asyncio
async def test_kaomoji_delivery_recent_reply_window_and_no_sticker_writes(desktop, monkeypatch):
    sticker_dir = desktop.root / "stickers"
    monkeypatch.setattr(stickers, "STICKERS_DIR", sticker_dir)

    def unexpected_use(*_args, **_kwargs):
        pytest.fail("preview should not use sticker usage recording")

    monkeypatch.setattr(stickers.StickerManager, "record_use", unexpected_use)
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.8)
    short_reply = f"好呀 {KAOMOJI}"
    long_reply = "这本小说从一个很普通的早晨写起却让后面的转折更动人，后来几个人在小镇慢慢成了朋友也解决了眼前的难题，最后结局我很喜欢 " + KAOMOJI
    replies = iter((short_reply, "我也这么想", "可以呀", "说得有道理", long_reply))

    async def provider(_adapter, messages, *_args, **_kwargs):
        desktop.model_calls.append(messages)
        return ChatResponse(next(replies), model="isolated-preview")

    monkeypatch.setattr(LLMAdapter, "_ollama_chat", provider)
    async with mounted(desktop) as runtime:
        before = _sticker_files(sticker_dir)
        runtime._session.emotion.values["calm"] = 100
        client = PreviewClient(monkeypatch, desktop.epochs)
        coordinator = ws_bridge._get_chat_coordinator()
        coordinator.reply_start_planner = None

        async def skip_delay(_seconds):
            return None

        coordinator.sleep = skip_delay
        request_ids = [f"kaomoji_turn_{index}" for index in range(5)]
        for request_id in request_ids:
            await client.command("chat:send", request_id, text="一起聊聊刚才读的小说")
            await asyncio.wait_for(coordinator.tasks[request_id], timeout=8)
            assert coordinator.store.get_item(request_id)["state"] == "done"
            assert _sticker_files(sticker_dir) == before

        assert [CALM_RULE in call[0]["content"] for call in desktop.model_calls] == [True, False, False, False, True]
        history = await client.history("kaomoji_history")
        for index in (0, 4):
            request_id = request_ids[index]
            delivered = [frame["payload"]["text"] for frame in client.frames
                         if frame["type"] == "chat:bubble" and frame["payload"]["request_id"] == request_id]
            stored = [item["content"] for item in history if item["role"] == "assistant" and item["request_id"] == request_id]
            assert stored == delivered
            assert (len(delivered) > 1) == (index == 4)
            assert delivered[-1].endswith(KAOMOJI)
            assert sum(bubble.count(KAOMOJI) for bubble in delivered) == 1


def test_library_spans_choose_the_longest_entry_at_the_same_start():
    longer = "(´-ω-`)..."
    text = f"前{longer} {KAOMOJI}后"
    second = text.index(KAOMOJI)
    assert kaomoji_spans(text) == [(1, 1 + len(longer)), (second, second + len(KAOMOJI))]
    assert kaomoji_spans("自造表情 (x_x)") == []


def test_hard_cut_keeps_end_kaomoji_and_its_punctuation():
    face = "(´；ω；`)"
    text = "长" * 80 + face
    assert 80 < 84 < len(text)
    bubbles = MessageScheduler(split_messages=True).split_message(text)
    assert bubbles[-1] == face
    assert sum(bubble.count(face) for bubble in bubbles) == 1
    assert "".join(bubbles).replace(" ", "") == text.replace(" ", "")


def test_hard_cut_moves_after_a_span_starting_at_the_current_chunk(monkeypatch):
    face = "〔" + "表" * 45 + "〕"
    text = face + "后" * 50
    # The built-in entries are shorter than 42, so simulate a longer span.
    monkeypatch.setattr("src.chat.scheduler.kaomoji_spans", lambda _: [(0, len(face))])
    bubbles = MessageScheduler(split_messages=True).split_message(text)
    assert bubbles[0] == face
    assert "".join(bubbles) == text


def _previous_split(scheduler, message):
    if not scheduler.should_split(message):
        return [message]
    normalize = scheduler._normalize_chat_punctuation
    sentences = [part.strip() for part in re.split(r"(?<=[，,！!？?\n])\s*", message) if part.strip()]
    chunks = []
    current = ""
    for sentence in sentences:
        candidate = current + sentence
        if current and len(candidate) > 42:
            chunks.append(normalize(current.strip()))
            current = sentence
        else:
            current = candidate
    if current:
        chunks.append(normalize(current.strip()))
    hard_chunks = []
    for chunk in chunks:
        if len(chunk) <= 48:
            hard_chunks.append(chunk)
            continue
        for start in range(0, len(chunk), 42):
            hard_chunks.append(normalize(chunk[start:start + 42]))
    return [chunk for chunk in hard_chunks if chunk] or [normalize(message)]


def test_hard_cut_leaves_seeded_non_kaomoji_replies_unchanged():
    scheduler = MessageScheduler(split_messages=True)
    rng = random.Random(22)
    alphabet = "一起看书窗边长句次序xyz，,！!？?。.;： \n"
    for _ in range(500):
        text = "".join(rng.choices(alphabet, k=rng.randint(1, 200)))
        assert kaomoji_spans(text) == []
        assert scheduler.split_message(text) == _previous_split(scheduler, text)


def test_typo_protection_excludes_han_characters_inside_the_kaomoji():
    face = "٩(╬ʘ益ʘ╬)۶"
    assert apply_typos(face, rate=1.0) == face
    assert apply_typos(f"窗 {face}", rate=1.0) == f"窗窗 {face}"
