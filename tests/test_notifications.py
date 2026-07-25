import json
from datetime import datetime

from src.notifications import NotificationOutbox


def test_notification_outbox_uses_parseable_iso_timestamp(tmp_path) -> None:
    outbox = NotificationOutbox(tmp_path)
    notification_id = outbox.enqueue("记得喝水")
    payload = json.loads((outbox.outbox_dir / f"{notification_id}.json").read_text(encoding="utf-8"))

    parsed = datetime.fromisoformat(payload["created_at"])
    assert parsed.tzinfo is not None
    assert payload["body"] == "记得喝水"
