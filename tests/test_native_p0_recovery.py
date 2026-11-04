"""P0 backend recovery evidence through actual desktop business boundaries.

Uses real private-control handling, authenticated dispatcher, coordinator factory,
presence planner, turn engine, framed StdioController and SQLCipher KernelStore.
Only the provider and clocks are synthetic; no GUI or default user store is read.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import importlib.util
import io
import json
import os
import queue
from pathlib import Path
from types import SimpleNamespace
from weakref import WeakSet

import httpx
import pytest

from src.bridge import stdio_bridge, ws_bridge
from src.bridge.stdio_transport import encode_frame, read_frame, write_frame
from src.chat.pending import PendingChatStore
from src.chat.scheduler import MessageScheduler
from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
from src.kernel.storage import KernelStore
from src.local_mode import LocalModeGate
from src.persona import identity
from src.persona.persona_card import default_persona
from src.storage import encrypted_sqlite
import src.local_mode as local_mode

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("p0_backend_bootstrap", ROOT / "native-ui/tests/p0_backend_bootstrap.py")
assert spec and spec.loader
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class ManualClock:
    def __init__(self) -> None:
        import time
        self.wall = time.time()
        self.mono = 1000.0
        self.waiters: list[tuple[float, asyncio.Future]] = []
        self.sleeps: list[float] = []

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        waiter = asyncio.get_running_loop().create_future()
        self.waiters.append((self.mono + seconds, waiter))
        try:
            await waiter
        finally:
            self.waiters = [(due, pending) for due, pending in self.waiters if pending is not waiter]

    def advance(self, seconds: float) -> None:
        self.wall += seconds
        self.mono += seconds
        for due, waiter in tuple(self.waiters):
            if due <= self.mono and not waiter.done():
                waiter.set_result(None)


class SyntheticSession:
    def __init__(self, scheduler: MessageScheduler) -> None:
        self.scheduler = scheduler
        self.provider_calls: list[str] = []
        self.commits: list[str] = []
        self.failure = False
        self.release: asyncio.Event | None = None

    async def send_message(self, text: str, *, status_delay_applied: bool,
                           defer_side_effects: bool, request_id: str) -> dict:
        assert status_delay_applied and defer_side_effects
        self.provider_calls.append(request_id)
        if self.release is not None:
            await self.release.wait()
        if self.failure:
            raise RuntimeError("synthetic provider outcome unavailable")
        return {"reply": "合成答复", "messages": ["合成答复"],
                "_commit_context": {"request_id": request_id}}

    async def commit_exchange(self, *, request_id: str, user_message: str, result: dict) -> None:
        assert result["request_id"] == request_id
        self.commits.append(request_id)


async def until(predicate) -> None:
    async def spin():
        while not predicate():
            await asyncio.sleep(0.001)
    await asyncio.wait_for(spin(), timeout=2.0)


class DesktopHarness:
    def __init__(self, clock, session, gate, controller, output, store, coordinator, scope, kernel):
        self.clock, self.session, self.gate = clock, session, gate
        self.controller, self.output = controller, output
        self.store, self.coordinator, self.scope, self.kernel = store, coordinator, scope, kernel

    async def control(self, active: bool, epoch: int) -> dict:
        wire = encode_frame({"kind": "control", "schema": stdio_bridge.CONTROL_SCHEMA,
                             "type": "local_mode:set", "requestId": f"control_p0_{epoch:03d}",
                             "active": active, "epoch": epoch, "sessionId": "p0_fixture_session"})
        frame = read_frame(io.BytesIO(wire))
        response = await stdio_bridge._handle_control(frame)
        await self.controller.write(response)
        return response

    async def send(self, request_id: str, text: str = "合成普通消息") -> None:
        envelope = CommandEnvelopeV4(request_id=request_id, idempotency_key=request_id,
                                     command="chat:send", persona=self.scope,
                                     payload={"text": text, "conversation_id": "dream-room", "request_id": request_id})
        private = read_frame(io.BytesIO(encode_frame({"kind": "renderer_command", "schema": "reverie.command.v4",
                                                     "envelope": envelope.model_dump(mode="json")})))
        accepted = CommandEnvelopeV4.model_validate(private["envelope"])
        payload = {**accepted.payload, "request_id": request_id,
                   "expected_persona_id": accepted.persona.persona_id,
                   "expected_persona_epoch": accepted.persona.epoch,
                   "expected_persona_fingerprint": accepted.persona.fingerprint}
        await ws_bridge.dispatch_authenticated_message({"type": accepted.command, "payload": payload,
                                                        "request_id": request_id}, self.controller)

    def events(self, event_type: str, request_id: str | None = None) -> list[dict]:
        frames = io.BytesIO(self.output.getvalue())
        events = []
        while (value := read_frame(frames)) is not None:
            if value.get("kind") == "event" and value["frame"]["type"] == event_type:
                payload = value["frame"]["payload"]
                if request_id is None or payload.get("request_id") == request_id:
                    events.append(payload)
        return events

    async def finish(self, request_id: str) -> None:
        task = self.coordinator.tasks.get(request_id)
        if task is None:
            assert self.store.get_item(request_id)["state"] == "done"
            return
        # Wait for a delivery sleep to register before advancing the manual
        # clock: asyncio.create_task can defer that registration by one turn.
        await until(lambda: task.done() or bool(self.clock.waiters))
        self.clock.advance(100.0)
        await asyncio.wait_for(task, timeout=2.0)


@pytest.fixture
def desktop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # This actual SQLCipher key and ledger belong only to this fixture path.
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", True)
    monkeypatch.delenv("REVERIE_STORAGE_KEY_FD", raising=False)
    monkeypatch.delenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE", raising=False)
    registry = identity.PersonaEpochRegistry()
    token = registry.activate_initial(default_persona())
    monkeypatch.setattr(identity, "GLOBAL_PERSONA_EPOCH", registry)
    scope = PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint)
    kernel = KernelStore(tmp_path / "kernel.sqlite3")
    kernel.activate_persona(scope, identity={"name": "synthetic"}, identity_version=1,
                            actor="bootstrap", reason="disposable P0 fixture")
    clock = ManualClock()
    scheduler = MessageScheduler(status="online")
    # Fixed daylight, with genuine probability and delay calculations below.
    from datetime import datetime
    monkeypatch.setattr(scheduler, "_now_local", lambda: datetime(2026, 10, 12, 12))
    monkeypatch.setattr(scheduler, "should_retract_message", lambda **_kwargs: False)
    session = SyntheticSession(scheduler)
    state = ws_bridge.BridgeState()
    state.session, state.kernel_store = session, kernel
    state.settings = SimpleNamespace(llm=SimpleNamespace(provider="ollama", model="p0-fixture", base_url="http://127.0.0.1:18080/v1", api_key=""))
    gate = LocalModeGate(desktop=True)
    monkeypatch.setattr(local_mode, "_LOCAL_MODE_GATE", gate)
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    store = PendingChatStore(tmp_path / "pending.json")
    monkeypatch.setattr(ws_bridge, "_pending_chat_store", store)
    monkeypatch.setattr(ws_bridge, "_chat_coordinator", None)
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())
    controller = stdio_bridge.StdioController()
    output = io.BytesIO()
    # Retains StdioController's real serialization/lock/threaded writer and
    # actual framing; replaces only its destination with this private buffer.
    monkeypatch.setattr(stdio_bridge, "write_frame", lambda _stream, frame: write_frame(output, frame))
    monkeypatch.setattr(ws_bridge, "_connections", WeakSet([controller]))
    monkeypatch.setattr(ws_bridge, "_client_contexts", {
        controller: ws_bridge.BridgeClientContext("p0_fixture_controller", 4, True, "dream-room", scope.persona_id)
    })
    monkeypatch.setattr(ws_bridge, "_controller_ws", controller)
    coordinator = ws_bridge._get_chat_coordinator()
    coordinator.clock = lambda: clock.wall
    coordinator.monotonic = lambda: clock.mono
    coordinator.sleep = clock.sleep
    coordinator.provider_timeout = 2.0
    harness = DesktopHarness(clock, session, gate, controller, output, store, coordinator, scope, kernel)
    yield harness
    kernel.close()
    assert kernel.path.read_bytes()[:16] != encrypted_sqlite.SQLITE_HEADER


async def test_paused_startup_unlocks_real_factory_gate_zero_to_one(desktop, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.0)
    assert desktop.gate.snapshot().state == "unknown"
    assert desktop.coordinator.local_mode_gate is desktop.gate
    assert desktop.coordinator.reply_start_planner is ws_bridge._reply_start_planner
    startup = await desktop.control(True, 0)
    assert startup["ok"] and startup["active"] and startup["epoch"] == 0
    await desktop.send("request_paused_01")
    assert not desktop.session.provider_calls and not desktop.store.list_items()
    assert desktop.events("error", "request_paused_01")
    resumed = await desktop.control(False, 1)
    assert resumed["ok"] and not resumed["active"] and resumed["epoch"] == 1
    await desktop.send("request_resumed_01")
    await until(lambda: len(desktop.session.provider_calls) == 1)
    await desktop.finish("request_resumed_01")
    assert desktop.store.get_item("request_resumed_01")["state"] == "done"
    assert desktop.kernel.command("request_resumed_01").state == "committed"
    assert len(desktop.events("chat:bubble", "request_resumed_01")) == 1
    assert desktop.events("chat:typing", "request_resumed_01")[-1]["typing"] is False


async def test_complete_stdio_loop_resumes_and_generates_one_request(desktop, monkeypatch):
    """Include the transport's canonical command ledger registration too."""
    import queue

    class PrivateInput:
        def __init__(self):
            self.chunks = queue.Queue()
            self.buffered = b""

        def read(self, size):
            if not self.buffered:
                self.buffered = self.chunks.get(timeout=5.0)
                if not self.buffered:
                    return b""
            result, self.buffered = self.buffered[:size], self.buffered[size:]
            return result

        def push(self, value):
            self.chunks.put(encode_frame(value) if value is not None else b"")

    private_input = PrivateInput()
    monkeypatch.setattr(stdio_bridge.sys, "stdin", SimpleNamespace(buffer=private_input))
    monkeypatch.setenv("REVERIE_BRIDGE_SECRET", "a" * 64)
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.0)
    async def parked(*_args):
        await asyncio.Event().wait()
    for name in ("_parent_watch_loop", "_runtime_activity_loop", "_proactive_broadcast_loop"):
        monkeypatch.setattr(ws_bridge, name, parked)
    runner = asyncio.create_task(stdio_bridge.start_stdio_bridge())
    def declaration(active, epoch):
        return {"kind": "control", "schema": stdio_bridge.CONTROL_SCHEMA,
                "type": "local_mode:set", "requestId": f"stdio_control_{epoch:03d}",
                "active": active, "epoch": epoch, "sessionId": "p0_fixture_session"}
    def chat(request_id):
        envelope = CommandEnvelopeV4(request_id=request_id, idempotency_key=request_id,
                                     command="chat:send", persona=desktop.scope,
                                     payload={"text": "合成完整管线消息", "conversation_id": "dream-room", "request_id": request_id})
        return {"kind": "renderer_command", "schema": "reverie.command.v4",
                "envelope": envelope.model_dump(mode="json")}
    try:
        private_input.push(declaration(True, 0))
        private_input.push(chat("stdio_paused_request_01"))
        await until(lambda: bool(desktop.events("error", "stdio_paused_request_01")))
        assert desktop.session.provider_calls == []
        private_input.push(declaration(False, 1))
        private_input.push(chat("stdio_resumed_request_01"))
        await until(lambda: bool(desktop.session.provider_calls)
                    or bool(desktop.events("error", "stdio_resumed_request_01")))
        errors = desktop.events("error", "stdio_resumed_request_01")
        assert desktop.session.provider_calls == ["stdio_resumed_request_01"], errors
        await desktop.finish("stdio_resumed_request_01")
        assert desktop.store.get_item("stdio_resumed_request_01")["state"] == "done"
        assert desktop.kernel.command("stdio_resumed_request_01").state == "committed"
    finally:
        private_input.push(None)
        await asyncio.wait_for(runner, timeout=2.0)


