from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
from weakref import WeakSet

import pytest

from src.api import budget
from src.api.adapter import ChatResponse, LLMAdapter
from src.bridge import ws_bridge
from src.bridge.stdio_bridge import StdioController
from src.chat import proactive
from src.config import settings, usage_policy
from src.kernel.contracts import PersonaScopeV4
from src.kernel.modules import ModuleRegistry
from src.kernel.storage import KernelStore
from src.local_mode import LocalModeGate
from src import local_mode
from src.mvp_runtime import MvpDesktopRuntime
from src.persona import identity, speech_habits
from src.persona.persona_card import default_persona
from src.persona.state_scope import PersonaStateScope
from src.storage import encrypted_sqlite
from src import user
from src.world import clock


FIXTURE = Path(__file__).resolve().parents[1] / "native-ui/tests/fixtures/proactive-message.json"
CANARY = "合成测试里那只蓝色杯子放在窗边的线索"


@pytest.fixture
def preview(tmp_path, monkeypatch):
    for key, value in {
        "DATA_DIR": tmp_path, "CONFIG_FILE": tmp_path / "config.json",
        "WORLD_STATE_DB": tmp_path / "world_state.sqlite3", "PERSONA_DIR": tmp_path / "persona",
        "EMOTION_DIR": tmp_path / "emotion", "MEMORY_DIR": tmp_path / "memory", "RELATIONSHIP_DIR": tmp_path / "relationship",
    }.items():
        monkeypatch.setattr(settings, key, value, raising=False)
    monkeypatch.setattr(budget, "WORLD_STATE_DB", settings.WORLD_STATE_DB)
    monkeypatch.setattr(user, "USER_DIR", tmp_path / "user")
    monkeypatch.setattr(clock, "WORLD_DIR", tmp_path / "world")
    monkeypatch.setattr(speech_habits, "PERSONA_DIR", settings.PERSONA_DIR)
    monkeypatch.setattr(proactive, "USER_DIR", tmp_path / "legacy-user")
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", True)
    monkeypatch.setattr(ws_bridge, "bridge_state", ws_bridge.BridgeState())
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())
    monkeypatch.setattr(ws_bridge, "_chat_coordinator", None)
    active_chats = []
    _replace_preview_pending_busy(monkeypatch, active_chats)
    gate = LocalModeGate(desktop=False)
    monkeypatch.setattr(local_mode, "_LOCAL_MODE_GATE", gate)
    config = settings._Settings(llm=settings.LLMSettings(
        provider="ollama", model="preview-proactive-fixture", base_url="http://127.0.0.1:11434/v1",
    ))
    policy = usage_policy.UsagePolicy(lambda: config)
    monkeypatch.setattr(usage_policy, "_GLOBAL_POLICY", policy)
    persona = default_persona()
    epochs = identity.PersonaEpochRegistry()
    token = epochs.activate_initial(persona)
    monkeypatch.setattr(identity, "GLOBAL_PERSONA_EPOCH", epochs)
    state = PersonaStateScope(persona, registry=epochs, base_dir=tmp_path / "personas")
    kernel = KernelStore(tmp_path / "runtime/kernel.sqlite3")
    kernel.activate_persona(PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint),
                           identity=persona.identity_envelope.core_identity, identity_version=persona.identity_envelope.version,
                           actor="bootstrap", reason="isolated proactive fixture")
    model_calls = []
    response = SimpleNamespace(text=json.loads(FIXTURE.read_text())["frame"]["payload"]["text"])

    async def model(_adapter, messages, *_args, **_kwargs):
        model_calls.append(messages)
        return ChatResponse(response.text, model="preview-proactive-fixture", usage={"prompt_tokens": 50, "completion_tokens": 12})

    monkeypatch.setattr(LLMAdapter, "_ollama_chat", model)
    runtime = MvpDesktopRuntime(
        persona=persona, settings=config, memory_state=state.module("memory"),
        emotion_state=state.module("emotion"), relationship_state=state.module("relationship"),
        persona_state=state, kernel_store=kernel, module_registry=ModuleRegistry(kernel),
        logger=logging.getLogger(__name__),
    )
    now = SimpleNamespace(value=datetime(2026, 11, 17, 8, 0))
    runtime._proactive.world_clock._now_provider = lambda: now.value
    yield SimpleNamespace(runtime=runtime, state=runtime._proactive, kernel=kernel, config=config, policy=policy,
                          gate=gate, token=token, epochs=epochs, active_chats=active_chats, model_calls=model_calls,
                          response=response, root=tmp_path, now=now)
    asyncio.run(runtime.close())
    kernel.close()


def seed_user(env):
    env.kernel.append_user_message(request_id="proactive_seed_user", conversation_id="dream-room",
                                   persona_id=env.token.persona_id, text=CANARY)
    env.state.mark_user_replied(CANARY)


def allow(env):
    env.config.features.proactive_chat_enabled = True
    env.policy.grant("proactive_chat")


