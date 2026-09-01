"""Typed, failure-contained command dispatch."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from .contracts import (
    CommandEnvelopeV4,
    CommandResultV4,
    ErrorCode,
)
from .storage import IdempotencyConflict, KernelStore


logger = logging.getLogger("reverie.kernel.command_bus")
Handler = Callable[[CommandEnvelopeV4], Awaitable[Any]]


class CommandBus:
    def __init__(self, store: KernelStore) -> None:
        self.store = store
        self._handlers: dict[str, Handler] = {}

    def register(self, command: str, handler: Handler) -> None:
        if command in self._handlers:
            raise ValueError(f"handler already registered for {command}")
        self._handlers[command] = handler

    async def dispatch(self, command: CommandEnvelopeV4) -> CommandResultV4:
        began = False
        active = self.store.active_persona()
        if active is not None and active != command.persona:
            return CommandResultV4.failure(
                command.request_id,
                code=ErrorCode.STALE_PERSONA,
                message="请求属于已过期的人格版本。",
            )
        handler = self._handlers.get(command.command)
        if handler is None:
            return CommandResultV4.failure(
                command.request_id,
                code=ErrorCode.MODULE_UNAVAILABLE,
                message="该功能模块当前不可用。",
            )
        try:
            existing = self.store.begin_command(command)
            began = True
            if existing.state == "committed":
                return CommandResultV4.success(command.request_id, existing.result)
            if existing.state == "outcome_unknown":
                return CommandResultV4.failure(
                    command.request_id,
                    code=ErrorCode.PROVIDER_OUTCOME_UNKNOWN,
                    message="上一次请求结果未知，为避免重复计费不会自动重试。",
                )
            if existing.state == "failed":
                # Terminal state: the previous attempt already ran the handler
                # (which may have produced LLM calls or side effects) before
                # failing. Re-running it here would repeat those side effects
                # only to discard the result at commit time, so short-circuit.
                return CommandResultV4.failure(
                    command.request_id,
                    code=ErrorCode.CONFLICT,
                    message="上一次请求未完成，为避免重复执行不会自动重试。",
                )
            if existing.state in {"generating", "dispatched"}:
                # Stale in-flight row from a crashed attempt. Its outcome is
                # unknowable from this process, so never re-run the handler:
                # settle the ledger (dispatched rows upgrade to
                # outcome_unknown inside fail_command) and refuse the replay.
                self.store.fail_command(command.request_id, error_code="PROVIDER_OUTCOME_UNKNOWN")
                return CommandResultV4.failure(
                    command.request_id,
                    code=ErrorCode.PROVIDER_OUTCOME_UNKNOWN,
                    message="上一次请求中途断开，为避免重复执行不会自动重试。",
                )
            value = await handler(command)
            committed = self.store.commit_command_result(command, value)
            return CommandResultV4.success(command.request_id, committed.result)
        except IdempotencyConflict:
            return CommandResultV4.failure(
                command.request_id,
                code=ErrorCode.CONFLICT,
                message="请求标识发生冲突，未执行重复操作。",
            )
        except PermissionError:
            if began:
                self.store.fail_command(command.request_id, error_code="CONSENT_REQUIRED")
            return CommandResultV4.failure(
                command.request_id,
                code=ErrorCode.CONSENT_REQUIRED,
                message="该操作需要用户明确授权。",
            )
        except (TypeError, ValueError):
            if began:
                self.store.fail_command(command.request_id, error_code="INVALID_REQUEST")
            return CommandResultV4.failure(
                command.request_id,
                code=ErrorCode.INVALID_REQUEST,
                message="请求内容无效。",
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception("Command failed outside a persona message: %s", command.command)
            try:
                self.store.fail_command(command.request_id, error_code=error.__class__.__name__)
            except Exception:
                logger.exception("Could not persist failed command state")
            return CommandResultV4.failure(
                command.request_id,
                code=ErrorCode.INTERNAL,
                message="请求未完成。技术详情已写入本地日志。",
            )
