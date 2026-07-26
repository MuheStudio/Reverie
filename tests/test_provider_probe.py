from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from src.api.adapter import ProviderRequestError
from src.bridge import ws_bridge
from src.config.settings import LLMSettings


class _RemoteAllowed:
    def require_remote(self, _operation: str) -> None:
        return None


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
    assert sent["max_tokens"] == 4
    assert sent["messages"] == [{"role": "user", "content": "Reply with OK."}]
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

    assert caught.value.code == "PROVIDER_UNAUTHORIZED"
    assert "private vendor detail" not in str(caught.value)
