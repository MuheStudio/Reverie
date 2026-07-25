import time

from src.chat.pending import PendingChatStore


def test_pending_chat_survives_restart_without_rebilling_generating_state(tmp_path) -> None:
    path = tmp_path / "runtime" / "pending_chat.json"
    store = PendingChatStore(path)
    item_id = store.enqueue("醒来再告诉我", due_at=time.time() + 3600)
    store.mark_generating(item_id)

    restored = PendingChatStore(path)
    items = restored.list_items()

    assert len(items) == 1
    assert items[0]["id"] == item_id
    assert items[0]["state"] == "failed_uncertain"
    assert items[0]["provider_state"] == "started"
    assert "not retried" in items[0]["error"]
    assert items[0]["text"] == "醒来再告诉我"


def test_ready_reply_is_persisted_until_delivery(tmp_path) -> None:
    path = tmp_path / "pending_chat.json"
    store = PendingChatStore(path)
    item_id = store.enqueue("稍后回复", due_at=time.time())
    result = {"messages": ["我回来啦"], "delay": 0, "typing_duration": 0}

    store.mark_ready(item_id, result)
    restored = PendingChatStore(path)

    assert restored.list_items()[0]["result"] == result
    restored.remove(item_id)
    assert PendingChatStore(path).list_items() == []
