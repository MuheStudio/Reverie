"""Switch commit boundaries and cold starts use only isolated synthetic data.

The process tests enter the real ``src.main`` composition root, use a temporary
SQLCipher key over stdin, and never request a model or a network connection.
"""
from __future__ import annotations

import asyncio
from contextlib import closing
import copy
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import stat
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
CRASH_EXIT = 73

# The same file is the isolated child entry point. Install its key before any
# project import there; normal pytest collection can reuse the signed fixtures.
if __name__ != "__main__":
    from src.persona import sillytavern_import as import_module
    from src.persona.identity import PersonaEpochRegistry, legacy_v1_identity_fingerprint
    from src.persona.persona_card import Persona, default_persona
    from tests.persona_profile_support import cipher_key, profile_env, scope_proof


def synthetic_card(name="切换缓存合成人格"):
    return json.dumps({"spec": "chara_card_v2", "spec_version": "2.0", "data": {
        "name": name, "description": "年龄：24。只在隔离切换测试中出现。", "personality": "安静，认真",
        "scenario": "隔离测试观景室", "first_mes": "你好。", "mes_example": "",
        "creator_notes": "", "system_prompt": "", "post_history_instructions": "",
        "alternate_greetings": [], "tags": [], "creator": "", "character_version": "", "extensions": {},
    }}, ensure_ascii=False)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sealed_identity(persona):
    envelope = persona.identity_envelope
    return envelope.persona_id, envelope.fingerprint, envelope.version


@pytest.fixture
def switch_store(tmp_path):
    root = tmp_path / "persona"
    builtin = default_persona()
    import_module.initialize_default_persona(root, builtin)
    report = import_module.parse_sillytavern_json(synthetic_card())
    import_module.save_imported_persona(report, root)
    epochs = PersonaEpochRegistry()
    epochs.activate_initial(builtin)
    return root, builtin, report, epochs


def activate(root, report, epochs):
    authorization = epochs.authorize_update(actor="owner", reason="isolated switch cache test", user_confirmed=True)
    return epochs.activate_update_with_commit(report.persona, authorization,
        lambda: import_module.activate_imported_persona(root, report.card_id,
            expected_fingerprint=report.persona.identity_envelope.fingerprint))


def test_switch_removes_cache_and_syncs_directory_before_registry_commit(switch_store, monkeypatch):
    root, _builtin, report, epochs = switch_store
    events = []
    original_write = import_module._atomic_json_write
    original_sync = import_module._sync_persona_directory

    def observe_write(path, value):
        if path == root / "registry.json":
            assert not (root / "active.json").exists()
            events.append("registry_write")
        elif path == root / "active.json":
            events.append("cache_write")
        return original_write(path, value)

    def observe_sync(path):
        assert Path(path) == root
        assert not (root / "active.json").exists()
        current = json.loads((root / "registry.json").read_text())["active_id"]
        events.append("clear_sync" if current == "default" else "registry_sync")
        return original_sync(path)

    monkeypatch.setattr(import_module, "_atomic_json_write", observe_write)
    monkeypatch.setattr(import_module, "_sync_persona_directory", observe_sync)
    _token, result = activate(root, report, epochs)
    assert result["ok"] is True
    assert events == ["clear_sync", "registry_write", "registry_sync", "cache_write"]


@pytest.mark.parametrize("failure", ["unlink", "clear_directory_sync", "registry_temp_write",
                                   "registry_temp_sync", "registry_replace"])
