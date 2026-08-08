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
        "src.ambient",
        "src.archive",
        "src.backup",
        "src.diary",
        "src.interest",
        "src.notifications",
        "src.timeline",
        "src.web",
        "src.work_manager",
    }
    assert imported.isdisjoint(forbidden)


def test_packager_omits_every_non_mvp_python_capability() -> None:
    source = (
        PROJECT_ROOT / "frontend" / "script" / "production-runtime.cjs"
    ).read_text(encoding="utf-8")
    for module in (
        "affairs",
        "ambient",
        "archive",
        "backup",
        "diary",
        "interest",
        "notifications",
        "timeline",
        "web",
        "work_manager",
    ):
        assert f"'{module}'" in source


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
