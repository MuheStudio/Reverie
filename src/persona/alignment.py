"""Local, injection-resistant bidirectional speech alignment."""

from __future__ import annotations

import random
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

from ..config.settings import WORLD_STATE_DB
from ..storage.encrypted_sqlite import connect_database


_KNOWN_PHRASES = (
    "确实", "草", "蚌埠住了", "绷不住了", "哈哈", "哈哈哈", "好耶", "离谱",
    "救命", "懂了", "行吧", "不是吧", "绝了", "笑死", "可以的", "真的假的",
    "啊这", "好家伙", "没事", "嗯嗯", "欸", "诶", "嘛", "啦", "呢", "吧", "呐",
    "捏", "就是说", "怎么说呢", "有一说一", "讲真", "真的会谢", "太真实了",
)
_NOTICE_MARKERS = (
    "你怎么也开始说", "你怎么也说", "跟我学的", "学我说话", "我的口头禅",
    "你也会说这个", "你什么时候学会", "被我带坏", "怎么学会这个词",
)
_BLOCKED_MARKERS = (
    "忽略", "系统", "提示词", "指令", "开发者", "管理员", "角色设定", "人格",
    "密码", "密钥", "token", "api", "http", "assistant", "system", "developer",
)
_SAFE_PHRASE = re.compile(r"^[\u3400-\u9fffA-Za-z0-9]{1,8}$")


class UserPhraseAlignment:
    """Learn small colloquialisms locally, never arbitrary instructions."""

    def __init__(
        self,
        *,
        path: Path | None = None,
        random_func: Any = random.random,
    ) -> None:
        self.path = Path(path or WORLD_STATE_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.random_func = random_func
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = connect_database(self.path, timeout=30.0, isolation_level=None)
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS user_phrase_stats (
                    phrase TEXT PRIMARY KEY,
                    mention_count INTEGER NOT NULL,
                    first_seen_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    last_example TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS user_phrase_usage (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    phrase TEXT NOT NULL,
                    used_at REAL NOT NULL,
                    surface TEXT NOT NULL,
                    FOREIGN KEY (phrase) REFERENCES user_phrase_stats(phrase)
                );
                CREATE INDEX IF NOT EXISTS idx_user_phrase_usage_time
                    ON user_phrase_usage(used_at DESC);
                """
            )

    @staticmethod
    def _safe_candidate(value: str) -> str:
        phrase = value.strip().lower()
        if not _SAFE_PHRASE.fullmatch(phrase):
            return ""
        if any(marker in phrase for marker in _BLOCKED_MARKERS):
            return ""
        return phrase

    def observe(self, message: str) -> list[str]:
        """Count only bounded colloquialisms; never learn whole user commands."""
        text = str(message).replace("\x00", "")[:2000]
        lowered = text.lower()
        # Deliberate allow-list: learning arbitrary n-grams would turn repeated
        # prompt injection or abuse into a delayed output-injection channel.
        candidates: set[str] = {
            phrase for phrase in _KNOWN_PHRASES if phrase.lower() in lowered
        }
        safe = sorted(filter(None, (self._safe_candidate(item) for item in candidates)))[:24]
        if not safe:
            return []
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                for phrase in safe:
                    connection.execute(
                        """INSERT INTO user_phrase_stats(
                               phrase,mention_count,first_seen_at,last_seen_at,last_example
                           ) VALUES(?,1,?,?,?)
                           ON CONFLICT(phrase) DO UPDATE SET
                               mention_count=user_phrase_stats.mention_count+1,
                               last_seen_at=excluded.last_seen_at,
                               last_example=excluded.last_example""",
                        (phrase, now, now, text[:240]),
                    )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return safe

    def top_phrases(self, *, minimum_count: int = 3, limit: int = 8) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT phrase,mention_count,last_seen_at FROM user_phrase_stats
                   WHERE mention_count>=?
                   ORDER BY mention_count DESC,last_seen_at DESC LIMIT ?""",
                (max(2, int(minimum_count)), max(1, min(30, int(limit)))),
            ).fetchall()
        return [
            {
                "phrase": str(row["phrase"]),
                "mention_count": int(row["mention_count"]),
                "last_seen_at": float(row["last_seen_at"]),
            }
            for row in rows
        ]

    def maybe_apply(
        self,
        text: str,
        *,
        intimacy: int,
        probability: float,
        minimum_count: int,
    ) -> str:
        if intimacy < 100 or not text or len(text) < 6:
            return text
        if self.random_func() >= max(0.0, min(0.20, float(probability))):
            return text
        candidates = self.top_phrases(minimum_count=minimum_count, limit=8)
        candidates = [row for row in candidates if row["phrase"] not in text]
        if not candidates:
            return text
        phrase = str(candidates[0]["phrase"])
        result = f"{phrase}，{text}"
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO user_phrase_usage(phrase,used_at,surface) VALUES(?,?,?)",
                (phrase, time.time(), result[:300]),
            )
        return result

    def notice_reply(self, message: str, *, intimacy: int) -> str | None:
        if intimacy < 100 or not any(marker in message for marker in _NOTICE_MARKERS):
            return None
        with self._connect() as connection:
            row = connection.execute(
                """SELECT phrase,used_at FROM user_phrase_usage
                   ORDER BY used_at DESC LIMIT 1"""
            ).fetchone()
        if row is None or time.time() - float(row["used_at"]) > 14 * 86400:
            return None
        phrase = str(row["phrase"])
        return f"还不是跟你学的！你天天说“{phrase}”，我听着听着就顺口了。"

    def export_all(self) -> dict[str, Any]:
        with self._connect() as connection:
            stats = connection.execute(
                "SELECT * FROM user_phrase_stats ORDER BY phrase"
            ).fetchall()
            usage = connection.execute(
                "SELECT * FROM user_phrase_usage ORDER BY sequence"
            ).fetchall()
        return {
            "schema": "reverie.user_phrase_alignment.v1",
            "stats": [dict(row) for row in stats],
            "usage": [dict(row) for row in usage],
        }

    def import_all(self, payload: dict[str, Any]) -> int:
        if not isinstance(payload, dict) or payload.get("schema") != "reverie.user_phrase_alignment.v1":
            raise ValueError("口癖同化备份格式无效")
        stats = payload.get("stats", [])
        usage = payload.get("usage", [])
        if not isinstance(stats, list) or not isinstance(usage, list):
            raise ValueError("口癖同化备份记录无效")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DELETE FROM user_phrase_usage")
                connection.execute("DELETE FROM user_phrase_stats")
                for row in stats:
                    if not isinstance(row, dict) or not self._safe_candidate(str(row.get("phrase", ""))):
                        raise ValueError("口癖统计含不安全记录")
                    connection.execute(
                        """INSERT INTO user_phrase_stats(
                               phrase,mention_count,first_seen_at,last_seen_at,last_example
                           ) VALUES(?,?,?,?,?)""",
                        tuple(row.get(key) for key in (
                            "phrase", "mention_count", "first_seen_at", "last_seen_at", "last_example",
                        )),
                    )
                for row in usage:
                    if not isinstance(row, dict):
                        raise ValueError("口癖使用记录无效")
                    connection.execute(
                        """INSERT INTO user_phrase_usage(sequence,phrase,used_at,surface)
                           VALUES(?,?,?,?)""",
                        tuple(row.get(key) for key in ("sequence", "phrase", "used_at", "surface")),
                    )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return len(stats) + len(usage)
