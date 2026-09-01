from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.bridge import ws_bridge
from src.chat.proactive import ProactiveResult
from src.kernel.contracts import PersonaScopeV4
from src.kernel.storage import IdempotencyConflict, KernelStore
from src.persona.identity import PersonaEpochToken


PROACTIVE_A = f"proactive_{'a' * 32}"
PROACTIVE_B = f"proactive_{'b' * 32}"
PROACTIVE_C = f"proactive_{'c' * 32}"
PROACTIVE_D = f"proactive_{'d' * 32}"
PROACTIVE_E = f"proactive_{'e' * 32}"


@pytest.fixture()
def persona() -> PersonaScopeV4:
    return PersonaScopeV4(
        persona_id="persona_proactive",
        epoch=4,
        fingerprint="c" * 64,
    )


@pytest.fixture()
def store(tmp_path, persona):
    value = KernelStore(tmp_path / "kernel.sqlite3")
    value.activate_persona(
        persona,
        identity={"name": "Yumi"},
        identity_version=1,
        actor="bootstrap",
        reason="proactive persistence test",
    )
    yield value
    value.close()


def test_proactive_result_allocates_stable_delivery_fields() -> None:
    token = PersonaEpochToken(
        persona_id="persona_proactive",
        epoch=4,
        fingerprint="c" * 64,
    )
    result = ProactiveResult(
        messages=["first", "second"],
        trigger="evening_checkin",
        emotion_changes={},
        persona_token=token,
    )

    assert result.proactive_id.startswith("proactive_")
    assert result.created_at_utc.endswith("+00:00")
    assert result.conversation_id == "dream-room"


def test_kernel_persists_proactive_bubbles_once_without_user_row(store, persona) -> None:
    kwargs = {
        "proactive_id": PROACTIVE_A,
        "conversation_id": "dream-room",
        "persona": persona,
        "messages": ["first", "second"],
        "created_at_utc": "2026-09-01T08:00:00+00:00",
    }

    assert store.append_proactive_messages(**kwargs) is True
    assert store.append_proactive_messages(**kwargs) is False
    rows = store.message_page("dream-room", persona_id=persona.persona_id)["items"]

    assert [row["role"] for row in rows] == ["assistant", "assistant"]
    assert [row["bubble_index"] for row in rows] == [0, 1]
    assert {row["proactive_id"] for row in rows} == {PROACTIVE_A}
    assert {row["source"] for row in rows} == {"proactive"}
    with pytest.raises(IdempotencyConflict):
        store.append_proactive_messages(**{**kwargs, "messages": ["changed"]})
    assert len(store.messages("dream-room")) == 2


def test_kernel_requires_canonical_proactive_id(store, persona) -> None:
    with pytest.raises(ValueError, match="identity"):
        store.append_proactive_messages(
            proactive_id="proactive_loose",
            conversation_id="dream-room",
            persona=persona,
            messages=["invalid"],
            created_at_utc="2026-09-01T08:00:00+00:00",
        )


def test_kernel_rejects_proactive_message_outside_active_persona_scope(store) -> None:
    stale = PersonaScopeV4(
        persona_id="persona_proactive",
        epoch=3,
        fingerprint="c" * 64,
    )

    with pytest.raises(IdempotencyConflict):
        store.append_proactive_messages(
            proactive_id=PROACTIVE_B,
            conversation_id="dream-room",
            persona=stale,
            messages=["must not persist"],
            created_at_utc="2026-09-01T08:00:00+00:00",
        )
    assert store.messages("dream-room") == []