def test_each_precommit_failure_preserves_registry_and_epoch(switch_store, monkeypatch, failure):
    root, builtin, report, epochs = switch_store
    registry_path, active_path = root / "registry.json", root / "active.json"
    registry_before, cache_before, token_before = registry_path.read_bytes(), active_path.read_bytes(), epochs.token()
    injected = OSError("synthetic precommit failure")
    reached = []

    def fail():
        reached.append(failure)
        raise injected

    if failure == "unlink":
        original = Path.unlink

        def unlink(path, *args, **kwargs):
            if path == active_path:
                fail()
            return original(path, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", unlink)
    elif failure == "clear_directory_sync":
        monkeypatch.setattr(import_module, "_sync_persona_directory", lambda _path: fail())
    elif failure == "registry_temp_write":
        original = import_module.json.dump

        def dump(value, stream, *args, **kwargs):
            if Path(stream.name).name.startswith(".registry.json."):
                fail()
            return original(value, stream, *args, **kwargs)

        monkeypatch.setattr(import_module.json, "dump", dump)
    elif failure == "registry_temp_sync":
        original = import_module.os.fsync

        def fsync(fd):
            if stat.S_ISREG(os.fstat(fd).st_mode):
                fail()
            return original(fd)

        monkeypatch.setattr(import_module.os, "fsync", fsync)
    else:
        original = import_module.os.replace

        def replace(source, destination):
            if Path(destination) == registry_path:
                fail()
            return original(source, destination)

        monkeypatch.setattr(import_module.os, "replace", replace)

    authorization = epochs.authorize_update(actor="owner", reason="isolated precommit failure", user_confirmed=True)
    with pytest.raises((OSError, import_module.CharacterCardImportError)) as caught:
        epochs.activate_update_with_commit(report.persona, authorization,
            lambda: import_module.activate_imported_persona(root, report.card_id))
    assert reached == [failure]
    if failure in {"unlink", "clear_directory_sync"}:
        assert caught.value.code == "active_cache_clear_failed"
        assert caught.value.__cause__ is injected
    else:
        assert caught.value is injected  # Preserve the original OSError, including its identity.
    assert registry_path.read_bytes() == registry_before
    assert epochs.token() == token_before
    assert sealed_identity(import_module.load_active_persona(root)) == sealed_identity(builtin)
    if failure == "unlink":
        assert active_path.read_bytes() == cache_before
    else:
        assert not active_path.exists()
    assert list(root.glob(".registry.json.*.tmp")) == []
    with pytest.raises(PermissionError, match="reused"):
        epochs.activate_update_with_commit(report.persona, authorization, lambda: pytest.fail("replayed callback"))


@pytest.mark.parametrize("target_kind", ["ordinary", "legacy_builtin"])
def test_live_cache_unlink_failure_uses_callback_entry_registry_baseline(profile_env, monkeypatch, target_kind):
    from src.bridge import ws_bridge

    env = profile_env
    target = env.profile_id
    if target_kind == "legacy_builtin":
        authorization = env.epochs.authorize_update(actor="owner", reason="isolated setup switch", user_confirmed=True)
        token, _result = env.epochs.activate_update_with_commit(env.report.persona, authorization,
            lambda: import_module.activate_imported_persona(env.persona_dir, env.profile_id))
        monkeypatch.setattr(ws_bridge.bridge_state, "persona", env.report.persona)
        monkeypatch.setattr(ws_bridge.bridge_state, "persona_epoch", token.epoch)
        target = "default"
        registry = json.loads((env.persona_dir / "registry.json").read_text())
        legacy = legacy_v1_identity_fingerprint(env.builtin)
        assert legacy in import_module.KNOWN_LEGACY_DEFAULT_FINGERPRINTS
        assert legacy != env.builtin.identity_envelope.fingerprint
        registry["profiles"][target]["identity_fingerprint"] = legacy
        write_json(env.persona_dir / "registry.json", registry)

    registry_path, active_path = env.persona_dir / "registry.json", env.persona_dir / "active.json"
    call_before = registry_path.read_bytes()
    parsed_before = json.loads(call_before)
    cache_before = active_path.read_bytes()
    token_before, model_before = env.epochs.token(), ws_bridge.bridge_state.model_epoch
    restart_before, persona_before = ws_bridge.bridge_state.persona_restart_required, ws_bridge.bridge_state.persona
    callback_entries, authorizations = [], []
    original_activate, original_unlink = import_module.activate_imported_persona, Path.unlink
    original_authorize = env.epochs.authorize_update

    def callback_entry(*args, **kwargs):
        callback_entries.append(registry_path.read_bytes())
        return original_activate(*args, **kwargs)

    def authorize(**kwargs):
        capability = original_authorize(**kwargs)
        authorizations.append(capability)
        return capability

    def unlink(path, *args, **kwargs):
        if path == active_path:
            raise OSError("synthetic active cache unlink denied")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(import_module, "activate_imported_persona", callback_entry)
    monkeypatch.setattr(env.epochs, "authorize_update", authorize)
    monkeypatch.setattr(Path, "unlink", unlink)
    result = asyncio.run(ws_bridge._commit_live_persona(env.endpoint, {
        "profile_id": target, "confirmed_profile_id": target, "identity_change_confirmed": True,
        "actor": "owner", "reason": "isolated layered failure assertions", **scope_proof(),
    }))
    assert result["ok"] is False and result["code"] == "active_cache_clear_failed"
    assert len(callback_entries) == 1
    assert registry_path.read_bytes() == callback_entries[0]
    after = json.loads(registry_path.read_bytes())
    assert after["active_id"] == parsed_before["active_id"]
    assert {key: value for key, value in after["profiles"].items() if key != target} == {
        key: value for key, value in parsed_before["profiles"].items() if key != target}
    if target_kind == "ordinary":
        assert registry_path.read_bytes() == call_before
    else:
        expected = copy.deepcopy(parsed_before)
        envelope = env.builtin.identity_envelope
        expected["profiles"][target].update(identity_fingerprint=envelope.fingerprint,
            persona_id=envelope.persona_id, identity_version=envelope.version)
        assert after == expected and registry_path.read_bytes() != call_before
    assert active_path.read_bytes() == cache_before
    assert env.epochs.token() == token_before
    assert ws_bridge.bridge_state.model_epoch == model_before
    assert ws_bridge.bridge_state.persona_restart_required is restart_before
    assert ws_bridge.bridge_state.persona is persona_before
    assert len(authorizations) == 1
    candidate = env.builtin if target == "default" else env.report.persona
    with pytest.raises(PermissionError, match="reused"):
        env.epochs.activate_update_with_commit(candidate, authorizations[0], lambda: pytest.fail("replayed callback"))


@pytest.mark.parametrize("rewrite_fails", [False, True])
def test_registered_stale_cache_heals_only_to_authority_and_logs_both_identities(switch_store, monkeypatch, caplog, rewrite_fails):
    root, builtin, report, _epochs = switch_store
    registry_path, active_path = root / "registry.json", root / "active.json"
    registry = json.loads(registry_path.read_text())
    registry["active_id"] = report.card_id
    write_json(registry_path, registry)
    registry_before, cache_before = registry_path.read_bytes(), active_path.read_bytes()
    original = import_module._atomic_json_write
    loads, writes = [], []
    original_load = import_module._load_profile_persona

    def load(*args):
        loads.append(args[2])
        return original_load(*args)

    def write(path, value):
        writes.append(path)
        if rewrite_fails and path == active_path:
            raise OSError("synthetic cache healing write denied")
        return original(path, value)

    monkeypatch.setattr(import_module, "_load_profile_persona", load)
    monkeypatch.setattr(import_module, "_atomic_json_write", write)
    with caplog.at_level(logging.WARNING):
        loaded = import_module.load_active_persona(root)
    assert sealed_identity(loaded) == sealed_identity(report.persona)
    assert loads == [report.card_id]  # Never load/upgrade the other registered persona to make a match.
    assert writes == [active_path]
    assert registry_path.read_bytes() == registry_before
    if rewrite_fails:
        assert active_path.read_bytes() == cache_before
    else:
        assert sealed_identity(import_module._load_persona_file(active_path)) == sealed_identity(loaded)
    warning_records = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warning_records) == 1
    warnings = warning_records[0].getMessage()
    for envelope in (builtin.identity_envelope, report.persona.identity_envelope):
        assert envelope.persona_id in warnings and envelope.fingerprint[:16] in warnings
    if rewrite_fails:
        assert "OSError" in warnings


