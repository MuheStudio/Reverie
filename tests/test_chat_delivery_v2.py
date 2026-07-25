from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.chat.delivery import (
    ChatDeliveryCoordinator,
    delivery_targets,
    stable_characters_per_minute,
)
from src.chat.pending import PendingChatStore
from src.local_mode import LocalModeBlocked, LocalModeGate


CLIENT = "desktop_test_controller"


class EventSink:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict]] = []
        self.connected = True

    async def emit(self, client_id: str, event_type: str, payload: dict) -> bool:
        if not self.connected:
            return False
        self.events.append((client_id, event_type, dict(payload)))
        return True


class FakeSession:
    def __init__(self, *, block: asyncio.Event | None = None, messages: list[str] | None = None) -> None:
        self.block = block
        self.messages = messages or ["第一泡", "第二泡"]
        self.provider_calls = 0
        self.commits: list[str] = []

    async def send_message(
        self,
        text: str,
        *,
        status_delay_applied: bool = False,
        defer_side_effects: bool = False,
        request_id: str = "",
    ) -> dict:
        assert status_delay_applied is True
        assert defer_side_effects is True
        self.provider_calls += 1
        if self.block is not None:
            await self.block.wait()
        return {
            "reply": "".join(self.messages),
            "messages": list(self.messages),
            "clean_messages": list(self.messages),
            "_commit_context": {"request_id": request_id},
        }

    async def commit_exchange(self, *, request_id: str, user_message: str, result: dict) -> None:
        assert user_message
        assert result["request_id"] == request_id
        self.commits.append(request_id)


class FailingCommitSession(FakeSession):
    async def commit_exchange(self, *, request_id: str, user_message: str, result: dict) -> None:
        raise OSError("injected durable side-effect failure")


class FakeClock:
    def __init__(self) -> None:
        self.wall = datetime(2026, 7, 16, 8, tzinfo=timezone.utc).timestamp()
        self.mono = 1000.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.wall

    def monotonic(self) -> float:
        return self.mono

    def advance(self, seconds: float, *, wall_seconds: float | None = None) -> None:
        self.mono += seconds
        self.wall += seconds if wall_seconds is None else wall_seconds

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.advance(seconds)
        await asyncio.sleep(0)


class TimedSession(FakeSession):
    def __init__(self, clock: FakeClock, provider_seconds: float) -> None:
        super().__init__(messages=["第一泡", "第二泡"])
        self.clock = clock
        self.provider_seconds = provider_seconds

    async def send_message(
        self,
        text: str,
        *,
        status_delay_applied: bool = False,
        defer_side_effects: bool = False,
        request_id: str = "",
    ) -> dict:
        self.clock.advance(self.provider_seconds)
        return await super().send_message(
            text,
            status_delay_applied=status_delay_applied,
            defer_side_effects=defer_side_effects,
            request_id=request_id,
        )


