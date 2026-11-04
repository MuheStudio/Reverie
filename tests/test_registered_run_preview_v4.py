"""Synthetic saved upgrade evidence; no application, keychain, or live runtime."""
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from script.registered_run import preview, preview_v3, preview_v4, stages
from script.registered_run.config import ConfigError, validate_config
from script.registered_run.contract import registration_contract
from script.registered_run.modes.context import RunContext
from tests.test_registered_run_preview import SOURCE, config_value, ready, report_value, report_value_v2, replace, save_observations, workspace, write_json
from tests.test_registered_run_preview_v3 import events, export_binding, report_value_v3


def previous_input():
    candidate = "synthetic-previous"
    root = ".tools/preview-runtime/" + candidate
    manifest = {"schema": "reverie.qt.preview-manifest.v1", "entries": [
        {"path": "src/main.py"}, {"path": "native-ui/avatar-host.cjs"}]}
    manifest_bytes = json.dumps(manifest).encode()
    metadata = {"schema": "reverie.qt.preview-runtime.v1", "installation": {"kind": "adopted"},
        "candidate": candidate, "sourceHead": "f" * 40, "buildManifestSha256": "e" * 64,
        "manifestSha256": preview_v4.sha(manifest_bytes), "hostExecutable": "candidate/Reverie Scene.app/Contents/MacOS/Reverie Scene",
        "python": ".venv/bin/python", "node": ".tools/node/bin/node"}
    public = {"schema": "reverie.preview.m1.formal.r1.result.v1", "overallPassed": True, "formalAcceptance": True,
        "sourceHead": "f" * 40, "adoption": {"candidate": candidate, "build": {"sha256": "e" * 64}}}
    documents = {"evidence": json.dumps(public).encode(), "runtimeMetadata": json.dumps(metadata).encode(), "runtimeManifest": manifest_bytes}
    paths = {"evidence": preview_v4.PUBLIC_RESULT, "runtimeMetadata": root + "/preview-runtime.json", "runtimeManifest": root + "/preview-manifest.json"}
    binding = {role: {"path": paths[role], "bytes": len(payload), "sha256": preview_v4.sha(payload)} for role, payload in documents.items()}
    binding.update(runtimeRoot=root, candidate=candidate, sourceHead="f" * 40, buildManifestSha256="e" * 64, model=".tools/live2d/isolated-copy")
    return binding, documents


def v4_config():
    result = config_value(enabled=True, version="v4")
    result.update(previewWorkspaceChecks=list(preview_v4.SELECTION), previewUpgradeBaseline=previous_input()[0])
    result["timeoutsSeconds"]["preview-check"] = preview_v4.TIMEOUT_SECONDS
    return result


