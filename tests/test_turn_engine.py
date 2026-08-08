from __future__ import annotations

import asyncio

import pytest

from src.chat.turn_engine import (
    LegacySessionTurnGenerator,
    TurnEngine,
    TurnOutcome,
    TurnRequest,
)


def request(conversation_id: str, turn_id: str) -> TurnRequest:
    return TurnRequest(
        conversation_id=conversation_id,
        turn_id=turn_id,
        generation_id=turn_id,
        text="hello",
        persona_id="persona",
        persona_epoch=1,
        persona_fingerprint="a" * 64,
    )


@pytest.mark.asyncio
async def test_legacy_session_details_are_confined_to_adapter() -> None:
    observed: dict[str, object] = {}

    class Session:
        async def send_message(
            self,
            text: str,
            *,
            status_delay_applied: bool,
            defer_side_effects: bool,
            request_id: str,
        ) -> dict:
            observed.update(
                text=text,
                status_delay_applied=status_delay_applied,
                defer_side_effects=defer_side_effects,
                request_id=request_id,
            )
            return {"reply": "hi", "messages": ["hi"]}

    engine = TurnEngine(LegacySessionTurnGenerator(lambda: Session()))
    outcome = await engine.generate(request("conversation", "turn-1"), timeout=1)

    assert outcome.payload["reply"] == "hi"
    assert outcome.side_effects_deferred is True
    assert observed == {
        "text": "hello",
        "status_delay_applied": True,
        "defer_side_effects": True,
        "request_id": "turn-1",
    }


@pytest.mark.asyncio
async def test_same_conversation_is_serialized_but_different_conversations_are_not() -> None:
    release = asyncio.Event()
    entered: list[str] = []

    class Generator:
        async def generate(self, value: TurnRequest) -> TurnOutcome:
            entered.append(value.turn_id)
            await release.wait()
            return TurnOutcome(payload={"reply": value.turn_id}, side_effects_deferred=False)

    engine = TurnEngine(Generator())
    first = asyncio.create_task(engine.generate(request("same", "turn-1"), timeout=2))
    await asyncio.sleep(0)
    second = asyncio.create_task(engine.generate(request("same", "turn-2"), timeout=2))
    other = asyncio.create_task(engine.generate(request("other", "turn-3"), timeout=2))
    await asyncio.sleep(0)

    assert set(entered) == {"turn-1", "turn-3"}
    assert engine.active_generation("same") == "turn-1"
    release.set()
    await asyncio.gather(first, second, other)
    assert entered == ["turn-1", "turn-3", "turn-2"]
    assert engine.active_generation("same") is None
