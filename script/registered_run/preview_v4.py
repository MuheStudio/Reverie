"""Saved-only upgrade/restore proof. Never probes an installed runtime on replay.

The previous release is frozen by the public formal result and by copies of its
runtime metadata/manifest. The old native host is deliberately not executed.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

from . import preview as base
from . import preview_v3 as v3

VERSION = "v4"
TIMEOUT_SECONDS = 1200
SELECTION = ("version-upgrade", "snapshot-restore", "format-protection", "sanitized-diagnostics")
CHECKS = (*base.CHECKS, *((name, name) for name in SELECTION))
CATEGORIES = ("chat", "persona", "memory", "worldbook", "settings", "avatar")
PREVIOUS_RESULTS = {
    "docs/evidence/preview-m1-formal-r1-20261102.json": {
        "schema": "reverie.preview.m1.formal.r1.result.v1", "buildSource": "adoption",
    },
    "docs/evidence/preview-m2-formal-r2-20261104.json": {
        "schema": "reverie.preview.m2.formal.r2.result.v1", "buildSource": "artifacts",
    },
    "docs/evidence/preview-m3-formal-r1-20261107.json": {
        "schema": "reverie.preview.m3.formal.r1.result.v1", "buildSource": "artifacts",
    },
    "docs/evidence/preview-m4-formal-r1-20261110.json": {
        "schema": "reverie.preview.m4.formal.r1.result.v1", "buildSource": "artifacts",
    },
    "docs/evidence/preview-m5-formal-r2-20261111.json": {
        "schema": "reverie.preview.m5.formal.r2.result.v1", "buildSource": "artifacts",
    },
    "docs/evidence/preview-m6-formal-r1-20261117.json": {
        "schema": "reverie.preview.m6.formal.r1.result.v1", "buildSource": "artifacts",
    },
}
# Historical M1 through M5 bindings remain readable. New runs bind M6.
PUBLIC_RESULT = "docs/evidence/preview-m6-formal-r1-20261117.json"
INPUT_COPIES = {"evidence": "previous-formal-result.json", "runtimeMetadata": "previous-runtime-metadata.json",
                "runtimeManifest": "previous-runtime-manifest.json"}
PERSONA_NAME = "W5 isolated persona"
PERSONA_DESCRIPTION = "Synthetic preview upgrade character, age 24.\n\nCalm\n\nIsolated upgrade fixture"
MEMORY_MARKER = "W5 isolated durable memory marker"
USER_MARKER = "W5 isolated upgrade conversation marker /forget-this"
ASSISTANT_MARKER = "W5 isolated durable assistant reply."
MODEL = "reverie-preview-upgrade"
PROBE_PROMPT = "Reply with a short confirmation that this connection works."


def mock_response_bytes():
    # Deliberately unchanged: no per-request nonce or extra marker is injected.
    return json.dumps({"id": "w5-isolated-reply", "object": "chat.completion", "choices": [
        {"index": 0, "message": {"role": "assistant", "content": ASSISTANT_MARKER}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 8, "completion_tokens": 8, "total_tokens": 16}}).encode()


def model_requests(value, chat):
    base._keys(value, ("rows", "chatRequestIds", "unknownCount"), "PREVIEW_V4_MODEL_REQUEST_FIELDS")
    base.need(type(value["unknownCount"]) is int and value["unknownCount"] == 0, "PREVIEW_V4_UNKNOWN_MODEL_REQUEST")
    rows = value["rows"]
    base.need(isinstance(rows, list) and 1 <= len(rows) <= 2 and
              [row.get("sequence") for row in rows] == list(range(1, len(rows) + 1)), "PREVIEW_V4_MODEL_ORDER")
    chats, probes = [], []
    for row in rows:
        base._keys(row, ("sequence", "chat", "probe", "requestSha256", "requestBytes", "responseSha256", "responseBytes", "userSha256", "userBytes",
                         "modelSha256", "responseTextSha256", "responseTextBytes", "statusCode"), "PREVIEW_V4_MODEL_ROW_FIELDS")
        base.need(base._integer(row["sequence"], 1) and type(row["chat"]) is bool and type(row["probe"]) is bool and row["chat"] != row["probe"], "PREVIEW_V4_UNKNOWN_MODEL_REQUEST")
        expected = USER_MARKER if row["chat"] else PROBE_PROMPT
        base.need(base._sha(row["requestSha256"]) and base._integer(row["requestBytes"], 1) and
                  row["userSha256"] == sha(expected.encode()) and row["userBytes"] == len(expected.encode()) and row["modelSha256"] == sha(MODEL.encode()) and
                  row["responseSha256"] == sha(mock_response_bytes()) and row["responseBytes"] == len(mock_response_bytes()) and row["statusCode"] == 200 and
                  row["responseTextSha256"] == sha(ASSISTANT_MARKER.encode()) and row["responseTextBytes"] == len(ASSISTANT_MARKER.encode()), "PREVIEW_V4_MODEL_DIGEST")
        (chats if row["chat"] else probes).append(row)
    base.need(len(chats) == 1 and len(probes) <= 1 and rows[-1] == chats[0] and
              value["chatRequestIds"] == [chat["requestId"]], "PREVIEW_V4_MODEL_CHAT_BIJECTION")


def seed_card():
    return {"spec": "chara_card_v2", "spec_version": "2.0", "data": {
        "name": PERSONA_NAME, "description": "Synthetic preview upgrade character, age 24.", "personality": "Calm",
        "scenario": "Isolated upgrade fixture", "first_mes": "Hello", "mes_example": "", "creator_notes": "",
        "system_prompt": "", "post_history_instructions": "", "alternate_greetings": [], "tags": [], "creator": "",
        "character_version": "", "extensions": {}}}


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def reference(value):
    base._keys(value, ("path", "bytes", "sha256"), "PREVIEW_V4_INPUT_REFERENCE")
    base._relative(value["path"])
    base.need(base._integer(value["bytes"], 1) and base._sha(value["sha256"]), "PREVIEW_V4_INPUT_REFERENCE")


def previous_binding(value):
    base._keys(value, ("evidence", "runtimeRoot", "runtimeMetadata", "runtimeManifest", "candidate", "sourceHead",
                       "buildManifestSha256", "model"), "PREVIEW_V4_PREVIOUS_FIELDS")
    for role in INPUT_COPIES:
        reference(value[role])
    v3.identity({key: value[key] for key in ("candidate", "sourceHead", "buildManifestSha256")})
    base.need(value["evidence"]["path"] in PREVIOUS_RESULTS and
              value["runtimeRoot"] == ".tools/preview-runtime/" + value["candidate"] and
              value["runtimeMetadata"]["path"] == value["runtimeRoot"] + "/preview-runtime.json" and
              value["runtimeManifest"]["path"] == value["runtimeRoot"] + "/preview-manifest.json",
              "PREVIEW_V4_PREVIOUS_PATHS")
    base._relative(value["model"])
    base.need(value["model"].startswith(".tools/live2d/"), "PREVIEW_V4_MODEL_SCOPE")
    return value


def _previous_build_sha(public, result_path):
    rule = PREVIOUS_RESULTS[result_path]
    if rule["buildSource"] == "adoption":
        return public.get("adoption", {}).get("build", {}).get("sha256")
    artifacts = public.get("artifacts")
    expected = ".tools/qt-candidates/" + str(public.get("adoption", {}).get("candidate")) + "/build.json"
    base.need(isinstance(artifacts, list), "PREVIEW_V4_FORMAL_IDENTITY")
    matches = [row for row in artifacts if isinstance(row, dict) and row.get("path") == expected]
    base.need(len(matches) == 1 and base._sha(matches[0].get("sha256")), "PREVIEW_V4_FORMAL_IDENTITY")
    return matches[0]["sha256"]


def _validate_previous_documents(binding, documents):
    from .state import load_json_bytes
    values = {}
    for role, payload in documents.items():
        expected = binding[role]
        base.need(len(payload) == expected["bytes"] and sha(payload) == expected["sha256"], "PREVIEW_V4_PREVIOUS_BYTES")
        values[role] = load_json_bytes(payload)
    public, metadata = values["evidence"], values["runtimeMetadata"]
    rule = PREVIOUS_RESULTS[binding["evidence"]["path"]]
    public_build_sha = _previous_build_sha(public, binding["evidence"]["path"])
    base.need(public.get("schema") == rule["schema"] and
              public.get("overallPassed") is True and public.get("formalAcceptance") is True and
              public.get("sourceHead") == binding["sourceHead"] and
              public.get("adoption", {}).get("candidate") == binding["candidate"] and
              public_build_sha == binding["buildManifestSha256"] and
              (rule["buildSource"] != "artifacts" or public_build_sha == metadata.get("buildManifestSha256")),
              "PREVIEW_V4_FORMAL_IDENTITY")
    base.need(metadata.get("schema") == "reverie.qt.preview-runtime.v1" and
              metadata.get("installation", {}).get("kind") == "adopted" and
              all(metadata.get(key) == binding[key] for key in ("candidate", "sourceHead", "buildManifestSha256")) and
              metadata.get("manifestSha256") == binding["runtimeManifest"]["sha256"] and
              metadata.get("hostExecutable") == "candidate/Reverie Scene.app/Contents/MacOS/Reverie Scene" and
              metadata.get("python") == ".venv/bin/python" and metadata.get("node") == ".tools/node/bin/node",
              "PREVIEW_V4_RUNTIME_IDENTITY")
    manifest = values["runtimeManifest"]
    base.need(manifest.get("schema") == "reverie.qt.preview-manifest.v1" and isinstance(manifest.get("entries"), list) and
              any(row.get("path") == "src/main.py" for row in manifest["entries"]) and
              any(row.get("path") == "native-ui/avatar-host.cjs" for row in manifest["entries"]),
              "PREVIEW_V4_RUNTIME_SOURCES")


def bind_previous(root, model=".tools/live2d/yumi-local-validation/原模型测试 副本"):
    """Read input files only; callers freeze the returned exact references."""
    root = Path(root)
    from .state import load_json_bytes
    evidence = base._read_json(root / PUBLIC_RESULT, 32 * 1024 * 1024)[1]
    public = load_json_bytes(evidence)
    candidate = public.get("adoption", {}).get("candidate")
    base.need(isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", candidate), "PREVIEW_V4_FORMAL_CANDIDATE")
    runtime = ".tools/preview-runtime/" + candidate
    metadata = base._read_json(root / runtime / "preview-runtime.json", 65536)[1]
    manifest = base._read_json(root / runtime / "preview-manifest.json", 32 * 1024 * 1024)[1]
    documents = {"evidence": evidence, "runtimeMetadata": metadata, "runtimeManifest": manifest}
    paths = {"evidence": PUBLIC_RESULT, "runtimeMetadata": runtime + "/preview-runtime.json", "runtimeManifest": runtime + "/preview-manifest.json"}
    result = {role: {"path": paths[role], "bytes": len(payload), "sha256": sha(payload)} for role, payload in documents.items()}
    result.update(runtimeRoot=runtime, candidate=candidate, sourceHead=public.get("sourceHead"),
                  buildManifestSha256=_previous_build_sha(public, PUBLIC_RESULT), model=model)
    previous_binding(result)
    _validate_previous_documents(result, documents)
    return result


def verify_saved_inputs(directory, binding):
    previous_binding(binding)
    documents = {role: base._read_json(Path(directory) / name, 32 * 1024 * 1024)[1]
                 for role, name in INPUT_COPIES.items()}
    _validate_previous_documents(binding, documents)
    return [{"path": name, "sha256": binding[role]["sha256"], "bytes": binding[role]["bytes"]}
            for role, name in INPUT_COPIES.items()]


def categories(value):
    base._keys(value, CATEGORIES, "PREVIEW_V4_CATEGORY_SET")
    for role in CATEGORIES:
        category = value[role]
        base._keys(category, ("count", "items"), "PREVIEW_V4_CATEGORY_FIELDS")
        items = category["items"]
        base.need(isinstance(items, list) and base._integer(category["count"], 1) and
                  category["count"] == len(items) <= 50000, "PREVIEW_V4_CATEGORY_COUNT")
        ids = []
        for item in items:
            base._keys(item, ("id", "sha256"), "PREVIEW_V4_CATEGORY_ITEM")
            base.need(isinstance(item["id"], str) and 0 < len(item["id"]) <= 1024 and
                      not any(c in item["id"] for c in "\0\r\n") and base._sha(item["sha256"]), "PREVIEW_V4_CATEGORY_ITEM")
            ids.append(item["id"])
        base.need(ids == sorted(set(ids)), "PREVIEW_V4_CATEGORY_IDENTITIES")
    return value


def workspace_inventory(value):
    base._keys(value, ("files", "directories", "totalBytes"), "PREVIEW_V4_WORKSPACE_INVENTORY")
    base.need(isinstance(value["files"], list) and isinstance(value["directories"], list) and
              len(value["files"]) + len(value["directories"]) <= 50000, "PREVIEW_V4_WORKSPACE_INVENTORY_LIMIT")
    directories = value["directories"]
    base.need(len(directories) == len(set(directories)), "PREVIEW_V4_WORKSPACE_DUPLICATE")
    for path in directories:
        base._relative(path)
    paths, total = [], 0
    for row in value["files"]:
        base._keys(row, ("path", "size", "sha256"), "PREVIEW_V4_WORKSPACE_FILE")
        base._relative(row["path"])
        base.need(row["path"] not in ("workspace.lock", "preview-events.jsonl") and base._sha(row["sha256"]), "PREVIEW_V4_WORKSPACE_FILE")
        paths.append(row["path"]); total += v3._decimal(row["size"], "PREVIEW_V4_WORKSPACE_SIZE")
    base.need(len(paths) == len(set(paths)) and not set(paths).intersection(directories) and
              total == v3._decimal(value["totalBytes"], "PREVIEW_V4_WORKSPACE_SIZE"), "PREVIEW_V4_WORKSPACE_INVENTORY")
    return {"files": sorted(value["files"], key=lambda row: row["path"]), "directories": sorted(directories), "totalBytes": str(total)}


def chat_proof(report, chat, llm, *, user_marker=USER_MARKER, conversation="dream-room"):
    """The original delivered-chat contract, also used for each new memory turn."""
    data = report["categories"]
    def linked(role, record):
        digest = sha(v3.canonical_json({key: value for key, value in record.items() if key != "id"}))
        base.need({"id": record["id"], "sha256": digest} in data[role]["items"], "PREVIEW_V4_SEED_CATEGORY_BINDING")
    base._keys(chat, ("requestId", "user", "assistant", "delivery"), "PREVIEW_V4_SEED_CHAT_FIELDS")
    base.need(base._sha(chat["requestId"], 32) and
              [row["requestId"] for row in report["requests"] if row["command"] == "chat:send"] == [chat["requestId"]],
              "PREVIEW_V4_SEED_CHAT_REQUEST")
    for role in ("user", "assistant"):
        record = chat[role]
        base._keys(record, ("id", "role", "contentSha256", "contentBytes", "request_id", "persona_id", "bubble_index"), "PREVIEW_V4_SEED_CHAT_RECORD")
        base.need(record["role"] == role and base._sha(record["contentSha256"]) and base._integer(record["contentBytes"], 1) and
                  record["request_id"] == chat["requestId"] and type(record["bubble_index"]) is int and record["bubble_index"] == 0 and
                  isinstance(record["persona_id"], str) and record["persona_id"] and
                  (role != "user" or (record["contentSha256"] == sha(user_marker.encode()) and record["contentBytes"] == len(user_marker.encode()))),
                  "PREVIEW_V4_SEED_CHAT_MARKER")
        linked("chat", record)
    base.need(chat["user"]["id"] != chat["assistant"]["id"] and
              chat["user"]["persona_id"] == chat["assistant"]["persona_id"] and data["chat"]["count"] == 2 and
              {row["id"] for row in data["chat"]["items"]} == {chat["user"]["id"], chat["assistant"]["id"]}, "PREVIEW_V4_SEED_CHAT_IDENTITY")
    delivery = chat["delivery"]
    base._keys(delivery, ("scope", "ownerPersona", "ownerModel", "bubble", "done", "history", "beforeMessageIds", "marker"), "PREVIEW_V4_DELIVERY_FIELDS")
    scope, owner, model = delivery["scope"], delivery["ownerPersona"], delivery["ownerModel"]
    base._keys(scope, ("requestId", "deliveryId", "conversationId", "personaId", "personaEpoch", "personaFingerprint", "modelEpoch", "modelFingerprint"), "PREVIEW_V4_DELIVERY_SCOPE_FIELDS")
    base._keys(owner, ("persona_id", "epoch", "fingerprint"), "PREVIEW_V4_DELIVERY_OWNER_FIELDS")
    base._keys(model, ("epoch", "fingerprint"), "PREVIEW_V4_DELIVERY_MODEL_FIELDS")
    model_fingerprint = sha("\0".join(str(llm[key]) for key in ("provider", "model", "base_url")).encode())[:24]
    base.need(scope["requestId"] == chat["requestId"] and scope["conversationId"] == conversation and
              isinstance(scope["deliveryId"], str) and re.fullmatch(r"delivery_[0-9a-f]{32}", scope["deliveryId"]) is not None and
              scope["personaId"] == owner["persona_id"] == chat["user"]["persona_id"] and
              base._integer(owner["epoch"], 1) and base._sha(owner["fingerprint"]) and
              base._integer(scope["personaEpoch"], 1) and base._integer(scope["modelEpoch"]) and
              scope["personaEpoch"] == owner["epoch"] and scope["personaFingerprint"] == owner["fingerprint"] and
              base._integer(model["epoch"]) and scope["modelEpoch"] == model["epoch"] and
              scope["modelFingerprint"] == model["fingerprint"] == model_fingerprint, "PREVIEW_V4_DELIVERY_SCOPE")
    bubble, done, history = delivery["bubble"], delivery["done"], delivery["history"]
    base._keys(bubble, ("scopeSha256", "sequence", "index", "total", "displaySha256", "displayBytes"), "PREVIEW_V4_BUBBLE_FIELDS")
    base._keys(done, ("scopeSha256", "sequence", "responseSha256", "displaySha256", "displayBytes", "cleanSha256", "cleanBytes", "cleanCount", "displayCount",
                     "stateDone", "incremental", "degraded", "markerInDisplay", "markerInClean"), "PREVIEW_V4_DONE_FIELDS")
    base._keys(history, ("requestId", "responseSha256", "sequence"), "PREVIEW_V4_HISTORY_FIELDS")
    scope_sha = sha(v3.canonical_json(scope))
    base.need(bubble["scopeSha256"] == done["scopeSha256"] == scope_sha and type(bubble["index"]) is int and bubble["index"] == 0 and
              type(bubble["total"]) is int and bubble["total"] == 1 and
              type(done["cleanCount"]) is int and type(done["displayCount"]) is int and done["cleanCount"] == done["displayCount"] == 1 and
              done["stateDone"] is True and done["incremental"] is True and done["degraded"] is False and
              done["markerInDisplay"] is True and done["markerInClean"] is True and base._sha(bubble["displaySha256"]) and
              base._integer(bubble["displayBytes"], 1) and done["displaySha256"] == bubble["displaySha256"] and done["displayBytes"] == bubble["displayBytes"] and
              done["cleanSha256"] == chat["assistant"]["contentSha256"] and done["cleanBytes"] == chat["assistant"]["contentBytes"], "PREVIEW_V4_DELIVERY_CONTENT")
    base.need(all(base._integer(row["sequence"], 1) for row in (bubble, done, history)) and
              bubble["sequence"] < done["sequence"] < history["sequence"], "PREVIEW_V4_DELIVERY_ORDER")
    prior = delivery["beforeMessageIds"]
    base.need(isinstance(prior, list) and all(isinstance(value, str) and value for value in prior) and len(prior) == len(set(prior)) and
              chat["user"]["id"] not in prior and chat["assistant"]["id"] not in prior, "PREVIEW_V4_DELIVERY_OLD_MESSAGE")
    base.need(base._sha(done["responseSha256"]) and
              [row["responseSha256"] for row in report["requests"] if row["command"] == "chat:send"] == [done["responseSha256"]] and
              any(row["command"] == "chat:history" and row["requestId"] == history["requestId"] and row["responseSha256"] == history["responseSha256"]
                  for row in report["requests"]), "PREVIEW_V4_DELIVERY_RECEIPTS")
    base.need(delivery["marker"] == {"sha256": sha(b"W5"), "bytes": 2, "unique": False, "inUser": True, "inMock": True}, "PREVIEW_V4_MARKER_SCOPE")


def seed_proof(report):
    """Require the intended seeded records, rather than six unrelated nonempty lists."""
    proof, data = report["seedProof"], report["categories"]
    base._keys(proof, CATEGORIES, "PREVIEW_V4_SEED_PROOF_FIELDS")

    def linked(role, record):
        base.need(isinstance(record, dict) and isinstance(record.get("id"), str), "PREVIEW_V4_SEED_RECORD")
        digest = sha(v3.canonical_json({key: value for key, value in record.items() if key != "id"}))
        base.need({"id": record["id"], "sha256": digest} in data[role]["items"], "PREVIEW_V4_SEED_CATEGORY_BINDING")

    persona = proof["persona"]
    base._keys(persona, ("id", "name", "source_format", "active", "profile"), "PREVIEW_V4_SEED_PERSONA_FIELDS")
    content = persona["profile"]
    base._keys(content, ("fields", "identity_version", "identity_fingerprint"), "PREVIEW_V4_SEED_PERSONA_CONTENT")
    base.need(persona["id"] == "st_" + sha(v3.canonical_json(seed_card()))[:20] and persona["name"] == PERSONA_NAME and
              persona["source_format"] == "chara_card_v2" and persona["active"] is False and
              type(content["identity_version"]) is int and content["identity_version"] == 1 and base._sha(content["identity_fingerprint"]) and
              content["fields"].get("description") == PERSONA_DESCRIPTION and content["fields"].get("first_message") == "Hello",
              "PREVIEW_V4_SEED_PERSONA_MARKER")
    linked("persona", persona)
    if report["schema"] == "reverie.preview.upgrade-host.v1":
        memory = proof["memory"]
        base._keys(memory, ("id", "text"), "PREVIEW_V4_SEED_MEMORY_FIELDS")
        base.need(memory["text"] == MEMORY_MARKER, "PREVIEW_V4_SEED_MEMORY_MARKER")
        # Match the old production API's exact permanent-memory normalization;
        # the input/proof marker stays logical and the category remains raw bytes.
        linked("memory", {"id": memory["id"], "text": "Precious memory: " + memory["text"]})
    core_view = report
    if report["schema"] == "reverie.preview.upgrade-host.v2":
        from . import preview_memory_seed as memory_seed
        memory_seed.proof(report, chat_validator=chat_proof)
        memory_ids = {row["requestId"] for row in proof["memory"]["chats"]}
        core_view = {**report, "requests": [row for row in report["requests"] if row["requestId"] not in memory_ids]}
    chat_proof(core_view, proof["chat"], proof["settings"]["llm"])
    worldbook = proof["worldbook"]
    base._keys(worldbook, ("id", "name", "entries", "scanDepth", "tokenBudget", "recursiveScanning"), "PREVIEW_V4_SEED_WORLDBOOK_FIELDS")
    base.need(worldbook["id"] == "w5-upgrade-book" and worldbook["name"] == "W5 isolated worldbook" and
              worldbook["scanDepth"] == 1 and worldbook["tokenBudget"] == 256 and worldbook["recursiveScanning"] is False and
              isinstance(worldbook["entries"], list) and len(worldbook["entries"]) == 1 and
              worldbook["entries"][0].get("id") == "w5-upgrade-entry" and
              worldbook["entries"][0].get("content") == "W5 durable worldbook marker", "PREVIEW_V4_SEED_WORLDBOOK_MARKER")
    linked("worldbook", worldbook)
    settings = proof["settings"]
    base._keys(settings, ("chat", "memory", "ui", "features", "llm"), "PREVIEW_V4_SEED_SETTINGS_FIELDS")
    base.need(settings["chat"] == {"split_messages": False, "reply_delay_min": 1, "reply_delay_max": 1} and
              settings["memory"] == {"retention_days": 730} and
              settings["ui"] == {"onboarding_completed": True, "onboarding_version": 3, "onboarding_state": "complete", "onboarding_last_step": "finish"} and
              settings["features"] == {"autonomous_memory_enabled": False, "autonomous_memory_llm_enabled": False, "self_growth_enabled": False},
              "PREVIEW_V4_SEED_SETTINGS_VALUES")
    llm = settings["llm"]
    base._keys(llm, ("provider", "model", "base_url"), "PREVIEW_V4_SEED_PROVIDER_FIELDS")
    base.need(llm["provider"] == "ollama" and llm["model"] == "reverie-preview-upgrade" and isinstance(llm["base_url"], str) and
              re.fullmatch(r"http://127\.0\.0\.1:([0-9]{4,5})/v1", llm["base_url"]) is not None and
              1024 <= int(llm["base_url"].split(":")[2].split('/')[0]) <= 65535, "PREVIEW_V4_SEED_PROVIDER")
    for section in ("chat", "memory", "ui", "features"):
        linked("settings", {"id": section, "value": settings[section]})
    avatar = proof["avatar"]
    base._keys(avatar, ("id", "activeId", "importId", "resourceCount", "resourceInventorySha256"), "PREVIEW_V4_SEED_AVATAR_FIELDS")
    base.need(isinstance(avatar["id"], str) and re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", avatar["id"]) is not None and
              avatar["activeId"] == avatar["id"] and isinstance(avatar["importId"], str) and
              re.fullmatch(r"[A-Za-z0-9_-]{20,128}", avatar["importId"]) is not None and
              avatar["resourceCount"] == data["avatar"]["count"] and
              avatar["resourceInventorySha256"] == sha(v3.canonical_json(data["avatar"])), "PREVIEW_V4_SEED_AVATAR_IDENTITY")
    paths = [row["id"] for row in data["avatar"]["items"]]
    base.need("records/" + avatar["id"] + "/manifest.json" in paths and
              any(path.startswith("records/" + avatar["id"] + "/payload/") for path in paths), "PREVIEW_V4_SEED_AVATAR_RESOURCES")


def native_report(value, identity, workspace_id, action, public_sha):
    base._keys(value, ("json", "sha256", "bytes", "hostPid", "startedNs", "exitedNs", "exitCode", "remainingPids", "descendantPids"), "PREVIEW_V4_NATIVE_BINDING")
    raw = value["json"]
    base.need(isinstance(raw, str) and len(raw.encode()) == value["bytes"] and sha(raw.encode()) == value["sha256"] and
              type(value["exitCode"]) is int and value["exitCode"] == 0 and value["remainingPids"] == [], "PREVIEW_V4_NATIVE_BYTES_OR_EXIT")
    base._duration(value["startedNs"], value["exitedNs"], 240000, "PREVIEW_V4_NATIVE_DEADLINE")
    from .state import load_json_bytes
    report = load_json_bytes(raw.encode())
    base._keys(report, ("schema", "action", "hostPid", "backendPid", "backendExited", "oldHostParticipated", "workspaceId",
                       "backendIdentity", "categories", "seedProof", "authenticatedReady", "backendRuntimeVerified", "previousPublicResultSha256", "requests"), "PREVIEW_V4_NATIVE_FIELDS")
    base.need(report["schema"] in ("reverie.preview.upgrade-host.v1", "reverie.preview.upgrade-host.v2") and report["action"] == action and
              report["oldHostParticipated"] is False and report["backendExited"] is True and report["authenticatedReady"] is True and
              report["backendRuntimeVerified"] is True and report["previousPublicResultSha256"] == public_sha and
              report["workspaceId"] == workspace_id and report["backendIdentity"] == identity and
              base._integer(report["hostPid"], 1) and base._integer(report["backendPid"], 1) and
              report["hostPid"] != report["backendPid"] and report["hostPid"] == value["hostPid"] and
              report["backendPid"] in base._pids(value["descendantPids"]), "PREVIEW_V4_NATIVE_IDENTITY")
    rows = report["requests"]
    base.need(isinstance(rows, list) and 5 <= len(rows) <= 1024, "PREVIEW_V4_NATIVE_REQUESTS")
    requests, commands = [], []
    for row in rows:
        base._keys(row, ("command", "requestId", "responseSha256"), "PREVIEW_V4_NATIVE_REQUEST_FIELDS")
        base.need(base._sha(row["requestId"], 32) and base._sha(row["responseSha256"]), "PREVIEW_V4_NATIVE_REQUEST_ID")
        requests.append(row["requestId"]); commands.append(row["command"])
    base.need(len(requests) == len(set(requests)) and all(command in commands for command in
              ("chat:history", "persona:list", "persona:profile:get", "memory:list", "archive:get", "settings:get")), "PREVIEW_V4_NATIVE_READS")
    product_memory = report["schema"] == "reverie.preview.upgrade-host.v2"
    if action == "seed":
        memory_command = "memory:candidates:confirm" if product_memory else "memory:store"
        base.need(all(command in commands for command in ("provider:configure", "settings:update", "persona:import", memory_command, "archive:put", "chat:send")),
                  "PREVIEW_V4_NATIVE_WRITES")
    else:
        suffix = ["memory:list", "memory:candidates:list", "chat:history", "archive:get", "settings:get"] if product_memory else ["memory:list", "archive:get", "settings:get"]
        base.need(commands[:2] == ["chat:history", "persona:list"] and commands[-len(suffix):] == suffix and
                  commands[2:-len(suffix)] and all(command == "persona:profile:get" for command in commands[2:-len(suffix)]), "PREVIEW_V4_READ_MUTATED")
    categories(report["categories"])
    if action == "seed":
        seed_proof(report)
    else:
        base.need(report["seedProof"] is None, "PREVIEW_V4_READ_HAS_SEED_PROOF")
    return report


def snapshot(value, before, source, destination, kind):
    base._keys(value, ("name", "manifestJson", "manifestSha256", "copiedInventory"), "PREVIEW_V4_SNAPSHOT_FIELDS")
    raw = value["manifestJson"]
    base.need(isinstance(raw, str) and sha(raw.encode()) == value["manifestSha256"], "PREVIEW_V4_MANIFEST_BYTES")
    from .state import load_json_bytes
    manifest = load_json_bytes(raw.encode())
    base._keys(manifest, ("schema", "name", "createdAt", "kind", "dataIdentity", "fromReadyId", "from", "to",
                          "transitionSha256", "files", "directories", "totalBytes"), "PREVIEW_V4_MANIFEST_FIELDS")
    base.need(manifest["schema"] == "reverie.preview.snapshot.v2" and manifest["kind"] == kind and
              manifest["name"] == value["name"] and manifest["from"] == source and manifest["to"] == destination and
              manifest["dataIdentity"] == source and base._sha(manifest["fromReadyId"], 32), "PREVIEW_V4_MANIFEST_IDENTITY")
    transition = sha(v3.canonical_json({"fromReadyId": manifest["fromReadyId"], "from": source, "to": destination}))
    stamp = manifest["createdAt"]
    from datetime import datetime
    base.need(isinstance(stamp, str) and re.fullmatch(r"[0-9]{8}T[0-9]{9}Z", stamp) is not None,
              "PREVIEW_V4_MANIFEST_TIME")
    try:
        datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ")
    except ValueError as error:
        raise base.PreviewError("PREVIEW_V4_MANIFEST_TIME") from error
    prefix = (f"snapshot-{stamp}-{source['candidate'][:32]}--{destination['candidate'][:32]}-{transition[:32]}-"
              if kind == "upgrade" else f"pre-restore-{stamp}-{source['candidate'][:32]}-")
    base.need(manifest["transitionSha256"] == transition and value["name"].startswith(prefix) and
              re.fullmatch(r"[0-9a-f]{8}", value["name"][len(prefix):]) is not None and
              (kind != "upgrade" or source != destination), "PREVIEW_V4_MANIFEST_TRANSITION")
    files = []
    for row in manifest["files"]:
        base._keys(row, ("path", "type", "sourceLinkCount", "size", "sha256"), "PREVIEW_V4_MANIFEST_FILE")
        base.need(row["type"] == "regular" and isinstance(row["sourceLinkCount"], str) and
                  re.fullmatch(r"[1-9][0-9]{0,15}", row["sourceLinkCount"]), "PREVIEW_V4_MANIFEST_FILE_TYPE")
        files.append({key: row[key] for key in ("path", "size", "sha256")})
    contents = v3.inventory({"files": files, "directories": manifest["directories"], "totalBytes": manifest["totalBytes"]})
    base.need(contents == v3.inventory(before) == v3.inventory(value["copiedInventory"]), "PREVIEW_V4_SNAPSHOT_BYTES")
    return manifest


def verify_observations_v4(result, *, expected_source, expected_candidate, expected_build_sha, isolation_root,
                           expected_version=None, expected_previous=None):
    base.need(expected_version in (None, VERSION), "PREVIEW_SUMMARY_VERSION")
    required = {"schema", "contract", "passed", "checks", "observations", "cleanup", "observationBinding", "sourceHead", "candidate",
                "buildManifestSha256", "isolationRoot", "workspaceRelativePath", "runtimeRelativePath", "limits"}
    base.need(isinstance(result, dict) and set(result) in (required, required | {"error"}) and result.get("passed") is True and
              result.get("error") in (None, "") and result.get("contract") == VERSION and
              result.get("schema") == "reverie.preview-workspace.smoke.v4", "PREVIEW_V4_SUMMARY")
    base.need(result["checks"] == [{"name": name, "observation": observation, "passed": True} for name, observation in CHECKS],
              "PREVIEW_V4_CHECK_SELECTION")
    current = {"candidate": expected_candidate, "sourceHead": expected_source, "buildManifestSha256": expected_build_sha}
    base.need(all(result.get(key) == value for key, value in current.items()) and result["limits"] == base.LIMITS and
              result["isolationRoot"] == str(isolation_root) and result["workspaceRelativePath"] == "preview-workspace" and
              result["runtimeRelativePath"] == "preview-runtime", "PREVIEW_V4_CURRENT_BINDING")
    obs = result["observations"]
    base._keys(obs, ("lifecycle", "previousBefore", "previousAfter", "seed", "upgrade", "restore", "rollback", "formatProtection", "diagnostics", "modelRequests"),
               "PREVIEW_V4_OBSERVATION_FIELDS")
    binding = previous_binding(obs["previousBefore"])
    base.need(expected_previous is not None and binding == expected_previous == obs["previousAfter"], "PREVIEW_V4_PREVIOUS_BINDING")
    life = obs["lifecycle"]
    proof = base._verify_lifecycle_observations(life, expected_source=expected_source, expected_candidate=expected_candidate,
        expected_build_sha=expected_build_sha, isolation_root=isolation_root, expected_version="v2")
    workspace_id = proof["workspaceId"]
    old = {key: binding[key] for key in ("candidate", "sourceHead", "buildManifestSha256")}
    seed = native_report(obs["seed"], old, workspace_id, "seed", binding["evidence"]["sha256"])
    if seed["schema"] == "reverie.preview.upgrade-host.v2":
        from . import preview_memory_seed as memory_seed
        memory_seed.model_requests(obs["modelRequests"], seed)
    else:
        model_requests(obs["modelRequests"], seed["seedProof"]["chat"])
    upgrade = obs["upgrade"]
    base._keys(upgrade, ("baselineReady", "beforeInventory", "start", "startupEvents", "snapshot", "readyRecord", "exit", "readback"), "PREVIEW_V4_UPGRADE_FIELDS")
    start = upgrade["start"]
    base._ready(start["ready"], {**current, "workspaceId": workspace_id})
    base._duration(start["startedNs"], start["readyNs"], base.LIMITS["readyMs"], "PREVIEW_V4_UPGRADE_READY")
    v3._exit(upgrade["exit"], start)
    v3.verify_startup_events(upgrade["startupEvents"], start)
    manifest = snapshot(upgrade["snapshot"], upgrade["beforeInventory"], old, current, "upgrade")
    base.need(v3.ready_candidate(upgrade["baselineReady"]) == old and
              upgrade["baselineReady"]["readyId"] == manifest["fromReadyId"], "PREVIEW_V4_OLD_BASELINE_RECORD")
    base.need(v3.ready_candidate(upgrade["readyRecord"]) == current, "PREVIEW_V4_READY_RECORD")
    new = native_report(upgrade["readback"], current, workspace_id, "read", binding["evidence"]["sha256"])
    restore = obs["restore"]
    base._keys(restore, ("exitCode", "startedNs", "exitedNs", "beforeInventory", "afterInventory", "preSnapshot", "readyRecord", "result"), "PREVIEW_V4_RESTORE_FIELDS")
    base.need(type(restore["exitCode"]) is int and restore["exitCode"] == 0 and
              v3.inventory(restore["afterInventory"]) == v3.inventory(upgrade["beforeInventory"]), "PREVIEW_V4_RESTORE_BYTES")
    snapshot(restore["preSnapshot"], restore["beforeInventory"], current, current, "pre-restore")
    base.need(v3.ready_candidate(restore["readyRecord"]) == old and
              restore["readyRecord"]["readyId"] != manifest["fromReadyId"], "PREVIEW_V4_RESTORE_BASELINE")
    base.need(restore["result"].get("schema") == "reverie.preview.restore-result.v1" and
              restore["result"].get("name") == upgrade["snapshot"]["name"] and
              restore["result"].get("preRestoreSnapshot") == restore["preSnapshot"]["name"], "PREVIEW_V4_RESTORE_RECEIPT")
    base._duration(restore["startedNs"], restore["exitedNs"], 30000, "PREVIEW_V4_RESTORE_DEADLINE")
    rollback = native_report(obs["rollback"], old, workspace_id, "read", binding["evidence"]["sha256"])
    base.need(seed["schema"] == new["schema"] == rollback["schema"], "PREVIEW_MEMORY_REPORT_VERSION")
    base.need(seed["categories"] == new["categories"] == rollback["categories"], "PREVIEW_V4_DATA_CHANGED")
    base.need(life["cleanup"]["hostCleanup"]["exitedNs"] <= obs["seed"]["startedNs"] and
              obs["seed"]["exitedNs"] <= start["startedNs"] and upgrade["exit"]["allGoneNs"] <= upgrade["readback"]["startedNs"] and
              upgrade["readback"]["exitedNs"] <= restore["startedNs"] <= restore["exitedNs"] <= obs["rollback"]["startedNs"],
              "PREVIEW_V4_PHASE_ORDER")
    refusals = obs["formatProtection"]
    base._keys(refusals, ("launcher", "host"), "PREVIEW_V4_FORMAT_FIELDS")
    for role, row in refusals.items():
        base._keys(row, ("exitCode", "stdout", "stderr", "beforeInventory", "afterInventory", "startedNs", "exitedNs", "descendantPids", "descendantExecutables", "formatRecordJson"), "PREVIEW_V4_REFUSAL_FIELDS")
        base.need(type(row["exitCode"]) is int and row["exitCode"] != 0 and "REVERIE_PREVIEW_READY" not in row["stdout"] and
                  "PREVIEW_DATA_FORMAT_TOO_NEW" in row["stderr"] and
                  workspace_inventory(row["beforeInventory"]) == workspace_inventory(row["afterInventory"]), "PREVIEW_V4_FORMAT_MODIFIED_DATA")
        children = base._pids(row["descendantPids"])
        # The launcher verifies the signed old installation before its format
        # gate. codesign is a verifier, never the old host or Python backend.
        # The process snapshot can record that verifier as (codesign).
        allowed = ["/usr/bin/codesign", "(codesign)"] if role == "launcher" else []
        base.need(isinstance(row["descendantExecutables"], list) and
                  all(path in allowed for path in row["descendantExecutables"]) and
                  bool(children) == bool(row["descendantExecutables"]), "PREVIEW_V4_FORMAT_STARTED_BACKEND")
        from .state import load_json_bytes
        record = row["formatRecordJson"]
        base.need(isinstance(record, str) and load_json_bytes(record.encode()) ==
                  {"schema": "reverie.preview.data-format.v1", "formatVersion": 2} and
                  next((item for item in row["beforeInventory"]["files"] if item["path"] == "data/preview-data-format.json"), None) ==
                  {"path": "data/preview-data-format.json", "size": str(len(record.encode())), "sha256": sha(record.encode())},
                  "PREVIEW_V4_FORMAT_RECORD_BINDING")
        base._duration(row["startedNs"], row["exitedNs"], 10000, "PREVIEW_V4_FORMAT_DEADLINE")
    diagnostic = obs["diagnostics"]
    base._keys(diagnostic, ("exportJson", "sha256", "bytes", "outputMode", "exportedNs"), "PREVIEW_V4_DIAGNOSTICS_FIELDS")
    raw = diagnostic["exportJson"]
    base.need(isinstance(raw, str) and len(raw.encode()) == diagnostic["bytes"] and sha(raw.encode()) == diagnostic["sha256"] and
              diagnostic["outputMode"] == 0o600 and start["readyNs"] <= diagnostic["exportedNs"] <= upgrade["exit"]["sentNs"],
              "PREVIEW_V4_DIAGNOSTICS_BYTES")
    from .state import load_json_bytes
    value = load_json_bytes(raw.encode()); v3._no_absolute_paths(value)
    projected = deepcopy(value)
    for row in projected.get("snapshots", {}).get("entries", []):
        base.need(row.pop("kind", None) == "upgrade", "PREVIEW_V4_DIAGNOSTICS_SNAPSHOT_KIND")
    diagnostic_events = v3.diagnostics_document(projected, current, upgrade["snapshot"])
    base.need([row for row in diagnostic_events if row["hostPid"] == start["ready"]["hostPid"]] == upgrade["startupEvents"],
              "PREVIEW_V4_DIAGNOSTICS_EVENT_BINDING")
    cleanup = result["cleanup"]
    base._keys(cleanup, ("account", "attributesBefore", "attributesAfter", "hostCleanup", "remainingPids", "workspaceRemoved", "runtimeRemoved"), "PREVIEW_V4_CLEANUP_FIELDS")
    base._attributes_absent(cleanup["attributesBefore"]); base._attributes_absent(cleanup["attributesAfter"])
    cleaner = cleanup["hostCleanup"]
    base._keys(cleaner, ("hostPid", "exitCode", "workspaceId", "startedNs", "exitedNs", "services", "backendPids", "readyEvents"),
               "PREVIEW_V4_CLEANUP_HOST_FIELDS")
    base.need(cleanup["account"] == workspace_id and cleanup["remainingPids"] == [] and
              cleanup["workspaceRemoved"] is True and cleanup["runtimeRemoved"] is True and
              cleanup["hostCleanup"].get("exitCode") == 0 and cleanup["hostCleanup"].get("workspaceId") == workspace_id and
              cleanup["hostCleanup"].get("services") == [base.STORAGE_SERVICE, base.CREDENTIALS_SERVICE] and
              cleanup["hostCleanup"].get("backendPids") == [] and cleanup["hostCleanup"].get("readyEvents") == [], "PREVIEW_V4_CLEANUP")
    base._duration(cleaner["startedNs"], cleaner["exitedNs"], 10000, "PREVIEW_V4_CLEANUP_DEADLINE")
    base.need(base._integer(cleaner["hostPid"], 1) and max(row["exitedNs"] for row in refusals.values()) <= cleaner["startedNs"],
              "PREVIEW_V4_CLEANUP_ORDER")
    pids = [*proof["hostPids"], *proof["backendPids"], proof["duplicateHostPid"], proof["hostCleanupPid"],
            start["ready"]["hostPid"], start["ready"]["backendPid"], cleaner["hostPid"]]
    for report in (seed, new, rollback):
        pids.extend((report["hostPid"], report["backendPid"]))
    base.need(len(pids) == len(set(pids)), "PREVIEW_V4_PROCESS_IDENTITIES_REUSED")
    proof.update(schema="reverie.preview-workspace.proof.v4", contract=VERSION, checks=len(CHECKS),
        checkNames=[name for name, _ in CHECKS], oldHostParticipated=False, previousVersion=old,
        previousInputBinding=deepcopy(binding), categories=seed["categories"], versionSnapshotVerified=True,
        snapshotBeforeKeychainAndBackend=True, restoreVerified=True, rollbackVerified=True, formatProtectionVerified=True,
        diagnosticsSanitized=True, snapshotName=upgrade["snapshot"]["name"])
    return proof
