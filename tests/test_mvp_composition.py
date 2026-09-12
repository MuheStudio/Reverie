from __future__ import annotations

import ast
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_desktop_composition_root_does_not_import_non_mvp_capabilities() -> None:
    source = (PROJECT_ROOT / "src" / "mvp_runtime.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)

    forbidden = {
        "src.affairs",
        "src.interest",
        "src.notifications",
        "src.timeline",
        "src.work_manager",
    }
    assert imported.isdisjoint(forbidden)


def test_packager_omits_every_non_mvp_python_capability() -> None:
    source = (
        PROJECT_ROOT / "frontend" / "script" / "production-runtime.cjs"
    ).read_text(encoding="utf-8")
    for module in (
        "affairs",
        "interest",
        "timeline",
        "work_manager",
    ):
        assert f"'{module}'" in source


def test_packager_ships_the_core_companion_artifacts() -> None:
    """Diary, stickers, game persistence, the social circle, keepsakes, the
    persona-scoped archive, the world book matcher and native backup are MVP
    capabilities — the composition root constructs them and the packaged
    runtime must therefore contain their source."""
    source = (
        PROJECT_ROOT / "frontend" / "script" / "production-runtime.cjs"
    ).read_text(encoding="utf-8")
    for module in (
        "diary", "games", "immersion", "notifications", "stickers",
        "social", "keepsakes", "web", "ambient", "archive", "lorebook",
        "backup",
    ):
        assert f"'{module}'" not in source
    runtime = (PROJECT_ROOT / "src" / "mvp_runtime.py").read_text(encoding="utf-8")
    assert "from src.diary import DiaryManager" in runtime
    assert "from src.stickers import StickerManager" in runtime
    assert "from src.social.universe import SocialUniverse" in runtime
    assert "from src.keepsakes import KeepsakeManager" in runtime
    assert "from src.web import WebSurfingManager" in runtime
    assert "from src.ambient import ThoughtOfYouEngine" in runtime
    assert "from src.archive import ArchiveStore" in runtime
    assert "from src.lorebook import LorebookManager" in runtime
    assert "from src.backup import LocalBackupManager" in runtime
    assert "lorebook_mgr=lorebook_mgr" in runtime
    assert "archive_store=archive_store" in runtime
    assert "backup_manager=backup_manager" in runtime


def test_new_user_never_inherits_the_historical_developer_profile() -> None:
    runtime = (PROJECT_ROOT / "src" / "mvp_runtime.py").read_text(encoding="utf-8")
    assert "ensure_default_profile()" not in runtime


def test_onboarding_marks_completion_only_after_profile_acknowledgement() -> None:
    bridge = (
        PROJECT_ROOT / "frontend" / "src" / "hooks" / "useMvpBridge.ts"
    ).read_text(encoding="utf-8")
    function = bridge[
        bridge.index("const completeOnboarding"):
        bridge.index("  return {", bridge.index("const completeOnboarding"))
    ]
    profile = function.index("await requestResult(\n        'user:profile:update'")
    completion = function.index("await requestResult(\n        'settings:update'")
    assert profile < completion
    assert "savedProfile.error" in function
    assert "completed.ok !== true" in function
    assert "section: 'ui'" in function


def test_completed_onboarding_ignores_late_in_progress_writes() -> None:
    source = (PROJECT_ROOT / "src" / "bridge" / "ws_bridge.py").read_text(
        encoding="utf-8",
    )
    assert 'ignored": "onboarding_progress"' in source
    assert "already_complete" in source


def test_stdio_bridge_starts_room_life_loops() -> None:
    source = (PROJECT_ROOT / "src" / "bridge" / "stdio_bridge.py").read_text(
        encoding="utf-8",
    )
    assert "_runtime_activity_loop" in source
    assert "_proactive_broadcast_loop" in source
    assert "MsgType.RUNTIME_ACTIVITY" in source
