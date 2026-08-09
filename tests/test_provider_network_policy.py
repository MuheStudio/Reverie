from __future__ import annotations

import asyncio
import socket

import pytest

from src.api.adapter import LLMAdapter
from src.api.network_policy import assert_provider_destination
from src.config.settings import LLMSettings


def _dns_rows(*addresses: str) -> list[tuple]:
    return [
        (
            socket.AF_INET6 if ":" in address else socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            (address, 443, 0, 0) if ":" in address else (address, 443),
        )
        for address in addresses
    ]


def test_custom_provider_accepts_only_all_public_dns_answers(monkeypatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _dns_rows("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"),
    )
    asyncio.run(assert_provider_destination("custom", "https://api.example.com/v1"))


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.5",
        "169.254.169.254",
        "192.168.1.5",
        "::1",
        "fe80::1",
        "100.64.0.1",  # CGNAT shared address range
        "198.18.0.1",  # benchmark/testing range
        "::ffff:10.0.0.1",  # IPv4-mapped IPv6 private
        "::ffff:127.0.0.1",  # IPv4-mapped IPv6 loopback
    ],
)
def test_custom_provider_rejects_private_or_special_dns_answers(
    monkeypatch,
    address: str,
) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: _dns_rows("93.184.216.34", address),
    )
    with pytest.raises(PermissionError, match="non-public"):
        asyncio.run(assert_provider_destination("custom", "https://api.example.com/v1"))


def test_ollama_never_resolves_or_leaves_loopback(monkeypatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("loopback mode must not consult DNS")
        ),
    )
    asyncio.run(assert_provider_destination("ollama", "http://localhost:11434/v1"))
    with pytest.raises(PermissionError, match="loopback"):
        asyncio.run(assert_provider_destination("ollama", "http://ollama.example/v1"))


@pytest.mark.parametrize(
    ("provider", "endpoint"),
    [
        ("openai", "https://api.openai.com/v1"),
        ("anthropic", "https://api.anthropic.com"),
        ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai"),
        ("grok", "https://api.x.ai/v1"),
        ("deepseek", "https://api.deepseek.com"),
        ("kimi", "https://api.moonshot.cn/v1"),
        ("glm", "https://api.z.ai/api/paas/v4"),
    ],
)
def test_named_provider_requires_its_official_public_host(monkeypatch, provider: str, endpoint: str) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: _dns_rows("93.184.216.34"))
    asyncio.run(assert_provider_destination(provider, endpoint))
    with pytest.raises(PermissionError, match="official HTTPS host"):
        asyncio.run(assert_provider_destination(provider, "https://proxy.example/v1"))


@pytest.mark.parametrize(
    "provider,model",
    [
        ("openai", "gpt"), ("anthropic", "claude"), ("gemini", "gemini"),
        ("grok", "grok"), ("deepseek", "deepseek"), ("kimi", "kimi"),
        ("glm", "glm"), ("ollama", "local"), ("custom", "custom"),
    ],
)
def test_adapter_accepts_every_supported_provider(provider: str, model: str) -> None:
    adapter = LLMAdapter(LLMSettings(
        provider=provider,
        model=model,
        base_url="https://gateway.example.test/v1" if provider == "custom" else "",
    ))
    asyncio.run(adapter.close())
