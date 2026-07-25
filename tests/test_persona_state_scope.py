from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime
from types import SimpleNamespace

import pytest

from src.affairs.manager import PersonalAffairManager
from src.diary import DiaryManager
from src.interest.tracker import InterestTracker
from src.memory.manager import MemoryManager
from src.config.settings import MemorySettings
from src.persona.identity import PersonaEpochRegistry, StalePersonaEpoch
from src.persona.persona_card import Persona, default_persona
from src.persona.state_scope import PersonaStateScope
from src.social.circle import SocialCircle
from src.social.universe import SocialUniverse
from src.timeline import TimelineManager


def _replacement_for(source: Persona) -> Persona:
    data = source.to_dict()
    data["name"] = "Scoped Replacement"
    data["identity"]["persona_id"] = "scoped_replacement"
    data["identity"]["identity_version"] = 1
    return Persona(**data)


def _switch_persona(registry: PersonaEpochRegistry, source: Persona) -> Persona:
    replacement = _replacement_for(source)
    authorization = registry.authorize_update(
        actor="owner",
        reason="persona scope race test",
        user_confirmed=True,
    )
    registry.activate_update(replacement, authorization)
    return replacement


def _scope(persona: Persona, registry: PersonaEpochRegistry, root) -> PersonaStateScope:
    return PersonaStateScope(
        persona,
        registry=registry,
        base_dir=root,
        legacy_fingerprint_allowlist={persona.seal_identity().fingerprint},
    )


def test_unknown_identity_quarantines_unscoped_legacy_data(tmp_path) -> None:
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "history.json").write_text('{"owner":"old"}', encoding="utf-8")
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    scope = PersonaStateScope(
        persona,
        registry=registry,
        base_dir=tmp_path / "scoped",
        legacy_fingerprint_allowlist=frozenset(),
    )

    module = scope.module("diary", legacy_path=legacy)

    assert module.migration_status == "quarantined_unscoped"
    assert not (module.path / "history.json").exists()
    assert (legacy / "history.json").read_text(encoding="utf-8") == '{"owner":"old"}'


def test_failed_legacy_copy_never_publishes_partial_namespace(
    tmp_path,
    monkeypatch,
) -> None:
    import src.persona.state_scope as state_scope_module

    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "one.json").write_text('{"one":1}', encoding="utf-8")
    persona = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(persona)
    scope = _scope(persona, registry, tmp_path / "scoped")
    original_copytree = state_scope_module.shutil.copytree

    def fail_after_partial_copy(source, destination):
        destination.mkdir()
        (destination / "partial.json").write_text("partial", encoding="utf-8")
        raise OSError("injected copy failure")

    monkeypatch.setattr(state_scope_module.shutil, "copytree", fail_after_partial_copy)
    with pytest.raises(OSError, match="injected copy failure"):
        scope.module("timeline", legacy_path=legacy)

    assert not (scope.root / "timeline").exists()
    assert (legacy / "one.json").read_text(encoding="utf-8") == '{"one":1}'

    monkeypatch.setattr(state_scope_module.shutil, "copytree", original_copytree)
    module = scope.module("timeline", legacy_path=legacy)
    assert module.migration_status == "migrated_known_legacy"
    assert (module.path / "one.json").read_text(encoding="utf-8") == '{"one":1}'
    assert not any(path.name.endswith(".tmp") for path in scope.root.iterdir())


def test_switch_isolates_durable_state_and_invalidates_old_manager(tmp_path) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    old_scope = _scope(original, registry, tmp_path / "personas")
    old_module = old_scope.module("interest")
    old_tracker = InterestTracker(state_scope=old_module)
    old_tracker.record_activity("painting", note="old identity history")
    old_path = old_tracker.path

    replacement = _switch_persona(registry, original)

    with pytest.raises(StalePersonaEpoch):
        old_tracker.export_all()
    with pytest.raises(StalePersonaEpoch):
        old_tracker.record_activity("painting", note="must be rejected")

    new_scope = _scope(replacement, registry, tmp_path / "personas")
    new_tracker = InterestTracker(state_scope=new_scope.module("interest"))
    assert new_tracker.count == 0
    assert new_tracker.path != old_path
    assert json.loads(old_path.read_text(encoding="utf-8"))["interests"][0]["name"] == "painting"


def test_memory_catalog_is_persona_scoped_and_stale_manager_fails_closed(tmp_path) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    old_scope = _scope(original, registry, tmp_path / "personas")
    old_module = old_scope.module("memory")
    settings = MemorySettings(
        lancedb_path=str(tmp_path / "must-not-be-used" / "vectors"),
        sqlite_path=str(tmp_path / "must-not-be-used" / "metadata.db"),
    )
    old_memory = MemoryManager(original, settings, state_scope=old_module)
    old_memory.store_fact("only persona A knows this", layer="long_term")

    replacement = _switch_persona(registry, original)
    with pytest.raises(StalePersonaEpoch):
        old_memory.search("persona A")
    with pytest.raises(StalePersonaEpoch):
        old_memory.store_fact("stale writer must fail")

    new_scope = _scope(replacement, registry, tmp_path / "personas")
    new_module = new_scope.module("memory")
    new_memory = MemoryManager(replacement, settings, state_scope=new_module)

    assert old_memory.store.catalog.path != new_memory.store.catalog.path
    assert "only persona A knows this" not in {
        str(row.get("text", "")) for row in new_memory.export_all()
    }
    assert not (tmp_path / "must-not-be-used").exists()


class _StableEmotion:
    values = {"joy": 50.0, "calm": 60.0}

    def get_mood_label(self) -> str:
        return "calm"

    def get_dominant(self, count: int):
        return list(self.values.items())[:count]


