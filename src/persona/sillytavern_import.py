"""Strict, local-only import for SillyTavern-style JSON character cards.

Character cards are untrusted documents.  Their descriptive fields may shape a
persona after import, but embedded system prompts, scripts, lorebooks, assets,
and extension payloads are never executed by this importer.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from .persona_card import Persona, default_persona


MAX_CARD_BYTES = 2 * 1024 * 1024
MAX_CONTAINER_DEPTH = 32
MAX_CONTAINER_ITEMS = 20_000
MAX_NAME_CHARS = 120
MAX_PROFILE_CHARS = 24_000
MAX_GREETING_CHARS = 4_000
SUPPORTED_SPECS = {
    "chara_card_v2": "2.0",
    "chara_card_v3": "3.0",
}
# Exact identity shipped before registry.json became authoritative.  This is an
# allowlist, not a generic "trust active.json" migration path.
KNOWN_LEGACY_DEFAULT_FINGERPRINTS = frozenset({
    "33400d02c76445fad79ac7be10f9173c3e8f5f924a8daf1b76d04cf728d0e8c0",
    "4e7eba3ebeeb0809517d8c87d5dc146e01bf7bff5231d2fdde7724c5ac078a18",
})

_BIDI_AND_INVISIBLE = re.compile(
    "[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]"
)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_DANGEROUS_KEYS = {"__proto__", "prototype", "constructor"}
_REQUIRED_V1_FIELDS = ("name", "description", "personality", "scenario", "first_mes", "mes_example")
_V2_REQUIRED_TYPES: dict[str, type] = {
    "creator_notes": str,
    "system_prompt": str,
    "post_history_instructions": str,
    "alternate_greetings": list,
    "tags": list,
    "creator": str,
    "character_version": str,
    "extensions": dict,
}
_UNSAFE_PROFILE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("override_previous", re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above).{0,24}(?:instructions?|rules?|prompts?)|忽略.{0,8}(?:之前|以上).{0,8}(?:指令|规则|设定|提示)|忽略.{0,8}(?:系统指令|系统设定)", re.I)),
    ("prompt_reference", re.compile(r"system\s*prompt|developer\s*message|hidden\s*instruction|系统提示词?|开发者消息|隐藏指令", re.I)),
    ("instruction_marker", re.compile(r"\[(?:system|developer|assistant)\]|</?(?:system|instruction|tool)>|###\s*(?:instruction|system)", re.I)),
    ("exfiltration", re.compile(r"reveal.{0,20}(?:system\s*prompt|api.?key|hidden\s*secret)|(?:输出|泄露).{0,12}(?:系统提示词|API.?密钥|隐藏指令)", re.I)),
    ("tool_execution", re.compile(r"(?:please|must|now)\s+(?:execute|run).{0,16}(?:command|code|script)|(?:请|必须|立即)执行.{0,12}(?:命令|代码|脚本)", re.I)),
    ("memory_poisoning", re.compile(r"(?:store|save|write).{0,16}(?:memory|long.term)|(?:写入|保存|植入).{0,12}(?:记忆|长期记忆)", re.I)),
)
_CORE_NEVER_SAY = [
    "作为AI",
    "作为 AI",
    "as an AI",
    "as a language model",
    "I am an AI",
    "I am a program",
]


class CharacterCardImportError(ValueError):
    """A safe, user-facing character card validation failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CharacterCardImportReport:
    """Normalized import result and its security report."""

    persona: Persona
    card_id: str
    source_sha256: str
    source_format: str
    source_version: str
    warnings: list[str] = field(default_factory=list)
    ignored_fields: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def public_summary(self) -> dict[str, Any]:
        return {
            "card_id": self.card_id,
            "name": self.persona.name,
            "source_sha256": self.source_sha256,
            "source_format": self.source_format,
            "source_version": self.source_version,
            "warnings": list(self.warnings),
            "ignored_fields": list(self.ignored_fields),
            "remote_assets_blocked": True,
        }


