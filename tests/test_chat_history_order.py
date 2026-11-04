from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from src.bridge import ws_bridge
from src.kernel import storage as kernel_storage
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
from src.kernel.storage import KernelStore


BUBBLES = 16
PROACTIVE_ID = f"proactive_{'f' * 32}"


@pytest.fixture()
def persona() -> PersonaScopeV4:
    return PersonaScopeV4(
        persona_id="persona_history_order",
        epoch=2,
        fingerprint="d" * 64,
    )


@pytest.fixture()
def descending_ids(monkeypatch):
    """Issue message ids that sort opposite to insertion order.

    Random UUIDs would make a regression pass by chance only 1 in 16!, so the
    ids are made adversarial: any id tie-break reverses every bubble group.
    """
    counter = iter(range(10**6, 0, -1))
    monkeypatch.setattr(
        kernel_storage,
        "uuid4",
        lambda: SimpleNamespace(hex=f"{next(counter):032x}"),
    )


@pytest.fixture()
def store(tmp_path, persona, descending_ids):
    value = KernelStore(tmp_path / "kernel.sqlite3")
    value.activate_persona(
        persona,
        identity={"name": "Yumi"},
        identity_version=1,
        actor="bootstrap",
        reason="chat history order test",
    )
    yield value
    value.close()


@pytest.fixture()
def bridge(monkeypatch, store, persona):
    pending: list[dict] = []
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
        lambda: SimpleNamespace(list_active=lambda: list(pending)),
    )
    return pending


def _history(**payload) -> dict:
    return asyncio.run(ws_bridge.handle_chat_history(
        {"conversation_id": "dream-room", **payload},
        SimpleNamespace(),
    ))


def _commit(store: KernelStore, persona: PersonaScopeV4, request_id: str, bubbles: int) -> None:
    request = CommandEnvelopeV4(
        request_id=request_id,
        idempotency_key=f"idempotency-{request_id}",
        command="chat:send",
        persona=persona,
        payload={"text": request_id},
    )
    store.begin_command(request)
    store.mark_provider_dispatched(request.request_id)
    store.commit_chat_exchange(
        request,
        conversation_id="dream-room",
        user_text=f"user-{request_id}",
        assistant_bubbles=[f"{request_id}-{index}" for index in range(bubbles)],
    )


def _ledger_ids(store: KernelStore, persona: PersonaScopeV4) -> list[str]:
    page = store.message_page("dream-room", limit=300, persona_id=persona.persona_id)
    return [item["message_id"] for item in page["items"]]


def test_history_keeps_one_commit_in_ledger_order(store, persona, bridge) -> None:
    # The user row and all bubbles share one commit timestamp here.
    _commit(store, persona, "request-a", BUBBLES)
    _commit(store, persona, "request-b", BUBBLES)

    items = _history(limit=300)["items"]

    assert [item["id"] for item in items] == _ledger_ids(store, persona)
    for request_id in ("request-a", "request-b"):
        group = [item for item in items if item["request_id"] == request_id]
        assert [item["role"] for item in group] == ["user"] + ["assistant"] * BUBBLES
        assert [item["bubble_index"] for item in group[1:]] == list(range(BUBBLES))
        assert len({item["created_at_utc"] for item in group}) == 1


def test_history_keeps_proactive_bubbles_in_bubble_order(store, persona, bridge) -> None:
    store.append_proactive_messages(
        proactive_id=PROACTIVE_ID,
        conversation_id="dream-room",
        persona=persona,
        messages=[f"proactive-{index}" for index in range(BUBBLES)],
        created_at_utc="2026-09-01T08:00:00+00:00",
    )

    items = _history(limit=300)["items"]

    assert [item["bubble_index"] for item in items] == list(range(BUBBLES))
    assert [item["id"] for item in items] == _ledger_ids(store, persona)


def test_history_pages_keep_ledger_order_across_cursor(store, persona, bridge) -> None:
    _commit(store, persona, "request-a", BUBBLES)
    _commit(store, persona, "request-b", BUBBLES)
    ledger = _ledger_ids(store, persona)

    newest = _history(limit=10)
    older = _history(limit=300, before=newest["next_cursor"])

    assert [item["id"] for item in newest["items"]] == ledger[-10:]
    assert [item["id"] for item in older["items"]] == ledger[:-10]


