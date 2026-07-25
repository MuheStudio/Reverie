from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from src.chat.proactive import ProactiveChat, ProactiveResult
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import Persona, default_persona


class StableEmotion:
    values = {
        "joy": 50.0,
        "calm": 60.0,
        "excitement": 20.0,
        "sadness": 10.0,
        "anger": 5.0,
        "anxiety": 10.0,
        "grievance": 5.0,
        "touched": 15.0,
    }

    def get_dominant(self, count: int):
        return list(self.values.items())[:count]

    def get_mood_label(self) -> str:
        return "calm"


class StableClock:
    def now(self) -> datetime:
        return datetime(2026, 7, 18, 21, 0)

    def build_prompt_context(self) -> str:
        return "2026-07-18 21:00"


class BlockingAdapter:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def chat(self, *_args, **_kwargs):
        self.started.set()
        await self.release.wait()
        return SimpleNamespace(content="I wanted to check in with you tonight.")


class CountingAdapter:
    def __init__(self) -> None:
        self.calls = 0

    async def chat(self, *_args, **_kwargs):
        self.calls += 1
        return SimpleNamespace(content="This must never be generated.")


def replacement_for(source: Persona) -> Persona:
    data = source.to_dict()
    data["name"] = "Replacement"
    data["identity"]["persona_id"] = "replacement_persona"
    data["identity"]["identity_version"] = 1
    return Persona(**data)


def switch_persona(registry: PersonaEpochRegistry, source: Persona) -> None:
    authorization = registry.authorize_update(
        actor="owner",
        reason="deterministic race test",
        user_confirmed=True,
    )
    registry.activate_update(replacement_for(source), authorization)


@pytest.mark.asyncio
async def test_provider_result_finishing_after_persona_switch_never_persists_or_queues(
    tmp_path,
) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    adapter = BlockingAdapter()
    state_path = tmp_path / "proactive.json"
    proactive = ProactiveChat(
        original,
        adapter,
        StableEmotion(),
        world_clock=StableClock(),
        state_path=state_path,
        persona_epoch_registry=registry,
    )

    generation = asyncio.create_task(
        proactive._generate_message("evening_checkin", {"time": "21:00"})
    )
    await adapter.started.wait()
    switch_persona(registry, original)
    adapter.release.set()

    assert await generation is None
    assert proactive.drain_pending() == []
    assert proactive._last_triggered == {}
    assert not state_path.exists()


def test_stale_result_cannot_cross_the_atomic_persistence_queue_boundary(tmp_path) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    old_token = registry.activate_initial(original)
    state_path = tmp_path / "proactive.json"
    proactive = ProactiveChat(
        original,
        adapter=None,
        emotion=StableEmotion(),
        world_clock=StableClock(),
        state_path=state_path,
        persona_epoch_registry=registry,
    )
    stale = ProactiveResult(
        messages=["old persona output"],
        trigger="evening_checkin",
        emotion_changes={"joy": 1.0},
        persona_token=old_token,
        trigger_context={"time": "21:00"},
    )

    switch_persona(registry, original)

    assert proactive._enqueue_result(stale) is False
    assert proactive.drain_pending() == []
    assert proactive._last_triggered == {}
    assert not state_path.exists()


def test_drain_revalidates_results_that_were_queued_before_switch(tmp_path) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    old_token = registry.activate_initial(original)
    proactive = ProactiveChat(
        original,
        adapter=None,
        emotion=StableEmotion(),
        world_clock=StableClock(),
        state_path=tmp_path / "proactive.json",
        persona_epoch_registry=registry,
    )
    queued = ProactiveResult(
        messages=["still old"],
        trigger="evening_checkin",
        emotion_changes={},
        persona_token=old_token,
        trigger_context={"time": "21:00"},
    )
    assert proactive._enqueue_result(queued) is True

    switch_persona(registry, original)

    assert proactive.drain_pending() == []


@pytest.mark.asyncio
async def test_old_proactive_object_cannot_stamp_old_persona_text_with_new_epoch(tmp_path) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    adapter = CountingAdapter()
    proactive = ProactiveChat(
        original,
        adapter,
        StableEmotion(),
        world_clock=StableClock(),
        state_path=tmp_path / "proactive.json",
        persona_epoch_registry=registry,
    )
    switch_persona(registry, original)

    result = await proactive._generate_message("evening_checkin", {"time": "21:00"})

    assert result is None
    assert adapter.calls == 0
    assert proactive.drain_pending() == []
