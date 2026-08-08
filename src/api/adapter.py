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

from ..config.settings import LLMSettings, SUPPORTED_PROVIDER_NAMES, load_settings
from ..config.usage_policy import UsagePolicy, get_usage_policy
from ..local_mode import LocalModeGate, get_local_mode_gate
from .network_policy import assert_provider_destination

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
            "PROVIDER_AUTH_FAILED": "供应商拒绝了凭据，请检查 API 密钥或账户权限。",
            "PROVIDER_RATE_LIMITED": "供应商暂时限流；Reverie 不会自动重试。",
            "PROVIDER_TIMEOUT": "供应商请求超时；结果未知，Reverie 不会自动重试。",
            "PROVIDER_UNREACHABLE": "无法连接到供应商；结果未知，Reverie 不会自动重试。",
            "PROVIDER_CONNECTION_FAILED": "供应商连接中断；结果未知，Reverie 不会自动重试。",
            "PROVIDER_INVALID_RESPONSE": "供应商返回了无法解析的响应。",
            "PROVIDER_INVALID_RESPONSE_SCHEMA": "供应商响应不符合 Chat Completions 协议。",
            "PROVIDER_EMPTY_RESPONSE": "供应商返回了空响应。",
            "PROVIDER_REASONING_ONLY_RESPONSE": "供应商只返回了思考过程，没有可显示的最终回答。",
            "PROVIDER_OUTPUT_TRUNCATED": "供应商输出达到长度上限，未形成完整回答。",
            "PROVIDER_CONTENT_FILTERED": "供应商过滤了本次测试输出。",
            "PROVIDER_TOOL_ONLY_RESPONSE": "供应商只返回了工具调用，当前聊天界面无法显示。",
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
            "PROVIDER_UNREACHABLE",
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


def _message_field(message: Any, name: str) -> Any:
    value = getattr(message, name, None)
    if value is not None:
        return value
    extra = getattr(message, "model_extra", None)
    return extra.get(name) if isinstance(extra, dict) else None


def parse_chat_completion(completion: Any) -> ChatResponse:
    """Validate the subset of Chat Completions that Reverie's text UI can consume."""

    choices = getattr(completion, "choices", None)
    if not isinstance(choices, (list, tuple)) or not choices:
        raise ProviderRequestError(
            "PROVIDER_INVALID_RESPONSE_SCHEMA",
            retryable=False,
            outcome_unknown=False,
        )
    choice = choices[0]
    message = getattr(choice, "message", None)
    if message is None:
        raise ProviderRequestError(
            "PROVIDER_INVALID_RESPONSE_SCHEMA",
            retryable=False,
            outcome_unknown=False,
        )
    finish_reason = str(getattr(choice, "finish_reason", None) or "stop")
    content = _message_field(message, "content")
    reasoning_content = _message_field(message, "reasoning_content")
    tool_calls = _message_field(message, "tool_calls")
    refusal = _message_field(message, "refusal")

    if finish_reason == "length":
        code = "PROVIDER_OUTPUT_TRUNCATED"
    elif finish_reason == "content_filter" or refusal:
        code = "PROVIDER_CONTENT_FILTERED"
    elif finish_reason == "tool_calls" or tool_calls:
        code = "PROVIDER_TOOL_ONLY_RESPONSE"
    elif content is not None and not isinstance(content, str):
        code = "PROVIDER_INVALID_RESPONSE_SCHEMA"
    elif isinstance(content, str) and content.strip():
        usage = getattr(completion, "usage", None)
        return ChatResponse(
            content=content,
            model=str(getattr(completion, "model", "") or ""),
            finish_reason=finish_reason,
            usage={
                "prompt_tokens": getattr(usage, "prompt_tokens", 0) if usage else 0,
                "completion_tokens": getattr(usage, "completion_tokens", 0) if usage else 0,
            },
        )
    elif isinstance(reasoning_content, str) and reasoning_content.strip():
        code = "PROVIDER_REASONING_ONLY_RESPONSE"
    else:
        code = "PROVIDER_INVALID_RESPONSE_SCHEMA"
    raise ProviderRequestError(
        code,
        retryable=False,
        outcome_unknown=False,
    )


