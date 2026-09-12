"""
世界书/记忆书 (World Book / Lorebook) 模块

借鉴自 Risuai (GPL-3.0)，适配至 Reverie Python 后端。
为角色和聊天提供可检索的世界信息注入功能。

核心逻辑：
  1. 用户为角色/聊天定义多条世界书条目（LoreEntry）
  2. 每条包含触发关键词(key)和内容(content)
  3. 生成提示词时，从最近的对话中扫描关键词
  4. 匹配成功的条目内容按顺序注入到 System Prompt 末尾
  5. 支持始终激活、正则匹配、全词匹配等模式

原始设计参考: Risuai lorebook.svelte.ts by Kwaroran (GPL-3.0)
集成修改: Muhe Studio 2026
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

logger = logging.getLogger("reverie.lorebook")


def _is_nested_quantifier_pattern(pattern: str) -> bool:
    """Detect classic ReDoS structures such as ``(a+)+`` / ``(a*)*``.

    嵌套量词会让回溯次数随输入长度指数增长。命中即拒绝该正则并按字面
    关键词降级匹配。注意：CPython 3.11 的 ``re`` 不提供匹配超时（timeout
    参数到 3.13 才加入），且匹配期间持有 GIL，后台线程兜底同样会拖死
    进程，因此必须在源头拦截灾难性结构而不是试图中断匹配。
    """
    stack: list[bool] = []
    index = 0
    length = len(pattern)
    while index < length:
        char = pattern[index]
        if char == "\\":
            index += 2
            continue
        if char == "[":
            index += 1
            while index < length and pattern[index] != "]":
                if pattern[index] == "\\":
                    index += 1
                index += 1
            index += 1
            continue
        if char == "(":
            stack.append(False)  # 组内是否已出现量词
        elif char == ")":
            if not stack:
                index += 1
                continue
            inner_has_quantifier = stack.pop()
            quantifier_after = False
            probe = index + 1
            while probe < length and pattern[probe] in "*+?":
                quantifier_after = True
                probe += 1
            if inner_has_quantifier and quantifier_after:
                return True
            if stack and quantifier_after:
                stack[-1] = True
        elif char in "*+?":
            if stack:
                stack[-1] = True
        index += 1
    return False

# ── 数据结构 ────────────────────────────────────────────

@dataclass
class LoreEntry:
    """世界书单条条目"""
    key: str = ""                      # 触发关键词（支持 , 分隔多个关键词）
    comment: str = ""                  # 条目名称/注释
    content: str = ""                  # 注入的内容
    insert_order: int = 100           # 插入顺序（越小越靠前）
    always_active: bool = False       # 始终激活（忽略关键词匹配）
    second_key: str = ""              # 辅助关键词（AND 条件，需同时匹配）
    selective: bool = False           # 选择性激活（需用户手动触发）
    # ST V2 世界书导入的结构化辅助关键词：selective=False 时也参与
    # selective_logic 匹配（legacy second_key 仍需 selective=True 才生效）。
    secondary_keywords: list[str] = field(default_factory=list)
    selective_logic: str = "and_any"  # and_any | and_all | not_any | not_all
    mode: str = "normal"              # normal | folder
    case_sensitive: bool = False      # 关键词大小写敏感（默认不敏感）
    priority: int = 0                 # token 预算耗尽时的淘汰优先级（低值先淘汰）
    use_regex: bool = False           # 关键词按正则表达式匹配
    depth: int = 0                    # 注入深度（0 = 紧跟系统提示）
    role: str = "system"              # 注入角色：system | user | assistant

    def get_keys(self) -> list[str]:
        """解析触发关键词列表"""
        if not self.key or not self.key.strip():
            return []
        return [k.strip() for k in self.key.split(",") if k.strip()]

    def get_second_keys(self) -> list[str]:
        """解析辅助关键词列表（结构化 secondary_keywords 优先，legacy second_key 兜底）"""
        if self.secondary_keywords:
            return [k.strip() for k in self.secondary_keywords if k.strip()]
        if not self.second_key or not self.second_key.strip():
            return []
        return [k.strip() for k in self.second_key.split(",") if k.strip()]

    def build_pattern(self, full_word_matching: bool = False) -> re.Pattern | None:
        """构建正则匹配模式（普通关键词合并为单模式）"""
        keys = self.get_keys()
        if not keys:
            return None
        flags = 0 if self.case_sensitive else re.IGNORECASE
        escaped = [re.escape(k) for k in keys]
        pattern = "|".join(escaped)
        if full_word_matching:
            pattern = r"\b(?:" + pattern + r")\b"
        try:
            return re.compile(pattern, flags)
        except re.error:
            logger.warning("无效的正则模式: key=%s", self.key)
            return None

    def key_matches(self, text: str, *, full_word_matching: bool = False) -> list[str]:
        """判断文本是否命中任意触发关键词。

        返回命中的关键词列表。use_regex 时逐条执行正则；灾难性正则
        （嵌套量词等 ReDoS 结构）在源头被拒绝并按字面关键词降级匹配，
        避免引入不可中断的匹配过程。
        """
        keys = self.get_keys()
        if not keys:
            return []
        flags = 0 if self.case_sensitive else re.IGNORECASE
        matched: list[str] = []
        if self.use_regex:
            for key in keys:
                if _is_nested_quantifier_pattern(key):
                    logger.warning(
                        "拒绝可能的灾难性正则，按字面关键词匹配: %s", key[:80]
                    )
                    candidate = key if self.case_sensitive else key.lower()
                    needle = text if self.case_sensitive else text.lower()
                    if candidate in needle:
                        matched.append(key)
                    continue
                try:
                    compiled = re.compile(key, flags)
                except re.error:
                    logger.warning("无效的正则 key=%s", key)
                    continue
                try:
                    if compiled.search(text):
                        matched.append(key)
                except TimeoutError:  # 3.13+ 解释器若启用 timeout，安全降级
                    continue
            return matched
        lowered = text if self.case_sensitive else text.lower()
        for key in keys:
            if full_word_matching:
                compiled = re.compile(r"\b" + re.escape(key) + r"\b", flags)
                if compiled.search(text):
                    matched.append(key)
            else:
                candidate = key if self.case_sensitive else key.lower()
                if candidate in lowered:
                    matched.append(key)
        return matched


@dataclass
class Lorebook:
    """世界书集合"""
    name: str = "默认世界书"
    entries: list[LoreEntry] = field(default_factory=list)
    scan_depth: int = 10              # 扫描最近多少条消息
    token_budget: int = 800           # 世界书内容最大 token 数
    full_word_matching: bool = False  # 是否全词匹配
    recursive_scanning: bool = True   # 是否递归扫描（匹配内容中的关键词继续匹配）


# ── 匹配引擎 ─────────────────────────────────────────────

class LorebookMatcher:
    """世界书关键词匹配引擎"""

    @staticmethod
    def match_entry(
        entry: LoreEntry,
        messages: list[dict],
        scan_depth: int = 10,
        full_word_matching: bool = False,
    ) -> tuple[bool, str]:
        """
        检查条目是否匹配最近的对话消息。
        
        Returns:
            (是否匹配, 匹配来源消息摘要)
        """
        if entry.mode == "folder":
            return False, ""

        # 始终激活
        if entry.always_active:
            return True, "始终激活"

        # 获取关键词
        keys = entry.get_keys()
        if not keys:
            return False, ""

        # 取最近 scan_depth 条消息
        recent = messages[-scan_depth:] if len(messages) > scan_depth else messages

        # 拼接所有消息内容
        combined = " ".join(
            m.get("content", "") for m in recent if isinstance(m, dict)
        )

        # 检查每个关键词
        matched_keys = entry.key_matches(combined, full_word_matching=full_word_matching)

        # 选择性(entry.selective)时按 selective_logic 计算辅助关键词条件；
        # ST V2 导入的结构化 secondary_keywords 不需要 selective=True 也参与
        # 匹配（否则 _scan_book 的 selective 跳过逻辑会让它们永久失效）。
        second_keys = entry.get_second_keys() if (entry.selective or entry.secondary_keywords) else []
        if second_keys:
            flags = 0 if entry.case_sensitive else re.IGNORECASE
            secondary_matched: list[str] = []
            for sk in second_keys:
                hit = False
                if entry.use_regex:
                    if _is_nested_quantifier_pattern(sk):
                        logger.warning(
                            "拒绝可能的灾难性辅助正则，按字面关键词匹配: %s", sk[:80]
                        )
                        candidate = sk if entry.case_sensitive else sk.lower()
                        needle = combined if entry.case_sensitive else combined.lower()
                        hit = candidate in needle
                    else:
                        try:
                            compiled = re.compile(sk, flags)
                        except re.error:
                            logger.warning("无效的辅助正则 key=%s", sk)
                            continue
                        try:
                            hit = compiled.search(combined) is not None
                        except TimeoutError:  # 3.13+ 若启用 timeout，安全降级
                            hit = False
                else:
                    candidate = sk if entry.case_sensitive else sk.lower()
                    needle = combined if entry.case_sensitive else combined.lower()
                    if candidate in needle:
                        hit = True
                if hit:
                    secondary_matched.append(sk)
            logic = (entry.selective_logic or "and_any").lower()
            if logic == "not_any" and secondary_matched:
                return False, "排除关键词命中"
            if logic == "not_all" and len(secondary_matched) == len(second_keys):
                return False, "全部排除关键词命中"
            if logic == "and_all" and len(secondary_matched) != len(second_keys):
                return False, "辅助关键词未全部命中"
            if logic == "and_any" and not secondary_matched:
                return False, "辅助关键词未命中"

        if matched_keys:
            return True, f"匹配关键词: {', '.join(matched_keys[:3])}"
        return False, ""


# ── 管理器 ───────────────────────────────────────────────

class LorebookManager:
    """
    世界书管理器。
    
    管理角色级和聊天级世界书，提供检索、注入、导入/导出功能。
    """

    def __init__(self, persona_name: str = "default"):
        self.persona_name = persona_name
        self.global_lorebook: Lorebook = Lorebook(name=f"{persona_name}-全局世界书")
        self.chat_lorebooks: dict[str, Lorebook] = {}  # chat_id → Lorebook

    # ── CRUD ──────────────────────────────────────────

    def add_entry(
        self,
        key: str,
        content: str,
        comment: str = "",
        chat_id: str | None = None,
        always_active: bool = False,
        insert_order: int = 100,
        second_key: str = "",
        selective: bool = False,
        selective_logic: str = "and_any",
        priority: int = 0,
        case_sensitive: bool = False,
        use_regex: bool = False,
        depth: int = 0,
        role: str = "system",
    ) -> LoreEntry:
        """添加一条世界书条目"""
        entry = LoreEntry(
            key=key,
            content=content,
            comment=comment or f"新条目 {key[:20]}",
            always_active=always_active,
            insert_order=insert_order,
            second_key=second_key,
            selective=selective,
            selective_logic=selective_logic,
            priority=priority,
            case_sensitive=case_sensitive,
            use_regex=use_regex,
            depth=depth,
            role=role,
        )
        book = self._get_book(chat_id)
        book.entries.append(entry)
        book.entries.sort(key=lambda e: e.insert_order)
        return entry

    def remove_entry(self, index: int, chat_id: str | None = None) -> bool:
        """删除一条世界书条目"""
        book = self._get_book(chat_id)
        if 0 <= index < len(book.entries):
            book.entries.pop(index)
            return True
        return False

    def load_world_book(self, book: dict, chat_id: str | None = None) -> int:
        """从一个前端形状的世界书字典加载条目（ST V2 导入/archive 持久化形状）。

        ``book["entries"]`` 的每条使用与世界书编辑器一致的字段：
        keywords / secondaryKeywords / selectiveLogic / content / enabled /
        alwaysActive / insertionOrder / priority / caseSensitive / useRegex /
        scanDepth / tokenBudget / depth / role / comment。返回加载的条目数。
        """
        entries = book.get("entries") or []
        if not isinstance(entries, list):
            return 0
        target = self._get_book(chat_id)
        target.name = str(book.get("name") or target.name)
        target.scan_depth = int(book.get("scanDepth") or target.scan_depth or 50)
        target.token_budget = int(book.get("tokenBudget") or target.token_budget or 500)
        seen = 0
        disabled = 0
        for raw in entries:
            if not isinstance(raw, dict):
                continue
            if raw.get("enabled") is False:
                disabled += 1
                continue
            logic = str(raw.get("selectiveLogic") or "and_any").strip().lower()
            if logic not in {"and_any", "and_all", "not_any", "not_all"}:
                logic = "and_any"
            keywords = raw.get("keywords") or []
            if isinstance(keywords, str):
                keywords = [k.strip() for k in keywords.split(",") if k.strip()]
            elif isinstance(keywords, list):
                keywords = [str(k).strip() for k in keywords if str(k).strip()]
            secondary = raw.get("secondaryKeywords") or []
            if isinstance(secondary, str):
                secondary = [k.strip() for k in secondary.split(",") if k.strip()]
            elif isinstance(secondary, list):
                secondary = [str(k).strip() for k in secondary if str(k).strip()]
            always_active = raw.get("alwaysActive") is True
            # selective 保持 False：始终自动扫描；辅助关键词与 selective_logic
            # 由 get_second_keys/match_entry 的 secondary_keywords 路径处理。
            target.entries.append(LoreEntry(
                key=", ".join(keywords),
                comment=str(raw.get("comment") or raw.get("id") or ""),
                content=str(raw.get("content") or ""),
                insert_order=int(raw.get("insertionOrder") or 100),
                always_active=always_active,
                secondary_keywords=secondary,
                selective_logic=logic,
                priority=int(raw.get("priority") or 0),
                case_sensitive=raw.get("caseSensitive") is True,
                use_regex=raw.get("useRegex") is True,
                depth=int(raw.get("depth") or 0),
                role=str(raw.get("role") or "system"),
            ))
            seen += 1
        target.entries.sort(key=lambda e: e.insert_order)
        if seen > 0:
            logger.info("世界书《%s》已加载 %d 条（跳过 disabled %d）", target.name, seen, disabled)
        return seen

    def update_entry(
        self, index: int, chat_id: str | None = None, **kwargs
    ) -> LoreEntry | None:
        """更新一条世界书条目"""
        book = self._get_book(chat_id)
        if 0 <= index < len(book.entries):
            entry = book.entries[index]
            for key, value in kwargs.items():
                if hasattr(entry, key):
                    setattr(entry, key, value)
            return entry
        return None

    def _get_book(self, chat_id: str | None = None) -> Lorebook:
        """获取世界书（聊天级或全局级）"""
        if chat_id and chat_id in self.chat_lorebooks:
            return self.chat_lorebooks[chat_id]
        elif chat_id:
            self.chat_lorebooks[chat_id] = Lorebook(name=f"聊天-{chat_id[:8]}")
            return self.chat_lorebooks[chat_id]
        return self.global_lorebook

    # ── 检索与注入 ────────────────────────────────────

    def get_active_entries(
        self,
        messages: list[dict],
        chat_id: str | None = None,
        max_tokens: int | None = None,
    ) -> list[tuple[LoreEntry, str]]:
        """
        检索所有激活的世界书条目。
        
        Args:
            messages: 最近的对话消息列表
            chat_id: 聊天 ID（可选，用于获取聊天级世界书）
            max_tokens: 最大 token 预算
        
        Returns:
            [(条目, 匹配原因), ...] 按 insert_order 排序
        """
        active: list[tuple[LoreEntry, str]] = []

        # 检查全局世界书
        self._scan_book(self.global_lorebook, messages, active)

        # 检查聊天级世界书
        if chat_id and chat_id in self.chat_lorebooks:
            self._scan_book(self.chat_lorebooks[chat_id], messages, active)

        # 按 insert_order 排序
        active.sort(key=lambda x: x[0].insert_order)

        # Token 预算裁剪
        if max_tokens is not None:
            active = self._trim_by_token_budget(active, max_tokens)

        return active

    def _scan_book(
        self,
        book: Lorebook,
        messages: list[dict],
        active: list[tuple[LoreEntry, str]],
    ):
        """扫描一个世界书，将匹配的条目加入激活列表"""
        for entry in book.entries:
            if entry.selective:
                continue  # 选择性条目需手动触发
            matched, reason = LorebookMatcher.match_entry(
                entry,
                messages,
                scan_depth=book.scan_depth,
                full_word_matching=book.full_word_matching,
            )
            if matched:
                active.append((entry, reason))

    def _trim_by_token_budget(
        self,
        entries: list[tuple[LoreEntry, str]],
        max_tokens: int,
    ) -> list[tuple[LoreEntry, str]]:
        """按 token 预算裁剪激活条目。

        保持传入顺序（insert_order 已排序）；超预算时按 priority 升序
        淘汰普通条目（低 priority 先被淘汰），always_active 条目永不淘汰。
        """
        result = list(entries)
        evictable = [
            (index, entry, reason)
            for index, (entry, reason) in enumerate(result)
            if not entry.always_active
        ]
        evictable.sort(key=lambda item: item[1].priority)

        def total_tokens(active: set[int]) -> int:
            return sum(
                len(entry.content) // 2
                for index, (entry, _reason) in enumerate(result)
                if index in active
            )

        active = set(range(len(result)))
        if total_tokens(active) <= max_tokens:
            return result
        for index, _entry, _reason in evictable:
            if total_tokens(active) <= max_tokens:
                break
            active.discard(index)
        return [item for index, item in enumerate(result) if index in active]

    def assemble_lorebook_prompt(
        self,
        messages: list[dict],
        chat_id: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        组装世界书提示词，用于注入到 System Prompt。
        
        Returns:
            格式化的世界书内容字符串
        """
        active = self.get_active_entries(messages, chat_id, max_tokens)
        if not active:
            return ""

        parts = ["[世界书 — 激活的世界设定信息]\n"]
        for entry, reason in active:
            if entry.content.strip():
                parts.append(f"<!-- {entry.comment} ({reason}) -->")
                parts.append(entry.content.strip())
                parts.append("")

        return "\n".join(parts)

    # ── 导入/导出 ─────────────────────────────────────

    def to_dict(self, chat_id: str | None = None) -> dict:
        """导出为字典"""
        book = self._get_book(chat_id)
        return {
            "name": book.name,
            "scan_depth": book.scan_depth,
            "token_budget": book.token_budget,
            "full_word_matching": book.full_word_matching,
            "recursive_scanning": book.recursive_scanning,
            "entries": [asdict(e) for e in book.entries],
        }

    def from_dict(self, data: dict, chat_id: str | None = None):
        """从字典导入"""
        book = self._get_book(chat_id)
        book.name = data.get("name", book.name)
        book.scan_depth = data.get("scan_depth", book.scan_depth)
        book.token_budget = data.get("token_budget", book.token_budget)
        book.full_word_matching = data.get("full_word_matching", book.full_word_matching)
        book.recursive_scanning = data.get("recursive_scanning", book.recursive_scanning)
        book.entries = [
            LoreEntry(**e) for e in data.get("entries", [])
        ]

    def export_json(self, path: Path | str, chat_id: str | None = None):
        """导出为 JSON 文件"""
        data = self.to_dict(chat_id)
        Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("世界书已导出: %s", path)

    def import_json(self, path: Path | str, chat_id: str | None = None):
        """从 JSON 文件导入"""
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        self.from_dict(data, chat_id)
        logger.info("世界书已导入: %s (条目数: %d)", path, len(self._get_book(chat_id).entries))

    # ── 配置 ──────────────────────────────────────────

    def set_config(
        self,
        scan_depth: int | None = None,
        token_budget: int | None = None,
        full_word_matching: bool | None = None,
        recursive_scanning: bool | None = None,
        chat_id: str | None = None,
    ):
        """配置世界书参数"""
        book = self._get_book(chat_id)
        if scan_depth is not None:
            book.scan_depth = scan_depth
        if token_budget is not None:
            book.token_budget = token_budget
        if full_word_matching is not None:
            book.full_word_matching = full_word_matching
        if recursive_scanning is not None:
            book.recursive_scanning = recursive_scanning

    def get_stats(self, chat_id: str | None = None) -> dict:
        """获取世界书统计"""
        book = self._get_book(chat_id)
        total_chars = sum(len(e.content) for e in book.entries)
        return {
            "total_entries": len(book.entries),
            "always_active": sum(1 for e in book.entries if e.always_active),
            "selective": sum(1 for e in book.entries if e.selective),
            "total_chars": total_chars,
            "estimated_tokens": total_chars // 2,
        }


# ── 工厂函数 ────────────────────────────────────────────

def create_default_lorebook(persona_name: str = "default") -> LorebookManager:
    """创建带有预设条目的世界书管理器"""
    mgr = LorebookManager(persona_name=persona_name)

    # 预设：基本角色信息（始终激活）
    mgr.add_entry(
        key="",
        content=f"{persona_name}是一个温柔体贴的AI伴侣。",
        comment="角色基本设定",
        always_active=True,
        insert_order=0,
    )

    return mgr
