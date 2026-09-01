"""Durable request ledger for chat generation and delivery."""

from __future__ import annotations

import json
import logging
import time
import uuid
import copy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config.settings import DATA_DIR

logger = logging.getLogger("reverie.chat.pending")

ACTIVE_STATES = {"queued", "generating", "ready_waiting", "delivering"}
TERMINAL_STATES = {"done", "failed", "failed_uncertain", "cancelled"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch_to_utc(value: float | int | None) -> str:
    try:
        timestamp = float(value or time.time())
    except (TypeError, ValueError):
        timestamp = time.time()
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def utc_to_epoch(value: Any, *, fallback: float = 0.0) -> float:
    if isinstance(value, (float, int)):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return fallback


class PendingChatStore:
    """Persist chat requests, cached results, cancellation, and delivery progress."""

    DEFAULT_PATH = DATA_DIR / "runtime" / "pending_chat.json"

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or self.DEFAULT_PATH
        self._items: dict[str, dict[str, Any]] = {}
        self._load()

    def enqueue(
        self,
        text: str,
        *,
        due_at: float | None = None,
        request_id: str | None = None,
        delivery_id: str | None = None,
        conversation_id: str = "",
        persona_id: str = "",
        persona_epoch: int = 0,
        persona_fingerprint: str = "",
        model_epoch: int = 0,
        model_fingerprint: str = "",
        source: str = "user",
        client_id: str = "",
        sent_at_utc: str | None = None,
        image_path: str = "",
    ) -> str:
        item_id = str(request_id or f"chat_{uuid.uuid4().hex}")
        if item_id in self._items:
            return item_id
        now = time.time()
        due = max(now, float(due_at if due_at is not None else now))
        self._items[item_id] = {
            "id": item_id,
            "request_id": item_id,
            "delivery_id": str(delivery_id or f"delivery_{uuid.uuid4().hex}"),
            "conversation_id": str(conversation_id or ""),
            "persona_id": str(persona_id or ""),
            "persona_epoch": int(persona_epoch or 0),
            "persona_fingerprint": str(persona_fingerprint or ""),
            "model_epoch": int(model_epoch or 0),
            "model_fingerprint": str(model_fingerprint or ""),
            "source": str(source or "user"),
            "client_id": str(client_id or ""),
            "text": str(text),
            # Durable stored-media path so a crash replay regenerates with the
            # same attachment (the bytes live under chat-media/, not here).
            "image_path": str(image_path or ""),
            "state": "queued",
            "provider_state": "not_started",
            "commit_state": "not_started",
            "result": None,
            "delivered_bubble_indices": [],
            "retraction_state": "not_started",
            "reveal_requested": False,
            "cancelled": False,
            "created_at_utc": str(sent_at_utc or epoch_to_utc(now)),
            "deliver_at_utc": epoch_to_utc(due),
            "cancelled_at_utc": None,
            "revealed_at_utc": None,
            "finished_at_utc": None,
            "error": None,
            "created_at": now,
            "due_at": due,
        }
        self._save()
        return item_id

    def get_item(self, item_id: str) -> dict[str, Any] | None:
        item = self._items.get(str(item_id))
        return copy.deepcopy(item) if item is not None else None

    def mark_generating(self, item_id: str) -> None:
        self._update(item_id, state="generating", provider_state="started")

    def set_state(self, item_id: str, state: str, **changes: Any) -> None:
        """Persist a validated state transition before emitting it to a client."""
        if state not in ACTIVE_STATES | TERMINAL_STATES:
            raise ValueError(f"Unsupported pending chat state: {state}")
        self._update(item_id, state=state, **changes)

    def mark_ready(
        self,
        item_id: str,
        result: dict[str, Any],
        *,
        deliver_at_utc: str | None = None,
    ) -> None:
        changes: dict[str, Any] = {
            "state": "ready_waiting",
            "provider_state": "completed",
            "result": copy.deepcopy(result),
        }
        if deliver_at_utc:
            changes["deliver_at_utc"] = str(deliver_at_utc)
            changes["due_at"] = utc_to_epoch(deliver_at_utc, fallback=time.time())
        self._update(item_id, **changes)

    def mark_waiting(self, item_id: str, *, due_at: float | None = None) -> None:
        due = max(time.time(), float(due_at or time.time()))
        self._update(
            item_id,
            state="queued",
            provider_state="not_started",
            due_at=due,
            deliver_at_utc=epoch_to_utc(due),
        )

    def mark_reveal_requested(self, item_id: str) -> None:
        self._update(item_id, reveal_requested=True, revealed_at_utc=utc_now())

    def rebind_client(self, item_id: str, client_id: str) -> None:
        """Bind a cached request to the newly authenticated sole controller."""
        self._update(item_id, client_id=str(client_id or ""))

    def mark_delivering(self, item_id: str) -> None:
        self._update(item_id, state="delivering")

    def mark_commit_started(self, item_id: str) -> None:
        self._update(item_id, commit_state="started")

    def mark_committed(self, item_id: str) -> None:
        self._update(item_id, commit_state="completed")

    def mark_commit_uncertain(self, item_id: str, error: str = "commit interrupted") -> None:
        self._update(item_id, commit_state="uncertain", error=str(error)[:500])

    def mark_bubble_delivered(self, item_id: str, index: int) -> None:
        item = self._items.get(str(item_id))
        if item is None:
            return
        indices = {int(value) for value in item.get("delivered_bubble_indices", [])}
        indices.add(int(index))
        item["delivered_bubble_indices"] = sorted(indices)
        self._save()

    def mark_retraction_started(self, item_id: str) -> None:
        """Tombstone an optional retraction before emitting it.

        A renderer disconnect at the wrong instant must never make a cosmetic
        event replay as though it were a second authoritative chat mutation.
        """
        self._update(item_id, retraction_state="started")

    def mark_retraction_completed(self, item_id: str) -> None:
        self._update(item_id, retraction_state="completed")

    def mark_done(self, item_id: str) -> None:
        self._update(item_id, state="done", finished_at_utc=utc_now())

    def mark_failed(self, item_id: str, error: str, *, uncertain: bool = False) -> None:
        self._update(
            item_id,
            state="failed_uncertain" if uncertain else "failed",
            error=str(error)[:500],
            finished_at_utc=utc_now(),
        )

    def mark_cancelled(self, item_id: str, *, reason: str = "cancelled") -> None:
        item = self._items.get(str(item_id))
        if item is None or item.get("state") in TERMINAL_STATES:
            return
        now = utc_now()
        self._update(
            item_id,
            state="cancelled",
            cancelled=True,
            cancelled_at_utc=now,
            finished_at_utc=now,
            error=str(reason)[:500],
        )

    def clear_not_started(self, *, reason: str = "local_mode") -> list[str]:
        cancelled: list[str] = []
        now = utc_now()
        for item_id, item in tuple(self._items.items()):
            if item.get("state") == "queued" and item.get("provider_state") == "not_started":
                item.update(
                    state="cancelled",
                    cancelled=True,
                    cancelled_at_utc=now,
                    finished_at_utc=now,
                    error=str(reason)[:500],
                )
                cancelled.append(item_id)
        if cancelled:
            self._save()
        return cancelled

    def remove(self, item_id: str) -> None:
        if self._items.pop(str(item_id), None) is not None:
            self._save()

    def list_items(self) -> list[dict[str, Any]]:
        return sorted(
            (copy.deepcopy(item) for item in self._items.values()),
            key=lambda item: (
                utc_to_epoch(item.get("deliver_at_utc"), fallback=float(item.get("due_at", 0.0))),
                utc_to_epoch(item.get("created_at_utc"), fallback=float(item.get("created_at", 0.0))),
            ),
        )

    def list_active(self) -> list[dict[str, Any]]:
        return [item for item in self.list_items() if item.get("state") in ACTIVE_STATES]

    def prune_terminal(self, *, older_than_epoch: float) -> int:
        """Remove old delivery ledger rows without touching user chat history."""
        removed = 0
        for item_id, item in tuple(self._items.items()):
            if item.get("state") not in TERMINAL_STATES:
                continue
            finished = utc_to_epoch(item.get("finished_at_utc"), fallback=0.0)
            if finished and finished < older_than_epoch:
                self._items.pop(item_id, None)
                removed += 1
        if removed:
            self._save()
        return removed

    def _update(self, item_id: str, **changes: Any) -> None:
        item = self._items.get(str(item_id))
        if item is None:
            return
        item.update(changes)
        self._save()

    def _load(self) -> None:
        if not self.path.exists():
            return
        migrated = False
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            version = int(data.get("version", 1)) if isinstance(data, dict) else 1
            items = data.get("items", []) if isinstance(data, dict) else []
            for raw in items:
                if not isinstance(raw, dict) or not raw.get("id") or not raw.get("text"):
                    continue
                item = self._normalize_item(raw, version=version)
                self._items[str(item["request_id"])] = item
                migrated = migrated or version < 2 or item != raw
        except Exception:
            logger.exception("Failed to load pending chat ledger; preserving the damaged file")
            return
        if migrated:
            self._save()

    def _normalize_item(self, raw: dict[str, Any], *, version: int) -> dict[str, Any]:
        item = copy.deepcopy(raw)
        item_id = str(item.get("request_id") or item["id"])
        now = time.time()
        old_state = str(item.get("state", "waiting"))
        state = {"waiting": "queued", "ready": "ready_waiting"}.get(old_state, old_state)
        provider_state = str(item.get("provider_state") or "")
        if not provider_state:
            provider_state = {
                "queued": "not_started",
                "generating": "started",
                "ready_waiting": "completed",
                "delivering": "completed",
            }.get(state, "not_started")

        # STARTED without a persisted result is an uncertain paid side effect.
        # Never turn it back into queued work after a crash.
        if state == "generating" or (provider_state == "started" and not item.get("result")):
            state = "failed_uncertain"
            item["error"] = "provider outcome unknown after restart; request not retried"
            item["finished_at_utc"] = utc_now()
        elif state == "delivering":
            state = "ready_waiting"
        elif state not in ACTIVE_STATES | TERMINAL_STATES:
            state = "failed"
            item["error"] = f"unrecognized persisted state: {old_state}"

        # An active cached reply without a complete identity/model generation
        # cannot be attributed after restart.  Empty fields were v1 wildcards;
        # accepting them could deliver persona A's paid result as persona B.
        # Quarantine malformed v2 rows as well, since hand-edited/truncated
        # ledgers must fail closed rather than recreating the same wildcard.
        try:
            persona_epoch = int(item.get("persona_epoch") or 0)
            model_epoch = int(item.get("model_epoch"))
            model_epoch_present = "model_epoch" in item and model_epoch >= 0
        except (TypeError, ValueError):
            persona_epoch = 0
            model_epoch = 0
            model_epoch_present = False
        scope_complete = bool(
            str(item.get("persona_id") or "").strip()
            and persona_epoch > 0
            and str(item.get("persona_fingerprint") or "").strip()
            and model_epoch_present
            and str(item.get("model_fingerprint") or "").strip()
        )
        if state in ACTIVE_STATES and not scope_complete:
            state = "cancelled"
            item["cancelled"] = True
            item["cancelled_at_utc"] = utc_now()
            item["finished_at_utc"] = item["cancelled_at_utc"]
            item["error"] = "persisted request missing complete persona/model scope; quarantined"

        try:
            created_epoch = float(item.get("created_at", now))
        except (TypeError, ValueError):
            created_epoch = now
        try:
            due_epoch = float(item.get("due_at", created_epoch))
        except (TypeError, ValueError):
            due_epoch = created_epoch
        try:
            indices = sorted({int(value) for value in item.get("delivered_bubble_indices", [])})
        except (TypeError, ValueError):
            indices = []
        item.update(
            id=item_id,
            request_id=item_id,
            delivery_id=str(item.get("delivery_id") or f"delivery_{uuid.uuid4().hex}"),
            conversation_id=str(item.get("conversation_id") or ""),
            persona_id=str(item.get("persona_id") or ""),
            persona_epoch=persona_epoch,
            persona_fingerprint=str(item.get("persona_fingerprint") or ""),
            model_epoch=model_epoch,
            model_fingerprint=str(item.get("model_fingerprint") or ""),
            source=str(item.get("source") or ("legacy" if version < 2 else "user")),
            client_id=str(item.get("client_id") or ""),
            state=state,
            provider_state=provider_state,
            commit_state=(
                "uncertain"
                if str(item.get("commit_state") or "not_started") == "started"
                else str(item.get("commit_state") or "not_started")
            ),
            result=copy.deepcopy(item.get("result")),
            delivered_bubble_indices=indices,
            retraction_state=(
                str(item.get("retraction_state") or "not_started")
                if str(item.get("retraction_state") or "not_started")
                in {"not_started", "started", "completed"}
                else "started"
            ),
            reveal_requested=bool(item.get("reveal_requested", False)),
            cancelled=bool(item.get("cancelled", state == "cancelled")),
            created_at_utc=str(item.get("created_at_utc") or epoch_to_utc(created_epoch)),
            deliver_at_utc=str(item.get("deliver_at_utc") or epoch_to_utc(due_epoch)),
            cancelled_at_utc=item.get("cancelled_at_utc"),
            revealed_at_utc=item.get("revealed_at_utc"),
            finished_at_utc=item.get("finished_at_utc"),
            error=item.get("error"),
            created_at=created_epoch,
            due_at=due_epoch,
        )
        return item

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"version": 2, "storage_policy": "local-first", "items": self.list_items()}
        temp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(self.path)
