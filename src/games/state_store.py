"""Persona-scoped, bounded SQLite storage for optional mini games."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import threading
from typing import Any

from src.kernel.modules import CapabilityManifest
from src.kernel.storage import connect_sqlite


MAX_STATE_BYTES = 1024 * 1024
MAX_STATE_DEPTH = 64
MAX_STATE_ITEMS = 50_000
_GAME_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_PERSONA_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
_DANGEROUS_KEYS = frozenset({"__proto__", "prototype", "constructor"})


class GameStateConflict(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_json(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [0]
    if depth > MAX_STATE_DEPTH:
        raise ValueError("game state is nested too deeply")
    budget[0] += 1
    if budget[0] > MAX_STATE_ITEMS:
        raise ValueError("game state contains too many values")
    if value is None or isinstance(value, (bool, str)):
        if isinstance(value, str) and (len(value) > 200_000 or "\x00" in value):
            raise ValueError("game state string is invalid")
        return
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # float() of a huge Python int (e.g. 10**400) raises OverflowError,
        # which is still "not a finite JSON number" and must surface as the
        # same validation failure as inf/nan.
        try:
            finite = math.isfinite(float(value))
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("game state number must be finite")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json(item, depth=depth + 1, budget=budget)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 160
                or key in _DANGEROUS_KEYS
                or "\x00" in key
            ):
                raise ValueError("game state object key is invalid")
            _validate_json(item, depth=depth + 1, budget=budget)
        return
    raise ValueError("game state contains a non-JSON value")


class GameStateStore:
    manifest = CapabilityManifest(
        module_id="games",
        version="1.0.0",
        api_consuming=False,
        default_enabled=True,
        data_permissions=("game_state:read", "game_state:write"),
    )

    def __init__(self, path: Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()
        self._connection = connect_sqlite(self.path)
        self._connection.executescript(
            """
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS game_state (
                persona_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision >= 1),
                state_json TEXT NOT NULL,
                checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
                updated_at_utc TEXT NOT NULL,
                PRIMARY KEY (persona_id, game_id)
            );
            COMMIT;
            """
        )
        self._connection.execute("PRAGMA user_version = 1")

    @staticmethod
    def _scope(persona_id: str, game_id: str) -> tuple[str, str]:
        if not _PERSONA_ID.fullmatch(persona_id):
            raise ValueError("invalid persona id")
        if not _GAME_ID.fullmatch(game_id):
            raise ValueError("invalid game id")
        return persona_id, game_id

    def get(self, persona_id: str, game_id: str) -> dict[str, Any]:
        persona_id, game_id = self._scope(persona_id, game_id)
        with self._lock:
            row = self._connection.execute(
                """
                SELECT revision, state_json, checksum_sha256, updated_at_utc
                FROM game_state WHERE persona_id = ? AND game_id = ?
                """,
                (persona_id, game_id),
            ).fetchone()
        if row is None:
            return {"exists": False, "revision": 0, "state": None}
        raw = str(row["state_json"])
        checksum = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        if checksum != row["checksum_sha256"]:
            raise RuntimeError("game state checksum mismatch")
        return {
            "exists": True,
            "revision": int(row["revision"]),
            "state": json.loads(raw),
            "updated_at_utc": str(row["updated_at_utc"]),
        }

    def put(
        self,
        persona_id: str,
        game_id: str,
        state: Any,
        *,
        expected_revision: int,
    ) -> dict[str, Any]:
        persona_id, game_id = self._scope(persona_id, game_id)
        if isinstance(expected_revision, bool) or expected_revision < 0:
            raise ValueError("invalid game state revision")
        _validate_json(state)
        raw = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if len(raw.encode("utf-8")) > MAX_STATE_BYTES:
            raise ValueError("game state exceeds the safe size")
        checksum = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        now = _now()
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    """
                    SELECT revision FROM game_state
                    WHERE persona_id = ? AND game_id = ?
                    """,
                    (persona_id, game_id),
                ).fetchone()
                current = int(row["revision"]) if row else 0
                if current != expected_revision:
                    raise GameStateConflict(
                        f"game state revision changed from {expected_revision} to {current}"
                    )
                revision = current + 1
                self._connection.execute(
                    """
                    INSERT INTO game_state(
                        persona_id, game_id, revision, state_json,
                        checksum_sha256, updated_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(persona_id, game_id) DO UPDATE SET
                        revision = excluded.revision,
                        state_json = excluded.state_json,
                        checksum_sha256 = excluded.checksum_sha256,
                        updated_at_utc = excluded.updated_at_utc
                    """,
                    (persona_id, game_id, revision, raw, checksum, now),
                )
                self._connection.execute("COMMIT")
            except BaseException:
                if self._connection.in_transaction:
                    self._connection.execute("ROLLBACK")
                raise
        return {
            "exists": True,
            "revision": revision,
            "state": state,
            "updated_at_utc": now,
        }

    def start(self) -> None:
        if self.integrity_check() != "ok":
            raise RuntimeError("game state database integrity check failed")

    def stop(self) -> None:
        return

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def handle_event(self, _event) -> None:
        return

    def integrity_check(self) -> str:
        with self._lock:
            row = self._connection.execute("PRAGMA integrity_check").fetchone()
        return str(row[0] if row else "")

    def health(self) -> dict[str, Any]:
        with self._lock:
            count = self._connection.execute("SELECT count(*) FROM game_state").fetchone()[0]
        return {"integrity": self.integrity_check(), "saved_games": int(count)}
