from __future__ import annotations

import asyncio
import copy

import pytest

from src.archive import ArchiveConflict, ArchiveStore
from src.bridge import ws_bridge
from src.worldbook.runtime import WorldbookRuntime, archive_available


def test_optional_archive_module_presence_and_disabled_state():
    from types import SimpleNamespace
    assert archive_available(None)
    class Unregistered:
        def status(self, _name): raise KeyError("archive")
    assert archive_available(Unregistered())
    assert archive_available(SimpleNamespace(status=lambda _name: SimpleNamespace(state="running")))
    assert not archive_available(SimpleNamespace(status=lambda _name: SimpleNamespace(state="disabled")))


def archive(content="synthetic first setting", **entry):
    return {"characters": [], "activeCharacterIds": [], "worldBooks": [{
        "id": "book", "name": "Synthetic book", "scanDepth": 1, "tokenBudget": 500,
        "entries": [{"id": "entry", "keywords": ["trigger"], "content": content, **entry}],
    }]}


@pytest.mark.asyncio
async def test_native_priority_save_applies_next_turn_and_survives_store_restart(tmp_path):
    db = tmp_path / "priority.sqlite3"
    store = ArchiveStore(db)
    runtime = WorldbookRuntime(store, "sunny")
    original = archive()
    original["worldBooks"][0].update(tokenBudget=8, entries=[
        {"id": "a", "content": "PRIORITY_A_ONLY", "alwaysActive": True,
         "insertionOrder": 10, "priority": 0},
        {"id": "b", "content": "PRIORITY_B_ONLY", "alwaysActive": True,
         "insertionOrder": 20, "priority": 1}])
    try:
        first = store.put("sunny", original, expected_revision=0)
        before_save = runtime.capture("captured-before-save")
        changed = copy.deepcopy(first["archive"])
        changed["worldBooks"][0]["entries"][0]["priority"] = 2
        second = store.put("sunny", changed, expected_revision=first["revision"])
        runtime.observe_record(second)
        assert await runtime.evaluate(before_save, []) == "PRIORITY_B_ONLY"
        assert await runtime.evaluate(runtime.capture("after-save"), []) == "PRIORITY_A_ONLY"
        changed["worldBooks"][0]["entries"][0]["priority"] = 0
        third = store.put("sunny", changed, expected_revision=second["revision"])
        assert await runtime.evaluate(runtime.capture("after-restore"), []) == "PRIORITY_B_ONLY"
        assert store.get("moon")["exists"] is False
    finally:
        await runtime.aclose()
        store.close()
    restarted = ArchiveStore(db)
    runtime = WorldbookRuntime(restarted, "sunny")
    try:
        assert restarted.get("sunny") == third
        assert await runtime.evaluate(runtime.capture("restart-read-only"), []) == "PRIORITY_B_ONLY"
        assert restarted.get("sunny") == third
        assert restarted.get("moon")["exists"] is False
    finally:
        await runtime.aclose()
        restarted.close()


@pytest.mark.asyncio
async def test_captured_turn_and_next_turn_read_different_committed_revisions(tmp_path):
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    runtime = WorldbookRuntime(store, "persona-a")
    try:
        first = store.put("persona-a", archive(), expected_revision=0)
        captured = runtime.capture("turn-one")
        second = store.put("persona-a", archive("synthetic saved setting"), expected_revision=1)
        runtime.observe_record(second)
        assert await runtime.evaluate(captured, [{"content": "trigger"}]) == "synthetic first setting"
        assert runtime.diagnostics_for(second)["request_id"] == ""
        assert await runtime.evaluate(runtime.capture("turn-two"), [{"content": "trigger"}]) == "synthetic saved setting"
        assert store.get("persona-a")["revision"] == 2
        assert first["archive"]["worldBooks"][0]["entries"][0]["id"] == second["archive"]["worldBooks"][0]["entries"][0]["id"]
        with pytest.raises(ArchiveConflict):
            store.put("persona-a", archive("must not win"), expected_revision=1)
        assert "saved" in await runtime.evaluate(runtime.capture(), [{"content": "trigger"}])
        assert not (tmp_path / "lorebook.json").exists()
    finally:
        await runtime.aclose()
        store.close()


@pytest.mark.asyncio
async def test_save_disable_delete_restart_and_persona_isolation(tmp_path):
    db = tmp_path / "archive.sqlite3"
    store = ArchiveStore(db)
    a, b = WorldbookRuntime(store, "a"), WorldbookRuntime(store, "b")
    try:
        store.put("a", archive(), expected_revision=0, migrate_only=True)
        assert await a.evaluate(a.capture(), [{"content": "trigger"}])
        assert await b.evaluate(b.capture(), [{"content": "trigger"}]) == ""
        store.put("a", archive(enabled=False), expected_revision=1)
        assert await a.evaluate(a.capture(), [{"content": "trigger"}]) == ""
        store.put("a", archive("restored"), expected_revision=2)
        await a.aclose()
        a = WorldbookRuntime(store, "a")
        assert await a.evaluate(a.capture(), [{"content": "trigger"}]) == "restored"
        store.put("a", {"characters": [], "activeCharacterIds": [], "worldBooks": []}, expected_revision=3)
        assert await a.evaluate(a.capture(), [{"content": "trigger"}]) == ""
    finally:
        await a.aclose()
        await b.aclose()
        store.close()