def test_pending_rows_follow_committed_ties_and_keep_time_order(store, persona, bridge) -> None:
    _commit(store, persona, "request-a", 3)
    committed = _history(limit=300)["items"]
    tie = committed[0]["created_at_utc"]
    bridge.extend([
        {"request_id": "queued-z", "conversation_id": "dream-room",
         "persona_id": persona.persona_id, "text": "z", "created_at_utc": tie, "state": "queued"},
        {"request_id": "queued-y", "conversation_id": "dream-room",
         "persona_id": persona.persona_id, "text": "y", "created_at_utc": tie, "state": "queued"},
        {"request_id": "queued-early", "conversation_id": "dream-room",
         "persona_id": persona.persona_id, "text": "early",
         "created_at_utc": "2000-01-01T00:00:00+00:00", "state": "queued"},
    ])

    items = _history(limit=300)["items"]

    assert [item["id"] for item in items] == [
        "pending_user_queued-early",
        *(item["id"] for item in committed),
        "pending_user_queued-y",
        "pending_user_queued-z",
    ]


def _fixed_message_ids(monkeypatch, message_ids: list[str]) -> None:
    values = iter(message_ids)
    monkeypatch.setattr(kernel_storage, "uuid4", lambda: SimpleNamespace(hex=next(values)))


def _pending_row(
    persona: PersonaScopeV4,
    request_id: str,
    created_at_utc: str,
    *,
    conversation_id: str = "dream-room",
    persona_id: str | None = None,
) -> dict:
    return {
        "request_id": request_id,
        "conversation_id": conversation_id,
        "persona_id": persona_id or persona.persona_id,
        "text": request_id,
        "created_at_utc": created_at_utc,
        "state": "queued",
    }


def test_history_keeps_late_proactive_with_earlier_timestamp_in_storage_order(
    store, persona, bridge, monkeypatch,
) -> None:
    expected_ids = ["f" * 32, "e" * 32, "d" * 32, "c" * 32]
    _fixed_message_ids(monkeypatch, expected_ids)
    monkeypatch.setattr(kernel_storage, "_utc_now", lambda: "2026-09-01T12:00:00+00:00")
    _commit(store, persona, "request-before-proactive", 2)
    store.append_proactive_messages(
        proactive_id=PROACTIVE_ID,
        conversation_id="dream-room",
        persona=persona,
        messages=["generated earlier, committed later"],
        created_at_utc="2026-09-01T08:00:00+00:00",
    )
    ledger = store.message_page("dream-room", limit=300, persona_id=persona.persona_id)

    result = _history(limit=300)

    assert [row["message_id"] for row in ledger["items"]] == expected_ids
    assert [row["message_sequence"] for row in ledger["items"]] == [1, 2, 3, 4]
    assert [row["created_at_utc"] for row in ledger["items"]] == [
        "2026-09-01T12:00:00+00:00",
        "2026-09-01T12:00:00+00:00",
        "2026-09-01T12:00:00+00:00",
        "2026-09-01T08:00:00+00:00",
    ]
    assert [item["id"] for item in result["items"]] == expected_ids
    assert result["has_more"] == ledger["has_more"] is False
    assert result["next_cursor"] == ledger["next_cursor"] is None


def test_history_cross_page_identity_and_cursor_follow_storage_with_reversed_time(
    store, persona, bridge, monkeypatch,
) -> None:
    expected_ids = ["f" * 32, "e" * 32, "d" * 32, "c" * 32, "b" * 32]
    _fixed_message_ids(monkeypatch, expected_ids)
    monkeypatch.setattr(kernel_storage, "_utc_now", lambda: "2026-09-01T12:00:00+00:00")
    _commit(store, persona, "request-across-pages", 2)
    store.append_proactive_messages(
        proactive_id=PROACTIVE_ID,
        conversation_id="dream-room",
        persona=persona,
        messages=["earlier proactive first", "earlier proactive second"],
        created_at_utc="2026-09-01T08:00:00+00:00",
    )
    storage_newest = store.message_page("dream-room", limit=3, persona_id=persona.persona_id)
    storage_older = store.message_page(
        "dream-room", limit=3, before_sequence=3, persona_id=persona.persona_id,
    )
    assert [row["message_id"] for row in storage_newest["items"]] == expected_ids[2:]
    assert [row["message_id"] for row in storage_older["items"]] == expected_ids[:2]
    assert storage_newest["next_cursor"] == {"sequence": 3}
    assert storage_newest["has_more"] is True
    assert storage_older["next_cursor"] is None
    assert storage_older["has_more"] is False

    newest = _history(limit=3)
    assert newest["next_cursor"] == storage_newest["next_cursor"]
    assert newest["has_more"] == storage_newest["has_more"]
    older = _history(limit=3, before=newest["next_cursor"])

    assert [item["id"] for item in newest["items"]] == expected_ids[2:]
    assert [item["id"] for item in older["items"]] == expected_ids[:2]
    assert older["next_cursor"] == storage_older["next_cursor"]
    assert older["has_more"] == storage_older["has_more"]
    combined = older["items"] + newest["items"]
    assert [item["id"] for item in combined] == expected_ids
    assert [
        (item["id"], item["request_id"], item["role"], item["bubble_index"],
         item["source"], item["proactive_id"])
        for item in combined
    ] == [
        (expected_ids[0], "request-across-pages", "user", 0, "user", None),
        (expected_ids[1], "request-across-pages", "assistant", 0, "assistant", None),
        (expected_ids[2], "request-across-pages", "assistant", 1, "assistant", None),
        (expected_ids[3], PROACTIVE_ID, "assistant", 0, "proactive", PROACTIVE_ID),
        (expected_ids[4], PROACTIVE_ID, "assistant", 1, "proactive", PROACTIVE_ID),
    ]


