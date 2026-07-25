from src.relationship.tracker import RelationshipTracker, build_relationship_prompt_context


def test_relationship_growth_stages_are_chinese_and_thresholded() -> None:
    assert RelationshipTracker(0).stage == "初识期"
    assert RelationshipTracker(100).stage == "熟悉期"
    assert RelationshipTracker(500).stage == "依赖期"
    assert RelationshipTracker(2000).stage == "特殊关系期"


def test_relationship_snapshot_exposes_growth_rules() -> None:
    snapshot = RelationshipTracker(520).snapshot()

    assert snapshot["stage"] == "依赖期"
    assert snapshot["stage_key"] == "dependent"
    assert snapshot["stage_number"] == 3
    assert "委屈" in snapshot["stage_detail"]
    assert "昵称" in snapshot["address_style"]
    assert snapshot["proactive_multiplier"] == 1.35
    assert [item["label"] for item in snapshot["thresholds"]] == [
        "初识期",
        "熟悉期",
        "依赖期",
        "特殊关系期",
    ]


def test_relationship_prompt_context_prevents_instant_max_affection() -> None:
    context = build_relationship_prompt_context(20)

    assert "初识期" in context
    assert "Do not use possessive jealousy" in context
    assert "emotional closeness is earned" not in context


def test_relationship_state_persists_across_sessions(tmp_path) -> None:
    state_path = tmp_path / "relationship" / "state.json"
    tracker = RelationshipTracker(120, state_path=state_path)
    tracker.on_special_event(importance=2.0)

    restored = RelationshipTracker(0, state_path=state_path)

    assert restored.intimacy == 140
    assert restored.stage == "熟悉期"


def test_chinese_messages_grow_relationship_without_spaces() -> None:
    tracker = RelationshipTracker(0)

    tracker.on_user_message("今天过得怎么样呀")

    assert tracker.intimacy == 1
    assert tracker.interaction_count == 1


def test_repeated_message_cannot_farm_intimacy() -> None:
    tracker = RelationshipTracker(0)

    tracker.on_user_message("晚安晚安")
    tracker.on_user_message("晚安晚安")

    assert tracker.intimacy == 1
    assert tracker.interaction_count == 1


def test_rapid_unique_messages_are_growth_rate_limited() -> None:
    tracker = RelationshipTracker(0)

    for index in range(10):
        tracker.on_user_message(f"第{index}条不同消息")

    assert tracker.interaction_count == 6
    assert tracker.intimacy == 6


def test_emotional_outcome_changes_relationship_history() -> None:
    tracker = RelationshipTracker(100)

    tracker.on_emotional_result({"joy": 8, "touched": 6})
    tracker.on_emotional_result({"anger": 8, "grievance": 5})

    assert tracker.positive_interactions == 1
    assert tracker.negative_interactions == 1
    assert tracker.intimacy == 101


def test_early_stage_strips_unearned_intimate_addressing() -> None:
    initial = RelationshipTracker(20)
    special = RelationshipTracker(2200)

    assert "宝贝" not in initial.enforce_addressing("宝贝，你还好吗")
    assert special.enforce_addressing("宝贝，你还好吗") == "宝贝，你还好吗"
