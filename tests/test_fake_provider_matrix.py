from __future__ import annotations

import asyncio

import pytest

from src.api.adapter import ProviderRequestError, normalize_provider_error
from src.api.fake_provider import DeterministicFakeProvider, FakeScenario
from src.config.settings import LLMSettings


@pytest.mark.parametrize(
    ("scenario", "code", "retryable", "unknown"),
    [
        ("401", "PROVIDER_UNAUTHORIZED", False, False),
        ("429", "PROVIDER_RATE_LIMITED", True, False),
        ("timeout", "PROVIDER_TIMEOUT", True, True),
        ("stream_interrupted", "PROVIDER_CONNECTION_FAILED", True, True),
        ("after_dispatch_crash", "PROVIDER_CONNECTION_FAILED", True, True),
        ("invalid_json", "PROVIDER_INVALID_RESPONSE", False, False),
        ("empty", "PROVIDER_EMPTY_RESPONSE", False, False),
    ],
)
def test_offline_provider_failure_matrix(
    scenario: str,
    code: str,
    retryable: bool,
    unknown: bool,
) -> None:
    provider = DeterministicFakeProvider([scenario])
    with pytest.raises(ProviderRequestError) as raised:
        asyncio.run(
            provider.chat(
                [{"role": "user", "content": "offline acceptance"}],
                purpose="chat_reply",
            )
        )
    assert raised.value.code == code
    assert raised.value.retryable is retryable
    assert raised.value.outcome_unknown is unknown
    assert len(provider.calls) == 1


def test_offline_provider_is_deterministic_for_chat_diary_and_verifiers() -> None:
    provider = DeterministicFakeProvider(
        [
            FakeScenario("success"),
            FakeScenario("success"),
            FakeScenario("success"),
        ]
    )
    chat = asyncio.run(provider.chat([], purpose="chat_reply"))
    diary = asyncio.run(provider.chat([], purpose="diary_generation"))
    verifier = asyncio.run(provider.chat([], purpose="semantic_verifier"))
    assert chat.content == "嗯，我在这里。慢慢说就好。"
    assert diary.content.startswith("安静的一天")
    assert '"verdict":"consistent"' in verifier.content
    assert [call["purpose"] for call in provider.calls] == [
        "chat_reply",
        "diary_generation",
        "semantic_verifier",
    ]


class StatusFailure(RuntimeError):
    status_code = 429


def test_raw_vendor_body_is_not_exposed_by_error_normalization() -> None:
    normalized = normalize_provider_error(
        StatusFailure("secret request headers and vendor body")
    )
    assert normalized.code == "PROVIDER_RATE_LIMITED"
    assert "secret" not in str(normalized)


def test_openai_compatible_sdk_retries_are_explicitly_disabled(monkeypatch) -> None:
    captured = {}

    class Client:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("src.api.adapter.AsyncOpenAI", Client)
    from src.api.adapter import LLMAdapter

    adapter = LLMAdapter(
        LLMSettings(
            provider="deepseek",
            model="deepseek-v4-flash",
            api_key="session-key",
            base_url="https://api.deepseek.com",
        )
    )
    assert adapter._get_openai_client() is not None
    assert captured["max_retries"] == 0
