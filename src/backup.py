"""Complete local backup and restore for Reverie state.

The backup is local-first: every exported byte comes from local managers, and
cloud sync remains a future optional layer rather than the source of truth.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .diary import DiaryManager
    from .emotion.system import EmotionSystem
    from .memory.manager import MemoryManager
    from .relationship.tracker import RelationshipTracker
    from .user import UserManager
    from .timeline import TimelineManager
    from .social import SocialCircle
    from .interest import InterestTracker
    from .affairs import PersonalAffairManager
    from .world import WorldClock
    from .world_state_store import WorldStateStore
    from .ambient import AmbientPresence, ThoughtOfYouEngine
    from .diary.easter_egg import DiaryKeyManager
    from .persona.alignment import UserPhraseAlignment
    from .social.universe import SocialUniverse

from .local_store import atomic_write_json
from .config.settings import (
    AFFAIRS_DIR,
    DATA_DIR,
    DIARY_DIR,
    EMOTION_DIR,
    INTEREST_DIR,
    MEMORY_DIR,
    RELATIONSHIP_DIR,
    SOCIAL_DIR,
    TIMELINE_DIR,
    USER_DIR,
    WORLD_DIR,
)


BACKUP_SCHEMA = "reverie.full_local_backup.v3"
LEGACY_BACKUP_SCHEMAS = {
    "reverie.full_local_backup.v1",
    "reverie.full_local_backup.v2",
}

logger = logging.getLogger("reverie.backup")


class _IncrementalJSONReader:
    """Small stdlib-only JSON cursor that bounds memory to one decoded value."""

    CHUNK_SIZE = 64 * 1024

    def __init__(self, stream) -> None:
        self.stream = stream
        self.decoder = json.JSONDecoder()
        self.buffer = ""
        self.position = 0
        self.eof = False

    def _fill(self) -> bool:
        chunk = self.stream.read(self.CHUNK_SIZE)
        if chunk:
            self.buffer += chunk
            return True
        self.eof = True
        return False

    def _compact(self) -> None:
        if self.position >= self.CHUNK_SIZE:
            self.buffer = self.buffer[self.position:]
            self.position = 0

    def _skip_space(self) -> None:
        while True:
            while self.position < len(self.buffer) and self.buffer[self.position].isspace():
                self.position += 1
            if self.position < len(self.buffer) or self.eof:
                self._compact()
                return
            self._fill()

    def peek(self) -> str:
        self._skip_space()
        if self.position >= len(self.buffer):
            raise ValueError("Backup JSON ended unexpectedly")
        return self.buffer[self.position]

    def expect(self, character: str) -> None:
        if self.peek() != character:
            raise ValueError(f"Malformed backup JSON: expected {character!r}")
        self.position += 1
        self._compact()

    def value(self) -> Any:
        self._skip_space()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer, self.position)
            except json.JSONDecodeError as exc:
                if self.eof:
                    raise ValueError("Backup JSON is malformed or truncated") from exc
                self._fill()
                continue
            self.position = end
            self._compact()
            return value

    def ensure_finished(self) -> None:
        self._skip_space()
        if self.position < len(self.buffer):
            raise ValueError("Backup JSON has trailing data")
        if not self.eof:
            self._fill()
            self._skip_space()
            if self.position < len(self.buffer):
                raise ValueError("Backup JSON has trailing data")


class LocalBackupManager:
    """Exports and restores the full local companion state."""

    def __init__(
        self,
        *,
        memory: "MemoryManager",
        emotion: "EmotionSystem",
        relationship: "RelationshipTracker",
        diary: "DiaryManager",
        user_manager: "UserManager",
        timeline: "TimelineManager | None" = None,
        social_circle: "SocialCircle | None" = None,
        interest_tracker: "InterestTracker | None" = None,
        affair_manager: "PersonalAffairManager | None" = None,
        world_clock: "WorldClock | None" = None,
        state_store: "WorldStateStore | None" = None,
        ambient_presence: "AmbientPresence | None" = None,
        thought_engine: "ThoughtOfYouEngine | None" = None,
        diary_keys: "DiaryKeyManager | None" = None,
        phrase_alignment: "UserPhraseAlignment | None" = None,
        social_universe: "SocialUniverse | None" = None,
    ) -> None:
        self.memory = memory
        self.emotion = emotion
        self.relationship = relationship
        self.diary = diary
        self.user_manager = user_manager
        self.timeline = timeline
        self.social_circle = social_circle
        self.interest_tracker = interest_tracker
        self.affair_manager = affair_manager
        self.world_clock = world_clock
        self.state_store = state_store
        self.ambient_presence = ambient_presence
        self.thought_engine = thought_engine
        self.diary_keys = diary_keys
        self.phrase_alignment = phrase_alignment
        self.social_universe = social_universe

    def _optional_managers(self) -> dict[str, Any]:
        return {
            "timeline": self.timeline,
            "social_circle": self.social_circle,
            "interests": self.interest_tracker,
            "affairs": self.affair_manager,
            "calendar": self.world_clock,
            "ambient_presence": self.ambient_presence,
            "thought_of_you": self.thought_engine,
            "diary_keys": self.diary_keys,
            "phrase_alignment": self.phrase_alignment,
            "social_universe": self.social_universe,
        }

    def _persona_identity(self) -> dict[str, Any]:
        persona = getattr(self.memory, "persona", None)
        envelope = getattr(persona, "identity_envelope", None)
        if envelope is None or not envelope.verify():
            raise RuntimeError("Backup refused because the active persona identity is unavailable")
        return {
            "persona_id": envelope.persona_id,
            "fingerprint": envelope.fingerprint,
            "identity_version": envelope.version,
        }

    def _export_nonmemory_payload(self) -> dict[str, Any]:
        payload = {
            "schema": BACKUP_SCHEMA,
            "exported_at": datetime.now().isoformat(),
            "storage_policy": "local-first",
            "cloud_status": "寮€鍙戜腑",
            "persona_identity": self._persona_identity(),
            "emotion": self.emotion.to_dict(),
            "relationship": self.relationship.to_dict(),
            "user": self.user_manager.export_all(),
            "diary": self.diary.export_all(),
        }
        for section, manager in self._optional_managers().items():
            if manager is not None:
                payload[section] = manager.export_all()
        return payload

    def _stage_backup_file(self, path: Path) -> tuple[dict[str, Any], Path, int]:
        """Validate the complete outer JSON while spooling memory records."""

        descriptor, temporary_name = tempfile.mkstemp(prefix="reverie-memory-", suffix=".ndjson")
        stage_path = Path(temporary_name)
        payload: dict[str, Any] = {}
        memory_count = 0
        seen_keys: set[str] = set()
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as source, os.fdopen(
                descriptor, "w", encoding="utf-8", newline="\n"
            ) as staged:
                reader = _IncrementalJSONReader(source)
                reader.expect("{")
                if reader.peek() != "}":
                    while True:
                        key = reader.value()
                        if not isinstance(key, str):
                            raise ValueError("Backup JSON object key is not a string")
                        if key in seen_keys:
                            raise ValueError(f"Backup JSON contains duplicate section: {key}")
                        seen_keys.add(key)
                        reader.expect(":")
                        if key == "memory":
                            reader.expect("[")
                            if reader.peek() != "]":
                                while True:
                                    record = reader.value()
                                    if not isinstance(record, dict):
                                        raise ValueError("Backup memory section contains a non-object record")
                                    json.dump(record, staged, ensure_ascii=False, separators=(",", ":"))
                                    staged.write("\n")
                                    memory_count += 1
                                    separator = reader.peek()
                                    if separator == ",":
                                        reader.expect(",")
                                        continue
                                    if separator == "]":
                                        break
                                    raise ValueError("Malformed backup memory array")
                            reader.expect("]")
                            payload["memory"] = []
                        else:
                            payload[key] = reader.value()
                        separator = reader.peek()
                        if separator == ",":
                            reader.expect(",")
                            continue
                        if separator == "}":
                            break
                        raise ValueError("Malformed backup JSON object")
                reader.expect("}")
                reader.ensure_finished()
                staged.flush()
                os.fsync(staged.fileno())
            self._validate_payload(payload)
            if payload.get("schema") not in {BACKUP_SCHEMA, *LEGACY_BACKUP_SCHEMAS}:
                raise ValueError("Unsupported Reverie backup schema")
            return payload, stage_path, memory_count
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            stage_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _iter_staged_memory(path: Path):
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    value = json.loads(line)
                    if not isinstance(value, dict):
                        raise ValueError("Staged memory record is not an object")
                    yield value

    def _materialize_nonmemory_target(
        self,
        payload: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        target = deepcopy(snapshot)
        for section in (
            "emotion", "relationship", "user", "diary", "timeline",
            "social_circle", "interests", "affairs", "calendar",
            "ambient_presence", "thought_of_you", "diary_keys",
            "phrase_alignment", "social_universe",
        ):
            if section in payload:
                target[section] = deepcopy(payload[section])
        return target

    def _apply_nonmemory(self, payload: dict[str, Any]) -> dict[str, int]:
        emotion_data = payload.get("emotion")
        if isinstance(emotion_data, dict):
            self.emotion.restore(emotion_data)
        relationship_data = payload.get("relationship")
        if isinstance(relationship_data, dict):
            self.relationship.restore(relationship_data)
        user_data = payload.get("user")
        if isinstance(user_data, dict):
            self.user_manager.import_all(user_data)
        diary_imported = 0
        diary_data = payload.get("diary")
        if isinstance(diary_data, dict):
            diary_imported = self.diary.import_all(diary_data)
        result = {"diary": diary_imported}
        for section, manager in self._optional_managers().items():
            section_data = payload.get(section)
            if manager is not None and isinstance(section_data, dict):
                result[section] = int(manager.import_all(section_data))
        return result

    def _memory_restore_marker(self) -> str:
        catalog = getattr(getattr(self.memory, "store", None), "catalog", None)
        if catalog is not None and hasattr(catalog, "metadata_get"):
            return str(catalog.metadata_get("full_restore_marker") or "")
        return str(getattr(self.memory, "restore_marker", "") or "")

    def export_payload(self) -> dict[str, Any]:
        """Return a complete JSON-safe backup payload."""
        payload = {
            "schema": BACKUP_SCHEMA,
            "exported_at": datetime.now().isoformat(),
            "storage_policy": "local-first",
            "cloud_status": "开发中",
            "persona_identity": self._persona_identity(),
            "memory": self.memory.export_all(),
            "emotion": self.emotion.to_dict(),
            "relationship": self.relationship.to_dict(),
            "user": self.user_manager.export_all(),
            "diary": self.diary.export_all(),
        }
        for section, manager in self._optional_managers().items():
            if manager is not None:
                payload[section] = manager.export_all()
        return payload

    def import_payload(self, payload: dict[str, Any], *, replace_memory: bool = True) -> dict[str, int]:
        """Restore a full local backup payload.

        Returns counts for sections that have countable entries.
        """
        if payload.get("schema") not in {BACKUP_SCHEMA, *LEGACY_BACKUP_SCHEMAS}:
            raise ValueError("Unsupported Reverie backup schema")

        self._validate_payload(payload)
        snapshot = self._snapshot()
        target = self._materialize_target(payload, snapshot, replace_memory=replace_memory)
        if self.state_store is not None:
            self.state_store.prepare_restore(snapshot, target)

        try:
            result = self._apply_payload(target, replace_memory=True)
            if self.state_store is not None:
                self._durability_barrier()
                self.state_store.checkpoint(self._snapshot())
        except Exception as exc:
            try:
                if self.state_store is not None:
                    self.state_store.mark_rolling_back()
                self._restore_snapshot(snapshot)
                if self.state_store is not None:
                    self._durability_barrier()
                    self.state_store.checkpoint(snapshot)
            except Exception as rollback_exc:
                raise RuntimeError("备份导入失败，且自动回滚未能完整完成") from rollback_exc
            raise ValueError(f"备份导入失败，已恢复导入前状态：{exc}") from exc
        return result

    def _materialize_target(
        self,
        payload: dict[str, Any],
        snapshot: dict[str, Any],
        *,
        replace_memory: bool,
    ) -> dict[str, Any]:
        """Expand partial and legacy imports into one complete target state."""
        target = deepcopy(snapshot)
        for section in (
            "emotion",
            "relationship",
            "user",
            "diary",
            "timeline",
            "social_circle",
            "interests",
            "affairs",
            "calendar",
            "ambient_presence",
            "thought_of_you",
            "diary_keys",
            "phrase_alignment",
            "social_universe",
        ):
            if section in payload:
                target[section] = deepcopy(payload[section])

        incoming_memory = deepcopy(payload.get("memory", []))
        if replace_memory:
            target["memory"] = incoming_memory
        else:
            combined = [*deepcopy(snapshot.get("memory", [])), *incoming_memory]
            unique: dict[str, Any] = {}
            for index, item in enumerate(combined):
                if isinstance(item, dict):
                    key = str(item.get("id") or item.get("memory_id") or "")
                    if not key:
                        key = json.dumps(item, ensure_ascii=False, sort_keys=True)
                else:
                    key = f"value:{index}:{item!r}"
                unique[key] = item
            target["memory"] = list(unique.values())
        return target

    def checkpoint(self) -> None:
        """Commit the current complete world snapshot to SQLite."""
        if self.state_store is not None:
            streaming = hasattr(self.memory, "import_stream")
            snapshot = self._snapshot(include_memory=not streaming)
            if streaming:
                snapshot["_memory_restore_marker"] = self._memory_restore_marker()
            self.state_store.checkpoint(snapshot)

    def recover_interrupted_restore(self) -> bool:
        """Finish an interrupted import before background subsystems start."""
        if self.state_store is None:
            return False
        pending = self.state_store.pending_restore()
        if pending is None:
            return False
        if "_memory_restore_marker" in pending.after:
            marker = self._memory_restore_marker()
            target = (
                pending.after
                if marker == str(pending.after.get("_memory_restore_marker", ""))
                else pending.before
            )
            self._apply_nonmemory(target)
            self._durability_barrier()
            self.state_store.checkpoint(target)
            return True
        target = pending.after if pending.phase == "applying" else pending.before
        self._apply_payload(target, replace_memory=True)
        self._durability_barrier()
        self.state_store.checkpoint(self._snapshot())
        return True

    def _durability_barrier(self) -> None:
        """Flush restored manager files before the SQLite intent is cleared."""
        if self.state_store is None:
            return
        try:
            store_parent = self.state_store.path.parent.resolve()
            data_root = DATA_DIR.resolve()
        except OSError:
            store_parent = self.state_store.path.parent
            data_root = DATA_DIR

        roots = (
            MEMORY_DIR,
            EMOTION_DIR,
            RELATIONSHIP_DIR,
            USER_DIR,
            DIARY_DIR,
            TIMELINE_DIR,
            SOCIAL_DIR,
            INTEREST_DIR,
            AFFAIRS_DIR,
            WORLD_DIR,
        ) if store_parent == data_root else (store_parent,)
        sqlite_files = {
            self.state_store.path.resolve(),
            Path(f"{self.state_store.path}-journal").resolve(),
            Path(f"{self.state_store.path}-wal").resolve(),
            Path(f"{self.state_store.path}-shm").resolve(),
        }
        parent_dirs: set[Path] = set()
        for root in roots:
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                try:
                    resolved = path.resolve()
                    if resolved in sqlite_files:
                        continue
                    with path.open("rb") as stream:
                        os.fsync(stream.fileno())
                    parent_dirs.add(path.parent)
                except FileNotFoundError:
                    continue
                except OSError as exc:
                    raise RuntimeError(f"Unable to flush restored state file: {path}") from exc

        if os.name != "nt":
            for directory in sorted(parent_dirs, key=lambda item: len(item.parts), reverse=True):
                descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)

    def _apply_payload(self, payload: dict[str, Any], *, replace_memory: bool) -> dict[str, int]:
        """Apply an already validated payload."""

        memory_items = payload.get("memory")
        memory_imported = 0
        if isinstance(memory_items, list):
            memory_imported = self.memory.import_all(memory_items, replace=replace_memory)

        emotion_data = payload.get("emotion")
        if isinstance(emotion_data, dict):
            self.emotion.restore(emotion_data)

        relationship_data = payload.get("relationship")
        if isinstance(relationship_data, dict):
            self.relationship.restore(relationship_data)

        user_data = payload.get("user")
        if isinstance(user_data, dict):
            self.user_manager.import_all(user_data)
            if hasattr(self.memory, "sync_user_profile"):
                self.memory.sync_user_profile(self.user_manager)

        diary_imported = 0
        diary_data = payload.get("diary")
        if isinstance(diary_data, dict):
            diary_imported = self.diary.import_all(diary_data)

        result = {
            "memory": memory_imported,
            "diary": diary_imported,
        }
        for section, manager in self._optional_managers().items():
            section_data = payload.get(section)
            if manager is not None and isinstance(section_data, dict):
                result[section] = int(manager.import_all(section_data))
        return result

    def _validate_payload(self, payload: dict[str, Any]) -> None:
        expected = {
            "memory": list,
            "emotion": dict,
            "relationship": dict,
            "user": dict,
            "diary": dict,
            "timeline": dict,
            "social_circle": dict,
            "interests": dict,
            "affairs": dict,
            "calendar": dict,
            "ambient_presence": dict,
            "thought_of_you": dict,
            "diary_keys": dict,
            "phrase_alignment": dict,
            "social_universe": dict,
            "persona_identity": dict,
        }
        for section, expected_type in expected.items():
            if section in payload and not isinstance(payload[section], expected_type):
                raise ValueError(f"备份分区 {section} 格式无效")
        for required in ("memory", "emotion", "relationship", "user", "diary"):
            if required not in payload:
                raise ValueError(f"备份缺少必要分区：{required}")
        identity = payload.get("persona_identity")
        if not isinstance(identity, dict):
            raise ValueError("备份缺少人格身份封印，不能安全归属到当前角色")
        active = self._persona_identity()
        if (
            str(identity.get("persona_id") or "") != active["persona_id"]
            or str(identity.get("fingerprint") or "") != active["fingerprint"]
            or int(identity.get("identity_version") or 0) != active["identity_version"]
        ):
            raise ValueError("备份属于另一个人格或身份版本，已拒绝跨人格恢复")

    def _snapshot(self, *, include_memory: bool = True) -> dict[str, Any]:
        snapshot = {
            "emotion": self.emotion.to_dict(),
            "relationship": self.relationship.to_dict(),
            "user": self.user_manager.export_all(),
            "diary": self.diary.export_all(),
        }
        if include_memory:
            snapshot["memory"] = self.memory.export_all()
        for section, manager in self._optional_managers().items():
            if manager is not None:
                snapshot[section] = manager.export_all()
        return snapshot

    def _restore_snapshot(self, snapshot: dict[str, Any]) -> None:
        self.memory.import_all(snapshot["memory"], replace=True)
        self.emotion.restore(snapshot["emotion"])
        self.relationship.restore(snapshot["relationship"])
        self.user_manager.import_all(snapshot["user"])
        self.diary.import_all(snapshot["diary"])
        for section, manager in self._optional_managers().items():
            if manager is not None and section in snapshot:
                manager.import_all(snapshot[section])
        if hasattr(self.memory, "sync_user_profile"):
            self.memory.sync_user_profile(self.user_manager)

    def backup_to_file(self, path: Path) -> None:
        """Write a complete local backup file."""
        if not hasattr(self.memory, "iter_export_pages"):
            atomic_write_json(path, self.export_payload())
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        payload = self._export_nonmemory_payload()
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as stream:
                stream.write("{\n")
                first_section = True
                for key, value in payload.items():
                    if not first_section:
                        stream.write(",\n")
                    json.dump(str(key), stream, ensure_ascii=False)
                    stream.write(": ")
                    json.dump(value, stream, ensure_ascii=False, indent=2)
                    first_section = False
                if not first_section:
                    stream.write(",\n")
                stream.write('\"memory\": [\n')
                first_memory = True
                for page in self.memory.iter_export_pages():
                    for record in page:
                        if not first_memory:
                            stream.write(",\n")
                        json.dump(record, stream, ensure_ascii=False, separators=(",", ":"))
                        first_memory = False
                stream.write("\n]\n}\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def restore_from_file(self, path: Path, *, replace_memory: bool = True) -> dict[str, int]:
        """Restore a complete local backup file."""
        if not path.exists():
            raise FileNotFoundError(f"Backup not found: {path}")
        payload, staged_memory, _count = self._stage_backup_file(path)
        try:
            if not hasattr(self.memory, "import_stream"):
                payload["memory"] = list(self._iter_staged_memory(staged_memory))
                return self.import_payload(payload, replace_memory=replace_memory)
            return self._restore_staged_payload(
                payload,
                staged_memory,
                replace_memory=replace_memory,
            )
        finally:
            staged_memory.unlink(missing_ok=True)

    def _restore_staged_payload(
        self,
        payload: dict[str, Any],
        staged_memory: Path,
        *,
        replace_memory: bool,
    ) -> dict[str, int]:
        """Restore a validated stream with a crash-recoverable commit marker.

        Non-memory managers still persist to their own local files.  The marker
        written in the same SQLite transaction as the memory rows lets startup
        recovery determine whether those files must move forward or roll back
        after a process or power failure at the commit boundary.
        """

        before = self._snapshot(include_memory=False)
        target = self._materialize_nonmemory_target(payload, before)
        previous_marker = self._memory_restore_marker()
        restore_marker = uuid.uuid4().hex
        before["_memory_restore_marker"] = previous_marker
        target["_memory_restore_marker"] = restore_marker

        if self.state_store is not None:
            self.state_store.prepare_restore(before, target)

        nonmemory_result: dict[str, int] = {}

        def commit_nonmemory() -> None:
            nonlocal nonmemory_result
            nonmemory_result = self._apply_nonmemory(target)
            if self.state_store is not None:
                self._durability_barrier()

        try:
            memory_imported = self.memory.import_stream(
                self._iter_staged_memory(staged_memory),
                replace=replace_memory,
                before_commit=commit_nonmemory,
                restore_marker=restore_marker,
            )
        except Exception as exc:
            try:
                if self.state_store is not None:
                    self.state_store.mark_rolling_back()
                self._apply_nonmemory(before)
                if self.state_store is not None:
                    self._durability_barrier()
                    self.state_store.checkpoint(before)
            except Exception as rollback_exc:
                raise RuntimeError(
                    "Backup restore failed and the pre-restore local state "
                    "could not be fully reinstated"
                ) from rollback_exc
            raise ValueError(
                f"Backup restore failed; pre-restore local state was reinstated: {exc}"
            ) from exc

        # These are derivatives/finalization only: canonical memory and the
        # non-memory target have already crossed the durable commit boundary.
        if hasattr(self.memory, "sync_user_profile"):
            try:
                self.memory.sync_user_profile(self.user_manager)
            except Exception:
                logger.exception("Restore committed but user-memory projection refresh failed")
        if self.state_store is not None:
            self.state_store.checkpoint(target)

        return {"memory": int(memory_imported), **nonmemory_result}
