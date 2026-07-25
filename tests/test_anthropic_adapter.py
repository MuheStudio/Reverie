import asyncio

from src.api.adapter import LLMAdapter
from src.config.settings import LLMSettings


class FakeAnthropicResponse:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {
            "model": "claude-test",
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text": "pong"}],
            "usage": {"input_tokens": 7, "output_tokens": 3},
        }


class FakeAnthropicClient:
    last_request: dict | None = None

    def __init__(self, timeout: float) -> None:
        self.timeout = timeout

    async def __aenter__(self) -> "FakeAnthropicClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def post(self, url: str, *, headers: dict, json: dict) -> FakeAnthropicResponse:
        FakeAnthropicClient.last_request = {
            "url": url,
            "headers": headers,
            "json": json,
        }
        return FakeAnthropicResponse()


def test_anthropic_uses_native_messages_api(monkeypatch) -> None:
    monkeypatch.setattr("src.api.adapter.httpx.AsyncClient", FakeAnthropicClient)
    settings = LLMSettings(
        provider="anthropic",
        model="claude-test",
        api_key="test-key",
        base_url="https://api.anthropic.com",
    )
    adapter = LLMAdapter(settings)

    async def fail_openai(*args, **kwargs):
        raise AssertionError("Anthropic must not fall back to OpenAI-compatible chat")

    monkeypatch.setattr(adapter, "_openai_chat", fail_openai)

    result = asyncio.run(
        adapter.chat(
            [
                {"role": "system", "content": "Stay in character."},
                {"role": "user", "content": [{"type": "text", "text": "ping"}]},
            ],
            temperature=0.2,
            max_tokens=16,
            purpose="chat_reply",
        )
    )

    assert result.content == "pong"
    assert result.model == "claude-test"
    assert result.usage == {"prompt_tokens": 7, "completion_tokens": 3}
    assert FakeAnthropicClient.last_request == {
        "url": "https://api.anthropic.com/v1/messages",
        "headers": {
            "x-api-key": "test-key",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        "json": {
            "model": "claude-test",
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 16,
            "temperature": 0.2,
            "system": "Stay in character.",
        },
    }


def test_anthropic_omits_default_temperature(monkeypatch) -> None:
    monkeypatch.setattr("src.api.adapter.httpx.AsyncClient", FakeAnthropicClient)
    FakeAnthropicClient.last_request = None
    settings = LLMSettings(
        provider="anthropic",
        model="claude-test",
        api_key="test-key",
        base_url="https://api.anthropic.com/v1",
    )
    adapter = LLMAdapter(settings)

    result = asyncio.run(
        adapter.chat(
            [{"role": "user", "content": "ping"}],
            max_tokens=16,
            purpose="chat_reply",
        )
    )

    assert result.content == "pong"
    assert FakeAnthropicClient.last_request is not None
    assert FakeAnthropicClient.last_request["url"] == "https://api.anthropic.com/v1/messages"
    assert "temperature" not in FakeAnthropicClient.last_request["json"]


def test_reset_and_shutdown_close_persistent_provider_clients() -> None:
    class ClosableClient:
        def __init__(self) -> None:
            self.closed = False

        async def close(self) -> None:
            self.closed = True

    async def scenario() -> None:
        adapter = LLMAdapter(LLMSettings())
        retired = ClosableClient()
        active = ClosableClient()
        adapter._client = retired

        adapter.reset_client()
        await asyncio.sleep(0)
        assert retired.closed is True

        adapter._client = active
        await adapter.close()
        assert active.closed is True

    asyncio.run(scenario())