@pytest.mark.parametrize("case,code", [
    ("unregistered", "active_cache_conflict"), ("old_version", "active_cache_conflict"),
    ("authority_missing", "active_cache_conflict"), ("authority_changed", "active_cache_conflict"),
    ("corrupt_cache", "active_cache_corrupt"), ("forged_persona_id", "active_cache_conflict"),
])
def test_cache_healing_keeps_unsafe_mismatches_fail_closed(switch_store, case, code):
    root, builtin, report, _epochs = switch_store
    registry_path, active_path = root / "registry.json", root / "active.json"
    registry = json.loads(registry_path.read_text())
    write_json(active_path, report.persona.to_dict())
    if case == "unregistered":
        foreign = import_module.parse_sillytavern_json(synthetic_card("从未登记的合成人格"))
        write_json(active_path, foreign.persona.to_dict())
    elif case == "old_version":
        data = report.persona.to_dict()
        data["identity"]["identity_version"] += 1
        data["identity"]["description"] += "新版合成正文。"
        latest = Persona(**data)
        envelope = latest.seal_identity()
        entry = registry["profiles"][report.card_id]
        entry.update(identity_fingerprint=envelope.fingerprint, persona_id=envelope.persona_id,
                     identity_version=envelope.version)
        write_json(root / entry["persona_path"], latest.to_dict())
        write_json(registry_path, registry)
        assert envelope.fingerprint != report.persona.identity_envelope.fingerprint
    elif case == "authority_missing":
        (root / registry["profiles"]["default"]["persona_path"]).unlink()
    elif case == "authority_changed":
        write_json(root / registry["profiles"]["default"]["persona_path"], report.persona.to_dict())
    elif case == "corrupt_cache":
        active_path.write_bytes(b"{synthetic-truncated-cache")
    elif case == "forged_persona_id":
        registry["profiles"][report.card_id]["persona_id"] = builtin.identity_envelope.persona_id
        write_json(registry_path, registry)
    before = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
    with pytest.raises(import_module.CharacterCardImportError) as caught:
        import_module.load_active_persona(root)
    assert caught.value.code == code
    assert {path: path.read_bytes() for path in root.rglob("*") if path.is_file()} == before


