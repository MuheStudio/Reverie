"""Real isolated desktop graphs survive both sides of the registry commit.

The child exits immediately after saving, then cold-starts the original and
edited identities in separate processes.  No chat/model request is issued.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def run_phase(root, phase, key):
    temporary = root / "tmp"
    cache = root / "cache"
    hf_home = cache / "huggingface"
    hub_cache = hf_home / "hub"
    transformer_cache = hf_home / "transformers"
    torch_home = cache / "torch"
    for path in (temporary, cache, hf_home, hub_cache, transformer_cache, torch_home):
        path.mkdir(parents=True, exist_ok=True)
    environment = {name: os.environ[name] for name in ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH") if name in os.environ}
    environment.update({"PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHON_DOTENV_DISABLED": "1",
        "REVERIE_BRIDGE_MODE": "1", "REVERIE_BRIDGE_PROTOCOL_VERSION": "4", "REVERIE_BRIDGE_SECRET": secrets.token_hex(32),
        "REVERIE_PARENT_PID": str(os.getpid()), "REVERIE_DATA_DIR": str(root / "data"),
        "TMPDIR": str(temporary), "TMP": str(temporary), "TEMP": str(temporary),
        "XDG_CACHE_HOME": str(cache), "HF_HOME": str(hf_home), "HF_HUB_CACHE": str(hub_cache),
        "HUGGINGFACE_HUB_CACHE": str(hub_cache), "TRANSFORMERS_CACHE": str(transformer_cache), "TORCH_HOME": str(torch_home),
        "REVERIE_LOCAL_MODE": "1", "REVERIE_LOCAL_MODE_EPOCH": "0", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    process = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()), phase, str(root)],
        input=key, capture_output=True, env=environment, cwd=ROOT, timeout=120, check=False)
    assert process.returncode == 0, process.stderr.decode("utf-8", errors="replace")[-5000:]


@pytest.mark.parametrize("commit_side,version", [("before", 1), ("after", 2)])
def test_real_remount_and_cold_starts_preserve_state_across_edit_crash(tmp_path, commit_side, version):
    root = tmp_path.resolve()
    (root / "data").mkdir()
    (root / "data/config.json").write_text(json.dumps({
        "llm": {"provider": "ollama", "model": "isolated-profile-model", "base_url": "http://127.0.0.1:9/v1"},
        "ui": {"mode": "mvp", "experience_mode": "core", "onboarding_completed": True},
    }), encoding="utf-8")
    key = os.urandom(32)
    phases = ["save_" + commit_side]
    if commit_side == "before":
        phases.append("restart_retry")
    for phase in (*phases, "restart_other", "restart_edited"):
        run_phase(root, phase, key)
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    assert [entry for entry in events if entry["event"] == "error"] == []
    states = {entry["label"]: entry for entry in events if entry["event"] == "state"}
    labels = {"saved_then_exit", "original_cold_start", "edited_remount", "edited_cold_start"}
    if commit_side == "before":
        labels.add("retry_after_restart")
        retry = states["retry_after_restart"]
        assert retry["current_unchanged"] is True and retry["orphan_reused"] is True
        assert retry["version"] == 2 and retry["writable"] is True and retry["recovery"] == "clean"
    assert set(states) == labels
    assert states["saved_then_exit"]["version"] == version
    assert states["saved_then_exit"]["live_unchanged"] is True
    for label in ("original_cold_start", "edited_remount", "edited_cold_start"):
        assert states[label]["writable"] is True
        assert states[label]["recovery"] == "clean"
    for label in ("edited_remount", "edited_cold_start"):
        assert states[label]["version"] == 2
        assert states[label]["state_preserved"] is True
        assert states[label]["anchors_current"] is True
    assert states["edited_remount"]["old_backup_code"] == "BACKUP_PERSONA_MISMATCH"


def child(phase, root):
    import logging
    import runpy
    sys.path.insert(0, str(ROOT))
    from src.storage.encrypted_sqlite import install_storage_key
    install_storage_key(sys.stdin.buffer.read(), require_encryption=True)

    def record(event, **fields):
        with (root / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, "phase": phase, **fields}, ensure_ascii=False) + "\n")

    class Errors(logging.Handler):
        def emit(self, entry):
            record("error", logger=entry.name, message=entry.getMessage()[:200])
    logging.getLogger().addHandler(Errors(level=logging.ERROR))

    from src.config.settings import DATA_DIR, PERSONA_DIR
    assert Path(DATA_DIR).resolve() == root / "data"
    from src.persona.identity import GLOBAL_PERSONA_EPOCH
    from src.persona.persona_card import default_persona
    from src.persona.profile_edit import commit_persona_profile_update, prepare_persona_profile_update, read_persona_profile
    from src.persona.sillytavern_import import initialize_default_persona, parse_sillytavern_json, save_imported_persona
    from tests.persona_profile_support import candidate_path, synthetic_card
    if phase.startswith("save_"):
        initialize_default_persona(PERSONA_DIR, default_persona())
        report = parse_sillytavern_json(synthetic_card())
        save_imported_persona(report, PERSONA_DIR)
        (root / "profile.json").write_text(json.dumps({"profile_id": report.card_id, "version": 2 if phase == "save_after" else 1}))
    expected = json.loads((root / "profile.json").read_text())
    target = expected["profile_id"]

    import src.mvp_runtime as runtime_module
    from src.bridge import ws_bridge

    class Endpoint:
        async def send(self, raw):
            pass

    async def composed(*, stdio, host, port, **kwargs):
        runtime = runtime_module.MvpDesktopRuntime(**kwargs)
        runtime_module._ACTIVE_DESKTOP_RUNTIME = runtime
        endpoint = Endpoint()
        ws_bridge._connections.add(endpoint)
        ws_bridge._client_contexts[endpoint] = ws_bridge.BridgeClientContext(client_id="isolated-lifecycle", protocol_version=4,
            authenticated=True, conversation_id="profile-lifecycle", persona_id=ws_bridge._active_persona_id())
        ws_bridge._controller_ws = endpoint

        def proof():
            return {"expected_" + key: value for key, value in ws_bridge._active_persona_scope().items()}

        async def switch(profile_id):
            result = await ws_bridge._commit_live_persona(endpoint, {"profile_id": profile_id,
                "confirmed_profile_id": profile_id, "identity_change_confirmed": True,
                "actor": "owner", "reason": "isolated edit lifecycle switch", **proof()})
            assert result["ok"] is True and result["activated"] is True and result["restart_required"] is False, result
            runtime.require_writable()

        def state(label, **extra):
            runtime.require_writable()
            record("state", label=label, writable=True, recovery=ws_bridge.recovery_status_payload()["recovery_state"], **extra)

        def retained_state():
            row = runtime._memory.store.catalog.get("synthetic-user-memory")
            diary = runtime._diary.load_entry("2026-10-20")
            chat = runtime._kernel_store.message_page("profile-lifecycle", persona_id=target)["items"]
            anchors = [row for row in runtime._memory.store.list_by_layer("permanent") if row.get("source_type") == "persona_identity"]
            fingerprint = ws_bridge.bridge_state.persona.identity_envelope.fingerprint
            return (row is not None and row["text"] == "合成用户长期记忆" and diary is not None
                and diary.content == "合成旧版本日记" and any(row["request_id"] == "synthetic-chat-before-edit" for row in chat),
                bool(anchors) and all(row["source_hash"] == fingerprint for row in anchors))

        try:
            if phase.startswith("save_"):
                await switch(target)
                runtime._memory.store.catalog.upsert(id="synthetic-user-memory", text="合成用户长期记忆",
                    retention_layer="permanent", cognitive_layer="semantic", timestamp=1792454400.0,
                    importance=0.8, emotions={}, embedding_model_version="isolated-no-model", source_type="local_interaction")
                from src.diary import DiaryEntry
                runtime._diary.save_entry(DiaryEntry(date="2026-10-20", title="合成日记", content="合成旧版本日记",
                    mood="peaceful", emotions={}, created_at="2026-10-20T00:00:00"))
                runtime._kernel_store.append_user_message(request_id="synthetic-chat-before-edit", conversation_id="profile-lifecycle",
                    persona_id=target, text="合成旧版本聊天")
                (root / "old-backup.json").write_text(json.dumps(runtime._backup_manager.export_payload(), ensure_ascii=False))
                await switch("default")
                token, model = GLOBAL_PERSONA_EPOCH.token(), ws_bridge.bridge_state.model_epoch
                cache = (PERSONA_DIR / "active.json").read_bytes()
                kernel_rows = [tuple(row) for row in runtime._kernel_store._connection.execute("SELECT * FROM personas ORDER BY persona_id")]
                current = read_persona_profile(PERSONA_DIR, target)
                def record_exit_boundary():
                    live_unchanged = (GLOBAL_PERSONA_EPOCH.token() == token and ws_bridge.bridge_state.model_epoch == model
                        and (PERSONA_DIR / "active.json").read_bytes() == cache
                        and [tuple(row) for row in runtime._kernel_store._connection.execute("SELECT * FROM personas ORDER BY persona_id")] == kernel_rows)
                    record("state", label="saved_then_exit", version=read_persona_profile(PERSONA_DIR, target)["identity_version"], live_unchanged=live_unchanged)
                if phase == "save_after":
                    result = await ws_bridge.handle_persona_profile_update({"profile_id": target,
                        "confirmed_profile_id": target, "identity_change_confirmed": True, "actor": "owner",
                        "reason": "isolated edit before process exit", "expected_identity_version": current["identity_version"],
                        "expected_identity_fingerprint": current["identity_fingerprint"], "fields": {"description": "升版后的合成正文。"}, **proof()}, endpoint)
                    assert result["ok"] is True, result
                else:
                    prepared = prepare_persona_profile_update(PERSONA_DIR, target, expected_identity_version=current["identity_version"],
                        expected_identity_fingerprint=current["identity_fingerprint"], fields={"description": "未提交的合成正文。"})
                    def fail(stage):
                        if stage == "before_registry_commit":
                            # Exit with the immutable orphan fully published,
                            # before the registry write or its error handler.
                            record_exit_boundary()
                            os._exit(0)
                    authorization = GLOBAL_PERSONA_EPOCH.authorize_update(actor="owner", reason="isolated crash boundary", user_confirmed=True)
                    GLOBAL_PERSONA_EPOCH.commit_inactive_update_with_commit(prepared.candidate, authorization,
                        lambda: commit_persona_profile_update(prepared, fault_hook=fail))
                    raise AssertionError("exit hook did not stop the registry commit")
                record_exit_boundary()
                # Deliberately skip graph cleanup and every post-save action.
                os._exit(0)
            elif phase == "restart_retry":
                # src.main has loaded the old active identity in this fresh
                # process. The RPC below must mint a fresh one-use capability.
                assert ws_bridge._active_persona_id() == default_persona().identity_envelope.persona_id
                runtime.require_writable()
                current = read_persona_profile(PERSONA_DIR, target)
                assert current["identity_version"] == 1 and current["active"] is False
                fields = {"description": "未提交的合成正文。"}
                prepared = prepare_persona_profile_update(PERSONA_DIR, target,
                    expected_identity_version=current["identity_version"],
                    expected_identity_fingerprint=current["identity_fingerprint"], fields=fields)
                orphan = candidate_path(prepared)
                old_bytes, old_info = orphan.read_bytes(), orphan.stat()
                token, model = GLOBAL_PERSONA_EPOCH.token(), ws_bridge.bridge_state.model_epoch
                cache = (PERSONA_DIR / "active.json").read_bytes()
                kernel_rows = [tuple(row) for row in runtime._kernel_store._connection.execute("SELECT * FROM personas ORDER BY persona_id")]
                result = await ws_bridge.handle_persona_profile_update({"profile_id": target,
                    "confirmed_profile_id": target, "identity_change_confirmed": True, "actor": "owner",
                    "reason": "isolated retry after process restart", "expected_identity_version": current["identity_version"],
                    "expected_identity_fingerprint": current["identity_fingerprint"], "fields": fields, **proof()}, endpoint)
                assert result["ok"] is True and result["identity_version"] == 2, result
                registry = json.loads((PERSONA_DIR / "registry.json").read_text())
                assert PERSONA_DIR / registry["profiles"][target]["persona_path"] == orphan
                after = orphan.stat()
                reused = (orphan.read_bytes() == old_bytes and
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) ==
                    (old_info.st_dev, old_info.st_ino, old_info.st_size, old_info.st_mtime_ns, old_info.st_ctime_ns))
                unchanged = (GLOBAL_PERSONA_EPOCH.token() == token and ws_bridge.bridge_state.model_epoch == model
                    and (PERSONA_DIR / "active.json").read_bytes() == cache
                    and [tuple(row) for row in runtime._kernel_store._connection.execute("SELECT * FROM personas ORDER BY persona_id")] == kernel_rows)
                state("retry_after_restart", version=2, orphan_reused=reused, current_unchanged=unchanged)
            elif phase == "restart_other":
                assert ws_bridge._active_persona_id() != target
                state("original_cold_start")
                await switch(target)
                preserved, anchors = retained_state()
                old_backup_code = "accepted"
                try:
                    runtime._backup_manager._validate_payload(json.loads((root / "old-backup.json").read_text()))
                except Exception as error:
                    old_backup_code = getattr(error, "code", type(error).__name__)
                state("edited_remount", version=ws_bridge.bridge_state.persona.identity_envelope.version,
                    state_preserved=preserved, anchors_current=anchors, old_backup_code=old_backup_code)
            else:
                assert ws_bridge._active_persona_id() == target
                preserved, anchors = retained_state()
                state("edited_cold_start", version=ws_bridge.bridge_state.persona.identity_envelope.version,
                    state_preserved=preserved, anchors_current=anchors)
        finally:
            await runtime.close()
            runtime_module._ACTIVE_DESKTOP_RUNTIME = None

    runtime_module.run_mvp_desktop = composed
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    runpy.run_module("src.main", run_name="__main__")


if __name__ == "__main__":
    child(sys.argv[1], Path(sys.argv[2]))
