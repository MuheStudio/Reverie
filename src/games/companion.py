"""Persona-driven board-game opponent.

The LLM chooses the move; the renderer's rules engine owns legality. The
renderer serializes the board into compact text (it owns the engines), this
module wraps it with the persona's voice plus a strict JSON instruction, and
a malformed or absent reply surfaces as an error — the renderer falls back to
its heuristic bot after one clarification retry, so the game can never hang.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("reverie.games.companion")

SUPPORTED_GAMES = {"gomoku", "chess", "xiangqi", "go"}

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)

# Playing a board game with the user is core companionship interaction — the
# same consent scope as a normal chat reply, not a new billing path.
_PROVIDER_PURPOSE = "chat_reply"


class GameCompanionError(RuntimeError):
    """The companion could not produce a usable move."""


def _board_section(state: dict[str, Any]) -> str:
    board_text = str(state.get("board_text") or "").strip()
    if not board_text:
        raise GameCompanionError("board_text is required")
    return board_text


def _move_instruction(game: str, state: dict[str, Any]) -> str:
    """Per-game reply contract the renderer's validator understands."""
    if game == "gomoku":
        return '{"move": <0-224 的格子编号（行*15+列）>, "comment": "..."}'
    if game == "chess":
        return '{"move": "<合法的 SAN 走法，例如 Nf3 或 exd5>", "comment": "..."}'
    if game == "xiangqi":
        return '{"move": "<起点x,起点y,终点x,终点y 的四个整数：x 是 0-8 的列（从左到右），y 是 0-9 的行（0 为红方底线，9 为黑方底线），例如 \\"4,9,4,8\\">", "comment": "..."}'
    if game == "go":
        return '{"move": "<列,行 两个 0-8 整数，例如 \\"2,3\\"，或 \\"pass\\">", "comment": "..."}'
    raise GameCompanionError(f"unsupported game: {game}")


def build_move_messages(persona_name: str, game: str, state: dict[str, Any]) -> list[dict[str, Any]]:
    side = str(state.get("side") or "").strip() or "对方"
    history_text = str(state.get("history_text") or "").strip()
    system = (
        f"你是 {persona_name}，正在陪用户下{game}。你执{side}。"
        "认真观察棋盘，选择一步合理且合法的走法。"
        "回复必须是仅含一个 JSON 对象的一行，格式："
        f"{_move_instruction(game, state)}"
        " comment 是一句不超过 18 个字的、符合你性格的短评，不要提及格式本身。"
    )
    user = (
        f"当前棋盘（你的棋子用 ▲ 表示，用户棋子用 △ 表示）：\n{_board_section(state)}\n"
        + (f"走子记录：{history_text}\n" if history_text else "")
        + "请只输出 JSON。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def parse_move_reply(raw: str) -> dict[str, Any]:
    """Extract the move + comment from a free-form model reply."""
    match = _JSON_RE.search(raw or "")
    if not match:
        raise GameCompanionError("reply does not contain a JSON object")
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise GameCompanionError("reply JSON is invalid") from exc
    if not isinstance(parsed, dict) or "move" not in parsed:
        raise GameCompanionError("reply is missing the move field")
    move = parsed.get("move")
    if isinstance(move, (dict, list)) or move is None:
        raise GameCompanionError("reply move has an unsupported shape")
    comment = str(parsed.get("comment") or "").strip()
    if len(comment) > 60:
        comment = comment[:60]
    return {"move": str(move).strip(), "comment": comment}


async def choose_move(
    adapter: Any,
    persona_name: str,
    game: str,
    state: dict[str, Any],
    *,
    retry_note: str = "",
) -> dict[str, Any]:
    """Ask the persona for one move. Raises GameCompanionError on failure."""
    if adapter is None:
        raise GameCompanionError("no adapter available")
    if game not in SUPPORTED_GAMES:
        raise GameCompanionError(f"unsupported game: {game}")
    messages = build_move_messages(persona_name, game, state)
    if retry_note:
        messages.append({
            "role": "user",
            "content": f"你上一步的走法不合法（{retry_note}）。请重新观察棋盘，只输出一个新的合法 JSON 走法。",
        })
    response = await adapter.chat(
        messages,
        purpose=_PROVIDER_PURPOSE,
        background=False,
        temperature=0.4,
        max_tokens=160,
    )
    return parse_move_reply(str(response.content))


__all__ = [
    "GameCompanionError",
    "SUPPORTED_GAMES",
    "build_move_messages",
    "choose_move",
    "parse_move_reply",
]
