"""Atomic local notification outbox consumed by the Electron main process."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config.settings import DATA_DIR


class NotificationOutbox:
    EVENT_ID_PATTERN = re.compile(r"^proactive_[0-9a-f]{32}$")

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
        event_id: str | None = None,
        created_at: str | None = None,
    ) -> str:
        safe_body = str(body).replace("\x00", "").strip()[:500]
        safe_title = str(title).replace("\x00", "").replace("\n", " ").strip()[:80] or "Reverie"
        if not safe_body:
            raise ValueError("Notification body is empty")
        notification_id = str(event_id or "").strip()
        if not self.EVENT_ID_PATTERN.fullmatch(notification_id):
            raise ValueError("Notification event id is invalid")
        payload = {
            "schema": "reverie.notification.v1",
            "id": notification_id,
            "title": safe_title,
            "body": safe_body,
            "category": str(category)[:40],
            "only_when_unfocused": bool(only_when_unfocused),
            "created_at": created_at or datetime.now(timezone.utc).isoformat(),
        }
        destination = self.outbox_dir / f"{notification_id}.json"
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if destination.exists():
            if destination.read_bytes() != encoded:
                raise ValueError("Notification event id was reused with new content")
            return notification_id
        temporary = self.outbox_dir / (
            f".{notification_id}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        )
        try:
            with open(temporary, "xb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary, destination)
            except FileExistsError:
                if destination.read_bytes() != encoded:
                    raise ValueError("Notification event id was reused with new content")
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        return notification_id
