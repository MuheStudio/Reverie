from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import pytest

from script.generate_protocol_contracts import electron_contracts, typescript
from script.validate_capability_manifest import validate as validate_capabilities
from src.bridge.stdio_transport import (
    FrameProtocolError,
    encode_frame,
    read_frame,
    round_trip,
)
from src.kernel.command_bus import CommandBus
from src.kernel.contracts import (
    CommandEnvelopeV3,
    DomainEventV3,
    ErrorCode,
    PersonaScopeV3,
)
from src.kernel.modules import (
    CapabilityManifest,
    ModuleRegistry,
    ModuleState,
)
from src.kernel.storage import IdempotencyConflict, KernelStore


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def persona() -> PersonaScopeV3:
    return PersonaScopeV3(
        persona_id="persona_test",
        epoch=1,
        fingerprint="a" * 64,
    )


@pytest.fixture()
def store(tmp_path: Path, persona: PersonaScopeV3):
    value = KernelStore(tmp_path / "kernel.sqlite3")
    value.activate_persona(
        persona,
        identity={"name": "Yumi"},
        identity_version=1,
        actor="bootstrap",
        reason="test bootstrap",
    )
    yield value
    value.close()


def command(persona: PersonaScopeV3, request_id: str = "request-1") -> CommandEnvelopeV3:
    return CommandEnvelopeV3(
        request_id=request_id,
        idempotency_key=f"idempotency-{request_id}",
        command="chat:send",
        persona=persona,
        payload={"message": "hello"},
    )


def test_capability_manifest_has_exactly_110_decision_complete_entries():
    assert validate_capabilities() == []


def test_generated_typescript_is_current():
    generated = (
        ROOT / "frontend" / "src" / "contracts" / "protocolV3.generated.ts"
    ).read_text(encoding="utf-8")
    assert generated == typescript()
    assert "STICKER_SEND" in generated
    assert "LOCAL_MODE_SET" in generated


def test_generated_electron_command_allowlist_is_current():
    generated = (
        ROOT / "frontend" / "electron" / "protocol-v3.generated.cjs"
    ).read_text(encoding="utf-8")
    assert generated == electron_contracts()
    assert '"chat:send"' in generated
    command_allowlist = generated.split("const MESSAGE_NAMES", 1)[0]
    assert '"chat:chunk"' not in command_allowlist


def test_length_prefixed_transport_round_trip_and_size_guard():
    payload = {"protocol_version": 3, "message": "你好"}
    assert round_trip(payload) == payload
    with pytest.raises(FrameProtocolError):
        encode_frame({"oversized": "x" * (16 * 1024 * 1024)})
    with pytest.raises(EOFError):
        read_frame(__import__("io").BytesIO(b"\x00\x00\x00\x10{}"))


def test_chat_exchange_commits_message_events_and_command_atomically(
    store: KernelStore,
    persona: PersonaScopeV3,
):
    request = command(persona)
    store.begin_command(request)
    store.mark_provider_dispatched(request.request_id)
    event = DomainEventV3(
        event_type="relationship.delta.accepted",
        persona=persona,
        causation_id=request.request_id,
        payload={"delta": 1},
    )
    record = store.commit_chat_exchange(
        request,
        conversation_id="conversation-1",
        user_text="hello",
        assistant_bubbles=["hi", "there"],
        events=[event],
    )
    assert record.state == "committed"
    assert record.provider_state == "completed"
    assert [item["role"] for item in store.messages("conversation-1")] == [
        "user",
        "assistant",
        "assistant",
    ]
    assert store.events_after(persona.persona_id)[0][1] == event
    assert store.integrity_check() == "ok"