@pytest.mark.parametrize("delay", [8.0, 35.0])
async def test_online_wobble_has_zero_calls_before_due_and_one_after_due(desktop, monkeypatch, delay):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.999)
    monkeypatch.setattr("src.chat.scheduler.random.uniform", lambda _low, _high: delay)
    await desktop.control(True, 0)
    await desktop.control(False, 1)
    await desktop.send("request_deferred_01", "在吗")
    due = desktop.coordinator._planned_due["request_deferred_01"]
    # The real complexity calculation slightly scales the 8..35s base.
    assert due - desktop.clock.wall == pytest.approx(round(delay * (1 + 2 / 240 * .25), 1))
    await until(lambda: bool(desktop.clock.waiters))
    desktop.clock.advance(due - desktop.clock.wall - 0.01)
    await asyncio.sleep(0.01)
    assert desktop.session.provider_calls == []
    assert desktop.store.get_item("request_deferred_01")["state"] == "queued"
    desktop.clock.advance(0.02)
    await until(lambda: len(desktop.session.provider_calls) == 1)
    await desktop.finish("request_deferred_01")
    assert desktop.session.provider_calls == ["request_deferred_01"]
    assert desktop.events("chat:done", "request_deferred_01")


async def test_pause_tombstones_queued_request_and_resume_does_not_catch_up(desktop, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.999)
    monkeypatch.setattr("src.chat.scheduler.random.uniform", lambda _low, _high: 35.0)
    await desktop.control(False, 0)
    await desktop.send("request_old_queued_01")
    await until(lambda: bool(desktop.clock.waiters))
    paused = await desktop.control(True, 1)
    old = desktop.store.get_item("request_old_queued_01")
    assert paused["active"] and old["state"] == "cancelled" and old["provider_state"] == "not_started"
    assert desktop.events("chat:state", "request_old_queued_01")[-1]["state"] == "cancelled"
    await desktop.control(False, 2)
    await desktop.coordinator.resume(client_id="p0_fixture_controller", conversation_id="dream-room", persona_id=desktop.scope.persona_id)
    desktop.clock.advance(100.0)
    await asyncio.sleep(0.01)
    assert desktop.session.provider_calls == []
    assert desktop.events("chat:bubble", "request_old_queued_01") == []
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.0)
    await desktop.send("request_new_after_pause_01")
    await until(lambda: len(desktop.session.provider_calls) == 1)
    await desktop.finish("request_new_after_pause_01")
    assert desktop.session.provider_calls == ["request_new_after_pause_01"]


