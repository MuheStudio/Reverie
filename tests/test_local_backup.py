import json

import pytest

import src.backup as backup_module
from src.backup import BACKUP_SCHEMA, LocalBackupManager
from src.memory.manager import MemoryManager
from src.persona.persona_card import default_persona


class FakeMemory:
    def __init__(self) -> None:
        self.persona = default_persona()
        self.rows = [
            {
                "id": "lt_1",
                "text": "事件记忆：一起聊过生日约定",
                "layer": "long_term",
                "timestamp": 1.0,
                "importance": 0.9,
                "emotion_joy": 12.0,
                "vector": [0.0] * 384,
            }
        ]
        self.imported = []
        self.replace = None
        self.synced = False

    def export_all(self):
        return self.rows

    def import_all(self, rows, *, replace=False):
        self.imported = rows
        self.replace = replace
        return len(rows)

    def sync_user_profile(self, _user_manager):
        self.synced = True
        return 1


class FakeEmotion:
    def __init__(self) -> None:
        self.state = {"values": {"joy": 70.0}, "mood": "happy"}
        self.restored = None

    def to_dict(self):
        return self.state

    def restore(self, data):
        self.restored = data


class FakeRelationship:
    def __init__(self) -> None:
        self.state = {"intimacy": 520, "stage": "信任期"}
        self.restored = None

    def to_dict(self):
        return self.state

    def restore(self, data):
        self.restored = data


class FakeDiary:
    def __init__(self) -> None:
        self.data = {"entries": [{"date": "2026-07-10", "content": "今天很开心"}]}
        self.restored = None

    def export_all(self):
        return self.data

    def import_all(self, data):
        self.restored = data
        return len(data.get("entries", []))


class FakeUser:
    def __init__(self) -> None:
        self.data = {
            "profile": {"name": "星野白夜"},
            "emotional_memories": [{"summary": "一段情感记忆"}],
        }
        self.restored = None

    def export_all(self):
        return self.data

    def import_all(self, data):
        self.restored = data


class StreamingMemory(FakeMemory):
    def __init__(self, rows=None) -> None:
        super().__init__()
        if rows is not None:
            self.rows = list(rows)
        self.stream_import_calls = 0
        self.restore_marker = ""

    def export_all(self):
        raise AssertionError("streaming backup must not materialize all memory")

    def iter_export_pages(self, *, page_size=137):
        for offset in range(0, len(self.rows), page_size):
            yield self.rows[offset:offset + page_size]

    def import_all(self, rows, *, replace=False):
        raise AssertionError("streaming restore must not materialize all memory")

    def import_stream(
        self,
        rows,
        *,
        replace=False,
        before_commit=None,
        restore_marker="",
    ):
        self.stream_import_calls += 1
        incoming = list(rows)
        if before_commit is not None:
            before_commit()
        self.rows = incoming if replace else [*self.rows, *incoming]
        self.restore_marker = restore_marker
        return len(incoming)


def test_memory_export_read_failure_never_becomes_successful_empty_backup() -> None:
    class BrokenCatalog:
        def all(self):
            raise OSError("catalog read failed")

    manager = object.__new__(MemoryManager)
    manager.store = type("Store", (), {"catalog": BrokenCatalog()})()

    with pytest.raises(OSError, match="catalog read failed"):
        manager.export_all()


def test_complete_local_backup_exports_all_restorable_sections() -> None:
    manager = LocalBackupManager(
        memory=FakeMemory(),  # type: ignore[arg-type]
        emotion=FakeEmotion(),  # type: ignore[arg-type]
        relationship=FakeRelationship(),  # type: ignore[arg-type]
        diary=FakeDiary(),  # type: ignore[arg-type]
        user_manager=FakeUser(),  # type: ignore[arg-type]
    )

    payload = manager.export_payload()

    assert payload["schema"] == BACKUP_SCHEMA
    assert payload["storage_policy"] == "local-first"
    assert payload["cloud_status"] == "开发中"
    assert payload["memory"][0]["text"].startswith("事件记忆")
    assert payload["emotion"]["values"]["joy"] == 70.0
    assert payload["relationship"]["intimacy"] == 520
    assert payload["user"]["profile"]["name"] == "星野白夜"
    assert payload["diary"]["entries"][0]["date"] == "2026-07-10"


