"""Product memory proofs and precise HTTP branches; fresh saved fixtures only."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from script.registered_run import preview, preview_v3 as v3, preview_v4 as v4, preview_memory_seed as memory
from script import check_preview_upgrade as producer
from tests.test_registered_run_preview_v4 import value_v4, derive, native_change


def product_value(root, *, probe=False):
    value = value_v4(root)
    report = json.loads(value["observations"]["seed"]["json"])
    core = report["seedProof"]["chat"]
    core["delivery"]["bubble"]["sequence"] = 100
    core["delivery"]["done"]["sequence"] = 101
    core["delivery"]["history"]["sequence"] = 102
    chats, history_rows, request_rows = [], [], []
    for index, text in enumerate(memory.INPUTS):
        chat = deepcopy(core); rid = format(0x100 + index, "032x")
        chat["requestId"] = rid
        for role in ("user", "assistant"):
            row = chat[role]; row.update(id=f"memory-{index}-{role}", request_id=rid)
            if role == "user": row.update(contentSha256=memory.sha(text.encode()), contentBytes=len(text.encode()))
            history_rows.append(memory.item(row))
        scope = chat["delivery"]["scope"]
        scope.update(requestId=rid, conversationId=memory.CONVERSATION, deliveryId="delivery_" + format(0x200 + index, "032x"))
        for kind, delta in [("bubble", 0), ("done", 1)]:
            chat["delivery"][kind].update(scopeSha256=memory.sha(v3.canonical_json(scope)), sequence=10 * (index + 1) + delta)
        history_id = format(0x300 + index, "032x")
        chat["delivery"]["history"].update(requestId=history_id, sequence=10 * (index + 1) + 2)
        chat["delivery"]["beforeMessageIds"] = [f"memory-{n}-{role}" for n in range(index) for role in ("user", "assistant")]
        request_rows.extend([{"command": "chat:send", "requestId": rid, "responseSha256": chat["delivery"]["done"]["responseSha256"]},
                             {"command": "chat:history", "requestId": history_id, "responseSha256": chat["delivery"]["history"]["responseSha256"]}])
        chats.append(chat)
    history = {"count": 6, "items": sorted(history_rows, key=lambda r: r["id"])}
    def record(index, pending=False):
        return {"id": "pending-stable" if pending else f"confirmed-{index}", "kind": "pending" if pending else "confirmed",
                "state": "pending" if pending else "confirmed", "lifecycle": "" if pending else "active",
                "textSha256": memory.sha(("backend actual format: " + memory.MARKERS[index]).encode()), "textBytes": 50,
                "sourceHash": memory.sha((memory.MARKERS[index] if index == 0 else memory.INPUTS[index]).encode()),
                "sourceUri": "reverie-chat://request/" + chats[index]["requestId"]}
    confirmed, pending = [record(0), record(1)], [record(2, True)]
    confirmation = {"requestId": "5" * 32, "responseSha256": "6" * 64, "candidateId": "candidate-confirmed", "memoryId": confirmed[1]["id"]}
    request_rows.append({"command": "memory:candidates:confirm", "requestId": confirmation["requestId"], "responseSha256": confirmation["responseSha256"]})
    reads = {"confirmedRequestId": "7" * 32, "pendingRequestId": "8" * 32, "historyRequestId": "9" * 32}
    for key, command in [("confirmedRequestId", "memory:list"), ("pendingRequestId", "memory:candidates:list"), ("historyRequestId", "chat:history")]:
        request_rows.append({"command": command, "requestId": reads[key], "responseSha256": "a" * 64})
    report["seedProof"]["memory"] = {"contract": "product-chat-v1", "conversationId": memory.CONVERSATION,
        "gate": {"autonomousEnabled": False, "autonomousLlmEnabled": False, "interactionCaptureEnabled": True},
        "chats": chats, "confirmed": confirmed, "pending": pending, "confirmation": confirmation, "history": history, "reads": reads}
    report["schema"] = "reverie.preview.upgrade-host.v2"
    report["requests"] = ([{"command": "provider:test", "requestId": "d" * 32, "responseSha256": "e" * 64}] if probe else []) + request_rows + [row for row in report["requests"] if row["command"] != "memory:store"]
    report["categories"]["memory"] = {"count": 4, "items": sorted([memory.item(r) for r in confirmed + pending + [memory.history_record(history)]], key=lambda r: r["id"])}
    native_change(value["observations"]["seed"], lambda target: target.update(report))
    for binding in (value["observations"]["upgrade"]["readback"], value["observations"]["rollback"]):
        def update(target):
            target["schema"] = report["schema"]; target["categories"] = deepcopy(report["categories"])
            old = target["requests"]; target["requests"] = old[:-2] + [
                {"command": "memory:candidates:list", "requestId": "b" * 32, "responseSha256": "c" * 64},
                {"command": "chat:history", "requestId": format(0x401, "032x"), "responseSha256": "d" * 64}] + old[-2:]
        native_change(binding, update)
    core_rows = value["observations"]["modelRequests"]["rows"]
    if probe:
        probe_row = deepcopy(core_rows[0]); probe_row.update(sequence=1, chat=False, probe=True,
            userSha256=memory.sha(v4.PROBE_PROMPT.encode()), userBytes=len(v4.PROBE_PROMPT.encode()))
        core_rows[0]["sequence"] = 2; core_rows.insert(0, probe_row)
    memory_rows = []
    for index, text in enumerate(memory.INPUTS):
        row = deepcopy(core_rows[-1]); row.update(sequence=index + 1, userSha256=memory.sha(text.encode()), userBytes=len(text.encode()))
        memory_rows.append(row)
    order = ([{"kind": "probe", "index": 1}] if probe else []) + [{"kind": "memory", "index": n + 1} for n in range(3)] + [{"kind": "chat", "index": 2 if probe else 1}]
    order = [{"sequence": i + 1, **r} for i, r in enumerate(order)]
    mock = SimpleNamespace(rows=core_rows, memory_rows=memory_rows, http_order=order, unknown_count=0)
    value["observations"]["modelRequests"] = producer.captured_memory_requests(mock, report)
    return value


@pytest.mark.parametrize("probe", [False, True])
def test_product_memory_proof_has_exact_three_user_bound_model_calls_and_observed_probe_branch(tmp_path, probe):
    value = product_value(tmp_path.resolve(), probe=probe)
    result = derive(value)
    assert result["checks"] == 9 and result["restoreVerified"] and result["rollbackVerified"]
    observed = value["observations"]["modelRequests"]
    assert len(observed["memoryRows"]) == 3 and len(observed["httpOrder"]) == 4 + int(probe)
    assert [row["modelRequests"] for row in observed["memoryBindings"]] == [1, 1, 1]


def test_old_saved_v1_memory_proof_is_still_interpreted_by_original_contract(tmp_path):
    assert derive(value_v4(tmp_path.resolve()))["checks"] == 9


@pytest.mark.parametrize("field,replacement,reason", [
    ("confirmed.0.id", "wrong-id", "PREVIEW_MEMORY_CATEGORY_BINDING"),
    ("confirmed.0.state", "observed", "PREVIEW_MEMORY_RECORD_STATE"),
    ("pending.0.state", "confirmed", "PREVIEW_MEMORY_RECORD_STATE"),
    ("confirmed.0.textSha256", "0" * 64, "PREVIEW_MEMORY_CATEGORY_BINDING"),
    ("pending.0.textSha256", "0" * 64, "PREVIEW_MEMORY_CATEGORY_BINDING"),
    ("confirmation.memoryId", "wrong-id", "PREVIEW_MEMORY_CONFIRMATION_BINDING"),
    ("gate.autonomousLlmEnabled", True, "PREVIEW_MEMORY_GATE"),
    ("chats.1.user.id", "wrong-user", "PREVIEW_MEMORY_HISTORY_IDENTITIES"),
    ("chats.0.assistant.contentBytes", 0, "PREVIEW_V4_SEED_CHAT_MARKER"),
    ("chats.0.delivery.done.degraded", True, "PREVIEW_V4_DELIVERY_CONTENT"),
    ("chats.1.delivery.done.scopeSha256", "0" * 64, "PREVIEW_V4_DELIVERY_CONTENT"),
])
def test_product_memory_rejects_wrong_id_state_content_and_delivery(tmp_path, field, replacement, reason):
    from tests.test_registered_run_preview import replace
    baseline = product_value(tmp_path.resolve()); derive(baseline)
    value = deepcopy(baseline)
    native_change(value["observations"]["seed"], lambda report: replace(report["seedProof"]["memory"], field, replacement))
    with pytest.raises(preview.PreviewError, match=reason): derive(value)


@pytest.mark.parametrize("field,replacement,reason", [
    ("memoryBindings.1.userMessageId", "wrong-user", "PREVIEW_MEMORY_MODEL_USER_ID"),
    ("memoryBindings.1.modelRequests", 2, "PREVIEW_MEMORY_MODEL_USER_ID"),
    ("memoryRows.0.userSha256", "0" * 64, "PREVIEW_MEMORY_MODEL_BINDING"),
    ("memoryRows.0.responseSha256", "0" * 64, "PREVIEW_MEMORY_MODEL_BINDING"),
    ("connectionProbe.requestCount", 1, "PREVIEW_MEMORY_PROBE_BRANCH"),
    ("httpOrder.0.kind", "chat", "PREVIEW_MEMORY_HTTP_EXACT_BRANCH"),
])
def test_product_memory_model_count_and_user_binding_mutations_reject(tmp_path, field, replacement, reason):
    from tests.test_registered_run_preview import replace
    baseline = product_value(tmp_path.resolve()); derive(baseline)
    value = deepcopy(baseline); replace(value["observations"]["modelRequests"], field, replacement)
    with pytest.raises(preview.PreviewError, match=reason): derive(value)


@pytest.mark.parametrize("phase", ["readback", "rollback"])
def test_product_memory_tampering_after_upgrade_or_restore_cannot_pass(tmp_path, phase):
    baseline = product_value(tmp_path.resolve()); derive(baseline); value = deepcopy(baseline)
    binding = value["observations"]["upgrade"][phase] if phase == "readback" else value["observations"][phase]
    native_change(binding, lambda report: report["categories"]["memory"]["items"][0].update(sha256="0" * 64))
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_DATA_CHANGED"): derive(value)


def test_product_memory_driver_uses_only_product_apis_and_versioned_report():
    root = Path(__file__).resolve().parents[1]
    driver = (root / "native-ui/tests/PreviewUpgradeCheck.cpp").read_text()
    helper = (root / "native-ui/tests/PreviewUpgradeMemory.h").read_text()
    assert 'backend.call("memory:store"' not in driver + helper
    assert all(value in helper for value in memory.INPUTS)
    assert '"memory:candidates:confirm"' in helper and '"memory:candidates:list"' in helper
    assert '"schema", "reverie.preview.upgrade-host.v2"' in driver
