import asyncio
import json

import pytest

from src.bridge import ws_bridge
from src.config.settings import FeatureSettings, MemorySettings
from src.kernel.contracts import MemoryStorePayload
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona


FORBIDDEN_KEYS = {
    "latitude", "longitude", "coordinates", "rounded_coordinates", "country",
    "city", "district", "address", "poi", "business_name", "provider_id",
    "provider_name", "geohash", "s2", "h3", "plus_code", "accuracy",
    "accuracy_m", "timestamp", "key", "url", "provider_results",
}
NORMAL_MEMORY_METADATA_KEYS = {"timestamp", "confirmed_at", "updated_at", "created_at"}
FORBIDDEN_CANARIES = {
    "31.2304", "121.4737", "37.5", "2026-07-25t00:00:00", "secret-key",
    "https://places.googleapis.com", "google places", "amap", "provider-place-id",
}


def _memory(tmp_path) -> MemoryManager:
    return MemoryManager(
        default_persona(),
        MemorySettings(
            lancedb_path=str(tmp_path / "vectors"),
            sqlite_path=str(tmp_path / "memory.db"),
        ),
        feature_settings=FeatureSettings(autonomous_memory_enabled=False),
    )


def _collect_keys(value) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        keys.update(str(key).lower() for key in value)
        for child in value.values():
            keys.update(_collect_keys(child))
    elif isinstance(value, list):
        for child in value:
            keys.update(_collect_keys(child))
    return keys


def test_contract_is_closed_and_requires_separate_confirmation() -> None:
    accepted = MemoryStorePayload.model_validate({
        "kind": "coarse_system_location",
        "neighborhood_scale": "city-scale",
        "user_confirmed": True,
    })
    assert accepted.model_dump() == {
        "kind": "coarse_system_location",
        "neighborhood_scale": "city-scale",
        "user_confirmed": True,
    }
    for invalid in (
        {"kind": "coarse_system_location", "neighborhood_scale": "city-scale", "user_confirmed": False},
        {"kind": "coarse_system_location", "neighborhood_scale": "street-scale", "user_confirmed": True},
        {"kind": "coarse_system_location", "neighborhood_scale": "city-scale", "user_confirmed": True, "text": "Google Places"},
        {"kind": "coarse_system_location", "neighborhood_scale": "city-scale", "user_confirmed": True, "provider_results": []},
    ):
        with pytest.raises(ValueError):
            MemoryStorePayload.model_validate(invalid)


def test_backend_constructs_summary_and_normal_review_delete_export(monkeypatch, tmp_path) -> None:
    memory = _memory(tmp_path)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", memory)
    result = asyncio.run(ws_bridge.handle_memory_store({
        "kind": "coarse_system_location",
        "neighborhood_scale": "neighborhood-scale",
        "user_confirmed": True,
    }, object()))

    assert result["ok"] is True
    saved = memory.list_confirmed_memories()[0]
    assert saved["text"] == "系统定位当前为街区尺度"
    assert saved["source_type"] == "user_confirmed_system_location_summary"
    assert saved["confirmation_state"] == "confirmed"
    assert memory.export_all()
    corrected = memory.correct_confirmed_memory(saved["id"], "系统定位当前为街区尺度（已复核）")["memory"]
    assert corrected["source_type"] == "user_confirmed_system_location_summary"
    assert memory.delete_confirmed_memory(corrected["id"])["deleted"] is True
    assert memory.list_confirmed_memories() == []
    memory.store.close()


def test_provider_content_cannot_enter_coarse_path(monkeypatch, tmp_path) -> None:
    memory = _memory(tmp_path)
    monkeypatch.setattr(ws_bridge.bridge_state, "memory", memory)
    payload = {
        "kind": "coarse_system_location",
        "neighborhood_scale": "city-scale",
        "user_confirmed": True,
        "provider_results": [{"provider_name": "Google Places", "poi": "Canary Cafe"}],
    }
    result = asyncio.run(ws_bridge.handle_memory_store(payload, object()))
    assert result["ok"] is False
    assert memory.list_confirmed_memories() == []
    memory.store.close()


def test_forbidden_location_data_absent_from_memory_config_kernel_and_backup(tmp_path) -> None:
    memory = _memory(tmp_path)
    memory.confirm_coarse_system_location("regional-scale")
    memory_rows = [
        row for row in memory.export_all()
        if row.get("source_type") == "user_confirmed_system_location_summary"
    ]
    kernel_schema = MemoryStorePayload.model_json_schema()
    coarse_schema = kernel_schema["$defs"]["CoarseSystemLocationMemoryPayload"]
    exports = {
        "memory": memory_rows,
        "config": FeatureSettings().model_dump(),
        "kernel": coarse_schema,
        "backup": {"memory": memory_rows},
    }
    for name, value in exports.items():
        forbidden_keys = FORBIDDEN_KEYS - (NORMAL_MEMORY_METADATA_KEYS if name in {"memory", "backup"} else set())
        assert not (forbidden_keys & _collect_keys(value)), name
        serialized = json.dumps(value, ensure_ascii=False).lower()
        assert not any(canary in serialized for canary in FORBIDDEN_CANARIES), name
    assert set(coarse_schema["properties"]) == {
        "kind", "neighborhood_scale", "user_confirmed",
    }
    memory.store.close()
