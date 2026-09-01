from __future__ import annotations

import json
from pathlib import Path

import pytest

import src.local_store as local_store
from src.diary import DiaryEntry, DiaryManager
from src.persona.persona_card import default_persona


def test_atomic_write_fsyncs_files_and_cleans_temps(tmp_path: Path, monkeypatch) -> None:
    fsynced: list[int] = []
    real_fsync = local_store.os.fsync
    monkeypatch.setattr(local_store.os, "fsync", lambda fd: (fsynced.append(fd), real_fsync(fd))[1])

    local_store.atomic_write_json(tmp_path / "state.json", {"value": 1})

    assert len(fsynced) >= 2  # Primary and first-generation backup.
    assert list(tmp_path.glob("*.tmp")) == []


def test_failed_primary_replace_keeps_prior_and_backup(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "state.json"
    local_store.atomic_write_json(target, {"value": 1})
    real_replace = local_store._durable_replace

    def fail_primary(source: Path, destination: Path) -> None:
        if destination == target:
            raise OSError("injected primary replacement failure")
        real_replace(source, destination)

    monkeypatch.setattr(local_store, "_durable_replace", fail_primary)
    with pytest.raises(OSError, match="injected"):
        local_store.atomic_write_json(target, {"value": 2})

    assert json.loads(target.read_text(encoding="utf-8")) == {"value": 1}
    assert local_store.read_json_object(target) == {"value": 1}
    assert list(tmp_path.glob("*.tmp")) == []


def test_corrupt_primary_never_replaces_only_good_backup(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "state.json"
    backup = local_store.backup_path(target)
    target.write_text("{broken", encoding="utf-8")
    backup.write_text('{"value": "safe"}', encoding="utf-8")

    monkeypatch.setattr(
        local_store,
        "_durable_replace",
        lambda _source, _destination: (_ for _ in ()).throw(OSError("injected")),
    )
    with pytest.raises(OSError, match="injected"):
        local_store.atomic_write_json(target, {"value": "new"})

    assert json.loads(backup.read_text(encoding="utf-8")) == {"value": "safe"}
    assert local_store.read_json_object(target) == {"value": "safe"}
    assert list(tmp_path.glob("*.tmp")) == []


def test_read_json_object_recovers_missing_or_corrupt_primary(tmp_path: Path) -> None:
    target = tmp_path / "state.json"
    local_store.backup_path(target).write_text('{"value": 7}', encoding="utf-8")

    assert local_store.read_json_object(target) == {"value": 7}
    target.write_text("not-json", encoding="utf-8")
    assert local_store.read_json_object(target) == {"value": 7}


def test_diary_recovers_encrypted_backup_without_plaintext(tmp_path: Path) -> None:
    diary = DiaryManager(default_persona(), diary_dir=tmp_path)
    first = DiaryEntry(
        date="2099-01-01",
        title="prior secret title",
        content="prior secret diary body",
        mood="quiet",
        emotions={"joy": 1},
        created_at="2099-01-01T00:00:00",
    )
    newer = DiaryEntry(
        date=first.date,
        title="new secret title",
        content="new secret diary body",
        mood="happy",
        emotions={"joy": 2},
        created_at="2099-01-01T01:00:00",
    )
    diary.save_entry(first)
    diary.save_entry(newer)
    primary = tmp_path / "2099-01-01.json"
    backup = local_store.backup_path(primary)
    newer_envelope = json.loads(primary.read_text(encoding="utf-8"))

    raw_backup = backup.read_text(encoding="utf-8")
    assert "prior secret title" not in raw_backup
    assert "prior secret diary body" not in raw_backup
    assert '"encrypted": true' in raw_backup
    primary.write_text("{truncated", encoding="utf-8")

    recovered = diary.load_entry(first.date)
    assert diary.list_entries() == [first.date]
    assert recovered is not None
    assert recovered.title == first.title
    assert recovered.content == first.content
    assert diary.get_entry_metadata(first.date)["mood"] == first.mood

    # Authentication corruption can remain valid JSON and must still fall back.
    newer_envelope["crypto"]["ciphertext"] = "AAAA"
    primary.write_text(json.dumps(newer_envelope), encoding="utf-8")
    recovered = diary.load_entry(first.date)
    assert recovered is not None
    assert recovered.content == first.content


def test_diary_write_does_not_rotate_auth_invalid_primary_over_good_backup(tmp_path: Path, monkeypatch) -> None:
    diary = DiaryManager(default_persona(), diary_dir=tmp_path)

    def entry(content: str, hour: int) -> DiaryEntry:
        return DiaryEntry(
            date="2099-01-02",
            title=content,
            content=content,
            mood="quiet",
            emotions={},
            created_at=f"2099-01-02T{hour:02}:00:00",
        )

    diary.save_entry(entry("only good prior", 0))
    diary.save_entry(entry("newer primary", 1))
    primary = tmp_path / "2099-01-02.json"
    backup = local_store.backup_path(primary)
    damaged = json.loads(primary.read_text(encoding="utf-8"))
    damaged["crypto"]["ciphertext"] = "AAAA"
    primary.write_text(json.dumps(damaged), encoding="utf-8")
    good_backup = backup.read_bytes()

    monkeypatch.setattr(
        local_store,
        "_durable_replace",
        lambda _source, destination: (_ for _ in ()).throw(OSError(f"injected {destination.name}")),
    )
    with pytest.raises(OSError, match="injected"):
        diary.save_entry(entry("attempted replacement", 2))

    assert backup.read_bytes() == good_backup
    assert list(tmp_path.glob("*.tmp")) == []
