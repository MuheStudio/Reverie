from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.api.adapter import ProviderRequestError, parse_chat_completion
from src.api.provider_probe import (
    ProviderProbe,
    ProviderProbeResult,
    is_official_deepseek_endpoint,
)
from src.bridge import ws_bridge
from src.config.settings import LLMSettings


class _RemoteAllowed:
    def require_remote(self, _operation: str) -> None:
        return None


@pytest.mark.asyncio
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
        ("ollama", "http://localhost:11434/v1"),
        ("custom", "https://gateway.example.com/v1"),
    ],
)
async def test_runtime_provider_authority_accepts_all_canonical_providers(
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
    endpoint: str,
) -> None:
    seen: list[tuple[str, str, str, str, str, str]] = []

    async def fake_run(
        self: ProviderProbe,
        *,
        provider: str,
        model: str,
        base_url: str,
    ) -> ProviderProbeResult:
        seen.append(
            (
                provider,
                model,
                base_url,
                self._adapter.settings.provider,
                self._adapter.settings.api_key,
                self._adapter.settings.base_url,
            )
        )
        return ProviderProbeResult(provider, model, 7, "stop")

    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    for key in (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
        "DEEPSEEK_API_KEY",
        "KIMI_API_KEY",
        "GLM_API_KEY",
    ):
        monkeypatch.setenv(key, "environment-shadow-key")
    monkeypatch.setattr(ProviderProbe, "run", fake_run)
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "settings",
        SimpleNamespace(llm=LLMSettings()),
    )
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "adapter",
        SimpleNamespace(local_mode_gate=_RemoteAllowed()),
    )

    result = await ws_bridge._test_runtime_provider(
        {"provider": provider, "model": "probe-model", "base_url": endpoint},
        {} if provider == "ollama" else {"apiKey": "test-key"},
    )

    assert result == {
        "provider": provider,
        "model": "probe-model",
        "latency_ms": 7,
        "finish_reason": "stop",
    }
    expected_key = "" if provider == "ollama" else "test-key"
    assert seen == [
        (provider, "probe-model", endpoint, provider, expected_key, endpoint)
    ]


@pytest.mark.asyncio
async def test_runtime_provider_uses_environment_key_only_when_none_is_submitted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_keys: list[str] = []

    async def fake_run(
        self: ProviderProbe,
        **_kwargs: str,
    ) -> ProviderProbeResult:
        seen_keys.append(self._adapter.settings.api_key)
        return ProviderProbeResult("deepseek", "deepseek-v4-flash", 1, "stop")

    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "environment-key")
    monkeypatch.setattr(ProviderProbe, "run", fake_run)
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "settings",
        SimpleNamespace(llm=LLMSettings()),
    )
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "adapter",
        SimpleNamespace(local_mode_gate=_RemoteAllowed()),
    )

    await ws_bridge._test_runtime_provider(
        {
            "provider": "deepseek",
            "model": "deepseek-v4-flash",
            "base_url": "https://api.deepseek.com",
        },
        {},
    )

    assert seen_keys == ["environment-key"]


@pytest.mark.asyncio
async def test_provider_commit_keeps_the_explicit_ollama_endpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    previous = LLMSettings(
        provider="deepseek",
        model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
    )
    owner_settings = SimpleNamespace(llm=previous)
    owner_adapter = SimpleNamespace(
        settings=previous,
        usage_policy=None,
        reset_client=lambda: None,
    )
    coordinator = SimpleNamespace(cancel_all=AsyncMock())
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://localhost:9999/v1")
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", owner_settings)
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", owner_adapter)
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: coordinator)
    monkeypatch.setattr("src.config.settings.save_settings", lambda _settings: None)

    result = await ws_bridge._configure_runtime_provider(
        {
            "provider": "ollama",
            "model": "local-model",
            "base_url": "http://localhost:11434/v1",
        }
    )

    assert result["llm"]["base_url"] == "http://localhost:11434/v1"
    assert owner_settings.llm.base_url == "http://localhost:11434/v1"
    assert owner_adapter.settings.base_url == "http://localhost:11434/v1"


@pytest.mark.asyncio
async def test_provider_commit_does_not_report_post_commit_reset_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    previous = LLMSettings(
        provider="deepseek",
        model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
    )
    owner_settings = SimpleNamespace(llm=previous)

    def fail_reset() -> None:
        raise RuntimeError("reset failed after durable commit")

    owner_adapter = SimpleNamespace(
        settings=previous,
        usage_policy=None,
        reset_client=fail_reset,
    )
    coordinator = SimpleNamespace(cancel_all=AsyncMock())
    saves: list[str] = []
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", owner_settings)
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", owner_adapter)
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: coordinator)
    monkeypatch.setattr(
        "src.config.settings.save_settings",
        lambda settings: saves.append(settings.llm.provider),
    )

    result = await ws_bridge._configure_runtime_provider(
        {
            "provider": "openai",
            "model": "gpt-test",
            "base_url": "https://api.openai.com/v1",
        }
    )

    coordinator.cancel_all.assert_awaited_once_with(reason="model_changed")
    assert saves == ["openai"]
    assert result["llm"]["provider"] == "openai"