def test_pending_merge_uses_last_qualifying_committed_anchor_in_nonmonotonic_page(
    store, persona, bridge, monkeypatch,
) -> None:
    committed_ids = ["f" * 32, "e" * 32, "d" * 32, "c" * 32]
    _fixed_message_ids(monkeypatch, committed_ids)
    for request_id, timestamp in [
        ("committed-a", "2026-09-01T03:00:00+00:00"),
        ("committed-b", "2026-09-01T01:00:00+00:00"),
        ("committed-c", "2026-09-01T04:00:00+00:00"),
        ("committed-d", "2026-09-01T02:00:00+00:00"),
    ]:
        store.append_user_message(
            request_id=request_id,
            conversation_id="dream-room",
            persona_id=persona.persona_id,
            text=request_id,
            created_at_utc=timestamp,
        )
    ledger = store.message_page("dream-room", limit=300, persona_id=persona.persona_id)
    assert [row["message_id"] for row in ledger["items"]] == committed_ids
    bridge.extend([
        _pending_row(persona, "queued-z", "2026-09-01T02:30:00+00:00"),
        _pending_row(persona, "queued-late", "2026-09-01T05:00:00+00:00"),
        _pending_row(persona, "queued-tie-three", "2026-09-01T03:00:00+00:00"),
        _pending_row(persona, "queued-early", "2026-09-01T00:00:00+00:00"),
        _pending_row(persona, "queued-y", "2026-09-01T02:30:00+00:00"),
        _pending_row(persona, "queued-middle", "2026-09-01T01:30:00+00:00"),
        _pending_row(persona, "queued-tie-two", "2026-09-01T02:00:00+00:00"),
    ])

    items = _history(limit=300)["items"]

    # The 03:00 pending row anchors after committed-d (02:00), the last
    # qualifying row, rather than directly after committed-a (03:00).
    assert [item["id"] for item in items] == [
        "pending_user_queued-early",
        committed_ids[0],
        committed_ids[1],
        "pending_user_queued-middle",
        committed_ids[2],
        committed_ids[3],
        "pending_user_queued-tie-two",
        "pending_user_queued-y",
        "pending_user_queued-z",
        "pending_user_queued-tie-three",
        "pending_user_queued-late",
    ]
    assert [item["id"] for item in items if not item["id"].startswith("pending_user_")] == committed_ids


def test_pending_rows_are_excluded_from_older_history_pages(
    store, persona, bridge, monkeypatch,
) -> None:
    committed_ids = ["f" * 32, "e" * 32, "d" * 32, "c" * 32]
    _fixed_message_ids(monkeypatch, committed_ids)
    for request_id, timestamp in [
        ("page-a", "2026-09-01T03:00:00+00:00"),
        ("page-b", "2026-09-01T01:00:00+00:00"),
        ("page-c", "2026-09-01T04:00:00+00:00"),
        ("page-d", "2026-09-01T02:00:00+00:00"),
    ]:
        store.append_user_message(
            request_id=request_id,
            conversation_id="dream-room",
            persona_id=persona.persona_id,
            text=request_id,
            created_at_utc=timestamp,
        )
    storage_newest = store.message_page("dream-room", limit=2, persona_id=persona.persona_id)
    storage_older = store.message_page(
        "dream-room", limit=300, before_sequence=3, persona_id=persona.persona_id,
    )
    assert [row["message_id"] for row in storage_newest["items"]] == committed_ids[2:]
    assert [row["message_id"] for row in storage_older["items"]] == committed_ids[:2]
    assert storage_newest["next_cursor"] == {"sequence": 3}
    bridge.extend([
        _pending_row(persona, "queued-old", "2026-09-01T00:00:00+00:00"),
        _pending_row(persona, "queued-new", "2026-09-01T05:00:00+00:00"),
    ])

    newest = _history(limit=2)
    assert newest["next_cursor"] == storage_newest["next_cursor"]
    older = _history(limit=300, before=newest["next_cursor"])

    assert [item["id"] for item in newest["items"]] == [
        "pending_user_queued-old", *committed_ids[2:], "pending_user_queued-new",
    ]
    assert [item["id"] for item in older["items"]] == committed_ids[:2]
    assert all(not item["id"].startswith("pending_user_") for item in older["items"])
    assert newest["has_more"] == storage_newest["has_more"] is True
    assert older["has_more"] == storage_older["has_more"] is False
    assert older["next_cursor"] == storage_older["next_cursor"] is None


