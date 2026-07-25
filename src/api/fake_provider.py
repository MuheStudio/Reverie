"""Deterministic, zero-network provider used by adversarial acceptance tests."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any, Iterable

from .adapter import ChatResponse, ProviderRequestError


@dataclass(frozen=True)
class FakeScenario:
    kind: str = "success"
    content: str | None = None


class DeterministicFakeProvider:
    """Purpose-aware provider with scripted Murphy-law failure modes."""

    def __init__(self, scenarios: Iterable[FakeScenario | str] = ()) -> None:
        self._scenarios = deque(
            item if isinstance(item, FakeScenario) else FakeScenario(str(item))
            for item in scenarios
        )
        self.calls: list[dict[str, Any]] = []

    async def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        purpose: str = "unclassified",
        background: bool = False,
        **_kwargs: Any,
    ) -> ChatResponse:
        self.calls.append(
            {
                "purpose": purpose,
                "background": background,
                "messages": messages,
            }
        )
        scenario = self._scenarios.popleft() if self._scenarios else FakeScenario()
        if scenario.kind == "success":
            content = scenario.content or self._default_content(purpose)
            return ChatResponse(
                content=content,
                model="reverie-offline-deterministic",
                usage={"prompt_tokens": 0, "completion_tokens": 0},
            )
        failures = {
            "401": ("PROVIDER_UNAUTHORIZED", False, False, 401),
            "429": ("PROVIDER_RATE_LIMITED", True, False, 429),
            "timeout": ("PROVIDER_TIMEOUT", True, True, None),
            "stream_interrupted": ("PROVIDER_CONNECTION_FAILED", True, True, None),
            "after_dispatch_crash": ("PROVIDER_CONNECTION_FAILED", True, True, None),
            "invalid_json": ("PROVIDER_INVALID_RESPONSE", False, False, None),
            "empty": ("PROVIDER_EMPTY_RESPONSE", False, False, None),
        }
        if scenario.kind not in failures:
            raise ValueError(f"unknown deterministic fake scenario: {scenario.kind}")
        code, retryable, outcome_unknown, status = failures[scenario.kind]
        raise ProviderRequestError(
            code,
            retryable=retryable,
            outcome_unknown=outcome_unknown,
            status_code=status,
        )

    @staticmethod
    def _default_content(purpose: str) -> str:
        if purpose in {"semantic_verifier", "diary_consistency"}:
            return '{"verdict":"consistent","consistent":true,"claims":[],"reasons":[],"unsupported_claims":[],"corrected_reply":""}'
        if purpose == "diary_generation":
            return "安静的一天\n\n今天把那些细小却真实的心情收好，留给明天的自己。"
        if purpose == "memory_summary":
            return "用户今天提到了一件值得记住的小事。"
        return "嗯，我在这里。慢慢说就好。"
