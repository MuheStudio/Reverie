"""Versioned, saved-only product memory seeding proof. No live data access."""
import hashlib

from . import preview as base, preview_v3 as v3

CONVERSATION = "w5-memory-seed"
INPUTS = ("记住：W5 isolated durable memory marker", "我喜欢 W5 isolated candidate confirmed tea", "我喜欢 W5 isolated candidate pending river")
MARKERS = ("W5 isolated durable memory marker", "W5 isolated candidate confirmed tea", "W5 isolated candidate pending river")
FIELDS = ("id", "kind", "state", "textSha256", "textBytes", "sourceHash", "sourceUri", "lifecycle")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def item(record):
    return {"id": record["id"], "sha256": sha(v3.canonical_json({k: v for k, v in record.items() if k != "id"}))}


def history_record(history):
    payload = v3.canonical_json(history)
    return {"id": "memory-history:w5-memory-seed", "kind": "history", "state": "persisted", "lifecycle": "",
            "textSha256": sha(payload), "textBytes": len(payload), "sourceHash": sha(payload),
            "sourceUri": "reverie-chat://conversation/" + CONVERSATION}


def proof(report, *, chat_validator):
    from . import preview_v4 as v4
    memory = report["seedProof"]["memory"]
    base._keys(memory, ("contract", "conversationId", "gate", "chats", "confirmed", "pending", "confirmation", "history", "reads"), "PREVIEW_MEMORY_FIELDS")
    base.need(memory["contract"] == "product-chat-v1" and memory["conversationId"] == CONVERSATION and
              isinstance(memory["gate"], dict) and all(type(v) is bool for v in memory["gate"].values()) and memory["gate"] ==
              {"autonomousEnabled": False, "autonomousLlmEnabled": False, "interactionCaptureEnabled": True}, "PREVIEW_MEMORY_GATE")
    chats = memory["chats"]
    base.need(isinstance(chats, list) and len(chats) == 3, "PREVIEW_MEMORY_CHAT_COUNT")
    rows = report["requests"]
    base.need(not any(r["command"] == "memory:store" for r in rows), "PREVIEW_MEMORY_LEGACY_WRITE")
    ids = [chat.get("requestId") for chat in chats]
    core = report["seedProof"]["chat"]["requestId"]
    base.need(len(set(ids + [core])) == 4 and [r["requestId"] for r in rows if r["command"] == "chat:send"] == ids + [core], "PREVIEW_MEMORY_CHAT_REQUESTS")
    history = memory["history"]
    base._keys(history, ("count", "items"), "PREVIEW_MEMORY_HISTORY")
    base.need(history["count"] == 6 and isinstance(history["items"], list) and len(history["items"]) == 6, "PREVIEW_MEMORY_HISTORY")
    history_items, last_sequence, message_ids = [], 0, []
    for index, chat in enumerate(chats):
        # Only select the two actual records for this turn. Full membership,
        # no extras and aggregate persistence are checked below.
        actual = [item(chat[role]) for role in ("user", "assistant")]
        view = {**report, "requests": [r for r in rows if r["command"] != "chat:send" or r["requestId"] == ids[index]],
                "categories": {**report["categories"], "chat": {"count": 2, "items": sorted(actual, key=lambda r: r["id"])}}}
        chat_validator(view, chat, report["seedProof"]["settings"]["llm"], user_marker=INPUTS[index], conversation=CONVERSATION)
        base.need(chat["delivery"]["bubble"]["sequence"] > last_sequence, "PREVIEW_MEMORY_DELIVERY_ORDER")
        last_sequence = chat["delivery"]["history"]["sequence"]
        history_items.extend(actual); message_ids.extend(chat[role]["id"] for role in ("user", "assistant"))
    base.need(len(set(message_ids)) == 6 and history["items"] == sorted(history_items, key=lambda r: r["id"]), "PREVIEW_MEMORY_HISTORY_IDENTITIES")
    confirmed, pending = memory["confirmed"], memory["pending"]
    base.need(isinstance(confirmed, list) and len(confirmed) == 2 and isinstance(pending, list) and len(pending) == 1, "PREVIEW_MEMORY_RECORD_COUNTS")
    indexed = {}
    for record in confirmed + pending:
        base._keys(record, FIELDS, "PREVIEW_MEMORY_RECORD_FIELDS")
        base.need(isinstance(record["id"], str) and record["id"] and record["id"] not in indexed and
                  base._sha(record["textSha256"]) and base._integer(record["textBytes"], 1), "PREVIEW_MEMORY_RECORD_ID_OR_TEXT")
        expected_state = "confirmed" if record in confirmed else "pending"
        base.need(record["kind"] == record["state"] == expected_state and record["lifecycle"] == ("active" if expected_state == "confirmed" else ""), "PREVIEW_MEMORY_RECORD_STATE")
        indexed[record["id"]] = record
    expected_sources = [(sha(MARKERS[0].encode()), chats[0]["requestId"]), (sha(INPUTS[1].encode()), chats[1]["requestId"])]
    base.need(sorted((r["sourceHash"], r["sourceUri"]) for r in confirmed) ==
              sorted((h, "reverie-chat://request/" + rid) for h, rid in expected_sources), "PREVIEW_MEMORY_CONFIRMED_SOURCE")
    base.need(pending[0]["sourceHash"] == sha(INPUTS[2].encode()) and pending[0]["sourceUri"] == "reverie-chat://request/" + chats[2]["requestId"], "PREVIEW_MEMORY_PENDING_SOURCE")
    confirmation = memory["confirmation"]
    base._keys(confirmation, ("requestId", "responseSha256", "candidateId", "memoryId"), "PREVIEW_MEMORY_CONFIRMATION")
    base.need(confirmation["memoryId"] in indexed and confirmation["memoryId"] in {r["id"] for r in confirmed} and
              indexed[confirmation["memoryId"]]["sourceHash"] == sha(INPUTS[1].encode()) and
              isinstance(confirmation["candidateId"], str) and confirmation["candidateId"] and confirmation["candidateId"] != pending[0]["id"] and
              any(r == {"command": "memory:candidates:confirm", "requestId": confirmation["requestId"], "responseSha256": confirmation["responseSha256"]} for r in rows), "PREVIEW_MEMORY_CONFIRMATION_BINDING")
    base._keys(memory["reads"], ("confirmedRequestId", "pendingRequestId", "historyRequestId"), "PREVIEW_MEMORY_READS")
    for key, command in [("confirmedRequestId", "memory:list"), ("pendingRequestId", "memory:candidates:list"), ("historyRequestId", "chat:history")]:
        base.need(any(r["command"] == command and r["requestId"] == memory["reads"][key] for r in rows), "PREVIEW_MEMORY_READ_BINDING")
    expected = sorted([item(r) for r in confirmed + pending + [history_record(history)]], key=lambda r: r["id"])
    base.need(report["categories"]["memory"] == {"count": 4, "items": expected}, "PREVIEW_MEMORY_CATEGORY_BINDING")


