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
        entry = LoreEntry(key="猫咪", second_key="宠物")
        messages = [{"role": "user", "content": "我喜欢猫咪作为宠物"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert matched

    def test_second_key_fail(self):
        entry = LoreEntry(key="猫咪", second_key="大型动物")
        messages = [{"role": "user", "content": "我喜欢猫咪"}]
        matched, _ = LorebookMatcher.match_entry(entry, messages)
        assert not matched

    def test_folder_skip(self):
        entry = LoreEntry(key="test", content="test", mode="folder")
        matched, _ = LorebookMatcher.match_entry(entry, [{"role": "user", "content": "test"}])
        assert not matched


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
