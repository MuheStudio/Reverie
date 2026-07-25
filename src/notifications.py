"""Atomic local notification outbox consumed by the Electron main process."""

from __future__ import annotations

import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config.settings import DATA_DIR


class NotificationOutbox:
    def __init__(self, data_dir: Path | None = None) -> None:
        self.outbox_dir = (data_dir or DATA_DIR) / "notifications" / "outbox"
        self.outbox_dir.mkdir(parents=True, exist_ok=True)

    def enqueue(
        self,
        body: str,
        *,
        title: str = "Reverie",
        category: str = "care",
        only_when_unfocused: bool = True,
    ) -> str:
        safe_body = str(body).replace("\x00", "").strip()[:500]
        safe_title = str(title).replace("\x00", "").replace("\n", " ").strip()[:80] or "Reverie"
        if not safe_body:
            raise ValueError("Notification body is empty")
        notification_id = f"{time.time_ns()}-{uuid.uuid4().hex[:12]}"
        payload = {
            "schema": "reverie.notification.v1",
            "id": notification_id,
            "title": safe_title,
            "body": safe_body,
            "category": str(category)[:40],
            "only_when_unfocused": bool(only_when_unfocused),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        destination = self.outbox_dir / f"{notification_id}.json"
        temporary = destination.with_suffix(".tmp")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with open(temporary, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        return notification_id
