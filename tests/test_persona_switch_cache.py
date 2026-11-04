"""Isolated checks for switch-cache ordering and sealed-cache recovery."""
from __future__ import annotations

import json
import logging
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.persona import sillytavern_import as importer
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import Persona, default_persona


def _card(name):
    return json.dumps({"spec": "chara_card_v2", "spec_version": "2.0", "data": {
        "name": name, "description": "年龄：24。喜欢画画的合成角色。", "personality": "温柔，谨慎",
        "scenario": "隔离测试中的观景室", "first_mes": "你好。", "mes_example": "用户：你好。",
        "creator_notes": "合成来源", "system_prompt": "", "post_history_instructions": "",
        "alternate_greetings": [], "tags": ["合成"], "creator": "隔离测试",
        "character_version": "source-1", "extensions": {},
    }}, ensure_ascii=False)


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _registry(env):
    return json.loads(env.registry.read_text(encoding="utf-8"))


@pytest.fixture
def switch_env(tmp_path):
    root = tmp_path / "isolated-persona"
    builtin = default_persona()
    importer.initialize_default_persona(root, builtin)
    target = importer.parse_sillytavern_json(_card("缓存测试·晴"))
    other = importer.parse_sillytavern_json(_card("缓存测试·月"))
    importer.save_imported_persona(target, root)
    importer.save_imported_persona(other, root)
    epochs = PersonaEpochRegistry()
    epochs.activate_initial(builtin)
    return SimpleNamespace(root=root, registry=root / "registry.json", cache=root / "active.json",
                           builtin=builtin, target=target, other=other, epochs=epochs)


def _authorized_switch(env, profile_id=None):
    profile_id = profile_id or env.target.card_id
    candidate = importer.load_imported_persona(env.root, profile_id)
    authorization = env.epochs.authorize_update(
        actor="owner", reason="隔离切换缓存测试", user_confirmed=True,
    )
    return env.epochs.activate_update_with_commit(candidate, authorization,
        lambda: importer.activate_imported_persona(env.root, profile_id,
            expected_fingerprint=candidate.identity_envelope.fingerprint))


def _stale_cache(env, persona):
    _authorized_switch(env)
    _write_json(env.cache, persona.to_dict())


@pytest.mark.parametrize("cache_exists", [True, False])
def test_switch_clears_cache_and_syncs_in_commit_order(switch_env, monkeypatch, cache_exists):
    env = switch_env
    if not cache_exists:
        env.cache.unlink()
    old_epoch = env.epochs.token().epoch
    events = []
    real_write = importer._atomic_json_write
    real_sync = importer._sync_persona_directory
    real_unlink = Path.unlink

    def unlink(path, *args, **kwargs):
        if path == env.cache:
            events.append("cache_unlink")
        return real_unlink(path, *args, **kwargs)

    def write(path, value):
        if path == env.registry:
            assert not env.cache.exists()
            events.append("registry_commit")
        elif path == env.cache:
            assert _registry(env)["active_id"] == env.target.card_id
            events.append("cache_write")
        return real_write(path, value)

    def sync(root):
        assert root == env.root
        assert not env.cache.exists()
        events.append("directory_after_commit" if _registry(env)["active_id"] == env.target.card_id
                      else "directory_after_clear")
        return real_sync(root)

    monkeypatch.setattr(Path, "unlink", unlink)
    monkeypatch.setattr(importer, "_atomic_json_write", write)
    monkeypatch.setattr(importer, "_sync_persona_directory", sync)
    token, result = _authorized_switch(env)

    expected = ["registry_commit", "directory_after_commit", "cache_write"]
    if cache_exists:
        expected = ["cache_unlink", "directory_after_clear", *expected]
    assert events == expected
    assert result["ok"] is True and "warning" not in result
    assert token.epoch == old_epoch + 1
    assert token.fingerprint == env.target.persona.identity_envelope.fingerprint
    assert importer.load_active_persona(env.root).to_dict() == env.target.persona.to_dict()


