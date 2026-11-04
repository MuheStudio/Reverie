"""Read-only per-turn view of the canonical encrypted persona archive.

Runtime diagnostics and compiled snapshots are disposable memory, never a
second archive. A capture is made before chat awaits any asynchronous work.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
from typing import Any, Callable
from uuid import uuid4

from .engine import EvaluationResult, WorldbookEngine, compile_snapshot

logger = logging.getLogger("reverie.worldbook.runtime")


def archive_available(registry: Any) -> bool:
    """Match the bridge's existing optional-module availability contract."""
    if registry is None:
        return True
    try:
        status = registry.status("archive")
    except KeyError:
        # The core composition can supply an archive without registering an
        # optional module controller. Its store remains authoritative.
        return True
    return str(getattr(status.state, "value", status.state)) == "running"


@dataclass(frozen=True)
class WorldbookCapture:
    snapshot: Any
    revision: int
    checksum: str
    request_id: str
    error: str = ""


class WorldbookRuntime:
    def __init__(self, store: Any, persona_id: str, *, available: Callable[[], bool] | None = None,
                 engine: Any = None) -> None:
        self.store = store
        self.persona_id = persona_id
        self.available = available or (lambda: True)
        self.engine = engine if engine is not None else WorldbookEngine()
        self._cache_key: tuple[int, str] | None = None
        self._snapshot: Any = None
        self._latest_key: tuple[int, str] = (0, "")
        self._diagnostics: dict[str, Any] = self._empty(0)
        self._closed = False
        self.cleanup_confirmed = False

    def _empty(self, revision: int) -> dict[str, Any]:
        return {"persona_id": self.persona_id, "revision": revision,
                "request_id": "", "entries": [], "truncated": 0}

    def observe_record(self, record: dict[str, Any]) -> None:
        key = (int(record.get("revision") or 0), str(record.get("checksum") or ""))
        if key != self._latest_key:
            self._latest_key = key
            self._diagnostics = self._empty(key[0])

    def capture(self, request_id: str = "") -> WorldbookCapture:
        request_id = request_id or f"worldbook-{uuid4()}"
        revision, checksum = self._latest_key
        try:
            if self._closed or self.store is None or not self.available():
                raise RuntimeError("worldbook archive is unavailable")
            record = self.store.get(self.persona_id)
            self.observe_record(record)
            revision, checksum = self._latest_key
            if self._cache_key != self._latest_key or self._snapshot is None:
                candidate = compile_snapshot(self.persona_id, record)
                self._snapshot, self._cache_key = candidate, self._latest_key
            return WorldbookCapture(self._snapshot, revision, checksum, request_id)
        except Exception:
            # Do not log archive content, raw regex, SQL errors or keys.
            logger.warning("Worldbook snapshot unavailable; this turn will omit world settings")
            self._snapshot, self._cache_key = None, None
            return WorldbookCapture(None, revision, checksum, request_id, "snapshot_unavailable")

    def _failure(self, captured: WorldbookCapture, code: str) -> dict[str, Any]:
        return {"persona_id": self.persona_id, "revision": captured.revision,
                "book_id": "", "entry_id": "", "book_index": -1, "entry_index": -1,
                "request_id": captured.request_id, "code": code}

    def _publish(self, captured: WorldbookCapture, entries: list[dict[str, Any]], total: int | None = None) -> None:
        if self._closed or (captured.revision, captured.checksum) != self._latest_key:
            return
        self._diagnostics = {"persona_id": self.persona_id, "revision": captured.revision,
                             "request_id": captured.request_id, "entries": entries[:200],
                             "truncated": max(0, (len(entries) if total is None else total) - 200)}

    async def evaluate(self, captured: WorldbookCapture, messages: list[dict[str, Any]]) -> str:
        """Keep the legacy all-selected-body rendering for existing callers."""
        return str((await self.evaluate_grouped(captured, messages)).text)

    async def evaluate_grouped(self, captured: WorldbookCapture,
                               messages: list[dict[str, Any]]) -> EvaluationResult:
        """Evaluate once and publish diagnostics before returning placement groups."""
        if captured.error or self._closed:
            entries = [self._failure(captured, "snapshot_unavailable")]
            self._publish(captured, entries)
            return EvaluationResult("", entries, (), len(entries))
        try:
            result = await self.engine.evaluate(captured.snapshot, messages,
                                                request_id=captured.request_id, max_tokens=800)
        except asyncio.CancelledError:
            raise
        except Exception:
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                # Cleanup failure must not convert a cancelled chat into a
                # successful optional-context downgrade and a provider call.
                raise asyncio.CancelledError() from None
            logger.warning("Worldbook evaluation failed; this turn will omit world settings")
            entries = [self._failure(captured, "snapshot_unavailable")]
            self._publish(captured, entries)
            return EvaluationResult("", entries, (), len(entries))
        task = asyncio.current_task()
        if task is not None and task.cancelling():
            raise asyncio.CancelledError()
        self._publish(captured, list(result.diagnostics), getattr(result, "diagnostics_total", None))
        return result

    def diagnostics_for(self, record: dict[str, Any] | None = None) -> dict[str, Any]:
        if record is not None:
            self.observe_record(record)
        # Return fresh containers so renderer serialization cannot mutate state.
        return {**self._diagnostics, "entries": [dict(item) for item in self._diagnostics["entries"]]}

    async def aclose(self) -> None:
        self._closed = True
        self._snapshot, self._cache_key = None, None
        self._diagnostics = self._empty(self._latest_key[0])
        await self.engine.aclose()
        self.cleanup_confirmed = True