def seed_fixture():
    profile_id = "st_" + preview_v4.sha(preview_v3.canonical_json(preview_v4.seed_card()))[:20]
    persona = {"id": profile_id, "name": preview_v4.PERSONA_NAME, "source_format": "chara_card_v2", "active": False,
               "profile": {"identity_version": 1, "identity_fingerprint": "a" * 64,
                           "fields": {"description": preview_v4.PERSONA_DESCRIPTION, "first_message": "Hello"}}}
    memory = {"id": "memory-stable-id", "text": preview_v4.MEMORY_MARKER}
    request_id = "f" * 32
    clean_reply = "W5 isolated durable"
    def chat_record(identity, role, text):
        return {"id": identity, "role": role, "contentSha256": preview_v4.sha(text.encode()), "contentBytes": len(text.encode()),
                "request_id": request_id, "persona_id": "default", "bubble_index": 0}
    user = chat_record("user-stable-id", "user", preview_v4.USER_MARKER)
    assistant = chat_record("assistant-stable-id", "assistant", clean_reply)
    book = {"id": "w5-upgrade-book", "name": "W5 isolated worldbook", "scanDepth": 1, "tokenBudget": 256, "recursiveScanning": False,
            "entries": [{"id": "w5-upgrade-entry", "content": "W5 durable worldbook marker"}]}
    settings = {"chat": {"split_messages": False, "reply_delay_min": 1, "reply_delay_max": 1}, "memory": {"retention_days": 730},
                "ui": {"onboarding_completed": True, "onboarding_version": 3, "onboarding_state": "complete", "onboarding_last_step": "finish"},
                "features": {"autonomous_memory_enabled": False, "autonomous_memory_llm_enabled": False, "self_growth_enabled": False},
                "llm": {"provider": "ollama", "model": "reverie-preview-upgrade", "base_url": "http://127.0.0.1:9876/v1"}}
    avatar_id = "01234567-89ab-cdef-0123-456789abcdef"
    avatar_data = {"count": 3, "items": [
        {"id": "active.json", "sha256": "a" * 64}, {"id": "records/" + avatar_id + "/manifest.json", "sha256": "b" * 64},
        {"id": "records/" + avatar_id + "/payload/model.model3.json", "sha256": "c" * 64}]}
    def category(records):
        return {"count": len(records), "items": sorted([
            {"id": record["id"], "sha256": preview_v4.sha(preview_v3.canonical_json({key: value for key, value in record.items() if key != "id"}))}
            for record in records], key=lambda item: item["id"])}
    stored_memory = {"id": memory["id"], "text": "Precious memory: " + memory["text"]}
    data = {"persona": category([persona]), "memory": category([stored_memory]), "chat": category([user, assistant]), "worldbook": category([book]),
            "settings": category([{"id": section, "value": settings[section]} for section in ("chat", "memory", "ui", "features")]), "avatar": avatar_data}
    model_fingerprint = preview_v4.sha("\0".join(settings["llm"][key] for key in ("provider", "model", "base_url")).encode())[:24]
    scope = {"requestId": request_id, "deliveryId": "delivery_" + "a" * 32, "conversationId": "dream-room", "personaId": "default",
             "personaEpoch": 1, "personaFingerprint": "d" * 64, "modelEpoch": 1, "modelFingerprint": model_fingerprint}
    scope_sha = preview_v4.sha(preview_v3.canonical_json(scope))
    delivery = {"scope": scope, "ownerPersona": {"persona_id": "default", "epoch": 1, "fingerprint": "d" * 64},
        "ownerModel": {"epoch": 1, "fingerprint": model_fingerprint}, "beforeMessageIds": [],
        "bubble": {"scopeSha256": scope_sha, "sequence": 10, "index": 0, "total": 1,
                   "displaySha256": assistant["contentSha256"], "displayBytes": assistant["contentBytes"]},
        "done": {"scopeSha256": scope_sha, "sequence": 11, "responseSha256": "a" * 64, "displaySha256": assistant["contentSha256"],
                 "displayBytes": assistant["contentBytes"], "cleanSha256": assistant["contentSha256"], "cleanBytes": assistant["contentBytes"],
                 "cleanCount": 1, "displayCount": 1, "stateDone": True, "incremental": True, "degraded": False, "markerInDisplay": True, "markerInClean": True},
        "history": {"requestId": "c" * 32, "responseSha256": "a" * 64, "sequence": 12},
        "marker": {"sha256": preview_v4.sha(b"W5"), "bytes": 2, "unique": False, "inUser": True, "inMock": True}}
    proof = {"persona": persona, "memory": memory, "chat": {"requestId": request_id, "user": user, "assistant": assistant, "delivery": delivery}, "worldbook": book,
             "settings": settings, "avatar": {"id": avatar_id, "activeId": avatar_id, "importId": "synthetic_import_1234567890123456", "resourceCount": 3,
                "resourceInventorySha256": preview_v4.sha(preview_v3.canonical_json(avatar_data))}}
    return proof, data


def native(identity, workspace_id, action, begin, host, category_data=None):
    seed, default_data = seed_fixture()
    data = category_data or default_data
    commands = ["chat:history", "persona:list", "persona:profile:get", "memory:list", "archive:get", "settings:get"]
    if action == "seed":
        commands = ["provider:configure", "settings:update", "persona:import", "memory:store", "archive:put", "chat:send", *commands]
    report = {"schema": "reverie.preview.upgrade-host.v1", "action": action, "hostPid": host, "backendPid": host + 1,
        "backendExited": True, "oldHostParticipated": False, "workspaceId": workspace_id, "backendIdentity": identity,
        "categories": deepcopy(data), "seedProof": deepcopy(seed) if action == "seed" else None, "authenticatedReady": True, "backendRuntimeVerified": True,
        "previousPublicResultSha256": previous_input()[0]["evidence"]["sha256"],
        "requests": [{"command": command, "requestId": seed["chat"]["requestId"] if command == "chat:send" else
                      seed["chat"]["delivery"]["history"]["requestId"] if command == "chat:history" else format(index + 1, "032x"), "responseSha256": "a" * 64}
                     for index, command in enumerate(commands)]}
    raw = json.dumps(report)
    return {"json": raw, "bytes": len(raw.encode()), "sha256": preview_v4.sha(raw.encode()), "hostPid": host,
            "startedNs": begin, "exitedNs": begin + 100_000_000, "exitCode": 0, "remainingPids": [], "descendantPids": [host + 1]}


