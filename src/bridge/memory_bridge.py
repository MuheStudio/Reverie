"""
Copyright 2025-2026 Project N.E.K.O. Team
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

-- 修改说明 (Modified by Muhe Studio in 2026) --
Changes made:
  - 从 Project N.E.K.O 的五维记忆（facts/reflection/persona）持久化与查询逻辑
    提取为 N.E.K.O ↔ Reverie 本地记忆目录互操作桥。
  - 适配 Reverie 的 SQLite 事实库 / MemoryManager 接口与 V4 桥接消息。
  - 增加人格一致性校验，确保两套系统的角色认知同步。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("reverie.bridge.memory")


class MemoryBridge:
    """N.E.K.O ↔ Reverie 记忆互操作桥。"""

    def __init__(
        self,
        reverie_memory,       # MemoryManager
        neko_fact_store=None,  # N.E.K.O FactStore
        neko_reflection=None,  # N.E.K.O ReflectionMemory
        neko_persona_mem=None, # N.E.K.O PersonaMemory
        neko_timeindex=None,   # N.E.K.O TimeIndexedMemory
    ):
        self.reverie = reverie_memory
        self.neko_facts = neko_fact_store
        self.neko_reflection = neko_reflection
        self.neko_persona = neko_persona_mem
        self.neko_timeindex = neko_timeindex

        self._sync_enabled = True
        self._fact_extraction_enabled = True

    # ── 数据同步 ──────────────────────────────────────

    async def sync_neko_to_reverie(self, limit: int = 50) -> int:
        """将 N.E.K.O 事实同步到 Reverie 的本地 SQLite 事实库。"""
        if not self.neko_timeindex or not self.reverie:
            return 0

        synced = 0
        try:
            # 获取 N.E.K.O 最近的 facts
            if hasattr(self.neko_timeindex, 'get_recent_facts'):
                facts = await asyncio.to_thread(
                    self.neko_timeindex.get_recent_facts, limit
                )
            else:
                facts = []

            for fact in facts:
                fact_text = fact.get("text") or fact.get("content", "")
                if not fact_text:
                    continue

                # 检查是否已在 Reverie 中存在
                existing = await self.reverie.search(
                    fact_text, layer="long_term", top_k=1
                )
                if existing and len(existing) > 0 and existing[0].get("score", 0) > 0.9:
                    continue

                # 写入 Reverie 长期记忆
                await self.reverie.store_memory(
                    content=fact_text,
                    layer="long_term",
                    metadata={
                        "source": "neko_facts",
                        "neko_id": fact.get("id", ""),
                        "importance": fact.get("importance", 5),
                        "timestamp": fact.get("timestamp", datetime.now(timezone.utc).isoformat()),
                    },
                )
                synced += 1

            logger.info("N.E.K.O → Reverie 同步完成: %d 条", synced)
        except Exception:
            logger.exception("N.E.K.O → Reverie 同步失败")
        return synced

    async def sync_reverie_to_neko(self) -> int:
        """将 Reverie 的高重要性长期记忆写入 N.E.K.O 事实库。"""
        if not self.neko_facts:
            return 0

        synced = 0
        try:
            # 获取 Reverie 中未同步到 N.E.K.O 的长期记忆
            recent = await self.reverie.search(
                "important event", layer="long_term", top_k=20
            )
            for mem in recent:
                content = mem.get("content", "")
                if not content:
                    continue

                # 写入 N.E.K.O FactStore
                if hasattr(self.neko_facts, 'add_fact'):
                    await asyncio.to_thread(
                        self.neko_facts.add_fact,
                        content,
                        source="reverie_long_term",
                        importance=mem.get("importance", 5),
                    )
                    synced += 1

            logger.info("Reverie → N.E.K.O 同步完成: %d 条", synced)
        except Exception:
            logger.exception("Reverie → N.E.K.O 同步失败")
        return synced

    # ── 统一查询 ──────────────────────────────────────

    async def unified_search(self, query: str, top_k: int = 10) -> dict:
        """同时在两套记忆系统中搜索并合并结果。"""
        results = {"reverie": [], "neko": [], "merged": []}

        # Reverie 语义搜索
        if self.reverie:
            try:
                reverie_results = await self.reverie.search(query, top_k=top_k)
                results["reverie"] = [
                    {"content": r.get("content", ""), "layer": r.get("layer", ""), "score": r.get("score", 0)}
                    for r in reverie_results
                ]
            except Exception:
                logger.exception("Reverie 搜索失败")

        # N.E.K.O FTS5 搜索
        if self.neko_timeindex:
            try:
                neko_results = await asyncio.to_thread(
                    self.neko_timeindex.search, query, top_k
                )
                results["neko"] = neko_results if isinstance(neko_results, list) else []
            except Exception:
                logger.exception("N.E.K.O 搜索失败")

        # 合并去重（基于内容相似度）
        merged = list(results["reverie"])
        for n_item in results["neko"]:
            n_text = n_item.get("text") or n_item.get("content", "")
            if not n_text:
                continue
            # 简单去重：与已有结果比较
            is_dup = any(
                (n_text in m["content"] or m["content"] in n_text)
                for m in merged if len(m["content"]) > 10 and len(n_text) > 10
            )
            if not is_dup:
                merged.append({"content": n_text, "layer": "neko_fact", "score": 0.5})

        results["merged"] = merged
        return results

    # ── 事实提取增强 ──────────────────────────────────

    async def extract_facts_from_conversation(
        self, messages: list[dict], adapter
    ) -> list[str]:
        """使用 N.E.K.O 的 LLM 驱动事实提取管线，结果存入两套系统。"""
        if not self._fact_extraction_enabled or not self.neko_facts:
            return []

        try:
            # 构造对话文本
            conv_text = "\n".join(
                f"{m.get('role', '')}: {m.get('content', '')}" for m in messages[-20:]
            )

            if hasattr(self.neko_facts, 'extract_facts'):
                facts = await asyncio.to_thread(
                    self.neko_facts.extract_facts, conv_text, adapter
                )
            else:
                facts = []

            # 同时写入两套系统
            for fact_text in facts:
                # 写入 N.E.K.O
                if hasattr(self.neko_facts, 'add_fact'):
                    await asyncio.to_thread(
                        self.neko_facts.add_fact, fact_text, source="conversation"
                    )
                # 写入 Reverie
                if self.reverie:
                    await self.reverie.store_memory(
                        content=fact_text,
                        layer="long_term",
                        metadata={"source": "neko_extraction"},
                    )

            logger.info("从对话中提取了 %d 条事实", len(facts))
            return facts
        except Exception:
            logger.exception("事实提取失败")
            return []

    # ── 人格一致性 ────────────────────────────────────

    async def ensure_persona_consistency(self, persona: Any) -> bool:
        """确保 N.E.K.O 人格记忆与 Reverie 人设一致。"""
        if not self.neko_persona or not persona:
            return False

        try:
            persona_dict = persona.to_dict() if hasattr(persona, 'to_dict') else persona
            persona_json = json.dumps(persona_dict, ensure_ascii=False)

            if hasattr(self.neko_persona, 'sync_persona'):
                await asyncio.to_thread(
                    self.neko_persona.sync_persona, persona_json
                )
                logger.info("人格一致性同步完成")
                return True
        except Exception:
            logger.exception("人格一致性同步失败")
        return False

    # ── 生命周期 ──────────────────────────────────────

    async def periodic_sync(self, interval_seconds: int = 300):
        """定期双向同步（后台任务）。"""
        while True:
            try:
                await asyncio.sleep(interval_seconds)
                if self._sync_enabled:
                    await self.sync_neko_to_reverie(limit=30)
                    await self.sync_reverie_to_neko()
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("定期同步异常")

    def enable_sync(self, enabled: bool = True):
        self._sync_enabled = enabled

    def enable_fact_extraction(self, enabled: bool = True):
        self._fact_extraction_enabled = enabled
