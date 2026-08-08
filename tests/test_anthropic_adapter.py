import asyncio

from src.api.adapter import LLMAdapter, _anthropic_request_messages, parse_anthropic_message
from src.config.settings import LLMSettings


def test_native_anthropic_provider_uses_messages_api_contract(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    adapter = LLMAdapter(
        LLMSettings(
            provider="anthropic",
            model="claude-test",
            api_key="test-key",
            base_url="https://api.anthropic.com",
        )
    )
    client = adapter._get_anthropic_client()
    assert client.headers["x-api-key"] == "test-key"
    assert client.headers["anthropic-version"] == "2023-06-01"
    asyncio.run(adapter.close())


def test_anthropic_message_translation_separates_system_and_text_blocks() -> None:
    system, turns = _anthropic_request_messages([
        {"role": "system", "content": "be kind"},
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ])
    assert system == "be kind"
    assert turns == [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]
    parsed = parse_anthropic_message({
        "model": "claude-test",
        "stop_reason": "end_turn",
        "content": [{"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": "hello"}],
        "usage": {"input_tokens": 3, "output_tokens": 2},
    })
    assert parsed.content == "hello"
    assert parsed.usage == {"prompt_tokens": 3, "completion_tokens": 2}


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
