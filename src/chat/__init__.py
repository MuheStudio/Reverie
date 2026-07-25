# Chat system module

from .session import ChatSession
from .scheduler import MessageScheduler
from .anti_ai import (
    anti_ai_status_payload,
    build_anti_ai_prompt_block,
    detect_injection,
    filter_output,
    filter_output_detail,
    guard_user_message,
)
from .typo import apply_typos

__all__ = [
    "ChatSession",
    "MessageScheduler",
    "ProactiveChat",
    "ProactiveResult",
    "apply_typos",
    "anti_ai_status_payload",
    "build_anti_ai_prompt_block",
    "detect_injection",
    "filter_output",
    "filter_output_detail",
    "guard_user_message",
]


def __getattr__(name: str):
    """Keep proactive chat optional while preserving the public import API."""

    if name in {"ProactiveChat", "ProactiveResult"}:
        from .proactive import ProactiveChat, ProactiveResult

        return {"ProactiveChat": ProactiveChat, "ProactiveResult": ProactiveResult}[name]
    raise AttributeError(name)
