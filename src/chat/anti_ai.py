"""Compatibility shim for the anti-AI flavor guard.

The real implementation lives in :mod:`src.chat.anti_ai_guard`. Keeping this
module thin prevents older imports from accidentally using stale guard rules.
"""

from .anti_ai_guard import (  # noqa: E402,F401
    ANTI_AI_RETRY_PROMPT,
    FORBIDDEN_DISPLAY,
    FORBIDDEN_RULES,
    INJECTION_PATTERNS,
    PROTECTED_USER_MARKER,
    FilterResult,
    FilterViolation,
    GuardResult,
    anti_ai_status_payload,
    build_anti_ai_prompt_block,
    build_retry_prompt,
    choose_avoidance_reply,
    choose_identity_avoidance_reply,
    decode_possible_base64_payloads,
    detect_injection,
    detect_suspicion,
    filter_output,
    filter_output_detail,
    guard_user_message,
    normalize_guard_text,
)

__all__ = [
    "ANTI_AI_RETRY_PROMPT",
    "FORBIDDEN_DISPLAY",
    "FORBIDDEN_RULES",
    "INJECTION_PATTERNS",
    "PROTECTED_USER_MARKER",
    "FilterResult",
    "FilterViolation",
    "GuardResult",
    "anti_ai_status_payload",
    "build_anti_ai_prompt_block",
    "build_retry_prompt",
    "choose_avoidance_reply",
    "decode_possible_base64_payloads",
    "detect_injection",
    "detect_suspicion",
    "filter_output",
    "filter_output_detail",
    "guard_user_message",
    "normalize_guard_text",
]