async def test_pause_during_provider_never_emits_old_reply_after_resume(desktop, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.0)
    desktop.session.release = asyncio.Event()
    await desktop.control(False, 0)
    await desktop.send("request_old_active_01")
    await until(lambda: len(desktop.session.provider_calls) == 1)
    task = desktop.coordinator.tasks["request_old_active_01"]
    await desktop.control(True, 1)
    await asyncio.gather(task, return_exceptions=True)
    assert desktop.store.get_item("request_old_active_01")["state"] == "cancelled"
    assert desktop.events("chat:state", "request_old_active_01")[-1]["provider_may_have_been_called"] is True
    await desktop.control(False, 2)
    desktop.session.release.set()
    desktop.clock.advance(100.0)
    await desktop.coordinator.resume(client_id="p0_fixture_controller", conversation_id="dream-room", persona_id=desktop.scope.persona_id)
    await asyncio.sleep(0.01)
    assert desktop.session.provider_calls == ["request_old_active_01"]
    assert desktop.events("chat:bubble", "request_old_active_01") == []
    assert desktop.events("chat:done", "request_old_active_01") == []
    assert desktop.events("chat:typing", "request_old_active_01")[-1]["typing"] is False


async def test_storage_failure_before_generation_emits_failed_and_zero_calls(desktop, monkeypatch):
    def fail_storage(**_kwargs):
        raise OSError("synthetic storage unavailable")
    monkeypatch.setattr(desktop.kernel, "append_user_message", fail_storage)
    await desktop.control(False, 0)
    await desktop.send("request_storage_failure_01")
    item = desktop.store.get_item("request_storage_failure_01")
    assert item["state"] == "failed" and item["provider_state"] == "not_started"
    assert desktop.session.provider_calls == []
    terminal = desktop.events("chat:state", "request_storage_failure_01")[-1]
    assert terminal["state"] == "failed" and terminal["provider_may_have_been_called"] is False
    assert desktop.kernel.command("request_storage_failure_01").state == "failed"
    assert not desktop.events("chat:typing", "request_storage_failure_01")


async def test_provider_unknown_emits_failed_uncertain_without_automatic_retry(desktop, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.0)
    desktop.session.failure = True
    await desktop.control(False, 0)
    await desktop.send("request_provider_unknown_01")
    task = desktop.coordinator.tasks["request_provider_unknown_01"]
    await asyncio.wait_for(task, timeout=2.0)
    item = desktop.store.get_item("request_provider_unknown_01")
    assert item["state"] == "failed_uncertain" and item["provider_state"] == "started"
    assert desktop.kernel.command("request_provider_unknown_01").state == "outcome_unknown"
    terminal = desktop.events("chat:state", "request_provider_unknown_01")[-1]
    assert terminal["state"] == "failed_uncertain" and terminal["provider_may_have_been_called"] is True
    assert not desktop.events("chat:bubble", "request_provider_unknown_01")
    assert desktop.events("chat:typing", "request_provider_unknown_01")[-1]["typing"] is False
    await desktop.control(True, 1)
    await desktop.control(False, 2)
    await desktop.coordinator.resume(client_id="p0_fixture_controller", conversation_id="dream-room", persona_id=desktop.scope.persona_id)
    await desktop.send("request_provider_unknown_01")
    assert desktop.session.provider_calls == ["request_provider_unknown_01"]