async def wait_for_state(store: PendingChatStore, request_id: str, state: str, timeout: float = 1.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        item = store.get_item(request_id)
        if item and item.get("state") == state:
            return item
        await asyncio.sleep(0.005)
    raise AssertionError(f"request {request_id} did not reach {state}: {store.get_item(request_id)}")


def payload(request_id: str, text: str = "普通消息") -> dict:
    return {
        "request_id": request_id,
        "conversation_id": "conversation_a",
        "persona_id": "persona_a",
        "persona_epoch": 1,
        "persona_fingerprint": "persona_fp_a",
        "model_epoch": 0,
        "model_fingerprint": "model_a",
        "sent_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "text": text,
    }


def coordinator(
    path: Path,
    session: FakeSession,
    sink: EventSink,
    *,
    gate: LocalModeGate | None = None,
) -> tuple[ChatDeliveryCoordinator, PendingChatStore]:
    store = PendingChatStore(path)
    return (
        ChatDeliveryCoordinator(
            store=store,
            get_session=lambda: session,
            emit=sink.emit,
            scope_is_current=lambda item: (
                item.get("persona_id") == "persona_a"
                and item.get("model_fingerprint") == "model_a"
            ),
            local_mode_gate=gate or LocalModeGate(desktop=False),
            provider_timeout=2.0,
        ),
        store,
    )


def test_delivery_curve_is_stable_and_obeys_all_caps() -> None:
    messages = ["一" * 12, "二" * 24, "三" * 30]
    first = delivery_targets(
        messages,
        request_id="request_curve_01",
        conversation_id="conversation_a",
        persona_id="persona_a",
        urgent=False,
    )
    second = delivery_targets(
        messages,
        request_id="request_curve_01",
        conversation_id="conversation_a",
        persona_id="persona_a",
        urgent=False,
    )
    assert first == second
    cpm, targets = first
    assert 60 <= cpm <= 80
    assert targets[0] <= 8.0
    assert targets[-1] <= 20.0
    assert all(0.799999 <= right - left <= 2.400001 for left, right in zip(targets, targets[1:]))
    assert stable_characters_per_minute("request_curve_01", "conversation_a", "persona_a") == cpm


def test_urgent_context_has_zero_artificial_delay() -> None:
    _, targets = delivery_targets(
        ["先联系急救", "不要等待"],
        request_id="request_urgent_01",
        conversation_id="conversation_a",
        persona_id="persona_a",
        urgent=True,
    )
    assert targets == [0.0, 0.0]


@pytest.mark.asyncio
async def test_hung_provider_can_be_cancelled_without_any_bubble(tmp_path: Path) -> None:
    release = asyncio.Event()
    session = FakeSession(block=release)
    sink = EventSink()
    delivery, store = coordinator(tmp_path / "pending.json", session, sink)
    request_id = "request_cancel_01"

    await delivery.accept(payload(request_id), client_id=CLIENT)
    await wait_for_state(store, request_id, "generating")
    started = time.monotonic()
    outcome = await delivery.cancel(request_id, client_id=CLIENT)
    elapsed = time.monotonic() - started
    await asyncio.sleep(0)

    assert elapsed < 0.1
    assert outcome["provider_may_have_been_called"] is True
    assert store.get_item(request_id)["state"] == "cancelled"
    assert not [event for event in sink.events if event[1] == "chat:bubble"]
    release.set()
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_reveal_is_idempotent_and_never_calls_provider_twice(tmp_path: Path) -> None:
    session = FakeSession()
    sink = EventSink()
    delivery, store = coordinator(tmp_path / "pending.json", session, sink)
    request_id = "request_reveal_01"

    await delivery.accept(payload(request_id), client_id=CLIENT)
    await wait_for_state(store, request_id, "ready_waiting")
    for _ in range(20):
        await delivery.reveal(request_id, client_id=CLIENT)
    await wait_for_state(store, request_id, "done")

    bubbles = [event[2] for event in sink.events if event[1] == "chat:bubble"]
    assert session.provider_calls == 1
    assert session.commits == [request_id]
    assert [bubble["bubble_index"] for bubble in bubbles] == [0, 1]
    assert all(bubble["request_id"] == request_id for bubble in bubbles)
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_partial_side_effect_failure_is_never_reported_as_committed(tmp_path: Path) -> None:
    session = FailingCommitSession(messages=["回复仍可从已生成缓存交付"])
    sink = EventSink()
    delivery, store = coordinator(tmp_path / "pending.json", session, sink)
    request_id = "request_commit_failure_01"

    await delivery.accept(payload(request_id), client_id=CLIENT)
    await wait_for_state(store, request_id, "ready_waiting")
    await delivery.reveal(request_id, client_id=CLIENT)
    await wait_for_state(store, request_id, "done")

    item = store.get_item(request_id)
    assert item["commit_state"] == "uncertain"
    assert "durable side-effect failure" in item["error"]
    assert session.provider_calls == 1
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_ten_requests_allow_targeted_queued_cancellation(tmp_path: Path) -> None:
    release = asyncio.Event()
    session = FakeSession(block=release, messages=["完成"])
    sink = EventSink()
    delivery, store = coordinator(tmp_path / "pending.json", session, sink)
    ids = [f"request_batch_{index:02d}" for index in range(10)]
    for request_id in ids:
        await delivery.accept(payload(request_id), client_id=CLIENT)
    await wait_for_state(store, ids[0], "generating")
    await delivery.cancel(ids[3], client_id=CLIENT)
    await delivery.cancel(ids[7], client_id=CLIENT)
    release.set()
    for request_id in ids:
        if request_id not in {ids[3], ids[7]}:
            # reveal_requested also works while a request is queued/generating.
            await delivery.reveal(request_id, client_id=CLIENT)
    for request_id in ids:
        expected = "cancelled" if request_id in {ids[3], ids[7]} else "done"
        await wait_for_state(store, request_id, expected, timeout=3.0)

    bubble_requests = {event[2]["request_id"] for event in sink.events if event[1] == "chat:bubble"}
    assert ids[3] not in bubble_requests
    assert ids[7] not in bubble_requests
    assert session.provider_calls == 8
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_ready_restart_delivers_cache_immediately_without_provider(tmp_path: Path) -> None:
    path = tmp_path / "pending.json"
    store = PendingChatStore(path)
    request_id = "request_restart_01"
    store.enqueue(
        "恢复",
        request_id=request_id,
        conversation_id="conversation_a",
        persona_id="persona_a",
        persona_epoch=1,
        persona_fingerprint="persona_fp_a",
        model_epoch=0,
        model_fingerprint="model_a",
        client_id="old_controller",
    )
    store.mark_ready(
        request_id,
        {
            "reply": "缓存结果",
            "messages": ["缓存结果"],
            "delivery_targets_seconds": [20.0],
            "side_effects_deferred": False,
        },
    )
    session = FakeSession()
    sink = EventSink()
    delivery = ChatDeliveryCoordinator(
        store=PendingChatStore(path),
        get_session=lambda: session,
        emit=sink.emit,
        scope_is_current=lambda _item: True,
        local_mode_gate=LocalModeGate(desktop=False),
    )
    await delivery.resume(client_id=CLIENT, conversation_id="conversation_a", persona_id="persona_a")
    await wait_for_state(delivery.store, request_id, "done")
    assert session.provider_calls == 0
    assert [event[2]["text"] for event in sink.events if event[1] == "chat:bubble"] == ["缓存结果"]
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_local_mode_rejects_before_persist_or_provider(tmp_path: Path) -> None:
    gate = LocalModeGate(desktop=True)
    session = FakeSession()
    sink = EventSink()
    delivery, store = coordinator(tmp_path / "pending.json", session, sink, gate=gate)

    with pytest.raises(LocalModeBlocked):
        await delivery.accept(payload("request_blocked_01"), client_id=CLIENT)
    assert store.list_items() == []
    assert session.provider_calls == 0
    await delivery.shutdown()


def test_started_without_result_recovers_failed_uncertain(tmp_path: Path) -> None:
    path = tmp_path / "pending.json"
    store = PendingChatStore(path)
    request_id = store.enqueue("可能已计费", request_id="request_uncertain_01")
    store.mark_generating(request_id)
    restored = PendingChatStore(path)
    item = restored.get_item(request_id)
    assert item["state"] == "failed_uncertain"
    assert item["provider_state"] == "started"


def test_legacy_ready_without_complete_scope_is_quarantined(tmp_path: Path) -> None:
    path = tmp_path / "pending.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "items": [
                    {
                        "id": "legacy_ready_01",
                        "text": "old persona request",
                        "state": "ready",
                        "result": {"messages": ["old persona reply"]},
                        "created_at": time.time(),
                        "due_at": time.time(),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    restored = PendingChatStore(path)
    item = restored.get_item("legacy_ready_01")

    assert item is not None
    assert item["state"] == "cancelled"
    assert item["cancelled"] is True
    assert "quarantined" in item["error"]
    assert restored.list_active() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_seconds", [0.2, 8.0, 30.0, 120.0])
async def test_provider_latency_consumes_delay_budget_without_double_wait(
    tmp_path: Path,
    provider_seconds: float,
) -> None:
    clock = FakeClock()
    session = TimedSession(clock, provider_seconds)
    sink = EventSink()
    event_times: list[tuple[str, float]] = []

    async def timed_emit(client_id: str, event_type: str, event_payload: dict) -> bool:
        event_times.append((event_type, clock.monotonic()))
        return await sink.emit(client_id, event_type, event_payload)

    store = PendingChatStore(tmp_path / f"pending-{provider_seconds}.json")
    delivery = ChatDeliveryCoordinator(
        store=store,
        get_session=lambda: session,
        emit=timed_emit,
        scope_is_current=lambda _item: True,
        local_mode_gate=LocalModeGate(desktop=False),
        provider_timeout=180.0,
        clock=clock.time,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )
    request_id = f"request_latency_{str(provider_seconds).replace('.', '_')}"
    start = clock.monotonic()
    await delivery.accept(payload(request_id), client_id=CLIENT)
    await wait_for_state(store, request_id, "done")

    bubble_times = [at - start for kind, at in event_times if kind == "chat:bubble"]
    assert session.provider_calls == 1
    assert bubble_times
    # Provider time consumes the same end-to-end budget; it is never followed
    # by a fresh 8/20 second renderer delay.
    assert bubble_times[0] <= max(provider_seconds, 8.0) + 1e-6
    assert bubble_times[-1] <= max(provider_seconds, 20.0) + 1e-6
    assert all(0.0 <= delay <= 20.0 for delay in clock.sleeps)
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_persona_scope_switch_discards_late_provider_result(tmp_path: Path) -> None:
    release = asyncio.Event()
    session = FakeSession(block=release)
    sink = EventSink()
    scope = {"current": True}
    store = PendingChatStore(tmp_path / "pending-scope.json")
    delivery = ChatDeliveryCoordinator(
        store=store,
        get_session=lambda: session,
        emit=sink.emit,
        scope_is_current=lambda _item: scope["current"],
        local_mode_gate=LocalModeGate(desktop=False),
    )
    request_id = "request_scope_switch"
    await delivery.accept(payload(request_id), client_id=CLIENT)
    await wait_for_state(store, request_id, "generating")
    scope["current"] = False
    release.set()
    await wait_for_state(store, request_id, "cancelled")

    assert not [event for event in sink.events if event[1] in {"chat:bubble", "chat:done"}]
    assert session.commits == []
    await delivery.shutdown()


@pytest.mark.asyncio
async def test_wall_clock_rollback_cannot_create_an_hour_long_delay(tmp_path: Path) -> None:
    clock = FakeClock()

    class RollbackSession(TimedSession):
        async def send_message(
            self,
            text: str,
            *,
            status_delay_applied: bool = False,
            defer_side_effects: bool = False,
            request_id: str = "",
        ) -> dict:
            self.clock.advance(1.0, wall_seconds=-3600.0)
            return await FakeSession.send_message(
                self,
                text,
                status_delay_applied=status_delay_applied,
                defer_side_effects=defer_side_effects,
                request_id=request_id,
            )

    session = RollbackSession(clock, 1.0)
    sink = EventSink()
    store = PendingChatStore(tmp_path / "pending-clock.json")
    delivery = ChatDeliveryCoordinator(
        store=store,
        get_session=lambda: session,
        emit=sink.emit,
        scope_is_current=lambda _item: True,
        local_mode_gate=LocalModeGate(desktop=False),
        clock=clock.time,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )
    await delivery.accept(payload("request_clock_rollback"), client_id=CLIENT)
    await wait_for_state(store, "request_clock_rollback", "done")

    assert clock.sleeps
    assert max(clock.sleeps) <= 8.0
    await delivery.shutdown()