def native_change(binding, update):
    value = json.loads(binding["json"])
    update(value)
    binding["json"] = json.dumps(value)
    binding["bytes"] = len(binding["json"].encode()); binding["sha256"] = preview_v4.sha(binding["json"].encode())


def snapshot(before, source, destination, kind, ready_id="c" * 32):
    stamp = "20261101T050000123Z"
    transition = preview_v4.sha(preview_v3.canonical_json({"fromReadyId": ready_id, "from": source, "to": destination}))
    prefix = (f"snapshot-{stamp}-{source['candidate'][:32]}--{destination['candidate'][:32]}-{transition[:32]}-"
              if kind == "upgrade" else f"pre-restore-{stamp}-{source['candidate'][:32]}-")
    name = prefix + "1234abcd"
    manifest = {"schema": "reverie.preview.snapshot.v2", "name": name, "createdAt": stamp, "kind": kind, "dataIdentity": source,
        "fromReadyId": ready_id, "from": source, "to": destination, "transitionSha256": transition,
        "files": [{**item, "type": "regular", "sourceLinkCount": "1"} for item in before["files"]],
        "directories": before["directories"], "totalBytes": before["totalBytes"]}
    raw = json.dumps(manifest)
    return {"name": name, "manifestJson": raw, "manifestSha256": preview_v4.sha(raw.encode()), "copiedInventory": deepcopy(before)}


def value_v4(isolation, candidate="synthetic-preview", build_sha="b" * 64):
    v3 = report_value_v3(isolation, candidate=candidate, build_sha=build_sha)
    value = deepcopy(v3)
    value.update(schema="reverie.preview-workspace.smoke.v4", contract="v4",
        checks=[{"name": name, "observation": observation, "passed": True} for name, observation in preview_v4.CHECKS])
    binding, _ = previous_input()
    current = {"candidate": candidate, "sourceHead": SOURCE, "buildManifestSha256": build_sha}
    old = {key: binding[key] for key in current}
    added = v3["observations"]["versionSnapshot"]
    before = added["beforeInventory"]
    snap = snapshot(before, old, current, "upgrade")
    pre = snapshot(before, current, current, "pre-restore", "d" * 32)
    workspace_id = value["cleanup"]["account"]
    diagnostic = json.loads(v3["observations"]["diagnostics"]["exportJson"])
    diagnostic["snapshots"]["entries"][0].update(name=snap["name"], kind="upgrade")
    diagnostic["events"]["entries"] = events(109)
    record_json = json.dumps({"schema": "reverie.preview.data-format.v1", "formatVersion": 2})
    refusal_before = deepcopy(before)
    refusal_before["files"].append({"path": "data/preview-data-format.json", "size": str(len(record_json)), "sha256": preview_v4.sha(record_json.encode())})
    refusal_before["totalBytes"] = str(int(before["totalBytes"]) + len(record_json))
    refusal = {"exitCode": 71, "stdout": "", "stderr": "PREVIEW_DATA_FORMAT_TOO_NEW", "beforeInventory": refusal_before,
        "afterInventory": deepcopy(refusal_before), "startedNs": 18_000_000_000, "exitedNs": 18_100_000_000,
        "descendantPids": [], "descendantExecutables": [], "formatRecordJson": record_json}
    value["observations"] = {
        "lifecycle": report_value_v2(isolation, candidate=candidate, build_sha=build_sha),
        "previousBefore": binding, "previousAfter": deepcopy(binding),
        "seed": native(old, workspace_id, "seed", 9_500_000_000, 201),
        "upgrade": {"baselineReady": {"schema": "reverie.preview.ready-candidate.v1", "readyId": "c" * 32, **old},
            "beforeInventory": before, "start": added["start"], "startupEvents": events(109), "snapshot": snap,
            "readyRecord": added["readyRecord"], "exit": added["changedExit"],
            "readback": native(current, workspace_id, "read", 12_000_000_000, 203)},
        "restore": {"exitCode": 0, "startedNs": 14_000_000_000, "exitedNs": 15_000_000_000, "beforeInventory": deepcopy(before),
            "afterInventory": deepcopy(before), "preSnapshot": pre,
            "readyRecord": {"schema": "reverie.preview.ready-candidate.v1", "readyId": "e" * 32, **old},
            "result": {"schema": "reverie.preview.restore-result.v1", "name": snap["name"], "preRestoreSnapshot": pre["name"]}},
        "rollback": native(old, workspace_id, "read", 16_000_000_000, 205),
        "modelRequests": model_fixture(),
        "formatProtection": {"launcher": refusal, "host": deepcopy(refusal)},
        "diagnostics": export_binding(diagnostic, exported_ns=11_100_000_000)}
    value["cleanup"] = {"account": workspace_id, "attributesBefore": dict.fromkeys(preview.ATTRIBUTE_ROLES),
        "attributesAfter": dict.fromkeys(preview.ATTRIBUTE_ROLES), "remainingPids": [], "workspaceRemoved": True, "runtimeRemoved": True,
        "hostCleanup": {"hostPid": 208, "exitCode": 0, "startedNs": 20_000_000_000, "exitedNs": 20_100_000_000,
                        "workspaceId": workspace_id, "services": [preview.STORAGE_SERVICE, preview.CREDENTIALS_SERVICE],
                        "backendPids": [], "readyEvents": []}}
    return value