def isolation(tmp_path, monkeypatch):
    root = tmp_path / "run"
    root.mkdir()
    data = root / "data"
    data.mkdir()
    (data / "data").mkdir()
    endpoint = "http://127.0.0.1:12345/v1"
    (data / "data/config.json").write_text(json.dumps({"llm": {"provider": "ollama", "base_url": endpoint}}))
    def snapshot(path):
        st = path.stat()
        return {"path": str(path), "uid": st.st_uid, "device": str(st.st_dev), "inode": str(st.st_ino)}
    context = root / "qt-context.json"
    context.write_text(json.dumps({"schema": "reverie.qt.isolation.v1", "root": snapshot(root), "data": snapshot(data)}))
    for key, value in {"REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
                       "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
                       "PYTHON_DOTENV_DISABLED": "1"}.items():
        monkeypatch.setenv(key, value)
    # Test only the descriptor policy with a genuine anonymous pipe; no key is
    # installed and no production process starts in these validation checks.
    read_fd, write_fd = os.pipe()
    original_fstat = os.fstat
    monkeypatch.setattr(bootstrap.os, "fstat", lambda fd: original_fstat(read_fd if fd == 3 else fd))
    return context, data, endpoint, data / "p0-planner.jsonl", (read_fd, write_fd)


@pytest.mark.parametrize("violation", ["external_endpoint", "environment", "replaced_inode", "evidence_symlink", "provider_config", "key_descriptor"])
def test_supplementary_bootstrap_rejects_unregistered_context(tmp_path, monkeypatch, violation):
    context, data, endpoint, evidence, descriptors = isolation(tmp_path, monkeypatch)
    try:
        bootstrap.validate_context(context, data, endpoint, evidence, 1)
        if violation == "external_endpoint":
            endpoint = "https://example.com/v1"
        elif violation == "environment":
            monkeypatch.setenv("REVERIE_DATA_DIR", str(tmp_path / "default-user-data"))
        elif violation == "replaced_inode":
            value = json.loads(context.read_text())
            value["data"]["inode"] = "0"
            context.write_text(json.dumps(value))
        elif violation == "evidence_symlink":
            outside = tmp_path / "outside"
            outside.write_text("synthetic")
            evidence.symlink_to(outside)
        elif violation == "provider_config":
            (data / "data/config.json").write_text(json.dumps({"llm": {"provider": "openai", "base_url": endpoint}}))
        else:
            original = bootstrap.os.fstat
            file_fd = os.open(context, os.O_RDONLY)
            monkeypatch.setattr(bootstrap.os, "fstat", lambda fd: original(file_fd if fd == 3 else fd))
        with pytest.raises(ValueError):
            bootstrap.validate_context(context, data, endpoint, evidence, 1)
    finally:
        if violation == "key_descriptor":
            os.close(file_fd)
        for descriptor in descriptors:
            os.close(descriptor)


async def test_supplementary_hooks_keep_original_plans_and_trace_real_http_boundary(desktop, tmp_path, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.999)
    monkeypatch.setattr("src.chat.scheduler.random.uniform", lambda _low, _high: 35.0)
    trace_path = tmp_path / "p0-planner.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 1)
    endpoint = "http://127.0.0.1:12345/v1"
    undo = bootstrap.install_test_hooks(trace, endpoint)
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"synthetic": True})))
    original_send = desktop.session.send_message
    async def sending(text, *, status_delay_applied, defer_side_effects, request_id):
        await client.post(endpoint + "/chat/completions", json={"private_fixture": text})
        return await original_send(text, status_delay_applied=status_delay_applied,
                                   defer_side_effects=defer_side_effects, request_id=request_id)
    monkeypatch.setattr(desktop.session, "send_message", sending)
    try:
        assert ws_bridge._reply_start_planner("补充-恢复：合成").start_delay >= 35.0
        assert ws_bridge._reply_start_planner("补充-重启恢复：合成").start_delay >= 35.0
        assert ws_bridge._reply_start_planner("补充-受控恢复-extra：合成").start_delay >= 35.0
        assert ws_bridge._reply_start_planner("普通未注册合成消息").start_delay >= 35.0
        for marker in ("补充-受控恢复", "补充-受控延迟", "补充-受控停止"):
            # A matching string outside its real owner dispatch is not enough
            # to activate a fixture plan.
            assert ws_bridge._reply_start_planner(marker + "：合成").start_delay >= 35.0
        await desktop.control(True, 0)
        await desktop.control(False, 1)
        secret_canary = "synthetic-body-must-not-be-in-evidence"
        await desktop.send("request_controlled_trace_01", "补充-受控恢复：" + secret_canary)
        await until(lambda: bool(desktop.clock.waiters))
        desktop.clock.advance(0.19)
        await asyncio.sleep(0.01)
        assert not desktop.session.provider_calls
        desktop.clock.advance(0.02)
        await until(lambda: bool(desktop.session.provider_calls))
        await desktop.finish("request_controlled_trace_01")
        rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
        assert {row["event"] for row in rows} >= {"gate", "accept", "plan", "generate", "provider_dispatch", "terminal"}
        assert all(set(row) <= bootstrap.FIELDS and row["schema"] == bootstrap.SCHEMA for row in rows)
        assert secret_canary not in trace_path.read_text()
        assert "补充-" not in trace_path.read_text()
        assert not any(key in row for row in rows for key in ("text", "content", "endpoint", "persona_id", "api_key"))
        assert sum(row["event"] == "provider_dispatch" for row in rows) == 1
        assert next(row for row in rows if row["event"] == "plan")["injected"] is True
        assert next(row for row in rows if row["event"] == "terminal")["state"] == "done"
    finally:
        await desktop.coordinator.shutdown()
        await client.aclose()
        undo()
        trace.close()


async def test_diagnostic_overflow_does_not_change_successful_business_result(desktop, tmp_path, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.0)
    monkeypatch.setattr(bootstrap, "MAX_TRACE_EVENTS", 1)
    trace_path = tmp_path / "bounded.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 2)
    undo = bootstrap.install_test_hooks(trace, "http://127.0.0.1:12345/v1")
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    try:
        await desktop.control(False, 0)
        await desktop.send("request_diagnostic_limit_01", "补充-受控恢复：合成")
        await until(lambda: bool(desktop.clock.waiters))
        desktop.clock.advance(0.21)
        await until(lambda: bool(desktop.session.provider_calls))
        await desktop.finish("request_diagnostic_limit_01")
        assert desktop.store.get_item("request_diagnostic_limit_01")["state"] == "done"
        assert desktop.session.provider_calls == ["request_diagnostic_limit_01"]
    finally:
        await desktop.coordinator.shutdown()
        undo()
        trace.close()
    rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
    health = rows[-1]
    assert health["event"] == "trace_health" and health["complete"] is False
    assert health["overflow"] is True and health["dropped_events"] >= 1
    assert trace_path.stat().st_size <= bootstrap.MAX_TRACE_BYTES


