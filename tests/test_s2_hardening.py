"""S2 hardening tests: unique temp writes, bounded backup streaming and
bounded N.E.K.O import (size caps + hash-first dedupe).
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from src.backup import _IncrementalJSONReader
from src.local_store import atomic_write_json, read_json_object
from src.memory.neko_import import (
    NekoImportError,
    import_entries,
    import_json_file,
    normalize_entry,
)


# ── S2-2: unique temp file names ─────────────────────────────


def test_atomic_write_uses_unique_temp_names(tmp_path: Path) -> None:
    target = tmp_path / "state.json"
    atomic_write_json(target, {"a": 1})
    atomic_write_json(target, {"b": 2})
    # No deterministic ".tmp" residue; os.replace consumed each unique temp.
    leftovers = [p.name for p in tmp_path.iterdir() if p.name != "state.json"]
    assert leftovers == [], f"leftover temp files: {leftovers}"
    assert read_json_object(target) == {"b": 2}


# ── S2-7: bounded backup streaming ───────────────────────────


def test_backup_reader_rejects_oversized_single_value(monkeypatch) -> None:
    from src.backup import _IncrementalJSONReader

    monkeypatch.setattr(_IncrementalJSONReader, "MAX_BUFFER_BYTES", 64 * 1024)
    stream = io.StringIO('{"key": "' + "x" * (128 * 1024) + '"}')
    reader = _IncrementalJSONReader(stream)
    with pytest.raises(ValueError, match="safe size"):
        reader.value()


def test_backup_reader_reads_normal_object() -> None:
    stream = io.StringIO('{"memory": [1, 2, 3], "diary": "ok"}')
    reader = _IncrementalJSONReader(stream)
    reader.expect("{")
    assert reader.value() == "memory"
    reader.expect(":")
    assert reader.value() == [1, 2, 3]
    reader.expect(",")
    assert reader.value() == "diary"
    reader.expect(":")
    assert reader.value() == "ok"
    reader.expect("}")
    reader.ensure_finished()


# ── S2-8: bounded N.E.K.O import ─────────────────────────────


def test_import_file_rejects_oversized_source(tmp_path: Path) -> None:
    source = tmp_path / "facts.json"
    source.write_bytes(b"[" + b" " * (11 * 1024 * 1024) + b"]")
    with pytest.raises(NekoImportError, match="过大"):
        import_json_file(MagicMock(), source)


def test_normalize_entry_truncates_oversized_text() -> None:
    entry = {"text": "x" * 50_000, "importance": 3}
    normalized = normalize_entry(entry)
    assert normalized is not None
    assert len(normalized["text"]) == 10_000


def test_import_entries_hash_dedupes_within_batch() -> None:
    memory = MagicMock()
    memory.store_manual_memory.return_value = None
    result = import_entries(
        memory,
        [
            {"text": "same fact", "hash": "h1"},
            {"text": "same fact", "hash": "h1"},
            {"text": "other fact", "hash": "h2"},
        ],
        layer="long_term",
        dedupe=True,
    )
    assert result["imported"] == 2
    assert result["skipped"] == 1
