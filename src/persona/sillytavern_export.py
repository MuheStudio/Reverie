"""Explicit, deterministic V2 export of an already imported live persona.

The trial parser consumes the exact output bytes and its result is discarded.
It never saves, activates, seals, or attaches the parsed persona.  Mapping uses
saved values, including quarantined author prompts, without import-time limits.
"""

from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Any

from .persona_card import Persona
from .sillytavern_import import (
    CharacterCardImportError,
    MAX_CARD_BYTES,
    parse_sillytavern_json,
)


EXPORT_FIELDS = frozenset({
    "path", "world_book_id", "persona_id", "persona_epoch",
    "persona_fingerprint", "archive_revision",
})
_IMPORTED_FORMATS = frozenset({"tavern_card_v1", "chara_card_v2", "chara_card_v3"})


class CharacterCardExportError(ValueError):
    def __init__(self, code: str, message: str, *, import_code: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.import_code = import_code

    def result(self) -> dict[str, Any]:
        result: dict[str, Any] = {"ok": False, "code": self.code, "error": str(self)}
        if self.import_code:
            result["import_code"] = self.import_code
        return result


def imported_identity(persona: Persona, persona_id: str) -> Mapping[str, Any]:
    identity = getattr(persona, "identity", None)
    if not isinstance(identity, Mapping):
        raise CharacterCardExportError("persona_not_exportable", "当前人格不是由角色卡导入的")
    source = identity.get("import_source")
    digest = identity.get("import_sha256")
    if (source not in _IMPORTED_FORMATS or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or persona_id != f"st_{digest[:20]}"
            or identity.get("persona_id") != persona_id):
        raise CharacterCardExportError("persona_not_exportable", "当前人格不是由角色卡导入的")
    return identity


def load_export_metadata(persona_dir: Path, persona: Persona, persona_id: str) -> dict[str, Any]:
    """Read only the report owned by the mounted imported identity."""
    identity = imported_identity(persona, persona_id)
    root = Path(persona_dir).resolve()
    report_path = root / "imported" / persona_id / "import-report.json"
    try:
        for component in (report_path.parent.parent, report_path.parent, report_path):
            if component.is_symlink():
                raise ValueError("symlink report")
        if not report_path.is_file():
            raise ValueError("missing report")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        if (not isinstance(report, dict)
                or report.get("card_id") != persona_id
                or report.get("source_sha256") != identity["import_sha256"]
                or report.get("source_format") != identity["import_source"]):
            raise ValueError("mismatched report")
        metadata = report.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError("invalid metadata")
        for field in ("creator", "character_version", "creator_notes"):
            if not isinstance(metadata.get(field, ""), str):
                raise ValueError("invalid text metadata")
        tags = metadata.get("tags", [])
        if not isinstance(tags, list) or any(not isinstance(item, str) for item in tags):
            raise ValueError("invalid tags")
        return {field: metadata.get(field, "") for field in (
            "creator", "character_version", "creator_notes",
        )} | {"tags": list(tags)}
    except (OSError, ValueError, TypeError):
        raise CharacterCardExportError(
            "card_export_unavailable", "当前人格的角色卡导入报告无法读取",
        ) from None


def _entry(entry: Mapping[str, Any], number: int) -> dict[str, Any]:
    position = entry.get("position", "before_char")
    logic = entry.get("selectiveLogic", "and_any")
    reverie = {"id": entry["id"]}
    if logic != "and_any" or position == "at_depth":
        # The agreed fallback applies to either unsupported setting. Preserve
        # both original settings so after_char is not lost with non-AND logic.
        reverie.update(position=position, selectiveLogic=logic)
        position = "before_char"
    return {
        "keys": list(entry.get("keywords", [])),
        "secondary_keys": list(entry.get("secondaryKeywords", [])),
        "content": entry["content"],
        "enabled": entry.get("enabled", True),
        "insertion_order": entry.get("insertionOrder", 100),
        "priority": entry.get("priority", 0),
        "case_sensitive": entry.get("caseSensitive", False),
        "comment": entry.get("comment", ""),
        "constant": entry.get("alwaysActive", False),
        "selective": bool(entry.get("secondaryKeywords")),
        "id": number,
        "depth": entry.get("depth", 0),
        "role": entry.get("role", "system"),
        "scan_depth": entry.get("scanDepth"),
        "token_budget": entry.get("tokenBudget"),
        "use_regex": entry.get("useRegex", False),
        "position": position,
        "extensions": {"reverie": reverie},
    }


def build_v2_card(
    persona: Persona, metadata: Mapping[str, Any], world_book: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Project only contract fields; never serialize a persona/archive wholesale."""
    identity = persona.identity
    book = None if world_book is None else {
        "name": world_book["name"],
        "description": "",
        "scan_depth": world_book.get("scanDepth", 50),
        "token_budget": world_book.get("tokenBudget", 500),
        "recursive_scanning": world_book.get("recursiveScanning", False),
        "extensions": {},
        "entries": [_entry(entry, number) for number, entry in enumerate(world_book.get("entries", []), 1)],
    }
    return {
        "spec": "chara_card_v2",
        "spec_version": "2.0",
        "data": {
            "name": persona.name,
            "description": persona.backstory,
            "personality": "",
            "scenario": "",
            "first_mes": identity.get("first_message", ""),
            "mes_example": identity.get("message_example", ""),
            "alternate_greetings": list(identity.get("alternate_greetings", [])),
            "system_prompt": identity.get("imported_system_prompt", ""),
            "post_history_instructions": identity.get("imported_post_history_instructions", ""),
            "creator": metadata.get("creator", ""),
            "character_version": metadata.get("character_version", ""),
            "creator_notes": metadata.get("creator_notes", ""),
            "tags": list(metadata.get("tags", [])),
            "extensions": {},
            "character_book": book,
        },
    }


def serialize_importable_card(document: dict[str, Any], *, filename: str) -> bytes:
    payload = (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    if len(payload) > MAX_CARD_BYTES:
        raise CharacterCardExportError("card_too_large", "导出内容超过 2 MiB 上限")
    try:
        # Static audit: the V2 parser and dataclass construction have no file,
        # network, activation or application-global writes. Its birthday age
        # inference may read today's date. Do not use any normalized result.
        parse_sillytavern_json(payload, filename=filename)
    except CharacterCardImportError as exc:
        raise CharacterCardExportError(
            "card_not_importable", f"按现有导入规则不能读回：{exc}", import_code=exc.code,
        ) from None
    return payload


def validate_export_path(value: Any) -> Path:
    if (not isinstance(value, str) or not value or len(value) > 32_767
            or any(ord(character) < 32 for character in value)):
        raise CharacterCardExportError("invalid_path", "请选择有效的 JSON 保存位置")
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.suffix.lower() != ".json":
        raise CharacterCardExportError("invalid_path", "保存位置必须是绝对路径且以 .json 结尾")
    try:
        # Resolve the parent only: resolving the final component first would
        # silently turn an existing symlink into an apparently regular target.
        parent = candidate.parent.resolve(strict=True)
        if not parent.is_dir():
            raise ValueError("parent is not a directory")
        target = parent / candidate.name
        try:
            mode = target.lstat().st_mode
        except FileNotFoundError:
            mode = None
        if mode is not None and not stat.S_ISREG(mode):
            raise ValueError("target is not regular")
        return target
    except (OSError, ValueError, RuntimeError):
        raise CharacterCardExportError("invalid_path", "保存目录不存在，或目标不是普通文件") from None


def write_card_file(target: Path, payload: bytes) -> dict[str, Any]:
    """Replace only after the complete temporary file has reached disk."""
    target = validate_export_path(str(target))
    receipt = {"file_name": target.name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    temporary: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
        temporary = Path(temporary_name)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        validate_export_path(str(target))
        os.replace(temporary, target)
        # The commit succeeded. Do not attempt filesystem cleanup afterward:
        # an unrelated permission change must not turn success into rejection.
        temporary = None
    except OSError:
        raise CharacterCardExportError("card_write_failed", "角色卡文件无法完整写出") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return receipt