def test_stale_cache_does_not_upgrade_another_legacy_builtin_to_match(switch_store, monkeypatch):
    root, builtin, report, _epochs = switch_store
    registry_path = root / "registry.json"
    registry = json.loads(registry_path.read_text())
    registry["active_id"] = report.card_id
    legacy = legacy_v1_identity_fingerprint(builtin)
    assert legacy in import_module.KNOWN_LEGACY_DEFAULT_FINGERPRINTS
    registry["profiles"]["default"]["identity_fingerprint"] = legacy
    write_json(registry_path, registry)
    before = registry_path.read_bytes()
    loads = []
    original = import_module._load_profile_persona

    def load(*args):
        loads.append(args[2])
        return original(*args)

    monkeypatch.setattr(import_module, "_load_profile_persona", load)
    with pytest.raises(import_module.CharacterCardImportError) as caught:
        import_module.load_active_persona(root)
    assert caught.value.code == "active_cache_conflict"
    assert loads == [report.card_id]
    assert registry_path.read_bytes() == before
    assert sealed_identity(import_module._load_persona_file(root / "active.json")) == sealed_identity(builtin)


def prepare_runtime_root(root):
    (root / "data").mkdir()
    write_json(root / "data/config.json", {
        "llm": {"provider": "ollama", "model": "isolated-switch-cache-model", "base_url": "http://127.0.0.1:9/v1"},
        "ui": {"mode": "mvp", "experience_mode": "core", "onboarding_completed": True},
    })


def run_phase(root, phase, key, *, expected_code=0):
    temporary, cache = root / "tmp", root / "cache"
    hf_home = cache / "huggingface"
    hub_cache, transformer_cache, torch_home = hf_home / "hub", hf_home / "transformers", cache / "torch"
    for path in (temporary, cache, hf_home, hub_cache, transformer_cache, torch_home):
        path.mkdir(parents=True, exist_ok=True)
    environment = {name: os.environ[name] for name in ("HOME", "USER", "LOGNAME", "LANG", "PATH") if name in os.environ}
    environment.update({"PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHON_DOTENV_DISABLED": "1",
        "REVERIE_BRIDGE_MODE": "1", "REVERIE_BRIDGE_PROTOCOL_VERSION": "4", "REVERIE_BRIDGE_SECRET": secrets.token_hex(32),
        "REVERIE_PARENT_PID": str(os.getpid()), "REVERIE_DATA_DIR": str(root / "data"),
        "TMPDIR": str(temporary), "TMP": str(temporary), "TEMP": str(temporary), "XDG_CACHE_HOME": str(cache),
        "HF_HOME": str(hf_home), "HF_HUB_CACHE": str(hub_cache), "HUGGINGFACE_HUB_CACHE": str(hub_cache),
        "TRANSFORMERS_CACHE": str(transformer_cache), "TORCH_HOME": str(torch_home),
        "REVERIE_LOCAL_MODE": "1", "REVERIE_LOCAL_MODE_EPOCH": "0", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    process = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()), phase, str(root)],
        input=key, capture_output=True, env=environment, cwd=ROOT, timeout=120, check=False)
    assert process.returncode == expected_code, process.stderr.decode("utf-8", errors="replace")[-5000:]


