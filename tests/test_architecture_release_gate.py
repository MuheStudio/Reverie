from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" / "src"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_production_router_has_one_shell_and_no_legacy_imports() -> None:
    router = _text(FRONTEND / "routers" / "index.tsx")
    assert "DreamRoom" in router
    assert "ReverieMain" not in router
    assert "components/Shell" not in router
    assert "components/ChatPanel" not in router


def test_dream_room_cannot_create_a_browser_fact_source() -> None:
    production_files = tuple((FRONTEND / "components" / "DreamRoom").glob("*.ts*"))
    offenders = [
        path.relative_to(ROOT).as_posix()
        for path in production_files
        if "localStorage.setItem" in _text(path)
        or "sessionStorage.setItem" in _text(path)
    ]
    assert offenders == []

    # Retired facts may be read and deleted only by explicit one-way migration
    # adapters. They may never be written back into browser storage.
    for relative in (
        "frontend/src/lib/reverieArchive.ts",
        "frontend/src/lib/llmClient.ts",
        "frontend/src/lib/imageGenClient.ts",
    ):
        source = _text(ROOT / relative)
        assert "localStorage.setItem" not in source


def test_renderer_has_no_loopback_websocket_or_bridge_secret() -> None:
    sources = [
        path
        for path in FRONTEND.rglob("*")
        if path.suffix in {".ts", ".tsx"} and "__tests__" not in path.parts
    ]
    merged = "\n".join(_text(path) for path in sources)
    assert "ws://127.0.0.1" not in merged
    assert "REVERIE_BRIDGE_SECRET" not in merged
    assert "REVERIE_WS_SECRET" not in merged


def test_retired_reference_projects_and_worldbook_file_are_not_runtime_dependencies() -> None:
    python_sources = [
        path
        for path in (ROOT / "src").rglob("*.py")
        if "neko_core" not in path.parts
    ]
    merged = "\n".join(_text(path) for path in python_sources)
    assert "src.neko_core" not in merged
    assert 'DATA_DIR / "lorebook.json"' not in merged

    runtime = _text(ROOT / "frontend" / "script" / "production-runtime.cjs")
    assert "'neko_core'" in runtime
    assert "'lorebook'" in runtime


def test_framed_production_transport_requires_v3_commands() -> None:
    supervisor = _text(ROOT / "frontend" / "electron" / "framed-bridge-supervisor.cjs")
    bridge = _text(ROOT / "src" / "bridge" / "stdio_bridge.py")
    assert "reverie.command.v3" in supervisor
    assert "protocol_version: 3" in supervisor
    assert "CommandEnvelopeV3.model_validate" in bridge
    assert 'protocol_version=3' in bridge
    assert "bridge-supervisor.cjs" not in _text(
        ROOT / "frontend" / "electron" / "framed-bridge-supervisor.cjs"
    )
    assert "import.meta.env.DEV" in _text(
        FRONTEND / "hooks" / "useReverieWS.ts"
    )


def test_avatar_and_optional_views_are_not_in_the_initial_bundle_graph() -> None:
    shell = _text(FRONTEND / "components" / "DreamRoom" / "index.tsx")
    character = _text(FRONTEND / "components" / "DreamRoom" / "CharacterStage.tsx")
    assert "React.lazy(() => import('./MiniGamePanel'))" in shell
    assert "import('./ArchivePanels')" in shell
    assert "lazy(() => import('./AvatarStage'))" in character


def test_electron_runtime_does_not_duplicate_corresponding_source_maps() -> None:
    vite = _text(ROOT / "frontend" / "vite.config.ts")
    assert "sourcemap: isElectronBuild ? false : isProd" in vite
