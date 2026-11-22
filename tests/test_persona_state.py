from contextlib import closing
from datetime import datetime
import logging
import os
import threading
from types import SimpleNamespace

import pytest

from src.bridge import ws_bridge
from src.config.settings import FeatureSettings
from src.emotion.system import EmotionSystem
from src.kernel.storage import KernelStore, PersonaStateMigrationError, connect_sqlite
from src.mvp_runtime import MvpDesktopRuntime
from src.relationship.tracker import RelationshipTracker
from src.storage import encrypted_sqlite
from tests.p1_restore_support import Graph


EMOTION = "persona_emotion_state"
RELATIONSHIP = "persona_relationship_state"


@pytest.fixture(autouse=True)
def encrypted_key(monkeypatch):
    monkeypatch.setattr(encrypted_sqlite, "_storage_key", bytearray(os.urandom(32)))
    monkeypatch.setattr(encrypted_sqlite, "_encryption_required", True)


@pytest.fixture
def kernel(tmp_path):
    with closing(KernelStore(tmp_path / "kernel.sqlite3")) as store:
        yield store


def legacy_rows(store):
    with closing(connect_sqlite(store.path, read_only=True)) as connection:
        return [tuple(row) for row in connection.execute(
            "SELECT document_name, payload_json, updated_at_utc FROM private_documents "
            "WHERE document_name IN (?, ?) ORDER BY document_name", (EMOTION, RELATIONSHIP),
        )]


def scoped_rows(store, persona_id):
    with closing(connect_sqlite(store.path, read_only=True)) as connection:
        return [tuple(row) for row in connection.execute(
            "SELECT document_name, payload_json, updated_at_utc FROM persona_state_documents "
            "WHERE persona_id = ? ORDER BY document_name", (persona_id,),
        )]


def migrate(store, current):
    return store.migrate_persona_state(current, MvpDesktopRuntime._validate_legacy_persona_document)


def populate_history(store, counts):
    with store.transaction() as connection:
        for persona_id in ("alpha", "beta", "current"):
            connection.execute("INSERT INTO personas VALUES (?,1,?,'{}',1,'fixture',?)",
                               (persona_id, "a" * 64, int(persona_id == "current")))
        for persona_id, user_count in counts.items():
            connection.execute("INSERT INTO conversations VALUES (?,?,'fixture','fixture')",
                               (persona_id, persona_id))
            messages = ["assistant"] * 8 + ["user"] * user_count
            for index, role in enumerate(messages):
                message_id = f"{persona_id}-{index}"
                connection.execute(
                    "INSERT INTO messages(message_id,conversation_id,persona_id,request_id,role,content,delivery_state,created_at_utc) "
                    "VALUES (?,?,?,?,?,'fixture','delivered','fixture')",
                    (message_id, persona_id, persona_id, message_id, role),
                )


@pytest.mark.parametrize(("counts", "owner"), [
    ({"alpha": 3, "beta": 1, "current": 2, "unknown": 7}, "alpha"),
    ({"alpha": 3, "beta": 1, "current": 3}, "current"),
    ({"alpha": 3, "beta": 3, "current": 1}, "alpha"),
    ({"alpha": 0, "beta": 0, "current": 0}, "current"),
], ids=["most-user-messages", "tie-with-current", "tie-by-persona-id", "no-user-messages"])
def test_persona_state_migration_assigns_both_legacy_documents(kernel, counts, owner):
    populate_history(kernel, counts)
    with kernel.transaction() as connection:
        connection.executemany("INSERT INTO private_documents VALUES (?,?,?)", [
            (EMOTION, '{ "values": {"joy": 72} }', "old-emotion"),
            (RELATIONSHIP, '{ "intimacy": 83, "interaction_count": 4 }', "old-relationship"),
        ])
    original = legacy_rows(kernel)

    assert migrate(kernel, "current") is True
    assert kernel.persona_state_migrated()
    assert scoped_rows(kernel, owner) == legacy_rows(kernel) == original
    for persona_id in {"alpha", "beta", "current"} - {owner}:
        assert scoped_rows(kernel, persona_id) == []
    assert EmotionSystem(document_store=kernel, persona_id=owner).values["joy"] == 72
    assert RelationshipTracker(50, document_store=kernel, persona_id=owner).interaction_count == 4


