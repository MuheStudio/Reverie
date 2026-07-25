import random
from datetime import datetime

from src.chat.scheduler import MessageScheduler


def test_scheduler_clamps_non_sleep_delay_thresholds() -> None:
    scheduler = MessageScheduler(reply_delay_min=90, reply_delay_max=-5)

    assert scheduler.reply_delay_min == 1.0
    assert scheduler.reply_delay_max == 60.0


def test_scheduler_status_payload_uses_chinese_labels() -> None:
    scheduler = MessageScheduler(status="busy")

    assert scheduler.status_payload() == {
        "status": "busy",
        "label": "忙碌",
        "is_available": True,
        "immediate_reply_probability": 0.68,
    }


def test_scheduler_retract_probability_is_fixed(monkeypatch) -> None:
    scheduler = MessageScheduler()

    monkeypatch.setattr(random, "random", lambda: 0.0009)
    assert scheduler.should_retract_message() is True

    monkeypatch.setattr(random, "random", lambda: 0.0011)
    assert scheduler.should_retract_message() is False


def test_message_complexity_and_length_increase_typing_delay(monkeypatch) -> None:
    scheduler = MessageScheduler(reply_delay_min=3, reply_delay_max=3)
    monkeypatch.setattr(random, "triangular", lambda *_args: 3.0)
    monkeypatch.setattr(random, "uniform", lambda *_args: 1.0)

    simple = scheduler.calculate_delay(10, user_message="你好")
    complex_delay = scheduler.calculate_delay(
        100,
        user_message="请比较两个方案，解释为什么，并给我一个分步骤计划？还有哪些风险？",
    )

    assert complex_delay > simple
    assert scheduler.typing_duration(100) > scheduler.typing_duration(10)


def test_busy_and_sleeping_states_can_defer_reply_start(monkeypatch) -> None:
    monkeypatch.setattr(random, "random", lambda: 0.99)
    monkeypatch.setattr(random, "uniform", lambda low, high: low)

    busy = MessageScheduler(status="busy").plan_reply_start("请帮我想想")
    sleeping = MessageScheduler(status="sleeping").plan_reply_start(
        "晚安了吗",
        now=datetime(2099, 1, 1, 23, 30),
    )

    assert busy.reason == "busy_deferred"
    assert busy.start_delay >= 120
    assert sleeping.reason == "sleep_until_wake"
    assert sleeping.start_delay > 8 * 60 * 60


def test_short_replies_are_the_majority_bucket(monkeypatch) -> None:
    scheduler = MessageScheduler()
    rolls = iter([0.10] * 70 + [0.80] * 25 + [0.99] * 5)
    monkeypatch.setattr(random, "random", lambda: next(rolls))
    text = "这是一段足够长的聊天回复，用来验证长度分布控制会把大多数回复压缩成短消息，同时保留少量中长消息。" * 3

    for _ in range(100):
        scheduler.shape_reply_length(text, allow_long=True)

    stats = scheduler.get_length_stats()
    assert stats["short_ratio"] == 0.70
    assert stats["medium_ratio"] == 0.25
    assert stats["long_ratio"] == 0.05