@pytest.mark.asyncio
async def test_corrupt_snapshot_never_reuses_prior_context_and_does_not_repair_archive(tmp_path):
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    runtime = WorldbookRuntime(store, "a")
    try:
        store.put("a", archive("secret setting"), expected_revision=0)
        assert await runtime.evaluate(runtime.capture(), [{"content": "trigger"}]) == "secret setting"
        store._connection.execute("UPDATE archive_state SET checksum_sha256=? WHERE persona_id='a'", ("0" * 64,))
        assert await runtime.evaluate(runtime.capture("corrupt-turn"), [{"content": "trigger"}]) == ""
        diagnostic = runtime.diagnostics_for()["entries"][0]
        assert diagnostic["code"] == "snapshot_unavailable"
        assert "secret" not in str(diagnostic)
        assert store._connection.execute("SELECT checksum_sha256 FROM archive_state").fetchone()[0] == "0" * 64
    finally:
        await runtime.aclose()
        store.close()


@pytest.mark.asyncio
async def test_regex_error_is_revision_bound_and_save_repairs_it(tmp_path):
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    runtime = WorldbookRuntime(store, "a")
    try:
        first = store.put("a", archive(useRegex=True, keywords=["["]), expected_revision=0)
        assert await runtime.evaluate(runtime.capture("broken"), [{"content": "trigger"}]) == ""
        diagnostic = runtime.diagnostics_for(first)
        assert diagnostic["revision"] == 1
        assert diagnostic["entries"][0]["code"] == "invalid_regex"
        fixed = store.put("a", archive(useRegex=True, keywords=["trigger"]), expected_revision=1)
        assert runtime.diagnostics_for(fixed)["entries"] == []
        assert await runtime.evaluate(runtime.capture("fixed"), [{"content": "trigger"}])
        assert runtime.diagnostics_for(fixed)["entries"] == []
    finally:
        await runtime.aclose()
        store.close()


