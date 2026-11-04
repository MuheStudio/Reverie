"""The private control contract the native host's saved reply-service key relies on.

The native host keeps the key in the Keychain and sends it over the private
stdio control channel after every handshake, identity reset and save. These
tests pin what the backend does with it: apply it in memory only, clear it on
an explicit null, drop it when the destination changes, keep it when the
destination stays, and never write it into the saved configuration.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from src.bridge import stdio_bridge, ws_bridge
from src.config import settings as settings_module
from src.config.settings import LLMSettings, _Settings

KEY = "sk-native-contract-key-0001"
FIRST = "http://127.0.0.1:11434/v1"
SECOND = "http://127.0.0.1:11435/v1"


def _control(control_type: str, **fields: object) -> dict:
    return {
        "kind": "control",
        "schema": stdio_bridge.CONTROL_SCHEMA,
        "type": control_type,
        "requestId": "native_provider_key_01",
        **fields,
    }


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(settings_module, "CONFIG_FILE", tmp_path / "config.json")
    # save_settings also replaces the module's live object; keep other tests' view.
    monkeypatch.setattr(settings_module, "_settings", settings_module._settings)
    live = _Settings()
    live.llm = LLMSettings(provider="ollama", model="reverie-qt-test", base_url=FIRST)
    cancelled: list[str] = []

    class Coordinator:
        async def cancel_all(self, *, reason: str) -> list[object]:
            cancelled.append(reason)
            return []

    class Adapter:
        def __init__(self) -> None:
            self.settings = live.llm
            self.custom_headers: dict[str, str] = {}
            self.resets = 0

        def reset_client(self) -> None:
            self.resets += 1

    adapter = Adapter()
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", live)
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", adapter)
    monkeypatch.setattr(ws_bridge.bridge_state, "model_epoch", 0)
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: Coordinator())
    monkeypatch.setattr(ws_bridge, "control_preflight", lambda _type: None)
    return SimpleNamespace(settings=live, adapter=adapter, cancelled=cancelled, config=tmp_path / "config.json")


@pytest.mark.asyncio
async def test_key_is_applied_in_memory_and_an_explicit_null_clears_it(runtime) -> None:
    applied = await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))
    assert applied["ok"] is True and applied["applied"]["llm"] is True
    assert runtime.settings.llm.api_key == KEY
    assert KEY not in json.dumps(applied)

    snapshot = await stdio_bridge._handle_control(_control("provider:get"))
    assert snapshot["llm"]["has_api_key"] is True
    assert KEY not in json.dumps(snapshot)

    cleared = await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": None}))
    assert cleared["applied"]["llm"] is True
    assert runtime.settings.llm.api_key == ""
    assert runtime.cancelled == ["credentials_changed", "credentials_changed"]


@pytest.mark.asyncio
async def test_a_read_after_a_stop_reports_that_no_key_is_held(runtime) -> None:
    # The native host settles an unconfirmed stop from this flag alone; it never repeats the stop itself.
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))
    held = await stdio_bridge._handle_control(_control("provider:get"))
    assert held["llm"]["has_api_key"] is True
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": None}))
    read = await stdio_bridge._handle_control(_control("provider:get"))
    assert read["llm"]["has_api_key"] is False
    assert KEY not in json.dumps(read)


@pytest.mark.asyncio
async def test_unchanged_credentials_cancel_nothing(runtime) -> None:
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))
    epoch = ws_bridge.bridge_state.model_epoch
    # The native host resends the same key after every refresh; that must not cancel a chat.
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))
    assert runtime.cancelled == ["credentials_changed"]
    assert ws_bridge.bridge_state.model_epoch == epoch


@pytest.mark.asyncio
async def test_a_destination_change_drops_the_key_and_the_same_destination_keeps_it(runtime) -> None:
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))

    same = await stdio_bridge._handle_control(
        _control("provider:configure", llm={"provider": "ollama", "base_url": FIRST + "/", "model": "renamed"}))
    assert same["ok"] is True and same["llm"]["has_api_key"] is True
    assert runtime.settings.llm.api_key == KEY

    moved = await stdio_bridge._handle_control(
        _control("provider:configure", llm={"provider": "ollama", "base_url": SECOND, "model": "renamed"}))
    assert moved["ok"] is True and moved["llm"]["base_url"] == SECOND
    assert moved["llm"]["has_api_key"] is False
    assert runtime.settings.llm.api_key == ""


@pytest.mark.asyncio
async def test_the_saved_configuration_never_holds_the_key(runtime) -> None:
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))
    await stdio_bridge._handle_control(
        _control("provider:configure", llm={"provider": "ollama", "base_url": FIRST, "model": "saved"}))
    saved = runtime.config.read_text(encoding="utf-8")
    assert "saved" in saved
    assert KEY not in saved
    assert "api_key" not in json.loads(saved)["llm"]


@pytest.mark.asyncio
async def test_configure_refuses_a_key_on_the_ordinary_channel(runtime) -> None:
    with pytest.raises(ValueError, match="private Electron control channel"):
        await stdio_bridge._handle_control(
            _control("provider:configure", llm={"provider": "ollama", "base_url": FIRST, "model": "x", "api_key": KEY}))
    assert runtime.settings.llm.api_key == ""


@pytest.mark.asyncio
async def test_credentials_outside_the_llm_scope_are_refused(runtime) -> None:
    with pytest.raises(ValueError, match="credentials payload is invalid"):
        await stdio_bridge._handle_control(_control("credentials:set", credentials={"amap": {"apiKey": KEY}}))
    with pytest.raises(ValueError):
        await stdio_bridge._handle_control(
            _control("credentials:set", credentials={"llm": {"apiKey": KEY, "token": "extra"}}))
    assert runtime.settings.llm.api_key == ""


@pytest.mark.asyncio
async def test_finishing_first_run_keeps_the_service_and_its_key(runtime) -> None:
    # The native first-run sheet ends with settings:update {section: onboarding, completed: true},
    # which replaces the live settings object. The reply service and its key must not move.
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": {"apiKey": KEY}}))
    before = await stdio_bridge._handle_control(_control("provider:get"))
    finished = await ws_bridge.handle_settings_update({"section": "onboarding", "completed": True}, None)
    assert finished["ok"] is True and finished["ui"]["onboarding_completed"] is True
    after = await stdio_bridge._handle_control(_control("provider:get"))
    assert after["llm"] == before["llm"] and after["llm"]["has_api_key"] is True
    assert ws_bridge.bridge_state.settings is not runtime.settings
    assert runtime.adapter.settings.api_key == KEY
    read = await ws_bridge.handle_settings_get({}, None)
    assert read["ui"]["onboarding_completed"] is True
    saved = runtime.config.read_text(encoding="utf-8")
    assert json.loads(saved)["ui"]["onboarding_completed"] is True
    assert KEY not in saved
    # A later stop reaches both the replaced settings and the adapter.
    await stdio_bridge._handle_control(_control("credentials:set", credentials={"llm": None}))
    stopped = await stdio_bridge._handle_control(_control("provider:get"))
    assert stopped["llm"]["has_api_key"] is False
    assert runtime.adapter.settings.api_key == ""
