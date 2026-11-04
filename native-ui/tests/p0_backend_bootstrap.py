"""Disposable supplementary GUI bootstrap; never used by the normal runtime.

Registered synthetic messages receive a deterministic start plan only inside
their authenticated owner dispatch. The explicit P0-tail suite also registers
two exact host-owned destinations and one-shot cancel failures. Every other
message uses the original planner, including the original 20-second cases.
Diagnostics are a closed metadata projection, never framed stdout content.
"""
from __future__ import annotations

import argparse
from contextvars import ContextVar
import functools
import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = "reverie.qt.p0.backend.metadata.v1"
CONTROLLED_DELAY_SECONDS = 0.2
MARKERS = {
    "补充-受控恢复": "controlled_recovery",
    "补充-受控延迟": "controlled_delay",
    "补充-受控停止": "controlled_stop",
    "补充-恢复": "original_recovery",
    "补充-重启恢复": "original_restart_recovery",
}
CONTROLLED = frozenset({"controlled_recovery", "controlled_delay", "controlled_stop"})
TAIL_MARKERS = {
    "补充-尾部受控恢复": "tail_controlled_recovery",
    "补充-尾部受控延迟": "tail_controlled_delay",
    "补充-尾部受控停止": "tail_controlled_stop",
    "补充-尾部服务B": "tail_service_b",
    "补充-尾部服务A": "tail_service_a",
    "补充-取消拒绝": "cancel_reject",
    "补充-取消超时": "cancel_timeout",
}
TAIL_CONTROLLED = frozenset(TAIL_MARKERS.values())
CANCEL_TIMEOUT_START_SECONDS = 40.0
MAX_TRACKED_SUBJECTS = 128
EVENTS = frozenset({"bootstrap", "gate", "accept", "plan", "generate", "provider_dispatch", "terminal", "cancel_command", "trace_health"})
FIELDS = frozenset({
    "schema", "event", "cycle", "unix_ms", "monotonic_ns", "request_id", "marker",
    "gate_state", "epoch", "start_delay_seconds", "reason", "injected", "state",
    "provider_state", "provider_may_have_been_called", "error_type", "accepted",
    "complete", "overflow", "dropped_events",
    "subject_request_id", "endpoint_role",
})
MAX_TRACE_BYTES = 1024 * 1024
MAX_TRACE_EVENTS = 2048
TRACE_HEALTH_RESERVE = 1024


def marker_of(text: str, *, p0_tail: bool = False) -> str | None:
    # Exact marker plus colon avoids matching a longer or user-composed name.
    prefix = re.match(r"^(补充-[^：:]+)[：:]", str(text))
    if not prefix:
        return None
    name = prefix.group(1)
    return MARKERS.get(name) or (TAIL_MARKERS.get(name) if p0_tail else None)


def validate_endpoint(endpoint: str) -> None:
    # Exact spelling prevents treating arbitrary localhost aliases, paths,
    # credentials, normalized URLs or neighboring ports as owner evidence.
    match = re.fullmatch(r"http://127[.]0[.]0[.]1:([0-9]{4,5})/v1", endpoint)
    if (not match or not 1024 <= int(match.group(1)) <= 65535
            or str(int(match.group(1))) != match.group(1)):
        raise ValueError("supplementary owned loopback endpoint required")