@pytest.mark.asyncio
async def test_cancelled_turn_does_not_downgrade_cleanup_failure_and_continue(tmp_path):
    started = asyncio.Event()
    class FailedCleanupEngine:
        async def evaluate(self, *_args, **_kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                raise RuntimeError("synthetic cleanup failure") from None
        async def aclose(self):
            pass
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    runtime = WorldbookRuntime(store, "a", engine=FailedCleanupEngine())
    provider_calls = []
    async def turn():
        await runtime.evaluate(runtime.capture("cancelled"), [{"content": "trigger"}])
        provider_calls.append("must not continue")
    task = asyncio.create_task(turn())
    try:
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert provider_calls == []
        assert runtime.diagnostics_for()["entries"] == []
    finally:
        await runtime.aclose()
        store.close()


@pytest.mark.asyncio
async def test_archive_bridge_save_and_migrate_expose_current_diagnostics(tmp_path, monkeypatch):
    state = ws_bridge.BridgeState()
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    runtime = WorldbookRuntime(store, "a")
    state.archive_store, state.worldbook_runtime = store, runtime
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_active_persona_id", lambda: "a")
    async def social(*_args, **_kwargs):
        return {"ok": True, "synced": 0}
    monkeypatch.setattr(ws_bridge, "handle_settings_update", social)
    try:
        first = await ws_bridge.handle_archive_migrate({"archive": archive(), "expected_revision": 0}, None)
        assert first["ok"] and first["world_book_diagnostics"]["revision"] == 1
        assert await runtime.evaluate(runtime.capture(), [{"content": "trigger"}])
        modified = copy.deepcopy(first["archive"])
        modified["worldBooks"][0]["entries"][0]["content"] = "next turn"
        saved = await ws_bridge.handle_archive_put({"archive": modified, "expected_revision": 1}, None)
        assert saved["world_book_diagnostics"]["entries"] == []
        assert await runtime.evaluate(runtime.capture(), [{"content": "trigger"}]) == "next turn"
    finally:
        await runtime.aclose()
        store.close()


@pytest.mark.asyncio
async def test_archive_waiting_for_persona_lock_cannot_write_new_persona(tmp_path, monkeypatch):
    state = ws_bridge.BridgeState()
    store = ArchiveStore(tmp_path / "archive.sqlite3")
    state.archive_store = store
    scope = {"persona_id": "a", "persona_epoch": 1, "persona_fingerprint": "old-fingerprint"}
    checked = asyncio.Event()
    lock = asyncio.Lock()
    class Endpoint:
        pass
    endpoint = Endpoint()
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_persona_effect_lock", lock)
    monkeypatch.setattr(ws_bridge, "_active_persona_scope", lambda: dict(scope))
    monkeypatch.setattr(ws_bridge, "_active_persona_id", lambda: scope["persona_id"])
    monkeypatch.setattr(ws_bridge, "_client_contexts", {endpoint: ws_bridge.BridgeClientContext("client-test", 4, True)})
    original = ws_bridge._matches_expected_persona
    def matches(payload):
        answer = original(payload)
        checked.set()
        return answer
    monkeypatch.setattr(ws_bridge, "_matches_expected_persona", matches)
    await lock.acquire()
    task = asyncio.create_task(ws_bridge.dispatch_authenticated_message({
        "type": "archive:put", "request_id": "queued-save", "payload": {
            "archive": archive(), "expected_revision": 0, "expected_persona_id": "a",
            "expected_persona_epoch": 1, "expected_persona_fingerprint": "old-fingerprint",
        }}, endpoint, emit_result=False))
    try:
        await checked.wait()
        assert not task.done()
        scope.update(persona_id="b", persona_epoch=2, persona_fingerprint="new-fingerprint")
        lock.release()
        result = await task
        assert result["code"] == "stale_persona"
        assert not store.get("a")["exists"] and not store.get("b")["exists"]
    finally:
        if lock.locked(): lock.release()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_type", [RuntimeError, asyncio.CancelledError])
async def test_chat_shutdown_closes_provider_even_when_worldbook_cleanup_fails(failure_type):
    from src.chat.session import ChatSession

    calls = []

    class FailedWorldbook:
        async def aclose(self):
            calls.append("worldbook")
            raise failure_type("synthetic cleanup failure")

    class Provider:
        async def close(self):
            await asyncio.sleep(0)
            calls.append("provider")

    # Exercise the real cleanup method without constructing unrelated modules.
    session = object.__new__(ChatSession)
    session.conversation_summary = None
    session.worldbook_runtime = FailedWorldbook()
    session.adapter = Provider()
    with pytest.raises(failure_type):
        await session.close()
    assert calls == ["worldbook", "provider"]


@pytest.mark.asyncio
async def test_archive_get_exposes_snapshot_failure_when_store_could_not_initialize(monkeypatch):
    state = ws_bridge.BridgeState()
    runtime = WorldbookRuntime(None, "unavailable-persona")
    state.archive_store, state.worldbook_runtime = None, runtime
    monkeypatch.setattr(ws_bridge, "bridge_state", state)
    monkeypatch.setattr(ws_bridge, "_active_persona_id", lambda: "unavailable-persona")
    try:
        assert await runtime.evaluate(runtime.capture("failed-store-turn"), [{"content": "synthetic"}]) == ""
        result = await ws_bridge.handle_archive_get({}, None)
        assert result["ok"] is False and result["code"] == "module_unavailable"
        assert result["persona_id"] == "unavailable-persona" and result["revision"] == 0
        diagnostics = result["world_book_diagnostics"]
        assert diagnostics["request_id"] == "failed-store-turn"
        assert diagnostics["entries"][0]["code"] == "snapshot_unavailable"
        assert diagnostics["entries"][0]["entry_id"] == ""
    finally:
        await runtime.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("cleanup_confirmed", [False, True])
async def test_persona_graph_closes_other_resources_and_blocks_only_uncertain_worldbook_cleanup(cleanup_confirmed):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from src.mvp_runtime import MvpDesktopRuntime

    calls = []

    class Session:
        async def close(self):
            calls.append("session")
            raise RuntimeError("synthetic shutdown failure")

    def store(label):
        return SimpleNamespace(close=lambda: calls.append(label))

    runtime = object.__new__(MvpDesktopRuntime)
    runtime._recovery_state = "clean"
    runtime._tasks = []
    runtime._logger = Mock()
    runtime._user_manager = SimpleNamespace(save=lambda: calls.append("profile"))
    runtime._session = Session()
    runtime._worldbook_runtime = SimpleNamespace(cleanup_confirmed=cleanup_confirmed)
    runtime._memory = SimpleNamespace(store=store("memory"))
    runtime._game_state_store = store("games")
    runtime._archive_store = store("archive")
    if cleanup_confirmed:
        await runtime._stop_persona_graph()
    else:
        with pytest.raises(RuntimeError, match="worker cleanup was not confirmed; persona remount blocked"):
            await runtime._stop_persona_graph()
    assert calls == ["profile", "session", "memory", "games", "archive"]