async def test_diagnostic_write_failure_does_not_change_successful_business_result(desktop, tmp_path, monkeypatch):
    trace_path = tmp_path / "unavailable.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 2)
    original_write = os.write
    def failed_write(fd, data):
        if fd == trace.fd:
            raise OSError("synthetic diagnostic destination unavailable")
        return original_write(fd, data)
    monkeypatch.setattr(bootstrap.os, "write", failed_write)
    undo = bootstrap.install_test_hooks(trace, "http://127.0.0.1:12345/v1")
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    try:
        await desktop.control(False, 0)
        await desktop.send("request_diagnostic_io_01", "补充-受控恢复：合成")
        await until(lambda: bool(desktop.clock.waiters))
        desktop.clock.advance(0.21)
        await until(lambda: bool(desktop.session.provider_calls))
        await desktop.finish("request_diagnostic_io_01")
        assert desktop.store.get_item("request_diagnostic_io_01")["state"] == "done"
        assert trace.dropped_events > 0 and trace.error_type == "OSError"
    finally:
        await desktop.coordinator.shutdown()
        undo()
        trace.close()
    # No health receipt is deliberately distinguishable from a complete run.
    assert trace_path.read_text() == ""


ENDPOINT_A = "http://127.0.0.1:12345/v1"
ENDPOINT_B = "http://127.0.0.1:12346/v1"


def framed_output(desktop):
    stream = io.BytesIO(desktop.output.getvalue())
    result = []
    while (frame := read_frame(stream)) is not None:
        result.append(frame)
    return result


def command_frame(desktop, command_id, command, payload):
    envelope = CommandEnvelopeV4(request_id=command_id, idempotency_key=command_id,
                                 command=command, persona=desktop.scope, payload=payload)
    return {"kind": "renderer_command", "schema": "reverie.command.v4",
            "envelope": envelope.model_dump(mode="json")}


@asynccontextmanager
async def actual_stdio(desktop, monkeypatch):
    """A real framed read loop, with only private input and clocks replaced."""
    class PrivateInput:
        def __init__(self):
            self.chunks = queue.Queue()
            self.buffered = b""

        def read(self, size):
            if not self.buffered:
                self.buffered = self.chunks.get(timeout=5.0)
                if not self.buffered:
                    return b""
            result, self.buffered = self.buffered[:size], self.buffered[size:]
            return result

        def push(self, frame):
            self.chunks.put(encode_frame(frame) if frame is not None else b"")

    private_input = PrivateInput()
    monkeypatch.setattr(stdio_bridge.sys, "stdin", SimpleNamespace(buffer=private_input))
    monkeypatch.setenv("REVERIE_BRIDGE_SECRET", "b" * 64)

    async def parked(*_args):
        await asyncio.Event().wait()

    for name in ("_parent_watch_loop", "_runtime_activity_loop", "_proactive_broadcast_loop"):
        monkeypatch.setattr(ws_bridge, name, parked)
    runner = asyncio.create_task(stdio_bridge.start_stdio_bridge())
    try:
        await until(lambda: any(frame["kind"] == "ready" for frame in framed_output(desktop)))
        yield private_input
    finally:
        private_input.push(None)
        await asyncio.wait_for(runner, timeout=2.0)


def tail_isolation(tmp_path, monkeypatch, *, cycle=1):
    context, data, endpoint, evidence, descriptors = isolation(tmp_path, monkeypatch)
    value = json.loads(context.read_text())
    value["p0_tail"] = {"endpoints": {"A": ENDPOINT_A, "B": ENDPOINT_B}}
    context.write_text(json.dumps(value))
    (data / "data/config.json").write_text(json.dumps({"llm": {
        "provider": "ollama", "model": "reverie-qt-p0-tail",
        "base_url": ENDPOINT_A if cycle == 1 else ENDPOINT_B}}))
    return context, data, endpoint, evidence, descriptors


@pytest.mark.parametrize("cycle", [1, 2])
def test_tail_bootstrap_requires_exact_registered_persisted_destination(tmp_path, monkeypatch, cycle):
    context, data, endpoint, evidence, descriptors = tail_isolation(tmp_path, monkeypatch, cycle=cycle)
    try:
        bootstrap.validate_context(context, data, endpoint, evidence, cycle,
                                   p0_tail=True, endpoint_b=ENDPOINT_B)
        config_path = data / "data/config.json"
        config = json.loads(config_path.read_text())
        config["llm"]["base_url"] = ENDPOINT_B if cycle == 1 else ENDPOINT_A
        config_path.write_text(json.dumps(config))
        with pytest.raises(ValueError, match="configuration"):
            bootstrap.validate_context(context, data, endpoint, evidence, cycle,
                                       p0_tail=True, endpoint_b=ENDPOINT_B)
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


@pytest.mark.parametrize("violation", ["unregistered_port", "localhost", "trailing_slash", "same_endpoint",
                                        "missing_registration", "wrong_registration", "extra_registration", "wrong_model"])
def test_tail_bootstrap_rejects_non_owner_allowlist(tmp_path, monkeypatch, violation):
    context, data, endpoint, evidence, descriptors = tail_isolation(tmp_path, monkeypatch)
    endpoint_b = ENDPOINT_B
    try:
        if violation == "unregistered_port":
            endpoint_b = "http://127.0.0.1:12347/v1"
        elif violation == "localhost":
            endpoint_b = "http://localhost:12346/v1"
        elif violation == "trailing_slash":
            endpoint_b += "/"
        elif violation == "same_endpoint":
            endpoint_b = endpoint
        elif violation == "wrong_model":
            (data / "data/config.json").write_text(json.dumps({"llm": {"provider": "ollama",
                "base_url": ENDPOINT_A, "model": "unregistered-model"}}))
        else:
            value = json.loads(context.read_text())
            if violation == "missing_registration":
                value.pop("p0_tail")
            elif violation == "wrong_registration":
                value["p0_tail"]["endpoints"]["B"] = "http://127.0.0.1:12347/v1"
            else:
                value["p0_tail"]["endpoints"]["C"] = "http://127.0.0.1:12347/v1"
            context.write_text(json.dumps(value))
        with pytest.raises(ValueError):
            bootstrap.validate_context(context, data, endpoint, evidence, 1,
                                       p0_tail=True, endpoint_b=endpoint_b)
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