def model_fixture():
    user = preview_v4.USER_MARKER.encode(); reply = preview_v4.mock_response_bytes()
    return {"chatRequestIds": ["f" * 32], "unknownCount": 0, "rows": [{"sequence": 1, "chat": True, "probe": False,
        "requestSha256": "a" * 64, "requestBytes": 1000, "responseSha256": preview_v4.sha(reply), "responseBytes": len(reply),
        "userSha256": preview_v4.sha(user), "userBytes": len(user), "modelSha256": preview_v4.sha(preview_v4.MODEL.encode()),
        "responseTextSha256": preview_v4.sha(preview_v4.ASSISTANT_MARKER.encode()), "responseTextBytes": len(preview_v4.ASSISTANT_MARKER.encode()), "statusCode": 200}]}


def derive(value):
    return preview.verify_observations(value, expected_source=value["sourceHead"], expected_candidate=value["candidate"],
        expected_build_sha=value["buildManifestSha256"], isolation_root=Path(value["isolationRoot"]), expected_version="v4",
        expected_previous=previous_input()[0])


def test_v4_fixed_selection_preserves_original_substep_limits_and_versions():
    result = validate_config(v4_config())
    assert result["timeoutsSeconds"]["preview-check"] == 1200
    assert preview.TIMEOUT_SECONDS == 600
    assert preview.LIMITS == {"readyMs": 30000, "normalMs": 10000, "duplicateMs": 5000, "forcedMs": 10000}
    command = preview.command("/repo", result, "/report", "/scratch")
    assert command[-4:-1] == ["--contract", "v4", "--previous-binding"]
    assert json.loads(command[-1]) == previous_input()[0]


@pytest.mark.parametrize("field,replacement", [
    ("previewWorkspaceChecks", []), ("previewWorkspaceChecks", list(reversed(preview_v4.SELECTION))),
    ("previewUpgradeBaseline", None), ("previewUpgradeBaseline.evidence.path", "docs/other.json"),
    ("previewUpgradeBaseline.runtimeRoot", ".tools/preview-runtime/from-default-pointer"),
    ("previewUpgradeBaseline.model", "data/real-model"), ("timeoutsSeconds.preview-check", 600),
])
def test_v4_configuration_rejects_unfrozen_or_partial_upgrade_selection(field, replacement):
    value = v4_config(); replace(value, field, replacement)
    with pytest.raises(ConfigError):
        validate_config(value)


def test_v4_baseline_inputs_are_part_of_canonical_frozen_contract():
    args = ({"cases": [], "counts": {}}, {}, {}, {"unitRun": {"sequence": 1}, "requiredGuiRuns": {}}, {})
    config = v4_config()
    old = registration_contract(config, *args, code_tree_hash="c" * 40)
    config["previewUpgradeBaseline"]["runtimeMetadata"]["sha256"] = "0" * 64
    changed = registration_contract(config, *args, code_tree_hash="c" * 40)
    assert old["runtime"]["previewUpgradeBaseline"] != changed["runtime"]["previewUpgradeBaseline"]


def test_v4_recomputes_nine_checks_from_raw_six_category_and_snapshot_facts(tmp_path):
    proof = derive(value_v4(tmp_path.resolve()))
    assert proof["checks"] == 9 and proof["oldHostParticipated"] is False
    assert proof["restoreVerified"] and proof["rollbackVerified"] and proof["formatProtectionVerified"]
    assert set(proof["categories"]) == set(preview_v4.CATEGORIES)


