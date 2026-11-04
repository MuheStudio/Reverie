"""Isolated inputs and controllers for the new persona profile checks."""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace
from weakref import WeakSet

import pytest

from src.bridge import ws_bridge
from src.config import settings
from src.persona import identity
from src.persona.persona_card import default_persona
from src.persona.profile_edit import (
    commit_persona_profile_update, prepare_persona_profile_update, read_persona_profile,
)
from src.persona.sillytavern_import import (
    initialize_default_persona, parse_sillytavern_json, save_imported_persona,
)
from src.storage import encrypted_sqlite


def synthetic_card(name="编辑人格·晴"):
    return json.dumps({"spec": "chara_card_v2", "spec_version": "2.0", "data": {
        "name": name, "description": "年龄：24。喜欢画画的合成角色。", "personality": "温柔，谨慎",
        "scenario": "隔离测试中的观景室", "first_mes": "你好。", "mes_example": "用户：你好。",
        "creator_notes": "合成来源备注", "system_prompt": "作者补充设定",
        "post_history_instructions": "作者补充尾注", "alternate_greetings": ["早上好。"],
        "tags": ["合成"], "creator": "隔离测试", "character_version": "source-1", "extensions": {},
    }}, ensure_ascii=False)


@pytest.fixture
def cipher_key(monkeypatch):
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", True)
    monkeypatch.delenv("REVERIE_STORAGE_KEY_FD", raising=False)
    monkeypatch.delenv("REVERIE_REQUIRE_ENCRYPTED_STORAGE", raising=False)


@pytest.fixture
def profile_env(tmp_path, monkeypatch, cipher_key):
    data_dir = tmp_path / "isolated-data"
    persona_dir = data_dir / "persona"
    builtin = default_persona()
    initialize_default_persona(persona_dir, builtin)
    report = parse_sillytavern_json(synthetic_card())
    save_imported_persona(report, persona_dir)
    epochs = identity.PersonaEpochRegistry()
    epochs.activate_initial(builtin)
    monkeypatch.setattr(identity, "GLOBAL_PERSONA_EPOCH", epochs)
    monkeypatch.setattr(settings, "DATA_DIR", data_dir)
    monkeypatch.setattr(settings, "PERSONA_DIR", persona_dir)
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", asyncio.Lock())

    class Endpoint:
        def __init__(self):
            self.frames = []

        async def send(self, raw):
            self.frames.append(json.loads(raw))

    endpoint = Endpoint()
    context = ws_bridge.BridgeClientContext(client_id="isolated-profile-controller", protocol_version=4,
        authenticated=True, conversation_id="dream-room", persona_id=epochs.token().persona_id)
    monkeypatch.setattr(ws_bridge, "_client_contexts", {endpoint: context})
    monkeypatch.setattr(ws_bridge, "_controller_ws", endpoint)
    monkeypatch.setattr(ws_bridge, "_connections", WeakSet([endpoint]))
    for name, value in {"persona": builtin, "persona_restart_required": False, "model_epoch": 17,
                        "runtime_unavailable": (), "recovery_state": "clean", "recovery_reason": "",
                        "backup_manager": None, "kernel_store": None, "proactive": None,
                        "work_manager": None}.items():
        monkeypatch.setattr(ws_bridge.bridge_state, name, value)
    return SimpleNamespace(data_dir=data_dir, persona_dir=persona_dir, builtin=builtin,
        report=report, profile_id=report.card_id, epochs=epochs, endpoint=endpoint, context=context)


def scope_proof():
    return {"expected_" + key: value for key, value in ws_bridge._active_persona_scope().items()}


def update_payload(env, fields=None, **overrides):
    current = read_persona_profile(env.persona_dir, env.profile_id)
    return {"profile_id": env.profile_id, "expected_identity_version": current["identity_version"],
        "expected_identity_fingerprint": current["identity_fingerprint"],
        "identity_change_confirmed": True, "confirmed_profile_id": env.profile_id,
        "actor": "owner", "reason": "隔离角色卡编辑测试", **scope_proof(),
        "fields": fields if fields is not None else {"tone": "用简短而温柔的语气说话。"}, **overrides}


def prepared_update(env, fields=None, **overrides):
    payload = update_payload(env, fields, **overrides)
    return prepare_persona_profile_update(env.persona_dir, env.profile_id,
        expected_identity_version=payload["expected_identity_version"],
        expected_identity_fingerprint=payload["expected_identity_fingerprint"], fields=payload["fields"])


def commit_update(env, prepared, **kwargs):
    authorization = env.epochs.authorize_update(actor="owner", reason="隔离编辑测试", user_confirmed=True)
    return env.epochs.commit_inactive_update_with_commit(prepared.candidate, authorization,
        lambda: commit_persona_profile_update(prepared, **kwargs))


def candidate_path(prepared):
    envelope = prepared.candidate.identity_envelope
    return prepared.root / "imported" / prepared.profile_id / f"persona.v{envelope.version}-{envelope.fingerprint[:16]}.json"


def file_snapshot(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}
