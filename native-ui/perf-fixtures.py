"""Seed only registered disposable SQLCipher stores through KernelStore APIs.

The native Qt helper is the key owner. This script accepts its private fd 3;
it has no raw-key argument, key environment value, or plaintext fallback.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from unittest.mock import patch
from uuid import UUID

ROWS = (9, 100, 300)
CONVERSATION = "dream-room"
MAX_HISTORY_BYTES = 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


def encoded(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def exchanges(rows: int) -> list[tuple[str, list[str]]]:
    if rows not in ROWS:
        raise ValueError("fixture row count must be 9, 100 or 300")
    result: list[tuple[str, list[str]]] = []
    remaining = rows
    while remaining:
        count = 2 if remaining in (2, 4) else 3
        index = len(result) + 1
        user = f"合成历史 {index:03d}：今天读到窗边这一段，请把已经确认的事项记在这里。"
        bubbles = [
            f"合成段落 {index:03d}-{bubble + 1}。窗外的光缓慢地移过房间，桌上留着今天的记录。"
            "我们先看眼前的句子，再一件一件核对清单。调整窗口之后，长段落仍然有清楚的顺序，"
            "每一处停顿也都保留自己的位置。\n"
            "Mixed text: the room keeps its place. 中文、English、数字 0123456789、标点和 emoji 🌙 都是固定的测试文本。"
            "读完这一段，可以停一会儿，把尚未确认的部分留到明天继续。"
            for bubble in range(count - 1)
        ]
        result.append((user, bubbles))
        remaining -= count
    assert sum(1 + len(bubbles) for _, bubbles in result) == rows
    return result


def verify_context(context: Path, data: Path) -> None:
    if not context.is_absolute() or not data.is_absolute() or data.resolve() != data:
        raise ValueError("absolute canonical fixture paths required")
    if context.stat().st_size > 16384:
        raise ValueError("invalid isolation context size")
    value = json.loads(context.read_text(encoding="utf-8"))
    if value.get("schema") != "reverie.qt.isolation.v1" or value.get("data", {}).get("path") != str(data):
        raise ValueError("fixture context does not authorize this data directory")
    for name in ("root", "data"):
        expected = value[name]
        target = Path(expected["path"])
        info = target.lstat()
        if (not stat.S_ISDIR(info.st_mode) or target.resolve() != target or info.st_uid != os.getuid()
                or int(expected["uid"]) != info.st_uid or str(info.st_dev) != expected["device"]
                or str(info.st_ino) != expected["inode"]):
            raise ValueError("fixture isolation directory identity changed")
    if data.parent != Path(value["root"]["path"]):
        raise ValueError("fixture data is outside the registered run root")
    current = data
    while current != current.parent:
        if current.is_symlink() or not current.is_dir() or current.suffix.lower() == ".app":
            raise ValueError("unsafe fixture directory chain")
        current = current.parent


def seed(data: Path, rows: int, context: Path, report: Path) -> dict:
    verify_context(context, data)
    if not report.is_absolute() or report.exists() or report.is_symlink():
        raise ValueError("fresh absolute fixture report required")
    if os.environ.get("REVERIE_STORAGE_KEY_FD") != "3" or os.environ.get("REVERIE_REQUIRE_ENCRYPTED_STORAGE") != "1":
        raise ValueError("native private key bootstrap required")
    if not stat.S_ISFIFO(os.fstat(3).st_mode):
        raise ValueError("fixture key descriptor must be an anonymous pipe")
    actual_data = data / "data"
    if os.environ.get("REVERIE_DATA_DIR") not in (None, str(actual_data)):
        raise ValueError("fixture data environment disagrees with context")
    if (actual_data / "runtime" / "kernel.sqlite3").exists() or (actual_data / "persona" / "registry.json").exists():
        raise ValueError("fixture cannot replace existing state")
    os.environ["REVERIE_DATA_DIR"] = str(actual_data)
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    sys.path.insert(0, str(ROOT))
    from src.storage.encrypted_sqlite import initialize_storage_from_environment, SQLITE_HEADER
    initialize_storage_from_environment()
    from src.persona.persona_card import default_persona
    from src.persona.sillytavern_import import initialize_default_persona
    from src.persona.identity import GLOBAL_PERSONA_EPOCH
    from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
    from src.kernel.storage import KernelStore

    persona = default_persona()
    initialize_default_persona(actual_data / "persona", persona)
    token = GLOBAL_PERSONA_EPOCH.activate_initial(persona)
    envelope = GLOBAL_PERSONA_EPOCH.envelope()
    scope = PersonaScopeV4(persona_id=token.persona_id, epoch=token.epoch, fingerprint=token.fingerprint)
    database = actual_data / "runtime" / "kernel.sqlite3"
    database.parent.mkdir(parents=True, exist_ok=True)
    counter = 0
    instant = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def fixture_uuid() -> UUID:
        nonlocal counter
        counter += 1
        return UUID(int=0x10000000000000000000000000000000 + counter)

    # These substitutions are local to this one-shot seed process. Canonical
    # transaction, identity and committed command invariants remain unchanged.
    with patch("src.kernel.storage.uuid4", fixture_uuid), patch("src.kernel.storage._utc_now", lambda: instant.isoformat()):
        store = KernelStore(database)
        try:
            store.activate_persona(scope, identity=envelope.core_identity, identity_version=envelope.version,
                                   actor="bootstrap", reason="isolated synthetic performance fixture")
            for index, (user, bubbles) in enumerate(exchanges(rows)):
                instant = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=index * 2)
                request = CommandEnvelopeV4(request_id=f"perf_seed_{index:04d}", idempotency_key=f"perf_seed_{index:04d}",
                                            command="chat:send", persona=scope, payload={"text": user, "conversation_id": CONVERSATION})
                store.begin_command(request)
                store.mark_provider_dispatched(request.request_id)
                record = store.commit_chat_exchange(request, conversation_id=CONVERSATION, user_text=user,
                                                    assistant_bubbles=bubbles)
                if record.state != "committed" or record.provider_state != "completed":
                    raise ValueError("fixture command did not commit")
            page = store.message_page(CONVERSATION, limit=300, persona_id=scope.persona_id)
            if store.integrity_check() != "ok" or len(page["items"]) != rows or page["has_more"]:
                raise ValueError("fixture history validation failed")
            items = [{"id": item["message_id"], "role": item["role"], "content": item["content"],
                      "request_id": item["request_id"], "conversation_id": CONVERSATION, "persona_id": scope.persona_id,
                      "created_at_utc": item["created_at_utc"], "timestamp_status": "known", "source": item["role"],
                      "proactive_id": None, "delivery_state": item["delivery_state"], "bubble_index": item["bubble_index"],
                      **({"media": []} if item["role"] == "user" else {})} for item in page["items"]]
            history_bytes = len(encoded({"protocol_version": 4, "type": "chat:history:result", "payload": {**page, "items": items}}))
            if history_bytes + 4096 >= MAX_HISTORY_BYTES:
                raise ValueError("fixture history exceeds framed transport budget")
            result = {"schema": "reverie.qt.performance-fixture.v1", "rows": rows, "exchangeCount": len(exchanges(rows)),
                      "conversationId": CONVERSATION, "personaId": scope.persona_id, "messageIds": [item["id"] for item in items],
                      "historySha256": hashlib.sha256(encoded(items)).hexdigest(), "serializedHistoryBytes": history_bytes,
                      "historyFrameLimitBytes": MAX_HISTORY_BYTES, "committed": True, "integrity": "ok", "encrypted": True}
        finally:
            store.close()
    if database.read_bytes()[:16] == SQLITE_HEADER:
        raise ValueError("fixture database unexpectedly has a plaintext header")
    with report.open("x", encoding="utf-8") as output:
        os.chmod(report, 0o600)
        json.dump(result, output, ensure_ascii=False, indent=2)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--rows", type=int, choices=ROWS, required=True)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = seed(args.data_dir, args.rows, args.context, args.report)
    print(json.dumps({"rows": result["rows"], "encrypted": result["encrypted"], "committed": result["committed"]}))


if __name__ == "__main__":
    main()