@pytest.mark.parametrize("field,replacement,code", [
    ("checks", [], "PREVIEW_V4_CHECK_SELECTION"),
    ("observations.previousAfter.sourceHead", "0" * 40, "PREVIEW_V4_PREVIOUS_BINDING"),
    ("observations.upgrade.snapshot.copiedInventory.files.0.sha256", "0" * 64, "PREVIEW_V4_SNAPSHOT_BYTES"),
    ("observations.upgrade.startupEvents.1.code", "REUSED", "PREVIEW_V3_SNAPSHOT_EVENT_RESULT"),
    ("observations.restore.afterInventory.files.0.sha256", "0" * 64, "PREVIEW_V4_RESTORE_BYTES"),
    ("observations.restore.readyRecord.readyId", "c" * 32, "PREVIEW_V4_RESTORE_BASELINE"),
    ("observations.formatProtection.host.afterInventory.files.0.sha256", "0" * 64, "PREVIEW_V4_FORMAT_MODIFIED_DATA"),
    ("observations.formatProtection.launcher.descendantPids", [42], "PREVIEW_V4_FORMAT_STARTED_BACKEND"),
    ("cleanup.attributesAfter.previewStorage", {"present": True}, "PREVIEW_ATTRIBUTES_NOT_ABSENT"),
    ("cleanup.hostCleanup.services", [preview.STORAGE_SERVICE, "com.muhe.reverie.qt.local.storage.v1"], "PREVIEW_V4_CLEANUP"),
])
def test_v4_rejects_changed_data_false_success_and_cleanup_scope(tmp_path, field, replacement, code):
    value = value_v4(tmp_path.resolve()); replace(value, field, replacement)
    with pytest.raises(preview.PreviewError, match=code):
        derive(value)


@pytest.mark.parametrize("change,code", [
    (lambda report: report.update(oldHostParticipated=True), "PREVIEW_V4_NATIVE_IDENTITY"),
    (lambda report: report.update(backendRuntimeVerified=False), "PREVIEW_V4_NATIVE_IDENTITY"),
    (lambda report: report.update(previousPublicResultSha256="0" * 64), "PREVIEW_V4_NATIVE_IDENTITY"),
    (lambda report: report.update(workspaceId="0" * 64), "PREVIEW_V4_NATIVE_IDENTITY"),
    (lambda report: report["backendIdentity"].update(sourceHead="0" * 40), "PREVIEW_V4_NATIVE_IDENTITY"),
    (lambda report: report["categories"]["memory"]["items"][0].update(sha256="0" * 64), "PREVIEW_V4_DATA_CHANGED"),
    (lambda report: report["categories"].pop("avatar"), "PREVIEW_V4_CATEGORY_SET"),
    (lambda report: report["requests"].append({"command": "settings:update", "requestId": "b" * 32, "responseSha256": "c" * 64}), "PREVIEW_V4_READ_MUTATED"),
])
def test_v4_native_readback_binds_owner_backend_category_and_read_only_commands(tmp_path, change, code):
    value = value_v4(tmp_path.resolve()); native_change(value["observations"]["rollback"], change)
    with pytest.raises(preview.PreviewError, match=code):
        derive(value)


@pytest.mark.parametrize("field,replacement,code", [
    ("persona.profile.fields.description", "unrelated persona", "PREVIEW_V4_SEED_PERSONA_MARKER"),
    ("memory.text", "unrelated memory", "PREVIEW_V4_SEED_MEMORY_MARKER"),
    ("chat.requestId", "0" * 32, "PREVIEW_V4_SEED_CHAT_REQUEST"),
    ("chat.assistant.request_id", "0" * 32, "PREVIEW_V4_SEED_CHAT_MARKER"),
    ("chat.user.contentSha256", preview_v4.sha(b"earlier user message"), "PREVIEW_V4_SEED_CHAT_MARKER"),
    ("worldbook.entries.0.content", "unrelated worldbook", "PREVIEW_V4_SEED_WORLDBOOK_MARKER"),
    ("settings.chat.split_messages", True, "PREVIEW_V4_SEED_SETTINGS_VALUES"),
    ("avatar.activeId", "different-avatar", "PREVIEW_V4_SEED_AVATAR_IDENTITY"),
])
def test_v4_seed_proof_rejects_unrelated_records_and_earlier_chat_replies(tmp_path, field, replacement, code):
    value = value_v4(tmp_path.resolve())
    def change(report):
        replace(report["seedProof"], field, replacement)
    native_change(value["observations"]["seed"], change)
    with pytest.raises(preview.PreviewError, match=code):
        derive(value)


