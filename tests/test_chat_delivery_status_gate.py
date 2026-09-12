"""Clause 39/41: presence-gated reply starts and typing indicator frames."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone
from pathlib import Path

import pytest

from src.chat.delivery import ChatDeliveryCoordinator
from src.chat.pending import PendingChatStore
from src.local_mode import LocalModeGate

CLIENT = "desktop_test_controller"


class EventSink:
    def __init__(self) -> None:
        self.frames: list[tuple[str, str, dict]] = []

    async def emit(self, client_id: str, msg_type: str, payload: dict) -> bool:
        self.frames.append((str(client_id), str(msg_type), dict(payload)))
        return True

    def of_type(self, msg_type: str) -> list[dict]:
        return [dict(payload) for _, kind, payload in self.frames if kind == msg_type]


class FakeSession:
    def __init__(self, *, messages: list[str] | None = None, fail: bool = False) -> None:
        self.messages = messages or ["第一泡", "第二泡"]
        self.fail = fail
        self.provider_calls = 0

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
        if self.fail:
            raise RuntimeError("injected provider failure")
        return {
            "reply": "".join(self.messages),
            "messages": list(self.messages),
            "clean_messages": list(self.messages),
            "_commit_context": {"request_id": request_id},
        }

    async def commit_exchange(self, *, request_id: str, user_message: str, result: dict) -> None:
        assert user_message
        assert result["request_id"] == request_id


class TestClock:
    """Fake clock; sleeps only advance time when ``auto`` is enabled."""

    def __init__(self, *, auto: bool = True) -> None:
        self.wall = datetime(2026, 9, 6, 10, tzinfo=timezone.utc).timestamp()
        self.mono = 1000.0
        self.auto = auto
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.wall

    def monotonic(self) -> float:
        return self.mono

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if self.auto:
            self.mono += seconds
            self.wall += seconds
        await asyncio.sleep(0)


class DeferredPlan:
    def __init__(self, delay_seconds: float, reason: str = "busy_deferred") -> None:
        self.delay_seconds = delay_seconds
        self.start_delay = delay_seconds
        self.reason = reason
        self.calls: list[str] = []

    def __call__(self, text: str) -> "DeferredPlan":
        self.calls.append(text)
        return self


def payload(request_id: str, text: str = "普通消息", *, conversation_id: str = "conversation_a") -> dict:
    return {
        "request_id": request_id,
        "conversation_id": conversation_id,
        "persona_id": "persona_a",
        "persona_epoch": 1,
        "persona_fingerprint": "persona_fp_a",
        "model_epoch": 0,
        "model_fingerprint": "model_a",
        "sent_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "text": text,
    }


def make_coordinator(
    tmp_path: Path,
    session: FakeSession,
    sink: EventSink,
    clock: TestClock,
    *,
    planner=None,
    presence=None,
) -> tuple[ChatDeliveryCoordinator, PendingChatStore]:
    store = PendingChatStore(tmp_path / "pending.json")
    coordinator = ChatDeliveryCoordinator(
        store=store,
        get_session=lambda: session,
        emit=sink.emit,
        scope_is_current=lambda item: (
            item.get("persona_id") == "persona_a"
            and item.get("model_fingerprint") == "model_a"
        ),
        local_mode_gate=LocalModeGate(desktop=False),
        provider_timeout=2.0,
        clock=clock.time,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
        reply_start_planner=planner,
        presence_provider=presence,
    )
    return coordinator, store


async def test_deferred_reply_does_not_generate_before_due(tmp_path: Path) -> None:
    clock = TestClock(auto=False)
    session = FakeSession()
    sink = EventSink()
    plan = DeferredPlan(600.0)
    coordinator, store = make_coordinator(tmp_path, session, sink, clock, planner=plan)

    accepted = await coordinator.accept(payload("request_gate_1", "在吗"), client_id=CLIENT)
    assert accepted["state"] == "queued"
    assert plan.calls == ["在吗"]
    item = store.get_item("request_gate_1")
    assert item is not None and item["due_at"] > clock.time()
    labels = [str(payload_.get("label")) for payload_ in sink.of_type("chat:state")]
    assert "她在忙手头的事，稍后会回你" in labels

    runner = coordinator.tasks.get("request_gate_1")
    assert runner is not None
    await asyncio.sleep(0.05)
    assert session.provider_calls == 0
    assert store.get_item("request_gate_1")["state"] == "queued"
    assert any(0 < seconds <= 30 for seconds in clock.sleeps)

    runner.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await runner


async def test_deferred_reply_generates_once_due_passes(tmp_path: Path) -> None:
    clock = TestClock(auto=True)
    session = FakeSession()
    sink = EventSink()
    plan = DeferredPlan(45.0, reason="sleepy_reply")
    coordinator, store = make_coordinator(tmp_path, session, sink, clock, planner=plan)

    await asyncio.wait_for(
        coordinator.accept(payload("request_gate_1", "睡不着"), client_id=CLIENT), timeout=2.0
    )
    await asyncio.wait_for(coordinator.tasks["request_gate_1"], timeout=5.0)

    assert session.provider_calls == 1
    item = store.get_item("request_gate_1")
    assert item is not None and item["state"] == "done"
    labels = [str(payload_.get("label")) for payload_ in sink.of_type("chat:state")]
    assert any("稍等她一下" in label for label in labels)


async def test_new_user_message_supersedes_the_deferred_reply(tmp_path: Path) -> None:
    clock = TestClock(auto=False)
    session = FakeSession()
    sink = EventSink()
    plan = DeferredPlan(600.0)
    coordinator, store = make_coordinator(tmp_path, session, sink, clock, planner=plan)

    await coordinator.accept(payload("request_gate_1", "第一条"), client_id=CLIENT)
    await coordinator.accept(payload("request_gate_2", "第二条"), client_id=CLIENT)

    assert store.get_item("request_gate_1")["state"] == "cancelled"
    r1_task = coordinator.tasks.get("request_gate_1")
    assert r1_task is not None
    with contextlib.suppress(asyncio.CancelledError):
        await r1_task
    assert r1_task.cancelled()

    clock.auto = True
    await asyncio.wait_for(coordinator.tasks["request_gate_2"], timeout=5.0)
    assert session.provider_calls == 1
    assert store.get_item("request_gate_2")["state"] == "done"
    assert not sink.of_type("chat:bubble") or all(
        payload_.get("request_id") == "request_gate_2" for payload_ in sink.of_type("chat:bubble")
    )


async def test_planner_fault_fails_open_to_immediate_reply(tmp_path: Path) -> None:
    clock = TestClock(auto=True)
    session = FakeSession()
    sink = EventSink()

    def broken_planner(text: str):
        raise RuntimeError("injected planner failure")

    coordinator, store = make_coordinator(tmp_path, session, sink, clock, planner=broken_planner)
    await asyncio.wait_for(
        coordinator.accept(payload("request_gate_1"), client_id=CLIENT), timeout=2.0
    )
    await asyncio.wait_for(coordinator.tasks["request_gate_1"], timeout=5.0)
    assert session.provider_calls == 1
    assert store.get_item("request_gate_1")["state"] == "done"


async def test_urgent_context_bypasses_the_gate(tmp_path: Path) -> None:
    clock = TestClock(auto=False)
    session = FakeSession()
    sink = EventSink()
    plan = DeferredPlan(600.0)
    coordinator, store = make_coordinator(tmp_path, session, sink, clock, planner=plan)

    accepted = await coordinator.accept(payload("request_gate_1", "救命，我现在很危险"), client_id=CLIENT)
    assert plan.calls == []
    runner = coordinator.tasks.get("request_gate_1")
    assert runner is not None
    clock.auto = True
    await asyncio.wait_for(runner, timeout=5.0)
    assert session.provider_calls == 1
    assert store.get_item("request_gate_1")["state"] == "done"
    assert accepted is not None


async def test_typing_frames_wrap_generation_and_delivery(tmp_path: Path) -> None:
    clock = TestClock(auto=True)
    session = FakeSession()
    sink = EventSink()
    coordinator, _store = make_coordinator(tmp_path, session, sink, clock)

    await asyncio.wait_for(
        coordinator.accept(payload("request_gate_1"), client_id=CLIENT), timeout=2.0
    )
    await asyncio.wait_for(coordinator.tasks["request_gate_1"], timeout=5.0)

    typing = sink.of_type("chat:typing")
    assert typing, "expected at least one typing frame"
    assert typing[0]["typing"] is True and typing[0]["status"] == "typing"
    assert typing[-1]["typing"] is False and typing[-1]["status"] == "idle"
    order = [kind for _, kind, _ in sink.frames]
    assert order.index("chat:typing") < order.index("chat:bubble")
    assert order.index("chat:typing") < order.index("chat:done")


async def test_typing_turns_off_when_generation_fails(tmp_path: Path) -> None:
    clock = TestClock(auto=True)
    session = FakeSession(fail=True)
    sink = EventSink()
    coordinator, store = make_coordinator(tmp_path, session, sink, clock)

    await asyncio.wait_for(
        coordinator.accept(payload("request_gate_1"), client_id=CLIENT), timeout=2.0
    )
    await asyncio.wait_for(coordinator.tasks["request_gate_1"], timeout=5.0)

    typing = sink.of_type("chat:typing")
    assert typing and typing[0]["typing"] is True
    assert typing[-1]["typing"] is False
    assert store.get_item("request_gate_1")["state"] in {"failed", "failed_uncertain"}


async def test_typing_frame_carries_presence_payload(tmp_path: Path) -> None:
    clock = TestClock(auto=True)
    session = FakeSession()
    sink = EventSink()
    presence = {"status": "sleeping", "label": "睡觉", "is_available": False}
    coordinator, _store = make_coordinator(
        tmp_path, session, sink, clock, presence=lambda: presence
    )

    await asyncio.wait_for(
        coordinator.accept(payload("request_gate_1"), client_id=CLIENT), timeout=2.0
    )
    await asyncio.wait_for(coordinator.tasks["request_gate_1"], timeout=5.0)

    typing = sink.of_type("chat:typing")
    assert typing and typing[0].get("presence", {}).get("status") == "sleeping"


async def test_zero_delay_plan_replies_immediately(tmp_path: Path) -> None:
    clock = TestClock(auto=True)
    session = FakeSession()
    sink = EventSink()
    plan = DeferredPlan(0.0, reason="available_now")
    coordinator, store = make_coordinator(tmp_path, session, sink, clock, planner=plan)

    accepted = await coordinator.accept(payload("request_gate_1"), client_id=CLIENT)
    await asyncio.wait_for(coordinator.tasks["request_gate_1"], timeout=5.0)

    assert plan.calls == ["普通消息"]
    assert session.provider_calls == 1
    assert store.get_item("request_gate_1")["state"] == "done"
    labels = [str(payload_.get("label")) for payload_ in sink.of_type("chat:state")]
    assert "她在忙手头的事，稍后会回你" not in labels
