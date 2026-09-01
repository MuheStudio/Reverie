from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from src.chat.proactive import ProactiveChat
from src.config.settings import FeatureSettings
from src.kernel.contracts import PersonaScopeV4, SettingsUpdatePayload
from src.kernel.storage import KernelStore
from src.persona.persona_card import default_persona


class Emotion:
    values = {"joy": 50.0, "calm": 60.0}

    def get_dominant(self, count=3):
        return list(self.values.items())[:count]

    def get_mood_label(self):
        return "calm"


class Clock:
    def now(self):
        return datetime(2026, 9, 1, 21, 0)

    def coerce(self, value):
        return value or self.now()

    def build_prompt_context(self):
        return "2026-09-01 21:00"


class Adapter:
    def __init__(self):
        self.calls = []

    async def chat(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        return SimpleNamespace(content="你提到的蓝色杯子后来找到了吗？")


def make_proactive(tmp_path, **kwargs):
    return ProactiveChat(
        default_persona(),
        kwargs.pop("adapter", Adapter()),
        Emotion(),
        world_clock=Clock(),
        state_path=tmp_path / "proactive.json",
        **kwargs,
    )


def test_wake_range_is_strict_and_cross_field_validated(tmp_path):
    with pytest.raises(ValueError):
        make_proactive(tmp_path, wake_min_minutes=1)
    with pytest.raises(ValueError):
        make_proactive(tmp_path, wake_min_minutes=11, wake_max_minutes=10)
    with pytest.raises(ValidationError):
        FeatureSettings(proactive_wake_min_minutes=11, proactive_wake_max_minutes=10)
    with pytest.raises(ValidationError):
        SettingsUpdatePayload(
            section="features",
            proactive_wake_min_minutes=11,
            proactive_wake_max_minutes=10,
        )


@pytest.mark.asyncio
async def test_loop_draws_fresh_inclusive_delay_and_duplicate_start_is_one_task(tmp_path):
    draws = iter((120, 600, 301))
    bounds = []
    sleeps = []
    proactive = make_proactive(
        tmp_path,
        random_seconds=lambda low, high: bounds.append((low, high)) or next(draws),
        sleep=lambda delay: sleeps.append(delay) or asyncio.sleep(0),
        chat_busy=lambda: True,
    )
    proactive.start()
    task = proactive._task
    proactive.start()
    assert proactive._task is task
    while len(sleeps) < 3:
        await asyncio.sleep(0)
    proactive.stop()
    await asyncio.gather(task, return_exceptions=True)
    assert sleeps == [120, 600, 301]
    assert bounds == [(120, 600)] * 3


@pytest.mark.asyncio
async def test_busy_or_missing_grounding_never_calls_provider(tmp_path):
    adapter = Adapter()
    busy = make_proactive(tmp_path, adapter=adapter, chat_busy=lambda: True)
    assert await busy._generate_message("evening_checkin", {"time": "21:00"}) is None
    empty = make_proactive(tmp_path, adapter=adapter)
    assert await empty._generate_message("evening_checkin", {"time": "21:00"}) is None
    assert adapter.calls == []


@pytest.mark.asyncio
async def test_authoritative_store_failure_does_not_fall_back_to_memory(tmp_path):
    class BrokenStore:
        def message_page(self, *_args, **_kwargs):
            raise OSError("database unavailable")

    adapter = Adapter()
    proactive = make_proactive(
        tmp_path,
        adapter=adapter,
        kernel_store=BrokenStore(),
        memory=SimpleNamespace(retrieve_relevant=lambda *_args, **_kwargs: ["蓝色杯子"]),
    )

    assert await proactive._generate_message("evening_checkin", {"time": "21:00"}) is None
    assert adapter.calls == []


@pytest.mark.asyncio
async def test_provider_output_without_grounding_detail_is_discarded(tmp_path):
    class GenericAdapter(Adapter):
        async def chat(self, messages, **kwargs):
            self.calls.append((messages, kwargs))
            return SimpleNamespace(content="今晚过得怎么样？")

    adapter = GenericAdapter()
    proactive = make_proactive(
        tmp_path,
        adapter=adapter,
        memory=SimpleNamespace(retrieve_relevant=lambda *_args, **_kwargs: ["我的蓝色杯子找不到了"]),
    )

    assert await proactive._generate_message("evening_checkin", {"time": "21:00"}) is None
    assert len(adapter.calls) == 1


@pytest.mark.asyncio
async def test_authoritative_recent_conversation_precedes_memory_and_is_untrusted(tmp_path):
    persona = default_persona()
    adapter = Adapter()
    store = KernelStore(tmp_path / "kernel.sqlite3")
    token = persona.identity_envelope
    scope = PersonaScopeV4(persona_id=token.persona_id, epoch=1, fingerprint=token.fingerprint)
    store.activate_persona(
        scope,
        identity={"name": persona.name},
        identity_version=1,
        actor="bootstrap",
        reason="test",
    )
    store.append_user_message(
        request_id="chat_grounding_1",
        conversation_id="dream-room",
        persona_id=scope.persona_id,
        text="我的蓝色杯子找不到了",
    )
    memory = SimpleNamespace(retrieve_relevant=lambda *_args, **_kwargs: ["memory must not win"])
    proactive = make_proactive(tmp_path, adapter=adapter, kernel_store=store, memory=memory)

    result = await proactive._generate_message("evening_checkin", {"time": "21:00"})

    assert result is not None
    prompt = adapter.calls[0][0][0]["content"]
    assert "<untrusted_grounding>" in prompt
    assert "我的蓝色杯子找不到了" in prompt
    assert "memory must not win" not in prompt
    assert "at least one concrete detail" in prompt
    assert "Do not invent" in prompt
    store.close()


@pytest.mark.asyncio
async def test_stop_cancels_in_flight_generation(tmp_path):
    started = asyncio.Event()

    class BlockingAdapter(Adapter):
        async def chat(self, *_args, **_kwargs):
            started.set()
            await asyncio.Event().wait()

    proactive = make_proactive(
        tmp_path,
        adapter=BlockingAdapter(),
        memory=SimpleNamespace(retrieve_relevant=lambda *_args, **_kwargs: ["蓝色杯子"]),
        random_seconds=lambda _low, _high: 120,
        sleep=lambda _delay: asyncio.sleep(0),
    )
    proactive._check_triggers = lambda: ("evening_checkin", {"time": "21:00"})
    proactive.start()
    task = proactive._task
    await started.wait()
    proactive.stop()
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled() or task.done()


@pytest.mark.asyncio
async def test_stopped_generation_cannot_publish_or_overlap_restart(tmp_path):
    started = asyncio.Event()
    release = asyncio.Event()

    class CancellationResistantAdapter(Adapter):
        async def chat(self, *_args, **_kwargs):
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return SimpleNamespace(content="蓝色杯子后来找到了吗？")

    proactive = make_proactive(
        tmp_path,
        adapter=CancellationResistantAdapter(),
        memory=SimpleNamespace(retrieve_relevant=lambda *_args, **_kwargs: ["蓝色杯子"]),
        random_seconds=lambda _low, _high: 120,
        sleep=lambda _delay: asyncio.sleep(0),
    )
    proactive._check_triggers = lambda: ("evening_checkin", {"time": "21:00"})
    proactive.start()
    old_task = proactive._task
    await started.wait()
    proactive.stop()
    proactive.start()
    assert proactive._task is old_task
    release.set()
    await asyncio.gather(old_task, return_exceptions=True)
    assert proactive.drain_pending() == []
    await asyncio.sleep(0)
    assert proactive._task is not old_task
    proactive.stop()
