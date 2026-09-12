from __future__ import annotations

from src.api.adapter import native_search_tools_for_base_url
from src.config.settings import FeatureSettings
from src.persona.persona_card import default_persona
from src.persona.prompt_builder import build_system_prompt


def test_provider_host_mapping():
    zhipu = native_search_tools_for_base_url("https://open.bigmodel.cn/api/paas/v4")
    assert zhipu and zhipu[0]["type"] == "web_search"
    assert zhipu[0]["web_search"] == {"enable": True}

    zai = native_search_tools_for_base_url("https://api.z.ai/v1")
    assert zai and zai[0]["type"] == "web_search"

    kimi = native_search_tools_for_base_url("https://api.moonshot.cn/v1")
    assert kimi and kimi[0]["function"]["name"] == "$web_search"

    kimi_com = native_search_tools_for_base_url("https://api.moonshot.ai/v1")
    assert kimi_com is not None


def test_unknown_or_local_providers_get_no_tool_payload():
    # DeepSeek's OpenAI-compatible endpoint has no native search parameter:
    # sending one would 400 every request (Murphy guard).
    assert native_search_tools_for_base_url("https://api.deepseek.com") is None
    assert native_search_tools_for_base_url("http://localhost:11434/v1") is None
    assert native_search_tools_for_base_url("https://api.openai.com/v1") is None
    assert native_search_tools_for_base_url("not a url") is None
    assert native_search_tools_for_base_url(None) is None


def test_feature_default_is_off():
    assert FeatureSettings().web_native_search_enabled is False


def test_prompt_permission_block_toggles():
    persona = default_persona()
    enabled = build_system_prompt(persona, native_search_enabled=True)
    assert "NATIVE WEB SEARCH PERMISSION" in enabled
    assert "政治" in enabled
    assert "社会热点" in enabled

    disabled = build_system_prompt(persona)
    assert "NATIVE WEB SEARCH PERMISSION" not in disabled
