from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" / "src"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_default_pytest_boundary_only_collects_first_party_tests() -> None:
    pytest_config = _text(ROOT / "pytest.ini")
    pyproject = _text(ROOT / "pyproject.toml")

    assert "testpaths =\n    tests" in pytest_config
    for reference_tree in ("frontend", "N.E.K.O"):
        assert f"    {reference_tree}" in pytest_config
    for removed_tree in ("risuai_ref", "src/neko_core"):
        assert f"    {removed_tree}" not in pytest_config
        tree = ROOT / removed_tree
        assert not tree.exists() or not any(path.is_file() for path in tree.rglob("*"))
    assert "[tool.pytest.ini_options]" not in pyproject


def test_production_entry_mounts_one_mvp_shell_without_a_router() -> None:
    entry = _text(FRONTEND / "index.tsx")
    assert "components/MvpRoom" in entry
    # DreamRoom is reachable only through the switchable her-room view.
    assert "DreamRoom" in entry
    for retired in (
        "react-router",
        "ReverieMain",
        "components/Shell",
        "components/ChatPanel",
    ):
        assert retired not in entry


def test_mvp_room_cannot_create_a_browser_fact_source() -> None:
    production_files = (
        *tuple((FRONTEND / "components" / "MvpRoom").glob("*.ts*")),
        FRONTEND / "hooks" / "useMvpBridge.ts",
    )
    offenders = [
        path.relative_to(ROOT).as_posix()
        for path in production_files
        if "localStorage.setItem" in _text(path)
        or "sessionStorage.setItem" in _text(path)
    ]
    assert offenders == []

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
    python_sources = list((ROOT / "src").rglob("*.py"))
    merged = "\n".join(_text(path) for path in python_sources)
    assert "src.neko_core" not in merged
    assert 'DATA_DIR / "lorebook.json"' not in merged

    runtime = _text(ROOT / "frontend" / "script" / "production-runtime.cjs")
    assert "'neko_core'" not in runtime
    assert "'lorebook'" in runtime


def test_framed_production_transport_requires_v4_commands() -> None:
    supervisor = _text(ROOT / "frontend" / "electron" / "framed-bridge-supervisor.cjs")
    bridge = _text(ROOT / "src" / "bridge" / "stdio_bridge.py")
    assert "reverie.command.v4" in supervisor
    assert "protocol_version: 4" in supervisor
    assert "CommandEnvelopeV4.model_validate" in bridge
    assert 'protocol_version=4' in bridge
    assert "bridge-supervisor.cjs" not in _text(
        ROOT / "frontend" / "electron" / "framed-bridge-supervisor.cjs"
    )
    assert "import.meta.env.DEV" in _text(
        FRONTEND / "hooks" / "useMvpBridge.ts"
    )


def test_mvp_shell_has_no_platform_or_custom_avatar_import_graph() -> None:
    shell = _text(FRONTEND / "components" / "MvpRoom" / "index.tsx")
    character = _text(FRONTEND / "components" / "MvpRoom" / "BundledCharacter.tsx")
    merged = shell + character
    for retired in (
        "MiniGamePanel",
        "ArchivePanels",
        "AvatarStage",
        "imageGen",
        "focusSound",
        "beginImport",
        "setActive",
        "yumi-default-transparent",
    ):
        assert retired not in merged
    assert "character?.get()" in character


def test_electron_runtime_does_not_duplicate_corresponding_source_maps() -> None:
    vite = _text(ROOT / "frontend" / "vite.config.ts")
    assert "sourcemap: isElectronBuild ? false : isProd" in vite


def test_packaged_storage_key_uses_dpapi_and_a_private_bootstrap_pipe() -> None:
    electron = _text(ROOT / "frontend" / "electron" / "main.js")
    vault = _text(ROOT / "frontend" / "electron" / "storage-key-vault.cjs")
    storage = _text(ROOT / "src" / "storage" / "encrypted_sqlite.py")
    runtime_requirements = _text(ROOT / "requirements-runtime.lock")

    assert "new StorageKeyVault" in electron
    assert "REVERIE_REQUIRE_ENCRYPTED_STORAGE: '1'" in electron
    assert "REVERIE_STORAGE_KEY_FD: '3'" in electron
    assert "stdio: ['pipe', 'pipe', 'pipe', 'pipe']" in electron
    assert "safeStorage.encryptString" in vault
    assert "keyHex" not in electron
    assert "PRAGMA key" in storage
    assert "sqlcipher_export" in storage
    assert "refusing a plaintext fallback" in storage
    assert "sqlcipher3==0.6.2" in runtime_requirements
    assert "connect_database(self.path" in _text(ROOT / "src" / "api" / "budget.py")