def parse_sillytavern_json(raw: bytes | str, *, filename: str = "character.json") -> CharacterCardImportReport:
    """Validate and normalize a V1, V2, or V3 JSON character card.

    The function is deliberately strict about JSON integrity.  It does not
    repair malformed strings or guess around duplicate keys because two
    parsers disagreeing about a card is itself a security boundary failure.
    """

    raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
    if not raw_bytes:
        raise CharacterCardImportError("empty_file", "角色卡文件为空")
    if len(raw_bytes) > MAX_CARD_BYTES:
        raise CharacterCardImportError(
            "file_too_large",
            f"角色卡超过 {MAX_CARD_BYTES // (1024 * 1024)} MiB 安全上限",
        )
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CharacterCardImportError("invalid_encoding", "角色卡必须使用 UTF-8 编码") from exc

    try:
        document = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=lambda value: _reject_non_finite(value),
        )
    except CharacterCardImportError:
        raise
    except json.JSONDecodeError as exc:
        raise CharacterCardImportError(
            "invalid_json",
            f"JSON 格式损坏：第 {exc.lineno} 行，第 {exc.colno} 列，{exc.msg}",
        ) from exc

    if not isinstance(document, dict):
        raise CharacterCardImportError("invalid_root", "角色卡顶层必须是 JSON 对象")
    _validate_shape(document)

    compatibility_warnings: list[str] = []
    spec = _clean_text(document.get("spec", ""), 40)
    if spec:
        if spec not in SUPPORTED_SPECS:
            raise CharacterCardImportError("unsupported_spec", f"暂不支持角色卡格式：{spec}")
        expected_version = SUPPORTED_SPECS[spec]
        version = _clean_text(document.get("spec_version", ""), 20)
        if spec == "chara_card_v2" and version != expected_version:
            raise CharacterCardImportError(
                "unsupported_version",
                f"{spec} 必须使用 spec_version={expected_version}",
            )
        if spec == "chara_card_v3":
            try:
                parsed_version = Decimal(version)
            except InvalidOperation as exc:
                raise CharacterCardImportError("unsupported_version", "V3 角色卡版本号无效") from exc
            if not parsed_version.is_finite() or parsed_version < Decimal("3.0"):
                raise CharacterCardImportError("unsupported_version", "V3 角色卡版本不得低于 3.0")
            if parsed_version > Decimal("3.0"):
                compatibility_warnings.append(
                    f"该角色卡使用未来 V3 版本 {version}，仅导入当前已知的兼容字段"
                )
        data = document.get("data")
        if not isinstance(data, dict):
            raise CharacterCardImportError("missing_data", "V2/V3 角色卡缺少 data 对象")
        source_format = spec
        source_version = version
    else:
        data = document
        source_format = "tavern_card_v1"
        source_version = "1"

    _validate_card_fields(data, source_format)

    name = re.sub(r"\s+", " ", _clean_text(data.get("name", ""), MAX_NAME_CHARS)).strip()
    if not name:
        raise CharacterCardImportError("missing_name", "角色卡名称不能为空")

    description = _clean_text(data.get("description", ""), MAX_PROFILE_CHARS)
    personality_text = _clean_text(data.get("personality", ""), 8_000)
    scenario = _clean_text(data.get("scenario", ""), 8_000)
    message_examples = _clean_text(data.get("mes_example", ""), 8_000)
    first_message = _clean_text(data.get("first_mes", ""), MAX_GREETING_CHARS)
    alternate_greetings = _clean_string_list(data.get("alternate_greetings"), 20, MAX_GREETING_CHARS)
    tags = _clean_string_list(data.get("tags"), 100, 120)
    nickname = _clean_text(data.get("nickname", ""), MAX_NAME_CHARS)
    macro_name = nickname or name

    unsafe_core = _unsafe_instruction_flags(
        "\n".join((name, description, personality_text, scenario))
    )
    if unsafe_core:
        raise CharacterCardImportError(
            "unsafe_profile_instructions",
            "角色档案正文含有试图覆盖系统、执行工具或植入记忆的元指令，已拒绝导入",
        )

    ignored_fields: list[str] = []
    unsafe_message_fields: list[str] = []
    if _unsafe_instruction_flags(first_message):
        first_message = ""
        unsafe_message_fields.append("first_mes")
    if _unsafe_instruction_flags(message_examples):
        message_examples = ""
        unsafe_message_fields.append("mes_example")
    safe_greetings: list[str] = []
    for greeting in alternate_greetings:
        if _unsafe_instruction_flags(greeting):
            if "alternate_greetings" not in unsafe_message_fields:
                unsafe_message_fields.append("alternate_greetings")
        else:
            safe_greetings.append(greeting)
    alternate_greetings = safe_greetings
    ignored_fields.extend(f"{field_name}:unsafe" for field_name in unsafe_message_fields)

    combined_profile = _replace_macros(
        "\n\n".join(part for part in (description, personality_text, scenario) if part),
        macro_name,
    )[:MAX_PROFILE_CHARS]
    age, birthday, age_unknown = _extract_age_and_birthday(combined_profile)
    gender, gender_unknown = _infer_gender(tags, combined_profile)
    traits = _extract_traits(personality_text or description)
    if not traits:
        traits = ["保持导入角色档案中描述的人格特征"]

    for key in ("system_prompt", "post_history_instructions", "character_book", "extensions", "assets"):
        value = data.get(key)
        if value not in (None, "", [], {}):
            ignored_fields.append(key)
    for key in ("group_only_greetings", "creator_notes_multilingual", "source"):
        value = data.get(key)
        if value not in (None, "", [], {}):
            ignored_fields.append(key)

    remote_avatar = _clean_text(data.get("avatar", ""), 2_000)
    warnings = [
        *compatibility_warnings,
        "角色卡内容按不可信数据处理，不能覆盖 Reverie 的安全规则与人格连续性规则",
    ]
    if ignored_fields:
        warnings.append("卡内系统提示、lorebook、脚本或扩展数据已隔离，未执行")
    if remote_avatar:
        warnings.append("远程头像地址已记录但默认禁止联网加载")
    if unsafe_message_fields:
        warnings.append("问候语或对话示例中的可疑元指令已隔离，未写入角色档案")
    if age_unknown:
        warnings.append("角色卡没有可验证的年龄，Reverie 不会在对话中编造年龄")
    if gender_unknown:
        warnings.append("角色卡没有明确性别，已标记为未指定")

    digest = hashlib.sha256(raw_bytes).hexdigest()
    card_id = f"st_{digest[:20]}"
    metadata = {
        "source_filename": _clean_text(Path(filename).name, 255),
        "creator": _clean_text(data.get("creator", ""), 200),
        "character_version": _clean_text(data.get("character_version", ""), 120),
        "creator_notes": _clean_text(data.get("creator_notes", ""), 4_000),
        "nickname": nickname,
        "tags": tags,
        "first_message": _replace_macros(first_message, macro_name),
        "alternate_greetings": [_replace_macros(item, macro_name) for item in alternate_greetings],
        "message_example": _replace_macros(message_examples, macro_name),
        "remote_avatar_url": remote_avatar,
        "remote_assets_blocked": True,
        "ignored_fields": list(ignored_fields),
    }
    persona = Persona(
        name=name,
        age=age,
        gender=gender,
        birthday=birthday,
        identity={
            "persona_id": card_id,
            "identity_version": 1,
            "title": "",
            "description": combined_profile,
            "age_unknown": age_unknown,
            "gender_unknown": gender_unknown,
            "import_source": source_format,
            "import_sha256": digest,
            "first_message": metadata["first_message"],
            "alternate_greetings": metadata["alternate_greetings"],
            "message_example": metadata["message_example"],
        },
        personality_traits=traits,
        values=[],
        speaking_style={
            "catchphrases": [],
            "tone": personality_text[:2_000],
            "filler_words": [],
            "never_say": list(_CORE_NEVER_SAY),
        },
        daily_life={"hobbies": [], "quirks": [], "dislikes": [], "writes_diary": True},
        emotions={
            "joy": 50.0,
            "calm": 60.0,
            "excitement": 30.0,
            "sadness": 10.0,
            "anger": 5.0,
            "anxiety": 15.0,
            "grievance": 5.0,
            "touched": 20.0,
        },
        backstory=combined_profile,
    )
    return CharacterCardImportReport(
        persona=persona,
        card_id=card_id,
        source_sha256=digest,
        source_format=source_format,
        source_version=source_version,
        warnings=warnings,
        ignored_fields=ignored_fields,
        metadata=metadata,
    )