@pytest.mark.parametrize("marker", ["补充-取消拒绝", "补充-取消超时"])
async def test_tail_cancel_failure_stdio_continues_and_real_done_is_not_swallowed(desktop, tmp_path, monkeypatch, marker):
    trace_path = tmp_path / "tail.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 1)
    undo = bootstrap.install_test_hooks(trace, ENDPOINT_A, p0_tail=True, endpoint_b=ENDPOINT_B)
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    subject = "tail_cancel_subject_001"
    command = "tail_cancel_command_001"
    try:
        async with actual_stdio(desktop, monkeypatch) as wire:
            await desktop.control(False, 0)
            wire.push(command_frame(desktop, subject, "chat:send", {
                "request_id": subject, "conversation_id": "dream-room", "text": marker + "：private canary"}))
            await until(lambda: bool(desktop.store.get_item(subject)))
            wire.push(command_frame(desktop, command, "chat:cancel", {"request_id": subject}))
            # A control receipt behind the ignored cancel proves that the read
            # loop remained live without fabricating any cancellation ack.
            wire.push({"kind": "control", "schema": stdio_bridge.CONTROL_SCHEMA,
                       "type": "provider:get", "requestId": "tail_post_cancel_control"})
            await until(lambda: any(frame.get("requestId") == "tail_post_cancel_control"
                                    for frame in framed_output(desktop)))
            command_events = [frame["frame"] for frame in framed_output(desktop)
                              if frame["kind"] == "event" and frame["frame"].get("request_id") == command]
            if marker == "补充-取消拒绝":
                assert [frame["type"] for frame in command_events] == ["error"]
                assert "request_id" not in command_events[0]["payload"]
                assert desktop.kernel.command(command) is None
            else:
                assert command_events == []
                assert desktop.kernel.command(command) is None
                await until(lambda: bool(desktop.clock.waiters))
                desktop.clock.advance(30.01)
                await asyncio.sleep(0.01)
                assert desktop.session.provider_calls == []
                assert desktop.store.get_item(subject)["state"] == "queued"
                await until(lambda: bool(desktop.clock.waiters))
                desktop.clock.advance(9.98)
                await asyncio.sleep(0.01)
                assert desktop.session.provider_calls == []
            await until(lambda: bool(desktop.clock.waiters))
            desktop.clock.advance(0.21)
            await until(lambda: desktop.session.provider_calls == [subject])
            await desktop.finish(subject)
            assert desktop.store.get_item(subject)["state"] == "done"
            assert desktop.kernel.command(subject).state == "committed"
            assert len(desktop.events("chat:done", subject)) == 1
            assert len(desktop.events("chat:bubble", subject)) == 1
    finally:
        undo()
        trace.close()
    rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
    cancel = next(row for row in rows if row["event"] == "cancel_command")
    assert cancel["request_id"] == command and cancel["subject_request_id"] == subject
    assert cancel["accepted"] is True and cancel["injected"] is True
    assert cancel["reason"] == ("fixture_rejected" if marker == "补充-取消拒绝" else "fixture_ack_timeout")
    assert next(row for row in rows if row["event"] == "plan")["start_delay_seconds"] == (
        0.2 if marker == "补充-取消拒绝" else 40.0)
    assert next(row for row in rows if row["event"] == "terminal")["state"] == "done"
    assert rows[-1]["event"] == "trace_health" and rows[-1]["complete"] is True
    assert "private canary" not in trace_path.read_text()


@pytest.mark.parametrize("marker", ["补充-取消拒绝", "补充-取消超时", "补充-尾部受控停止"])
async def test_tail_cancel_injection_is_one_shot_and_normal_stop_reaches_terminal(desktop, tmp_path, marker):
    trace_path = tmp_path / "one-shot.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 1)
    undo = bootstrap.install_test_hooks(trace, ENDPOINT_A, p0_tail=True, endpoint_b=ENDPOINT_B)
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    subject = "tail_one_shot_subject_001"
    try:
        await desktop.control(False, 0)
        await desktop.send(subject, marker + "：合成")
        for index in range(2 if marker != "补充-尾部受控停止" else 1):
            command_id = f"tail_one_shot_cancel_{index:03d}"
            await ws_bridge.dispatch_authenticated_message({"type": "chat:cancel", "request_id": command_id,
                "payload": {"request_id": subject, "expected_persona_id": desktop.scope.persona_id,
                            "expected_persona_epoch": desktop.scope.epoch,
                            "expected_persona_fingerprint": desktop.scope.fingerprint}}, desktop.controller)
            if index == 0 and marker != "补充-尾部受控停止":
                assert desktop.store.get_item(subject)["state"] == "queued"
        assert desktop.store.get_item(subject)["state"] == "cancelled"
        assert desktop.session.provider_calls == []
        assert desktop.events("chat:state", subject)[-1]["state"] == "cancelled"
    finally:
        await desktop.coordinator.shutdown()
        undo()
        trace.close()
    rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
    cancels = [row for row in rows if row["event"] == "cancel_command"]
    assert cancels[-1]["injected"] is False and cancels[-1]["reason"] == "passthrough"
    assert sum(row["injected"] for row in cancels) == (0 if marker == "补充-尾部受控停止" else 1)
    assert any(row["event"] == "terminal" and row["state"] == "cancelled" for row in rows)


