"""Confirmed, compare-and-swap revisions of inactive imported personas.

Only a new immutable persona file and the authoritative registry are written.
Runtime state, the active cache, import reports and archive records are outside
this transaction.  The bridge serializes this module with persona effects.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any, Callable
import uuid

from .identity import require_authorized_identity_commit
from .persona_card import Persona
from .sillytavern_export import CharacterCardExportError, imported_identity
from .sillytavern_import import (
    CharacterCardImportError,
    _atomic_json_write,
    _clean_text,
    _load_profile_persona,
    _load_registry,
    _replace_macros,
    author_prompt_flags,
)


EDITABLE_FIELDS = frozenset({
    "description", "personality_traits", "tone", "first_message",
    "alternate_greetings", "message_example",
})
TEXT_LIMITS = {"description": 24_000, "tone": 2_000,
               "first_message": 4_000, "message_example": 8_000}


class PersonaProfileEditError(ValueError):
    def __init__(self, code: str, message: str, *, field: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.field = field

    def result(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "error": str(self),
                **({"field": self.field} if self.field else {})}


def _fail(code: str, message: str, field: str = "") -> None:
    raise PersonaProfileEditError(code, message, field=field)


def profile_fields(persona: Persona) -> dict[str, Any]:
    identity = persona.identity
    return {
        "description": str(identity.get("description", "")),
        "personality_traits": list(persona.personality_traits),
        "tone": str(persona.speaking_style.get("tone", "")),
        "first_message": str(identity.get("first_message", "")),
        "alternate_greetings": list(identity.get("alternate_greetings", [])),
        "message_example": str(identity.get("message_example", "")),
    }


def _profile(root: Path, profile_id: str) -> tuple[dict[str, Any], Persona, dict[str, Any]]:
    registry = _load_registry(root / "registry.json")
    record = registry.get("profiles", {}).get(profile_id)
    if not isinstance(record, dict):
        _fail("profile_not_found", "没有找到这个人格")
    # The shared loader can migrate a legacy builtin registry.  Reject it
    # before loading so even an unsuccessful profile read stays read only.
    if str(record.get("source_format") or "") in {"builtin", "builtin_legacy"}:
        _fail("persona_not_editable", "内置人格不能编辑")
    persona, record = _load_profile_persona(root, registry, profile_id)
    try:
        identity = imported_identity(persona, profile_id)
    except CharacterCardExportError:
        _fail("persona_not_editable", "这个人格不是由角色卡导入的，不能编辑")
    envelope = persona.identity_envelope
    if (type(record.get("identity_version")) is not int
            or record.get("identity_version") != envelope.version
            or record.get("identity_fingerprint") != envelope.fingerprint
            or record.get("persona_id") != envelope.persona_id
            or record.get("source_format") != identity["import_source"]):
        _fail("identity_conflict", "人格登记信息与封存版本不一致，请重新打开编辑")
    return registry, persona, record


def read_persona_profile(persona_dir: Path, profile_id: str) -> dict[str, Any]:
    registry, persona, record = _profile(Path(persona_dir).resolve(), profile_id)
    envelope = persona.identity_envelope
    return {"ok": True, "profile_id": profile_id, "name": persona.name,
            "identity_version": envelope.version, "identity_fingerprint": envelope.fingerprint,
            "active": str(registry.get("active_id") or "default") == profile_id,
            "source_format": record["source_format"], "fields": profile_fields(persona)}


def _normalized_text(value: Any, field: str, name: str, limit: int) -> str:
    if not isinstance(value, str):
        _fail("field_invalid", "字段必须是文本", field)
    # Reuse import normalization and macros without its lossy slicing.  Check
    # length after substitution too, because the character name can expand it.
    text = _clean_text(value, sys.maxsize)
    text = _clean_text(_replace_macros(text, name), sys.maxsize)
    if len(text) > limit:
        _fail("field_too_long", f"字段超过 {limit} 字上限，没有保存", field)
    if author_prompt_flags(text):
        _fail("unsafe_profile_instructions", "字段含有不安全的元指令，没有保存", field)
    return text


def normalize_profile_fields(fields: Any, name: str) -> dict[str, Any]:
    if not isinstance(fields, dict) or not fields:
        _fail("field_invalid", "至少需要一个可编辑字段", "fields")
    unknown = set(fields) - EDITABLE_FIELDS
    if unknown:
        _fail("field_not_editable", "这个字段不能编辑", str(sorted(unknown, key=str)[0]))
    result: dict[str, Any] = {}
    for field, value in fields.items():
        if field in TEXT_LIMITS:
            result[field] = _normalized_text(value, field, name, TEXT_LIMITS[field])
            continue
        if not isinstance(value, list):
            _fail("field_invalid", "字段必须是文本列表", field)
        max_items, item_limit = (24, 160) if field == "personality_traits" else (20, 4_000)
        if len(value) > max_items:
            _fail("field_invalid", f"列表最多 {max_items} 条", field)
        cleaned: list[str] = []
        for item in value:
            text = _normalized_text(item, field, name, item_limit)
            if not text or (field == "personality_traits" and len(text) < 2):
                _fail("field_invalid", "性格特征须为 2–160 字，问候不能为空", field)
            # Only traits have the contract's explicit automatic deduplication.
            if field != "personality_traits" or text not in cleaned:
                cleaned.append(text)
        if field == "personality_traits" and not cleaned:
            _fail("field_invalid", "性格特征至少一条", field)
        if author_prompt_flags("\n".join(cleaned)):
            _fail("unsafe_profile_instructions", "字段含有不安全的元指令，没有保存", field)
        result[field] = cleaned
    return result


@dataclass(frozen=True)
class PreparedProfileUpdate:
    root: Path
    profile_id: str
    previous: Persona
    candidate: Persona
    previous_path: str
    result: dict[str, Any]


def prepare_persona_profile_update(
    persona_dir: Path, profile_id: str, *, expected_identity_version: Any,
    expected_identity_fingerprint: Any, fields: Any,
) -> PreparedProfileUpdate:
    root = Path(persona_dir).resolve()
    registry, previous, record = _profile(root, profile_id)
    if str(registry.get("active_id") or "default") == profile_id:
        _fail("persona_active", "使用中的人格不能编辑，请先切换到其他人格")
    envelope = previous.identity_envelope
    if (type(expected_identity_version) is not int or expected_identity_version != envelope.version
            or not isinstance(expected_identity_fingerprint, str)
            or not expected_identity_fingerprint.isascii()
            or not hmac.compare_digest(expected_identity_fingerprint, envelope.fingerprint)):
        _fail("identity_conflict", "这个人格已在别处更改，请重新打开编辑")
    normalized = normalize_profile_fields(fields, previous.name)
    current_fields = profile_fields(previous)
    if all(current_fields[field] == value for field, value in normalized.items()):
        _fail("no_change", "规整后的内容没有变化，没有保存")
    data = previous.to_dict()
    for field, value in normalized.items():
        if field == "description":
            data["identity"]["description"] = value
            data["backstory"] = value
        elif field == "personality_traits":
            data[field] = value
        elif field == "tone":
            data["speaking_style"]["tone"] = value
        else:
            data["identity"][field] = value
    data["identity"]["identity_version"] = envelope.version + 1
    candidate = Persona(**data)
    updated = candidate.seal_identity()
    result = {"ok": True, "profile_id": profile_id, "name": candidate.name,
              "identity_version": updated.version, "identity_fingerprint": updated.fingerprint,
              "active": False, "source_format": record["source_format"],
              "fields": profile_fields(candidate)}
    return PreparedProfileUpdate(root, profile_id, previous, candidate,
                                 str(record["persona_path"]), result)


def check_profile_restore_pending(data_dir: Path, persona_id: str) -> None:
    """Inspect existing journals without mounting or creating a state scope."""
    from src.world_state_store import WorldStateStore

    state_root = Path(data_dir) / "personas" / hashlib.sha256(persona_id.encode("utf-8")).hexdigest()
    paths = (state_root / "restore" / "restore.sqlite3",
             state_root / "world" / "world_state.sqlite3")
    try:
        if any(WorldStateStore.peek_pending(path) is not None for path in paths):
            _fail("restore_pending", "这个人格有尚未完成的恢复，没有保存")
    except PersonaProfileEditError:
        raise
    except Exception:
        _fail("restore_pending", "这个人格的恢复状态无法确认，没有保存")


def _reuse_existing_version(path: Path, payload: bytes) -> bool:
    """Attest an existing immutable target without changing it or its links."""
    try:
        named = path.lstat()
    except FileNotFoundError:
        return False

    def private_regular(info: os.stat_result) -> bool:
        return (stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.getuid() and not info.st_mode & 0o077)

    def metadata(info: os.stat_result) -> tuple:
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    if not private_regular(named) or named.st_size != len(payload):
        raise ValueError("Existing version is not the matching private regular file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not private_regular(opened) or metadata(opened) != metadata(named):
            raise ValueError("Existing version changed before opening")
        chunks: list[bytes] = []
        remaining = len(payload) + 1
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65_536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        named_after = path.lstat()
        if (b"".join(chunks) != payload or not private_regular(after)
                or not private_regular(named_after) or metadata(after) != metadata(opened)
                or metadata(named_after) != metadata(opened)):
            raise ValueError("Existing version bytes or identity do not match")
        return True
    finally:
        os.close(descriptor)


def _write_new_version(path: Path, value: dict[str, Any]) -> None:
    # A content-addressed target may be an orphan from a previous interrupted
    # commit. Reuse it only after attesting its bytes and filesystem identity.
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
    if _reuse_existing_version(path, payload):
        return
    # Same-directory hard-link publication is atomic and never replaces a
    # destination. Only this call's exclusively created temporary is removed.
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary_created = False
    temporary_identity: tuple[int, int] | None = None
    try:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(temporary, flags, 0o600)
        temporary_created = True
        opened = os.fstat(descriptor)
        temporary_identity = (opened.st_dev, opened.st_ino)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if not _reuse_existing_version(path, payload):
                raise ValueError("Version target disappeared during publication")
    finally:
        if temporary_created:
            try:
                remaining = temporary.lstat()
            except FileNotFoundError:
                remaining = None
            if remaining is not None:
                if (remaining.st_dev, remaining.st_ino) != temporary_identity:
                    raise ValueError("Temporary name no longer belongs to this save")
                temporary.unlink()
    # A newly linked target has two names until our temporary is removed.
    # Cleanup failure must leave the registry unchanged, never publish nlink=2.
    if not _reuse_existing_version(path, payload):
        raise ValueError("Published version is unavailable")


def commit_persona_profile_update(
    prepared: PreparedProfileUpdate, *, fault_hook: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    require_authorized_identity_commit(prepared.candidate)
    # Re-read the pointer immediately before the first write.  Immutable source
    # files remain available even if another process replaced the registry.
    registry, previous, record = _profile(prepared.root, prepared.profile_id)
    if str(registry.get("active_id") or "default") == prepared.profile_id:
        _fail("persona_active", "使用中的人格不能编辑，请先切换到其他人格")
    old, expected = previous.identity_envelope, prepared.previous.identity_envelope
    if (old.persona_id, old.version, old.fingerprint, str(record["persona_path"])) != (
            expected.persona_id, expected.version, expected.fingerprint, prepared.previous_path):
        _fail("identity_conflict", "这个人格已在别处更改，请重新打开编辑")
    profile_dir = prepared.root / "imported" / prepared.profile_id
    if any(path.is_symlink() for path in (profile_dir.parent, profile_dir)) or not profile_dir.is_dir():
        _fail("unsafe_profile_path", "人格版本目录不安全，没有保存")
    envelope = prepared.candidate.identity_envelope
    path = profile_dir / f"persona.v{envelope.version}-{envelope.fingerprint[:16]}.json"
    result = dict(prepared.result)
    try:
        if fault_hook:
            fault_hook("before_version_write")
        _write_new_version(path, prepared.candidate.to_dict())
    except Exception:
        _fail("profile_save_failed", "新版本文件没有写入，登记表未更改")
    record.update({"persona_path": path.relative_to(prepared.root).as_posix(),
                   "identity_fingerprint": envelope.fingerprint,
                   "identity_version": envelope.version})
    try:
        if fault_hook:
            fault_hook("before_registry_commit")
        _atomic_json_write(prepared.root / "registry.json", registry)
    except Exception:
        _fail("profile_save_failed", "登记表没有更改；留下未引用的文件，旧版本仍可用")
    try:
        if fault_hook:
            fault_hook("after_registry_commit")
    except Exception as exc:
        result["warning"] = f"已保存；后续步骤未完成：{type(exc).__name__}"
    return result
