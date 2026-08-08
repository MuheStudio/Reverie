"""Protocol V4 registry consistency tests.

Guard against a repeat of the S0-1 incident where renderer commands existed
in the legacy facade but were missing from the host-side allowlist, silently
killing production features (chat:stop, persona:activate/import,
keepsake:add, ai_usage:*).
"""

from __future__ import annotations

from pathlib import Path
import re

from src.bridge import ws_bridge
from src.kernel.contracts import COMMAND_NAMES, MVP_EVENT_NAMES

ROOT = Path(__file__).resolve().parents[1]
ELECTRON_CONTRACTS = ROOT / "frontend" / "electron" / "protocol-v4.generated.cjs"
PRELOAD = ROOT / "frontend" / "electron" / "preload.js"
TS_CONTRACTS = ROOT / "frontend" / "src" / "contracts" / "protocolV4.generated.ts"


def _cjs_allowlists() -> tuple[set[str], set[str]]:
    text = ELECTRON_CONTRACTS.read_text(encoding="utf-8")
    commands = re.search(
        r"COMMAND_NAMES = Object\.freeze\(new Set\(\[(.*?)\]\)\)",
        text,
        re.S,
    )
    messages = re.search(
        r"MESSAGE_NAMES = Object\.freeze\(new Set\(\[(.*?)\]\)\)",
        text,
        re.S,
    )
    assert commands is not None and messages is not None
    return set(re.findall(r'"([^"]+)"', commands.group(1))), set(
        re.findall(r'"([^"]+)"', messages.group(1))
    )


def test_generated_electron_allowlists_match_kernel() -> None:
    commands, messages = _cjs_allowlists()
    assert commands == set(COMMAND_NAMES)
    assert messages == set(MVP_EVENT_NAMES)


def test_preload_allowlist_contains_every_kernel_command() -> None:
    text = PRELOAD.read_text(encoding="utf-8")
    start = text.index("/* BEGIN GENERATED PROTOCOL V4 COMMANDS */")
    end = text.index("/* END GENERATED PROTOCOL V4 COMMANDS */")
    block = text[start:end]
    missing = [c for c in COMMAND_NAMES if c not in block]
    assert missing == [], f"preload allowlist missing commands: {missing}"


def test_ts_contracts_expose_all_kernel_commands_and_events() -> None:
    text = TS_CONTRACTS.read_text(encoding="utf-8")
    missing_commands = [c for c in COMMAND_NAMES if f'"{c}"' not in text]
    missing_events = [e for e in MVP_EVENT_NAMES if f'"{e}"' not in text]
    assert missing_commands == [], f"TS contracts missing commands: {missing_commands}"
    assert missing_events == [], f"TS contracts missing events: {missing_events}"


def test_every_mvp_command_has_a_registered_bridge_handler() -> None:
    """The host allowlist and the handler table must stay in sync."""

    missing = sorted(set(COMMAND_NAMES) - set(ws_bridge._handlers))
    assert missing == [], f"commands without bridge handlers: {missing}"


def test_every_mvp_command_has_a_response_type() -> None:
    """Commands that return a payload must resolve to a declared event."""

    for command in sorted(COMMAND_NAMES):
        response = ws_bridge.response_type_for_request(command)
        assert isinstance(response, str) and response, f"no response type for {command}"
        # Commands whose handler returns None (fire-and-forget, e.g. chat:cancel)
        # fall back to "<command>_result"; those must be declared events too,
        # otherwise the host side would drop the frame silently.
        if response != command.replace(":", "_") + "_result":
            assert response in MVP_EVENT_NAMES, (
                f"{command} resolves to {response}, which is not an MVP event"
            )


def test_keepsake_and_persona_contracts_reject_bad_payloads() -> None:
    from src.kernel.contracts import (
        AIUsageGrantPayload,
        CommandEnvelopeV4,
        KeepsakeAddPayload,
        PersonaActivatePayload,
        PersonaImportPayload,
        PersonaScopeV4,
        ChatStopPayload,
    )
    from pydantic import ValidationError

    import pytest

    scope = PersonaScopeV4(persona_id="p1", epoch=1, fingerprint="a" * 64)

    with pytest.raises(ValidationError):
        AIUsageGrantPayload(
            feature="web",
            consent_digest="d",
            api_cost_acknowledged=1,
            user_confirmed=True,
        )
    with pytest.raises(ValidationError):
        PersonaActivatePayload(
            profile_id="p1",
            identity_change_confirmed=False,
            confirmed_profile_id="p1",
            actor="owner",
            reason="user switch",
        )
    with pytest.raises(ValidationError):
        PersonaImportPayload.model_validate(
            {"json": "", "filename": "c.json"}
        )
    with pytest.raises(ValidationError):
        KeepsakeAddPayload(importance=2.0)

    assert ChatStopPayload().request_id is None
    assert ChatStopPayload(request_id="abc12345").request_id == "abc12345"

    envelope = CommandEnvelopeV4(
        request_id="req_12345678",
        idempotency_key="key_12345678",
        command="persona:import",
        persona=scope,
        payload={"json": '{"spec": 2}', "filename": "card.json"},
    )
    assert envelope.payload == {"json": '{"spec": 2}', "filename": "card.json"}
