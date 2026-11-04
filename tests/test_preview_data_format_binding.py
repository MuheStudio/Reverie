"""Source-only binding of durable format declarations to the workspace number.

These checks never import application modules, open user data, launch a helper,
or infer migration success. A new workspace number needs a reviewed new table.
"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def capture(relative: str, expression: str) -> str:
    match = re.search(expression, source(relative))
    assert match is not None, f"Missing format declaration: {relative}: {expression}"
    return match.group(1)


def literal(relative: str, name: str) -> str:
    return capture(relative, rf"\b{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]")


def numbered_schemas(relative: str, prefix: str) -> tuple[str, ...]:
    return tuple(sorted(set(re.findall(re.escape(prefix) + r"\d+", source(relative)))))


def current_bindings() -> dict:
    avatar = "frontend/electron/avatar-manager.cjs"
    voice = "src/tts/workers/gpt_sovits.py"
    return {
        "kernel": capture("src/kernel/storage.py", r"KERNEL_SCHEMA_VERSION\s*=\s*(\d+)"),
        "archive": capture("src/archive/store.py", r"ARCHIVE_SCHEMA_VERSION\s*=\s*(\d+)"),
        "games": capture("src/games/state_store.py", r'PRAGMA user_version\s*=\s*(\d+)'),
        "summary_component": capture("src/conversation_summary/store.py", r"versions != \[(\d+)\]"),
        "summary_algorithm": literal("src/conversation_summary/engine.py", "CONTRACT_VERSION"),
        "restore_intent": capture("src/world_state_store.py", r"INTENT_VERSION\s*=\s*(\d+)"),
        "persona_scope": literal("src/persona/state_scope.py", "_SCHEMA"),
        "backup_current": literal("src/backup_inspection.py", "BACKUP_SCHEMA"),
        "backup_accepted": numbered_schemas("src/backup_inspection.py", "reverie.full_local_backup.v"),
        "backup_sections": tuple(sorted(set(re.findall(r'reverie\.(?:ambient_presence|thought_of_you|diary_keys|user_phrase_alignment|social_universe)\.v\d+', source("src/backup.py"))))),
        "voice_active": literal(voice, "ACTIVE_SCHEMA"),
        "voice_manifest": literal(voice, "MANIFEST_SCHEMA"),
        "voice_runtime": literal(voice, "RUNTIME_VERSION"),
        "avatar_import": literal(avatar, "CANDIDATE_SCHEMA"),
        "avatar_motion_import": literal(avatar, "MOTION_CANDIDATE_SCHEMA"),
        "avatar_manifest": literal(avatar, "MANIFEST_SCHEMA"),
        "avatar_active": literal(avatar, "ACTIVE_SCHEMA"),
        "live2d_min": capture(avatar, r"version < (\d+)"),
        "live2d_max": capture(avatar, r"version > (\d+)"),
        "live2d_motion": capture(avatar, r"Number\(motion\?\.Version\) !== (\d+)"),
        "glb_header": capture(avatar, r"buffer\.readUInt32LE\(4\) !== (\d+)"),
        "gltf_asset": capture(avatar, r"json\?\.asset\?\.version !== '([^']+)'"),
        "vrma_spec": capture(avatar, r"!/([^/]+)/i\.test\(specVersion\)"),
        "snapshots_accepted": numbered_schemas("native-ui/src/PreviewSnapshot.cpp", "reverie.preview.snapshot.v"),
        "ready_candidate": numbered_schemas("native-ui/src/PreviewSnapshot.cpp", "reverie.preview.ready-candidate.v"),
        "restore_transaction": numbered_schemas("native-ui/src/PreviewRestore.cpp", "reverie.preview.restore-transaction.v"),
        "restore_source": numbered_schemas("native-ui/src/PreviewRestore.cpp", "reverie.preview.restore-source.v"),
        "preview_events": numbered_schemas("native-ui/src/PreviewEvents.cpp", "reverie.qt.preview-event.v"),
        "installed_runtime": literal("native-ui/preview-runtime.cjs", "SCHEMA"),
        "installed_manifest": literal("native-ui/preview-runtime.cjs", "MANIFEST_SCHEMA"),
        "data_record": literal("native-ui/src/PreviewDataFormat.h", "Schema"),
    }


BINDINGS_BY_WORKSPACE_FORMAT = {
    1: {
        "kernel": "3", "archive": "1", "games": "1", "summary_component": "1",
        "summary_algorithm": "reverie.conversation-summary.v1", "restore_intent": "1",
        "persona_scope": "reverie.persona-state.v1", "backup_current": "reverie.full_local_backup.v3",
        "backup_accepted": ("reverie.full_local_backup.v1", "reverie.full_local_backup.v2", "reverie.full_local_backup.v3"),
        "backup_sections": ("reverie.ambient_presence.v1", "reverie.diary_keys.v1", "reverie.social_universe.v1", "reverie.thought_of_you.v1", "reverie.user_phrase_alignment.v1"),
        "voice_active": "reverie.voice-pack-active.v1", "voice_manifest": "reverie.voice-pack.v1", "voice_runtime": "v2",
        "avatar_import": "reverie.avatar-import.v1", "avatar_motion_import": "reverie.avatar-motion-import.v1",
        "avatar_manifest": "reverie.avatar.v1", "avatar_active": "reverie.avatar-active.v1",
        "live2d_min": "3", "live2d_max": "4", "live2d_motion": "3", "glb_header": "2", "gltf_asset": "2.0",
        "vrma_spec": r"^1(?:\.0)?(?:-draft)?$",
        "snapshots_accepted": ("reverie.preview.snapshot.v1", "reverie.preview.snapshot.v2"),
        "ready_candidate": ("reverie.preview.ready-candidate.v1",),
        "restore_transaction": ("reverie.preview.restore-transaction.v1",),
        "restore_source": ("reverie.preview.restore-source.v1",),
        "preview_events": ("reverie.qt.preview-event.v1",),
        "installed_runtime": "reverie.qt.preview-runtime.v1", "installed_manifest": "reverie.qt.preview-manifest.v1",
        "data_record": "reverie.preview.data-format.v1",
    },
}


def test_durable_format_changes_require_a_reviewed_workspace_format_number() -> None:
    number = int(capture("native-ui/src/PreviewDataFormat.h", r"\bCurrent\s*=\s*(\d+)"))
    assert number in BINDINGS_BY_WORKSPACE_FORMAT, "Add a reviewed durable-format table for the new workspace format"
    assert current_bindings() == BINDINGS_BY_WORKSPACE_FORMAT[number], "Durable formats changed without updating the workspace format binding"


def test_host_installer_and_builder_declare_the_same_workspace_format() -> None:
    number = capture("native-ui/src/PreviewDataFormat.h", r"\bCurrent\s*=\s*(\d+)")
    assert capture("native-ui/preview-runtime.cjs", r"SUPPORTED_DATA_FORMAT\s*=\s*(\d+)") == number
    assert capture("script/build-qt-macos.cjs", r"supportedDataFormat:\s*(\d+)") == number
    assert literal("native-ui/preview-runtime.cjs", "WORKSPACE_CONTROL_CONTRACT") == "v1"
    assert "workspaceControlContract: 'v1'" in source("script/build-qt-macos.cjs")