@pytest.mark.parametrize("field,replacement", [
    ("delivery.scope.personaEpoch", 2), ("delivery.scope.modelEpoch", 2),
    ("delivery.scope.requestId", "0" * 32), ("delivery.bubble.scopeSha256", "0" * 64),
    ("delivery.done.degraded", True), ("delivery.done.cleanBytes", 0),
    ("assistant.contentBytes", 0), ("delivery.done.cleanSha256", "0" * 64),
    ("delivery.done.sequence", 10), ("delivery.history.sequence", 10),
    ("delivery.beforeMessageIds", ["assistant-stable-id"]), ("delivery.done.markerInClean", False),
    ("delivery.done.markerInDisplay", False), ("delivery.marker.unique", True),
])
def test_v4_delivery_rejects_wrong_scope_order_empty_extra_and_missing_marker(tmp_path, field, replacement):
    value = value_v4(tmp_path.resolve())
    native_change(value["observations"]["seed"], lambda report: replace(report["seedProof"]["chat"], field, replacement))
    with pytest.raises(preview.PreviewError):
        derive(value)


@pytest.mark.parametrize("change", [
    lambda value: value["rows"][0].update(sequence=2),
    lambda value: value["rows"].append({**value["rows"][0], "sequence": 2}),
    lambda value: value["rows"][0].update(chat=False, probe=False),
    lambda value: value["rows"][0].update(responseSha256="0" * 64),
    lambda value: value.update(unknownCount=1),
    lambda value: value.update(chatRequestIds=["0" * 32]),
])
def test_v4_mock_requests_reject_extra_unknown_reordered_or_unbound_responses(tmp_path, change):
    value = value_v4(tmp_path.resolve()); change(value["observations"]["modelRequests"])
    with pytest.raises(preview.PreviewError):
        derive(value)


def test_v4_chat_and_model_evidence_keep_only_digests_lengths_ids_and_scope():
    proof, _ = seed_fixture()
    saved = json.dumps({"chat": proof["chat"], "modelRequests": model_fixture()})
    assert preview_v4.USER_MARKER not in saved and preview_v4.ASSISTANT_MARKER not in saved
    assert "W5 isolated durable" not in saved and "payloadJson" not in saved and '"content"' not in saved


def test_v4_fixed_health_probe_is_separate_and_precedes_the_single_business_reply(tmp_path):
    value = value_v4(tmp_path.resolve()); requests = value["observations"]["modelRequests"]
    probe = {**requests["rows"][0], "chat": False, "probe": True,
             "userSha256": preview_v4.sha(preview_v4.PROBE_PROMPT.encode()), "userBytes": len(preview_v4.PROBE_PROMPT.encode()),
             "requestSha256": "b" * 64, "requestBytes": 900}
    requests["rows"][0]["sequence"] = 2; requests["rows"].insert(0, probe)
    assert derive(value)["checks"] == 9


def test_v4_rejects_rebound_snapshot_transition_instead_of_trusting_manifest_success(tmp_path):
    value = value_v4(tmp_path.resolve()); snap = value["observations"]["upgrade"]["snapshot"]
    manifest = json.loads(snap["manifestJson"]); manifest["transitionSha256"] = "0" * 64
    snap["manifestJson"] = json.dumps(manifest); snap["manifestSha256"] = preview_v4.sha(snap["manifestJson"].encode())
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_MANIFEST_TRANSITION"):
        derive(value)


def test_v4_rejects_modified_root_control_bytes_in_format_refusal(tmp_path):
    value = value_v4(tmp_path.resolve()); row = value["observations"]["formatProtection"]["host"]
    item = {"path": "ready-candidate.json", "size": "1", "sha256": "0" * 64}
    row["afterInventory"]["files"].append(item)
    row["afterInventory"]["totalBytes"] = str(int(row["afterInventory"]["totalBytes"]) + 1)
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_FORMAT_MODIFIED_DATA"):
        derive(value)


def test_v4_input_binder_uses_public_adoption_and_never_a_default_pointer(tmp_path):
    binding, documents = previous_input()
    for role, payload in documents.items():
        path = tmp_path / binding[role]["path"]; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(payload)
    pointer = tmp_path / ".tools/qt-candidates/last-local-sdk.json"
    pointer.parent.mkdir(parents=True); pointer.write_text("not JSON; must not be read")
    assert preview_v4.bind_previous(tmp_path, binding["model"]) == binding


