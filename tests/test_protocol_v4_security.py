from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from src.bridge.stdio_bridge import (
    CONTROL_SCHEMA,
    _control_failure,
    _handle_control,
)
from src.kernel.command_bus import CommandBus
from src.kernel.contracts import (
    COMMAND_PAYLOAD_MODELS,
    MVP_COMMAND_NAMES,
    MVP_EVENT_NAMES,
    CommandEnvelopeV4,
    ErrorCode,
    PersonaScopeV4,
)
from src.kernel.storage import KernelStore


def persona() -> PersonaScopeV4:
    return PersonaScopeV4(
        persona_id="persona_test",
        epoch=1,
        fingerprint="a" * 64,
    )


def envelope(
    command: str,
    payload: dict,
    *,
    request_id: str = "request_protocol_01",
    protocol_version: int = 4,
) -> CommandEnvelopeV4:
    return CommandEnvelopeV4(
        protocol_version=protocol_version,
        request_id=request_id,
        idempotency_key=request_id,
        command=command,
        persona=persona(),
        payload=payload,
    )


def test_v4_is_closed_world_and_rejects_downgrades() -> None:
    with pytest.raises(ValidationError):
        envelope("emotion:get", {}, protocol_version=3)
    for retired in (
        "persona:import",
        "persona:activate",
    ):
        with pytest.raises(ValidationError):
            envelope(retired, {})


def test_every_mvp_command_has_one_strict_payload_contract() -> None:
    assert frozenset(COMMAND_PAYLOAD_MODELS) == MVP_COMMAND_NAMES
    with pytest.raises(ValidationError):
        envelope("emotion:get", {"unexpected": True})
    with pytest.raises(ValidationError):
        envelope("memory:query", {"query": "", "top_k": 10})
    with pytest.raises(ValidationError):
        envelope("memory:query", {"query": "x", "top_k": 51})
    with pytest.raises(ValidationError):
        envelope("memory:list", {"limit": 201})
    with pytest.raises(ValidationError):
        envelope("memory:edit", {"memory_id": "../escape", "text": "corrected"})
    with pytest.raises(ValidationError):
        envelope("memory:edit", {"memory_id": "fact_123", "text": "   "})
    with pytest.raises(ValidationError):
        envelope("memory:delete", {"memory_id": "fact_123", "confirm": True})
    with pytest.raises(ValidationError):
        envelope(
            "chat:send",
            {"text": "hello", "request_id": "another_request_01"},
        )


def test_settings_and_profile_payloads_reject_cross_section_and_minor_data() -> None:
    with pytest.raises(ValidationError):
        envelope(
            "settings:update",
            {
                "section": "memory",
                "forgetting_enabled": True,
                "reply_delay_min": 3,
            },
        )
    with pytest.raises(ValidationError):
        envelope(
            "settings:update",
            {
                "section": "memory",
                "misremembering_enabled": True,
            },
        )
    with pytest.raises(ValidationError):
        envelope(
            "user:profile:update",
            {
                "profile": {
                    "name": "test",
                    "age": 17,
                }
            },
        )


def test_only_mvp_events_can_cross_the_child_to_renderer_boundary() -> None:
    assert "chat:bubble" in MVP_EVENT_NAMES
    assert "memory:candidates:result" in MVP_EVENT_NAMES
    assert "sticker:data" in MVP_EVENT_NAMES
    assert "proactive:message" in MVP_EVENT_NAMES
    assert "runtime:activity" in MVP_EVENT_NAMES


def test_generated_schema_is_draft_2020_12_and_forbids_extra_envelope_fields() -> None:
    schema_path = (
        Path(__file__).resolve().parents[1]
        / "config"
        / "protocol-v4.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$defs"]["CommandEnvelopeV4"]["additionalProperties"] is False
    assert set(schema["$defs"]["CommandPayloadsV4"]) == MVP_COMMAND_NAMES


def test_generic_command_result_is_committed_before_replay_is_acknowledged(
    tmp_path: Path,
) -> None:
    store = KernelStore(tmp_path / "kernel.sqlite3")
    store.activate_persona(
        persona(),
        identity={"name": "Yumi"},
        identity_version=1,
        actor="bootstrap",
        reason="test",
    )
    bus = CommandBus(store)
    calls = 0

    async def update(_command: CommandEnvelopeV4) -> dict:
        nonlocal calls
        calls += 1
        return {"ok": True, "revision": 1}

    bus.register("settings:update", update)
    command = envelope(
        "settings:update",
        {"section": "onboarding", "completed": True},
    )
    first = asyncio.run(bus.dispatch(command))
    replay = asyncio.run(bus.dispatch(command))
    record = store.command(command.request_id)
    store.close()

    assert first.ok is True
    assert replay.ok is True
    assert replay.data == {"ok": True, "revision": 1}
    assert calls == 1
    assert record is not None and record.state == "committed"


def test_idempotency_key_reuse_with_different_request_is_rejected(tmp_path: Path) -> None:
    store = KernelStore(tmp_path / "kernel.sqlite3")
    store.activate_persona(
        persona(),
        identity={"name": "Yumi"},
        identity_version=1,
        actor="bootstrap",
        reason="test",
    )
    bus = CommandBus(store)
    bus.register("settings:update", lambda _command: _async_value({"ok": True}))
    first = envelope(
        "settings:update",
        {"section": "onboarding", "completed": True},
        request_id="request_protocol_01",
    )
    second = CommandEnvelopeV4(
        request_id="request_protocol_02",
        idempotency_key=first.idempotency_key,
        command="settings:update",
        persona=persona(),
        payload={"section": "onboarding", "completed": False},
    )
    assert asyncio.run(bus.dispatch(first)).ok is True
    result = asyncio.run(bus.dispatch(second))
    store.close()
    assert result.ok is False
    assert result.error is not None and result.error.code == ErrorCode.CONFLICT


async def _async_value(value: dict) -> dict:
    return value


def test_control_surface_rejects_retired_controls_and_unknown_fields() -> None:
    base = {
        "kind": "control",
        "schema": CONTROL_SCHEMA,
        "requestId": "control_request_01",
    }
    with pytest.raises(ValueError, match="unsupported"):
        asyncio.run(
            _handle_control(
                {
                    **base,
                    "type": "backup:file:export",
                    "path": "private.zip",
                }
            )
        )
    with pytest.raises(ValueError, match="unsupported fields"):
        asyncio.run(
            _handle_control(
                {
                    **base,
                    "type": "provider:get",
                    "debug": True,
                }
            )
        )


def test_public_control_failure_never_reflects_exception_secrets() -> None:
    result = _control_failure(
        "control_request_01",
        "provider:test",
        RuntimeError("sk-secret-token at C:\\Users\\private\\vault.json"),
    )
    serialized = json.dumps(result)
    assert "sk-secret-token" not in serialized
    assert "private\\vault.json" not in serialized
    assert result["error"] == "The requested local control operation was rejected"


def test_public_control_failure_preserves_only_sanitized_retryability() -> None:
    from src.api.adapter import ProviderRequestError

    result = _control_failure(
        "control_request_02",
        "provider:test",
        ProviderRequestError(
            "PROVIDER_TIMEOUT",
            retryable=True,
            outcome_unknown=True,
        ),
    )

    assert result["code"] == "PROVIDER_TIMEOUT"
    assert result["retryable"] is True