@pytest.mark.parametrize("boundary,expected_profile", [
    ("after_clear", "default"), ("after_registry", "target"),
    ("cache_write_failure", "target"), ("registry_sync_failure", "target"),
])
def test_real_process_switch_boundaries_cold_start_correct_identity_and_can_write(tmp_path, boundary, expected_profile):
    root = tmp_path.resolve()
    prepare_runtime_root(root)
    key = os.urandom(32)
    run_phase(root, "fault_" + boundary, key, expected_code=CRASH_EXIT)
    run_phase(root, "restart_" + boundary, key)
    identities = json.loads((root / "identities.json").read_text())
    expected = identities[expected_profile]
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    assert [entry for entry in events if entry["event"] == "error"] == []
    exits = [entry for entry in events if entry["event"] == "exit_boundary"]
    assert len(exits) == 1 and exits[0]["boundary"] == boundary
    assert exits[0]["active_id"] == expected["profile_id"]
    assert exits[0]["cache_exists"] is (boundary == "registry_sync_failure")
    restarted = [entry for entry in events if entry["event"] == "state" and entry["label"] == "cold_start"]
    assert len(restarted) == 1
    assert restarted[0]["persona_id"] == expected["persona_id"]
    assert restarted[0]["fingerprint"] == expected["fingerprint"]
    assert restarted[0]["writable"] is True and restarted[0]["recovery"] == "clean"
    if boundary in {"cache_write_failure", "registry_sync_failure"}:
        switched = next(entry for entry in events if entry["event"] == "state" and entry["label"] == "switch_succeeded")
        assert switched["epoch_advanced"] is True and switched["model_advanced"] is True
        assert switched["activated"] is True and switched["restart_required"] is False
        assert "OSError" in switched["warning"]


@pytest.mark.parametrize("rewrite_fails", [False, True])
def test_real_self_heal_kernel_state_journal_and_later_switch_survive_restart(tmp_path, rewrite_fails):
    root = tmp_path.resolve()
    prepare_runtime_root(root)
    key = os.urandom(32)
    run_phase(root, "heal_write_failure" if rewrite_fails else "heal", key)
    run_phase(root, "restart_after_heal", key)
    identities = json.loads((root / "identities.json").read_text())
    events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
    assert [entry for entry in events if entry["event"] == "error"] == []
    states = {entry["label"]: entry for entry in events if entry["event"] == "state"}
    assert set(states) == {"healed_start", "switched_again", "cold_start"}
    for entry in states.values():
        assert entry["writable"] is True and entry["recovery"] == "clean"
        assert entry["kernel_matches"] is True and entry["journal_matches"] is True
        assert entry["state_scoped"] is True
    assert states["healed_start"]["persona_id"] == identities["target"]["persona_id"]
    assert states["healed_start"]["cache_current"] is (not rewrite_fails)
    assert states["switched_again"]["persona_id"] == identities["default"]["persona_id"]
    assert states["cold_start"]["persona_id"] == identities["default"]["persona_id"]
    assert states["cold_start"]["prior_write_preserved"] is True
    warnings = "\n".join(entry["message"] for entry in events if entry["event"] == "warning")
    for identity in identities.values():
        assert identity["persona_id"] in warnings and identity["fingerprint"][:16] in warnings
    if rewrite_fails:
        assert "OSError" in warnings