@pytest.mark.asyncio
async def test_provider_save_failure_has_no_irreversible_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    previous = LLMSettings(
        provider="deepseek",
        model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
    )
    policy = SimpleNamespace(revoke_all_for_provider_change=MagicMock())
    adapter = SimpleNamespace(settings=previous, usage_policy=policy, reset_client=lambda: None)
    coordinator = SimpleNamespace(cancel_all=AsyncMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", SimpleNamespace(llm=previous))
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", adapter)
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: coordinator)
    monkeypatch.setattr(
        "src.config.settings.save_settings",
        lambda _settings: (_ for _ in ()).throw(OSError("disk full")),
    )

    with pytest.raises(OSError, match="disk full"):
        await ws_bridge._configure_runtime_provider(
            {
                "provider": "openai",
                "model": "gpt-test",
                "base_url": "https://api.openai.com/v1",
            }
        )

    coordinator.cancel_all.assert_not_awaited()
    policy.revoke_all_for_provider_change.assert_not_called()
    assert ws_bridge.bridge_state.settings.llm is previous
    assert adapter.settings is previous


@pytest.mark.asyncio
async def test_runtime_credential_object_is_a_complete_replacement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    llm = LLMSettings(api_key="old-key")
    adapter = SimpleNamespace(
        settings=llm,
        custom_headers={"X-Old": "hidden"},
        reset_client=lambda: None,
    )
    coordinator = SimpleNamespace(cancel_all=AsyncMock())
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", SimpleNamespace(llm=llm))
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", adapter)
    monkeypatch.setattr(ws_bridge, "_get_chat_coordinator", lambda: coordinator)

    await ws_bridge._apply_runtime_credentials(
        {"llm": {"customHeaders": "X-New: retained"}}
    )
    assert llm.api_key == ""
    assert adapter.custom_headers == {"X-New": "retained"}

    await ws_bridge._apply_runtime_credentials({})
    assert adapter.custom_headers == {"X-New": "retained"}

    await ws_bridge._apply_runtime_credentials({"llm": None})
    assert llm.api_key == ""
    assert adapter.custom_headers == {}


@pytest.mark.asyncio
async def test_invalid_runtime_headers_do_not_partially_replace_the_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    llm = LLMSettings(api_key="old-key")
    adapter = SimpleNamespace(
        settings=llm,
        custom_headers={"X-Old": "retained"},
        reset_client=lambda: None,
    )
    monkeypatch.setattr(ws_bridge.bridge_state, "settings", SimpleNamespace(llm=llm))
    monkeypatch.setattr(ws_bridge.bridge_state, "adapter", adapter)

    with pytest.raises(ValueError):
        await ws_bridge._apply_runtime_credentials(
            {"llm": {"apiKey": "new-key", "customHeaders": "Authorization: forbidden"}}
        )

    assert llm.api_key == "old-key"
    assert adapter.custom_headers == {"X-Old": "retained"}


async def _openai_server(status: int = 200):
    requests: list[tuple[str, bytes]] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        header = await reader.readuntil(b"\r\n\r\n")
        first_line = header.split(b"\r\n", 1)[0].decode("ascii")
        content_length = 0
        for line in header.split(b"\r\n")[1:]:
            name, separator, value = line.partition(b":")
            if separator and name.lower() == b"content-length":
                content_length = int(value.strip())
        body = await reader.readexactly(content_length)
        requests.append((first_line, body))
        if status == 200:
            payload = {
                "id": "probe",
                "object": "chat.completion",
                "created": 1,
                "model": "local-probe",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "OK"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 4,
                    "completion_tokens": 1,
                    "total_tokens": 5,
                },
            }
        else:
            payload = {"error": {"message": "private vendor detail"}}
        encoded = json.dumps(payload).encode("utf-8")
        reason = b"OK" if status == 200 else b"Unauthorized"
        writer.write(
            b"HTTP/1.1 "
            + str(status).encode("ascii")
            + b" "
            + reason
            + b"\r\nContent-Type: application/json\r\nConnection: close\r\n"
            + f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii")
            + encoded
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    return server, port, requests


@pytest.mark.asyncio
async def test_provider_probe_makes_a_real_minimal_http_call_without_mutating_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, port, requests = await _openai_server()
    original = LLMSettings(
        provider="deepseek",
        model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
    )
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "settings",
        SimpleNamespace(llm=original),
    )
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "adapter",
        SimpleNamespace(local_mode_gate=_RemoteAllowed()),
    )
    try:
        result = await ws_bridge._test_runtime_provider(
            {
                "provider": "ollama",
                "model": "local-probe",
                "base_url": f"http://127.0.0.1:{port}/v1",
            },
            {},
        )
    finally:
        server.close()
        await server.wait_closed()

    assert result["provider"] == "ollama"
    assert result["model"] == "local-probe"
    assert result["latency_ms"] >= 0
    assert requests and requests[0][0].startswith("POST /v1/chat/completions ")
    sent = json.loads(requests[0][1])
    assert sent["max_tokens"] == 64
    assert sent["messages"] == [
        {"role": "user", "content": "Reply with a short confirmation that this connection works."}
    ]
    assert "thinking" not in sent
    assert original.provider == "deepseek"
    assert original.model == "deepseek-v4-flash"


