"""Complete local backup with encrypted, persona-bound restore recovery."""
from __future__ import annotations

from contextlib import closing
from copy import deepcopy
from datetime import datetime
from dataclasses import dataclass
import hashlib
import io
import json
import logging
import math
import os
from pathlib import Path
import threading
from typing import Any, Callable
import uuid

from .backup_inspection import (
    BACKUP_SCHEMA, LEGACY_BACKUP_SCHEMAS, MAX_BACKUP_FILE_BYTES,
    BackupInspection, BackupRestoreError, _HashingReader,
    _IncrementalJSONReader, inspect_backup_file, is_unconfirmed_export,
)
from .local_store import atomic_write_json
from .storage.encrypted_sqlite import connect_database
from .world_state_store import RestoreIntent, WorldStateStore
from .backup_validation import validate_sql_participant

_MAX_BACKUP_FILE_BYTES = MAX_BACKUP_FILE_BYTES
logger = logging.getLogger("reverie.backup")


@dataclass(frozen=True)
class PreparedBackup:
    operation_id: str
    payload: dict[str, Any]
    memory_count: int
    inspection: BackupInspection


def canonical_digest(payload: dict[str, Any]) -> str:
    """Digest an exact captured state; callers choose any normalization."""
    text = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class LocalBackupManager:
    def __init__(self, *, memory, emotion, relationship, diary, user_manager,
                 timeline=None, social_circle=None, interest_tracker=None,
                 affair_manager=None, world_clock=None, state_store: WorldStateStore | None = None,
                 ambient_presence=None, thought_engine=None, diary_keys=None,
                 phrase_alignment=None, social_universe=None,
                 fault_hook: Callable[[str], None] | None = None) -> None:
        self.memory, self.emotion, self.relationship = memory, emotion, relationship
        self.diary, self.user_manager = diary, user_manager
        self.timeline, self.social_circle = timeline, social_circle
        self.interest_tracker, self.affair_manager = interest_tracker, affair_manager
        self.world_clock, self.state_store = world_clock, state_store
        self.ambient_presence, self.thought_engine = ambient_presence, thought_engine
        self.diary_keys, self.phrase_alignment = diary_keys, phrase_alignment
        self.social_universe = social_universe
        self._owner_thread = threading.get_ident()
        self._fault_hook = fault_hook
        self._recovery_state, self._recovery_reason = "clean", ""
        self._operation_id: str | None = None
        if state_store is not None:
            if fault_hook is not None:
                state_store._fault_hook = fault_hook
            try:
                state_store.bind_identity(self._persona_identity())
                pending = state_store.pending_restore()
                if pending is not None:
                    self._recovery_state = "recovering"
                    self._operation_id = pending.operation_id
            except Exception as exc:
                self._lock_recovery(str(exc))

    def _assert_owner(self) -> None:
        if threading.get_ident() != self._owner_thread:
            raise RuntimeError("Complete restore must run on the manager owner thread")

    def _fault(self, name: str) -> None:
        if self._fault_hook is not None:
            self._fault_hook(name)

    @property
    def recovery_state(self) -> str:
        return self._recovery_state

    def recovery_status(self) -> dict[str, Any]:
        return {"state": self._recovery_state, "reason": self._recovery_reason,
                "operation_id": self._operation_id}

    def _lock_recovery(self, reason: str) -> None:
        self._recovery_state, self._recovery_reason = "recovery_required", reason

    def _clean(self) -> None:
        self._recovery_state, self._recovery_reason, self._operation_id = "clean", "", None

    def _optional_managers(self) -> dict[str, Any]:
        return {"timeline": self.timeline, "social_circle": self.social_circle,
                "interests": self.interest_tracker, "affairs": self.affair_manager,
                "calendar": self.world_clock, "ambient_presence": self.ambient_presence,
                "thought_of_you": self.thought_engine, "diary_keys": self.diary_keys,
                "phrase_alignment": self.phrase_alignment, "social_universe": self.social_universe}

    def _persona_identity(self) -> dict[str, Any]:
        persona = getattr(self.memory, "persona", None)
        envelope = getattr(persona, "identity_envelope", None)
        if envelope is None or not envelope.verify():
            raise RuntimeError("Backup refused because the active persona identity is unavailable")
        return {"persona_id": envelope.persona_id, "fingerprint": envelope.fingerprint,
                "identity_version": envelope.version}

    def _export_nonmemory_payload(self) -> dict[str, Any]:
        payload = {"schema": BACKUP_SCHEMA, "exported_at": datetime.now().isoformat(),
                   "storage_policy": "local-first", "cloud_status": "开发中",
                   "persona_identity": self._persona_identity(),
                   "emotion": self.emotion.to_dict(), "relationship": self.relationship.to_dict(),
                   "user": self.user_manager.export_all(), "diary": self.diary.export_all()}
        for section, manager in self._optional_managers().items():
            if manager is not None:
                payload[section] = manager.export_all()
        if self._recovery_state != "clean":
            return {"export_state": {"consistency": "unconfirmed", "reason": "restore_terminal_unconfirmed"}, **payload}
        return payload

    def export_payload(self) -> dict[str, Any]:
        # Preserve the established normal v3 field layout exactly.
        nonmemory = self._export_nonmemory_payload()
        payload: dict[str, Any] = {}
        for key, value in nonmemory.items():
            payload[key] = value
            if key == "persona_identity":
                payload["memory"] = self.memory.export_all()
        return payload

    def _snapshot(self, *, include_memory: bool = True) -> dict[str, Any]:
        emotion_state = getattr(self.emotion,"_state_payload",None)
        diary_export = getattr(self.diary,"export_for_restore",self.diary.export_all)
        snapshot = {"emotion": emotion_state() if emotion_state is not None else self.emotion.to_dict(), "relationship": self.relationship.to_dict(),
                    "user": self.user_manager.export_all(), "diary": diary_export()}
        if include_memory:
            snapshot["memory"] = self.memory.export_all()
        for section, manager in self._optional_managers().items():
            if manager is not None:
                snapshot[section] = manager.export_all()
        return snapshot

    def _validate_payload(self, payload: dict[str, Any]) -> None:
        try:
            self._validate_payload_unchecked(payload)
        except BackupRestoreError:
            raise
        except (ValueError,TypeError,KeyError) as exc:
            raise BackupRestoreError("Backup contains an invalid format or record",code="BACKUP_INVALID_FORMAT") from exc

    def _validate_payload_unchecked(self, payload: dict[str, Any]) -> None:
        if is_unconfirmed_export(payload.get("export_state")):
            raise BackupRestoreError("This export has an unconfirmed restore state", code="BACKUP_UNCONFIRMED_EXPORT")
        if payload.get("schema") not in {BACKUP_SCHEMA, *LEGACY_BACKUP_SCHEMAS}:
            raise ValueError("Unsupported Reverie backup schema")
        for required in ("memory", "emotion", "relationship", "user", "diary"):
            if required not in payload:
                raise ValueError(f"备份缺少必要分区：{required}")
        for section in ("emotion", "relationship", "user", "diary", "persona_identity", *self._optional_managers()):
            if section in payload and not isinstance(payload[section], dict):
                raise ValueError(f"备份分区 {section} 格式无效")
        if not isinstance(payload.get("memory"), list):
            raise ValueError("备份分区 memory 格式无效")
        if payload.get("persona_identity") != self._persona_identity():
            raise BackupRestoreError("备份属于另一个人格或身份版本，已拒绝跨人格恢复",code="BACKUP_PERSONA_MISMATCH")
        for section, manager in self._optional_managers().items():
            if section in payload and manager is None:
                raise BackupRestoreError(f"Restore participant {section} is unavailable", code="BACKUP_PARTICIPANT_UNAVAILABLE")
        array_sections = {"user":("emotional_memories",),"diary":("entries","missed"),
            "timeline":("posts","events"),"social_circle":("contacts","events"),
            "interests":("interests",),"affairs":("affairs",),
            "ambient_presence":("runtime","traces","emotion_days"),
            "thought_of_you":("items",),"diary_keys":("unlocks",),
            "phrase_alignment":("stats","usage")}
        for section, names in array_sections.items():
            if section not in payload:
                continue
            for name in names:
                rows = payload[section].get(name,[])
                if not isinstance(rows,list) or (name != "missed" and any(not isinstance(row,dict) for row in rows)):
                    raise ValueError(f"Invalid backup records: {section}.{name}")
        if not isinstance(payload["user"].get("profile",{}),dict):
            raise ValueError("Invalid user profile")
        for name in ("values","emotions","baseline"):
            values = payload["emotion"].get(name)
            if values is not None:
                if not isinstance(values,dict) or any(not math.isfinite(float(value)) or not 0 <= float(value) <= 100 for value in values.values()):
                    raise ValueError("Invalid emotion values")
        for name in ("intimacy","interaction_count","positive_interactions","negative_interactions"):
            if name in payload["relationship"] and int(payload["relationship"][name]) < 0:
                raise ValueError("Invalid relationship counters")
        from .diary import DiaryManager
        dates: set[str] = set()
        for row in payload["diary"].get("entries",[]):
            date = DiaryManager._valid_restore_date(row.get("date",""))
            if date in dates:
                raise ValueError("Diary restore contains duplicate dates")
            dates.add(date)
        for date in payload["diary"].get("missed",[]):
            DiaryManager._valid_restore_date(date)
        highlights = payload["diary"].get("external_highlights",{})
        if not isinstance(highlights,dict):
            raise ValueError("Invalid diary highlights")
        for date,values in highlights.items():
            DiaryManager._valid_restore_date(date)
            if not isinstance(values,list):
                raise ValueError("Invalid diary highlights")
        for name in ("privacy_enabled","peek_enabled"):
            if name in payload["diary"] and not isinstance(payload["diary"][name],bool):
                raise ValueError("Invalid diary preferences")
        if "calendar" in payload and not isinstance(payload["calendar"].get("years"),dict):
            raise ValueError("Invalid calendar backup")
        if "diary_keys" in payload and payload["diary_keys"].get("state") is not None and not isinstance(payload["diary_keys"]["state"],dict):
            raise ValueError("Invalid diary-key state")
        if "social_universe" in payload:
            tables = payload["social_universe"].get("tables")
            if not isinstance(tables,dict) or any(not isinstance(rows,list) or any(not isinstance(row,dict) for row in rows) for rows in tables.values()):
                raise ValueError("Invalid social-universe tables")
        schemas = {"ambient_presence":"reverie.ambient_presence.v1", "thought_of_you":"reverie.thought_of_you.v1",
                   "diary_keys":"reverie.diary_keys.v1", "phrase_alignment":"reverie.user_phrase_alignment.v1",
                   "social_universe":"reverie.social_universe.v1"}
        for section,schema in schemas.items():
            if section in payload and payload[section].get("schema") != schema:
                raise ValueError(f"Invalid {section} backup schema")
        if "calendar" in payload:
            from .world.clock import _sanitize_calendar_payload
            normalized = _sanitize_calendar_payload(payload["calendar"])
            if not self._semantic_matches(payload["calendar"],normalized,("calendar",)):
                raise ValueError("Calendar records would be lost or changed during restore")
        if "thought_of_you" in payload and self.thought_engine is not None:
            path = getattr(getattr(self.thought_engine,"_db",None),"path",None)
            if path is not None:
                validate_sql_participant(path,{"ambient_web_thoughts":payload["thought_of_you"].get("items",[])})
        if "social_universe" in payload and self.social_universe is not None:
            path = getattr(self.social_universe,"path",None)
            order = ("social_universe_characters","social_group_threads","social_group_members",
                     "social_group_messages","social_timeline_comments","social_backchannel_events")
            tables = payload["social_universe"]["tables"]
            if set(tables) - set(order):
                raise ValueError("Unknown social-universe backup table")
            if path is not None:
                validate_sql_participant(path,{table:tables.get(table,[]) for table in order})

    def _materialize_nonmemory_target(self, payload: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
        target = deepcopy(snapshot)
        for section in ("emotion", "relationship", "user", "diary", *self._optional_managers()):
            if section in payload:
                target[section] = deepcopy(payload[section])
        # Normalize documented model defaults before applying any participant.
        # Old v3 exports may omit fields now present in those models.
        if "emotion" in payload:
            emotion = deepcopy(snapshot["emotion"])
            # enabled, carryover_days and inertia_factor are global settings; an
            # older backup's copies stay readable but the current ones are kept.
            for key in ("last_updated",):
                if key in payload["emotion"]:
                    emotion[key] = deepcopy(payload["emotion"][key])
            for key in ("values","baseline"):
                values = payload["emotion"].get(key)
                if key == "values" and values is None:
                    values = payload["emotion"].get("emotions")
                if isinstance(values,dict):
                    emotion.setdefault(key,{}).update({name: float(value) for name,value in values.items()})
            target["emotion"] = emotion
        if "relationship" in payload:
            relationship = deepcopy(snapshot["relationship"])
            relationship.update(deepcopy(payload["relationship"]))
            if isinstance(relationship.get("recent_fingerprints"),list):
                relationship["recent_fingerprints"] = [
                    {"hash": str(item.get("hash","")), "at": str(item.get("at",""))}
                    for item in relationship["recent_fingerprints"][-8:]
                    if isinstance(item,dict) and item.get("hash")]
            target["relationship"] = relationship
        if "user" in payload and hasattr(self.user_manager,"profile"):
            from .user import UserProfile, EmotionalMemory
            user = payload["user"]
            target["user"] = {"profile": UserProfile.from_dict(user.get("profile",{})).to_dict(),
                              "emotional_memories": [EmotionalMemory.from_dict(item).to_dict()
                                  for item in user.get("emotional_memories",[]) if isinstance(item,dict)]}
        if "diary" in payload and hasattr(self.diary,"diary_dir"):
            from .diary import DiaryEntry
            diary = deepcopy(payload["diary"])
            entries = diary.get("entries",[])
            if not isinstance(entries,list) or any(not isinstance(item,dict) for item in entries):
                raise ValueError("Diary restore entries are invalid")
            diary["entries"] = sorted([DiaryEntry.from_dict(item).to_dict() for item in entries],key=lambda item:item["date"])
            diary.setdefault("missed",[])
            diary.setdefault("external_highlights",{})
            diary.setdefault("privacy_enabled",True)
            diary.setdefault("peek_enabled",True)
            target["diary"] = diary
        return target

    @staticmethod
    def _semantic_matches(expected: Any, actual: Any, path: tuple[str,...] = ()) -> bool:
        ignored = {("emotion","dominant"),("emotion","mood"),("emotion","intensity"),
                   ("relationship","stage"),("relationship","stage_key"),("timeline","updated")}
        if path in ignored:
            return True
        if isinstance(expected,dict):
            return isinstance(actual,dict) and all(key in actual and LocalBackupManager._semantic_matches(value,actual[key],(*path,str(key)))
                                                   for key,value in expected.items())
        if isinstance(expected,list):
            return isinstance(actual,list) and len(actual) == len(expected) and all(
                LocalBackupManager._semantic_matches(left,right,(*path,str(index)))
                for index,(left,right) in enumerate(zip(expected,actual)))
        return expected == actual

    def _verify_nonmemory(self, expected: dict[str, Any]) -> None:
        actual = self._snapshot(include_memory=False)
        for section in ("emotion","relationship","user","diary",*self._optional_managers()):
            if section in expected and not self._semantic_matches(expected[section],actual.get(section),(section,)):
                raise BackupRestoreError(f"Restored participant {section} differs from the intended state",code="BACKUP_RECOVERY_REQUIRED")
        # Read durable documents independently of the in-memory managers.
        for manager, documents in (
            (self.emotion,{"persona_emotion_state":actual["emotion"]}),
            (self.relationship,{"persona_relationship_state":actual["relationship"]}),
            (self.user_manager,{"user_profile":actual["user"].get("profile",{}),
                "user_emotional_memories":{"memories":actual["user"].get("emotional_memories",[])}})):
            store = getattr(manager,"document_store",None)
            if store is not None and hasattr(store,"path"):
                with closing(connect_database(store.path,timeout=5.0,isolation_level=None,read_only=True)) as connection:
                    connection.execute("PRAGMA query_only=ON")
                    persona_id = getattr(manager, "persona_id", None)
                    for name,value in documents.items():
                        if persona_id is None:
                            row = connection.execute("SELECT payload_json FROM private_documents WHERE document_name=?",(name,)).fetchone()
                            stored = json.loads(str(row[0])) if row is not None else None
                        else:
                            stored = store.read_persisted_persona_state_document(connection, persona_id, name)
                        if stored != value:
                            raise BackupRestoreError(f"Durable document {name} was not restored",code="BACKUP_RECOVERY_REQUIRED")
            elif manager in (self.emotion,self.relationship):
                path = getattr(manager,"state_path",None)
                if path is not None:
                    value = json.loads(Path(path).read_text(encoding="utf-8"))
                    section = "emotion" if manager is self.emotion else "relationship"
                    if not self._semantic_matches(actual[section],value,(section,)):
                        raise BackupRestoreError(f"Durable participant {section} was not restored",code="BACKUP_RECOVERY_REQUIRED")
        # JSON optional participants export from RAM; confirm their durable
        # replacement as well. SQLite participants' exports already read SQL.
        for section,manager in self._optional_managers().items():
            if manager is None:
                continue
            location = getattr(manager,"calendar_path",None) if section == "calendar" else getattr(manager,"path",None)
            if location is not None and Path(location).suffix == ".json":
                value = json.loads(Path(location).read_text(encoding="utf-8"))
                if not self._semantic_matches(actual[section],value,(section,)):
                    raise BackupRestoreError(f"Durable participant {section} was not restored",code="BACKUP_RECOVERY_REQUIRED")

    @staticmethod
    def _replace(manager, payload: dict[str, Any]):
        replacement = getattr(manager, "replace_all", None)
        return replacement(payload) if replacement is not None else manager.import_all(payload)

    def _apply_nonmemory(self, payload: dict[str, Any]) -> dict[str, int]:
        for section in ("emotion", "relationship", "user", "diary"):
            if not isinstance(payload.get(section), dict):
                raise BackupRestoreError(f"Recovery participant {section} is missing", code="BACKUP_RECOVERY_REQUIRED")
        # A disabled optional subsystem must never silently drop restored data.
        for section, manager in self._optional_managers().items():
            if section in payload and manager is None:
                raise BackupRestoreError(f"Recovery participant {section} is unavailable", code="BACKUP_PARTICIPANT_UNAVAILABLE")
        self.emotion.restore(deepcopy(payload["emotion"]))
        self.relationship.restore(deepcopy(payload["relationship"]))
        self._replace(self.user_manager, deepcopy(payload["user"]))
        result = {"diary": int(self._replace(self.diary, deepcopy(payload["diary"])) or 0)}
        for section, manager in self._optional_managers().items():
            if manager is not None:
                if section not in payload:
                    raise BackupRestoreError(f"Recovery participant {section} is missing", code="BACKUP_RECOVERY_REQUIRED")
                result[section] = int(self._replace(manager, deepcopy(payload[section])) or 0)
        return result

    def _memory_restore_marker(self) -> str:
        catalog = getattr(getattr(self.memory, "store", None), "catalog", None)
        if catalog is None or not hasattr(catalog, "path"):
            raise BackupRestoreError("The canonical memory store is unavailable", code="BACKUP_RECOVERY_REQUIRED")
        # Never trust the existing writer connection after an exceptional
        # COMMIT. SQLCipher mode=ro does not migrate or replay write journals.
        with closing(connect_database(catalog.path, timeout=5.0, isolation_level=None, read_only=True)) as connection:
            connection.execute("PRAGMA query_only=ON")
            row = connection.execute("SELECT value FROM memory_system_metadata WHERE key='full_restore_marker'").fetchone()
        return str(row[0]) if row is not None else ""

    def _probe(self, intent: RestoreIntent) -> str:
        try:
            self._fault("before_readonly_probe")
            marker = self._memory_restore_marker()
            outcome = intent.classify_marker(marker)
            self._fault("after_readonly_probe")
            return outcome
        except Exception:
            return "unknown"

    def _finalize(self, intent: RestoreIntent, outcome: str) -> None:
        target = intent.after if outcome == "after" else intent.before
        assert self.state_store is not None
        self._verify_nonmemory(target)
        self._durability_barrier()
        # This fault is deliberately outside the finalize exception settlement:
        # it models a failure before any finalization transaction starts.
        self._fault("before_finalize")
        try:
            self.state_store.finalize_restore(intent.operation_id, intent.intent_version,
                                              outcome=outcome, payload=target)
        except Exception:
            self._fault("before_finalize_confirmation")
            if not self.state_store.confirm_finalized(intent.operation_id,intent.intent_version,
                                                       outcome=outcome,payload=target):
                raise
            self._fault("after_finalize_confirmation")
        self._clean()

    def _settle(self, intent: RestoreIntent, *, allow_unconfirmed_before: bool = False) -> tuple[str, dict[str, int]]:
        outcome = self._probe(intent)
        if outcome == "unknown":
            self._lock_recovery("The memory commit marker could not confirm a recovery direction")
            raise BackupRestoreError(self._recovery_reason, code="BACKUP_RECOVERY_REQUIRED")
        unconfirmed_before = outcome == "before" and intent.before.get("_restore_before_confirmed") is False
        if unconfirmed_before and not allow_unconfirmed_before:
            # A failed rescue's before state has no established authority.
            # Startup must stay readonly, without replaying participant writes.
            self._lock_recovery("The rescue before state is unconfirmed; explicit rescue is still required")
            raise BackupRestoreError(self._recovery_reason, code="BACKUP_RECOVERY_REQUIRED")
        target = intent.after if outcome == "after" else intent.before
        result = self._apply_nonmemory(target)
        self._durability_barrier()
        if unconfirmed_before:
            self._lock_recovery("Rescue rolled back to an unconfirmed state; explicit rescue is still required")
            raise BackupRestoreError(self._recovery_reason, code="BACKUP_RECOVERY_REQUIRED")
        self._finalize(intent,outcome)
        return outcome,result

    def checkpoint(self) -> None:
        self._assert_owner()
        if self.state_store is None:
            return
        if self._recovery_state != "clean":
            raise BackupRestoreError("Checkpoint refused while recovery is pending", code="BACKUP_RECOVERY_REQUIRED")
        snapshot = self._snapshot(include_memory=False)
        snapshot["_memory_restore_marker"] = self._memory_restore_marker()
        self.state_store.checkpoint(snapshot)

    def recover_interrupted_restore(self) -> bool:
        self._assert_owner()
        if self.state_store is None:
            return False
        try:
            intent = self.state_store.pending_restore()
            if intent is None:
                if self._recovery_state == "recovering":
                    self._clean()
                return False
            if intent.persona_identity != self._persona_identity():
                raise BackupRestoreError("Recovery belongs to another persona", code="BACKUP_RECOVERY_REQUIRED")
            self._recovery_state, self._operation_id = "recovering", intent.operation_id
            self._settle(intent)
            return True
        except Exception as exc:
            self._lock_recovery(str(exc))
            return False

    def _require_restore(self, *, rescue: bool) -> None:
        self._assert_owner()
        if self.state_store is None or not hasattr(self.memory, "import_stream"):
            raise BackupRestoreError("Complete restore requires an encrypted recovery journal and canonical memory store", code="BACKUP_RECOVERY_UNAVAILABLE")
        self.state_store.bind_identity(self._persona_identity())
        try:
            pending = self.state_store.pending_restore()
        except Exception as exc:
            self._lock_recovery(str(exc))
            if not rescue:
                raise BackupRestoreError(self._recovery_reason, code="BACKUP_RECOVERY_REQUIRED") from exc
            pending = None
        if not rescue and (pending is not None or self._recovery_state != "clean"):
            raise BackupRestoreError("Recovery must be completed or explicitly rescued first", code="BACKUP_RECOVERY_REQUIRED")

    def _require_complete_target(self, sections, *, rescue: bool, replace_memory: bool) -> None:
        if replace_memory is not True:
            raise BackupRestoreError("Complete restore requires full memory replacement",code="BACKUP_INVALID_FORMAT")
        if rescue:
            missing = [section for section,manager in self._optional_managers().items()
                       if manager is not None and section not in sections]
            if missing:
                raise BackupRestoreError("Rescue backup must include every mounted participant",code="BACKUP_INVALID_FORMAT")

    def _stage_backup_file(self, path: Path, inspection: BackupInspection) -> tuple[dict[str, Any], str, int]:
        """Spool records directly into SQLCipher, with no plaintext second source."""
        assert self.state_store is not None
        operation_id = uuid.uuid4().hex
        payload: dict[str, Any] = {}

        def records():
            seen: set[str] = set()
            with path.open("rb") as source:
                hashing = _HashingReader(source)
                with io.TextIOWrapper(io.BufferedReader(hashing), encoding="utf-8-sig", newline="") as stream:
                    reader = _IncrementalJSONReader(stream)
                    reader.expect("{")
                    if reader.peek() != "}":
                        while True:
                            key = reader.value()
                            if not isinstance(key,str) or key in seen:
                                raise ValueError("Backup JSON contains an invalid or duplicate section")
                            seen.add(key)
                            reader.expect(":")
                            if key == "memory":
                                reader.expect("[")
                                if reader.peek() != "]":
                                    while True:
                                        row = reader.value()
                                        if not isinstance(row,dict):
                                            raise ValueError("Backup memory contains a non-object record")
                                        yield row
                                        if reader.peek() != ",":
                                            break
                                        reader.expect(",")
                                reader.expect("]")
                                payload["memory"] = []
                            else:
                                payload[key] = reader.value()
                            if reader.peek() != ",":
                                break
                            reader.expect(",")
                    reader.expect("}")
                    reader.ensure_finished()
            self._validate_payload(payload)
            if hashing.digest.hexdigest() != inspection.sha256 or hashing.file_bytes != inspection.file_bytes:
                raise BackupRestoreError("Backup bytes changed after inspection", code="BACKUP_FILE_CHANGED")

        count = self.state_store.stage_memory(operation_id,records())
        return payload,operation_id,count

    def restore_from_file(self, path: Path, *, replace_memory: bool = True, rescue: bool = False,
                          expected_sha256: str | None = None,
                          expected_file_bytes: int | None = None) -> dict[str, Any]:
        prepared = self.prepare_file(path,rescue=rescue,replace_memory=replace_memory,expected_sha256=expected_sha256,
                                     expected_file_bytes=expected_file_bytes)
        try:
            return self.restore_prepared(prepared,replace_memory=replace_memory,rescue=rescue)
        finally:
            self.discard_prepared(prepared)

    def prepare_file(self, path: Path, *, rescue: bool = False, replace_memory: bool = True,
                     expected_sha256: str | None = None,
                     expected_file_bytes: int | None = None) -> PreparedBackup:
        # This scan is deliberately before staging, manager capture, or journal
        # writes. It detects an unconfirmed marker after arbitrarily large data.
        inspection = inspect_backup_file(Path(path))
        self._require_complete_target(inspection.sections,rescue=rescue,replace_memory=replace_memory)
        if ((expected_sha256 is not None and inspection.sha256 != expected_sha256)
                or (expected_file_bytes is not None and inspection.file_bytes != expected_file_bytes)):
            raise BackupRestoreError("Backup bytes differ from the inspected file", code="BACKUP_FILE_CHANGED")
        self._require_restore(rescue=rescue)
        assert self.state_store is not None
        try:
            payload,operation_id,count = self._stage_backup_file(Path(path),inspection)
        except BackupRestoreError:
            raise
        except (ValueError,TypeError,KeyError) as exc:
            raise BackupRestoreError("Backup contains an invalid format or record",code="BACKUP_INVALID_FORMAT") from exc
        try:
            self.state_store.record_staged_target(operation_id,payload,memory_count=count,
                source_sha256=inspection.sha256,file_bytes=inspection.file_bytes)
        except BaseException:
            self.state_store.discard_staging(operation_id)
            raise
        return PreparedBackup(operation_id,payload,count,inspection)

    def restore_prepared(self, prepared: PreparedBackup, *, replace_memory: bool = True,
                         rescue: bool = False) -> dict[str,Any]:
        self._require_restore(rescue=rescue)
        assert self.state_store is not None
        payload,count,digest,size = self.state_store.load_staged_target(prepared.operation_id)
        if digest != prepared.inspection.sha256 or size != prepared.inspection.file_bytes:
            raise BackupRestoreError("Prepared backup does not match inspection",code="BACKUP_FILE_CHANGED")
        self._validate_payload(payload)
        self._require_complete_target(payload,rescue=rescue,replace_memory=replace_memory)
        return self._restore_staged_payload(payload,prepared.operation_id,count,
                                            replace_memory=replace_memory,rescue=rescue)

    def discard_prepared(self, prepared: PreparedBackup) -> None:
        assert self.state_store is not None
        self.state_store.discard_staging(prepared.operation_id)

    def import_payload(self, payload: dict[str, Any], *, replace_memory: bool = True,
                       rescue: bool = False) -> dict[str, Any]:
        """Internal compatibility entry; public whole-JSON command is disabled."""
        self._validate_payload(payload)
        self._require_complete_target(payload,rescue=rescue,replace_memory=replace_memory)
        self._require_restore(rescue=rescue)
        assert self.state_store is not None
        operation_id = uuid.uuid4().hex
        count = self.state_store.stage_memory(operation_id,iter(payload["memory"]))
        try:
            return self._restore_staged_payload(payload,operation_id,count,
                                                replace_memory=replace_memory,rescue=rescue)
        finally:
            self.state_store.discard_staging(operation_id)

    def _restore_staged_payload(self, payload: dict[str, Any], operation_id: str, count: int,
                                *, replace_memory: bool, rescue: bool = False) -> dict[str, Any]:
        assert self.state_store is not None
        before = self._snapshot(include_memory=False)
        target = self._materialize_nonmemory_target(payload,before)
        if rescue and self._recovery_state != "clean":
            # A rescue starts from potentially mixed state. This durable flag
            # prevents a failed rescue from making that state authoritative
            # after process restart merely because its before marker matches.
            before["_restore_before_confirmed"] = False
        before["_memory_restore_marker"] = self._memory_restore_marker()
        target["_memory_restore_marker"] = operation_id
        try:
            intent = self.state_store.prepare_restore(before,target,operation_id=operation_id,rescue=rescue)
        except Exception as exc:
            # Preparation COMMIT can also be ambiguous. Never apply managers
            # until a fresh readonly journal confirms the exact new intent.
            try:
                confirmed = self.state_store.pending_restore()
            except Exception:
                confirmed = None
            if confirmed is None or confirmed.operation_id != operation_id:
                self._lock_recovery("Restore preparation could not be confirmed")
                raise BackupRestoreError(self._recovery_reason,code="BACKUP_RECOVERY_REQUIRED") from exc
            intent = confirmed
        self._recovery_state,self._operation_id = "recovering",operation_id
        self._fault("journal_prepared")
        nonmemory_result: dict[str,int] = {}

        def before_commit() -> None:
            nonlocal nonmemory_result
            nonmemory_result = self._apply_nonmemory(target)
            self._verify_nonmemory(target)
            self._durability_barrier()
            self._fault("nonmemory_applied")
            self._fault("before_memory_commit")

        try:
            # Close the journal's readonly cursor before settlement even when
            # a consumer raises midway and its traceback retains the iterator.
            with closing(self.state_store.iter_staged_memory(operation_id)) as rows:
                memory_count = self.memory.import_stream(rows,
                    replace=replace_memory,before_commit=before_commit,
                    after_commit=lambda: self._fault("after_memory_commit"),restore_marker=operation_id)
        except Exception as exc:
            try:
                outcome,nonmemory_result = self._settle(intent,allow_unconfirmed_before=rescue)
            except Exception as settlement_exc:
                self._lock_recovery(str(settlement_exc))
                raise BackupRestoreError(self._recovery_reason,code="BACKUP_RECOVERY_REQUIRED") from settlement_exc
            if outcome == "after":
                return {"memory": count,**nonmemory_result,"outcome":"committed","operation_id":operation_id}
            if rescue:
                # The before snapshot of rescue may itself have been mixed.
                # Keep admission closed even after this new attempt rolls back.
                self._lock_recovery("Rescue was rolled back; the prior unconfirmed state still requires rescue")
            raise BackupRestoreError(f"Backup restore failed; pre-restore state reinstated: {exc}",code="BACKUP_ROLLED_BACK") from exc
        try:
            # Even successful return must cross the same readonly confirmation.
            outcome = self._probe(intent)
            if outcome != "after":
                raise BackupRestoreError("Memory commit was not confirmed",code="BACKUP_RECOVERY_REQUIRED")
            self._finalize(intent,"after")
        except Exception as exc:
            self._lock_recovery(str(exc))
            raise BackupRestoreError(self._recovery_reason,code="BACKUP_RECOVERY_REQUIRED") from exc
        return {"memory":int(memory_count),**nonmemory_result,"outcome":"committed","operation_id":operation_id}

    def _durability_barrier(self) -> None:
        if self.state_store is None:
            return
        store_parent = self.state_store.path.parent.resolve()
        roots: set[Path] = {store_parent}
        participants = [self.memory, self.emotion, self.relationship, self.diary,
                        self.user_manager, *self._optional_managers().values()]
        for participant in participants:
            if participant is None:
                continue
            sources = [participant, getattr(participant,"_db",None),
                       getattr(participant,"document_store",None),
                       getattr(getattr(participant,"store",None),"catalog",None)]
            for source in sources:
                if source is None:
                    continue
                for attribute in ("path","state_path","data_dir","diary_dir","calendar_path"):
                    location = getattr(source,attribute,None)
                    if isinstance(location,(str,Path)) and str(location):
                        candidate = Path(location).resolve()
                        directory = candidate if attribute.endswith("dir") or candidate.is_dir() else candidate.parent
                        roots.add(directory)
        excluded = {self.state_store.path.resolve(), *(Path(f"{self.state_store.path}{suffix}").resolve()
                     for suffix in ("-journal","-wal","-shm"))}
        directories: set[Path] = set()
        for root in roots:
            if not root.exists():
                continue
            directories.add(root)
            for path in root.rglob("*"):
                if not path.is_file() or path.resolve() in excluded:
                    continue
                try:
                    with path.open("rb") as stream:
                        os.fsync(stream.fileno())
                    directories.add(path.parent)
                except FileNotFoundError:
                    continue
        if os.name != "nt":
            for directory in sorted(directories,key=lambda item: len(item.parts),reverse=True):
                descriptor = os.open(directory,os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)

    def backup_to_file(self, path: Path) -> None:
        if not hasattr(self.memory,"iter_export_pages"):
            atomic_write_json(path,self.export_payload())
            return
        path.parent.mkdir(parents=True,exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        payload = self._export_nonmemory_payload()
        try:
            with temporary.open("w",encoding="utf-8",newline="\n") as stream:
                stream.write("{\n")
                first_section = True
                for key,value in payload.items():
                    if not first_section:
                        stream.write(",\n")
                    json.dump(str(key),stream,ensure_ascii=False)
                    stream.write(": ")
                    json.dump(value,stream,ensure_ascii=False,indent=2)
                    first_section = False
                if not first_section:
                    stream.write(",\n")
                stream.write('"memory": [\n')
                first_memory = True
                for page in self.memory.iter_export_pages():
                    for record in page:
                        if not first_memory:
                            stream.write(",\n")
                        json.dump(record,stream,ensure_ascii=False,separators=(",", ":"))
                        first_memory = False
                stream.write("\n]\n}\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary,path)
        finally:
            temporary.unlink(missing_ok=True)