def test_chat_history_returns_proactive_identity_for_renderer_dedupe(
    monkeypatch,
    store,
    persona,
) -> None:
    store.append_proactive_messages(
        proactive_id=PROACTIVE_C,
        conversation_id="dream-room",
        persona=persona,
        messages=["persisted"],
        created_at_utc="2026-09-01T08:00:00+00:00",
    )
    monkeypatch.setattr(ws_bridge.bridge_state, "kernel_store", store)
    monkeypatch.setattr(
        ws_bridge,
        "_active_persona_scope",
        lambda: {
            "persona_id": persona.persona_id,
            "persona_epoch": persona.epoch,
            "persona_fingerprint": persona.fingerprint,
        },
    )
    monkeypatch.setattr(
        ws_bridge,
        "_get_pending_chat_store",
        lambda: SimpleNamespace(list_active=lambda: []),
    )

    result = asyncio.run(ws_bridge.handle_chat_history(
        {"conversation_id": "dream-room", "limit": 20},
        SimpleNamespace(),
    ))

    assert result["items"][0]["bubble_index"] == 0
    assert result["items"][0]["source"] == "proactive"
    assert result["items"][0]["proactive_id"] == PROACTIVE_C


def test_bridge_stops_replayed_proactive_result_before_side_effects() -> None:
    source = Path(ws_bridge.__file__).read_text(encoding="utf-8")
    persistence = source.index("inserted = bridge_state.kernel_store.append_proactive_messages")
    pending = source.index("pending_proactive_publications", persistence)
    effects_claim = source.index("claim_proactive_effects", pending)
    notification = source.index("NotificationOutbox().enqueue", pending)
    broadcast_call = source.index("broadcast(MsgType.PROACTIVE_MESSAGE", pending)

    assert persistence < pending < effects_claim < notification < broadcast_call


def test_proactive_publication_recovers_without_duplicate_bubbles_or_effects(
    store,
    persona,
) -> None:
    payload = {
        "proactive_id": PROACTIVE_D,
        "messages": ["persisted before crash"],
        "persona_id": persona.persona_id,
        "persona_epoch": persona.epoch,
        "persona_fingerprint": persona.fingerprint,
        "native_notification": True,
    }
    kwargs = {
        "proactive_id": payload["proactive_id"],
        "conversation_id": "dream-room",
        "persona": persona,
        "messages": payload["messages"],
        "created_at_utc": "2026-09-01T08:00:00+00:00",
        "publication_payload": payload,
    }

    assert store.append_proactive_messages(**kwargs) is True
    assert store.append_proactive_messages(**kwargs) is False
    pending = store.pending_proactive_publications(persona.persona_id)
    assert [item["proactive_id"] for item in pending] == [PROACTIVE_D]
    assert store.claim_proactive_effects(PROACTIVE_D) is True
    assert store.claim_proactive_effects(PROACTIVE_D) is False

    # Toast/broadcast acknowledgements happen after their external calls. This
    # is an explicit at-least-once boundary, while stable ids make replay safe.
    store.mark_proactive_published(PROACTIVE_D, "notification")
    store.mark_proactive_published(PROACTIVE_D, "notification")
    assert len(store.messages("dream-room")) == 1
    remaining = store.pending_proactive_publications(persona.persona_id)
    assert remaining[0]["broadcast_published"] is False
    store.mark_proactive_published(PROACTIVE_D, "broadcast")
    assert store.pending_proactive_publications(persona.persona_id) == []


def test_failed_notification_keeps_persisted_proactive_chat(store, persona) -> None:
    store.append_proactive_messages(
        proactive_id=PROACTIVE_E,
        conversation_id="dream-room",
        persona=persona,
        messages=["chat survives"],
        created_at_utc="2026-09-01T08:00:00+00:00",
        publication_payload={
            "proactive_id": PROACTIVE_E,
            "messages": ["chat survives"],
            "persona_id": persona.persona_id,
            "persona_epoch": persona.epoch,
            "persona_fingerprint": persona.fingerprint,
            "native_notification": True,
        },
    )

    # No publication acknowledgement models an enqueue failure/process crash.
    assert [row["content"] for row in store.messages("dream-room")] == ["chat survives"]
    assert store.pending_proactive_publications(persona.persona_id)[0][
        "notification_published"
    ] is False