def save_imported_persona(
    report: CharacterCardImportReport,
    persona_dir: Path,
    *,
    activate: bool = False,
) -> dict[str, Any]:
    """Atomically persist one normalized profile in Reverie's local persona store."""

    if activate:
        raise CharacterCardImportError(
            "privileged_activation_required",
            "Import and identity activation must be separate privileged operations",
        )
    root = Path(persona_dir).resolve()
    report.persona.seal_identity()
    imported_root = root / "imported"
    profile_dir = imported_root / report.card_id
    profile_dir.mkdir(parents=True, exist_ok=True)

    persona_path = profile_dir / "persona.json"
    metadata_path = profile_dir / "import-report.json"
    _atomic_json_write(persona_path, report.persona.to_dict())
    _atomic_json_write(
        metadata_path,
        {
            **report.public_summary(),
            "metadata": report.metadata,
        },
    )

    registry_path = root / "registry.json"
    registry = _load_registry(registry_path)
    profiles = registry.setdefault("profiles", {})
    profiles[report.card_id] = {
        "id": report.card_id,
        "name": report.persona.name,
        "persona_path": str(persona_path.relative_to(root)).replace("\\", "/"),
        "source_format": report.source_format,
        "source_sha256": report.source_sha256,
        "identity_fingerprint": report.persona.identity_envelope.fingerprint,
        "persona_id": report.persona.identity_envelope.persona_id,
        "identity_version": report.persona.identity_envelope.version,
    }
    _atomic_json_write(registry_path, registry)
    return {
        **report.public_summary(),
        "saved": True,
        "activated": False,
        "restart_required": False,
    }