@pytest.mark.parametrize("has_legacy", [False, True], ids=["fresh", "one-legacy-document"])
def test_persona_state_migration_marks_the_database_without_creating_default_rows(kernel, has_legacy):
    if has_legacy:
        kernel.write_private_document(RELATIONSHIP, {"intimacy": 91})
    original = legacy_rows(kernel)

    assert migrate(kernel, "current")
    assert kernel.persona_state_migrated()
    assert scoped_rows(kernel, "current") == original
    assert kernel.read_persona_state_document("current", EMOTION) is None
    kernel.write_private_document(EMOTION, {"values": {"joy": 45}})
    assert migrate(kernel, "current") is False
    assert scoped_rows(kernel, "current") == original


def test_migrated_state_survives_restart_and_older_version_writes(kernel):
    kernel.write_private_document(RELATIONSHIP, {"intimacy": 91})
    kernel.write_private_document(EMOTION, {"values": {"joy": 71}})
    assert migrate(kernel, "current")
    with closing(KernelStore(kernel.path)) as old:
        assert old.read_private_document(RELATIONSHIP) == {"intimacy": 91}
        old.write_private_document(RELATIONSHIP, {"intimacy": 12})
        old.write_private_document(EMOTION, {"values": {"joy": 13}})
    with closing(KernelStore(kernel.path)) as reopened:
        assert migrate(reopened, "another") is False
        assert reopened.read_private_document(RELATIONSHIP) == {"intimacy": 12}
        assert reopened.read_persona_state_document("current", RELATIONSHIP) == {"intimacy": 91}
        assert reopened.read_persona_state_document("current", EMOTION) == {"values": {"joy": 71}}
        assert scoped_rows(reopened, "another") == []


def test_persona_state_defaults_remain_lazy_and_switch_to_independent_records(kernel):
    assert migrate(kernel, "alpha")
    for persona_id, joy, intimacy in (("alpha", 62, 72), ("beta", 31, 65)):
        emotion = EmotionSystem(values={"joy": joy}, document_store=kernel, persona_id=persona_id)
        relationship = RelationshipTracker(50, document_store=kernel, persona_id=persona_id)
        assert (emotion.values["joy"], relationship.intimacy, relationship.interaction_count) == (joy, 50, 0)
        emotion.apply_daily_carryover(datetime(2026, 11, 14))
        emotion.apply_event({"joy": 0})
        assert scoped_rows(kernel, persona_id) == []
        emotion.apply_event({"joy": 3})
        relationship.restore({"intimacy": intimacy, "interaction_count": 1})

    for persona_id, joy, intimacy in (("beta", 34, 65), ("alpha", 65, 72)):
        emotion = EmotionSystem(document_store=kernel, persona_id=persona_id, defer_startup_writes=True)
        relationship = RelationshipTracker(50, document_store=kernel, persona_id=persona_id)
        assert (emotion.values["joy"], relationship.intimacy, relationship.interaction_count) == (joy, intimacy, 1)
    assert legacy_rows(kernel) == []


def test_scoped_emotion_uses_global_settings_instead_of_saved_options(kernel):
    assert migrate(kernel, "current")
    kernel.write_persona_state_document("current", EMOTION, {
        "values": {"joy": 72}, "enabled": True, "carryover_days": 7, "inertia_factor": .5,
    })
    emotion = EmotionSystem(document_store=kernel, persona_id="current", enabled=False,
                            carryover_days=2, inertia_factor=.1)
    assert (emotion.enabled, emotion.carryover_days, emotion.inertia_factor, emotion.values["joy"]) == (False, 2, .1, 72)


def test_mid_migration_failure_rolls_back_first_copy_and_retains_legacy_bytes(kernel):
    kernel.write_private_document(EMOTION, {"values": {"joy": 72}})
    kernel.write_private_document(RELATIONSHIP, {"intimacy": 83})
    original = legacy_rows(kernel)
    with kernel.transaction() as connection:
        connection.execute("CREATE TRIGGER fail_relationship BEFORE INSERT ON persona_state_documents "
                           "WHEN NEW.document_name = 'persona_relationship_state' "
                           "BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END")
    with pytest.raises(PersonaStateMigrationError, match="^PERSONA_STATE_MIGRATION_FAILED$"):
        migrate(kernel, "current")
    assert legacy_rows(kernel) == original
    assert scoped_rows(kernel, "current") == []
    assert not kernel.persona_state_migrated()


