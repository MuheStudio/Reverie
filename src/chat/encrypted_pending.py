"""Store the MVP's delivery ledger in its authenticated kernel database."""

from __future__ import annotations

import json
import logging
import os
import stat
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .pending import TERMINAL_STATES, PendingChatStore

if TYPE_CHECKING:
    from ..kernel.storage import KernelStore

logger = logging.getLogger("reverie.chat.pending")


def _file_identity(status: os.stat_result) -> tuple[int, int, int, int]:
    return status.st_dev, status.st_ino, status.st_size, status.st_mtime_ns


class EncryptedPendingChatStore(PendingChatStore):
    """Share delivery rules with the file store, committing each edit to SQL."""

    def __init__(self, kernel_store: KernelStore) -> None:
        self._kernel = kernel_store
        self._initialized = False

    @property
    def _legacy_path(self) -> Path:
        return self._kernel.path.with_name("pending_chat.json")

    @staticmethod
    def _table_exists(connection) -> bool:
        return connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'preview_pending_chat'",
        ).fetchone() is not None

    @staticmethod
    def _rows(connection) -> list[tuple[str, dict[str, Any]]]:
        return [(row[0], json.loads(row[1])) for row in connection.execute(
            "SELECT request_id, payload_json FROM preview_pending_chat ORDER BY rowid",
        )]

    @staticmethod
    def _read_item(connection, item_id: str) -> dict[str, Any] | None:
        row = connection.execute(
            "SELECT payload_json FROM preview_pending_chat WHERE request_id = ?", (item_id,),
        ).fetchone()
        return json.loads(row[0]) if row is not None else None

    @staticmethod
    def _write_item(connection, item_id: str, item: dict[str, Any], *, insert: bool = False) -> None:
        payload = json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if insert:
            connection.execute(
                "INSERT INTO preview_pending_chat (request_id, payload_json) VALUES (?, ?) "
                "ON CONFLICT(request_id) DO NOTHING", (item_id, payload),
            )
        else:
            connection.execute(
                "UPDATE preview_pending_chat SET payload_json = ? WHERE request_id = ?", (payload, item_id),
            )

    def initialize_writable(self) -> None:
        """Normalize a cold start and import the file once recovery admits writes."""
        if self._initialized:
            return
        legacy = self._read_legacy()
        with self._kernel.transaction() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS preview_pending_chat "
                "(request_id TEXT PRIMARY KEY NOT NULL, payload_json TEXT NOT NULL)",
            )
            for item_id, raw in self._rows(connection):
                item = self._normalize_item(raw, version=2)
                if item != raw:
                    self._write_item(connection, item_id, item)
            if legacy is not None:
                _, items = legacy
                for item_id, item in items.items():
                    self._write_item(connection, item_id, item, insert=True)
        self._initialized = True
        if legacy is not None:
            identity, _ = legacy
            try:
                self._remove_imported_file(identity)
            except OSError:
                logger.warning("Encrypted pending chat import committed; legacy cleanup deferred")

    def _read_legacy(self) -> tuple[tuple[int, int, int, int] | None, dict[str, dict[str, Any]]] | None:
        try:
            try:
                initial = self._legacy_path.lstat()
            except FileNotFoundError:
                return None, {}
            if not stat.S_ISREG(initial.st_mode):
                raise ValueError("Invalid legacy pending chat file")
            descriptor = os.open(self._legacy_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                                 getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(descriptor, "rb") as file:
                status = os.fstat(file.fileno())
                identity = _file_identity(status)
                if not stat.S_ISREG(status.st_mode) or identity != _file_identity(initial):
                    raise ValueError("Invalid legacy pending chat file")
                data = json.loads(file.read().decode("utf-8"))
                if _file_identity(os.fstat(file.fileno())) != identity:
                    raise ValueError("Legacy pending chat file changed during read")
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                raise ValueError("Invalid legacy pending chat document")
            version = int(data.get("version", 1))
            items = {}
            for raw in data["items"]:
                if not isinstance(raw, dict) or not raw.get("id") or not raw.get("text"):
                    continue
                item = self._normalize_item(raw, version=version)
                request_id = item["request_id"]
                if str(raw.get("state", "waiting")) in TERMINAL_STATES:
                    items.pop(request_id, None)
                else:
                    # If restart normalization ends a formerly active row,
                    # preserve its uncertainty or quarantine tombstone.
                    items[request_id] = item
            return identity, items
        except (OSError, ValueError, TypeError, OverflowError, RecursionError):
            logger.warning("Failed to read legacy pending chat ledger; preserving it")
            return None

    def _remove_imported_file(self, identity: tuple[int, int, int, int] | None) -> None:
        path = self._legacy_path
        try:
            current = _file_identity(path.lstat())
        except FileNotFoundError:
            current = None
        if current != identity:
            raise OSError("Legacy pending chat file changed before cleanup")
        # A crash after removing the temporary file still leaves the source
        # available for an idempotent import on the next start.
        path.with_suffix(".json.tmp").unlink(missing_ok=True)
        if current is not None:
            path.unlink()

    def _lookup_item(self, item_id: str) -> dict[str, Any] | None:
        with self._kernel.transaction() as connection:
            if self._table_exists(connection):
                return self._read_item(connection, item_id)
        return None

    def _stored_items(self) -> list[dict[str, Any]]:
        with self._kernel.transaction() as connection:
            if self._table_exists(connection):
                return [item for _, item in self._rows(connection)]
        return []

    def _insert_item(self, item_id: str, item: dict[str, Any]) -> None:
        with self._kernel.transaction() as connection:
            self._write_item(connection, item_id, item, insert=True)

    def _edit_item(self, item_id: str, mutate: Callable[[dict[str, Any]], bool]) -> None:
        with self._kernel.transaction() as connection:
            item = self._read_item(connection, item_id)
            if item is not None and mutate(item):
                self._write_item(connection, item_id, item)

    def _edit_selected(self, matches: Callable[[dict[str, Any]], bool],
                       changes: dict[str, Any] | None) -> list[str]:
        selected = []
        with self._kernel.transaction() as connection:
            for item_id, item in self._rows(connection):
                if not matches(item):
                    continue
                if changes is None:
                    connection.execute("DELETE FROM preview_pending_chat WHERE request_id = ?", (item_id,))
                else:
                    item.update(changes)
                    self._write_item(connection, item_id, item)
                selected.append(item_id)
        return selected

    def remove(self, item_id: str) -> None:
        with self._kernel.transaction() as connection:
            connection.execute("DELETE FROM preview_pending_chat WHERE request_id = ?", (str(item_id),))
