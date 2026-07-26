"""Unified LLM adapter for cloud providers and Ollama."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from ..config.settings import LLMSettings, load_settings
from ..config.usage_policy import UsagePolicy, get_usage_policy
from ..local_mode import LocalModeGate, get_local_mode_gate

if TYPE_CHECKING:
    from ollama import AsyncClient as OllamaClient
    from .budget import ApiBudgetTracker

logger = logging.getLogger("reverie.api")

_RESERVED_CUSTOM_HEADERS = {
    "authorization",
    "content-length",
    "host",
    "x-api-key",
}


def parse_custom_headers(value: str | None) -> dict[str, str]:
    """Parse the desktop header editor into a bounded, injection-safe mapping."""

    if not value:
        return {}
    if len(value) > 16 * 1024 or "\x00" in value:
        raise ValueError("custom headers are invalid")
    result: dict[str, str] = {}
    lines = value.splitlines()
    if len(lines) > 32:
        raise ValueError("too many custom headers")
    for line in lines:
        name, separator, raw_value = line.partition(":")
        name = name.strip()
        header_value = raw_value.strip()
        if (
            not separator
            or not name
            or not header_value
            or len(name) > 128
            or len(header_value) > 4096
            or name.lower() in _RESERVED_CUSTOM_HEADERS
            or not all(char.isalnum() or char in "!#$%&'*+-.^_`|~" for char in name)
            or any(ord(char) < 32 or ord(char) == 127 for char in header_value)
        ):
            raise ValueError("custom headers are invalid")
        result[name] = header_value
    return result


class ProviderRequestError(RuntimeError):
    """Sanitized provider failure safe for ledgers and technical UI."""

    def __init__(
        self,
        code: str,
        *,
        retryable: bool,
        outcome_unknown: bool,
        status_code: int | None = None,
    ) -> None:
        self.code = code
        self.retryable = retryable
        self.outcome_unknown = outcome_unknown
        self.status_code = status_code
        messages = {
            "PROVIDER_UNAUTHORIZED": "供应商拒绝了凭据，请检查 API 密钥。",
            "PROVIDER_RATE_LIMITED": "供应商暂时限流；Reverie 不会自动重试。",
            "PROVIDER_TIMEOUT": "供应商请求超时；结果未知，Reverie 不会自动重试。",
            "PROVIDER_CONNECTION_FAILED": "供应商连接中断；结果未知，Reverie 不会自动重试。",
            "PROVIDER_INVALID_RESPONSE": "供应商返回了无法解析的响应。",
            "PROVIDER_EMPTY_RESPONSE": "供应商返回了空响应。",
            "PROVIDER_REJECTED": "供应商拒绝了本次请求。",
            "PROVIDER_FAILURE": "供应商请求失败。",
        }
        super().__init__(messages.get(code, messages["PROVIDER_FAILURE"]))


def normalize_provider_error(error: BaseException) -> ProviderRequestError:
    """Map SDK/vendor failures without exposing their raw body or headers."""
    if isinstance(error, ProviderRequestError):
        return error
    status = getattr(error, "status_code", None)
    if not isinstance(status, int):
        response = getattr(error, "response", None)
        status = getattr(response, "status_code", None)
    name = error.__class__.__name__.lower()
    if status in {401, 403}:
        return ProviderRequestError(
            "PROVIDER_UNAUTHORIZED",
            retryable=False,
            outcome_unknown=False,
            status_code=status,
        )
    if status == 429:
        return ProviderRequestError(
            "PROVIDER_RATE_LIMITED",
            retryable=True,
            outcome_unknown=False,
            status_code=status,
        )
    if isinstance(error, (TimeoutError, httpx.TimeoutException)) or "timeout" in name:
        return ProviderRequestError(
            "PROVIDER_TIMEOUT",
            retryable=True,
            outcome_unknown=True,
            status_code=status,
        )
    if isinstance(error, (ConnectionError, httpx.NetworkError)) or "connection" in name:
        return ProviderRequestError(
            "PROVIDER_CONNECTION_FAILED",
            retryable=True,
            outcome_unknown=True,
            status_code=status,
        )
    if isinstance(error, (json.JSONDecodeError, UnicodeError)) or "json" in name:
        return ProviderRequestError(
            "PROVIDER_INVALID_RESPONSE",
            retryable=False,
            outcome_unknown=False,
            status_code=status,
        )
    if isinstance(status, int):
        return ProviderRequestError(
            "PROVIDER_REJECTED",
            retryable=status >= 500,
            outcome_unknown=status >= 500,
            status_code=status,
        )
    return ProviderRequestError(
        "PROVIDER_FAILURE",
        retryable=False,
        outcome_unknown=True,
    )


@dataclass
class ChatResponse:
    """Standardized response from any LLM provider."""

    content: str
    model: str = ""
    finish_reason: str = "stop"
    usage: dict = field(default_factory=dict)


class LLMAdapter:
    """Single entry point for all LLM calls."""

    def __init__(
        self,
        settings: LLMSettings | None = None,
        *,
        budget_tracker: "ApiBudgetTracker | None" = None,
        local_mode_gate: LocalModeGate | None = None,
        usage_policy: UsagePolicy | None = None,
        custom_headers: dict[str, str] | None = None,
    ) -> None:
        self.settings = settings or load_settings().llm
        self._client: AsyncOpenAI | None = None
        self._client_signature: tuple[str, str, str, str] | None = None
        self._ollama: OllamaClient | None = None
        self._retired_clients: list[Any] = []
        self._close_tasks: set[asyncio.Task[Any]] = set()
        self.budget_tracker = budget_tracker
        self.local_mode_gate = local_mode_gate or get_local_mode_gate()
        self.usage_policy = usage_policy or get_usage_policy()
        self.custom_headers = dict(custom_headers or {})

    def reset_client(self) -> None:
        """Drop cached provider clients after runtime settings change."""
        retired = self._client
        self._client = None
        self._client_signature = None
        self._ollama = None
        if retired is not None:
            try:
                task = asyncio.get_running_loop().create_task(self._close_client(retired))
                self._close_tasks.add(task)
                task.add_done_callback(self._close_tasks.discard)
            except RuntimeError:
                self._retired_clients.append(retired)

    async def _close_client(self, client: Any) -> None:
        try:
            result = client.close()
            if hasattr(result, "__await__"):
                await result
        except Exception:
            logger.exception("Failed to close retired provider client")

    async def close(self) -> None:
        """Release persistent HTTP transports owned by this adapter."""
        clients = [client for client in [self._client, *self._retired_clients] if client is not None]
        self._client = None
        self._client_signature = None
        self._retired_clients = []
        for client in clients:
            await self._close_client(client)
        if self._close_tasks:
            await asyncio.gather(*tuple(self._close_tasks), return_exceptions=True)
            self._close_tasks.clear()

    async def chat(
        self,
        messages: list[ChatCompletionMessageParam],
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        purpose: str = "unclassified",
        background: bool = False,
    ) -> ChatResponse:
        """Send a conversation and get the assistant's reply."""
        # Consent is checked before local-mode checks, budget writes, provider
        # client construction or network I/O.  New background purposes fail
        # closed until explicitly classified in the policy.
        usage_lease = self.usage_policy.begin_for_purpose(purpose, background=background)
        try:
            # This check deliberately lives at the lowest shared adapter boundary.
            # Callers cannot accidentally bypass local mode by using a new feature.
            self.local_mode_gate.require_remote("LLM request")
            provider = self.settings.provider
            selected_model = str(model or self.settings.model).strip()
            if not selected_model:
                raise ValueError("LLM model is empty")
            requested_max = max_tokens or self.settings.max_tokens
            call_id: str | None = None
            if self.budget_tracker is not None:
                from .budget import ApiBudgetExceeded

                try:
                    call_id = self.budget_tracker.begin(
                        provider=str(provider),
                        model=selected_model,
                        purpose=purpose,
                        background=background,
                        estimated_tokens=self.budget_tracker.estimate_tokens(messages, requested_max),
                    )
                except ApiBudgetExceeded:
                    raise
                except Exception:
                    logger.exception("API budget ledger unavailable; provider call continues")
            try:
                if provider == "ollama":
                    response = await self._ollama_chat(messages, temperature, max_tokens, selected_model)
                elif provider == "anthropic":
                    response = await self._anthropic_chat(messages, temperature, max_tokens, selected_model)
                else:
                    response = await self._openai_chat(messages, temperature, max_tokens, selected_model)
                if not isinstance(response.content, str) or not response.content.strip():
                    raise ProviderRequestError(
                        "PROVIDER_EMPTY_RESPONSE",
                        retryable=False,
                        outcome_unknown=False,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                normalized = normalize_provider_error(exc)
                if self.budget_tracker is not None:
                    try:
                        self.budget_tracker.fail(call_id, normalized)
                    except Exception:
                        logger.exception("API failure could not be written to budget ledger")
                raise normalized from exc
            if self.budget_tracker is not None:
                try:
                    self.budget_tracker.complete(call_id, response.usage)
                except Exception:
                    logger.exception("API usage could not be written to budget ledger")
            # A response generated under revoked consent is accounted for but
            # never returned to a caller that could persist or display it.
            self.usage_policy.validate(usage_lease)
            return response
        finally:
            self.usage_policy.finish(usage_lease)

    def budget_snapshot(self) -> dict[str, Any] | None:
        return self.budget_tracker.snapshot() if self.budget_tracker is not None else None

    async def _openai_chat(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> ChatResponse:
        client = self._get_openai_client()
        completion = await client.chat.completions.create(
            model=model or self.settings.model,
            messages=messages,
            temperature=temperature if temperature is not None else self.settings.temperature,
            max_tokens=max_tokens or self.settings.max_tokens,
        )
        choice = completion.choices[0]
        return ChatResponse(
            content=choice.message.content or "",
            model=completion.model,
            finish_reason=choice.finish_reason or "stop",
            usage={
                "prompt_tokens": completion.usage.prompt_tokens if completion.usage else 0,
                "completion_tokens": completion.usage.completion_tokens if completion.usage else 0,
            },
        )

    async def _ollama_chat(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> ChatResponse:
        # Ollama exposes an OpenAI-compatible chat endpoint.
        return await self._openai_chat(messages, temperature, max_tokens, model)

    async def _anthropic_chat(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> ChatResponse:
        """Call Anthropic's native Messages API."""
        if not self.settings.api_key:
            raise ValueError("ANTHROPIC_API_KEY is required for Anthropic provider")

        system_parts: list[str] = []
        anthropic_messages: list[dict[str, str]] = []
        for message in messages:
            role = str(message.get("role", "user"))
            content = self._message_content_to_text(message.get("content", ""))
            if not content:
                continue

            if role == "system":
                system_parts.append(content)
            elif role in {"user", "assistant"}:
                anthropic_messages.append({"role": role, "content": content})
            else:
                anthropic_messages.append({"role": "user", "content": content})

        if not anthropic_messages:
            raise ValueError("Anthropic request requires at least one user or assistant message")

        payload: dict[str, Any] = {
            "model": model or self.settings.model,
            "messages": anthropic_messages,
            "max_tokens": max_tokens or self.settings.max_tokens,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)

        base_url = self.settings.base_url.rstrip("/")
        url = f"{base_url}/messages" if base_url.endswith("/v1") else f"{base_url}/v1/messages"
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                url,
                headers={
                    **self.custom_headers,
                    "x-api-key": self.settings.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        content_blocks = data.get("content", [])
        text = "".join(
            block.get("text", "")
            for block in content_blocks
            if isinstance(block, dict) and block.get("type") == "text"
        )
        usage = data.get("usage") or {}
        return ChatResponse(
            content=text,
            model=data.get("model", model or self.settings.model),
            finish_reason=data.get("stop_reason") or "stop",
            usage={
                "prompt_tokens": usage.get("input_tokens", 0),
                "completion_tokens": usage.get("output_tokens", 0),
            },
        )

    @staticmethod
    def _message_content_to_text(content: Any) -> str:
        """Flatten simple chat message content into plain text."""
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    if item.get("type") == "text" and isinstance(item.get("text"), str):
                        parts.append(item["text"])
                    elif isinstance(item.get("content"), str):
                        parts.append(item["content"])
            return "\n".join(parts)
        return str(content)

    def _get_openai_client(self) -> AsyncOpenAI:
        signature = (
            str(self.settings.provider),
            str(self.settings.base_url),
            str(self.settings.api_key),
            json.dumps(self.custom_headers, sort_keys=True, separators=(",", ":")),
        )
        if self._client is None or self._client_signature != signature:
            self._client = AsyncOpenAI(
                api_key=self.settings.api_key or "ollama",
                base_url=self.settings.base_url,
                # The SDK otherwise retries 408/409/429/5xx and connection
                # errors automatically. Reverie cannot prove those retries are
                # free or idempotent after dispatch.
                max_retries=0,
                default_headers=self.custom_headers or None,
            )
            self._client_signature = signature
        return self._client