@pytest.mark.parametrize("failure", ["fingerprint", "authorization"])
def test_validation_and_authorization_precede_cache_removal(switch_env, monkeypatch, failure):
    env = switch_env
    before = env.registry.read_bytes(), env.cache.read_bytes(), env.epochs.token()

    def unexpected_sync(root):
        pytest.fail("Rejected activation reached directory refresh")

    monkeypatch.setattr(importer, "_sync_persona_directory", unexpected_sync)
    expected_error = importer.CharacterCardImportError if failure == "fingerprint" else PermissionError
    with pytest.raises(expected_error) as caught:
        importer.activate_imported_persona(env.root, env.target.card_id,
            expected_fingerprint="0" * 64 if failure == "fingerprint" else "")
    if failure == "fingerprint":
        assert caught.value.code == "identity_conflict"
    assert (env.registry.read_bytes(), env.cache.read_bytes(), env.epochs.token()) == before


def test_cache_unlink_failure_preserves_identity_and_consumes_authorization(switch_env, monkeypatch):
    env = switch_env
    candidate = importer.load_imported_persona(env.root, env.target.card_id)
    authorization = env.epochs.authorize_update(
        actor="owner", reason="隔离删缓存失败", user_confirmed=True,
    )
    before = env.registry.read_bytes(), env.cache.read_bytes(), env.epochs.token()
    fault = OSError("injected cache unlink failure")
    real_unlink = Path.unlink

    def unlink(path, *args, **kwargs):
        if path == env.cache:
            raise fault
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    callback = lambda: importer.activate_imported_persona(env.root, env.target.card_id)
    with pytest.raises(importer.CharacterCardImportError) as caught:
        env.epochs.activate_update_with_commit(candidate, authorization, callback)
    assert caught.value.code == "active_cache_clear_failed"
    assert caught.value.__cause__ is fault
    assert (env.registry.read_bytes(), env.cache.read_bytes(), env.epochs.token()) == before
    with pytest.raises(PermissionError, match="reused"):
        env.epochs.activate_update_with_commit(candidate, authorization, callback)


@pytest.mark.parametrize("failure", ["open", "fsync", "close"])
def test_cache_directory_failure_prevents_registry_commit(switch_env, monkeypatch, failure):
    env = switch_env
    before_registry, before_token = env.registry.read_bytes(), env.epochs.token()
    fault = OSError("injected cache directory " + failure)
    real_open, real_fsync, real_close = os.open, os.fsync, os.close
    directory_fds = set()

    def open_directory(path, flags, *args, **kwargs):
        if Path(path) == env.root and failure == "open":
            raise fault
        descriptor = real_open(path, flags, *args, **kwargs)
        if Path(path) == env.root:
            directory_fds.add(descriptor)
        return descriptor

    def fsync(descriptor):
        if descriptor in directory_fds and failure == "fsync":
            raise fault
        return real_fsync(descriptor)

    def close(descriptor):
        is_directory = descriptor in directory_fds
        real_close(descriptor)
        directory_fds.discard(descriptor)
        if is_directory and failure == "close":
            raise fault

    monkeypatch.setattr(os, "open", open_directory)
    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "close", close)
    with pytest.raises(importer.CharacterCardImportError) as caught:
        _authorized_switch(env)
    assert caught.value.code == "active_cache_clear_failed"
    assert caught.value.__cause__ is fault
    assert env.registry.read_bytes() == before_registry
    assert env.epochs.token() == before_token
    assert not env.cache.exists()
    assert not directory_fds
    assert importer.load_active_persona(env.root).to_dict() == env.builtin.to_dict()


@pytest.mark.parametrize("failure", ["temporary_write", "temporary_flush", "temporary_fsync", "replace"])
def test_registry_pre_replace_failures_preserve_original_oserror(switch_env, monkeypatch, failure):
    env = switch_env
    before_registry, before_token = env.registry.read_bytes(), env.epochs.token()
    fault = OSError("injected registry " + failure)
    real_dump, real_open = json.dump, Path.open
    real_fsync, real_replace = os.fsync, os.replace

    def is_registry_temporary(stream):
        return Path(stream.name).name.startswith(".registry.json.")

    def dump(value, stream, *args, **kwargs):
        if failure == "temporary_write" and is_registry_temporary(stream):
            raise fault
        return real_dump(value, stream, *args, **kwargs)

    class FlushFailure:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            self.stream.__enter__()
            return self

        def __exit__(self, *args):
            return self.stream.__exit__(*args)

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def flush(self):
            raise fault

    def open_file(path, *args, **kwargs):
        stream = real_open(path, *args, **kwargs)
        if failure == "temporary_flush" and path.name.startswith(".registry.json."):
            return FlushFailure(stream)
        return stream

    def fsync(descriptor):
        if failure == "temporary_fsync" and stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise fault
        return real_fsync(descriptor)

    def replace(source, destination):
        if failure == "replace" and destination == env.registry:
            raise fault
        return real_replace(source, destination)

    monkeypatch.setattr(json, "dump", dump)
    monkeypatch.setattr(Path, "open", open_file)
    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)
    with pytest.raises(OSError) as caught:
        _authorized_switch(env)
    assert caught.value is fault
    assert env.registry.read_bytes() == before_registry
    assert env.epochs.token() == before_token
    assert not env.cache.exists()
    assert not list(env.root.glob(".registry.json.*.tmp"))
    assert importer.load_active_persona(env.root).to_dict() == env.builtin.to_dict()


