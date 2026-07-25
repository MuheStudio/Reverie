"""Unified LLM adapter for cloud providers and Ollama."""

from __future__ import annotations

import asyncio
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
    ) -> None:
        self.settings = settings or load_settings().llm
        self._client: AsyncOpenAI | None = None
        self._client_signature: tuple[str, str, str] | None = None
        self._ollama: OllamaClient | None = None
        self._retired_clients: list[Any] = []
        self._close_tasks: set[asyncio.Task[Any]] = set()
        self.budget_tracker = budget_tracker
        self.local_mode_gate = local_mode_gate or get_local_mode_gate()
        self.usage_policy = usage_policy or get_usage_policy()

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
                # A response generated under revoked consent is never returned
                # to a caller that could persist or display it.
                self.usage_policy.validate(usage_lease)
            except BaseException as exc:
                if self.budget_tracker is not None:
                    try:
                        self.budget_tracker.fail(call_id, exc)
                    except Exception:
                        logger.exception("API failure could not be written to budget ledger")
                raise
            if self.budget_tracker is not None:
                try:
                    self.budget_tracker.complete(call_id, response.usage)
                except Exception:
                    logger.exception("API usage could not be written to budget ledger")
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
        )
        if self._client is None or self._client_signature != signature:
            self._client = AsyncOpenAI(
                api_key=self.settings.api_key or "ollama",
                base_url=self.settings.base_url,
            )
            self._client_signature = signature
        return self._client