def test_message_pages_keep_atomic_bubble_order_with_identical_timestamps(
    store: KernelStore,
    persona: PersonaScopeV3,
):
    for index in range(3):
        request = command(persona, f"request-page-{index}")
        store.begin_command(request)
        store.mark_provider_dispatched(request.request_id)
        store.commit_chat_exchange(
            request,
            conversation_id="conversation-page",
            user_text=f"user-{index}",
            assistant_bubbles=[f"assistant-{index}-a", f"assistant-{index}-b"],
        )

    newest = store.message_page("conversation-page", limit=4)
    assert [item["content"] for item in newest["items"]] == [
        "assistant-1-b",
        "user-2",
        "assistant-2-a",
        "assistant-2-b",
    ]
    assert newest["has_more"] is True
    assert set(newest["next_cursor"]) == {"sequence"}

    older = store.message_page(
        "conversation-page",
        limit=10,
        before_sequence=newest["next_cursor"]["sequence"],
    )
    assert [item["content"] for item in older["items"]] == [
        "user-0",
        "assistant-0-a",
        "assistant-0-b",
        "user-1",
        "assistant-1-a",
    ]
    assert older["has_more"] is False


def test_invalid_cross_persona_event_rolls_back_everything(
    store: KernelStore,
    persona: PersonaScopeV3,
):
    request = command(persona, "request-rollback")
    store.begin_command(request)
    other = PersonaScopeV3(
        persona_id="persona_other",
        epoch=1,
        fingerprint="b" * 64,
    )
    with pytest.raises(ValueError):
        store.commit_chat_exchange(
            request,
            conversation_id="conversation-rollback",
            user_text="hello",
            assistant_bubbles=["must not persist"],
            events=[DomainEventV3(event_type="memory.accepted", persona=other)],
        )
    assert store.messages("conversation-rollback") == []
    assert store.command(request.request_id).state == "accepted"


def test_dispatched_request_becomes_unknown_and_is_never_reopened(
    store: KernelStore,
    persona: PersonaScopeV3,
):
    request = command(persona, "request-unknown")
    store.begin_command(request)
    store.mark_provider_dispatched(request.request_id)
    assert store.recover_ambiguous_commands() == 1
    assert store.command(request.request_id).state == "outcome_unknown"
    with pytest.raises(IdempotencyConflict):
        store.mark_provider_dispatched(request.request_id)


def test_command_bus_rejects_stale_persona_outside_character_message(
    store: KernelStore,
):
    stale = PersonaScopeV3(
        persona_id="persona_test",
        epoch=2,
        fingerprint="a" * 64,
    )
    bus = CommandBus(store)

    async def unused(_request):
        raise AssertionError("stale request must not reach a module")

    bus.register("chat:send", unused)
    result = asyncio.run(bus.dispatch(command(stale, "request-stale")))
    assert result.ok is False
    assert result.error.code == ErrorCode.STALE_PERSONA
    assert "AI" not in result.error.message


@dataclass
class RecordingModule:
    fail_once: bool = False

    def __post_init__(self):
        self.manifest = CapabilityManifest(module_id="memory", version="1")
        self.events: list[str] = []
        self.started = False

    def start(self):
        self.started = True

    def stop(self):
        self.started = False

    def handle_event(self, event):
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("simulated module crash")
        self.events.append(event.event_id)

    def health(self):
        return {"started": self.started}


def test_module_crash_degrades_only_module_and_replay_resumes_from_checkpoint(
    store: KernelStore,
    persona: PersonaScopeV3,
):
    request = command(persona, "request-module")
    store.begin_command(request)
    event = DomainEventV3(event_type="memory.accepted", persona=persona)
    store.commit_chat_exchange(
        request,
        conversation_id="conversation-module",
        user_text="remember",
        assistant_bubbles=["okay"],
        events=[event],
    )
    module = RecordingModule(fail_once=True)
    registry = ModuleRegistry(store)
    registry.register(module)
    assert registry.start("memory").state == ModuleState.RUNNING
    assert registry.dispatch_pending("memory", persona.persona_id) == 0
    assert registry.status("memory").state == ModuleState.DEGRADED
    assert store.messages("conversation-module")

    assert registry.retry("memory").state == ModuleState.RUNNING
    assert registry.dispatch_pending("memory", persona.persona_id) == 1
    assert module.events == [event.event_id]
    assert registry.dispatch_pending("memory", persona.persona_id) == 0


def test_module_registry_does_not_swallow_process_control_exceptions(
    store: KernelStore,
):
    class InterruptedModule(RecordingModule):
        def start(self):
            raise KeyboardInterrupt("operator requested shutdown")

    registry = ModuleRegistry(store)
    registry.register(InterruptedModule())
    with pytest.raises(KeyboardInterrupt):
        registry.start("memory")