def validate_context(context: Path, data: Path, endpoint: str, evidence: Path, cycle: int,
                     *, p0_tail: bool = False, endpoint_b: str | None = None) -> None:
    if cycle not in (1, 2) or not all(p.is_absolute() for p in (context, data, evidence)):
        raise ValueError("supplementary absolute paths and cycle required")
    if data.resolve() != data or evidence != data / "p0-planner.jsonl":
        raise ValueError("supplementary evidence path is outside the registered data directory")
    info = context.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_size > 16384 or context.resolve() != context):
        raise ValueError("supplementary isolation context is invalid")
    value = json.loads(context.read_text(encoding="utf-8"))
    if value.get("schema") != "reverie.qt.isolation.v1" or value.get("data", {}).get("path") != str(data):
        raise ValueError("supplementary context does not authorize this data directory")
    for name in ("root", "data"):
        expected = value[name]
        target = Path(expected["path"])
        snapshot = target.lstat()
        if (not stat.S_ISDIR(snapshot.st_mode) or target.resolve() != target
                or snapshot.st_uid != os.getuid() or int(expected["uid"]) != snapshot.st_uid
                or str(snapshot.st_dev) != expected["device"] or str(snapshot.st_ino) != expected["inode"]):
            raise ValueError("supplementary isolation directory identity changed")
    if data.parent != Path(value["root"]["path"]) or context.parent != data.parent:
        raise ValueError("supplementary context and data must share the registered run root")
    current = data
    while current != current.parent:
        if current.is_symlink() or not current.is_dir() or current.suffix.lower() == ".app":
            raise ValueError("supplementary unsafe directory chain")
        current = current.parent
    validate_endpoint(endpoint)
    if p0_tail:
        if not endpoint_b or endpoint_b == endpoint:
            raise ValueError("P0-tail requires two distinct registered endpoints")
        validate_endpoint(endpoint_b)
        registered = value.get("p0_tail", {}).get("endpoints")
        if registered != {"A": endpoint, "B": endpoint_b}:
            raise ValueError("P0-tail endpoints are not registered in the owner context")
    elif endpoint_b is not None:
        raise ValueError("secondary endpoint requires the explicit P0-tail suite")
    required = {
        "REVERIE_BRIDGE_MODE": "1", "REVERIE_REQUIRE_ENCRYPTED_STORAGE": "1",
        "REVERIE_STORAGE_KEY_FD": "3", "REVERIE_DATA_DIR": str(data / "data"),
        "PYTHON_DOTENV_DISABLED": "1",
    }
    if any(os.environ.get(key) != expected for key, expected in required.items()):
        raise ValueError("supplementary private desktop bootstrap required")
    if not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("supplementary storage key must arrive through the private pipe")
    configured = json.loads((data / "data" / "config.json").read_text(encoding="utf-8")).get("llm", {})
    expected_endpoint = endpoint_b if p0_tail and cycle == 2 else endpoint
    configured_endpoint = configured.get("base_url", "")
    if (configured.get("provider") != "ollama"
            or (configured_endpoint if p0_tail else configured_endpoint.rstrip("/")) != expected_endpoint
            or (p0_tail and configured.get("model") != "reverie-qt-p0-tail")):
        raise ValueError("supplementary configuration must use the owned loopback provider")
    if evidence.exists() or evidence.is_symlink():
        existing = evidence.lstat()
        if (not stat.S_ISREG(existing.st_mode) or existing.st_uid != os.getuid()
                or existing.st_nlink != 1 or existing.st_mode & 0o077 or existing.st_size > 1024 * 1024):
            raise ValueError("supplementary evidence must be a private regular file")


