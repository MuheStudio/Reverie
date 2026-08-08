"""Small application boundary for one companion conversation turn.

The engine owns provider-call concurrency, while adapters own the details of
calling a concrete chat implementation. This keeps delivery, persistence, and
the legacy ``ChatSession`` from depending on each other's internals.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import inspect
from typing import Any, Callable, Protocol, runtime_checkable
from weakref import WeakValueDictionary


class TurnEngineError(RuntimeError):
    """A turn could not safely produce a typed outcome."""


class TurnRuntimeUnavailable(TurnEngineError):
    """No companion runtime is currently available."""


class InvalidTurnOutcome(TurnEngineError):
    """The configured runtime returned a value outside the turn contract."""


@dataclass(frozen=True, slots=True)
class TurnRequest:
    conversation_id: str
    turn_id: str
    generation_id: str
    text: str
    persona_id: str
    persona_epoch: int
    persona_fingerprint: str

    def __post_init__(self) -> None:
        for name in ("conversation_id", "turn_id", "generation_id", "persona_id"):
            if not str(getattr(self, name)).strip():
                raise ValueError(f"{name} must not be empty")
        if not self.text.strip():
            raise ValueError("text must not be empty")
        if self.persona_epoch < 0:
            raise ValueError("persona_epoch must not be negative")


@dataclass(frozen=True, slots=True)
class TurnOutcome:
    payload: dict[str, Any]
    side_effects_deferred: bool


@runtime_checkable
class TurnGenerator(Protocol):
    async def generate(self, request: TurnRequest) -> TurnOutcome: ...


class LegacySessionTurnGenerator:
    """Temporary adapter around ``ChatSession.send_message``."""

    def __init__(self, get_session: Callable[[], Any]) -> None:
        self._get_session = get_session

    async def generate(self, request: TurnRequest) -> TurnOutcome:
        session = self._get_session()
        send = getattr(session, "send_message", None)
        if not callable(send):
            raise TurnRuntimeUnavailable("companion runtime is unavailable")

        parameters = inspect.signature(send).parameters
        kwargs: dict[str, Any] = {}
        if "status_delay_applied" in parameters:
            kwargs["status_delay_applied"] = True
        if "defer_side_effects" in parameters:
            kwargs["defer_side_effects"] = True
        if "request_id" in parameters:
            kwargs["request_id"] = request.turn_id
        if "conversation_id" in parameters:
            kwargs["conversation_id"] = request.conversation_id

        result = await send(request.text, **kwargs)
        if not isinstance(result, dict):
            raise InvalidTurnOutcome("companion runtime returned a non-object outcome")
        return TurnOutcome(
            payload=dict(result),
            side_effects_deferred="defer_side_effects" in parameters,
        )


class TurnEngine:
    """Run at most one provider call per conversation at a time."""

    def __init__(self, generator: TurnGenerator) -> None:
        self._generator = generator
        self._conversation_locks: WeakValueDictionary[str, asyncio.Lock] = (
            WeakValueDictionary()
        )
        self._active_generation: dict[str, str] = {}

    def active_generation(self, conversation_id: str) -> str | None:
        return self._active_generation.get(conversation_id)

    async def generate(
        self,
        request: TurnRequest,
        *,
        timeout: float,
    ) -> TurnOutcome:
        lock = self._conversation_locks.setdefault(
            request.conversation_id,
            asyncio.Lock(),
        )
        async with lock:
            self._active_generation[request.conversation_id] = request.generation_id
            try:
                return await asyncio.wait_for(
                    self._generator.generate(request),
                    timeout=max(1.0, float(timeout)),
                )
            finally:
                if (
                    self._active_generation.get(request.conversation_id)
                    == request.generation_id
                ):
                    self._active_generation.pop(request.conversation_id, None)


__all__ = [
    "InvalidTurnOutcome",
    "LegacySessionTurnGenerator",
    "TurnEngine",
    "TurnEngineError",
    "TurnGenerator",
    "TurnOutcome",
    "TurnRequest",
    "TurnRuntimeUnavailable",
]
