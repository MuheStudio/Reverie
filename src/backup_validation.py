"""Side-effect-free validation against actual desktop participant constraints."""
from __future__ import annotations

from contextlib import closing
from pathlib import Path
from typing import Any

from .backup_inspection import BackupRestoreError
from .storage.encrypted_sqlite import _apply_raw_key, _current_key, _sqlcipher_module, connect_database


def validate_sql_participant(path: Path, tables: dict[str,list[dict[str,Any]]]) -> None:
    """Replay only declared tables in SQLCipher RAM, never a manager database.

    Schemas come from the actual readonly participant database, so required
    columns, uniqueness, enum CHECKs, and foreign keys match its writer.
    """
    key = _current_key()
    if key is None:
        raise BackupRestoreError("Encrypted participant validation is unavailable",code="BACKUP_RECOVERY_UNAVAILABLE")
    try:
        with closing(connect_database(path,timeout=5.0,isolation_level=None,read_only=True)) as source:
            source.execute("PRAGMA query_only=ON")
            with closing(_sqlcipher_module().connect(":memory:",isolation_level=None)) as scratch:
                _apply_raw_key(scratch,key)
                scratch.execute("PRAGMA temp_store=MEMORY")
                scratch.execute("PRAGMA foreign_keys=ON")
                columns: dict[str,list[str]] = {}
                for table in tables:
                    row = source.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()
                    if row is None:
                        raise ValueError("Participant schema is unavailable")
                    scratch.execute(str(row[0]))
                    columns[table] = [str(item[1]) for item in source.execute(f'PRAGMA table_info("{table}")')]
                for table,rows in tables.items():
                    names = columns[table]
                    quoted = ",".join('"'+name.replace('"','""')+'"' for name in names)
                    sql = f'INSERT INTO "{table}" ({quoted}) VALUES({",".join("?" for _ in names)})'
                    for row in rows:
                        scratch.execute(sql,tuple(row.get(name) for name in names))
    except BackupRestoreError:
        raise
    except Exception as exc:
        raise BackupRestoreError("Backup contains invalid desktop participant records",code="BACKUP_INVALID_FORMAT") from exc
