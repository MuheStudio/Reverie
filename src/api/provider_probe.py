"""One-shot provider connection probe using the production LLM adapter."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import urlsplit

from .adapter import ChatResponse, LLMAdapter, ProviderRequestError

PROBE_MAX_TOKENS = 64
PROBE_PROMPT = "Reply with a short confirmation that this connection works."
_DEEPSEEK_V4_MODELS = frozenset({"deepseek-v4-flash", "deepseek-v4-pro"})


def is_official_deepseek_endpoint(base_url: str, model: str) -> bool:
    """Select DeepSeek-only request fields only for its documented production endpoint."""

    try:
        parsed = urlsplit(str(base_url).strip())
    except ValueError:
        return False
    normalized_path = parsed.path.rstrip("/")
    return (
        parsed.scheme == "https"
        and parsed.hostname == "api.deepseek.com"
        and parsed.port is None
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and normalized_path in {"", "/v1"}
        and str(model).strip() in _DEEPSEEK_V4_MODELS
    )


@dataclass(frozen=True)
class ProviderProbeResult:
    provider: str
    model: str
    latency_ms: int
    finish_reason: str


class ProviderProbe:
    """Validate that a provider returns text the current chat UI can display."""

    def __init__(self, adapter: LLMAdapter, *, timeout_seconds: float = 30.0) -> None:
        self._adapter = adapter
        self._timeout_seconds = timeout_seconds

    async def run(self, *, provider: str, model: str, base_url: str) -> ProviderProbeResult:
        loop = asyncio.get_running_loop()
        started = loop.time()
        try:
            response: ChatResponse = await asyncio.wait_for(
                self._adapter.chat(
                    [{"role": "user", "content": PROBE_PROMPT}],
                    model=model,
                    temperature=0,
                    max_tokens=PROBE_MAX_TOKENS,
                    purpose="chat_reply",
                    background=False,
                    disable_reasoning=is_official_deepseek_endpoint(base_url, model),
                ),
                timeout=self._timeout_seconds,
            )
        except ProviderRequestError as error:
            if error.code == "PROVIDER_UNAUTHORIZED":
                raise ProviderRequestError(
                    "PROVIDER_AUTH_FAILED",
                    retryable=False,
                    outcome_unknown=False,
                    status_code=error.status_code,
                ) from error
            raise
        except TimeoutError as error:
            raise ProviderRequestError(
                "PROVIDER_TIMEOUT",
                retryable=True,
                outcome_unknown=True,
            ) from error
        return ProviderProbeResult(
            provider=provider,
            model=str(response.model or model)[:512],
            latency_ms=max(0, int((loop.time() - started) * 1000)),
            finish_reason=str(response.finish_reason or "stop")[:64],
        )
