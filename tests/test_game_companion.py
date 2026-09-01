from __future__ import annotations

import pytest

from src.games.companion import (
    GameCompanionError,
    build_move_messages,
    choose_move,
    parse_move_reply,
)


class FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content


class FakeAdapter:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict] = []

    async def chat(self, messages, *, purpose, background, temperature=None, max_tokens=None):
        self.calls.append({
            "messages": messages,
            "purpose": purpose,
            "background": background,
        })
        return FakeResponse(self.content)


@pytest.mark.asyncio
async def test_choose_move_parses_json_reply_and_uses_chat_purpose() -> None:
    adapter = FakeAdapter('{"move": "112", "comment": "这一步我挡住你啦"}')
    result = await choose_move(adapter, "星野幻月", "gomoku", {"board_text": "· " * 10, "side": "白棋"})
    assert result["move"] == "112"
    assert result["comment"] == "这一步我挡住你啦"
    assert adapter.calls[0]["purpose"] == "chat_reply"
    assert adapter.calls[0]["background"] is False
    system = adapter.calls[0]["messages"][0]["content"]
    assert "星野幻月" in system
    assert "JSON" in system


@pytest.mark.asyncio
async def test_choose_move_rejects_unsupported_game_and_missing_board() -> None:
    adapter = FakeAdapter("{}")
    with pytest.raises(GameCompanionError):
        await choose_move(adapter, "星野幻月", "tictactoe", {"board_text": "x"})
    with pytest.raises(GameCompanionError):
        await choose_move(adapter, "星野幻月", "chess", {"side": "黑棋"})


@pytest.mark.asyncio
async def test_choose_move_appends_retry_note_for_illegal_moves() -> None:
    adapter = FakeAdapter('{"move": "e2e4"}')
    await choose_move(
        adapter,
        "星野幻月",
        "chess",
        {"board_text": "board", "side": "黑棋"},
        retry_note="这不是一步合法的走法",
    )
    last_message = adapter.calls[0]["messages"][-1]["content"]
    assert "不合法" in last_message


def test_parse_move_reply_extracts_json_from_chatty_output() -> None:
    result = parse_move_reply('好的！{"move": "2,3", "comment": "那我就下这里吧"} 请看。')
    assert result["move"] == "2,3"
    assert result["comment"] == "那我就下这里吧"
    assert parse_move_reply('{"move": "pass"}')["comment"] == ""


def test_parse_move_reply_rejects_structural_garbage() -> None:
    for bad in ("我觉得下中间比较好", '{"comment": "没有走法"}', '{"move": {"x": 1}}', "{broken"):
        with pytest.raises(GameCompanionError):
            parse_move_reply(bad)


def test_build_move_messages_describes_per_game_reply_contract() -> None:
    for game, marker in (
        ("gomoku", "0-224"),
        ("chess", "SAN"),
        ("xiangqi", "0-8"),
        ("go", "pass"),
    ):
        messages = build_move_messages("星野幻月", game, {"board_text": "b", "side": "黑棋"})
        assert marker in messages[0]["content"], game