@pytest.mark.parametrize("cycle", [1, 2])
async def test_tail_real_provider_control_persists_and_dispatches_both_exact_endpoints(desktop, tmp_path, monkeypatch, cycle):
    import src.config.settings as settings_module

    initial, destination = (ENDPOINT_A, ENDPOINT_B) if cycle == 1 else (ENDPOINT_B, ENDPOINT_A)
    settings = settings_module._Settings(llm=settings_module.LLMSettings(
        provider="ollama", model="reverie-qt-p0-tail", base_url=initial))
    ws_bridge.bridge_state.settings = settings
    config_path = tmp_path / "private-config.json"
    monkeypatch.setattr(settings_module, "CONFIG_FILE", config_path)
    monkeypatch.setattr(settings_module, "_settings", None)
    trace_path = tmp_path / "dual-provider.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, cycle)
    undo = bootstrap.install_test_hooks(trace, ENDPOINT_A, p0_tail=True, endpoint_b=ENDPOINT_B)
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    calls = []

    def responding(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"private_fixture": True})

    client = httpx.AsyncClient(transport=httpx.MockTransport(responding))
    original_send = desktop.session.send_message

    async def sending(text, *, status_delay_applied, defer_side_effects, request_id):
        await client.post(ws_bridge.bridge_state.settings.llm.base_url + "/chat/completions",
                          json={"private_fixture": text})
        return await original_send(text, status_delay_applied=status_delay_applied,
                                   defer_side_effects=defer_side_effects, request_id=request_id)

    monkeypatch.setattr(desktop.session, "send_message", sending)
    try:
        await desktop.control(False, 0)
        first = "tail_endpoint_before_001"
        await desktop.send(first, "补充-尾部受控恢复：合成")
        await until(lambda: bool(desktop.clock.waiters))
        desktop.clock.advance(0.21)
        await until(lambda: bool(desktop.session.provider_calls))
        await desktop.finish(first)
        control = read_frame(io.BytesIO(encode_frame({"kind": "control", "schema": stdio_bridge.CONTROL_SCHEMA,
            "type": "provider:configure", "requestId": "tail_switch_provider_control", "llm": {
                "provider": "ollama", "model": "reverie-qt-p0-tail", "base_url": destination}})))
        response = await stdio_bridge._handle_control(control)
        await desktop.controller.write(response)
        assert response["ok"] and response["llm"]["base_url"] == destination
        assert json.loads(config_path.read_text())["llm"]["base_url"] == destination
        assert "api_key" not in json.loads(config_path.read_text())["llm"]
        second = "tail_endpoint_after_001"
        marker = "补充-尾部服务B" if cycle == 1 else "补充-尾部服务A"
        await desktop.send(second, marker + "：合成")
        await until(lambda: bool(desktop.clock.waiters))
        desktop.clock.advance(0.21)
        await until(lambda: len(desktop.session.provider_calls) == 2)
        await desktop.finish(second)
        assert calls == [initial + "/chat/completions", destination + "/chat/completions"]
        rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
        dispatches = [row for row in rows if row["event"] == "provider_dispatch"]
        assert [row["endpoint_role"] for row in dispatches] == (["A", "B"] if cycle == 1 else ["B", "A"])
        assert [row["request_id"] for row in dispatches] == [first, second]
        assert all(row["cycle"] == cycle for row in rows)
        assert len([row for row in rows if row["event"] == "terminal" and row["state"] == "done"]) == 2
    finally:
        await desktop.coordinator.shutdown()
        await client.aclose()
        undo()
        trace.close()


@pytest.mark.parametrize("endpoint", ["http://127.0.0.1:12347/v1", "http://localhost:12345/v1",
                                       "http://127.0.0.1:12345/v1/", "https://example.invalid/v1"])
async def test_tail_controls_and_http_refuse_unregistered_destination_before_io(desktop, tmp_path, endpoint):
    trace = bootstrap.MetadataTrace(tmp_path / "guard.jsonl", 1)
    undo = bootstrap.install_test_hooks(trace, ENDPOINT_A, p0_tail=True, endpoint_b=ENDPOINT_B)
    calls = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: (calls.append(request), httpx.Response(200, json={}))[1]))
    try:
        for control_type in ("provider:configure", "provider:test"):
            with pytest.raises(ValueError, match="not registered"):
                await stdio_bridge._handle_control({"kind": "control", "schema": stdio_bridge.CONTROL_SCHEMA,
                    "type": control_type, "requestId": "tail_invalid_provider_control", "llm": {
                        "provider": "ollama", "model": "reverie-qt-p0-tail", "base_url": endpoint},
                    **({"credential": ""} if control_type == "provider:test" else {})})
        with pytest.raises(ValueError, match="unregistered HTTP"):
            await client.post(endpoint + "/chat/completions", json={})
        assert calls == []
        assert ws_bridge.bridge_state.settings.llm.base_url == "http://127.0.0.1:18080/v1"
    finally:
        await client.aclose()
        undo()
        trace.close()


async def test_tail_wrong_controller_cannot_consume_subject_cancel_injection(desktop, tmp_path, monkeypatch):
    trace_path = tmp_path / "controller.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 1)
    undo = bootstrap.install_test_hooks(trace, ENDPOINT_A, p0_tail=True, endpoint_b=ENDPOINT_B)
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    subject = "tail_owner_subject_001"
    other = stdio_bridge.StdioController()
    ws_bridge._connections.add(other)
    ws_bridge._client_contexts[other] = ws_bridge.BridgeClientContext(
        "p0_fixture_other_controller", 4, True, "dream-room", desktop.scope.persona_id)
    payload = {"request_id": subject, "expected_persona_id": desktop.scope.persona_id,
               "expected_persona_epoch": desktop.scope.epoch, "expected_persona_fingerprint": desktop.scope.fingerprint}
    try:
        await desktop.control(False, 0)
        await desktop.send(subject, "补充-取消超时：合成")
        await ws_bridge.dispatch_authenticated_message({"type": "chat:cancel", "request_id": "tail_wrong_cancel_001",
                                                        "payload": payload}, other)
        assert desktop.store.get_item(subject)["state"] == "queued"
        await ws_bridge.dispatch_authenticated_message({"type": "chat:cancel", "request_id": "tail_owner_cancel_001",
                                                        "payload": payload}, desktop.controller)
        assert desktop.store.get_item(subject)["state"] == "queued"
        await ws_bridge.dispatch_authenticated_message({"type": "chat:cancel", "request_id": "tail_owner_cancel_002",
                                                        "payload": payload}, desktop.controller)
        assert desktop.store.get_item(subject)["state"] == "cancelled"
        rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
        assert [row["request_id"] for row in rows if row["event"] == "cancel_command" and row["injected"]] == ["tail_owner_cancel_001"]
    finally:
        await desktop.coordinator.shutdown()
        ws_bridge._connections.discard(other)
        ws_bridge._client_contexts.pop(other, None)
        undo()
        trace.close()


