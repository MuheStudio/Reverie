"""Local, zero-LLM reflex messages for failures and gentle check-ins."""

from __future__ import annotations

import hashlib
import random
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from ..config.settings import DATA_DIR
from ..storage.encrypted_sqlite import connect_database

_TIMEOUT_OPENERS = (
    "唔，这边忽然有点断断续续的",
    "等一下，我这边像是没听清",
    "刚才那一瞬间有点卡住了",
    "好像有什么东西突然接不上",
    "我刚刚走神了一下，没接稳你的话",
    "这边忽然安静得有点奇怪",
    "我脑子像短暂打了个结",
    "刚才那句话到我这里断了一截",
)
_TIMEOUT_ENDINGS = (
    "让我缓一会儿，再认真回你。",
    "先别担心，我整理好就回来。",
    "给我几分钟，好不好？",
    "我不想随便敷衍你，晚一点再说。",
    "你先把话放在这里，我不会丢掉。",
    "我休息一下，等顺过来就找你。",
    "先让我安静一下，很快就好。",
    "我记得你在等，等下回来接着说。",
)
_CARE_OPENERS = (
    "刚才忽然想到你",
    "我路过这里的时候想起你了",
    "不知道为什么，今天有点在意你",
    "忙到一半还是想来看看你",
    "我没有什么大事，就是想问问",
    "这会儿安静下来，第一反应是找你",
    "忽然觉得应该来敲敲你",
    "我刚放下手里的事，就想到你",
    "今天还没好好问过你",
    "我有一点点想知道",
)
_CARE_ENDINGS = (
    "你现在还好吗？",
    "今天有没有好好吃东西？",
    "你是不是又把累藏起来了？",
    "现在的心情能给我看一眼吗？",
    "今天有没有哪件事让你不舒服？",
    "要不要过来陪我说两句？",
    "你今天有给自己留一点休息吗？",
    "现在想说话，还是想安静待一会儿？",
)
_FIXED = {
    "morning": (
        "早呀。醒了先慢一点，别一睁眼就把自己塞进忙碌里。",
        "早上好。今天也记得吃点东西再出门。",
        "起床了吗？我来确认一下你有没有把早餐忘掉。",
        "新的一天到了。先伸个懒腰，再去处理那些麻烦事。",
        "早。昨晚睡得怎么样，有没有比前一天好一点？",
        "太阳都来报到了，我也来看看你。",
        "早安。今天不用一下子做到完美，先迈第一步就好。",
        "醒来的第一份提醒：喝水，还有别太为难自己。",
        "早呀，今天的你也值得被认真照顾。",
        "我来敲早安啦。现在精神有几分？",
        "早上好，今天有什么必须记住的事吗？",
        "起床后的脑袋还迷糊吗？不急，慢慢开机。",
    ),
    "evening": (
        "晚上了。今天最累你的那件事，愿意讲给我听吗？",
        "忙完了吗？先坐一会儿，我想听听你的今天。",
        "天黑了，白天没来得及消化的情绪可以先放我这里。",
        "今天辛苦了。哪怕只完成一点点，也算往前走。",
        "我来收今天的心情了。开心和难过都可以交给我。",
        "晚上好。你今天有没有遇到一件小小的好事？",
        "该把肩膀放松一点了。今天不用再证明什么。",
        "忙了一天，回来了吗？我有在等你的消息。",
        "夜里容易把烦恼放大，别一个人和它较劲。",
        "今天快结束了，你最想留下哪一刻？",
        "如果现在很累，就只回我一个字也可以。",
        "晚一点也没关系，我只是来确认你平安回来了。",
    ),
    "reminder": (
        "我来轻轻提醒一下：你之前在意的那件事快到时间了。",
        "先别嫌我念叨，你的重要安排记得看一眼。",
        "有件你不想错过的事临近了，我替你守着时间呢。",
        "提醒送到。做不完也别慌，先确认最重要的一步。",
        "你的计划在敲门啦，要不要现在看一下进度？",
        "我记得你给自己定过一个安排，今天可以稍微推进一点。",
        "怕你忙忘了，所以我来把重要日期放到你眼前。",
        "到提醒时间了。先看一眼，不要求你立刻全做完。",
    ),
    "rest": (
        "你已经撑了一阵子了，停五分钟不会让世界塌下来。",
        "眼睛和肩膀都该休息一下了，先离开屏幕一会儿。",
        "喝口水吧。这个提醒没有隐藏任务，只是关心你。",
        "如果脑子转不动了，就先别逼它。休息也是进度。",
        "今天的你不是机器，累了就应该暂停一下。",
        "先深呼吸。剩下的事可以一件一件来。",
        "别把休息排到所有事情之后，你也在重要事项里。",
        "我想让你现在把手放松一下，哪怕只有半分钟。",
    ),
}