class MetadataTrace:
    def __init__(self, evidence: Path, cycle: int) -> None:
        flags = os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
        self.fd = os.open(evidence, flags, 0o600)
        info = os.fstat(self.fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            os.close(self.fd)
            raise ValueError("supplementary evidence descriptor is not private")
        self.cycle = cycle
        self.bytes_written = info.st_size
        self.events_written = os.pread(self.fd, MAX_TRACE_BYTES, 0).count(b"\n")
        self.dropped_events = 0
        self.overflow = False
        self.error_type = ""
        self.closed = False

    def write(self, event: str, **metadata: object) -> None:
        if event not in EVENTS or set(metadata) - FIELDS:
            self.dropped_events += 1
            self.error_type = "UnsupportedMetadata"
            return
        row = {"schema": SCHEMA, "event": event, "cycle": self.cycle,
               "unix_ms": time.time_ns() // 1_000_000, "monotonic_ns": str(time.monotonic_ns()), **metadata}
        encoded = (json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
        if (self.events_written >= MAX_TRACE_EVENTS - 1
                or self.bytes_written + len(encoded) > MAX_TRACE_BYTES - TRACE_HEALTH_RESERVE):
            self.overflow = True
            self.dropped_events += 1
            return
        try:
            count = os.write(self.fd, encoded)
            self.bytes_written += count
            self.events_written += 1
            if count != len(encoded):
                self.error_type = "IncompleteMetadataWrite"
                self.dropped_events += 1
        except OSError as error:
            # A diagnostic failure must not turn a successful business request
            # into failed/failed_uncertain or relax any presence decision.
            self.error_type = type(error).__name__
            self.dropped_events += 1

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        row = {"schema": SCHEMA, "event": "trace_health", "cycle": self.cycle,
               "unix_ms": time.time_ns() // 1_000_000, "monotonic_ns": str(time.monotonic_ns()),
               "complete": not (self.dropped_events or self.error_type),
               "overflow": self.overflow, "dropped_events": self.dropped_events}
        if self.error_type:
            row["error_type"] = self.error_type
        encoded = (json.dumps(row, separators=(",", ":")) + "\n").encode()
        try:
            if (self.events_written < MAX_TRACE_EVENTS
                    and self.bytes_written + len(encoded) <= MAX_TRACE_BYTES):
                os.write(self.fd, encoded)
        except OSError:
            pass  # Missing health receipt makes host evidence incomplete.
        finally:
            os.close(self.fd)


def install_test_hooks(trace: MetadataTrace, endpoint: str, *, p0_tail: bool = False,
                       endpoint_b: str | None = None):
    """Install scoped probes around real backend boundaries; return undo()."""
    from src.bridge import stdio_bridge, ws_bridge
    from src.chat.delivery import ChatDeliveryCoordinator
    from src.chat.scheduler import ReplyStartPlan
    from src.local_mode import get_local_mode_gate
    import httpx

    validate_endpoint(endpoint)
    if p0_tail:
        if not endpoint_b or endpoint_b == endpoint:
            raise ValueError("P0-tail requires two distinct endpoints")
        validate_endpoint(endpoint_b)
    elif endpoint_b is not None:
        raise ValueError("secondary endpoint requires the explicit P0-tail suite")
    endpoints = {"A": endpoint, **({"B": endpoint_b} if p0_tail else {})}
    current: ContextVar[tuple[str, str] | None] = ContextVar("p0_supplementary_request", default=None)
    dispatch_current: ContextVar[tuple[str, str, object] | None] = ContextVar("p0_owner_dispatch", default=None)
    tracked: dict[str, str] = {}
    registered: dict[str, tuple[str, str, object, object]] = {}
    cancel_injected: set[str] = set()
    patches: list[tuple[object, str, object]] = []

    def patch(owner, name, replacement):
        patches.append((owner, name, getattr(owner, name)))
        setattr(owner, name, replacement)

    def scope(request_id: str) -> dict:
        marker = tracked.get(request_id)
        return {"request_id": request_id, "marker": marker} if marker else {}

    def owner_context(controller):
        context = ws_bridge._client_contexts.get(controller)
        return (context if isinstance(controller, stdio_bridge.StdioController)
                and controller is ws_bridge._controller_ws and context is not None
                and context.authenticated and context.protocol_version == 4 else None)

    dispatch = ws_bridge.dispatch_authenticated_message

    @functools.wraps(dispatch)
    async def dispatching(message, controller, *, emit_result=True):
        request_id = str(message.get("request_id") or "") if isinstance(message, dict) else ""
        command = str(message.get("type") or "") if isinstance(message, dict) else ""
        bound = ((request_id, command, controller)
                 if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id) and owner_context(controller)
                 else None)
        token = dispatch_current.set(bound)
        try:
            return await dispatch(message, controller, emit_result=emit_result)
        finally:
            dispatch_current.reset(token)

    patch(ws_bridge, "dispatch_authenticated_message", dispatching)

    apply_local_mode = ws_bridge._apply_local_mode

    @functools.wraps(apply_local_mode)
    async def gate(*args, **kwargs):
        result = await apply_local_mode(*args, **kwargs)
        trace.write("gate", gate_state=result["state"], epoch=result["epoch"])
        return result

    patch(ws_bridge, "_apply_local_mode", gate)
    original_plan = ws_bridge._reply_start_planner

    @functools.wraps(original_plan)
    def plan(text):
        bound = current.get()
        marker = marker_of(text, p0_tail=p0_tail)
        injected = bool(bound and marker == bound[1]
                        and (marker in CONTROLLED or (p0_tail and marker in TAIL_CONTROLLED)))
        delay = CANCEL_TIMEOUT_START_SECONDS if marker == "cancel_timeout" else CONTROLLED_DELAY_SECONDS
        result = (ReplyStartPlan(delay, 1.0, "online", "online_wobble")
                  if injected else original_plan(text))
        if bound:
            trace.write("plan", **scope(bound[0]), injected=injected,
                        start_delay_seconds=float(getattr(result, "start_delay", 0.0) or 0.0),
                        reason=str(getattr(result, "reason", "none")))
        return result

    patch(ws_bridge, "_reply_start_planner", plan)
    accept = ChatDeliveryCoordinator.accept

    @functools.wraps(accept)
    async def accepting(self, payload, *, client_id):
        request_id = str(payload.get("request_id") or "")
        marker = marker_of(payload.get("text", ""), p0_tail=p0_tail)
        dispatch_bound = dispatch_current.get()
        controller = dispatch_bound[2] if dispatch_bound else None
        context = owner_context(controller)
        if (not marker or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id)
                or not dispatch_bound or dispatch_bound[:2] != (request_id, "chat:send")
                or context is None or context.client_id != client_id
                or (request_id in tracked and tracked[request_id] != marker)
                or (request_id not in tracked and len(tracked) >= MAX_TRACKED_SUBJECTS)):
            return await accept(self, payload, client_id=client_id)
        previous_binding = registered.get(request_id)
        tracked[request_id] = marker
        token = current.set((request_id, marker))
        snapshot = get_local_mode_gate().snapshot()
        trace.write("accept", **scope(request_id), gate_state=snapshot.state, epoch=snapshot.epoch)
        try:
            result = await accept(self, payload, client_id=client_id)
            item = self.store.get_item(request_id)
            if (item and item.get("client_id") == client_id
                    and item.get("state") not in {"failed", "failed_uncertain", "cancelled", "done"}):
                registered.setdefault(request_id, (marker, client_id, controller, self))
            trace.write("accept", **scope(request_id), accepted=True, state=str(result.get("state") or ""))
            return result
        except Exception as error:
            if previous_binding is None:
                registered.pop(request_id, None)
            trace.write("accept", **scope(request_id), accepted=False, error_type=type(error).__name__)
            raise
        finally:
            current.reset(token)

    patch(ChatDeliveryCoordinator, "accept", accepting)

    # Replace the actual registered cancel handler. Returning None for timeout
    # neither runs cancel nor produces an ack, and never blocks the stdio loop.
    # Rejection goes through the real dispatcher's error/ledger handling.
    cancel_handler_key = ws_bridge.MsgType.CHAT_CANCEL
    cancel_handler = ws_bridge._handlers[cancel_handler_key]

    @functools.wraps(cancel_handler)
    async def cancelling(payload, controller):
        subject_id = str(payload.get("request_id") or "")
        binding = registered.get(subject_id)
        dispatch_bound = dispatch_current.get()
        context = owner_context(controller)
        matched = bool(binding and context and dispatch_bound
                       and dispatch_bound[1:] == ("chat:cancel", controller)
                       and binding[1] == context.client_id and binding[2] is controller
                       and binding[3] is ws_bridge._get_chat_coordinator())
        marker = binding[0] if binding else tracked.get(subject_id)
        command_id = dispatch_bound[0] if dispatch_bound else ""
        item = binding[3].store.get_item(subject_id) if binding else None
        injected = bool(p0_tail and matched and marker in {"cancel_reject", "cancel_timeout"}
                        and subject_id not in cancel_injected and item
                        and item.get("state") not in {"failed", "failed_uncertain", "cancelled", "done"})
        reason = ("fixture_rejected" if marker == "cancel_reject" else "fixture_ack_timeout") if injected else "passthrough"
        if marker and command_id:
            trace.write("cancel_command", request_id=command_id, subject_request_id=subject_id,
                        marker=marker, accepted=matched, injected=injected, reason=reason)
        if injected:
            cancel_injected.add(subject_id)
            if marker == "cancel_reject":
                raise ValueError("Controlled P0 cancel rejection")
            return None
        return await cancel_handler(payload, controller)

    ws_bridge._handlers[cancel_handler_key] = cancelling
    generate = ChatDeliveryCoordinator._generate

    @functools.wraps(generate)
    async def generating(self, request_id):
        marker = tracked.get(request_id)
        binding = registered.get(request_id)
        if not marker or not binding or binding[3] is not self:
            return await generate(self, request_id)
        token = current.set((request_id, marker))
        snapshot = get_local_mode_gate().snapshot()
        trace.write("generate", **scope(request_id), gate_state=snapshot.state, epoch=snapshot.epoch)
        try:
            return await generate(self, request_id)
        finally:
            current.reset(token)

    patch(ChatDeliveryCoordinator, "_generate", generating)
    send_http = httpx.AsyncClient.send

    @functools.wraps(send_http)
    async def sending_http(self, request, *args, **kwargs):
        bound = current.get()
        role = next((role for role, value in endpoints.items()
                     if str(request.url) == value + "/chat/completions"), None)
        if p0_tail and role is None:
            raise ValueError("P0-tail refuses an unregistered HTTP destination")
        if bound and role:
            trace.write("provider_dispatch", **scope(bound[0]), endpoint_role=role)
        return await send_http(self, request, *args, **kwargs)

    patch(httpx.AsyncClient, "send", sending_http)

    if p0_tail:
        def authorize_provider(payload, *, configured=False):
            if not isinstance(payload, dict):
                raise ValueError("P0-tail provider metadata must be an object")
            llm = getattr(ws_bridge.bridge_state.settings, "llm", None)
            base_url = payload.get("base_url", getattr(llm, "base_url", None) if configured else None)
            if (payload.get("provider", "ollama") != "ollama"
                    or base_url not in endpoints.values()
                    or payload.get("model", "reverie-qt-p0-tail") != "reverie-qt-p0-tail"):
                raise ValueError("P0-tail provider destination is not registered")

        configure_provider = ws_bridge._configure_runtime_provider

        @functools.wraps(configure_provider)
        async def configuring_provider(payload):
            authorize_provider(payload, configured=True)
            return await configure_provider(payload)

        patch(ws_bridge, "_configure_runtime_provider", configuring_provider)
        test_provider = ws_bridge._test_runtime_provider

        @functools.wraps(test_provider)
        async def testing_provider(payload, credential):
            authorize_provider(payload)
            return await test_provider(payload, credential)

        patch(ws_bridge, "_test_runtime_provider", testing_provider)
    emit_state = ChatDeliveryCoordinator._emit_state

    def terminal(item, state=None):
        request_id = str(item.get("request_id") or "")
        state = state or item.get("state")
        if request_id in tracked and state in {"failed", "failed_uncertain", "cancelled", "done"}:
            provider_state = str(item.get("provider_state") or "not_started")
            trace.write("terminal", **scope(request_id), state=state, provider_state=provider_state,
                        provider_may_have_been_called=provider_state in {"started", "completed"})

    @functools.wraps(emit_state)
    async def emitting_state(self, item, **extra):
        result = await emit_state(self, item, **extra)
        terminal(item)
        return result

    patch(ChatDeliveryCoordinator, "_emit_state", emitting_state)
    emit_done = ChatDeliveryCoordinator._emit_done

    @functools.wraps(emit_done)
    async def emitting_done(self, item, result):
        sent = await emit_done(self, item, result)
        if sent:
            terminal(item, "done")
        return sent

    patch(ChatDeliveryCoordinator, "_emit_done", emitting_done)

    def undo():
        ws_bridge._handlers[cancel_handler_key] = cancel_handler
        for owner, name, previous in reversed(patches):
            setattr(owner, name, previous)
        registered.clear()
        tracked.clear()
        cancel_injected.clear()

    return undo


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Run only an isolated supplementary backend fixture.")
    parser.add_argument("--stdio-bridge", action="store_true", required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--p0-tail", action="store_true")
    parser.add_argument("--endpoint-b")
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--cycle", type=int, choices=(1, 2), required=True)
    args = parser.parse_args(argv)
    validate_context(args.context, args.data_dir, args.endpoint, args.evidence, args.cycle,
                     p0_tail=args.p0_tail, endpoint_b=args.endpoint_b)
    sys.path.insert(0, str(ROOT))
    trace = MetadataTrace(args.evidence, args.cycle)
    undo = None
    sys.argv = [str(ROOT / "src" / "main.py"), "--stdio-bridge"]
    try:
        undo = install_test_hooks(trace, args.endpoint, p0_tail=args.p0_tail, endpoint_b=args.endpoint_b)
        trace.write("bootstrap", injected=True, endpoint_role="B" if args.p0_tail and args.cycle == 2 else "A")
        runpy.run_module("src.main", run_name="__main__")
    finally:
        if undo:
            undo()
        trace.close()


if __name__ == "__main__":
    main()