@pytest.mark.asyncio
async def test_provider_probe_sanitizes_401_and_never_exposes_vendor_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, port, _requests = await _openai_server(status=401)
    monkeypatch.setenv("REVERIE_BRIDGE_MODE", "1")
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "settings",
        SimpleNamespace(llm=LLMSettings()),
    )
    monkeypatch.setattr(
        ws_bridge.bridge_state,
        "adapter",
        SimpleNamespace(local_mode_gate=_RemoteAllowed()),
    )
    try:
        with pytest.raises(ProviderRequestError) as caught:
            await ws_bridge._test_runtime_provider(
                {
                    "provider": "ollama",
                    "model": "local-probe",
                    "base_url": f"http://127.0.0.1:{port}/v1",
                },
                {},
            )
    finally:
        server.close()
        await server.wait_closed()

    assert caught.value.code == "PROVIDER_AUTH_FAILED"
    assert "private vendor detail" not in str(caught.value)


def _completion(
    *,
    content: str | None,
    reasoning_content: str | None = None,
    finish_reason: str = "stop",
    tool_calls: list[object] | None = None,
):
    message = SimpleNamespace(
        content=content,
        reasoning_content=reasoning_content,
        tool_calls=tool_calls,
        refusal=None,
    )
    return SimpleNamespace(
        model="deepseek-v4-pro",
        choices=[SimpleNamespace(message=message, finish_reason=finish_reason)],
        usage=SimpleNamespace(prompt_tokens=4, completion_tokens=4),
    )


@pytest.mark.parametrize(
    ("completion", "code"),
    [
        (_completion(content=None, reasoning_content="thinking"), "PROVIDER_REASONING_ONLY_RESPONSE"),
        (
            _completion(
                content=None,
                reasoning_content="thinking",
                finish_reason="length",
            ),
            "PROVIDER_OUTPUT_TRUNCATED",
        ),
        (_completion(content=None, finish_reason="content_filter"), "PROVIDER_CONTENT_FILTERED"),
        (
            _completion(
                content=None,
                finish_reason="tool_calls",
                tool_calls=[SimpleNamespace(id="call-1")],
            ),
            "PROVIDER_TOOL_ONLY_RESPONSE",
        ),
        (
            SimpleNamespace(model="broken", choices=[], usage=None),
            "PROVIDER_INVALID_RESPONSE_SCHEMA",
        ),
    ],
)
def test_chat_completion_failures_are_classified_without_exposing_payload(
    completion,
    code: str,
) -> None:
    with pytest.raises(ProviderRequestError) as caught:
        parse_chat_completion(completion)
    assert caught.value.code == code
    assert "thinking" not in str(caught.value)


def test_official_deepseek_profile_requires_exact_host_and_v4_model() -> None:
    assert is_official_deepseek_endpoint(
        "https://api.deepseek.com",
        "deepseek-v4-pro",
    )
    assert is_official_deepseek_endpoint(
        "https://api.deepseek.com/v1",
        "deepseek-v4-flash",
    )
    assert not is_official_deepseek_endpoint(
        "https://proxy.example/v1",
        "deepseek-v4-pro",
    )
    assert not is_official_deepseek_endpoint(
        "https://api.deepseek.com.evil.example/v1",
        "deepseek-v4-pro",
    )
    assert not is_official_deepseek_endpoint(
        "https://api.deepseek.com/beta",
        "deepseek-v4-pro",
    )


@pytest.mark.asyncio
async def test_provider_probe_owns_and_normalizes_its_outer_timeout() -> None:
    class SlowAdapter:
        async def chat(self, *_args, **_kwargs):
            await asyncio.sleep(1)

    with pytest.raises(ProviderRequestError) as caught:
        await ProviderProbe(SlowAdapter(), timeout_seconds=0.001).run(
            provider="ollama",
            model="slow-model",
            base_url="http://127.0.0.1:11434/v1",
        )
    assert caught.value.code == "PROVIDER_TIMEOUT"
    assert caught.value.retryable is True
