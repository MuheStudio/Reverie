import json
from datetime import datetime

import pytest

from src.notifications import NotificationOutbox


ID_A = f"proactive_{'a' * 32}"
ID_B = f"proactive_{'b' * 32}"


def test_notification_outbox_uses_parseable_iso_timestamp(tmp_path) -> None:
    outbox = NotificationOutbox(tmp_path)
    notification_id = outbox.enqueue("记得喝水", event_id=ID_A)
    payload = json.loads((outbox.outbox_dir / f"{notification_id}.json").read_text(encoding="utf-8"))

    parsed = datetime.fromisoformat(payload["created_at"])
    assert parsed.tzinfo is not None
    assert payload["body"] == "记得喝水"
    assert payload["id"] == notification_id


def test_notification_outbox_stable_id_is_idempotent(tmp_path) -> None:
    outbox = NotificationOutbox(tmp_path)
    kwargs = {
        "event_id": ID_B,
        "created_at": "2026-09-01T08:00:00+00:00",
    }

    assert outbox.enqueue("same", **kwargs) == ID_B
    assert outbox.enqueue("same", **kwargs) == ID_B
    assert list(outbox.outbox_dir.glob("*.json")) == [
        outbox.outbox_dir / f"{ID_B}.json"
    ]


def test_notification_outbox_rejects_unsafe_or_conflicting_id(tmp_path) -> None:
    outbox = NotificationOutbox(tmp_path)
    with pytest.raises(ValueError, match="event id"):
        outbox.enqueue("body", event_id="../escape")

    outbox.enqueue(
        "original",
        event_id=ID_A,
        created_at="2026-09-01T08:00:00+00:00",
    )
    with pytest.raises(ValueError, match="reused"):
        outbox.enqueue(
            "changed",
            event_id=ID_A,
            created_at="2026-09-01T08:00:00+00:00",
        )