def list_imported_personas(persona_dir: Path) -> dict[str, Any]:
    """Return the local profile registry without exposing absolute paths."""

    root = Path(persona_dir).resolve()
    registry = _load_registry(root / "registry.json")
    profiles: list[dict[str, Any]] = []
    for profile_id, value in registry.get("profiles", {}).items():
        if not isinstance(value, dict):
            continue
        profiles.append({
            "id": str(profile_id),
            "name": _clean_text(value.get("name", ""), MAX_NAME_CHARS),
            "source_format": _clean_text(value.get("source_format", ""), 40),
            "source_sha256": _clean_text(value.get("source_sha256", ""), 64),
        })
    profiles.sort(key=lambda item: (item["name"].casefold(), item["id"]))
    return {
        "active_id": str(registry.get("active_id", "default")),
        "profiles": profiles,
    }


def _legacy_activate_imported_persona(persona_dir: Path, profile_id: str) -> dict[str, Any]:
    """Select an imported profile for the next process start."""

    raise CharacterCardImportError(
        "privileged_activation_required",
        "Legacy persona activation is disabled; use the privileged epoch transaction",
    )

    root = Path(persona_dir).resolve()
    registry_path = root / "registry.json"
    registry = _load_registry(registry_path)
    profile = registry.get("profiles", {}).get(str(profile_id))
    if not isinstance(profile, dict):
        raise CharacterCardImportError("profile_not_found", "找不到要启用的本地角色档案")
    relative = Path(str(profile.get("persona_path", "")))
    if relative.is_absolute() or ".." in relative.parts:
        raise CharacterCardImportError("unsafe_profile_path", "角色档案路径不安全")
    persona_path = (root / relative).resolve()
    try:
        persona_path.relative_to(root)
    except ValueError as exc:
        raise CharacterCardImportError("unsafe_profile_path", "角色档案越过了本地存储边界") from exc
    if not persona_path.is_file() or persona_path.is_symlink():
        raise CharacterCardImportError("profile_missing", "角色档案文件不存在或不是普通文件")
    try:
        from .persona_card import load_persona

        loaded_persona = load_persona(persona_path)
        persona_data = loaded_persona.to_dict()
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise CharacterCardImportError("profile_corrupt", "角色档案文件已经损坏") from exc
    if not isinstance(persona_data, dict) or not _clean_text(persona_data.get("name", ""), MAX_NAME_CHARS):
        raise CharacterCardImportError("profile_corrupt", "角色档案缺少有效名称")
    _atomic_json_write(root / "active.json", persona_data)
    registry["active_id"] = str(profile_id)
    _atomic_json_write(registry_path, registry)
    return {
        "ok": True,
        "active_id": str(profile_id),
        "name": _clean_text(persona_data.get("name", ""), MAX_NAME_CHARS),
        "restart_required": True,
    }