def test_history_isolates_persona_and_conversation_with_pending_and_rowid_gaps(
    store, persona, bridge, monkeypatch,
) -> None:
    seeded_ids = ["f" * 32, "e" * 32, "d" * 32, "c" * 32, "b" * 32, "a" * 32, "9" * 32]
    _fixed_message_ids(monkeypatch, seeded_ids)
    other_persona_id = "persona_history_order_other"
    for request_id, conversation_id, persona_id, timestamp in [
        ("target-a", "dream-room", persona.persona_id, "2026-09-01T03:00:00+00:00"),
        ("other-persona-a", "dream-room", other_persona_id, "2026-09-01T00:00:00+00:00"),
        ("target-b", "dream-room", persona.persona_id, "2026-09-01T01:00:00+00:00"),
        ("other-room-a", "other-room", persona.persona_id, "2026-09-01T00:00:00+00:00"),
        ("target-c", "dream-room", persona.persona_id, "2026-09-01T02:00:00+00:00"),
        ("other-persona-b", "dream-room", other_persona_id, "2026-09-01T01:15:00+00:00"),
        ("other-room-b", "other-room", persona.persona_id, "2026-09-01T01:15:00+00:00"),
    ]:
        store.append_user_message(
            request_id=request_id,
            conversation_id=conversation_id,
            persona_id=persona_id,
            text=request_id,
            created_at_utc=timestamp,
        )
    ledger = store.message_page("dream-room", limit=300, persona_id=persona.persona_id)
    storage_newest = store.message_page("dream-room", limit=2, persona_id=persona.persona_id)
    assert [row["message_id"] for row in ledger["items"]] == [seeded_ids[0], seeded_ids[2], seeded_ids[4]]
    assert [row["message_sequence"] for row in ledger["items"]] == [1, 3, 5]
    assert [row["message_id"] for row in storage_newest["items"]] == [seeded_ids[2], seeded_ids[4]]
    assert storage_newest["next_cursor"] == {"sequence": 3}
    assert [
        row["message_id"]
        for row in store.message_page("dream-room", persona_id=other_persona_id)["items"]
    ] == [seeded_ids[1], seeded_ids[5]]
    assert [
        row["message_id"]
        for row in store.message_page("other-room", persona_id=persona.persona_id)["items"]
    ] == [seeded_ids[3], seeded_ids[6]]
    bridge.extend([
        _pending_row(persona, "queued-middle", "2026-09-01T01:30:00+00:00"),
        _pending_row(persona, "queued-late", "2026-09-01T05:00:00+00:00"),
        _pending_row(persona, "target-b", "2026-09-01T00:00:00+00:00"),
        _pending_row(
            persona, "queued-other-persona", "2026-09-01T00:00:00+00:00",
            persona_id=other_persona_id,
        ),
        _pending_row(
            persona, "queued-other-room", "2026-09-01T06:00:00+00:00",
            conversation_id="other-room",
        ),
    ])

    full = _history(limit=300)
    newest = _history(limit=2)
    assert newest["next_cursor"] == storage_newest["next_cursor"]
    older = _history(limit=300, before=newest["next_cursor"])

    assert [item["id"] for item in full["items"]] == [
        seeded_ids[0], seeded_ids[2], "pending_user_queued-middle",
        seeded_ids[4], "pending_user_queued-late",
    ]
    assert [item["id"] for item in newest["items"]] == [
        seeded_ids[2], "pending_user_queued-middle", seeded_ids[4], "pending_user_queued-late",
    ]
    assert [item["id"] for item in older["items"]] == [seeded_ids[0]]
    assert newest["has_more"] == storage_newest["has_more"] is True
    assert older["has_more"] is False
    assert older["next_cursor"] is None
    assert all(
        item["persona_id"] == persona.persona_id and item["conversation_id"] == "dream-room"
        for result in (full, newest, older)
        for item in result["items"]
    )