def test_v4_saved_input_replay_never_accesses_original_installation(tmp_path):
    binding, documents = previous_input()
    for role, filename in preview_v4.INPUT_COPIES.items():
        (tmp_path / filename).write_bytes(documents[role])
    references = preview_v4.verify_saved_inputs(tmp_path, binding)
    assert len(references) == 3
    (tmp_path / preview_v4.INPUT_COPIES["runtimeMetadata"]).write_text("{}")
    with pytest.raises(preview.PreviewError, match="PREVIEW_V4_PREVIOUS_BYTES"):
        preview_v4.verify_saved_inputs(tmp_path, binding)


@pytest.mark.parametrize("version", ["v1", "v2", "v3"])
def test_v4_support_does_not_upgrade_historical_saved_proofs(tmp_path, version):
    factory = {"v1": report_value, "v2": report_value_v2, "v3": report_value_v3}[version]
    value = factory(tmp_path.resolve())
    proof = preview.verify_observations(value, expected_source=SOURCE, expected_candidate=value["candidate"],
        expected_build_sha=value["buildManifestSha256"], isolation_root=tmp_path.resolve(), expected_version=version)
    assert proof["contract"] == version and proof["checks"] == (7 if version == "v3" else 5)


def test_v4_saved_summary_binds_all_three_previous_documents_and_actual_stage_command(workspace):
    env = workspace; env.config = v4_config()
    spec, = stages.plan(env.root, env.report, env.config, env.environment, "gui", ["preview"])
    runtime = stages.load_runtime_config(env.report); directory = env.report / preview.STAGE
    build = env.root / runtime["candidateDirectory"] / "build.json"
    value = value_v4(env.scratch, candidate=build.parent.name, build_sha=preview_v4.sha(build.read_bytes()))
    save_observations(directory, value)
    _, documents = previous_input()
    for role, name in preview_v4.INPUT_COPIES.items():
        (directory / name).write_bytes(documents[role])
    row = {"previewIsolationRoot": str(env.scratch), "command": list(spec.command), "cwd": str(env.root)}
    observed = preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", row)
    assert len(observed["rawReportBinding"]) == 4 and observed["previewWorkspaceEvidence"]["checks"] == 9
    row["command"][-1] = "{}"
    with pytest.raises(preview.PreviewError, match="PREVIEW_STAGE_COMMAND_BINDING"):
        preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", row)


# Exercise the registration-prerequisite layer above the genuine v4 reader.
def _m2_saved_preview_prerequisite(env):
    from script.registered_run import registration, preview_v4_files
    from script import check_preview_upgrade as producer
    env.config = v4_config()
    spec, = stages.plan(env.root, env.report, env.config, env.environment, "gui", ["preview"])
    runtime = stages.load_runtime_config(env.report)
    directory = env.report / "preview-check"; directory.mkdir()
    build = env.root / runtime["candidateDirectory"] / "build.json"
    value = value_v4(env.scratch, candidate=build.parent.name, build_sha=preview_v4.sha(build.read_bytes()))
    assert preview_v4_files.write_current_bundle(directory, value, {"cleanup": "complete"}, write_json=producer.smoke.write_json)["passed"]
    _, documents = previous_input()
    for role, filename in preview_v4.INPUT_COPIES.items(): (directory / filename).write_bytes(documents[role])
    run = {"id": "preview-check", "command": list(spec.command), "cwd": str(env.root), "passed": True,
           "exitCode": 0, "state": "completed", "processGroupGone": True, "previewIsolationRoot": str(env.scratch)}
    observed = preview.verify_saved(RunContext(env.root, env.report, runtime), directory / "summary.json", run)
    record = {**observed, "reportRoot": str(directory), "summarySha256": preview_v4.sha((directory / "summary.json").read_bytes())}
    run["evidence"] = {"guiResults": {"preview-check": record}}
    (env.report / "preview-check.log").write_text(json.dumps({"reportRoot": str(directory), "passed": True}) + "\n")
    ledger = {"schema": "reverie.shared-run.ledger.v1", "kind": "local", "passed": True,
              "sourceHead": SOURCE, "sourceTreeHash": "b" * 40, "codeTreeHash": "c" * 40,
              "unitScratchRemoved": True, "ownedProcessesRemaining": 0, "unitIsolation": {"scratch": str(env.scratch)},
              "runtimeConfigBinding": registration._reference(env.root, env.report / "runtime-config.json"),
              "runs": [run], "guiResults": {"preview-check": record}}
    write_json(env.report / "run-ledger.json", ledger)
    row = {"sequence": 1, "outputDirectory": str(env.report), "sourceHead": SOURCE,
           "sourceTreeHash": "b" * 40, "codeTreeHash": "c" * 40}
    result = SimpleNamespace(env=env, directory=directory, runtime=runtime, ledger=ledger, row=row, observed=observed)
    baseline = _m2_call_preview_prerequisite(result)
    assert len(baseline["rawReports"]) == 13 and baseline["hostProofs"]["previewWorkspaceEvidence"]["checks"] == 9
    return result