@pytest.mark.parametrize("failure", ["cache", "registry_directory", "both"])
def test_post_commit_failures_warn_and_keep_committed_identity(switch_env, monkeypatch, failure):
    env = switch_env
    old_epoch = env.epochs.token().epoch
    real_sync, real_write = importer._sync_persona_directory, importer._atomic_json_write
    cache_attempts = []

    def sync(root):
        if failure in {"registry_directory", "both"} and _registry(env)["active_id"] == env.target.card_id:
            raise OSError("injected committed directory fsync failure")
        return real_sync(root)

    def write(path, value):
        if path == env.cache:
            cache_attempts.append(value)
            assert not path.exists()
            if failure in {"cache", "both"}:
                raise OSError("injected new cache write failure")
        return real_write(path, value)

    monkeypatch.setattr(importer, "_sync_persona_directory", sync)
    monkeypatch.setattr(importer, "_atomic_json_write", write)
    token, result = _authorized_switch(env)
    assert result["ok"] is True
    assert token.epoch == old_epoch + 1
    assert token.fingerprint == env.target.persona.identity_envelope.fingerprint
    assert _registry(env)["active_id"] == env.target.card_id
    assert cache_attempts == [env.target.persona.to_dict()]
    assert ("registry directory not synced: OSError" in result["warning"]) == (
        failure in {"registry_directory", "both"})
    assert ("active persona cache not refreshed: OSError" in result["warning"]) == (
        failure in {"cache", "both"})
    assert env.cache.exists() == (failure == "registry_directory")
    assert importer.load_active_persona(env.root).to_dict() == env.target.persona.to_dict()


@pytest.mark.parametrize("failure", [None, "open", "fsync", "close"])
def test_directory_sync_releases_its_descriptor_on_every_path(tmp_path, monkeypatch, failure):
    events = []
    fault = OSError("injected directory sync " + str(failure))

    def open_directory(path, flags):
        assert path == tmp_path
        assert flags == os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        events.append("open")
        if failure == "open":
            raise fault
        return 913

    def fsync(descriptor):
        assert descriptor == 913
        events.append("fsync")
        if failure == "fsync":
            raise fault

    def close(descriptor):
        assert descriptor == 913
        events.append("close")
        if failure == "close":
            raise fault

    with monkeypatch.context() as patch:
        patch.setattr(os, "open", open_directory)
        patch.setattr(os, "fsync", fsync)
        patch.setattr(os, "close", close)
        if failure is None:
            assert importer._sync_persona_directory(tmp_path) is None
        else:
            with pytest.raises(OSError) as caught:
                importer._sync_persona_directory(tmp_path)
            assert caught.value is fault
    assert events == (["open"] if failure == "open" else ["open", "fsync", "close"])


@pytest.mark.parametrize("cached_profile", ["builtin", "imported", "missing_imported_file"])
def test_registered_other_cache_is_rewritten_with_one_warning(switch_env, monkeypatch, caplog, cached_profile):
    env = switch_env
    cached = env.builtin if cached_profile == "builtin" else env.other.persona
    _stale_cache(env, cached)
    if cached_profile == "missing_imported_file":
        (env.root / _registry(env)["profiles"][env.other.card_id]["persona_path"]).unlink()
    before_registry = env.registry.read_bytes()

    def unexpected_sync(root):
        pytest.fail("Startup cache recovery refreshed a directory outside the switch path")

    monkeypatch.setattr(importer, "_sync_persona_directory", unexpected_sync)
    with caplog.at_level(logging.WARNING, logger=importer.__name__):
        loaded = importer.load_active_persona(env.root)
    assert loaded.to_dict() == env.target.persona.to_dict()
    assert env.registry.read_bytes() == before_registry
    assert json.loads(env.cache.read_text(encoding="utf-8")) == env.target.persona.to_dict()
    records = [record for record in caplog.records if record.name == importer.__name__]
    assert len(records) == 1 and records[0].levelno == logging.WARNING
    message = records[0].getMessage()
    for persona in (env.target.persona, cached):
        assert persona.identity_envelope.persona_id in message
        assert persona.identity_envelope.fingerprint[:16] in message
    assert "cache not refreshed" not in message


