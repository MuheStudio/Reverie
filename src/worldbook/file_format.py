"""Bounded world-book file conversion for the private native controls.

Files are untrusted data, including their Reverie extensions.  Conversion has
no archive side effects; the bridge remains the owner of identity checks,
whole-archive size checks and the existing archive commit path.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Any
from uuid import uuid4

from src.persona.sillytavern_import import (
    _clean_text,
    _replace_macros,
    _unsafe_instruction_flags,
)


MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 10_000
MAX_REGEX_CHARACTERS = 16_384
_SCHEMA = "reverie.world-book.v1"
_MAX_JSON_DEPTH = 64
_POSITIONS = {0: "before_char", 1: "after_char", 4: "at_depth"}
_LOGICS = {0: "and_any", 1: "not_all", 2: "not_any", 3: "and_all"}
_ROLES = {0: "system", 1: "user", 2: "assistant"}

# R8 defaults remain closed. W10 adds only position, selectiveLogic and
# keysecondary to the import-report whitelist; exported defaults are unchanged.
EXPORT_DEFAULTS: dict[str, Any] = {
    "vectorized": False, "addMemo": False, "ignoreBudget": False,
    "excludeRecursion": False, "preventRecursion": False, "groupOverride": False,
    "matchPersonaDescription": False, "matchCharacterDescription": False,
    "matchCharacterPersonality": False, "matchCharacterDepthPrompt": False,
    "matchScenario": False, "matchCreatorNotes": False,
    "delayUntilRecursion": 0, "probability": 100, "groupWeight": 100,
    "useProbability": True, "outletName": "", "group": "", "automationId": "",
    "matchWholeWords": None, "useGroupScoring": None, "sticky": None,
    "cooldown": None, "delay": None, "triggers": [],
}
_FILTER_DEFAULTS = {
    "characterFilter": None, "characterFilterNames": [],
    "characterFilterTags": [], "characterFilterExclude": False,
}
_ERRORS = {
    "invalid_request": "世界书文件请求无效。",
    "invalid_path": "请选择绝对路径的普通 JSON 文件。",
    "file_too_large": "世界书文件超过 5 MiB 上限。",
    "invalid_encoding": "世界书文件必须使用 UTF-8 编码。",
    "invalid_json": "世界书文件不是有效的 JSON。",
    "unsupported_format": "世界书文件的格式不受支持。",
    "too_many_entries": "世界书条目超过 10000 条上限。",
    "no_importable_entries": "文件没有可以导入的世界书条目。",
    "archive_too_large": "导入后的完整档案超过保存或传输上限。",
    "file_changed": "文件已变化，请重新检查后导入。",
    "persona_changed": "当前人格已变化，请重新发起操作。",
    "archive_changed": "档案版本已变化，请重新读取后操作。",
    "world_book_not_found": "当前档案中没有所选世界书。",
    "empty_book": "这本世界书还没有条目，不能导出。",
    "write_failed": "世界书文件无法完整写出。",
    "archive_unavailable": "世界书档案暂时无法操作。",
}


class WorldbookFileError(ValueError):
    """Public failures contain a fixed code and never rejected input text."""

    def __init__(self, code: str) -> None:
        self.code = code if code in _ERRORS else "invalid_request"
        super().__init__(_ERRORS[self.code])

    def result(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "error": str(self)}


@dataclass(frozen=True)
class WorldbookFileImport:
    book: dict[str, Any]
    sha256: str
    file_bytes: int
    skipped: dict[str, int]
    dropped_fields: dict[str, int]
    disabled_regex_entry_count: int
    cleaned_entry_count: int

    @property
    def entry_count(self) -> int:
        return len(self.book["entries"])

    def inspection(self) -> dict[str, Any]:
        """Exactly the R6 inspect domain receipt, without archive contents."""
        return {
            "ok": True, "book_name": self.book["name"],
            "importable_entry_count": self.entry_count,
            "skipped": dict(self.skipped), "dropped_fields": dict(self.dropped_fields),
            "disabled_regex_entry_count": self.disabled_regex_entry_count,
            "cleaned_entry_count": self.cleaned_entry_count,
            "sha256": self.sha256, "file_bytes": self.file_bytes,
        }


def _pick(value: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in value:
            return value[name]
    return default


def _integer(value: Any, default: int | None) -> int | None:
    # Do not coerce floats, booleans or strings.  In particular this cannot
    # raise OverflowError when JSON's 1e400 has become float('inf').
    return value if type(value) is int and value >= 0 else default


def _enum(value: Any, choices: Mapping[int, str], default: str) -> str:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in choices.values():
            return lowered
        if lowered in {str(number) for number in choices}:
            return choices[int(lowered)]
    return choices.get(value, default) if type(value) is int else default


def _extension(value: Mapping[str, Any]) -> Mapping[str, Any]:
    extensions = value.get("extensions")
    reverie = extensions.get("reverie") if isinstance(extensions, Mapping) else None
    return reverie if isinstance(reverie, Mapping) else {}


def _clean(value: Any, *, persona_name: str | None = None) -> tuple[str, bool]:
    if not isinstance(value, str):
        return "", False
    # The inherited cleaner slices its result.  sys.maxsize intentionally
    # makes that cap ineffective, including NFC expansions and macro growth.
    result = _clean_text(value, sys.maxsize)
    changed = result != value.strip()
    if persona_name is not None:
        replaced = _replace_macros(result, persona_name)
        result = _clean_text(replaced, sys.maxsize)
        changed = changed or result != replaced.strip()
    return result, changed


def _keywords(value: Any, persona_name: str) -> tuple[list[str], bool]:
    if value is None:
        return [], False
    if isinstance(value, str):
        value = re.split(r"[、，,]", value)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("invalid")
    result: list[str] = []
    changed = False
    for item in value:
        cleaned, item_changed = _clean(item, persona_name=persona_name)
        changed = changed or item_changed
        if cleaned:
            result.append(cleaned)
    return result, changed


def _regex_literal(value: str) -> tuple[str, str] | None:
    if not value.startswith("/"):
        return None
    closing = value.rfind("/")
    if closing < 2:
        return None
    flags = value[closing + 1:]
    if any(flag not in "gimsuy" for flag in flags):
        return None
    slashes = 0
    for index, character in enumerate(value[1:closing + 1], 1):
        if character == "/" and slashes % 2 == 0 and index != closing:
            return None
        if index == closing and slashes % 2:
            return None
        slashes = slashes + 1 if character == "\\" else 0
    return value[1:closing], flags


def _regex_rules(
    entry: Mapping[str, Any], primary: list[str], secondary: list[str], *, envelope: bool,
) -> tuple[list[str], list[str], bool, bool, bool]:
    sensitive = _pick(entry, "caseSensitive", "case_sensitive", default=False) is True
    explicit = _pick(entry, "useRegex", "use_regex")
    words = primary + secondary
    parsed = [_regex_literal(word) for word in words]
    if envelope:
        return primary, secondary, explicit is True, sensitive, False
    extension_flag = _extension(entry).get("useRegex")
    if extension_flag is False:
        return primary, secondary, False, sensitive, False
    if extension_flag is True and all(item is not None for item in parsed):
        bodies = [item[0] for item in parsed if item is not None]
        return bodies[:len(primary)], bodies[len(primary):], True, sensitive, False
    if type(explicit) is bool:
        return primary, secondary, explicit, sensitive, False
    if not any(item is not None for item in parsed):
        return primary, secondary, False, sensitive, False
    flags = {item[1] for item in parsed if item is not None}
    if all(item is not None for item in parsed) and len(flags) == 1 and flags <= {"", "i"}:
        bodies = [item[0] for item in parsed if item is not None]
        return bodies[:len(primary)], bodies[len(primary):], True, flags == {""}, False
    return primary, secondary, False, sensitive, True


def _dropped(entry: Mapping[str, Any], *, discarded_secondary: bool = False) -> Counter[str]:
    result: Counter[str] = Counter()
    for name, default in {**EXPORT_DEFAULTS, **_FILTER_DEFAULTS}.items():
        if name not in entry or name == "addMemo":
            continue
        if name == "probability":
            probability = entry[name]
            if entry.get("useProbability") is not False and type(probability) in {int, float} and probability < 100:
                result[name] += 1
        elif type(entry[name]) is not type(default) or entry[name] != default:
            result[name] += 1
    for name, value, choices in (
        ("position", entry.get("position"), _POSITIONS),
        ("selectiveLogic", _pick(entry, "selectiveLogic", "selective_logic"), _LOGICS),
    ):
        # Invalid types, negative integers and non-finite numbers still use
        # R4 defaults without being reported as unsupported settings.
        eligible = isinstance(value, str) or (type(value) is int and value >= 0)
        if eligible and _enum(value, choices, "") == "":
            result[name] += 1
    if discarded_secondary:
        result["keysecondary"] += 1
    return result


def _entry(
    value: Any, *, persona_name: str, envelope: bool,
) -> tuple[dict[str, Any] | None, str, Counter[str], bool, bool]:
    if not isinstance(value, dict):
        return None, "invalid", Counter(), False, False
    content, changed = _clean(value.get("content"), persona_name=persona_name)
    comment, comment_changed = _clean(_pick(value, "comment", "name", default=""))
    changed = changed or comment_changed
    try:
        primary, primary_changed = _keywords(_pick(value, "keywords", "keys", "key", default=[]), persona_name)
        secondary, secondary_changed = _keywords(
            _pick(value, "secondaryKeywords", "secondary_keys", "keysecondary", default=[]), persona_name,
        )
    except ValueError:
        return None, "invalid", Counter(), False, False
    changed = changed or primary_changed or secondary_changed
    discarded_secondary = value.get("selective") is False and bool(secondary)
    if value.get("selective") is False:
        secondary = []
    if not content:
        return None, "empty", Counter(), False, False
    if len(content) > 100_000 or len(comment) > 5_000 or len(primary) > 200 or len(secondary) > 200:
        return None, "oversized", Counter(), False, False
    if any(_unsafe_instruction_flags(text) for text in [content, *primary, *secondary]):
        return None, "unsafe", Counter(), False, False
    primary, secondary, use_regex, sensitive, disabled = _regex_rules(
        value, primary, secondary, envelope=envelope,
    )
    if use_regex and any(len(pattern) > MAX_REGEX_CHARACTERS for pattern in primary + secondary):
        return None, "oversized", Counter(), False, False
    extension = _extension(value)
    budget = _pick(value, "tokenBudget", "token_budget", default=extension.get("tokenBudget"))
    result = {
        "id": f"entry_{uuid4().hex}", "keywords": primary, "secondaryKeywords": secondary,
        "selectiveLogic": _enum(_pick(value, "selectiveLogic", "selective_logic"), _LOGICS, "and_any"),
        "content": content, "comment": comment,
        "alwaysActive": _pick(value, "alwaysActive", "always_active", "constant", default=False) is True,
        "enabled": value.get("enabled") is not False and value.get("disable") is not True and not disabled,
        "insertionOrder": _integer(_pick(value, "insertionOrder", "order", "insertion_order"), 100),
        "priority": _integer(value.get("priority"), 0),
        "position": _enum(value.get("position"), _POSITIONS, "before_char"),
        "depth": _integer(value.get("depth"), 0),
        "role": _enum(value.get("role"), _ROLES, "system"),
        "scanDepth": _integer(_pick(value, "scanDepth", "scan_depth"), None),
        "tokenBudget": _integer(budget, None), "caseSensitive": sensitive, "useRegex": use_regex,
    }
    return result, "", _dropped(value, discarded_secondary=discarded_secondary), disabled, changed


def _json(raw: bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def integer(value: str) -> int:
        if len(value.lstrip("-")) > 4_300:
            raise ValueError("integer too long")
        return int(value)

    def non_finite(_value: str) -> Any:
        raise ValueError("non-finite constant")

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise WorldbookFileError("invalid_encoding") from None
    text = text.removeprefix("\ufeff")
    try:
        result = json.loads(text, object_pairs_hook=pairs, parse_int=integer, parse_constant=non_finite)
        stack = [(result, 0)]
        while stack:
            item, depth = stack.pop()
            if depth > _MAX_JSON_DEPTH:
                raise ValueError("nested too deeply")
            if isinstance(item, dict):
                stack.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list):
                stack.extend((child, depth + 1) for child in item)
            elif isinstance(item, str):
                # JSON permits escaped surrogate code units syntactically;
                # they cannot be sent in our actual UTF-8 archive frames.
                item.encode("utf-8")
        return result
    except (ValueError, RecursionError, OverflowError, UnicodeError):
        raise WorldbookFileError("invalid_json") from None


def parse_worldbook_file(
    raw: bytes, *, filename: str, persona_name: str, existing_names: Sequence[str] = (),
) -> WorldbookFileImport:
    if not isinstance(raw, bytes):
        raise WorldbookFileError("invalid_request")
    if len(raw) > MAX_FILE_BYTES:
        raise WorldbookFileError("file_too_large")
    document = _json(raw)
    if not isinstance(document, dict):
        raise WorldbookFileError("unsupported_format")
    envelope = "schema" in document
    if envelope:
        if document["schema"] != _SCHEMA or not isinstance(document.get("worldBook"), dict):
            raise WorldbookFileError("unsupported_format")
        document = document["worldBook"]
    entries = document.get("entries")
    if not isinstance(entries, (dict, list)):
        raise WorldbookFileError("unsupported_format")
    if len(entries) > MAX_ENTRIES:
        raise WorldbookFileError("too_many_entries")
    name, _ = _clean(document.get("name"))
    if not name:
        name, _ = _clean(Path(filename).stem)
    if not name:
        name = "世界书"
    names = set(existing_names)
    while name in names:
        name += "（导入）"
    if len(name) > 500:
        raise WorldbookFileError("unsupported_format")
    skipped: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    converted: list[dict[str, Any]] = []
    disabled_count = cleaned_count = 0
    for value in entries.values() if isinstance(entries, dict) else entries:
        item, reason, fields, disabled, cleaned = _entry(value, persona_name=persona_name, envelope=envelope)
        if item is None:
            skipped[reason] += 1
            continue
        converted.append(item)
        dropped.update(fields)
        disabled_count += int(disabled)
        cleaned_count += int(cleaned)
    if not converted:
        raise WorldbookFileError("no_importable_entries")
    extension = _extension(document)

    def setting(canonical: str, legacy: str, default: Any) -> Any:
        return extension[canonical] if canonical in extension else _pick(document, canonical, legacy, default=default)

    now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    book = {
        "id": f"world_{uuid4().hex}", "name": name, "entries": converted,
        "createdAt": now, "updatedAt": now,
        "scanDepth": _integer(setting("scanDepth", "scan_depth", 50), 50),
        "tokenBudget": _integer(setting("tokenBudget", "token_budget", 500), 500),
        "recursiveScanning": setting("recursiveScanning", "recursive_scanning", False) is True,
    }
    return WorldbookFileImport(book, hashlib.sha256(raw).hexdigest(), len(raw),
                               dict(skipped), dict(dropped), disabled_count, cleaned_count)


def _escape_slashes(pattern: str) -> str:
    result: list[str] = []
    preceding = 0
    for character in pattern:
        if character == "/" and preceding % 2 == 0:
            result.append("\\")
        result.append(character)
        preceding = preceding + 1 if character == "\\" else 0
    return "".join(result)


def serialize_worldbook_file(book: Mapping[str, Any]) -> bytes:
    entries = book.get("entries")
    if not isinstance(entries, (list, tuple)):
        raise WorldbookFileError("invalid_request")
    if not entries:
        raise WorldbookFileError("empty_book")
    exported: dict[str, Any] = {}
    try:
        for uid, entry in enumerate(entries):
            regex = entry.get("useRegex") is True

            def keys(name: str) -> list[str]:
                words = list(entry.get(name, []))
                if not regex:
                    return words
                suffix = "" if entry.get("caseSensitive") is True else "i"
                return [f"/{_escape_slashes(word)}/{suffix}" for word in words]

            exported[str(uid)] = {
                **EXPORT_DEFAULTS, "triggers": [], "uid": uid,
                "key": keys("keywords"), "keysecondary": keys("secondaryKeywords"),
                "comment": entry.get("comment", ""), "content": entry["content"],
                "constant": entry.get("alwaysActive") is True, "selective": True,
                "selectiveLogic": {value: key for key, value in _LOGICS.items()}[entry.get("selectiveLogic", "and_any")],
                "order": entry.get("insertionOrder", 100),
                "position": {value: key for key, value in _POSITIONS.items()}[entry.get("position", "before_char")],
                "disable": entry.get("enabled") is False, "depth": entry.get("depth", 0),
                "scanDepth": entry.get("scanDepth"), "caseSensitive": entry.get("caseSensitive") is True,
                "role": {value: key for key, value in _ROLES.items()}[entry.get("role", "system")],
                "priority": entry.get("priority", 0),
                "extensions": {"reverie": {"tokenBudget": entry.get("tokenBudget"), "useRegex": regex}},
            }
        document = {
            "name": book["name"], "entries": exported,
            "extensions": {"reverie": {
                "scanDepth": book.get("scanDepth", 50), "tokenBudget": book.get("tokenBudget", 500),
                "recursiveScanning": book.get("recursiveScanning") is True,
            }},
        }
        payload = (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    except (KeyError, TypeError, ValueError, AttributeError, UnicodeError):
        raise WorldbookFileError("invalid_request") from None
    if len(payload) > MAX_FILE_BYTES:
        raise WorldbookFileError("file_too_large")
    return payload


def validate_worldbook_file_path(value: Any, *, must_exist: bool) -> Path:
    if (not isinstance(value, str) or not value or len(value) > 32_767
            or any(ord(character) < 32 for character in value)):
        raise WorldbookFileError("invalid_path")
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.suffix.lower() != ".json":
        raise WorldbookFileError("invalid_path")
    try:
        parent = candidate.parent.resolve(strict=True)
        if not parent.is_dir():
            raise ValueError("not a directory")
        target = parent / candidate.name
        try:
            mode = target.lstat().st_mode
        except FileNotFoundError:
            if must_exist:
                raise
            mode = None
        if mode is not None and not stat.S_ISREG(mode):
            raise ValueError("not a regular file")
        return target
    except (OSError, ValueError, RuntimeError):
        raise WorldbookFileError("invalid_path") from None


def read_worldbook_file(path: Path) -> bytes:
    target = validate_worldbook_file_path(str(path), must_exist=True)
    descriptor: int | None = None
    try:
        # O_NONBLOCK prevents a final-component FIFO swap from blocking open
        # before fstat can reject it.  It has no effect on regular-file reads.
        descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise WorldbookFileError("invalid_path")
        if info.st_size > MAX_FILE_BYTES:
            raise WorldbookFileError("file_too_large")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            payload = stream.read(MAX_FILE_BYTES + 1)
            after = os.fstat(stream.fileno())
        if (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise WorldbookFileError("file_changed")
        if len(payload) > MAX_FILE_BYTES:
            raise WorldbookFileError("file_too_large")
        return payload
    except OSError:
        raise WorldbookFileError("invalid_path") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def write_worldbook_file(path: Path, payload: bytes) -> dict[str, Any]:
    target = validate_worldbook_file_path(str(path), must_exist=False)
    if not isinstance(payload, bytes):
        raise WorldbookFileError("invalid_request")
    if len(payload) > MAX_FILE_BYTES:
        raise WorldbookFileError("file_too_large")
    receipt = {"file_name": target.name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    temporary: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
        temporary = Path(temporary_name)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        validate_worldbook_file_path(str(target), must_exist=False)
        os.replace(temporary, target)
        temporary = None
    except OSError:
        raise WorldbookFileError("write_failed") from None
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    return receipt