def _m2_call_preview_prerequisite(value, version="v4"):
    from script.registered_run import registration
    return registration._gui_prerequisite(value.env.root, value.row, "preview", preview_workspace_contract=version,
        preview_upgrade_baseline=value.runtime.get("previewUpgradeBaseline"))


def _m2_observed_after_reader(value, monkeypatch, observed):
    # Baseline was fully read and accepted first. Hold that result fixed to
    # isolate the aggregator's independent path/hash guard (including races).
    from script.registered_run import registration
    monkeypatch.setattr(registration, "verify_preview_saved", lambda *_args, **_kwargs: observed)
    record = value.ledger["guiResults"]["preview-check"]
    record.update(observed)
    value.ledger["runs"][0]["evidence"]["guiResults"]["preview-check"] = record
    write_json(value.env.report / "run-ledger.json", value.ledger)


def test_m2_local_prerequisite_accepts_genuine_v4_evidence_one_level_subdirectory(workspace):
    value = _m2_saved_preview_prerequisite(workspace)
    proof = _m2_call_preview_prerequisite(value)
    root = value.directory
    nested = [row for row in proof["rawReports"] if (value.env.root / row["path"]).parent == root / "evidence"]
    assert len(nested) == 8 and len(proof["rawReports"]) == 13


@pytest.mark.parametrize("version", ["v1", "v2", "v3"])
def test_m2_local_prerequisite_never_allows_v4_subdirectory_for_older_contract(workspace, monkeypatch, version):
    from script.registered_run import registration
    value = _m2_saved_preview_prerequisite(workspace)
    observed = deepcopy(value.observed)
    runtime = deepcopy(value.runtime); runtime["previewWorkspaceContract"] = version
    runtime.pop("previewUpgradeBaseline", None)
    if version == "v3":
        runtime["previewWorkspaceChecks"] = list(preview.SCOPE_ADDITIONS)
    else:
        runtime.pop("previewWorkspaceChecks", None)
    runtime["timeoutsSeconds"]["preview-check"] = preview.TIMEOUT_SECONDS
    validate_config(runtime)
    write_json(value.env.report / "runtime-config.json", runtime)
    value.ledger["runtimeConfigBinding"] = registration._reference(value.env.root, value.env.report / "runtime-config.json")
    _m2_observed_after_reader(value, monkeypatch, observed)
    with pytest.raises(registration.RegistrationError, match="LOCAL_PREREQUISITE_REFERENCE_PARENT"):
        _m2_call_preview_prerequisite(value, version)


@pytest.mark.parametrize("location", ["deeper", "sibling", "outside"])
def test_m2_local_prerequisite_rejects_other_reference_parents(workspace, monkeypatch, location):
    from script.registered_run import registration
    value = _m2_saved_preview_prerequisite(workspace)
    observed = deepcopy(value.observed)
    target = next(row for row in observed["rawReportBinding"] if "/evidence/" in row["path"])
    source = value.env.root / target["path"]
    destinations = {"deeper": value.directory / "evidence/x/seed.json", "sibling": value.directory / "other/seed.json",
                    "outside": value.env.root / "outside-report/seed.json"}
    destination = destinations[location]; destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(source.read_bytes()); target["path"] = str(destination.relative_to(value.env.root))
    _m2_observed_after_reader(value, monkeypatch, observed)
    with pytest.raises(registration.RegistrationError, match="LOCAL_PREREQUISITE_REFERENCE_PARENT"):
        _m2_call_preview_prerequisite(value)


def test_m2_local_prerequisite_rehashes_subdirectory_file_after_reader(workspace, monkeypatch):
    from script.registered_run import registration
    value = _m2_saved_preview_prerequisite(workspace)
    observed = deepcopy(value.observed)
    target = next(row for row in observed["rawReportBinding"] if row["path"].endswith("/evidence/seed.json"))
    path = value.env.root / target["path"]; before = path.read_bytes()
    after = before.replace(b'"seed"', b'"seEd"', 1); assert len(after) == len(before) and after != before
    path.write_bytes(after)
    _m2_observed_after_reader(value, monkeypatch, observed)
    with pytest.raises(registration.RegistrationError, match="LOCAL_PREREQUISITE_REFERENCE_HASH_CHANGED:seed.json"):
        _m2_call_preview_prerequisite(value)
