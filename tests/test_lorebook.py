"""
Lorebook 单元测试
"""
import pytest
from src.lorebook import LoreEntry, Lorebook, LorebookMatcher, LorebookManager


class TestLoreEntry:
    def test_get_keys_single(self):
        entry = LoreEntry(key="猫咪")
        assert entry.get_keys() == ["猫咪"]

    def test_get_keys_multiple(self):
        entry = LoreEntry(key="猫咪, 猫娘, 猫耳")
        assert entry.get_keys() == ["猫咪", "猫娘", "猫耳"]

    def test_get_keys_empty(self):
        entry = LoreEntry(key="")
        assert entry.get_keys() == []

    def test_build_pattern(self):
        entry = LoreEntry(key="hello, world")
        pattern = entry.build_pattern()
        assert pattern is not None
        assert pattern.search("hello there")
        assert pattern.search("WORLD")

    def test_always_active(self):
        entry = LoreEntry(key="", always_active=True, content="始终激活的内容")
        matched, reason = LorebookMatcher.match_entry(entry, [])
        assert matched
        assert "始终激活" in reason


class TestLorebookMatcher:
    def test_match_basic(self):
        entry = LoreEntry(key="猫咪")
        messages = [{"role": "user", "content": "我喜欢猫咪"}]
        matched, reason = LorebookMatcher.match_entry(entry, messages)
        assert matched
        assert "猫咪" in reason

    def test_no_match(self):
        entry = LoreEntry(key="狗狗")
        messages = [{"role": "user", "content": "我喜欢猫咪"}]
        matched, reason = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_second_key_and(self):
        entry = LoreEntry(key="猫咪", second_key="宠物", selective=True)
        messages = [{"role": "user", "content": "我喜欢猫咪作为宠物"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_second_key_fail(self):
        entry = LoreEntry(key="猫咪", second_key="大型动物", selective=True)
        messages = [{"role": "user", "content": "我喜欢猫咪"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_second_key_primary_only_match(self):
        # selective=True：仅 primary 命中不足以触发 AND 语义
        entry = LoreEntry(key="猫咪", second_key="宠物", selective=True)
        messages = [{"role": "user", "content": "我喜欢猫咪"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_second_key_all_match(self):
        # selective=True：primary 与 secondary 同时命中才触发
        entry = LoreEntry(key="猫咪", second_key="宠物", selective=True)
        messages = [{"role": "user", "content": "我养了一只猫咪作为宠物"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_selective_false_ignores_secondary(self):
        # selective=False：即使提供 second_key 也忽略，仅按 primary 匹配
        entry = LoreEntry(key="猫咪", second_key="大型动物")
        messages = [{"role": "user", "content": "我喜欢猫咪"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_folder_skip(self):
        entry = LoreEntry(key="test", content="test", mode="folder")
        matched, _ = LorebookMatcher.match_entry(entry, [{"role": "user", "content": "test"}])
        assert not matched

    def test_case_sensitive_keyword(self):
        entry = LoreEntry(key="Cat", case_sensitive=True)
        messages = [{"role": "user", "content": "I have a cat."}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched
        messages = [{"role": "user", "content": "I have a Cat."}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_case_insensitive_keyword_by_default(self):
        entry = LoreEntry(key="Cat")
        messages = [{"role": "user", "content": "I have a CAT."}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_use_regex_keyword(self):
        entry = LoreEntry(key=r"切尔诺伯格\d+", use_regex=True)
        messages = [{"role": "user", "content": "切尔诺伯格113号避难点"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched
        messages = [{"role": "user", "content": "切尔诺伯格区已撤离"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_regex_timeout_degrades_to_no_match(self):
        # ReDoS 攻击模式 (a+)+ 是嵌套量词，必须在源头被拒绝并按字面关键词
        # 降级匹配，绝不能进入正则引擎（匹配期间持有 GIL，中断不可靠）
        entry = LoreEntry(key=r"(a+)+$", use_regex=True)
        bomb = "a" * 40_000 + "!"
        messages = [{"role": "user", "content": bomb}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_regex_nested_quantifier_falls_back_to_literal_keyword(self):
        # 字面文本恰好包含该模式时，降级匹配仍能命中
        entry = LoreEntry(key=r"^(a+)+$", use_regex=True)
        messages = [{"role": "user", "content": "文本包含 ^(a+)+$ 字样"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_plain_regex_still_matches_normally(self):
        entry = LoreEntry(key=r"切尔诺伯格\d+", use_regex=True)
        messages = [{"role": "user", "content": "切尔诺伯格113号避难点"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_selective_and_all_requires_both_keys(self):
        entry = LoreEntry(
            key="龙门", second_key="乌萨斯, 近卫局",
            selective=True, selective_logic="and_all",
        )
        messages = [{"role": "user", "content": "龙门近卫局"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched  # 乌萨斯缺失
        messages = [{"role": "user", "content": "龙门近卫局与乌萨斯"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_selective_and_any_requires_one_secondary(self):
        entry = LoreEntry(
            key="龙门", second_key="乌萨斯, 近卫局",
            selective=True, selective_logic="and_any",
        )
        messages = [{"role": "user", "content": "龙门近卫局"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched  # 命中近卫局即可
        messages = [{"role": "user", "content": "龙门"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_selective_not_any_excludes_on_secondary_hit(self):
        entry = LoreEntry(
            key="龙门", second_key="乌萨斯",
            selective=True, selective_logic="not_any",
        )
        messages = [{"role": "user", "content": "龙门近卫局"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched
        messages = [{"role": "user", "content": "龙门与乌萨斯"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_priority_eviction_keeps_high_priority_when_budget_tight(self):
        mgr = LorebookManager("test")
        mgr.add_entry(key="low", content="低优先" * 100, comment="low", priority=0)
        mgr.add_entry(key="high", content="高优先" * 100, comment="high", priority=100)
        book = mgr.global_lorebook
        book.entries[0].case_sensitive = True
        book.entries[1].case_sensitive = True
        messages = [{"role": "user", "content": "low high"}]

        # 每个条目约 150 token；预算 200 只够一个，低 priority 条目应先被淘汰
        result = mgr.assemble_lorebook_prompt(messages, max_tokens=200)
        assert "高优先" in result
        assert "低优先" not in result


class TestLorebookManager:
    def test_add_and_match(self):
        mgr = LorebookManager("测试角色")
        mgr.add_entry(key="猫咪", content="她很喜欢猫", comment="猫爱好")
        messages = [{"role": "user", "content": "你见过猫咪吗"}]
        result = mgr.assemble_lorebook_prompt(messages)
        assert "猫爱好" in result
        assert "她很喜欢猫" in result

    def test_always_active_entry(self):
        mgr = LorebookManager("测试角色")
        mgr.add_entry(key="", content="基本设定", always_active=True, insert_order=0)
        messages = [{"role": "user", "content": "你好"}]
        result = mgr.assemble_lorebook_prompt(messages)
        assert "基本设定" in result

    def test_token_budget(self):
        mgr = LorebookManager("test")
        for i in range(10):
            mgr.add_entry(key=f"k{i}", content=f"v{i}")
        messages = [{"role": "user", "content": "k0 k1 k2"}]
        result_full = mgr.assemble_lorebook_prompt(messages, max_tokens=100)
        assert "v0" in result_full and "v1" in result_full
        result_limited = mgr.assemble_lorebook_prompt(messages, max_tokens=1)
        assert len(result_limited) < len(result_full)

    def test_export_import(self, tmp_path):
        mgr = LorebookManager("test")
        mgr.add_entry(key="cat", content="likes cats")
        path = tmp_path / "test_lorebook.json"
        mgr.export_json(path)
        mgr2 = LorebookManager("new")
        mgr2.import_json(path)
        assert len(mgr2.global_lorebook.entries) == 1  # the single imported entry

    def test_chat_lorebook_isolation(self):
        mgr = LorebookManager("test")
        mgr.add_entry(key="global", content="global content", always_active=True)
        mgr.add_entry(key="chat", content="chat content", chat_id="chat_001")
        messages = [{"role": "user", "content": "chat keyword"}]
        result_global = mgr.assemble_lorebook_prompt(messages)
        assert "global content" in result_global
        assert "chat content" not in result_global
        result_chat = mgr.assemble_lorebook_prompt(messages, chat_id="chat_001")
        assert "chat content" in result_chat