def test_healing_keeps_existing_current_builtin_upgrade(switch_env, caplog):
    env = switch_env
    registry = _registry(env)
    registry["profiles"]["default"]["identity_fingerprint"] = (
        "4e7eba3ebeeb0809517d8c87d5dc146e01bf7bff5231d2fdde7724c5ac078a18")
    _write_json(env.registry, registry)
    _write_json(env.cache, env.other.persona.to_dict())
    with caplog.at_level(logging.WARNING, logger=importer.__name__):
        loaded = importer.load_active_persona(env.root)
    assert loaded.to_dict() == env.builtin.to_dict()
    upgraded = _registry(env)
    assert upgraded["active_id"] == "default"
    for key, record in registry["profiles"].items():
        if key != "default":
            assert upgraded["profiles"][key] == record
    expected = env.builtin.identity_envelope
    assert upgraded["profiles"]["default"]["identity_fingerprint"] == expected.fingerprint
    assert upgraded["profiles"]["default"]["persona_id"] == expected.persona_id
    assert upgraded["profiles"]["default"]["identity_version"] == expected.version
    assert json.loads(env.cache.read_text(encoding="utf-8")) == env.builtin.to_dict()
    assert len([record for record in caplog.records if record.name == importer.__name__]) == 1


@pytest.mark.parametrize("error_class", [OSError, PermissionError])
def test_cache_healing_write_failure_still_loads_authoritative_persona(
        switch_env, monkeypatch, caplog, error_class):
    env = switch_env
    _stale_cache(env, env.builtin)
    before = env.registry.read_bytes(), env.cache.read_bytes()
    real_write = importer._atomic_json_write

    def write(path, value):
        if path == env.cache:
            raise error_class("injected healing write failure")
        return real_write(path, value)

    monkeypatch.setattr(importer, "_atomic_json_write", write)
    with caplog.at_level(logging.WARNING, logger=importer.__name__):
        loaded = importer.load_active_persona(env.root)
    assert loaded.to_dict() == env.target.persona.to_dict()
    assert (env.registry.read_bytes(), env.cache.read_bytes()) == before
    records = [record for record in caplog.records if record.name == importer.__name__]
    assert len(records) == 1
    message = records[0].getMessage()
    assert "cache not refreshed: " + error_class.__name__ in message
    for persona in (env.target.persona, env.builtin):
        assert persona.identity_envelope.persona_id in message
        assert persona.identity_envelope.fingerprint[:16] in message


@pytest.mark.parametrize("condition", [
    "unregistered", "old_version", "current_missing", "current_corrupt", "current_tampered",
    "cache_corrupt", "forged_persona_id", "unupgraded_legacy_other",
])
def test_cache_healing_keeps_untrusted_and_unverifiable_cases_rejected(
        switch_env, monkeypatch, caplog, condition):
    env = switch_env
    _stale_cache(env, env.builtin)
    registry = _registry(env)
    current_path = env.root / registry["profiles"][env.target.card_id]["persona_path"]
    if condition == "unregistered":
        rogue = importer.parse_sillytavern_json(_card("未登记的缓存人格"))
        _write_json(env.cache, rogue.persona.to_dict())
    elif condition == "old_version":
        _write_json(env.cache, env.other.persona.to_dict())
        data = env.other.persona.to_dict()
        data["identity"]["identity_version"] += 1
        data["speaking_style"]["tone"] = "新版本的合成语气"
        updated = Persona(**data)
        envelope = updated.seal_identity()
        record = registry["profiles"][env.other.card_id]
        _write_json(env.root / record["persona_path"], updated.to_dict())
        record.update(identity_version=envelope.version, identity_fingerprint=envelope.fingerprint)
    elif condition == "current_missing":
        current_path.unlink()
    elif condition == "current_corrupt":
        current_path.write_text("{truncated", encoding="utf-8")
    elif condition == "current_tampered":
        _write_json(current_path, env.other.persona.to_dict())
    elif condition == "cache_corrupt":
        env.cache.write_text("{truncated", encoding="utf-8")
    elif condition == "forged_persona_id":
        registry["profiles"]["default"]["persona_id"] = "forged_other_persona"
    elif condition == "unupgraded_legacy_other":
        registry["profiles"]["default"]["identity_fingerprint"] = (
            "4e7eba3ebeeb0809517d8c87d5dc146e01bf7bff5231d2fdde7724c5ac078a18")
    _write_json(env.registry, registry)
    before = env.registry.read_bytes(), env.cache.read_bytes()
    real_load = importer._load_profile_persona
    loaded_ids = []

    def load(root, records, profile_id):
        loaded_ids.append(profile_id)
        return real_load(root, records, profile_id)

    monkeypatch.setattr(importer, "_load_profile_persona", load)
    with caplog.at_level(logging.WARNING, logger=importer.__name__):
        with pytest.raises(importer.CharacterCardImportError) as caught:
            importer.load_active_persona(env.root)
    expected_code = "active_cache_corrupt" if condition == "cache_corrupt" else "active_cache_conflict"
    assert caught.value.code == expected_code
    assert (env.registry.read_bytes(), env.cache.read_bytes()) == before
    assert loaded_ids == [env.target.card_id]
    assert not [record for record in caplog.records if record.name == importer.__name__]


