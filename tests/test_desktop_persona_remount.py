"""The real desktop composition stays writable when one persona is mounted twice.

Regression for the persona r2 lock: switching back to a persona remounted its
memory, re-enqueued fold jobs whose dedupe keys already existed, and the
encrypted connection's IntegrityError escaped into recovery_required. A cold
start took the same path. This runs src.main's desktop composition root and the
real identity transaction in a subprocess with an isolated data directory and
an ephemeral key; the evidence file holds metadata only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EVENTS = "events.jsonl"


def synthetic_card() -> str:
    # Every V2 field the importer requires, with the quarantined ones empty.
    return json.dumps(
        {
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": "回归人格·晴",
                "description": "年龄：24。只在隔离回归测试中出现的合成角色。",
                "personality": "安静，认真",
                "scenario": "隔离测试用的观景室",
                "first_mes": "你好。",
                "mes_example": "",
                "creator_notes": "",
                "system_prompt": "",
                "post_history_instructions": "",
                "alternate_greetings": [],
                "tags": [],
                "creator": "",
                "character_version": "",
                "extensions": {},
            },
        },
        ensure_ascii=False,
    )


def run_phase(root: Path, phase: str, key: bytes) -> None:
    environment = {name: os.environ[name] for name in ("HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH")
                   if name in os.environ}
    environment.update({
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHON_DOTENV_DISABLED": "1",
        "REVERIE_BRIDGE_MODE": "1", "REVERIE_BRIDGE_PROTOCOL_VERSION": "4",
        "REVERIE_BRIDGE_SECRET": secrets.token_hex(32), "REVERIE_PARENT_PID": str(os.getpid()),
        "REVERIE_DATA_DIR": str(root / "data"), "REVERIE_LOCAL_MODE": "1", "REVERIE_LOCAL_MODE_EPOCH": "0",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
    })
    process = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", str(Path(__file__).resolve()), phase, str(root)],
        input=key, capture_output=True, env=environment, cwd=ROOT, timeout=120, check=False,
    )
    assert process.returncode == 0, process.stderr.decode("utf-8", errors="replace")[-4000:]


def test_one_persona_mounted_twice_and_cold_started_stays_writable(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / "data").mkdir()
    (root / "data/config.json").write_text(json.dumps({
        "llm": {"provider": "ollama", "model": "reverie-regression", "base_url": "http://127.0.0.1:9/v1"},
        "ui": {"mode": "mvp", "experience_mode": "core", "onboarding_completed": True},
    }), encoding="utf-8")
    key = os.urandom(32)

    for phase in ("switch", "restart"):
        run_phase(root, phase, key)

    events = [json.loads(line) for line in (root / EVENTS).read_text(encoding="utf-8").splitlines()]
    states = {(event["phase"], event["label"]): event for event in events if event["event"] == "state"}
    assert set(states) == {("switch", "mounted"), ("switch", "after_to_seeded"),
                           ("switch", "after_back_to_default"), ("restart", "mounted"),
                           ("restart", "cold_start")}
    for entry in states.values():
        assert (entry["runtime"], entry["manager"], entry["bridge"], entry["writable"]) == \
            ("clean", "clean", "clean", True), entry
    for label in ("after_to_seeded", "after_back_to_default"):
        entry = states[("switch", label)]
        assert (entry["ok"], entry["activated"], entry["restart"]) == (True, True, False), entry
        # Writability reaches the renderer before the identity it settles on.
        kinds = [frame["type"] for frame in entry["frames"]]
        activity = kinds.index("runtime:activity")
        assert activity < kinds.index("persona:data"), kinds
        assert entry["frames"][activity]["recovery_state"] == "clean"
    assert states[("switch", "after_back_to_default")]["persona"] == states[("switch", "mounted")]["persona"]
    assert states[("restart", "mounted")]["persona"] == states[("switch", "mounted")]["persona"]
    assert [event for event in events if event["event"] == "log"] == []


def test_real_desktop_import_attaches_only_to_ready_new_persona_and_rejects_duplicate(tmp_path: Path) -> None:
    root = tmp_path.resolve()
    (root / "data").mkdir()
    (root / "data/config.json").write_text(json.dumps({
        "llm": {"provider": "ollama", "model": "reverie-regression", "base_url": "http://127.0.0.1:9/v1"},
        "ui": {"mode": "mvp", "experience_mode": "core", "onboarding_completed": True},
    }), encoding="utf-8")

    run_phase(root, "import", os.urandom(32))

    events = [json.loads(line) for line in (root / EVENTS).read_text(encoding="utf-8").splitlines()]
    states = {event["label"]: event for event in events if event["event"] == "state"}
    assert set(states) == {"mounted", "after_import", "after_inactive", "after_duplicate"}
    for entry in states.values():
        assert (entry["runtime"], entry["manager"], entry["bridge"], entry["writable"]) == \
            ("clean", "clean", "clean", True), entry
    imported = states["after_import"]
    assert (imported["ok"], imported["saved"], imported["activated"], imported["runtime_ready"]) == \
        (True, True, True, True)
    assert imported["archive_correct"] is True
    assert imported["original_archive_unchanged"] is True
    assert (imported["world_book_imported"], imported["world_book_count"], imported["prompt_default_off"]) == \
        (True, 1, True)
    assert states["after_inactive"]["effects_unchanged"] is True
    assert (states["after_inactive"]["saved"], states["after_inactive"]["activated"]) == (True, False)
    duplicate = states["after_duplicate"]
    assert (duplicate["ok"], duplicate["code"], duplicate["saved"], duplicate["partial_write"]) == \
        (False, "already_imported", False, False)
    assert duplicate["effects_unchanged"] is True
    assert duplicate["files_unchanged"] is True
    assert states["mounted"]["persona"] != imported["persona"]
    assert states["after_inactive"]["persona"] == states["after_duplicate"]["persona"] == imported["persona"]
    assert [event for event in events if event["event"] == "log"] == []


def _child(phase: str, root: Path) -> None:
    import logging
    import runpy

    sys.path.insert(0, str(ROOT))
    from src.storage.encrypted_sqlite import install_storage_key

    # A dedicated ephemeral key over a pipe, never argv, environment or disk.
    install_storage_key(sys.stdin.buffer.read(), require_encryption=True)
    events = root / EVENTS

    def record(event: str, **fields) -> None:
        with events.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"phase": phase, "event": event, **fields}, ensure_ascii=False) + "\n")

    class Capture(logging.Handler):
        def emit(self, entry: logging.LogRecord) -> None:
            failure = entry.exc_info[0].__name__ if entry.exc_info and entry.exc_info[0] else ""
            record("log", logger=entry.name, level=entry.levelname, message=entry.getMessage()[:200],
                   exception=failure)

    logging.getLogger().addHandler(Capture(level=logging.ERROR))

    from src.config.settings import DATA_DIR, PERSONA_DIR

    if Path(DATA_DIR).resolve() != (root / "data").resolve():
        raise SystemExit("data directory outside the test root")
    seeded = ""
    if phase in {"switch", "import"}:
        from src.persona.persona_card import default_persona
        from src.persona.sillytavern_import import (
            initialize_default_persona,
            parse_sillytavern_json,
            save_imported_persona,
        )

        initialize_default_persona(Path(PERSONA_DIR), default_persona())
        if phase == "switch":
            seeded = save_imported_persona(parse_sillytavern_json(synthetic_card()), Path(PERSONA_DIR))["card_id"]

    import src.mvp_runtime as runtime_module
    from src.bridge import ws_bridge

    def state(label: str, runtime, **extra) -> None:
        manager = getattr(runtime, "_backup_manager", None)
        status = manager.recovery_status() if manager is not None else {}
        try:
            runtime.require_writable()
            writable = True
        except RuntimeError:
            writable = False
        record("state", label=label, runtime=runtime._recovery_state, manager=status.get("state"),
               bridge=ws_bridge.recovery_status_payload()["recovery_state"], writable=writable,
               persona=ws_bridge._active_persona_scope()["persona_id"], **extra)

    class Renderer:
        """Stands in for the authenticated stdio controller and keeps frame order."""

        def __init__(self) -> None:
            self.frames: list[dict] = []

        async def send(self, message: str) -> None:
            frame = json.loads(message)
            payload = frame.get("payload") if isinstance(frame.get("payload"), dict) else {}
            self.frames.append({"type": frame.get("type"), "recovery_state": payload.get("recovery_state")})

    async def composed(*, stdio, host, port, **kwargs) -> None:
        del stdio, host, port
        runtime = runtime_module.MvpDesktopRuntime(**kwargs)
        runtime_module._ACTIVE_DESKTOP_RUNTIME = runtime
        try:
            state("mounted", runtime)
            if phase in {"switch", "import"}:
                renderer = Renderer()
                ws_bridge._connections.add(renderer)
                ws_bridge._client_contexts[renderer] = ws_bridge.BridgeClientContext(
                    client_id="regression", protocol_version=4, authenticated=True,
                    conversation_id="dream-room", persona_id=ws_bridge._active_persona_scope()["persona_id"])
                ws_bridge._controller_ws = renderer
            if phase == "switch":
                for label, target in (("to_seeded", seeded), ("back_to_default", "default")):
                    scope = ws_bridge._active_persona_scope()
                    renderer.frames.clear()
                    result = await ws_bridge._commit_live_persona(renderer, {
                        "profile_id": target, "confirmed_profile_id": target, "identity_change_confirmed": True,
                        "actor": "owner", "reason": "isolated persona remount regression",
                        "expected_persona_id": scope["persona_id"],
                        "expected_persona_epoch": scope["persona_epoch"],
                        "expected_persona_fingerprint": scope["persona_fingerprint"],
                    })
                    state("after_" + label, runtime, ok=result.get("ok"), activated=result.get("activated"),
                          restart=result.get("restart_required"), frames=list(renderer.frames))
            elif phase == "import":
                from src.archive import ArchiveStore

                scope = ws_bridge._active_persona_scope()
                original_id = scope["persona_id"]
                original_store = ws_bridge.bridge_state.archive_store
                original_archive_path = original_store.path
                original_archive = original_store.put(original_id, {
                    "characters": [], "activeCharacterIds": [],
                    "worldBooks": [{"id": "prior-book", "name": "原身份的隔离设定", "entries": []}],
                }, expected_revision=0)
                card = json.loads(synthetic_card())
                card["data"].update({
                    "first_mes": "{{user}}，你好。",
                    "alternate_greetings": ["早上好，{{user}}。"],
                    "system_prompt": "卡作者补充设定",
                    "post_history_instructions": "卡作者补充尾注",
                    "character_book": {"entries": [{"keys": ["观景室"], "content": "窗外能看到海。"}]},
                })
                raw = json.dumps(card, ensure_ascii=False)
                result = await ws_bridge.handle_persona_import({
                    "json": raw, "identity_change_confirmed": True, "actor": "owner",
                    "reason": "isolated desktop card import regression",
                    "expected_persona_id": scope["persona_id"],
                    "expected_persona_epoch": scope["persona_epoch"],
                    "expected_persona_fingerprint": scope["persona_fingerprint"],
                }, renderer)
                current_scope = ws_bridge._active_persona_scope()
                current = ws_bridge.bridge_state.archive_store.get(current_scope["persona_id"])
                archived = current.get("archive") or {}
                cards = archived.get("characters") or []
                book_count = len(archived.get("worldBooks") or [])
                envelope = ws_bridge.bridge_state.persona.identity_envelope
                archive_correct = (len(cards) == 1 and cards[0]["id"] == result.get("card_id")
                                   and archived.get("activeCharacterIds") == [result.get("card_id")]
                                   and cards[0]["age"] == "24"
                                   and cards[0]["identity"] == ws_bridge.bridge_state.persona.identity["description"]
                                   and cards[0]["speakingStyle"] == "安静，认真"
                                   and cards[0]["alternateGreetings"] == ["早上好，用户。"]
                                   and bool(cards[0]["neverSay"])
                                   and result.get("persona_id") == envelope.persona_id
                                   and result.get("persona_fingerprint") == envelope.fingerprint
                                   and result.get("persona_epoch") == current_scope["persona_epoch"])
                prompt_default_off = (len(cards) == 1 and cards[0]["useImportedSystemPrompt"] is False
                                      and cards[0]["useImportedPostHistoryInstructions"] is False
                                      and cards[0]["importedSystemPrompt"] == "卡作者补充设定"
                                      and cards[0]["importedPostHistoryInstructions"] == "卡作者补充尾注"
                                      and not any(ws_bridge.bridge_state.session.imported_prompt_opts.values()))
                retained_original_store = ArchiveStore(original_archive_path)
                try:
                    original_unchanged = retained_original_store.get(original_id) == original_archive
                finally:
                    retained_original_store.close()
                state("after_import", runtime, ok=result.get("ok"), saved=result.get("saved"),
                      activated=result.get("activated"), runtime_ready=result.get("runtime_ready"),
                      archive_correct=archive_correct, world_book_imported=result.get("world_book_imported"),
                      world_book_count=book_count, prompt_default_off=prompt_default_off,
                      original_archive_unchanged=original_unchanged)
                opts_before = dict(ws_bridge.bridge_state.session.imported_prompt_opts)
                inactive_card = json.loads(raw)
                inactive_card["data"]["name"] = "隔离回归未激活人格"
                inactive = await ws_bridge.handle_persona_import({
                    "json": json.dumps(inactive_card, ensure_ascii=False), "identity_change_confirmed": False,
                }, renderer)
                state("after_inactive", runtime, saved=inactive.get("saved"), activated=inactive.get("activated"),
                      effects_unchanged=(ws_bridge._active_persona_scope() == current_scope
                                         and ws_bridge.bridge_state.archive_store.get(envelope.persona_id) == current
                                         and ws_bridge.bridge_state.session.imported_prompt_opts == opts_before))
                persona_root = Path(PERSONA_DIR)
                files_before = {str(path.relative_to(persona_root)): path.read_bytes()
                                for path in persona_root.rglob("*") if path.is_file()}
                duplicate = await ws_bridge.handle_persona_import({
                    "json": raw, "identity_change_confirmed": True,
                }, renderer)
                files_after = {str(path.relative_to(persona_root)): path.read_bytes()
                               for path in persona_root.rglob("*") if path.is_file()}
                state("after_duplicate", runtime, ok=duplicate.get("ok"), code=duplicate.get("code"),
                      saved=duplicate.get("saved"), partial_write=duplicate.get("partial_write"),
                      files_unchanged=files_after == files_before,
                      effects_unchanged=(ws_bridge._active_persona_scope() == current_scope
                                         and ws_bridge.bridge_state.archive_store.get(envelope.persona_id) == current
                                         and ws_bridge.bridge_state.session.imported_prompt_opts == opts_before))
            else:
                runtime.start_startup_recovery()
                state("cold_start", runtime)
        finally:
            await runtime.close()
            runtime_module._ACTIVE_DESKTOP_RUNTIME = None

    runtime_module.run_mvp_desktop = composed
    sys.argv = [str(ROOT / "src/main.py"), "--stdio-bridge"]
    runpy.run_module("src.main", run_name="__main__")


if __name__ == "__main__":
    _child(sys.argv[1], Path(sys.argv[2]))