def model_requests(value, report):
    from . import preview_v4 as v4
    base._keys(value, ("rows", "chatRequestIds", "unknownCount", "memoryRows", "memoryBindings", "httpOrder", "connectionProbe"), "PREVIEW_MEMORY_MODEL_FIELDS")
    core = {k: value[k] for k in ("rows", "chatRequestIds", "unknownCount")}
    v4.model_requests(core, report["seedProof"]["chat"])
    chats = report["seedProof"]["memory"]["chats"]
    rows = value["memoryRows"]
    base.need(isinstance(rows, list) and len(rows) == 3 and len(value["memoryBindings"]) == 3, "PREVIEW_MEMORY_MODEL_COUNT")
    for index, (row, chat) in enumerate(zip(rows, chats)):
        # Same wire/response digest checks as the original single chat; only
        # this approved memory prompt differs. Never mutate module constants.
        base._keys(row, tuple(core["rows"][0]), "PREVIEW_MEMORY_MODEL_ROW_FIELDS")
        base.need(type(row["sequence"]) is int and row["sequence"] == index + 1 and row["chat"] is True and row["probe"] is False and
                  base._sha(row["requestSha256"]) and base._integer(row["requestBytes"], 1) and row["statusCode"] == 200 and
                  row["userSha256"] == chat["user"]["contentSha256"] == sha(INPUTS[index].encode()) and
                  row["userBytes"] == chat["user"]["contentBytes"] == len(INPUTS[index].encode()) and
                  row["modelSha256"] == sha(v4.MODEL.encode()) and row["responseSha256"] == sha(v4.mock_response_bytes()) and
                  row["responseBytes"] == len(v4.mock_response_bytes()) and row["responseTextSha256"] == sha(v4.ASSISTANT_MARKER.encode()) and
                  row["responseTextBytes"] == len(v4.ASSISTANT_MARKER.encode()), "PREVIEW_MEMORY_MODEL_BINDING")
        base.need(type(value["memoryBindings"][index].get("modelRequests")) is int and value["memoryBindings"][index] == {"requestId": chat["requestId"], "userMessageId": chat["user"]["id"], "modelRequests": 1}, "PREVIEW_MEMORY_MODEL_USER_ID")
    probes = [r for r in core["rows"] if r["probe"]]
    probe_count = len(probes)
    base._keys(value["connectionProbe"], ("requestCount", "condition"), "PREVIEW_MEMORY_PROBE_BRANCH")
    tests = [r for r in report["requests"] if r["command"] == "provider:test"]
    base.need(type(value["connectionProbe"]["requestCount"]) is int and probe_count == len(tests) and probe_count in (0, 1) and
              value["connectionProbe"] == {"requestCount": probe_count, "condition": "provider-test-issued-probe" if probe_count else "no-provider-test-command"}, "PREVIEW_MEMORY_PROBE_BRANCH")
    expected = ([{"kind": "probe", "index": 1}] if probe_count else []) + [
        {"kind": "memory", "index": i + 1} for i in range(3)] + [{"kind": "chat", "index": 1 + probe_count}]
    expected = [{"sequence": i + 1, **row} for i, row in enumerate(expected)]
    base.need(value["httpOrder"] == expected and len(value["httpOrder"]) == 4 + probe_count, "PREVIEW_MEMORY_HTTP_EXACT_BRANCH")
