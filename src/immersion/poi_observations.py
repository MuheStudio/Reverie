"""Dormant, license-gated POI observation persistence.

The default product never constructs this store. The schema deliberately accepts
only a broad category and timestamps, so enabling code cannot persist provider or
location identifiers without changing this reviewed boundary.
"""

from __future__ import annotations

import sqlite3
import math
import time
from pathlib import Path


poi_observation_persistence_allowed = False
RETENTION_SECONDS = 90 * 24 * 60 * 60


class PoiObservationStore:
    def __init__(self, path: str | Path) -> None:
        if poi_observation_persistence_allowed is not True:
            raise PermissionError("POI observation persistence is not licensed")
        self._connection = sqlite3.connect(Path(path))
        self._connection.execute(
            """CREATE TABLE IF NOT EXISTS poi_observations (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   broad_category TEXT NOT NULL,
                   observed_at REAL NOT NULL,
                   expires_at REAL NOT NULL,
                   CHECK(length(broad_category) BETWEEN 1 AND 80)
               )"""
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_poi_observations_expiry ON poi_observations(expires_at)"
        )

    def add(self, broad_category: str, *, observed_at: float | None = None) -> int:
        value = " ".join(str(broad_category).split())
        if not value or len(value) > 80:
            raise ValueError("Broad category is invalid")
        observed = float(observed_at if observed_at is not None else time.time())
        if not math.isfinite(observed):
            raise ValueError("Observation timestamp is invalid")
        cursor = self._connection.execute(
            "INSERT INTO poi_observations(broad_category,observed_at,expires_at) VALUES (?,?,?)",
            (value, observed, observed + RETENTION_SECONDS),
        )
        self._connection.commit()
        return int(cursor.lastrowid)

    def list_active(self, *, now: float | None = None) -> list[dict[str, object]]:
        current = float(now if now is not None else time.time())
        self.purge_expired(now=current)
        rows = self._connection.execute(
            "SELECT id,broad_category,observed_at,expires_at FROM poi_observations "
            "WHERE expires_at>? ORDER BY observed_at DESC,id DESC",
            (current,),
        ).fetchall()
        return [
            {"id": row[0], "broad_category": row[1], "observed_at": row[2], "expires_at": row[3]}
            for row in rows
        ]

    def purge_expired(self, *, now: float | None = None) -> int:
        current = float(now if now is not None else time.time())
        cursor = self._connection.execute(
            "DELETE FROM poi_observations WHERE expires_at<=?", (current,)
        )
        self._connection.commit()
        return max(0, int(cursor.rowcount))

    def delete(self, observation_id: int) -> bool:
        cursor = self._connection.execute(
            "DELETE FROM poi_observations WHERE id=?", (int(observation_id),)
        )
        self._connection.commit()
        return cursor.rowcount == 1

    def close(self) -> None:
        self._connection.close()
