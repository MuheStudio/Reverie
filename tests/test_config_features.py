from src.config.settings import FeatureSettings, LLMSettings


def test_deprecated_deepseek_models_migrate_to_current_flash_model() -> None:
    assert LLMSettings(provider="deepseek", model="deepseek-chat").model == "deepseek-v4-flash"
    assert LLMSettings(provider="deepseek", model="deepseek-reasoner").model == "deepseek-v4-flash"
    assert LLMSettings(provider="deepseek", model="deepseek-v4-flash").model == "deepseek-v4-flash"
    assert LLMSettings(provider="deepseek", model="deepseek-v4-pro").model == "deepseek-v4-pro"


def test_feature_settings_defaults() -> None:
    settings = FeatureSettings()

    assert settings.diary_enabled is False
    assert settings.diary_privacy_enabled is True
    assert settings.diary_peek_enabled is True
    assert settings.web_surfing_enabled is False
    assert settings.web_disclaimer_acknowledged is False
    assert settings.web_search_windows == ["20:00-23:00"]
    assert settings.timeline_enabled is False
    assert settings.proactive_chat_enabled is False
    assert settings.late_night_enabled is False
    assert 0.01 <= settings.late_night_probability <= 0.30
    assert settings.late_night_message_enabled is False
    assert settings.self_growth_enabled is True
    assert settings.self_growth_from_memory_enabled is True
    assert settings.self_growth_from_web_enabled is False
    assert 30 <= settings.self_growth_interval_days <= 365
    assert settings.personality_flaws_enabled is True
    assert "路痴" in settings.user_selected_flaws
    assert settings.emotion_system_enabled is True
    assert 1 <= settings.emotion_carryover_days <= 7
    assert 0.01 <= settings.emotion_inertia_factor <= 0.60
    assert settings.world_life_enabled is True
    assert settings.timeline_visuals_enabled is False
    assert settings.group_social_enabled is True
    assert settings.group_social_permanent_memory_enabled is True
    assert settings.keepsake_collection_enabled is True
    assert 0.01 <= settings.keepsake_recall_probability <= 0.30
    assert "政治" not in settings.web_allowed_topics
    assert "社会热点" not in settings.web_allowed_topics
