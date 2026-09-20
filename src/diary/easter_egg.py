"""Relationship-gated diary-key easter egg backed by local SQLite."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config.settings import WORLD_STATE_DB
from ..storage.encrypted_sqlite import connect_database

if TYPE_CHECKING:
    from ..ambient import AmbientPresence
    from ..config.settings import FeatureSettings
    from ..relationship.tracker import RelationshipTracker
    from . import DiaryManager


class DiaryKeyManager:
    """Grant narrow read authorization without exposing the diary master key."""

    def __init__(
        self,
        settings: "FeatureSettings",
        *,
        ambient: "AmbientPresence",
        diary: "DiaryManager",
        relationship: "RelationshipTracker",
        path: Path | None = None,
        world_clock=None,
    ) -> None:
        self.settings = settings
        self.world_clock = world_clock
        self.ambient = ambient
        self.diary = diary
        self.relationship = relationship
        self.path = Path(path or WORLD_STATE_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
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
                CREATE TABLE IF NOT EXISTS diary_key_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
                    host_date TEXT NOT NULL,
                    target_date TEXT NOT NULL,
                    eligible_at REAL NOT NULL,
                    unlocked_at REAL
                );
                CREATE TABLE IF NOT EXISTS diary_unlocks (
                    date TEXT PRIMARY KEY,
                    host_date TEXT NOT NULL,
                    unlocked_at REAL NOT NULL,
                    reason TEXT NOT NULL
                );
                """
            )

    def _now_local(self) -> datetime:
        """Naive wall time in the world clock zone, or process-local fallback."""
        if self.world_clock is not None:
            return self.world_clock.now().replace(tzinfo=None)
        return datetime.now()

    def evaluate(self, now: datetime | None = None) -> dict[str, Any] | None:
        now = now or self._now_local()
        if not self.settings.diary_key_easter_egg_enabled:
            return None
        if int(getattr(self.relationship, "intimacy", 0) or 0) < int(
            self.settings.diary_key_intimacy_threshold
        ):
            return None
        if self.ambient.happy_streak(now) < int(self.settings.diary_key_happy_days):
            return None

        with self._connect() as connection:
            current = connection.execute(
                "SELECT * FROM diary_key_state WHERE singleton=1"
            ).fetchone()
            if current is not None and current["unlocked_at"] is None:
                return self._state_dict(current)
            if current is not None and now.timestamp() - float(current["unlocked_at"] or 0) < 30 * 86400:
                return self._state_dict(current)

            unlocked = {
                str(row[0]) for row in connection.execute("SELECT date FROM diary_unlocks").fetchall()
            }
            candidate = self._select_private_candidate(now, unlocked)
            dates = self.diary.list_entries()
            if candidate is None or not dates:
                return None
            host_date = dates[-1]
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """INSERT INTO diary_key_state(
                           singleton,host_date,target_date,eligible_at,unlocked_at
                       ) VALUES(1,?,?,?,NULL)
                       ON CONFLICT(singleton) DO UPDATE SET
                           host_date=excluded.host_date,
                           target_date=excluded.target_date,
                           eligible_at=excluded.eligible_at,
                           unlocked_at=NULL""",
                    (host_date, candidate, now.timestamp()),
                )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
            current = connection.execute(
                "SELECT * FROM diary_key_state WHERE singleton=1"
            ).fetchone()
        return self._state_dict(current) if current is not None else None

    def _select_private_candidate(self, now: datetime, unlocked: set[str]) -> str | None:
        threshold = float(self.settings.diary_key_private_emotion_threshold)
        ranked: list[tuple[float, str]] = []
        for date_str in self.diary.list_entries():
            if date_str in unlocked:
                continue
            try:
                age_days = (now.date() - datetime.strptime(date_str, "%Y-%m-%d").date()).days
            except ValueError:
                continue
            if age_days < 14 or age_days > 365:
                continue
            metadata = self.diary.get_entry_metadata(date_str) or {}
            emotions = metadata.get("emotions", {})
            if not isinstance(emotions, dict):
                continue
            try:
                intensity = max(
                    float(emotions.get("sadness", 0.0) or 0.0),
                    float(emotions.get("grievance", 0.0) or 0.0),
                )
            except (TypeError, ValueError):
                continue
            if intensity >= threshold:
                ranked.append((intensity, date_str))
        ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return ranked[0][1] if ranked else None

    @staticmethod
    def _state_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "host_date": str(row["host_date"]),
            "target_date": str(row["target_date"]),
            "eligible_at": float(row["eligible_at"]),
            "unlocked": row["unlocked_at"] is not None,
            "unlocked_at": float(row["unlocked_at"]) if row["unlocked_at"] is not None else None,
        }

    def decorate_entries(
        self,
        entries: list[dict[str, Any]],
        *,
        now: datetime | None = None,
    ) -> list[dict[str, Any]]:
        state = self.evaluate(now)
        with self._connect() as connection:
            unlocked = {
                str(row[0]) for row in connection.execute("SELECT date FROM diary_unlocks").fetchall()
            }
        decorated: list[dict[str, Any]] = []
        for original in entries:
            item = dict(original)
            date_str = str(item.get("date", ""))
            if date_str in unlocked:
                entry = self.diary.load_entry(date_str)
                item.update({
                    "can_peek": True,
                    "is_locked": False,
                    "key_unlocked": True,
                    "status_label": "已解锁",
                })
                if entry is not None:
                    item.update({
                        "title": entry.title,
                        "content": entry.content,
                        "emotions": entry.emotions,
                        "created_at": entry.created_at,
                    })
            if state and not state["unlocked"] and date_str == state["host_date"]:
                item["key_available"] = True
                item["status_label"] = "钥匙"
            decorated.append(item)
        return decorated

    def unlock(self, host_date: str, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._now_local()
        state = self.evaluate(now)
        if state is None or state["unlocked"] or state["host_date"] != str(host_date):
            raise ValueError("这把日记钥匙现在不可用")
        target_date = state["target_date"]
        entry = self.diary.load_entry(target_date)
        if entry is None:
            raise ValueError("钥匙对应的日记已经不存在或无法解密")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """INSERT OR REPLACE INTO diary_unlocks(date,host_date,unlocked_at,reason)
                       VALUES(?,?,?,?)""",
                    (target_date, host_date, now.timestamp(), "relationship_happiness_easter_egg"),
                )
                cursor = connection.execute(
                    """UPDATE diary_key_state SET unlocked_at=?
                       WHERE singleton=1 AND host_date=? AND target_date=? AND unlocked_at IS NULL""",
                    (now.timestamp(), host_date, target_date),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError("日记钥匙状态在解锁时发生变化")
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return {"ok": True, "entry": entry.to_dict(), "key_unlocked": True}

    def read(
        self,
        date_str: str,
        *,
        status: str,
        late_night_active: bool,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            unlocked = connection.execute(
                "SELECT 1 FROM diary_unlocks WHERE date=?", (str(date_str),)
            ).fetchone() is not None
        if not unlocked and not self.diary.can_peek(
            status=status,
            late_night_active=late_night_active,
        ):
            raise PermissionError("这页日记现在仍然锁着")
        entry = self.diary.load_entry(str(date_str))
        if entry is None:
            raise ValueError("日记不存在或无法解密")
        return {"ok": True, "entry": entry.to_dict(), "key_unlocked": unlocked}

    def export_all(self) -> dict[str, Any]:
        with self._connect() as connection:
            state = connection.execute("SELECT * FROM diary_key_state WHERE singleton=1").fetchone()
            unlocks = connection.execute(
                "SELECT date,host_date,unlocked_at,reason FROM diary_unlocks ORDER BY date"
            ).fetchall()
        return {
            "schema": "reverie.diary_keys.v1",
            "state": self._state_dict(state) if state is not None else None,
            "unlocks": [dict(row) for row in unlocks],
        }

    def import_all(self, payload: dict[str, Any]) -> int:
        if not isinstance(payload, dict) or payload.get("schema") != "reverie.diary_keys.v1":
            raise ValueError("日记钥匙备份格式无效")
        state = payload.get("state")
        unlocks = payload.get("unlocks", [])
        if state is not None and not isinstance(state, dict):
            raise ValueError("日记钥匙状态无效")
        if not isinstance(unlocks, list):
            raise ValueError("日记解锁记录无效")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DELETE FROM diary_unlocks")
                connection.execute("DELETE FROM diary_key_state")
                if state is not None:
                    connection.execute(
                        """INSERT INTO diary_key_state(
                               singleton,host_date,target_date,eligible_at,unlocked_at
                           ) VALUES(1,?,?,?,?)""",
                        tuple(state.get(key) for key in (
                            "host_date", "target_date", "eligible_at", "unlocked_at",
                        )),
                    )
                for row in unlocks:
                    if not isinstance(row, dict):
                        raise ValueError("日记解锁记录无效")
                    connection.execute(
                        """INSERT INTO diary_unlocks(date,host_date,unlocked_at,reason)
                           VALUES(?,?,?,?)""",
                        tuple(row.get(key) for key in (
                            "date", "host_date", "unlocked_at", "reason",
                        )),
                    )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return len(unlocks) + int(state is not None)