def child(phase, root):
    import runpy

    sys.path.insert(0, str(ROOT))
    from src.storage.encrypted_sqlite import install_storage_key
    install_storage_key(sys.stdin.buffer.read(), require_encryption=True)

    def record(event, **fields):
        with (root / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, "phase": phase, **fields}, ensure_ascii=False) + "\n")

    class Capture(logging.Handler):
        def emit(self, entry):
            if entry.levelno >= logging.ERROR:
                record("error", logger=entry.name, message=entry.getMessage()[:250])
            elif entry.levelno >= logging.WARNING:
                record("warning", logger=entry.name, message=entry.getMessage()[:600])

    logging.getLogger().addHandler(Capture(level=logging.WARNING))
    from src.config.settings import DATA_DIR, PERSONA_DIR
    assert Path(DATA_DIR).resolve() == root / "data"
    from src.persona import sillytavern_import as importer
    from src.persona.identity import GLOBAL_PERSONA_EPOCH
    from src.persona.persona_card import default_persona as builtin_persona
    from src.world_state_store import WorldStateStore

    registry_path, active_path = PERSONA_DIR / "registry.json", PERSONA_DIR / "active.json"
    original_write = importer._atomic_json_write
    if phase.startswith("fault_") or phase in {"heal", "heal_write_failure"}:
        builtin = builtin_persona()
        importer.initialize_default_persona(PERSONA_DIR, builtin)
        report = importer.parse_sillytavern_json(synthetic_card())
        importer.save_imported_persona(report, PERSONA_DIR)
        identities = {name: {"profile_id": profile_id, "persona_id": persona.identity_envelope.persona_id,
            "fingerprint": persona.identity_envelope.fingerprint} for name, profile_id, persona in (
                ("default", "default", builtin), ("target", report.card_id, report.persona))}
        write_json(root / "identities.json", identities)
        if phase.startswith("heal"):
            registry = json.loads(registry_path.read_text())
            registry["active_id"] = report.card_id
            write_json(registry_path, registry)
            if phase == "heal_write_failure":
                def startup_write(path, value):
                    if path == active_path:
                        raise OSError("synthetic startup cache rewrite failure")
                    return original_write(path, value)
                importer._atomic_json_write = startup_write
    identities = json.loads((root / "identities.json").read_text())

    import src.mvp_runtime as runtime_module
    from src.bridge import ws_bridge

    class Endpoint:
        async def send(self, raw):
            pass

    def exit_boundary(boundary):
        record("exit_boundary", boundary=boundary,
            active_id=json.loads(registry_path.read_text())["active_id"], cache_exists=active_path.exists())
        os._exit(CRASH_EXIT)

    async def composed(*, stdio, host, port, **kwargs):
        importer._atomic_json_write = original_write  # Startup-only rewrite failure cannot affect the later switch.
        runtime = runtime_module.MvpDesktopRuntime(**kwargs)
        runtime_module._ACTIVE_DESKTOP_RUNTIME = runtime
        endpoint = Endpoint()
        ws_bridge._connections.add(endpoint)
        ws_bridge._client_contexts[endpoint] = ws_bridge.BridgeClientContext(client_id="isolated-switch-cache", protocol_version=4,
            authenticated=True, conversation_id="switch-cache-runtime", persona_id=ws_bridge._active_persona_id())
        ws_bridge._controller_ws = endpoint

        async def switch(profile_id):
            result = await ws_bridge._commit_live_persona(endpoint, {"profile_id": profile_id,
                "confirmed_profile_id": profile_id, "identity_change_confirmed": True, "actor": "owner",
                "reason": "isolated switch cache runtime", **{
                    "expected_" + key: value for key, value in ws_bridge._active_persona_scope().items()}})
            assert result["ok"] is True and result["activated"] is True and result["restart_required"] is False, result
            runtime.require_writable()
            return result

        def state(label, *, prior_write=False, **extra):
            runtime.require_writable()
            token = GLOBAL_PERSONA_EPOCH.token()
            envelope = ws_bridge.bridge_state.persona.identity_envelope
            kernel = runtime._kernel_store
            current = kernel.active_persona()
            assert current is not None
            assert (current.persona_id, current.epoch, current.fingerprint) == (token.persona_id, token.epoch, token.fingerprint)
            assert kernel.integrity_check() == "ok"
            state_root = root / "data/personas" / hashlib.sha256(token.persona_id.encode()).hexdigest()
            manifest = json.loads((state_root / "persona-state.json").read_text())
            assert manifest["persona_id"] == token.persona_id
            for module in ("memory", "restore"):
                marker = json.loads((state_root / module / ".persona-scope").read_text())
                assert marker["persona_id"] == token.persona_id and marker["module"] == module
            journal = runtime._backup_manager.state_store
            assert journal.path == state_root / "restore/restore.sqlite3"
            expected_identity = {"persona_id": token.persona_id, "fingerprint": token.fingerprint,
                                 "identity_version": envelope.version}
            assert journal.persona_identity == expected_identity
            with closing(journal._connect(read_only=True)) as connection:
                bound = connection.execute("SELECT identity FROM recovery_identity WHERE singleton=1").fetchone()
                assert json.loads(bound[0]) == expected_identity
            assert journal.pending_restore() is None and WorldStateStore.peek_pending(journal.path) is None
            assert runtime._backup_manager.recovery_status()["state"] == "clean"
            assert ws_bridge.recovery_status_payload()["recovery_state"] == "clean"
            if prior_write:
                history = kernel.message_page("switch-cache-runtime", persona_id=token.persona_id)["items"]
                assert any(row["request_id"] == "switch-cache-switched-again" for row in history)
            request_id = "switch-cache-switched-again" if label == "switched_again" else "switch-cache-" + phase + "-" + label
            assert kernel.append_user_message(request_id=request_id, conversation_id="switch-cache-runtime",
                persona_id=token.persona_id, text="合成可写性证据") is True
            history = kernel.message_page("switch-cache-runtime", persona_id=token.persona_id)["items"]
            assert any(row["request_id"] == request_id for row in history)
            cache_current = (active_path.exists() and importer._load_persona_file(active_path).identity_envelope.fingerprint == token.fingerprint)
            record("state", label=label, persona_id=token.persona_id, fingerprint=token.fingerprint,
                writable=True, recovery="clean", kernel_matches=True, state_scoped=True, journal_matches=True,
                cache_current=cache_current, prior_write_preserved=prior_write, **extra)

        try:
            if phase.startswith("fault_"):
                boundary = phase.removeprefix("fault_")
                original_sync = importer._sync_persona_directory
                sync_count = 0
                cache_failures = []

                def sync(path):
                    nonlocal sync_count
                    sync_count += 1
                    if boundary == "registry_sync_failure" and sync_count == 2:
                        raise OSError("synthetic committed registry directory sync failure")
                    original_sync(path)
                    if boundary == "after_clear" and sync_count == 1:
                        exit_boundary(boundary)

                def write(path, value):
                    if path == active_path and boundary == "cache_write_failure":
                        cache_failures.append(True)
                        raise OSError("synthetic postcommit active cache write failure")
                    original_write(path, value)
                    if path == registry_path and boundary == "after_registry":
                        exit_boundary(boundary)

                importer._sync_persona_directory, importer._atomic_json_write = sync, write
                before, model_before = GLOBAL_PERSONA_EPOCH.token(), ws_bridge.bridge_state.model_epoch
                result = await switch(identities["target"]["profile_id"])
                after = GLOBAL_PERSONA_EPOCH.token()
                assert after.epoch == before.epoch + 1 and after.persona_id == identities["target"]["persona_id"]
                assert ws_bridge.bridge_state.model_epoch == model_before + 1
                assert "OSError" in result["warning"]
                if boundary == "cache_write_failure":
                    assert cache_failures == [True] and not active_path.exists()
                else:
                    assert boundary == "registry_sync_failure" and sync_count == 2
                    assert "registry" in result["warning"]
                    assert importer._load_persona_file(active_path).identity_envelope.fingerprint == after.fingerprint
                state("switch_succeeded", epoch_advanced=True, model_advanced=True, activated=result["activated"],
                    restart_required=result["restart_required"], warning=result["warning"])
                exit_boundary(boundary)
            elif phase in {"heal", "heal_write_failure"}:
                assert ws_bridge._active_persona_id() == identities["target"]["persona_id"]
                state("healed_start")
                await switch("default")
                state("switched_again")
            else:
                expected = identities["default"] if phase in {"restart_after_clear", "restart_after_heal"} else identities["target"]
                assert ws_bridge._active_persona_id() == expected["persona_id"]
                state("cold_start", prior_write=phase == "restart_after_heal")
        finally:
            await runtime.close()
            runtime_module._ACTIVE_DESKTOP_RUNTIME = None

    runtime_module.run_mvp_desktop = composed
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    runpy.run_module("src.main", run_name="__main__")


if __name__ == "__main__":
    child(sys.argv[1], Path(sys.argv[2]))
