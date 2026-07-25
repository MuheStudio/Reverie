"""Request-scoped, crash-aware chat generation and delivery.

The coordinator owns delivery truth.  UI labels, animation, and legacy events
are projections of this ledger; they never decide whether a provider call may
be repeated.  A provider invocation that was started but whose result wasn't
durably stored is intentionally treated as ``failed_uncertain`` after restart.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..kernel.contracts import CommandEnvelopeV3, DomainEventV3, PersonaScopeV3
from ..kernel.storage import KernelStore
from ..local_mode import LocalModeBlocked, LocalModeGate, get_local_mode_gate
from .pending import ACTIVE_STATES, PendingChatStore, epoch_to_utc, utc_to_epoch

logger = logging.getLogger("reverie.chat.delivery")

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
SCOPE_ID_RE = re.compile(r"^[^\x00-\x1f\x7f]{0,160}$")
URGENT_RE = re.compile(
    r"(?:救命|自杀|自傷|自伤|急诊|急救|危险|被跟踪|报警|火灾|中毒|窒息|"
    r"心脏|胸痛|昏迷|割腕|跳楼|immediate danger|suicid|emergency|overdose|"
    r"can't breathe|cannot breathe)",
    re.IGNORECASE,
)

EmitCallback = Callable[[str, str, dict[str, Any]], Awaitable[bool]]
SessionGetter = Callable[[], Any]
ScopeValidator = Callable[[dict[str, Any]], bool]


class ChatDeliveryError(RuntimeError):
    """A request cannot safely continue."""


class ClientDisconnected(ChatDeliveryError):
    """The result remains cached for a later authenticated controller."""


def _utc_now(clock: Callable[[], float] = time.time) -> str:
    return datetime.fromtimestamp(clock(), timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _safe_utc(value: Any, *, now: float) -> str:
    parsed = utc_to_epoch(value, fallback=now)
    # A renderer timestamp is descriptive, never scheduling authority.  Clamp
    # pathological values so an attacker can't defer work.  Future renderer
    # clocks are normalized to the server acceptance time; monotonic time is
    # the actual scheduling authority after acceptance.
    parsed = min(now, max(now - 7 * 86400.0, parsed))
    return epoch_to_utc(parsed)


def _scope_value(value: Any, *, fallback: str = "") -> str:
    text = str(value or fallback).strip()
    if not SCOPE_ID_RE.fullmatch(text):
        raise ChatDeliveryError("Invalid chat scope")
    return text


def stable_characters_per_minute(request_id: str, conversation_id: str, persona_id: str) -> int:
    digest = hashlib.sha256(
        f"{request_id}\0{conversation_id}\0{persona_id}".encode("utf-8", errors="strict")
    ).digest()
    return 60 + int.from_bytes(digest[:2], "big") % 21


def is_urgent_context(text: str) -> bool:
    return bool(URGENT_RE.search(str(text or "")))


def delivery_targets(
    messages: list[str],
    *,
    request_id: str,
    conversation_id: str,
    persona_id: str,
    urgent: bool,
) -> tuple[int, list[float]]:
    """Return deterministic CPM and elapsed targets from the original send.

    The first target is at most eight seconds; all targets are at most twenty
    seconds.  Inter-bubble rhythm is 0.8–2.4s for the normal maximum of sixteen
    bubbles.  Serious or safety-sensitive text receives no artificial delay.
    """
    cpm = stable_characters_per_minute(request_id, conversation_id, persona_id)
    if not messages:
        return cpm, [0.0]
    if urgent:
        return cpm, [0.0 for _ in messages]

    lengths = [max(1, len(message.strip())) for message in messages]
    cumulative: list[int] = []
    total = 0
    for length in lengths:
        total += length
        cumulative.append(total)

    nominal_total = min(20.0, total * 60.0 / cpm)
    first = min(8.0, max(0.8, lengths[0] * 60.0 / cpm))
    targets = [min(first, nominal_total)]
    for index in range(1, len(messages)):
        proportional = nominal_total * cumulative[index] / max(1, total)
        target = max(targets[-1] + 0.8, proportional)
        target = min(targets[-1] + 2.4, target, 20.0)
        targets.append(target)
    return cpm, targets


def _bounded_messages(value: Any) -> list[str]:
    messages = [str(item).strip() for item in list(value or []) if str(item).strip()]
    if not messages:
        return []
    # More than sixteen bubbles cannot satisfy both the 0.8s minimum interval
    # and the 20s total cap.  Preserve all text by merging the tail.
    if len(messages) > 16:
        messages = [*messages[:15], "".join(messages[15:])]
    return messages


class ChatDeliveryCoordinator:
    """Generate once, cache before delivery, and isolate every request."""

    def __init__(
        self,
        *,
        store: PendingChatStore,
        get_session: SessionGetter,
        emit: EmitCallback,
        scope_is_current: ScopeValidator | None = None,
        local_mode_gate: LocalModeGate | None = None,
        kernel_store: KernelStore | None = None,
        provider_timeout: float = 180.0,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.store = store
        self.get_session = get_session
        self.emit = emit
        self.scope_is_current = scope_is_current or (lambda _item: True)
        self.local_mode_gate = local_mode_gate or get_local_mode_gate()
        self.kernel_store = kernel_store
        self.provider_timeout = max(1.0, float(provider_timeout))
        self.clock = clock
        self.monotonic = monotonic
        self.sleep = sleep
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.reveal_events: dict[str, asyncio.Event] = {}
        self.anchors: dict[str, tuple[float, float]] = {}
        self.generation_lock = asyncio.Lock()

    def _track(self, request_id: str, task: asyncio.Task[None]) -> None:
        previous = self.tasks.get(request_id)
        if previous and previous is not task and not previous.done():
            raise ChatDeliveryError("Request is already running")
        self.tasks[request_id] = task

        def cleanup(done: asyncio.Task[None]) -> None:
            if self.tasks.get(request_id) is done:
                self.tasks.pop(request_id, None)
            self.anchors.pop(request_id, None)

        task.add_done_callback(cleanup)

    def _spawn(self, request_id: str, *, recovery: bool = False) -> None:
        existing = self.tasks.get(request_id)
        if existing and not existing.done():
            return
        task = asyncio.create_task(self._run(request_id, recovery=recovery))
        self._track(request_id, task)

    async def accept(self, payload: dict[str, Any], *, client_id: str) -> dict[str, Any]:
        self.local_mode_gate.require_remote("chat generation")
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ChatDeliveryError("消息为空")
        if len(text) > 20_000:
            raise ChatDeliveryError("消息过长")
        request_id = str(payload.get("request_id") or f"chat_{uuid.uuid4().hex}")
        if not REQUEST_ID_RE.fullmatch(request_id):
            raise ChatDeliveryError("Invalid request_id")
        conversation_id = _scope_value(payload.get("conversation_id"), fallback="default")
        persona_id = _scope_value(payload.get("persona_id"), fallback="default")
        persona_epoch = int(payload.get("persona_epoch") or 0)
        if persona_epoch < 0:
            raise ChatDeliveryError("Invalid persona epoch")
        persona_fingerprint = _scope_value(payload.get("persona_fingerprint"))
        model_epoch = int(payload.get("model_epoch") or 0)
        if model_epoch < 0:
            raise ChatDeliveryError("Invalid model epoch")
        model_fingerprint = _scope_value(payload.get("model_fingerprint"))
        now = self.clock()
        existing = self.store.get_item(request_id)
        if existing:
            immutable = (
                "text",
                "conversation_id",
                "persona_id",
                "persona_epoch",
                "persona_fingerprint",
                "model_epoch",
                "model_fingerprint",
            )
            proposed = {
                "text": text,
                "conversation_id": conversation_id,
                "persona_id": persona_id,
                "persona_epoch": persona_epoch,
                "persona_fingerprint": persona_fingerprint,
                "model_epoch": model_epoch,
                "model_fingerprint": model_fingerprint,
            }
            if any(existing.get(key) != proposed[key] for key in immutable):
                raise ChatDeliveryError("request_id was already used with different content or scope")
            await self._emit_state(existing)
            if existing.get("state") in ACTIVE_STATES:
                self._spawn(request_id, recovery=True)
            return self._state_payload(existing)

        sent_at = _safe_utc(payload.get("sent_at_utc"), now=now)
        kernel_command = self._kernel_command(
            {
                "request_id": request_id,
                "text": text,
                "conversation_id": conversation_id,
                "persona_id": persona_id,
                "persona_epoch": persona_epoch,
                "persona_fingerprint": persona_fingerprint,
            }
        )
        if kernel_command is not None:
            self.kernel_store.begin_command(kernel_command)
        self.store.enqueue(
            text,
            due_at=now,
            request_id=request_id,
            conversation_id=conversation_id,
            persona_id=persona_id,
            persona_epoch=persona_epoch,
            persona_fingerprint=persona_fingerprint,
            model_epoch=model_epoch,
            model_fingerprint=model_fingerprint,
            source="user",
            client_id=client_id,
            sent_at_utc=sent_at,
        )
        self.anchors[request_id] = (self.monotonic(), utc_to_epoch(sent_at, fallback=now))
        item = self.store.get_item(request_id) or {}
        await self._emit_state(item, label="她看见了")
        self._spawn(request_id)
        return self._state_payload(item)

    async def resume(
        self,
        *,
        client_id: str,
        conversation_id: str = "",
        persona_id: str = "",
    ) -> None:
        for item in self.store.list_active():
            if conversation_id and item.get("conversation_id") != conversation_id:
                continue
            if persona_id and item.get("persona_id") != persona_id:
                continue
            if hasattr(self.store, "rebind_client"):
                self.store.rebind_client(str(item["request_id"]), client_id)
            self._spawn(str(item["request_id"]), recovery=True)

    async def cancel(self, request_id: str, *, client_id: str, reason: str = "user_cancelled") -> dict[str, Any]:
        item = self.store.get_item(request_id)
        if not item:
            raise ChatDeliveryError("Unknown request_id")
        if item.get("client_id") and item.get("client_id") != client_id:
            raise ChatDeliveryError("Request belongs to another controller")
        provider_may_have_been_called = item.get("provider_state") in {"started", "completed"}
        if item.get("state") not in {"done", "failed", "failed_uncertain", "cancelled"}:
            # Tombstone is durable before Task.cancel(), because cancellation is
            # cooperative and cannot prove whether a provider charged the call.
            self.store.mark_cancelled(request_id, reason=reason)
            reveal = self.reveal_events.get(request_id)
            if reveal:
                reveal.set()
            task = self.tasks.get(request_id)
            if task and not task.done():
                task.cancel()
            if self.kernel_store is not None:
                try:
                    self.kernel_store.fail_command(
                        request_id,
                        error_code="CANCELLED",
                        provider_outcome_unknown=provider_may_have_been_called,
                    )
                except Exception:
                    logger.exception("Could not persist cancelled kernel command")
        current = self.store.get_item(request_id) or item
        await self._emit_state(
            current,
            provider_may_have_been_called=provider_may_have_been_called,
        )
        return {
            "ok": True,
            "request_id": request_id,
            "state": current.get("state"),
            "provider_may_have_been_called": provider_may_have_been_called,
        }

    async def reveal(self, request_id: str, *, client_id: str) -> dict[str, Any]:
        item = self.store.get_item(request_id)
        if not item:
            raise ChatDeliveryError("Unknown request_id")
        if item.get("client_id") and item.get("client_id") != client_id:
            raise ChatDeliveryError("Request belongs to another controller")
        if item.get("state") not in {"generating", "ready_waiting", "delivering"}:
            return {"ok": False, "request_id": request_id, "state": item.get("state")}
        if not item.get("reveal_requested"):
            self.store.mark_reveal_requested(request_id)
        self.reveal_events.setdefault(request_id, asyncio.Event()).set()
        current = self.store.get_item(request_id) or item
        await self._emit_state(current)
        return {"ok": True, "request_id": request_id, "state": current.get("state")}

    async def cancel_all(self, *, reason: str = "local_mode") -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for item in self.store.list_active():
            try:
                results.append(
                    await self.cancel(
                        str(item["request_id"]),
                        client_id=str(item.get("client_id") or ""),
                        reason=reason,
                    )
                )
            except Exception:
                logger.exception("Could not cancel chat request %s", item.get("request_id"))
        return results

    async def _run(self, request_id: str, *, recovery: bool) -> None:
        try:
            item = self.store.get_item(request_id)
            if not item or item.get("state") not in ACTIVE_STATES:
                return
            if item.get("state") == "queued":
                await self._generate(request_id)
                item = self.store.get_item(request_id)
                if not item or item.get("state") != "ready_waiting":
                    return
            elif item.get("state") == "generating":
                # This case can only exist while the original task is alive.
                # Never launch a second provider call for it.
                return
            await self._deliver(request_id, immediate=recovery)
        except asyncio.CancelledError:
            raise
        except ClientDisconnected:
            item = self.store.get_item(request_id)
            if item and item.get("state") == "delivering":
                self.store.set_state(request_id, "ready_waiting")
        except Exception as exc:
            logger.exception("Chat request %s failed", request_id)
            item = self.store.get_item(request_id)
            if item and item.get("state") in ACTIVE_STATES:
                uncertain = item.get("provider_state") == "started"
                self.store.mark_failed(request_id, str(exc), uncertain=uncertain)
                if self.kernel_store is not None:
                    try:
                        self.kernel_store.fail_command(
                            request_id,
                            error_code=exc.__class__.__name__,
                            provider_outcome_unknown=uncertain,
                        )
                    except Exception:
                        logger.exception("Could not persist failed kernel command")
                await self._emit_state(self.store.get_item(request_id) or item)

    async def _generate(self, request_id: str) -> None:
        item = self.store.get_item(request_id)
        if not item or item.get("cancelled"):
            return
        self.local_mode_gate.require_remote("chat generation")
        if not self.scope_is_current(item):
            self.store.mark_cancelled(request_id, reason="scope_changed")
            return
        session = self.get_session()
        if session is None or not hasattr(session, "send_message"):
            raise ChatDeliveryError("会话未初始化")

        async with self.generation_lock:
            item = self.store.get_item(request_id)
            if not item or item.get("cancelled") or item.get("state") != "queued":
                return
            self.local_mode_gate.require_remote("chat generation")
            if not self.scope_is_current(item):
                self.store.mark_cancelled(request_id, reason="scope_changed")
                return
            self.store.mark_generating(request_id)
            if self.kernel_store is not None:
                self.kernel_store.mark_provider_dispatched(request_id)
            item = self.store.get_item(request_id) or item
            if not await self._emit_state(item, label="她看见了，正在想怎么说"):
                # Generation may continue without a renderer; the result will be
                # cached, but no bubble is emitted to another arbitrary window.
                logger.info("Controller disconnected while request %s was generating", request_id)

            send_method = session.send_message
            parameters = inspect.signature(send_method).parameters
            kwargs: dict[str, Any] = {}
            if "status_delay_applied" in parameters:
                kwargs["status_delay_applied"] = True
            if "defer_side_effects" in parameters:
                kwargs["defer_side_effects"] = True
            if "request_id" in parameters:
                kwargs["request_id"] = request_id

            try:
                result = await asyncio.wait_for(
                    send_method(str(item.get("text", "")), **kwargs),
                    timeout=self.provider_timeout,
                )
            except LocalModeBlocked:
                self.store.mark_cancelled(request_id, reason="local_mode")
                await self._emit_state(self.store.get_item(request_id) or item)
                return
        if not isinstance(result, dict):
            raise ChatDeliveryError("Chat session returned an invalid result")

        current = self.store.get_item(request_id)
        if not current or current.get("cancelled") or current.get("state") == "cancelled":
            return
        if not self.scope_is_current(current):
            self.store.mark_cancelled(request_id, reason="scope_changed")
            return
        messages = _bounded_messages(result.get("messages") or [result.get("reply", "")])
        if not messages:
            raise ChatDeliveryError("Chat session returned an empty reply")
        cpm, targets = delivery_targets(
            messages,
            request_id=request_id,
            conversation_id=str(current.get("conversation_id") or ""),
            persona_id=str(current.get("persona_id") or ""),
            urgent=is_urgent_context(str(current.get("text") or "")),
        )
        result = dict(result)
        result["messages"] = messages
        result["delivery_id"] = current.get("delivery_id")
        result["request_id"] = request_id
        result["conversation_id"] = current.get("conversation_id")
        result["persona_id"] = current.get("persona_id")
        result["persona_epoch"] = current.get("persona_epoch")
        result["persona_fingerprint"] = current.get("persona_fingerprint")
        result["model_epoch"] = current.get("model_epoch")
        result["model_fingerprint"] = current.get("model_fingerprint")
        result["characters_per_minute"] = cpm
        result["delivery_targets_seconds"] = targets
        result["provider_completed_at_utc"] = _utc_now(self.clock)
        result["side_effects_deferred"] = "defer_side_effects" in parameters
        sent_epoch = utc_to_epoch(current.get("created_at_utc"), fallback=self.clock())
        deliver_at = sent_epoch + (targets[0] if targets else 0.0)
        self.store.mark_ready(request_id, result, deliver_at_utc=epoch_to_utc(deliver_at))
        await self._emit_state(self.store.get_item(request_id) or current)

    async def _wait_for_target(self, item: dict[str, Any], elapsed_target: float) -> None:
        request_id = str(item["request_id"])
        reveal = self.reveal_events.setdefault(request_id, asyncio.Event())
        if item.get("reveal_requested"):
            reveal.set()
        sent_epoch = utc_to_epoch(item.get("created_at_utc"), fallback=self.clock())
        anchor = self.anchors.get(request_id)
        wall_remaining = sent_epoch + elapsed_target - self.clock()
        if anchor:
            anchor_mono, anchor_sent_epoch = anchor
            already_elapsed = max(0.0, self.monotonic() - anchor_mono + (anchor_sent_epoch - sent_epoch))
            monotonic_remaining = elapsed_target - already_elapsed
            remaining = min(wall_remaining, monotonic_remaining)
        else:
            remaining = wall_remaining
        if remaining <= 0 or reveal.is_set():
            return
        sleep_task = asyncio.create_task(self.sleep(remaining))
        reveal_task = asyncio.create_task(reveal.wait())
        try:
            await asyncio.wait(
                {sleep_task, reveal_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            for task in (sleep_task, reveal_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(sleep_task, reveal_task, return_exceptions=True)

    async def _maybe_emit_retraction(
        self,
        item: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        """Emit the optional typo correction once, scoped to its owner.

        The durable ``started`` tombstone is written before the event.  If the
        process or renderer disappears at that boundary, skipping a cosmetic
        correction is safer than replaying a second authoritative mutation.
        """
        if item.get("retraction_state", "not_started") != "not_started":
            return
        messages = _bounded_messages(result.get("messages"))
        typo_indices = [
            int(index)
            for index in (result.get("typo_indices") or [])
            if isinstance(index, int) and 0 <= index < len(messages)
        ]
        if not messages:
            return
        scheduler = getattr(self.get_session(), "scheduler", None)
        decision = False
        if scheduler and hasattr(scheduler, "should_retract_message"):
            emotions = dict(
                getattr(getattr(self.get_session(), "emotion", None), "values", {}) or {}
            )
            try:
                candidate = scheduler.should_retract_message(
                    had_typo=bool(typo_indices),
                    emotions=emotions,
                    bubble_count=len(messages),
                )
            except TypeError:
                candidate = scheduler.should_retract_message()
            decision = candidate is True
        if not decision:
            return

        index = typo_indices[-1] if typo_indices else len(messages) - 1
        clean_messages = _bounded_messages(result.get("clean_messages") or messages)
        replacement = clean_messages[index] if index < len(clean_messages) else messages[index]
        request_id = str(item["request_id"])
        self.store.mark_retraction_started(request_id)
        # Stable 2.0–5.0 second rhythm avoids global randomness and is testable.
        digest = hashlib.sha256(request_id.encode("utf-8")).digest()
        await self.sleep(2.0 + int.from_bytes(digest[:2], "big") / 65535.0 * 3.0)
        refreshed = self.store.get_item(request_id) or item
        if not self.scope_is_current(refreshed):
            return
        payload = self._scope_payload(refreshed)
        payload.update(
            {
                "replacement": replacement,
                "notice": "对方撤回了一条消息",
                "bubble_index": index,
            }
        )
        if await self.emit(str(refreshed.get("client_id") or ""), "chat:retract", payload):
            self.store.mark_retraction_completed(request_id)

    async def _commit_if_needed(self, item: dict[str, Any], result: dict[str, Any]) -> None:
        request_id = str(item["request_id"])
        if item.get("commit_state") == "completed":
            return
        if item.get("commit_state") in {"started", "uncertain"}:
            # At-most-once is safer than duplicating relationship/memory writes.
            return
        if not result.get("side_effects_deferred"):
            self.store.mark_committed(request_id)
            return
        session = self.get_session()
        commit = getattr(session, "commit_exchange", None)
        if not callable(commit):
            self.store.mark_commit_uncertain(request_id, "deferred result has no commit handler")
            return
        self.store.mark_commit_started(request_id)
        try:
            self._commit_kernel_exchange(item, result)
            outcome = commit(
                request_id=request_id,
                user_message=str(item.get("text") or ""),
                result=result,
            )
            if inspect.isawaitable(outcome):
                await outcome
            self.store.mark_committed(request_id)
        except asyncio.CancelledError as exc:
            self.store.mark_commit_uncertain(request_id, str(exc))
            raise
        except Exception as exc:
            self.store.mark_commit_uncertain(request_id, str(exc))
            logger.exception("Chat side-effect commit failed for %s", request_id)

    def _kernel_command(self, item: dict[str, Any]) -> CommandEnvelopeV3 | None:
        if self.kernel_store is None:
            return None
        persona = PersonaScopeV3(
            persona_id=str(item.get("persona_id") or ""),
            epoch=int(item.get("persona_epoch") or 0),
            fingerprint=str(item.get("persona_fingerprint") or ""),
        )
        request_id = str(item.get("request_id") or "")
        return CommandEnvelopeV3(
            request_id=request_id,
            idempotency_key=request_id,
            command="chat:send",
            persona=persona,
            payload={
                "text": str(item.get("text") or ""),
                "conversation_id": str(item.get("conversation_id") or "default"),
            },
        )

    def _commit_kernel_exchange(
        self,
        item: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        command = self._kernel_command(item)
        if command is None:
            return
        context = result.get("_commit_context")
        if not isinstance(context, dict):
            context = {}
        events = [
            DomainEventV3(
                event_type="relationship.interaction.requested",
                persona=command.persona,
                causation_id=command.request_id,
                payload={"request_id": command.request_id},
            ),
            DomainEventV3(
                event_type="emotion.exchange.requested",
                persona=command.persona,
                causation_id=command.request_id,
                payload={"request_id": command.request_id},
            ),
        ]
        if bool(context.get("memory_safe")) and context.get("memory_directive") != "skip":
            events.append(
                DomainEventV3(
                    event_type="memory.interaction.requested",
                    persona=command.persona,
                    causation_id=command.request_id,
                    payload={
                        "request_id": command.request_id,
                        "directive": context.get("memory_directive"),
                    },
                )
            )
        clean_messages = _bounded_messages(
            result.get("clean_messages")
            or result.get("messages")
            or [result.get("reply", "")]
        )
        self.kernel_store.commit_chat_exchange(
            command,
            conversation_id=str(item.get("conversation_id") or "default"),
            user_text=str(item.get("text") or ""),
            assistant_bubbles=clean_messages,
            events=events,
            result={
                "conversation_id": str(item.get("conversation_id") or "default"),
                "bubble_count": len(clean_messages),
                "delivery_id": item.get("delivery_id"),
            },
        )

    async def _deliver(self, request_id: str, *, immediate: bool) -> None:
        item = self.store.get_item(request_id)
        if not item or item.get("state") not in {"ready_waiting", "delivering"}:
            return
        result = item.get("result")
        if not isinstance(result, dict):
            self.store.mark_failed(request_id, "cached result is missing")
            return
        if not self.scope_is_current(item):
            self.store.mark_cancelled(request_id, reason="scope_changed")
            return
        if immediate:
            self.reveal_events.setdefault(request_id, asyncio.Event()).set()
        targets = [float(value) for value in result.get("delivery_targets_seconds", [0.0])]
        messages = _bounded_messages(result.get("messages"))
        if not messages:
            self.store.mark_failed(request_id, "cached result is empty")
            return
        delivered = {int(value) for value in item.get("delivered_bubble_indices", [])}
        first_missing = next((index for index in range(len(messages)) if index not in delivered), None)
        if first_missing is None:
            if await self._emit_done(item, result):
                self.store.mark_done(request_id)
            else:
                self.store.set_state(request_id, "ready_waiting")
            return

        if not immediate:
            await self._wait_for_target(item, targets[min(first_missing, len(targets) - 1)])
        current = self.store.get_item(request_id)
        if not current or current.get("cancelled") or current.get("state") == "cancelled":
            return
        if not self.scope_is_current(current):
            self.store.mark_cancelled(request_id, reason="scope_changed")
            return
        await self._commit_if_needed(current, result)
        self.store.mark_delivering(request_id)
        current = self.store.get_item(request_id) or current
        if not await self._emit_state(current):
            raise ClientDisconnected()

        for index, message in enumerate(messages):
            refreshed = self.store.get_item(request_id)
            if not refreshed or refreshed.get("cancelled") or refreshed.get("state") == "cancelled":
                return
            if index in delivered:
                continue
            if not self.scope_is_current(refreshed):
                self.store.mark_cancelled(request_id, reason="scope_changed")
                return
            if index > first_missing and not immediate:
                await self._wait_for_target(refreshed, targets[min(index, len(targets) - 1)])
            payload = self._scope_payload(refreshed)
            payload.update(
                {
                    "text": message,
                    "index": index,
                    "bubble_index": index,
                    "total": len(messages),
                    "source": "assistant",
                    "created_at_utc": _utc_now(self.clock),
                }
            )
            if not await self.emit(str(refreshed.get("client_id") or ""), "chat:bubble", payload):
                raise ClientDisconnected()
            self.store.mark_bubble_delivered(request_id, index)
            delivered.add(index)

        final_item = self.store.get_item(request_id) or current
        if await self._emit_done(final_item, result):
            self.store.mark_done(request_id)
            await self._maybe_emit_retraction(
                self.store.get_item(request_id) or final_item,
                result,
            )
        else:
            self.store.set_state(request_id, "ready_waiting")

    def _scope_payload(self, item: dict[str, Any]) -> dict[str, Any]:
        return {
            "request_id": item.get("request_id"),
            "delivery_id": item.get("delivery_id"),
            "conversation_id": item.get("conversation_id"),
            "persona_id": item.get("persona_id"),
            "persona_epoch": item.get("persona_epoch"),
            "persona_fingerprint": item.get("persona_fingerprint"),
            "model_epoch": item.get("model_epoch"),
            "model_fingerprint": item.get("model_fingerprint"),
        }

    def _state_payload(self, item: dict[str, Any], **extra: Any) -> dict[str, Any]:
        state = str(item.get("state") or "failed")
        labels = {
            "queued": "她看见了",
            "generating": "她看见了，正在想怎么说",
            "ready_waiting": "回复已经准备好",
            "delivering": "正在送达",
            "done": "已送达",
            "failed": "回复失败",
            "failed_uncertain": "供应商结果未知，未自动重试",
            "cancelled": "已取消",
        }
        payload = self._scope_payload(item)
        payload.update(
            {
                "state": state,
                "label": extra.pop("label", labels.get(state, "状态未知")),
                "updated_at_utc": _utc_now(self.clock),
                "deliver_at_utc": item.get("deliver_at_utc"),
                "can_reveal": state == "ready_waiting",
                "provider_may_have_been_called": item.get("provider_state") in {"started", "completed"},
                "error": item.get("error"),
                **extra,
            }
        )
        return payload

    async def _emit_state(self, item: dict[str, Any], **extra: Any) -> bool:
        return await self.emit(
            str(item.get("client_id") or ""),
            "chat:state",
            self._state_payload(item, **extra),
        )

    async def _emit_done(self, item: dict[str, Any], result: dict[str, Any]) -> bool:
        public_result = {key: value for key, value in result.items() if not str(key).startswith("_")}
        public_result.update(self._scope_payload(item))
        public_result.update({"state": "done", "incremental_delivery": True})
        return await self.emit(str(item.get("client_id") or ""), "chat:done", public_result)

    async def shutdown(self) -> None:
        tasks = tuple(task for task in self.tasks.values() if not task.done())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
        self.reveal_events.clear()
        self.anchors.clear()


__all__ = [
    "ChatDeliveryCoordinator",
    "ChatDeliveryError",
    "ClientDisconnected",
    "delivery_targets",
    "is_urgent_context",
    "stable_characters_per_minute",
]
