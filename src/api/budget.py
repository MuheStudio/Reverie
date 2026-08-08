"""Transparent local API-usage ledger with background-call budgets."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config.settings import WORLD_STATE_DB
from ..storage.encrypted_sqlite import connect_database

if TYPE_CHECKING:
    from ..config.settings import FeatureSettings


class ApiBudgetExceeded(RuntimeError):
    """Raised only for background work when the configured budget is exhausted."""


class ApiBudgetTracker:
    def __init__(self, settings: "FeatureSettings", *, path: Path | None = None) -> None:
        self.settings = settings
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
                CREATE TABLE IF NOT EXISTS api_usage_calls (
                    id TEXT PRIMARY KEY,
                    local_day TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    finished_at REAL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    background INTEGER NOT NULL CHECK (background IN (0,1)),
                    estimated_tokens INTEGER NOT NULL,
                    prompt_tokens INTEGER NOT NULL DEFAULT 0,
                    completion_tokens INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL CHECK (status IN ('started','success','failed')),
                    error_type TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_api_usage_day
                    ON api_usage_calls(local_day,background,status);
                CREATE INDEX IF NOT EXISTS idx_api_usage_started
                    ON api_usage_calls(started_at DESC);
                """
            )

    @staticmethod
    def estimate_tokens(messages: list[dict[str, Any]], max_tokens: int) -> int:
        characters = 0
        for message in messages:
            content = message.get("content", "")
            if isinstance(content, str):
                characters += len(content)
            else:
                characters += len(json.dumps(content, ensure_ascii=False, default=str))
        # Conservative mixed Chinese/English approximation plus requested output.
        return max(1, (characters + 1) // 2 + max(1, int(max_tokens)))

    def begin(
        self,
        *,
        provider: str,
        model: str,
        purpose: str,
        background: bool,
        estimated_tokens: int,
        now: datetime | None = None,
    ) -> str | None:
        if not self.settings.api_budget_tracking_enabled:
            return None
        now = now or datetime.now()
        call_id = uuid.uuid4().hex
        local_day = now.date().isoformat()
        estimate = max(1, int(estimated_tokens))
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if background and self.settings.api_background_budget_enforced:
                    row = connection.execute(
                        """SELECT COUNT(*) AS requests,
                                  COALESCE(SUM(
                                      CASE WHEN prompt_tokens+completion_tokens>0
                                           THEN prompt_tokens+completion_tokens
                                           ELSE estimated_tokens END
                                  ),0) AS tokens
                           FROM api_usage_calls
                           WHERE local_day=? AND background=1""",
                        (local_day,),
                    ).fetchone()
                    requests = int(row["requests"] if row else 0)
                    tokens = int(row["tokens"] if row else 0)
                    if requests + 1 > int(self.settings.api_background_daily_request_budget):
                        raise ApiBudgetExceeded("今日后台 API 请求预算已用完")
                    if tokens + estimate > int(self.settings.api_background_daily_token_budget):
                        raise ApiBudgetExceeded("今日后台 Token 预算已用完")
                connection.execute(
                    """INSERT INTO api_usage_calls(
                           id,local_day,started_at,provider,model,purpose,background,
                           estimated_tokens,status
                       ) VALUES(?,?,?,?,?,?,?,?, 'started')""",
                    (
                        call_id,
                        local_day,
                        now.timestamp(),
                        str(provider)[:80],
                        str(model)[:160],
                        str(purpose)[:120],
                        int(bool(background)),
                        estimate,
                    ),
                )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
        return call_id

    def complete(self, call_id: str | None, usage: dict[str, Any]) -> None:
        if not call_id:
            return
        prompt = self._non_negative_int(usage.get("prompt_tokens", 0))
        completion = self._non_negative_int(usage.get("completion_tokens", 0))
        with self._connect() as connection:
            connection.execute(
                """UPDATE api_usage_calls SET finished_at=?,prompt_tokens=?,
                       completion_tokens=?,status='success' WHERE id=? AND status='started'""",
                (time.time(), prompt, completion, call_id),
            )

    def fail(self, call_id: str | None, error: BaseException) -> None:
        if not call_id:
            return
        with self._connect() as connection:
            connection.execute(
                """UPDATE api_usage_calls SET finished_at=?,status='failed',error_type=?
                   WHERE id=? AND status='started'""",
                (time.time(), error.__class__.__name__[:120], call_id),
            )

    @staticmethod
    def _non_negative_int(value: object) -> int:
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError, OverflowError):
            return 0

    def snapshot(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now()
        day = now.date().isoformat()
        with self._connect() as connection:
            totals = connection.execute(
                """SELECT COUNT(*) AS requests,
                          SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS succeeded,
                          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                          COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
                          COALESCE(SUM(completion_tokens),0) AS completion_tokens,
                          COALESCE(SUM(CASE WHEN prompt_tokens+completion_tokens=0
                                           THEN estimated_tokens ELSE 0 END),0) AS estimated_tokens
                   FROM api_usage_calls WHERE local_day=?""",
                (day,),
            ).fetchone()
            background = connection.execute(
                """SELECT COUNT(*) AS requests,
                          COALESCE(SUM(CASE WHEN prompt_tokens+completion_tokens>0
                                           THEN prompt_tokens+completion_tokens
                                           ELSE estimated_tokens END),0) AS tokens
                   FROM api_usage_calls WHERE local_day=? AND background=1""",
                (day,),
            ).fetchone()
            purposes = connection.execute(
                """SELECT purpose,COUNT(*) AS requests,
                          COALESCE(SUM(prompt_tokens+completion_tokens),0) AS measured_tokens
                   FROM api_usage_calls WHERE local_day=?
                   GROUP BY purpose ORDER BY requests DESC,purpose LIMIT 20""",
                (day,),
            ).fetchall()
            connection.execute(
                "DELETE FROM api_usage_calls WHERE started_at<?",
                ((now - timedelta(days=366)).timestamp(),),
            )
        total = dict(totals) if totals else {}
        bg_requests = int(background["requests"] if background else 0)
        bg_tokens = int(background["tokens"] if background else 0)
        return {
            "local_day": day,
            "tracking_enabled": bool(self.settings.api_budget_tracking_enabled),
            "background_enforced": bool(self.settings.api_background_budget_enforced),
            "requests": int(total.get("requests", 0) or 0),
            "succeeded": int(total.get("succeeded", 0) or 0),
            "failed": int(total.get("failed", 0) or 0),
            "prompt_tokens": int(total.get("prompt_tokens", 0) or 0),
            "completion_tokens": int(total.get("completion_tokens", 0) or 0),
            "estimated_unreported_tokens": int(total.get("estimated_tokens", 0) or 0),
            "background": {
                "requests": bg_requests,
                "request_budget": int(self.settings.api_background_daily_request_budget),
                "tokens": bg_tokens,
                "token_budget": int(self.settings.api_background_daily_token_budget),
            },
            "by_purpose": [dict(row) for row in purposes],
            "currency_estimate": None,
            "currency_note": "未配置供应商单价，因此只报告请求数与 Token，不虚构金额。",
        }