async def wake_once(env):
    waits = []

    async def wake(delay):
        if waits:
            raise asyncio.CancelledError
        waits.append(delay)

    env.state._sleep = wake
    await env.state._run_loop()
    assert len(waits) == 1 and 120 <= waits[0] <= 600


async def publish_once(env, monkeypatch):
    endpoint = StdioController()
    frames = []

    async def capture(frame):
        assert any(row["source"] == "proactive" for row in env.kernel.message_page(
            "dream-room", persona_id=env.token.persona_id)["items"])
        frames.append(frame)

    monkeypatch.setattr(endpoint, "write", capture)
    monkeypatch.setattr(ws_bridge, "_connections", WeakSet([endpoint]))
    wakes = []

    async def wake(delay):
        if wakes:
            raise asyncio.CancelledError
        wakes.append(delay)

    await ws_bridge._proactive_broadcast_loop(sleep=wake)
    return frames


def test_preview_assembly_generates_and_persists_before_the_shared_stdio_frame(preview, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    assert preview.state is ws_bridge.bridge_state.proactive and preview.state.preview_mode
    assert preview.config.features.proactive_chat_enabled is False
    seed_user(preview)
    allow(preview)
    before = preview.state.relationship.to_dict()

    async def exercise():
        await wake_once(preview)
        queued = preview.state.drain_pending()
        assert len(queued) == 1
        preview.state._pending.put_nowait(queued[0])
        emitted = await publish_once(preview, monkeypatch)
        preview.state._pending.put_nowait(queued[0])
        assert await publish_once(preview, monkeypatch) == []
        return emitted

    frames = asyncio.run(exercise())
    assert len(preview.model_calls) == len(frames) == 1
    assert CANARY in preview.model_calls[0][0]["content"]
    expected = json.loads(FIXTURE.read_text())
    payload = frames[0]["frame"]["payload"]
    for key in ("proactive_id", "created_at_utc"):
        assert payload[key]
        expected["frame"]["payload"][key] = payload[key]
    assert frames[0] == expected
    history = preview.kernel.message_page("dream-room", persona_id=preview.token.persona_id)["items"]
    assert [(row["source"], row["content"]) for row in history] == [("chat", CANARY), ("proactive", payload["text"])]
    assert preview.state.relationship.to_dict() == before
    assert payload["text"] not in caplog.text and CANARY not in caplog.text
    assert not list(preview.root.rglob("proactive_state.json"))
    assert all(CANARY.encode() not in path.read_bytes() for path in preview.root.rglob("*") if path.is_file())


@pytest.mark.parametrize("blocked", ["switch", "consent", "local-mode", "recovery", "reply", "budget"])
def test_preview_proactive_admission_does_not_call_the_model_or_publish(preview, blocked):
    seed_user(preview)
    if blocked != "consent":
        allow(preview)
    if blocked == "switch":
        preview.config.features.proactive_chat_enabled = False
    elif blocked == "consent":
        preview.config.features.proactive_chat_enabled = True
    elif blocked == "local-mode":
        preview.gate.set(True)
    elif blocked == "recovery":
        ws_bridge.bridge_state.recovery_state = "recovering"
    elif blocked == "reply":
        preview.active_chats.append("active")
    elif blocked == "budget":
        preview.config.features.api_budget_tracking_enabled = True
        preview.config.features.api_background_budget_enforced = True
        preview.config.features.api_background_daily_request_budget = 1
        tracker = preview.state.adapter.budget_tracker
        call = tracker.begin(provider="ollama", model="fixture", purpose="fixture", background=True, estimated_tokens=20)
        tracker.complete(call, {"prompt_tokens": 10, "completion_tokens": 5})

    asyncio.run(wake_once(preview))
    assert preview.model_calls == [] and preview.state.drain_pending() == []
    assert all(row["source"] != "proactive" for row in preview.kernel.message_page(
        "dream-room", persona_id=preview.token.persona_id)["items"])


@pytest.mark.parametrize("grounded_user", [False, True], ids=["no-chat", "ungrounded-reply"])
def test_preview_requires_chat_and_an_actual_verbatim_fragment(preview, grounded_user):
    allow(preview)
    if grounded_user:
        seed_user(preview)
        preview.response.text = "assistant user 今早看看风景。"
    asyncio.run(wake_once(preview))
    assert len(preview.model_calls) == int(grounded_user)
    assert preview.state.drain_pending() == []


def test_preview_trigger_state_reloads_and_keeps_persona_limits_separate(preview):
    seed_user(preview)
    state = preview.state
    now = preview.now.value
    state._record_successful_trigger("morning_greeting", {"time": "08:00"})
    stored = preview.kernel.read_proactive_trigger_state(preview.token.persona_id)
    assert stored["last_user_message"] == CANARY
    assert stored["daily_trigger_count"] == {now.strftime("%Y-%m-%d"): 1}
    reloaded = preview.runtime._mount_proactive()
    assert reloaded._last_user_message == CANARY
    assert reloaded._daily_trigger_count == stored["daily_trigger_count"]
    assert not reloaded._can_trigger("evening_checkin", now + timedelta(hours=5))  # Stage 0.5 makes two into one.
    state.relationship.intimacy = 700
    assert not state._can_trigger("other", now + timedelta(minutes=1))
    assert state._can_trigger("other", now + timedelta(hours=5))
    authorization = preview.epochs.authorize_update(actor="owner", reason="isolated switch", user_confirmed=True)
    other = default_persona()
    other.identity = {**other.identity, "persona_id": "preview_proactive_other"}
    preview.epochs.activate_update(other, authorization)
    async def switch():
        await preview.runtime.remount_persona(other)
        assert preview.runtime._proactive._daily_trigger_count == {}
        assert preview.kernel.read_proactive_trigger_state(preview.token.persona_id) == stored
        await preview.runtime._stop_persona_graph()

    asyncio.run(switch())


def test_inflight_preview_generation_is_discarded_after_persona_switch(preview, monkeypatch):
    seed_user(preview)
    allow(preview)
    other = default_persona()
    other.identity = {**other.identity, "persona_id": "isolated_next_proactive_persona"}

    async def exercise():
        began = asyncio.Event()
        finish = asyncio.Event()

        async def adapter(_messages, **_options):
            began.set()
            # Model transport can finish concurrently with an identity change.
            await finish.wait()
            return ChatResponse(preview.response.text)

        monkeypatch.setattr(preview.state.adapter, "chat", adapter)
        generation = asyncio.create_task(preview.state._generate_message("morning_greeting", {"time": "08:00"}))
        try:
            await asyncio.wait_for(began.wait(), 2)
            authorization = preview.epochs.authorize_update(actor="owner", reason="isolated switch", user_confirmed=True)
            preview.epochs.activate_update(other, authorization)
        finally:
            finish.set()
        assert await generation is None

    asyncio.run(exercise())
    assert preview.state.drain_pending() == []
    assert preview.kernel.message_page("dream-room", persona_id=other.identity_envelope.persona_id)["items"] == []
    assert preview.kernel.read_proactive_trigger_state(other.identity_envelope.persona_id) is None


def test_preview_emotion_thresholds_use_initial_values_and_never_change_online_status(preview):
    state = preview.state
    state.memory = None
    now = datetime(2026, 11, 17, 14, 0)
    assert state._check_triggers(now) == (None, None)
    state.emotion.values["excitement"] = 80
    assert state._check_triggers(now)[0] == "emotion_spike"
    state.emotion.values["excitement"] = 32
    state.emotion.values["grievance"] = 0
    assert state._check_triggers(now) == (None, None)
    state.emotion.values["calm"] = 15
    assert state._check_triggers(now)[1]["emotion"] == "calm"
    custom = default_persona()
    custom.emotions = {**custom.emotions, "excitement": 75}
    custom_epochs = identity.PersonaEpochRegistry()
    custom_epochs.activate_initial(custom)
    custom_state = proactive.ProactiveChat(
        custom, state.adapter, state.emotion, world_clock=state.world_clock,
        kernel_store=preview.kernel, persona_epoch_registry=custom_epochs, preview_mode=True,
    )
    state.emotion.values["calm"] = 60
    state.emotion.values["excitement"] = 85
    assert custom_state._check_triggers(now) == (None, None)
    state.emotion.values["excitement"] = 95
    assert custom_state._check_triggers(now)[0] == "emotion_spike"
    preview.now.value = datetime(2026, 11, 14, 2, 0)
    state.manage_status = True
    state._update_status()
    assert state.scheduler.status == "online"


def test_preview_silence_changes_emotions_once_during_the_active_mount(preview):
    state = preview.state
    state._record_successful_trigger("morning_greeting", {})
    before = dict(state.emotion.values)
    relation = state.relationship.to_dict()
    preview.now.value += timedelta(hours=4)
    state._apply_silence_emotion_if_needed()
    after = dict(state.emotion.values)
    assert after["sadness"] > before["sadness"] and after["grievance"] > before["grievance"]
    state._apply_silence_emotion_if_needed()
    assert state.emotion.values == after
    assert state.relationship.to_dict() == relation


def test_preview_proactive_settings_persist_before_changing_the_live_switch(preview, monkeypatch):
    def fail(_candidate):
        raise OSError("isolated save failure")

    monkeypatch.setattr(settings, "write_settings_file", fail)
    result = asyncio.run(ws_bridge.handle_settings_update({"section": "features", "proactive_chat_enabled": True}, None))
    assert result["ok"] is False
    assert preview.config.features.proactive_chat_enabled is False
    assert not preview.state.running


def _replace_preview_pending_busy(monkeypatch, active_chats):
    from src.chat.encrypted_pending import EncryptedPendingChatStore

    monkeypatch.setattr(EncryptedPendingChatStore, "list_active", lambda _store: list(active_chats))
