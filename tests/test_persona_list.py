"""Read-only persona listing for the native explicit-switch entry."""

import asyncio
import json

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.config import settings
from src.kernel.contracts import (
    COMMAND_PAYLOAD_MODELS,
    CommandEnvelopeV4,
    MUTATING_COMMAND_NAMES,
    MVP_COMMAND_NAMES,
    MVP_EVENT_NAMES,
    PersonaScopeV4,
)
from src.persona.persona_card import default_persona
from src.persona.sillytavern_import import (
    initialize_default_persona,
    parse_sillytavern_json,
    save_imported_persona,
)


def card(name: str) -> str:
    # Every V2 field the importer requires, with the quarantined ones empty.
    return json.dumps(
        {
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": name,
                "description": "年龄：24。她喜欢安静地画画。",
                "personality": "温柔，谨慎",
                "scenario": "住在海边小城",
                "first_mes": "你回来啦",
                "mes_example": "",
                "creator_notes": "",
                "system_prompt": "",
                "post_history_instructions": "",
                "alternate_greetings": [],
                "tags": [],
                "creator": "",
                "character_version": "",
                "extensions": {},
            },
        },
        ensure_ascii=False,
    )


@pytest.fixture
def persona_dir(tmp_path, monkeypatch):
    root = tmp_path / "persona"
    initialize_default_persona(root, default_persona())
    monkeypatch.setattr(settings, "PERSONA_DIR", root)
    return root


def listed() -> dict:
    return asyncio.run(ws_bridge.handle_persona_list({}, None))


def test_list_marks_active_profile_and_omits_paths_and_digests(persona_dir) -> None:
    report = save_imported_persona(parse_sillytavern_json(card("测试角色")), persona_dir)

    result = listed()

    assert result["ok"] is True
    assert result["active_id"] == "default"
    by_id = {item["id"]: item for item in result["profiles"]}
    assert set(by_id) == {"default", report["card_id"]}
    assert by_id["default"]["active"] is True
    assert by_id["default"]["source_format"] == "builtin"
    assert by_id[report["card_id"]]["active"] is False
    assert by_id[report["card_id"]]["name"] == "测试角色"
    for item in result["profiles"]:
        assert set(item) == {"id", "name", "source_format", "active"}
    assert str(persona_dir) not in json.dumps(result, ensure_ascii=False)
    # The live scope lets the renderer drop a list read under an older identity.
    assert {"persona_id", "persona_epoch", "persona_fingerprint"} <= set(result)


def test_list_is_sorted_by_name_then_id(persona_dir) -> None:
    save_imported_persona(parse_sillytavern_json(card("Beta")), persona_dir)
    save_imported_persona(parse_sillytavern_json(card("alpha")), persona_dir)

    names = [item["name"] for item in listed()["profiles"]]

    assert names == sorted(names, key=str.casefold)


def test_corrupt_registry_fails_closed_without_internal_detail(persona_dir) -> None:
    (persona_dir / "registry.json").write_text("{broken", encoding="utf-8")

    result = listed()

    assert result["ok"] is False
    assert result["code"] == "persona_registry_unavailable"
    assert result["error"] == "本地人格列表暂时无法读取"
    assert "profiles" not in result


def test_list_is_a_read_only_v4_command_with_its_own_result() -> None:
    assert "persona:list" in MVP_COMMAND_NAMES
    assert "persona:list" not in MUTATING_COMMAND_NAMES
    assert "persona:list:result" in MVP_EVENT_NAMES
    assert COMMAND_PAYLOAD_MODELS["persona:list"].__name__ == "EmptyPayload"
    assert ws_bridge.response_type_for_request("persona:list") == "persona:list:result"
    with pytest.raises(ValidationError):
        CommandEnvelopeV4(
            protocol_version=4,
            request_id="request_persona_list",
            idempotency_key="request_persona_list",
            command="persona:list",
            persona=PersonaScopeV4(persona_id="persona_test", epoch=1, fingerprint="a" * 64),
            payload={"profile_id": "default"},
        )


def test_recovery_lock_allows_listing_but_not_switching(monkeypatch) -> None:
    monkeypatch.setattr(
        ws_bridge,
        "recovery_status_payload",
        lambda: {"recovery_state": "recovery_required", "writes_blocked": True,
                 "runtime_writable": False, "recovery_reason": "Local recovery requires owner action"},
    )

    assert ws_bridge.command_preflight("persona:list") is None
    blocked = ws_bridge.command_preflight("persona:activate")
    assert blocked is not None and blocked["code"] == "BACKUP_RECOVERY_REQUIRED"