def test_complete_local_backup_import_restores_state_and_replaces_memory() -> None:
    memory = FakeMemory()
    emotion = FakeEmotion()
    relationship = FakeRelationship()
    diary = FakeDiary()
    user = FakeUser()
    manager = LocalBackupManager(
        memory=memory,  # type: ignore[arg-type]
        emotion=emotion,  # type: ignore[arg-type]
        relationship=relationship,  # type: ignore[arg-type]
        diary=diary,  # type: ignore[arg-type]
        user_manager=user,  # type: ignore[arg-type]
    )

    payload = manager.export_payload()
    result = manager.import_payload(payload)

    assert result == {"memory": 1, "diary": 1}
    assert memory.replace is True
    assert emotion.restored == payload["emotion"]
    assert relationship.restored == payload["relationship"]
    assert user.restored == payload["user"]
    assert diary.restored == payload["diary"]
    assert memory.synced is True


def test_backup_from_another_persona_is_rejected_before_any_restore() -> None:
    memory = FakeMemory()
    manager = LocalBackupManager(
        memory=memory,  # type: ignore[arg-type]
        emotion=FakeEmotion(),  # type: ignore[arg-type]
        relationship=FakeRelationship(),  # type: ignore[arg-type]
        diary=FakeDiary(),  # type: ignore[arg-type]
        user_manager=FakeUser(),  # type: ignore[arg-type]
    )
    payload = manager.export_payload()
    payload["persona_identity"]["persona_id"] = "attacker_persona"

    with pytest.raises(ValueError, match="另一个人格"):
        manager.import_payload(payload)

    assert memory.imported == []


def _streaming_manager(memory: StreamingMemory) -> LocalBackupManager:
    return LocalBackupManager(
        memory=memory,  # type: ignore[arg-type]
        emotion=FakeEmotion(),  # type: ignore[arg-type]
        relationship=FakeRelationship(),  # type: ignore[arg-type]
        diary=FakeDiary(),  # type: ignore[arg-type]
        user_manager=FakeUser(),  # type: ignore[arg-type]
    )


def test_file_backup_and_restore_stream_every_memory_record(tmp_path) -> None:
    rows = [
        {
            "id": f"memory-{index}",
            "text": f"事件记忆：第 {index} 条本地记录",
            "retention_layer": "long_term",
            "cognitive_layer": "episodic",
        }
        for index in range(3_005)
    ]
    backup_path = tmp_path / "complete.json"
    _streaming_manager(StreamingMemory(rows)).backup_to_file(backup_path)

    decoded = json.loads(backup_path.read_text(encoding="utf-8"))
    assert len(decoded["memory"]) == len(rows)
    assert decoded["memory"][-1]["id"] == "memory-3004"

    restored_memory = StreamingMemory([])
    result = _streaming_manager(restored_memory).restore_from_file(backup_path)

    assert result["memory"] == len(rows)
    assert restored_memory.stream_import_calls == 1
    assert len(restored_memory.rows) == len(rows)
    assert restored_memory.rows[-1]["id"] == "memory-3004"


def test_truncated_backup_is_rejected_before_restore_mutates_state(tmp_path) -> None:
    memory = StreamingMemory([{"id": "before", "text": "导入前记忆"}])
    manager = _streaming_manager(memory)
    backup_path = tmp_path / "truncated.json"
    _streaming_manager(StreamingMemory([
        {"id": "after", "text": "导入后记忆"},
    ])).backup_to_file(backup_path)
    complete = backup_path.read_text(encoding="utf-8")
    backup_path.write_text(complete[:-9], encoding="utf-8")

    with pytest.raises(ValueError, match="malformed|truncated|ended"):
        manager.restore_from_file(backup_path)

    assert memory.stream_import_calls == 0
    assert memory.rows == [{"id": "before", "text": "导入前记忆"}]


def test_backup_write_failure_preserves_previous_file(monkeypatch, tmp_path) -> None:
    backup_path = tmp_path / "complete.json"
    backup_path.write_text("previous-good-backup", encoding="utf-8")
    manager = _streaming_manager(StreamingMemory([
        {"id": "new", "text": "一条新记忆"},
    ]))

    def fail_replace(_source, _target):
        raise OSError("injected disk replacement failure")

    monkeypatch.setattr(backup_module.os, "replace", fail_replace)

    with pytest.raises(OSError, match="injected"):
        manager.backup_to_file(backup_path)

    assert backup_path.read_text(encoding="utf-8") == "previous-good-backup"
    assert list(tmp_path.glob(".complete.json.*.tmp")) == []