def _load_persona_file(path: Path, *, code: str = "profile_corrupt") -> Persona:
    if not path.is_file() or path.is_symlink():
        raise CharacterCardImportError(code, "Persona file is missing or is not a regular file")
    try:
        from .persona_card import load_persona

        persona = load_persona(path)
        persona.seal_identity()
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise CharacterCardImportError(code, "Persona file is corrupt") from exc
    if not _clean_text(persona.name, MAX_NAME_CHARS):
        raise CharacterCardImportError(code, "Persona file has no valid name")
    return persona


def _load_profile_persona(
    root: Path,
    registry: dict[str, Any],
    profile_id: str,
) -> tuple[Persona, dict[str, Any]]:
    profile = registry.get("profiles", {}).get(str(profile_id))
    if not isinstance(profile, dict):
        raise CharacterCardImportError("profile_not_found", "Local persona profile was not found")
    relative = Path(str(profile.get("persona_path", "")))
    if relative.is_absolute() or ".." in relative.parts:
        raise CharacterCardImportError("unsafe_profile_path", "Persona profile path is unsafe")
    persona_path = (root / relative).resolve()
    try:
        persona_path.relative_to(root)
    except ValueError as exc:
        raise CharacterCardImportError(
            "unsafe_profile_path",
            "Persona profile escaped the local storage boundary",
        ) from exc
    persona = _load_persona_file(persona_path)
    expected = str(profile.get("identity_fingerprint") or "")
    if expected and not hmac.compare_digest(
        persona.identity_envelope.fingerprint,
        expected,
    ):
        # Upgrade only an exact compiled built-in identity.  A v1 imported
        # profile cannot be upgraded safely because its old fingerprint did
        # not cover speaking style or daily-life fields.
        from .identity import legacy_v1_identity_fingerprint

        source_format = str(profile.get("source_format") or "")
        is_exact_builtin = (
            source_format in {"builtin", "builtin_legacy"}
            and expected in KNOWN_LEGACY_DEFAULT_FINGERPRINTS
            and hmac.compare_digest(legacy_v1_identity_fingerprint(persona), expected)
            and persona.to_dict() == default_persona().to_dict()
        )
        if is_exact_builtin:
            envelope = persona.identity_envelope
            profile["identity_fingerprint"] = envelope.fingerprint
            profile["persona_id"] = envelope.persona_id
            profile["identity_version"] = envelope.version
            _atomic_json_write(root / "registry.json", registry)
        else:
            raise CharacterCardImportError(
                "identity_fingerprint_mismatch",
                "Persona profile no longer matches its sealed identity",
            )
    return persona, profile


def load_imported_persona(persona_dir: Path, profile_id: str) -> Persona:
    """Load and fingerprint-check one imported persona without activating it."""

    root = Path(persona_dir).resolve()
    registry = _load_registry(root / "registry.json")
    persona, _profile = _load_profile_persona(root, registry, str(profile_id))
    return persona


def activate_imported_persona(
    persona_dir: Path,
    profile_id: str,
    *,
    expected_fingerprint: str = "",
) -> dict[str, Any]:
    """Commit one selected persona through a single authoritative pointer.

    ``registry.json`` is the commit point.  ``active.json`` remains a
    compatibility cache and is refreshed only after that pointer commits.
    """

    root = Path(persona_dir).resolve()
    registry_path = root / "registry.json"
    registry = _load_registry(registry_path)
    persona, profile = _load_profile_persona(root, registry, str(profile_id))
    envelope = persona.identity_envelope
    if expected_fingerprint and not hmac.compare_digest(
        envelope.fingerprint,
        str(expected_fingerprint),
    ):
        raise CharacterCardImportError(
            "identity_conflict",
            "Persona profile changed after confirmation",
        )
    from .identity import require_authorized_identity_commit

    require_authorized_identity_commit(persona)

    profile["identity_fingerprint"] = envelope.fingerprint
    profile["persona_id"] = envelope.persona_id
    profile["identity_version"] = envelope.version
    registry["active_id"] = str(profile_id)
    _atomic_json_write(registry_path, registry)

    warning = ""
    try:
        _atomic_json_write(root / "active.json", persona.to_dict())
    except OSError as exc:
        # The authoritative pointer already committed.  Reporting success is
        # intentional: retrying the privileged operation could create a second
        # epoch for the same durable identity.
        warning = f"active persona cache not refreshed: {type(exc).__name__}"
    return {
        "ok": True,
        "active_id": str(profile_id),
        "name": persona.name,
        "persona_id": envelope.persona_id,
        "identity_fingerprint": envelope.fingerprint,
        "identity_version": envelope.version,
        "restart_required": True,
        **({"warning": warning} if warning else {}),
    }


