from src.config.settings import FeatureSettings, MemorySettings
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona
from src.user import UserManager


def test_memory_retrieve_falls_back_to_permanent(monkeypatch, tmp_path) -> None:
    settings = MemorySettings(lancedb_path=str(tmp_path / "vectors"))
    memory = MemoryManager(default_persona(), settings)

    def broken_search(*args, **kwargs):
        raise RuntimeError("embedding unavailable")

    monkeypatch.setattr(memory.layers, "search_all", broken_search)
    result = memory.retrieve_relevant("hello", k=2)

    assert result
    assert any("My name is" in item for item in result)


def test_permanent_memories_are_listed_directly(tmp_path) -> None:
    settings = MemorySettings(lancedb_path=str(tmp_path / "vectors"))
    memory = MemoryManager(default_persona(), settings)

    permanent = memory.layers.get_permanent_memories()

    assert len(permanent) == memory.store.count("permanent")
    assert any("My name is" in item for item in permanent)


def test_sync_user_profile_refreshes_permanent_user_facts(tmp_path) -> None:
    settings = MemorySettings(lancedb_path=str(tmp_path / "vectors"))
    memory = MemoryManager(default_persona(), settings)
    user_manager = UserManager(data_dir=tmp_path / "user")
    user_manager.ensure_default_profile()

    memory.sync_user_profile(user_manager)
    assert any("星野白夜" in item for item in memory.layers.get_permanent_memories())

    user_manager.update_profile({"name": "测试白夜", "nickname": "测试"})
    memory.sync_user_profile(user_manager)
    user_facts = [
        item
        for item in memory.layers.get_permanent_memories()
        if item.startswith("用户档案：")
    ]

    assert any("测试白夜" in item for item in user_facts)
    assert not any("星野白夜" in item for item in user_facts)


def test_memory_manager_applies_runtime_forgetting_settings(tmp_path) -> None:
    settings = MemorySettings(lancedb_path=str(tmp_path / "vectors"))
    features = FeatureSettings(autonomous_memory_enabled=False)
    memory = MemoryManager(default_persona(), settings, feature_settings=features)

    assert memory.autonomous_enabled is False

    next_settings = MemorySettings(
        lancedb_path=str(tmp_path / "vectors"),
        long_term_forgetting_enabled=False,
        short_term_forgetting_enabled=True,
        long_term_forget_days=120,
        short_term_forget_days=12,
        long_term_forget_probability=0.07,
        short_term_forget_probability=0.02,
        long_term_misremembering_enabled=False,
        short_term_misremembering_enabled=True,
        long_term_misremember_probability=0.05,
        short_term_misremember_probability=0.02,
    )
    next_features = FeatureSettings(
        autonomous_memory_enabled=True,
        autonomous_memory_llm_enabled=True,
        self_growth_enabled=True,
        self_growth_from_web_enabled=True,
        self_growth_from_memory_enabled=True,
        self_growth_interval_days=45,
    )

    memory.apply_settings(next_settings, next_features)
    snapshot = memory.settings_snapshot()

    assert memory.autonomous_enabled is True
    assert memory.autonomous_llm_enabled is True
    assert memory.forgetting.long_term_forgetting_enabled is False
    assert memory.forgetting.short_term_forget_days == 12
    assert memory.forgetting.long_term_misremembering_enabled is False
    assert memory.forgetting.short_term_misremember_probability == 0.02
    assert snapshot["long_term_forget_probability"] == 0.07
    assert snapshot["short_term_forget_probability"] == 0.02
    assert snapshot["long_term_misremember_probability"] == 0.05
    assert snapshot["short_term_misremember_probability"] == 0.02
    assert snapshot["self_growth_from_web_enabled"] is False
    assert snapshot["reembedding_state"] in {"ready", "organizing", "lexical_only"}
    if snapshot["reembedding_state"] == "lexical_only":
        assert snapshot["semantic_recall_available"] is False
        assert "词法检索" in snapshot["embedding_diagnostic"]
    assert snapshot["self_growth_interval_days"] == 45


def test_self_growth_cycle_stores_memory_signal_as_long_term(monkeypatch, tmp_path) -> None:
    settings = MemorySettings(lancedb_path=str(tmp_path / "vectors"))
    features = FeatureSettings(
        self_growth_enabled=True,
        self_growth_from_memory_enabled=True,
        self_growth_interval_days=30,
    )
    memory = MemoryManager(default_persona(), settings, feature_settings=features)
    memory.store_fact("用户最近一直在聊画画和天文学，她有点被这种兴趣感染。", layer="long_term")
    monkeypatch.setattr("src.memory.manager.random.choice", lambda items: items[0])

    result = memory.run_self_growth_cycle()

    assert result["grown"] == 1
    assert any(
        str(row.get("text", "")).startswith("Self-growth memory:")
        for row in memory.store.list_by_layer("long_term")
    )