def test_clean_desktop_startup_reports_invalid_legacy_state_without_publishing_ready(tmp_path, monkeypatch):
    from src.config import settings as settings_module

    graph = Graph(tmp_path / "graph")
    try:
        monkeypatch.setattr(settings_module, "WORLD_STATE_DB", tmp_path / "unused-world.sqlite3")
        graph.kernel.write_private_document(EMOTION, {"values": {"joy": "invalid"}})
        original = legacy_rows(graph.kernel)
        original_bridge = ws_bridge.bridge_state
        with pytest.raises(PersonaStateMigrationError, match="^PERSONA_STATE_MIGRATION_FAILED$"):
            MvpDesktopRuntime(persona=graph.persona,
                              settings=SimpleNamespace(features=FeatureSettings()),
                              memory_state=graph.scope.module("memory"),
                              emotion_state=graph.scope.module("emotion"),
                              relationship_state=graph.scope.module("relationship"),
                              persona_state=graph.scope,
                              kernel_store=graph.kernel, module_registry=None,
                              logger=logging.getLogger(__name__))
        assert ws_bridge.bridge_state is original_bridge
        assert legacy_rows(graph.kernel) == original
        assert scoped_rows(graph.kernel, graph.persona.identity_envelope.persona_id) == []
        assert not graph.kernel.persona_state_migrated()
    finally:
        graph.close()


def use_scoped_participants(graph):
    persona_id = graph.persona.identity_envelope.persona_id
    graph.emotion = EmotionSystem(values=dict(graph.persona.emotions), document_store=graph.kernel,
                                  persona_id=persona_id, defer_startup_writes=True)
    graph.relationship = RelationshipTracker(50, document_store=graph.kernel, persona_id=persona_id)
    graph.manager.emotion, graph.manager.relationship = graph.emotion, graph.relationship


def test_old_backup_exports_and_restores_only_the_mounted_persona(tmp_path):
    old, current = Graph(tmp_path / "old"), Graph(tmp_path / "current")
    try:
        old.seed("after")
        current.seed("before")
        persona_id = current.persona.identity_envelope.persona_id
        assert migrate(current.kernel, persona_id)
        use_scoped_participants(current)
        current.kernel.write_persona_state_document("other", RELATIONSHIP, {"intimacy": 35})
        current.kernel.write_persona_state_document("other", EMOTION, {"values": {"joy": 29}})
        other = scoped_rows(current.kernel, "other")
        legacy = legacy_rows(current.kernel)
        assert current.manager.export_payload()["relationship"]["intimacy"] == 100
        assert current.manager.export_payload()["emotion"]["values"]["joy"] == 41

        result = current.manager.import_payload(old.manager.export_payload())

        assert result["outcome"] == "committed"
        restored = current.manager.export_payload()
        assert restored["relationship"]["intimacy"] == 200
        assert restored["emotion"]["values"]["joy"] == 42
        assert scoped_rows(current.kernel, "other") == other
        assert legacy_rows(current.kernel) == legacy
    finally:
        current.close()
        old.close()


def recovery_runtime(graph, monkeypatch):
    runtime = MvpDesktopRuntime.__new__(MvpDesktopRuntime)
    runtime._kernel_store = graph.kernel
    runtime._settings = SimpleNamespace(features=FeatureSettings(emotion_system_enabled=False))
    runtime._session = SimpleNamespace(persona=graph.persona, world_clock=None,
                                       emotion=graph.emotion, relationship=graph.relationship)
    runtime._backup_manager = graph.manager
    runtime._diary = graph.diary
    graph.diary.emotion = graph.emotion
    runtime._logger = logging.getLogger(__name__)
    runtime._owner_thread = threading.get_ident()
    runtime._recovery_state = "recovering"
    runtime._startup_recovery_pending = True
    runtime._persona_state_migration_pending = not graph.kernel.persona_state_migrated()
    runtime._start_background_tasks = lambda: None
    monkeypatch.setattr(ws_bridge, "bridge_state", SimpleNamespace(
        backup_manager=graph.manager, recovery_state="recovering", recovery_reason="",
        emotion=graph.emotion, relationship=graph.relationship,
    ))
    monkeypatch.setattr(ws_bridge, "_runtime_activity_payload", ws_bridge.recovery_status_payload)
    broadcasts = []

    async def broadcast(_message_type, payload):
        broadcasts.append(payload)

    monkeypatch.setattr(ws_bridge, "broadcast", broadcast)
    return runtime, broadcasts