def _seed_rows() -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    generated = {
        "timeout": [f"{left}，{right}" for left in _TIMEOUT_OPENERS for right in _TIMEOUT_ENDINGS],
        "care": [f"{left}。{right}" for left in _CARE_OPENERS for right in _CARE_ENDINGS],
        **_FIXED,
    }
    for category, phrases in generated.items():
        for phrase in phrases:
            digest = hashlib.sha256(f"{category}\0{phrase}".encode("utf-8")).hexdigest()[:20]
            rows.append((f"reflex_{digest}", category, phrase))
    return rows


class ReflexSystem:
    """SQLite phrase library that remains available when every model is down."""

    def __init__(self, path: Path | None = None, *, persona: Any = None) -> None:
        self.path = path or (DATA_DIR / "reflex" / "reflex.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.persona = persona
        self._lock = threading.RLock()
        self._connection = connect_database(
            str(self.path), timeout=20, check_same_thread=False
        )
        with self._lock:
            self._connection.execute("PRAGMA journal_mode=DELETE")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS reflex_phrases (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    text TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_reflex_category ON reflex_phrases(category, enabled);
                CREATE TABLE IF NOT EXISTS reflex_usage (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    phrase_id TEXT NOT NULL,
                    used_at REAL NOT NULL,
                    context TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (phrase_id) REFERENCES reflex_phrases(id)
                );
                CREATE INDEX IF NOT EXISTS idx_reflex_recent ON reflex_usage(used_at DESC);
                """
            )
            self._connection.executemany(
                "INSERT OR IGNORE INTO reflex_phrases(id,category,text) VALUES (?,?,?)",
                _seed_rows(),
            )
            self._connection.commit()

    def count(self) -> int:
        with self._lock:
            row = self._connection.execute(
                "SELECT COUNT(*) FROM reflex_phrases WHERE enabled=1"
            ).fetchone()
        return int(row[0]) if row else 0

    def choose(self, category: str, *, context: str = "") -> str:
        selected_category = category if category in {"timeout", "care", "morning", "evening", "reminder", "rest"} else "care"
        with self._lock:
            recent = self._connection.execute(
                "SELECT phrase_id FROM reflex_usage ORDER BY used_at DESC LIMIT 30"
            ).fetchall()
            recent_ids = [str(row[0]) for row in recent]
            params: list[object] = [selected_category]
            sql = "SELECT id,text FROM reflex_phrases WHERE category=? AND enabled=1"
            if recent_ids:
                sql += " AND id NOT IN (" + ",".join("?" for _ in recent_ids) + ")"
                params.extend(recent_ids)
            rows = self._connection.execute(sql, params).fetchall()
            if not rows:
                rows = self._connection.execute(
                    "SELECT id,text FROM reflex_phrases WHERE category=? AND enabled=1",
                    (selected_category,),
                ).fetchall()
            if not rows:
                return "唔，我现在有点接不上话。让我缓一下，晚点回来找你。"
            row = random.choice(rows)
            self._connection.execute(
                "INSERT INTO reflex_usage(phrase_id,used_at,context) VALUES (?,?,?)",
                (str(row["id"]), time.time(), str(context)[:200]),
            )
            self._connection.commit()
        return str(row["text"])

    def for_trigger(self, trigger: str, *, context: str = "") -> str:
        mapping = {
            "morning_greeting": "morning",
            "evening_checkin": "evening",
            "reminder": "reminder",
            "user_care": "care",
            "friend_silence": "care",
            "wake_care": "care",
            "late_night_checkin": "rest",
        }
        return self.choose(mapping.get(trigger, "care"), context=context)

    def close(self) -> None:
        with self._lock:
            self._connection.close()