def initialize_default_persona(persona_dir: Path, persona: Persona) -> Persona:
    """Create the first authoritative identity without trusting a loose cache.

    This is intentionally valid only for an empty identity store.  An
    ``active.json`` without a matching registry record may be a legacy file or
    a tampering attempt; silently blessing it would turn startup into an
    unprivileged identity-update path.
    """

    root = Path(persona_dir).resolve()
    registry_path = root / "registry.json"
    active_path = root / "active.json"
    registry = _load_registry(registry_path)
    profiles = registry.setdefault("profiles", {})
    if active_path.exists() or profiles or str(registry.get("active_id") or "default") != "default":
        raise CharacterCardImportError(
            "identity_store_not_empty",
            "Refusing to initialize a default persona over existing identity state",
        )

    persona.seal_identity()
    envelope = persona.identity_envelope
    profile_id = "default"
    profile_dir = root / "imported" / profile_id
    persona_path = profile_dir / "persona.json"
    _atomic_json_write(persona_path, persona.to_dict())
    profiles[profile_id] = {
        "id": profile_id,
        "name": persona.name,
        "persona_path": str(persona_path.relative_to(root)).replace("\\", "/"),
        "source_format": "builtin",
        "source_sha256": "",
        "identity_fingerprint": envelope.fingerprint,
        "persona_id": envelope.persona_id,
        "identity_version": envelope.version,
    }
    registry["active_id"] = profile_id
    _atomic_json_write(registry_path, registry)
    try:
        _atomic_json_write(active_path, persona.to_dict())
    except OSError:
        # The registry and its immutable profile are sufficient to boot.  A
        # compatibility-cache failure cannot roll back the committed identity.
        pass
    return persona


def migrate_known_legacy_default_persona(persona_dir: Path) -> Persona:
    """Register only a byte-semantically known pre-registry built-in identity."""

    root = Path(persona_dir).resolve()
    registry_path = root / "registry.json"
    registry = _load_registry(registry_path)
    active_id = str(registry.get("active_id") or "default")
    profiles = registry.setdefault("profiles", {})
    if active_id != "default" or isinstance(profiles.get("default"), dict):
        raise CharacterCardImportError(
            "legacy_migration_conflict",
            "Legacy identity migration conflicts with an existing active registry entry",
        )
    active_path = root / "active.json"
    persona = _load_persona_file(active_path, code="legacy_identity_corrupt")
    from .identity import legacy_v1_identity_fingerprint

    envelope = persona.identity_envelope
    legacy_fingerprint = legacy_v1_identity_fingerprint(persona)
    expected_default = default_persona().to_dict()
    expected_default["identity"].pop("persona_id", None)
    expected_default["identity"].pop("identity_version", None)
    if (
        legacy_fingerprint not in KNOWN_LEGACY_DEFAULT_FINGERPRINTS
        or persona.to_dict() != expected_default
    ):
        raise CharacterCardImportError(
            "legacy_identity_unrecognized",
            "Loose active persona does not match a known shipped identity; explicit owner confirmation is required",
        )

    persona_path = root / "imported" / "default" / "persona.json"
    _atomic_json_write(persona_path, persona.to_dict())
    profiles["default"] = {
        "id": "default",
        "name": persona.name,
        "persona_path": str(persona_path.relative_to(root)).replace("\\", "/"),
        "source_format": "builtin_legacy",
        "source_sha256": "",
        "identity_fingerprint": envelope.fingerprint,
        "persona_id": envelope.persona_id,
        "identity_version": envelope.version,
    }
    registry["active_id"] = "default"
    _atomic_json_write(registry_path, registry)
    return persona


