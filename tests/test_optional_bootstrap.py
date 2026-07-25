import asyncio
import os
import subprocess
import sys
from pathlib import Path

from src.bootstrap import OPTIONAL_CAPABILITY_MODULES, build_optional_capability_registry
from src.chat.session import ChatSession
from src.config.settings import FeatureSettings
from src.emotion.system import EmotionSystem
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import default_persona
from src.relationship.tracker import RelationshipTracker


class LocalMemory:
    def __init__(self) -> None:
        self.queries = []

    def retrieve_relevant(self, query):
        self.queries.append(query)
        return []


class UnexpectedProvider:
    async def chat(self, *_args, **_kwargs):
        raise AssertionError("identity-safe local chat must not call a provider")


def test_all_registered_optional_import_failures_leave_identity_and_local_chat_working(
    monkeypatch,
) -> None:
    import src.config.capabilities as capability_module

    blocked = set(OPTIONAL_CAPABILITY_MODULES.values())
    real_import_module = capability_module.importlib.import_module

    def import_blocker(name, package=None):
        if name in blocked:
            raise ModuleNotFoundError(f"injected missing optional module: {name}", name=name)
        return real_import_module(name, package)

    monkeypatch.setattr(capability_module.importlib, "import_module", import_blocker)

    persona = default_persona()
    epochs = PersonaEpochRegistry()
    persona_token = epochs.activate_initial(persona)
    registry = build_optional_capability_registry(identity_provider=epochs.envelope)

    for capability in OPTIONAL_CAPABILITY_MODULES:
        assert registry.start(capability) is None
    assert all(
        item["state"] == "unavailable"
        for item in registry.status().values()
    )
    assert registry.identity_snapshot().fingerprint == persona_token.fingerprint
    assert epochs.is_current(persona_token)

    local_memory = LocalMemory()
    session = ChatSession(
        persona=persona,
        adapter=UnexpectedProvider(),  # type: ignore[arg-type]
        memory=local_memory,  # type: ignore[arg-type]
        emotion=EmotionSystem(),
        relationship=RelationshipTracker(),
        feature_settings=FeatureSettings(emotion_system_enabled=False),
    )
    result = asyncio.run(session.send_message("你是不是AI？"))

    assert result["reply"]
    assert result["guard_reasons"] == ["identity_probe"]
    assert local_memory.queries == []
    assert [item["role"] for item in session._history] == ["user", "assistant"]
    assert epochs.is_current(persona_token)


def test_main_import_and_cloud_fallback_survive_real_cloud_import_blocker() -> None:
    project_root = Path(__file__).resolve().parents[1]
    script = r'''
import importlib.abc
import sys

class CloudBlocker(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "src.cloud" or fullname.startswith("src.cloud."):
            raise ModuleNotFoundError(
                "injected missing cloud package",
                name=fullname,
            )
        return None

sys.meta_path.insert(0, CloudBlocker())
import src.main
cloud = src.main.create_cloud_service_or_local("cloud")
assert cloud.get_status() == "local"
assert cloud.reason.startswith("ModuleNotFoundError")
'''
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"

    completed = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=project_root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr


def test_real_main_bootstrap_reaches_handoff_with_optional_modules_deleted(tmp_path) -> None:
    project_root = Path(__file__).resolve().parents[1]
    script = r'''
import asyncio
import importlib.abc
import sys

BLOCKED = (
    "src.api",
    "src.chat",
    "src.emotion",
    "src.memory",
    "src.relationship",
    "src.chat.proactive",
    "src.diary",
    "src.timeline",
    "src.web",
    "src.social",
    "src.interest",
    "src.affairs",
    "src.ambient",
    "src.keepsakes",
    "src.stickers",
    "src.immersion",
)

class OptionalModuleBlocker(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if any(fullname == item or fullname.startswith(item + ".") for item in BLOCKED):
            raise ModuleNotFoundError(
                "injected deleted optional module: " + fullname,
                name=fullname,
            )
        return None

sys.meta_path.insert(0, OptionalModuleBlocker())
sys.argv = ["reverie", "--bootstrap-smoke"]
from src.main import main
asyncio.run(main())
'''
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    environment["REVERIE_DATA_DIR"] = str(tmp_path / "smoke-data")

    completed = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=project_root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
