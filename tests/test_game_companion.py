from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.games.companion import (
    GameCompanionError,
    build_move_messages,
    choose_move,
    parse_move_reply,
)
from src.kernel.contracts import CommandEnvelopeV4, GameMovePayload, PersonaScopeV4


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


@pytest.mark.asyncio
async def test_xiangqi_prompt_delivers_piece_identity_and_coordinates_to_adapter() -> None:
    adapter = FakeAdapter('{"move":"0,6,0,5","comment":"轮到你了"}')
    board = "x 0 1 2 3 4 5 6 7 8\ny=9 黑车 黑马 黑象 黑士 黑将帅 黑士 黑象 黑马 黑车\ny=0 红车 红马 红象 红士 红将帅 红士 红象 红马 红车"
    await choose_move(adapter, "合成人格", "xiangqi", {"board_text": board, "side": "黑棋", "history_text": "1 手"})
    messages = adapter.calls[0]["messages"]
    assert board in messages[1]["content"]
    assert "颜色和棋种" in messages[1]["content"]
    assert "▲" not in messages[1]["content"]
    assert "0 为红方底线" in messages[0]["content"]


def test_game_move_retry_note_defaults_to_empty() -> None:
    payload = GameMovePayload(game="xiangqi", state={"board_text": "棋盘"})
    assert payload.retry_note == ""


@pytest.mark.parametrize("note", ["", "棋" * 200], ids=["empty", "limit"])
def test_game_move_accepts_bounded_retry_note(note: str) -> None:
    payload = GameMovePayload(game="xiangqi", state={"board_text": "棋盘"}, retry_note=note)
    assert payload.retry_note == note


@pytest.mark.parametrize(
    ("extra", "field", "code"),
    [
        ({"retry_note": "棋" * 201}, "retry_note", "string_too_long"),
        ({"retry_note": 1}, "retry_note", "string_type"),
        ({"retry_note": None}, "retry_note", "string_type"),
        ({"retry_note": b"note"}, "retry_note", "string_type"),
        ({"extra_note": ""}, "extra_note", "extra_forbidden"),
    ],
    ids=["too-long", "number", "null", "bytes", "unknown-field"],
)
def test_game_move_rejects_invalid_retry_note_or_extra_field(extra, field, code) -> None:
    with pytest.raises(ValidationError) as rejected:
        GameMovePayload(game="xiangqi", state={"board_text": "棋盘"}, **extra)
    assert [(error["loc"], error["type"]) for error in rejected.value.errors()] == [((field,), code)]


@pytest.mark.asyncio
async def test_xiangqi_retry_note_reaches_prompt_after_v4_validation(monkeypatch) -> None:
    note = "黑车不能越过另一枚棋子"
    scope = PersonaScopeV4(persona_id="fixture", epoch=1, fingerprint="a" * 64)
    command = CommandEnvelopeV4(
        command="game:move",
        persona=scope,
        payload={"game": "xiangqi", "state": {"board_text": "棋盘", "side": "黑棋"}, "retry_note": note},
    )
    state = ws_bridge.BridgeState()
    state.adapter = adapter = FakeAdapter('{"move":"0,6,0,5","comment":""}')
    endpoint = object()
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {
        endpoint: ws_bridge.BridgeClientContext("xiangqi-test", 4, True),
    })

    reply = await ws_bridge.dispatch_authenticated_message(
        {"type": command.command, "request_id": command.request_id, "payload": command.payload},
        endpoint,
        emit_result=False,
    )

    assert reply == {"ok": True, "move": "0,6,0,5", "comment": ""}
    assert len(adapter.calls) == 1
    assert adapter.calls[0]["messages"][-1] == {
        "role": "user",
        "content": f"你上一步的走法不合法（{note}）。请重新观察棋盘，只输出一个新的合法 JSON 走法。",
    }