def parse_anthropic_message(response: dict[str, Any]) -> ChatResponse:
    """Translate Anthropic's Messages response into the text-only UI contract."""

    content = response.get("content")
    if not isinstance(content, list):
        raise ProviderRequestError("PROVIDER_INVALID_RESPONSE_SCHEMA", retryable=False, outcome_unknown=False)
    text = "".join(
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
    )
    stop_reason = str(response.get("stop_reason") or "stop")
    if text.strip():
        usage = response.get("usage")
        return ChatResponse(
            content=text,
            model=str(response.get("model") or ""),
            finish_reason=stop_reason,
            usage={
                "prompt_tokens": usage.get("input_tokens", 0) if isinstance(usage, dict) else 0,
                "completion_tokens": usage.get("output_tokens", 0) if isinstance(usage, dict) else 0,
            },
        )
    code = "PROVIDER_OUTPUT_TRUNCATED" if stop_reason == "max_tokens" else "PROVIDER_INVALID_RESPONSE_SCHEMA"
    raise ProviderRequestError(code, retryable=False, outcome_unknown=False)


def _anthropic_request_messages(messages: list[ChatCompletionMessageParam]) -> tuple[str | None, list[dict[str, Any]]]:
    """Split OpenAI-style system prompts from Messages API conversation turns."""

    system_parts: list[str] = []
    turns: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "")
        content = message.get("content")
        if not isinstance(content, str):
            raise ProviderRequestError("PROVIDER_INVALID_RESPONSE_SCHEMA", retryable=False, outcome_unknown=False)
        if role == "system":
            system_parts.append(content)
        elif role in {"user", "assistant"}:
            turns.append({"role": role, "content": content})
        else:
            raise ProviderRequestError("PROVIDER_INVALID_RESPONSE_SCHEMA", retryable=False, outcome_unknown=False)
    if not turns:
        raise ProviderRequestError("PROVIDER_INVALID_RESPONSE_SCHEMA", retryable=False, outcome_unknown=False)
    return ("\n\n".join(system_parts) or None, turns)


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
        self.settings = (settings or load_settings().llm).model_copy(deep=True)
        if self.settings.provider not in SUPPORTED_PROVIDER_NAMES:
            raise ValueError("LLM provider is unsupported")
        self.settings.resolve()
        self._client: AsyncOpenAI | None = None
        self._client_signature: tuple[str, str, str, str] | None = None
        self._anthropic_client: httpx.AsyncClient | None = None
        self._anthropic_signature: tuple[str, str, str, str] | None = None
        self._ollama: OllamaClient | None = None
        self._retired_clients: list[Any] = []
        self._close_tasks: set[asyncio.Task[Any]] = set()
        self.budget_tracker = budget_tracker
        self.local_mode_gate = local_mode_gate or get_local_mode_gate()
        self.usage_policy = usage_policy or get_usage_policy()
        self.custom_headers = dict(custom_headers or {})

    def reset_client(self) -> None:
        """Drop cached provider clients after runtime settings change."""
        retired = [client for client in (self._client, self._anthropic_client) if client is not None]
        self._client = None
        self._client_signature = None
        self._anthropic_client = None
        self._anthropic_signature = None
        self._ollama = None
        for client in retired:
            try:
                task = asyncio.get_running_loop().create_task(self._close_client(client))
                self._close_tasks.add(task)
                task.add_done_callback(self._close_tasks.discard)
            except RuntimeError:
                self._retired_clients.append(client)

    async def _close_client(self, client: Any) -> None:
        try:
            result = client.close()
            if hasattr(result, "__await__"):
                await result
        except Exception:
            logger.exception("Failed to close retired provider client")

    async def close(self) -> None:
        """Release persistent HTTP transports owned by this adapter."""
        clients = [client for client in [self._client, self._anthropic_client, *self._retired_clients] if client is not None]
        self._client = None
        self._client_signature = None
        self._anthropic_client = None
        self._anthropic_signature = None
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
        disable_reasoning: bool = False,
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
            await assert_provider_destination(
                str(provider),
                str(self.settings.base_url),
            )
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
                if provider == "anthropic":
                    response = await self._anthropic_chat(messages, temperature, max_tokens, selected_model)
                elif provider == "ollama":
                    response = await self._ollama_chat(
                        messages,
                        temperature,
                        max_tokens,
                        selected_model,
                    )
                elif disable_reasoning:
                    response = await self._openai_chat(
                        messages,
                        temperature,
                        max_tokens,
                        selected_model,
                        disable_reasoning=True,
                    )
                else:
                    response = await self._openai_chat(
                        messages,
                        temperature,
                        max_tokens,
                        selected_model,
                    )
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
        *,
        disable_reasoning: bool = False,
    ) -> ChatResponse:
        client = self._get_openai_client()
        request: dict[str, Any] = {
            "model": model or self.settings.model,
            "messages": messages,
            "temperature": temperature if temperature is not None else self.settings.temperature,
            "max_tokens": max_tokens if max_tokens is not None else self.settings.max_tokens,
        }
        if disable_reasoning:
            request["extra_body"] = {"thinking": {"type": "disabled"}}
        completion = await client.chat.completions.create(
            **request,
        )
        return parse_chat_completion(completion)

    async def _ollama_chat(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
        *,
        disable_reasoning: bool = False,
    ) -> ChatResponse:
        # Ollama exposes an OpenAI-compatible chat endpoint.
        if disable_reasoning:
            return await self._openai_chat(
                messages,
                temperature,
                max_tokens,
                model,
                disable_reasoning=True,
            )
        return await self._openai_chat(messages, temperature, max_tokens, model)

    async def _anthropic_chat(
        self,
        messages: list[ChatCompletionMessageParam],
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
    ) -> ChatResponse:
        system, turns = _anthropic_request_messages(messages)
        payload: dict[str, Any] = {
            "model": model or self.settings.model,
            "messages": turns,
            "max_tokens": max_tokens if max_tokens is not None else self.settings.max_tokens,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if system:
            payload["system"] = system
        response = await self._get_anthropic_client().post("/v1/messages", json=payload)
        response.raise_for_status()
        try:
            body = response.json()
        except (json.JSONDecodeError, UnicodeError) as exc:
            raise ProviderRequestError("PROVIDER_INVALID_RESPONSE", retryable=False, outcome_unknown=False) from exc
        if not isinstance(body, dict):
            raise ProviderRequestError("PROVIDER_INVALID_RESPONSE_SCHEMA", retryable=False, outcome_unknown=False)
        return parse_anthropic_message(body)

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
                http_client=httpx.AsyncClient(
                    trust_env=False,
                    follow_redirects=False,
                    timeout=httpx.Timeout(60.0, connect=10.0),
                    limits=httpx.Limits(
                        max_connections=4,
                        max_keepalive_connections=2,
                    ),
                ),
            )
            self._client_signature = signature
        return self._client

    def _get_anthropic_client(self) -> httpx.AsyncClient:
        signature = (
            str(self.settings.provider),
            str(self.settings.base_url),
            str(self.settings.api_key),
            json.dumps(self.custom_headers, sort_keys=True, separators=(",", ":")),
        )
        if self._anthropic_client is None or self._anthropic_signature != signature:
            headers = {
                "x-api-key": self.settings.api_key,
                "anthropic-version": "2023-06-01",
                **self.custom_headers,
            }
            self._anthropic_client = httpx.AsyncClient(
                base_url=self.settings.base_url.rstrip("/"),
                headers=headers,
                trust_env=False,
                follow_redirects=False,
                timeout=httpx.Timeout(60.0, connect=10.0),
                limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
            )
            self._anthropic_signature = signature
        return self._anthropic_client