@pytest.mark.parametrize("condition", ["registry_corrupt", "active_profile_missing", "registry_identity_unsealed"])
def test_other_registered_cache_cannot_bypass_registry_preconditions(switch_env, monkeypatch, condition):
    env = switch_env
    _stale_cache(env, env.builtin)
    registry = _registry(env)
    if condition == "registry_corrupt":
        env.registry.write_text("{truncated", encoding="utf-8")
    else:
        if condition == "active_profile_missing":
            del registry["profiles"][env.target.card_id]
        else:
            del registry["profiles"][env.target.card_id]["identity_fingerprint"]
        _write_json(env.registry, registry)
    before = env.registry.read_bytes(), env.cache.read_bytes()

    def unexpected_write(*args, **kwargs):
        pytest.fail("An invalid authoritative registry reached cache recovery")

    monkeypatch.setattr(importer, "_atomic_json_write", unexpected_write)
    with pytest.raises(importer.CharacterCardImportError) as caught:
        importer.load_active_persona(env.root)
    assert caught.value.code == condition
    assert (env.registry.read_bytes(), env.cache.read_bytes()) == before


@pytest.mark.parametrize("profile_failure", ["missing", "tampered"])
def test_matching_sealed_cache_remains_a_continuity_copy(switch_env, caplog, profile_failure):
    env = switch_env
    _authorized_switch(env)
    current_path = env.root / _registry(env)["profiles"][env.target.card_id]["persona_path"]
    if profile_failure == "missing":
        current_path.unlink()
    else:
        _write_json(current_path, env.other.persona.to_dict())
    before = env.registry.read_bytes(), env.cache.read_bytes()
    with caplog.at_level(logging.WARNING, logger=importer.__name__):
        loaded = importer.load_active_persona(env.root)
    assert loaded.to_dict() == env.target.persona.to_dict()
    assert (env.registry.read_bytes(), env.cache.read_bytes()) == before
    assert not [record for record in caplog.records if record.name == importer.__name__]


@pytest.mark.parametrize("cache_state", ["missing", "matching"])
def test_normal_load_does_not_rewrite_or_refresh_directories(switch_env, monkeypatch, caplog, cache_state):
    env = switch_env
    if cache_state == "missing":
        env.cache.unlink()
    before_registry = env.registry.read_bytes()
    before_cache = env.cache.read_bytes() if env.cache.exists() else None

    def unexpected_write(*args, **kwargs):
        pytest.fail("Normal authoritative load attempted a cache or directory write")

    monkeypatch.setattr(importer, "_atomic_json_write", unexpected_write)
    monkeypatch.setattr(importer, "_sync_persona_directory", unexpected_write)
    with caplog.at_level(logging.WARNING, logger=importer.__name__):
        loaded = importer.load_active_persona(env.root)
    assert loaded.to_dict() == env.builtin.to_dict()
    assert env.registry.read_bytes() == before_registry
    assert (env.cache.read_bytes() if env.cache.exists() else None) == before_cache
    assert not [record for record in caplog.records if record.name == importer.__name__]
