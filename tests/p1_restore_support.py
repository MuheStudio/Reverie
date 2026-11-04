"""Actual encrypted desktop participants, without a model or application UI."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from src.backup import LocalBackupManager
from src.diary import DiaryEntry, DiaryManager
from src.emotion.system import EmotionSystem
from src.kernel.storage import KernelStore
from src.memory.catalog import MemoryCatalog
from src.memory.manager import MemoryManager
from src.persona.identity import PersonaEpochRegistry
from src.persona.persona_card import default_persona
from src.persona.state_scope import PersonaStateScope
from src.relationship.tracker import RelationshipTracker
from src.user import UserManager
from src.world_state_store import WorldStateStore


class CatalogMemory:
    """Real memory catalog; vector/model dependencies are not restore inputs."""
    def __init__(self, persona, scope):
        self.persona = persona
        self._state_scope = scope
        self.store = SimpleNamespace(catalog=MemoryCatalog(scope.file("memory.sqlite3")))

    def _require_current(self):
        self._state_scope.require_current()

    def iter_export_pages(self, page_size=500):
        cursor = None
        while True:
            rows, cursor = self.store.catalog.page(page_size=page_size, cursor=cursor)
            if rows:
                yield [MemoryManager._export_row(self, row) for row in rows]
            if cursor is None:
                return

    def export_all(self):
        return [record for page in self.iter_export_pages() for record in page]

    def import_stream(self, records, *, replace=False, before_commit=None, after_commit=None, restore_marker=""):
        return self._state_scope.commit_bound(lambda: self.store.catalog.import_records(
            records, replace=replace, before_commit=before_commit,
            after_commit=after_commit, restore_marker=restore_marker))

    def import_all(self, records, *, replace=False):
        return self.import_stream(iter(records), replace=replace)


class Graph:
    def __init__(self, path: Path, *, fault_hook=None, desktop_extras=False):
        self.root = path
        self.persona = default_persona()
        registry = PersonaEpochRegistry(); registry.activate_initial(self.persona)
        self.scope = PersonaStateScope(self.persona, registry=registry, base_dir=path / "personas")
        self.kernel = KernelStore(self.scope.module("kernel").file("kernel.sqlite3"))
        self.memory = CatalogMemory(self.persona, self.scope.module("memory"))
        self.emotion = EmotionSystem(state_path=self.scope.module("emotion").file("state.json"), document_store=self.kernel, defer_startup_writes=True)
        self.relationship = RelationshipTracker(state_path=self.scope.module("relationship").file("state.json"), document_store=self.kernel, defer_startup_writes=True)
        self.user = UserManager(self.scope.module("user").path, document_store=self.kernel, defer_startup_writes=True)
        self.diary = DiaryManager(self.persona, state_scope=self.scope.module("diary"))
        envelope = self.persona.identity_envelope
        identity = {"persona_id": envelope.persona_id, "fingerprint": envelope.fingerprint, "identity_version": envelope.version}
        self.journal = WorldStateStore(self.scope.module("restore").file("journal.sqlite3"), persona_identity=identity)
        extras = {}
        if desktop_extras:
            from src.ambient import ThoughtOfYouEngine
            from src.config.settings import FeatureSettings, WORLD_STATE_DB
            from src.social.universe import SocialUniverse
            from src.world import WorldClock
            self.world = WorldClock(data_dir=self.scope.module("calendar").path)
            world_scope = self.scope.module("world")
            self.thought = ThoughtOfYouEngine(FeatureSettings(), path=world_scope.file(WORLD_STATE_DB.name), world_clock=self.world)
            self.social = SocialUniverse(self.persona, FeatureSettings(), state_scope=world_scope, defer_startup_writes=True)
            extras = {"world_clock":self.world, "thought_engine":self.thought, "social_universe":self.social}
        self.manager = LocalBackupManager(memory=self.memory, emotion=self.emotion,
            relationship=self.relationship, user_manager=self.user, diary=self.diary,
            state_store=self.journal, fault_hook=fault_hook, **extras)

    def seed(self, which: str):
        number = {"before": 1, "after": 2}[which]
        self.memory.import_stream([{"id": f"fixture-{which}", "text": f"合成{which}事实", "layer": "permanent", "timestamp": 1791849600.0 + number, "importance": 0.8}], replace=True, restore_marker=f"fixture-{which}-marker")
        self.emotion.restore({"values": {"joy": 40.0 + number}, "last_updated": "2026-10-13T00:00:00"})
        self.relationship.restore({"intimacy": number * 100, "interaction_count": number, "positive_interactions": number, "negative_interactions": 0, "last_interaction_at": "2026-10-13T00:00:00", "recent_fingerprints": []})
        self.user.import_all({"profile": {"name": f"synthetic-{which}", "nickname": f"昵称-{which}", "first_seen": "2026-10-13T00:00:00", "last_seen": "2026-10-13T00:00:00", "session_count": number}, "emotional_memories": []})
        entry = DiaryEntry(date=f"2026-10-{10+number}", title=f"title-{which}", content=f"synthetic diary {which}", mood="peaceful", emotions={"joy": 40.0 + number}, created_at="2026-10-13T00:00:00")
        # Legitimate pre-restore activity creates the original diary key once;
        # restore itself may not replace or manufacture a missing key.
        if not (self.diary.diary_dir / "keys/diary_key.json").exists():
            self.diary.save_entry(entry)
        self.diary.replace_all({"entries": [entry.to_dict()], "missed": [f"2026-10-0{number}"], "external_highlights": {f"2026-10-{10+number}": [which]}, "privacy_enabled": number == 1, "peek_enabled": number == 2})

    def observable(self):
        """Compare declared fixture values, not expectations learned from restore."""
        return {
            "memory": [{"id": x["id"], "text": x["text"]} for x in self.memory.export_all()],
            "emotionJoy": self.emotion.values["joy"],
            "relationshipIntimacy": self.relationship.intimacy,
            "profileNickname": self.user.profile.nickname,
            "diary": self.diary.export_all(),
            "marker": self.memory.store.catalog.metadata_get("full_restore_marker"),
        }

    def assert_fixture(self, which: str, *, target_marker=None):
        number = {"before": 1, "after": 2}[which]
        state = self.observable()
        assert state["memory"] == [{"id": f"fixture-{which}", "text": f"合成{which}事实"}]
        assert state["emotionJoy"] == 40.0 + number
        assert state["relationshipIntimacy"] == number * 100
        assert state["profileNickname"] == f"昵称-{which}"
        diary = state["diary"]
        assert [e["date"] for e in diary["entries"]] == [f"2026-10-{10+number}"]
        assert diary["entries"][0]["content"] == f"synthetic diary {which}"
        assert diary["missed"] == [f"2026-10-0{number}"]
        assert diary["external_highlights"] == {f"2026-10-{10+number}": [which]}
        assert diary["privacy_enabled"] is (number == 1)
        assert diary["peek_enabled"] is (number == 2)
        assert not list(self.diary.diary_dir.glob(f"2026-10-{12 if number == 1 else 11}.json*"))
        assert state["marker"] == (target_marker or f"fixture-{which}-marker")

    def close(self):
        self.memory.store.catalog.close()
        self.kernel.close()