class _BlockingAdapter:
    def __init__(self, content: str) -> None:
        self.content = content
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0

    async def chat(self, *_args, **_kwargs):
        self.calls += 1
        self.started.set()
        await self.release.wait()
        return SimpleNamespace(content=self.content)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["diary", "timeline"])
async def test_async_generation_finishing_after_switch_cannot_commit(
    tmp_path,
    kind: str,
) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    scope = _scope(original, registry, tmp_path / "personas")
    adapter = _BlockingAdapter("Today I quietly recorded one honest thought.")
    module = scope.module(kind)
    if kind == "diary":
        manager = DiaryManager(
            original,
            adapter=adapter,
            emotion=_StableEmotion(),
            diary_dir=module.path,
            state_scope=module,
        )
        task = asyncio.create_task(manager.generate_daily_entry("2099-01-01"))
    else:
        settings = SimpleNamespace(
            timeline_enabled=True,
            world_life_enabled=True,
            timeline_visuals_enabled=False,
        )
        manager = TimelineManager(
            original,
            adapter=adapter,
            emotion=_StableEmotion(),
            feature_settings=settings,
            data_dir=module.path,
            state_scope=module,
        )
        task = asyncio.create_task(manager.generate_post("evening_reflection"))

    await adapter.started.wait()
    _switch_persona(registry, original)
    adapter.release.set()

    assert await task is None
    assert adapter.calls == 1
    if kind == "diary":
        assert not (module.path / "2099-01-01.json").exists()
        assert not (module.path / "keys").exists()
    else:
        assert not (module.path / "posts.json").exists()


@pytest.mark.asyncio
async def test_social_reply_finishing_after_switch_stays_out_of_durable_history(
    tmp_path,
) -> None:
    original = default_persona()
    registry = PersonaEpochRegistry()
    registry.activate_initial(original)
    scope = _scope(original, registry, tmp_path / "personas")
    module = scope.module("world")
    adapter = _BlockingAdapter("A reply from the old identity.")
    settings = SimpleNamespace(
        group_social_enabled=True,
        group_social_api_replies_enabled=True,
        group_social_max_api_calls_per_action=1,
        group_social_backchannel_probability=0.0,
        group_social_comment_probability=1.0,
    )
    universe = SocialUniverse(
        original,
        settings,
        adapter=adapter,
        state_scope=module,
    )
    universe.sync_character_cards(
        [{"name": "Friend", "personality": "calm", "role": "friend"}]
    )

    task = asyncio.create_task(universe.send_user_message("hello"))
    await adapter.started.wait()
    _switch_persona(registry, original)
    adapter.release.set()

    with pytest.raises(StalePersonaEpoch):
        await task
    with sqlite3.connect(universe.path) as connection:
        rows = connection.execute(
            "SELECT kind,content FROM social_group_messages ORDER BY created_at"
        ).fetchall()
    assert rows == [("user", "hello")]


def test_authoritative_histories_round_trip_beyond_previous_caps(tmp_path) -> None:
    interest_dir = tmp_path / "interest"
    tracker = InterestTracker(data_dir=interest_dir)
    tracker.import_all(
        {
            "interests": [
                {
                    "name": "painting",
                    "milestones": [f"milestone-{index}" for index in range(80)],
                    "activity_history": [
                        {"at": str(index), "note": f"activity-{index}"}
                        for index in range(240)
                    ],
                    "outputs": [
                        {"id": f"output-{index}", "title": f"output-{index}"}
                        for index in range(75)
                    ],
                }
            ]
        }
    )
    restored_interest = InterestTracker(data_dir=interest_dir).export_all()["interests"][0]
    assert len(restored_interest["milestones"]) == 80
    assert len(restored_interest["activity_history"]) == 240
    assert len(restored_interest["outputs"]) == 75

    affairs_dir = tmp_path / "affairs"
    affairs = PersonalAffairManager(data_dir=affairs_dir)
    affairs.import_all(
        {
            "affairs": [
                {
                    "id": "affair",
                    "title": "long plan",
                    "history": [
                        {"at": str(index), "progress": index, "note": str(index)}
                        for index in range(150)
                    ],
                }
            ]
        }
    )
    restored_affair = PersonalAffairManager(data_dir=affairs_dir).export_all()["affairs"][0]
    assert len(restored_affair["history"]) == 150

    social_dir = tmp_path / "social"
    circle = SocialCircle(data_dir=social_dir)
    circle.import_all(
        {
            "contacts": [
                {"id": "friend", "name": "Friend", "relationship": "friend"}
            ],
            "events": [
                {
                    "id": f"event-{index}",
                    "contact_id": "friend",
                    "contact_name": "Friend",
                    "event_type": "chat",
                    "description": str(index),
                    "occurred_at": str(index),
                }
                for index in range(1_050)
            ],
        }
    )
    restored_circle = SocialCircle(data_dir=social_dir)
    assert len(restored_circle.export_all()["events"]) == 1_050

    timeline_dir = tmp_path / "timeline"
    timeline = TimelineManager(default_persona(), data_dir=timeline_dir)
    timeline.import_all(
        {
            "posts": [
                {
                    "id": "post",
                    "date": "2099-01-01 20:00",
                    "content": "history",
                    "mood": "calm",
                    "emotions": {},
                    "source_facts": [f"post-fact-{index}" for index in range(35)],
                }
            ],
            "events": [
                {
                    "id": "story",
                    "title": "long story",
                    "started": "2099-01-01",
                    "last_post_date": "2099-01-01",
                    "facts": [f"event-fact-{index}" for index in range(45)],
                }
            ],
        }
    )
    restored_timeline = TimelineManager(default_persona(), data_dir=timeline_dir).export_all()
    assert len(restored_timeline["posts"][0]["source_facts"]) == 35
    assert len(restored_timeline["events"][0]["facts"]) == 45