async def test_tail_failed_accept_does_not_register_injection_or_leave_dispatch_scope(desktop, tmp_path, monkeypatch):
    monkeypatch.setattr("src.chat.scheduler.random.random", lambda: 0.999)
    monkeypatch.setattr("src.chat.scheduler.random.uniform", lambda _low, _high: 35.0)
    trace_path = tmp_path / "failed-accept.jsonl"
    trace = bootstrap.MetadataTrace(trace_path, 1)
    undo = bootstrap.install_test_hooks(trace, ENDPOINT_A, p0_tail=True, endpoint_b=ENDPOINT_B)
    desktop.coordinator.reply_start_planner = ws_bridge._reply_start_planner
    original_append = desktop.kernel.append_user_message

    def failing_append(**_kwargs):
        raise OSError("private synthetic storage failure")

    monkeypatch.setattr(desktop.kernel, "append_user_message", failing_append)
    subject = "tail_failed_accept_001"
    try:
        await desktop.control(False, 0)
        await desktop.send(subject, "补充-取消超时：合成")
        assert desktop.store.get_item(subject)["state"] == "failed"
        await ws_bridge.dispatch_authenticated_message({"type": "chat:cancel", "request_id": "tail_failed_cancel_001",
            "payload": {"request_id": subject, "expected_persona_id": desktop.scope.persona_id,
                        "expected_persona_epoch": desktop.scope.epoch,
                        "expected_persona_fingerprint": desktop.scope.fingerprint}}, desktop.controller)
        rows = [json.loads(line) for line in trace_path.read_text().splitlines()]
        assert any(row["event"] == "accept" and row.get("accepted") is False for row in rows)
        cancel = next(row for row in rows if row["event"] == "cancel_command")
        assert cancel["accepted"] is False and cancel["injected"] is False
        assert any(row["event"] == "terminal" and row["state"] == "failed" for row in rows)
        assert ws_bridge._reply_start_planner("补充-取消超时：合成").start_delay >= 35.0
        monkeypatch.setattr(desktop.kernel, "append_user_message", original_append)
        await desktop.send("tail_after_failed_accept_001", "普通未注册合成消息")
        assert desktop.coordinator._planned_due["tail_after_failed_accept_001"] - desktop.clock.wall >= 35.0
        assert desktop.session.provider_calls == []
    finally:
        await desktop.coordinator.shutdown()
        undo()
        trace.close()


def test_tail_marker_namespace_is_explicit_and_health_fits_total_event_cap(tmp_path, monkeypatch):
    assert bootstrap.marker_of("补充-取消超时：合成") is None
    assert bootstrap.marker_of("补充-取消超时：合成", p0_tail=True) == "cancel_timeout"
    assert bootstrap.marker_of("补充-取消超时-extra：合成", p0_tail=True) is None
    assert bootstrap.marker_of("前缀补充-取消超时：合成", p0_tail=True) is None
    with pytest.raises(ValueError, match="explicit P0-tail"):
        bootstrap.install_test_hooks(None, ENDPOINT_A, endpoint_b=ENDPOINT_B)
    monkeypatch.setattr(bootstrap, "MAX_TRACE_EVENTS", 4)
    path = tmp_path / "cap.jsonl"
    first = bootstrap.MetadataTrace(path, 1)
    first.write("bootstrap", injected=True)
    first.close()
    first.close()  # Cleanup is safe when a host calls it twice.
    second = bootstrap.MetadataTrace(path, 2)
    second.write("bootstrap", injected=True)
    second.write("bootstrap", injected=True)
    second.close()
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    assert len(rows) == 4
    assert rows[-1]["event"] == "trace_health" and rows[-1]["complete"] is False
    assert rows[-1]["overflow"] is True and path.stat().st_size <= bootstrap.MAX_TRACE_BYTES


@pytest.mark.parametrize("p0_tail", [False, True])
def test_bootstrap_failure_restores_real_handlers_and_writes_health(tmp_path, monkeypatch, p0_tail):
    from src.chat.delivery import ChatDeliveryCoordinator

    factory = tail_isolation if p0_tail else isolation
    context, data, endpoint, evidence, descriptors = factory(tmp_path, monkeypatch)
    original_dispatch = ws_bridge.dispatch_authenticated_message
    original_cancel = ws_bridge._handlers[ws_bridge.MsgType.CHAT_CANCEL]
    original_accept = ChatDeliveryCoordinator.accept
    original_http_send = httpx.AsyncClient.send
    monkeypatch.setattr(bootstrap.sys, "argv", ["private-test"])
    monkeypatch.setattr(bootstrap.sys, "path", bootstrap.sys.path.copy())

    def failed_runtime(module, *, run_name):
        assert module == "src.main" and run_name == "__main__"
        assert bootstrap.sys.argv == [str(ROOT / "src/main.py"), "--stdio-bridge"]
        raise RuntimeError("controlled bootstrap runtime failure")

    monkeypatch.setattr(bootstrap.runpy, "run_module", failed_runtime)
    args = ["--stdio-bridge", "--context", str(context), "--data-dir", str(data),
            "--endpoint", endpoint, "--evidence", str(evidence), "--cycle", "1"]
    if p0_tail:
        args += ["--p0-tail", "--endpoint-b", ENDPOINT_B]
    try:
        with pytest.raises(RuntimeError, match="runtime failure"):
            bootstrap.main(args)
        assert ws_bridge.dispatch_authenticated_message is original_dispatch
        assert ws_bridge._handlers[ws_bridge.MsgType.CHAT_CANCEL] is original_cancel
        assert ChatDeliveryCoordinator.accept is original_accept
        assert httpx.AsyncClient.send is original_http_send
        rows = [json.loads(line) for line in evidence.read_text().splitlines()]
        assert [row["event"] for row in rows] == ["bootstrap", "trace_health"]
        assert rows[-1]["complete"] is True
    finally:
        for descriptor in descriptors:
            os.close(descriptor)
