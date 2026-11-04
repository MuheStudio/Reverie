"""Fix only the first-cycle starts of the ordinary greeting and Moonroom turns.

Installed explicitly by the four isolated persona/worldbook bootstraps, after
their existing timing wrappers. Every call first delegates to the current
production planner; only a registered text's first occurrence in cycle one
gets a zero start wait. No delivery timing or evidence format is changed.
"""
from __future__ import annotations

import functools


# Kept equal to p1_memory_backend_bootstrap.REGISTERED_CHAT_TURNS by a unit test.
REGISTERED_CHAT_TURNS = (
    "你好，我喜欢和你一起看星空。",
    "阅读记录 1：请认真给我一份完整的项目说明",
    "阅读记录 2：请认真给我一份完整的项目说明",
    "停止记录",
    "组合记录：请认真给我一份完整的后续安排",
)
FIXTURE_REPLY_START_REASON = "isolated_moonroom_fixture"


def install_moonroom_reply_start(cycle: int):
    """Wrap the bridge planner once per bootstrap and return an idempotent undo.

    The first occurrence is consumed even if production returns no plan;
    repeats, other texts and other cycles return the original plan object.
    """
    from src.bridge import ws_bridge
    from src.chat.scheduler import ReplyStartPlan

    original_plan = ws_bridge._reply_start_planner
    seen: set[str] = set()

    @functools.wraps(original_plan)
    def plan(text):
        result = original_plan(text)
        if (cycle != 1 or not isinstance(text, str)
                or text not in REGISTERED_CHAT_TURNS or text in seen):
            return result
        seen.add(text)
        if result is None:
            return result
        return ReplyStartPlan(0.0, result.immediate_probability, result.status,
                              FIXTURE_REPLY_START_REASON)

    ws_bridge._reply_start_planner = plan
    restored = False

    def undo():
        nonlocal restored
        if not restored:
            ws_bridge._reply_start_planner = original_plan
            restored = True
    return undo