def load_active_persona(persona_dir: Path) -> Persona | None:
    """Resolve the authoritative active identity and fail closed on tampering."""

    root = Path(persona_dir).resolve()
    registry = _load_registry(root / "registry.json")
    active_id = str(registry.get("active_id") or "default")
    active_path = root / "active.json"
    profile = registry.get("profiles", {}).get(active_id)
    if not isinstance(profile, dict):
        if not active_path.exists() and not registry.get("profiles"):
            return None
        raise CharacterCardImportError(
            "active_profile_missing",
            "Selected persona is missing from the authoritative local registry",
        )
    expected = str(profile.get("identity_fingerprint") or "")
    if not expected:
        raise CharacterCardImportError(
            "registry_identity_unsealed",
            "Selected persona has no sealed identity fingerprint",
        )

    authoritative_error: CharacterCardImportError | None = None
    try:
        persona, loaded_profile = _load_profile_persona(root, registry, active_id)
        expected = str(loaded_profile.get("identity_fingerprint") or expected)
    except CharacterCardImportError as exc:
        authoritative_error = exc
        persona = None

    cached: Persona | None = None
    if active_path.exists():
        cached = _load_persona_file(active_path, code="active_cache_corrupt")
        if not hmac.compare_digest(cached.identity_envelope.fingerprint, expected):
            raise CharacterCardImportError(
                "active_cache_conflict",
                "Active persona cache conflicts with the authoritative sealed identity",
            )

    if persona is not None:
        return persona
    if cached is not None:
        # A cache is only a continuity copy after its fingerprint has been
        # proven against the authoritative registry record.
        return cached
    assert authoritative_error is not None
    raise authoritative_error


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CharacterCardImportError("duplicate_key", f"JSON 含重复字段：{key}")
        if key in _DANGEROUS_KEYS:
            raise CharacterCardImportError("dangerous_key", f"JSON 含危险字段：{key}")
        result[key] = value
    return result


def _reject_non_finite(value: str) -> None:
    raise CharacterCardImportError("non_finite_number", f"JSON 不允许非常规数字：{value}")


def _validate_shape(value: Any) -> None:
    count = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        if depth > MAX_CONTAINER_DEPTH:
            raise CharacterCardImportError("too_deep", "角色卡结构嵌套过深")
        count += 1
        if count > MAX_CONTAINER_ITEMS:
            raise CharacterCardImportError("too_many_items", "角色卡结构项目过多")
        if isinstance(current, dict):
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)


def _validate_card_fields(data: dict[str, Any], source_format: str) -> None:
    expected: dict[str, type] = {field_name: str for field_name in _REQUIRED_V1_FIELDS}
    if source_format in {"chara_card_v2", "chara_card_v3"}:
        expected.update(_V2_REQUIRED_TYPES)
    if source_format == "chara_card_v3":
        expected["group_only_greetings"] = list

    missing = [field_name for field_name in expected if field_name not in data]
    if missing:
        raise CharacterCardImportError(
            "missing_fields",
            "角色卡缺少必要字段：" + "、".join(missing),
        )
    wrong_types = [
        field_name
        for field_name, expected_type in expected.items()
        if not isinstance(data.get(field_name), expected_type)
    ]
    if wrong_types:
        raise CharacterCardImportError(
            "invalid_field_type",
            "角色卡字段类型错误：" + "、".join(wrong_types),
        )

    list_fields: tuple[str, ...] = ()
    if source_format in {"chara_card_v2", "chara_card_v3"}:
        list_fields = ("alternate_greetings", "tags")
    if source_format == "chara_card_v3":
        list_fields += ("group_only_greetings", "source")
    for field_name in list_fields:
        value = data.get(field_name)
        if value is not None and (
            not isinstance(value, list) or any(not isinstance(item, str) for item in value)
        ):
            raise CharacterCardImportError(
                "invalid_field_type",
                f"角色卡字段 {field_name} 必须是字符串数组",
            )
    for field_name in ("character_book",):
        value = data.get(field_name)
        if value is not None and not isinstance(value, dict):
            raise CharacterCardImportError(
                "invalid_field_type",
                f"角色卡字段 {field_name} 必须是对象",
            )
    if source_format == "chara_card_v3":
        value = data.get("assets")
        if value is not None and not isinstance(value, list):
            raise CharacterCardImportError(
                "invalid_field_type",
                "角色卡字段 assets 必须是数组",
            )
        nickname = data.get("nickname")
        if nickname is not None and not isinstance(nickname, str):
            raise CharacterCardImportError("invalid_field_type", "角色卡字段 nickname 必须是字符串")
        multilingual = data.get("creator_notes_multilingual")
        if multilingual is not None and (
            not isinstance(multilingual, dict)
            or any(not isinstance(key, str) or not isinstance(item, str) for key, item in multilingual.items())
        ):
            raise CharacterCardImportError(
                "invalid_field_type",
                "角色卡字段 creator_notes_multilingual 必须是字符串映射",
            )