@pytest.mark.asyncio
@pytest.mark.parametrize("marked", [False, True], ids=["legacy-recovery", "scoped-recovery"])
async def test_startup_recovery_uses_the_marker_then_loads_the_current_persona(tmp_path, monkeypatch, marked):
    current, source = Graph(tmp_path / "current"), Graph(tmp_path / "source")
    try:
        current.seed("before")
        source.seed("after")
        persona_id = current.persona.identity_envelope.persona_id
        if marked:
            assert migrate(current.kernel, persona_id)
            use_scoped_participants(current)
            current.kernel.write_persona_state_document("other", RELATIONSHIP, {"intimacy": 70})
        other = scoped_rows(current.kernel, "other")
        legacy = legacy_rows(current.kernel)
        before = current.manager._snapshot(include_memory=False)
        before["_memory_restore_marker"] = "fixture-before-marker"
        after = source.manager._snapshot(include_memory=False)
        after["_memory_restore_marker"] = "fixture-after-marker"
        current.journal.prepare_restore(before, after, operation_id="fixture-after-marker")
        current.memory.import_stream(source.memory.export_all(), replace=True, restore_marker="fixture-after-marker")
        runtime, broadcasts = recovery_runtime(current, monkeypatch)

        await runtime._recover_startup()

        assert current.journal.pending_restore() is None
        assert current.kernel.persona_state_migrated()
        assert broadcasts[-1]["runtime_writable"] is True
        assert runtime._session.relationship.intimacy == 200
        assert runtime._session.emotion.values["joy"] == 42
        assert current.manager._snapshot(include_memory=False)["relationship"] == after["relationship"]
        assert current.manager._snapshot(include_memory=False)["emotion"]["values"] == after["emotion"]["values"]
        assert runtime._session.emotion is current.manager.emotion is current.diary.emotion is ws_bridge.bridge_state.emotion
        assert runtime._session.relationship is current.manager.relationship is ws_bridge.bridge_state.relationship
        assert scoped_rows(current.kernel, "other") == other
        if marked:
            assert legacy_rows(current.kernel) == legacy
        else:
            assert legacy_rows(current.kernel) != legacy
            assert scoped_rows(current.kernel, persona_id) == legacy_rows(current.kernel)
    finally:
        source.close()
        current.close()


@pytest.mark.asyncio
async def test_deferred_migration_reload_failure_rolls_back_and_keeps_runtime_readonly(tmp_path, monkeypatch, caplog):
    graph = Graph(tmp_path / "graph")
    try:
        graph.seed("before")
        legacy = legacy_rows(graph.kernel)
        runtime, broadcasts = recovery_runtime(graph, monkeypatch)
        persona_id = graph.persona.identity_envelope.persona_id

        def fail_scoped_load(*_args):
            raise OSError("synthetic scoped read failure")

        monkeypatch.setattr(graph.kernel, "read_persona_state_document", fail_scoped_load)
        await runtime._recover_startup()

        assert not graph.kernel.persona_state_migrated()
        assert scoped_rows(graph.kernel, persona_id) == []
        assert legacy_rows(graph.kernel) == legacy
        assert runtime._recovery_reason == "PERSONA_STATE_MIGRATION_FAILED"
        assert broadcasts[-1]["runtime_writable"] is False
        assert "PERSONA_STATE_MIGRATION_FAILED" in caplog.text
        assert "synthetic scoped read failure" not in caplog.text
    finally:
        graph.close()
