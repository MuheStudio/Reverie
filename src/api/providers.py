"""Provider registry and model lookup for the API adapter.

Each provider maps to its API base URL, environment key name, and a list of
known model identifiers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..config.settings import ProviderName


@dataclass
class ProviderInfo:
    name: str
    base_url: str
    api_key_env: str | None  # None for Ollama (no key needed)
    models: list[str] = field(default_factory=list)


# ── Registry ──────────────────────────────────────────────

PROVIDERS: dict[str, ProviderInfo] = {
    "deepseek": ProviderInfo(
        name="DeepSeek",
        base_url="https://api.deepseek.com",
        api_key_env="DEEPSEEK_API_KEY",
        models=["deepseek-v4-flash", "deepseek-v4-pro"],
    ),
    "openai": ProviderInfo(
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        api_key_env="OPENAI_API_KEY",
        models=["gpt-5.4", "gpt-5.4-pro", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"],
    ),
    "custom": ProviderInfo(
        name="Custom OpenAI-compatible",
        base_url="",
        api_key_env=None,
        models=[],
    ),
    "anthropic": ProviderInfo(
        name="Anthropic Claude",
        base_url="https://api.anthropic.com",
        api_key_env="ANTHROPIC_API_KEY",
        models=["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-3-5-sonnet-20241022"],
    ),
    "gemini": ProviderInfo(
        name="Google Gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        api_key_env="GEMINI_API_KEY",
        models=["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
    ),
    "grok": ProviderInfo(
        name="Grok (XAI)",
        base_url="https://api.x.ai/v1",
        api_key_env="XAI_API_KEY",
        models=["grok-4", "grok-3", "grok-3-mini"],
    ),
    "kimi": ProviderInfo(
        name="Kimi (Moonshot)",
        base_url="https://api.moonshot.cn/v1",
        api_key_env="KIMI_API_KEY",
        models=["kimi-k2.7-code", "kimi-k2.6", "kimi-k2-5", "kimi-k2", "moonshot-v1-8k"],
    ),
    "glm": ProviderInfo(
        name="Z.AI (GLM)",
        base_url="https://api.z.ai/api/paas/v4",
        api_key_env="GLM_API_KEY",
        models=["glm-5.2", "glm-5", "glm-5-code", "glm-4.7", "glm-4.5-flash"],
    ),
    "ollama": ProviderInfo(
        name="Ollama (Local)",
        base_url="http://localhost:11434/v1",
        api_key_env=None,
        models=[],
    ),
}


def get_provider(name: str) -> ProviderInfo | None:
    return PROVIDERS.get(name)


def list_providers() -> list[str]:
    return list(PROVIDERS.keys())