def _unsafe_instruction_flags(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", str(text))
    normalized = _BIDI_AND_INVISIBLE.sub("", normalized)
    return [name for name, pattern in _UNSAFE_PROFILE_PATTERNS if pattern.search(normalized)]


def _clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFC", value)
    text = _BIDI_AND_INVISIBLE.sub("", text)
    text = _CONTROL.sub(" ", text)
    return text.strip()[:limit]


def _clean_string_list(value: Any, limit: int, item_limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value[:limit]:
        cleaned = _clean_text(item, item_limit)
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result


def _replace_macros(text: str, character_name: str) -> str:
    return (
        text.replace("{{char}}", character_name)
        .replace("{{Char}}", character_name)
        .replace("{{user}}", "用户")
        .replace("{{User}}", "用户")
    )


def _extract_traits(text: str) -> list[str]:
    parts = re.split(r"[\n,，;；。.!！?？]+", text)
    result: list[str] = []
    for part in parts:
        cleaned = part.strip(" -*#\t")[:160]
        if 2 <= len(cleaned) <= 160 and cleaned not in result:
            result.append(cleaned)
        if len(result) >= 24:
            break
    return result


def _extract_age_and_birthday(text: str) -> tuple[int, str, bool]:
    birthday = ""
    birthday_match = re.search(
        r"(?:生日|birthday|date of birth)\s*[:：]?\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?",
        text,
        flags=re.IGNORECASE,
    )
    if birthday_match:
        try:
            born = date(*(int(part) for part in birthday_match.groups()))
            birthday = born.isoformat()
        except ValueError:
            birthday = ""

    age_match = re.search(
        r"(?:年龄|age)\s*[:：]?\s*(\d{1,3})(?:\s*(?:岁|years?\s+old))?|(?<!\d)(\d{1,3})\s*岁",
        text,
        flags=re.IGNORECASE,
    )
    age = 18
    if age_match:
        candidate = int(age_match.group(1) or age_match.group(2))
        if 1 <= candidate <= 150:
            age = candidate
            return age, birthday, False
    if birthday:
        born = date.fromisoformat(birthday)
        today = date.today()
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        return max(1, age), birthday, False
    return age, "", True


def _infer_gender(tags: list[str], text: str) -> tuple[str, bool]:
    corpus = " ".join(tags).lower()
    if re.search(r"(?:^|\W)(female|woman|girl)(?:$|\W)", corpus) or "女性" in text or "女生" in text:
        return "female", False
    if re.search(r"(?:^|\W)(male|man|boy)(?:$|\W)", corpus) or "男性" in text or "男生" in text:
        return "male", False
    if "non-binary" in corpus or "非二元" in text:
        return "non-binary", False
    return "unspecified", True


def _load_registry_lenient(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 1, "active_id": "default", "profiles": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("profiles", {}), dict):
            return value
    except (OSError, json.JSONDecodeError):
        pass
    return {"schema_version": 1, "active_id": "default", "profiles": {}}


def _load_registry(path: Path) -> dict[str, Any]:
    """Read the identity registry without silently resetting corrupt state."""

    if not path.exists():
        return {"schema_version": 1, "active_id": "default", "profiles": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CharacterCardImportError(
            "registry_corrupt",
            "Local persona registry is unreadable; refusing to guess an identity",
        ) from exc
    if not isinstance(value, dict) or not isinstance(value.get("profiles", {}), dict):
        raise CharacterCardImportError(
            "registry_corrupt",
            "Local persona registry has an invalid structure",
        )
    return value


def _atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
