from __future__ import annotations

import math

import pytest

from src.games import GameStateConflict, GameStateStore


def test_game_state_is_persona_scoped_and_conflict_guarded(tmp_path) -> None:
    store = GameStateStore(tmp_path / "games.sqlite3")
    try:
        first = store.put(
            "persona-a",
            "gomoku",
            {"moves": [1, 2, 3], "winner": None},
            expected_revision=0,
        )
        assert first["revision"] == 1
        assert store.get("persona-a", "gomoku")["state"]["moves"] == [1, 2, 3]
        assert store.get("persona-b", "gomoku")["exists"] is False
        with pytest.raises(GameStateConflict):
            store.put(
                "persona-a",
                "gomoku",
                {"moves": []},
                expected_revision=0,
            )
    finally:
        store.close()


@pytest.mark.parametrize(
    "state",
    [
        {"__proto__": {"polluted": True}},
        {"score": math.inf},
        {"value": object()},
        {"text": "x" * 200_001},
    ],
)
def test_game_state_rejects_non_json_or_hostile_values(tmp_path, state) -> None:
    store = GameStateStore(tmp_path / "games.sqlite3")
    try:
        with pytest.raises(ValueError):
            store.put("persona-a", "snake", state, expected_revision=0)
        assert store.get("persona-a", "snake")["exists"] is False
    finally:
        store.close()
