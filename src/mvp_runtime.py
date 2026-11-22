"""Composition root for the Windows MVP.

Only the capabilities required for one-character text companionship are
constructed here. Optional legacy modules stay importable for migration and
the developer TUI, but are not loaded into the packaged desktop process.
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
import logging
import threading
from pathlib import Path
from typing import Any

from src.api.adapter import LLMAdapter
from src.api.budget import ApiBudgetTracker
from src.bridge.ws_bridge import attach_bridge_state
from src.chat.encrypted_pending import EncryptedPendingChatStore
from src.chat.scheduler import MessageScheduler
from src.chat.proactive import ProactiveChat
from src.chat.session import ChatSession
from src.emotion.system import EmotionSystem
from src.kernel.storage import PersonaStateMigrationError
from src.memory.manager import MemoryManager
from src.relationship.tracker import RelationshipTracker
from src.user import UserManager


async def _await_background_writer(awaitable):
    """Cancelling a scheduler must also wait for its underlying file writer."""
    worker = asyncio.create_task(awaitable)
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError as cancelled:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not worker.cancelled():
            worker.exception()
        raise cancelled


async def _await_thread_writer(callback, *args):
    return await _await_background_writer(asyncio.to_thread(callback, *args))


async def _memory_maintenance_loop(memory: MemoryManager, logger: logging.Logger) -> None:
    while True:
        try:
            await asyncio.sleep(24 * 60 * 60)
            logger.info("Memory maintenance completed: %s", await _await_background_writer(memory.run_maintenance()))
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Memory maintenance loop error")


# The companion writes one diary entry per day. The trigger fires when the day
# already gathered enough exchanges but no entry exists yet; every concrete
# gate (feature flag, AI consent, provider availability) is re-checked inside
# DiaryManager.generate_daily_entry, which fails closed.
DIARY_MIN_EXCHANGES = 6
DIARY_CHECK_INTERVAL_S = 30 * 60


async def _diary_maintenance_loop(diary: Any, settings: Any, kernel_store: Any, logger: logging.Logger) -> None:
    from src.diary import DiaryWriteRejected

    while True:
        try:
            await asyncio.sleep(DIARY_CHECK_INTERVAL_S)
            if diary is None or kernel_store is None or not settings.features.diary_enabled:
                continue
            today = diary.today()
            persona_id = diary.persona.seal_identity().persona_id
            if kernel_store.count_persona_user_messages_on_local_date(persona_id, today) < DIARY_MIN_EXCHANGES:
                continue
            await diary.write_daily_entry_once(today, trigger="daily_auto")
        except asyncio.CancelledError:
            return
        except DiaryWriteRejected:
            continue
        except Exception:
            logger.exception("Diary maintenance loop error")


async def _memory_reembedding_loop(memory: MemoryManager, logger: logging.Logger) -> None:
    while True:
        try:
            await asyncio.sleep(30)
            result = await _await_thread_writer(memory.run_reembedding_batch)
            if result.get("processed") or result.get("failed"):
                logger.info("Memory re-embedding batch: %s", result)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Memory re-embedding loop error")


# Web surfing refreshes keyless-search/RSS content on a slow cadence and feeds
# the approved items into the "thought of you" ledger, which is the only path by
# which fresh online content reaches chat. The loop reads session.web on every
# tick so a runtime settings toggle can attach or detach the manager without a
# restart. A surfing failure is contained here and never disrupts chat.
WEB_SURFING_CHECK_INTERVAL_S = 600


async def _web_surfing_loop(
    session: Any,
    thought_engine: Any,
    world_clock: Any,
    logger: logging.Logger,
) -> None:
    while True:
        try:
            await asyncio.sleep(WEB_SURFING_CHECK_INTERVAL_S)
            active_web = getattr(session, "web", None)
            if active_web is None or thought_engine is None or world_clock is None:
                continue
            refreshed = await active_web.fetch_if_needed()
            if refreshed:
                logger.info("WebSurfing: content refreshed")
            thought_engine.ingest(active_web.approved_items(), now=world_clock.now())
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("WebSurfing loop error")


_ACTIVE_DESKTOP_RUNTIME: "MvpDesktopRuntime | None" = None


def get_active_desktop_runtime() -> "MvpDesktopRuntime | None":
    return _ACTIVE_DESKTOP_RUNTIME


class MvpDesktopRuntime:
    """Own the minimal desktop object graph and its lifecycle."""

    def start_diary_write(self, write: Coroutine[Any, Any, None]) -> None:
        """Keep a manual writer in the same lifecycle as automatic writers."""
        task = asyncio.create_task(write)
        self._tasks.append(task)

        def forget(finished: asyncio.Task[Any]) -> None:
            if finished in self._tasks:
                self._tasks.remove(finished)

        task.add_done_callback(forget)

    def __init__(
        self,
        *,
        persona: Any,
        settings: Any,
        memory_state: Any,
        emotion_state: Any,
        relationship_state: Any,
        persona_state: Any,
        kernel_store: Any,
        module_registry: Any,
        logger: logging.Logger,
    ) -> None:
        self._logger = logger
        self._settings = settings
        self._kernel_store = kernel_store
        self._pending_chat_store = EncryptedPendingChatStore(kernel_store)
        self._module_registry = module_registry
        self._tasks: list[asyncio.Task[Any]] = []
        self._closed = False
        self._owner_thread = threading.get_ident()
        self._restore_lock = asyncio.Lock()
        self._restore_generation = 0
        self._recovery_state = "clean"
        self._recovery_reason = ""
        self._startup_recovery_pending = False
        self._startup_recovery_scheduled = False
        self._legacy_restore_pending = False
        self._user_manager = None
        self._mount_graph(
            persona=persona,
            memory_state=memory_state,
            emotion_state=emotion_state,
            relationship_state=relationship_state,
            persona_state=persona_state,
        )

    def _persona_state_managers(self, persona, *, scoped, emotion_state=None, relationship_state=None):
        features = self._settings.features
        persona_id = persona.identity_envelope.persona_id if scoped else None
        emotion = EmotionSystem(
            values=dict(persona.emotions),
            state_path=emotion_state.file("state.json") if emotion_state is not None else None,
            document_store=self._kernel_store,
            enabled=features.emotion_system_enabled,
            carryover_days=features.emotion_carryover_days,
            inertia_factor=features.emotion_inertia_factor,
            pause_intervals=list(features.emotion_pause_intervals),
            defer_startup_writes=True,
            persona_id=persona_id,
        )
        relationship = RelationshipTracker(
            initial_intimacy=50,
            state_path=relationship_state.file("state.json") if relationship_state is not None else None,
            document_store=self._kernel_store,
            defer_startup_writes=True,
            persona_id=persona_id,
        )
        return emotion, relationship

    @staticmethod
    def _validate_legacy_persona_document(name, document):
        if name == "persona_emotion_state":
            EmotionSystem(defer_startup_writes=True)._apply_state(document)
        else:
            RelationshipTracker()._apply_state(document)

    def _migrate_persona_state(self, persona, session, diary, backup_manager):
        emotion: EmotionSystem
        relationship: RelationshipTracker

        def prepare_current():
            nonlocal emotion, relationship
            emotion, relationship = self._persona_state_managers(persona, scoped=True)

        # Load the current persona while the copies and marker can still roll back.
        migrated = self._kernel_store.migrate_persona_state(
            persona.identity_envelope.persona_id, self._validate_legacy_persona_document,
            prepare_current=prepare_current,
        )
        emotion.world_clock = session.world_clock
        session.emotion, session.relationship = emotion, relationship
        session._last_safe_emotions = dict(emotion.values)
        session._last_safe_intimacy = relationship.intimacy
        if diary is not None:
            diary.emotion = emotion
        backup_manager.emotion, backup_manager.relationship = emotion, relationship
        self._persona_state_migration_pending = False
        if migrated:
            self._logger.info("Persona state migration completed")
        return emotion, relationship

    def _finish_recovered_persona_state(self) -> None:
        if self._recovery_state != "clean" or not getattr(self, "_persona_state_migration_pending", False):
            return
        from src.bridge import ws_bridge

        try:
            emotion, relationship = self._migrate_persona_state(
                self._session.persona, self._session, self._diary, self._backup_manager,
            )
        except PersonaStateMigrationError as exc:
            self._recovery_state = "recovery_required"
            self._recovery_reason = exc.code
            self._backup_manager._lock_recovery(exc.code)
            self._logger.error("%s", exc.code)
        else:
            ws_bridge.bridge_state.emotion = emotion
            ws_bridge.bridge_state.relationship = relationship
            emotion.defer_startup_writes = False

    def _mount_proactive(self) -> ProactiveChat | None:
        from src.bridge import ws_bridge
        from src.conversation_summary.runtime import current_runtime_settings
        from src.persona.identity import GLOBAL_PERSONA_EPOCH

        session = self._session
        features = current_runtime_settings(self._settings).features
        try:
            return ProactiveChat(
                session.persona, session.adapter, session.emotion, session.scheduler,
                relationship=session.relationship,
                daily_limit=features.proactive_daily_limit,
                min_interval_minutes=features.proactive_min_interval_minutes,
                memory=self._memory, user_manager=self._user_manager, world_clock=session.world_clock,
                speech_habit_engine=session.speech_habits, persona_epoch_registry=GLOBAL_PERSONA_EPOCH,
                kernel_store=self._kernel_store, chat_busy=lambda: bool(self._pending_chat_store.list_active()),
                preview_mode=True, writes_blocked=lambda: ws_bridge.recovery_status_payload()["writes_blocked"],
            )
        except Exception:
            self._logger.warning("Preview proactive capability could not be initialized")
            return None

    def _refresh_proactive_after_restore(self) -> None:
        if not hasattr(self, "_proactive"):
            return
        from src.bridge import ws_bridge

        self._proactive = self._mount_proactive()
        ws_bridge.bridge_state.proactive = self._proactive

    async def _stop_proactive(self) -> None:
        proactive = getattr(self, "_proactive", None)
        if proactive is None:
            return
        task = proactive._task
        proactive.stop()
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    def _mount_graph(
        self,
        *,
        persona: Any,
        memory_state: Any,
        emotion_state: Any,
        relationship_state: Any,
        persona_state: Any,
    ) -> None:
        settings = self._settings
        kernel_store = self._kernel_store
        module_registry = self._module_registry
        from src.backup import LocalBackupManager
        from src.config.settings import WORLD_STATE_DB
        from src.world_state_store import WorldStateStore

        journal_path = persona_state.root / "restore" / "restore.sqlite3"
        identity = persona.identity_envelope
        restore_identity = {"persona_id": identity.persona_id, "fingerprint": identity.fingerprint,
                            "identity_version": identity.version}
        pending = None
        try:
            pending = WorldStateStore.peek_pending(journal_path)
            for legacy_journal in (persona_state.root / "world" / WORLD_STATE_DB.name, WORLD_STATE_DB):
                try:
                    legacy_pending = WorldStateStore.peek_pending(legacy_journal)
                except Exception:
                    self._legacy_restore_pending = True
                    raise
                if legacy_pending is not None:
                    self._legacy_restore_pending = True
                    self._recovery_state = "recovery_required"
                    self._recovery_reason = "An older recovery journal requires explicit migration"
        except Exception as exc:
            self._recovery_state = "recovery_required"
            self._recovery_reason = str(exc)
        deferred = pending is not None or self._recovery_state != "clean"
        if pending is not None and self._recovery_state == "clean":
            self._recovery_state = "recovering"
        restore_store = None
        try:
            restore_state = persona_state.module("restore", legacy_path=None)
            restore_store = WorldStateStore(restore_state.file("restore.sqlite3"), persona_identity=restore_identity)
        except Exception as exc:
            self._recovery_state = "recovery_required"
            self._recovery_reason = str(exc)
        deferred = deferred or self._recovery_state != "clean"
        scoped_state = kernel_store.persona_state_migrated()
        self._persona_state_migration_pending = not scoped_state
        try:
            emotion, relationship = self._persona_state_managers(
                persona, scoped=scoped_state,
                emotion_state=None if scoped_state else emotion_state,
                relationship_state=None if scoped_state else relationship_state,
            )
        except Exception:
            if not scoped_state and not deferred:
                raise PersonaStateMigrationError() from None
            raise
        # Constructors load existing state first. Derived projection/seed work
        # is allowed only after the journal decision has been replayed.
        from src.conversation_summary.runtime import current_runtime_settings

        api_budget = ApiBudgetTracker(
            settings.features,
            settings_provider=lambda: current_runtime_settings(settings).features,
        )
        adapter = LLMAdapter(
            settings.llm,
            budget_tracker=api_budget,
            cost_sentinel_tokens=settings.features.api_cost_sentinel_tokens,
        )
        memory = MemoryManager(
            persona,
            settings.memory,
            adapter=adapter,
            feature_settings=settings.features,
            state_scope=memory_state,
            defer_startup_writes=True,
        )
        # The MVP stores only user-grounded interaction evidence. Autonomous
        # extraction remains outside the packaged composition root, including
        # after a memory settings update re-applies the feature switches.
        memory.pin_autonomous_gate_off()
        scheduler = MessageScheduler(
            reply_delay_min=settings.chat.reply_delay_min,
            reply_delay_max=settings.chat.reply_delay_max,
            split_messages=settings.chat.split_messages,
            typing_indicator=settings.chat.typing_indicator,
            status=settings.chat.status,
            allow_environment_description=settings.chat.allow_environment_description,
        )
        user_manager = UserManager(document_store=kernel_store, defer_startup_writes=True)

        conversation_summary = None
        try:
            from src.conversation_summary.runtime import ConversationSummaryRuntime
            from src.conversation_summary.store import SummaryStore

            summary_token = persona_state.registry.token()
            conversation_summary = ConversationSummaryRuntime(
                SummaryStore(kernel_store, summary_token),
                adapter,
                registry=persona_state.registry,
                token=summary_token,
                enabled=lambda: bool(current_runtime_settings(settings).features.hypa_compression_enabled),
                llm_settings_provider=lambda: current_runtime_settings(settings).llm,
            )
        except Exception:
            self._logger.exception("Conversation summary unavailable; chat continues")

        # Web surfing + the "thought of you" ledger. Keyless web search results
        # reach chat only through ThoughtOfYouEngine, so the two ship together.
        # world_clock and the ledger are cheap and built unconditionally (no
        # network) so a later settings toggle can attach a WebSurfingManager and
        # have somewhere to ingest into; web surfing itself is feature-gated
        # exactly like the full runtime. Each stage is isolated so a web/ambient
        # failure can never take chat down.
        world_clock = None
        thought_engine = None
        web_surfing = None
        try:
            from src.ambient import ThoughtOfYouEngine
            from src.config.settings import WORLD_STATE_DB
            from src.world import WorldClock

            web_world_state = persona_state.module("world", legacy_path=WORLD_STATE_DB)
            world_clock = WorldClock("Asia/Shanghai", defer_startup_writes=deferred)
            web_world_state_db = web_world_state.file(WORLD_STATE_DB.name)
            thought_engine = ThoughtOfYouEngine(
                settings.features, path=web_world_state_db, world_clock=world_clock
            )
        except Exception:
            self._logger.exception("Thought-of-you ledger failed during startup; isolating it")
            thought_engine = None

        if getattr(settings.features, "web_surfing_enabled", False):
            try:
                from src.web import WebSurfingManager

                web_surfing = WebSurfingManager(
                    persona,
                    adapter,
                    allowed_topics=settings.features.web_allowed_topics,
                    refresh_interval_minutes=settings.features.web_refresh_interval_minutes,
                    search_windows=settings.features.web_search_windows,
                    keyless_search_enabled=settings.features.surf_keyless_search_enabled,
                    surfing_consent=bool(
                        settings.features.web_surfing_enabled
                        and settings.features.web_disclaimer_acknowledged
                    ),
                )
            except Exception:
                self._logger.exception("Web surfing failed during startup; isolating it")
                web_surfing = None

        if not deferred and web_surfing is not None and thought_engine is not None and world_clock is not None:
            try:
                thought_engine.ingest(web_surfing.approved_items(), now=world_clock.now())
            except Exception:
                self._logger.exception("Initial web ingest failed; continuing without it")

        # Persona-scoped archive (character cards + world books) and the world
        # book matcher. The archive is the canonical store the import flow
        # writes into; the matcher loads active entries from it and injects
        # them into the chat prompt via ChatSession. Either may fail
        # independently and the chat keeps working without them.
        archive_store = None
        worldbook_runtime = None
        try:
            from src.archive import ArchiveStore

            archive_state = persona_state.module("archive", legacy_path=None)
            archive_store = ArchiveStore(archive_state.file("archive.sqlite3"))
        except Exception:
            self._logger.exception("Archive store failed during startup; isolating it")
            archive_store = None
        try:
            from src.worldbook.runtime import WorldbookRuntime, archive_available
            from src.persona.identity import GLOBAL_PERSONA_EPOCH

            persona_id = GLOBAL_PERSONA_EPOCH.token().persona_id
            worldbook_runtime = WorldbookRuntime(
                archive_store, persona_id,
                available=lambda: archive_available(module_registry),
            )
        except Exception:
            self._logger.exception("World book runtime failed during startup; isolating it")
            worldbook_runtime = None

        session = ChatSession(
            persona=persona,
            adapter=adapter,
            memory=memory,
            emotion=emotion,
            relationship=relationship,
            scheduler=scheduler,
            user_manager=user_manager,
            feature_settings=settings.features,
            web_surfing=web_surfing,
            world_clock=world_clock,
            thought_engine=thought_engine,
            worldbook_runtime=worldbook_runtime,
            conversation_summary=conversation_summary,
            kaomoji_hints=True,
        )

        stickers = None
        try:
            from src.stickers import StickerManager

            stickers = StickerManager(user_manager=user_manager)
        except Exception:
            self._logger.exception("Sticker manager failed during startup; isolating it")
            stickers = None

        image_service = None
        if getattr(settings.features, "image_service_enabled", False):
            try:
                from src.image_service import FoxgirlImageService

                image_service = FoxgirlImageService()
            except Exception:
                self._logger.exception("Image service failed during startup; isolating it")
                image_service = None

        social_universe = None
        try:
            from src.config.settings import PERSONA_DIR, WORLD_STATE_DB
            from src.social.universe import SocialUniverse

            world_state = persona_state.module("world", legacy_path=WORLD_STATE_DB)
            world_state_db = world_state.file(WORLD_STATE_DB.name)
            social_universe = SocialUniverse(
                persona,
                settings.features,
                adapter=adapter,
                path=world_state_db,
                state_scope=world_state,
                memory=memory,
                defer_startup_writes=True,
            )
        except Exception:
            self._logger.exception("Social universe failed during startup; isolating it")
            social_universe = None

        immersion = None
        try:
            from src.immersion import ImmersionManager

            immersion = ImmersionManager(settings.features)
        except Exception:
            self._logger.exception("Immersion manager failed during startup; isolating it")
            immersion = None

        game_state_store = None
        try:
            from src.games.state_store import GameStateStore

            game_state = persona_state.module("games", legacy_path=None)
            game_state_store = GameStateStore(game_state.file("game_state.sqlite3"))
        except Exception:
            self._logger.exception("Game-state store failed during startup; isolating it")
            game_state_store = None

        keepsakes = None
        try:
            from src.keepsakes import KeepsakeManager

            keepsake_state = persona_state.module("keepsakes", legacy_path=None)
            keepsakes = KeepsakeManager(
                keepsake_state.path,
                enabled=bool(getattr(settings.features, "keepsake_collection_enabled", False)),
                recall_probability=float(
                    getattr(settings.features, "keepsake_recall_probability", 0.05) or 0.05
                ),
            )
        except Exception:
            self._logger.exception("Keepsake manager failed during startup; isolating it")
            keepsakes = None

        from src.keepsakes.preview import PreviewKeepsakes

        preview_keepsakes = PreviewKeepsakes(kernel_store, identity.persona_id, require_writable=self.require_writable)
        session.keepsakes = preview_keepsakes
        self._legacy_keepsakes = keepsakes

        # The diary is one of the product's core artifacts: the LLM-written,
        # encrypted daily entry behind the DreamRoom diary panel. Isolated so a
        # diary failure can never take chat down with it.
        diary = None
        try:
            from src.diary import DiaryManager

            diary_state = persona_state.module("diary", legacy_path=None)
            diary = DiaryManager(
                persona,
                adapter=adapter,
                emotion=emotion,
                memory=memory,
                state_scope=diary_state,
                read_only_crypto=deferred,
            )
        except Exception:
            self._logger.exception("Diary manager failed during startup; isolating it")
            diary = None

        # Native full backup (R006): exports/restores the complete local state
        # through the Electron backup UI. Isolated so a backup failure never
        # takes chat down; optional managers inside LocalBackupManager are
        # already None-safe.
        backup_manager = None
        try:
            from src.backup import LocalBackupManager

            backup_manager = LocalBackupManager(
                memory=memory,
                emotion=emotion,
                relationship=relationship,
                diary=diary,
                user_manager=user_manager,
                timeline=None,
                social_circle=None,
                interest_tracker=None,
                affair_manager=None,
                world_clock=world_clock,
                ambient_presence=None,
                thought_engine=thought_engine,
                diary_keys=None,
                phrase_alignment=None,
                social_universe=social_universe,
                state_store=restore_store,
            )
            if restore_store is None or self._recovery_state == "recovery_required":
                self._recovery_state = "recovery_required"
                backup_manager._lock_recovery(self._recovery_reason or "Encrypted recovery journal is unavailable")
            elif self._recovery_state != "recovery_required":
                status = backup_manager.recovery_status()
                self._recovery_state = status.get("recovery_state", status.get("state", "recovery_required"))
                self._startup_recovery_pending = pending is not None and self._recovery_state != "recovery_required"
            if self._recovery_state == "clean" and not deferred:
                emotion.defer_startup_writes = False
                if self._persona_state_migration_pending:
                    emotion, relationship = self._migrate_persona_state(persona, session, diary, backup_manager)
                    emotion.defer_startup_writes = False
                emotion.apply_daily_carryover()
                memory.store.initialize_derivatives()
                memory.layers._sync_permanent_identity()
                user_manager.on_session_start()
                memory.sync_user_profile(user_manager)
                if social_universe is not None:
                    social_universe._upsert_character(
                        character_id="owner", name=persona.name,
                        role=str(persona.identity.get("title", "")),
                        personality="、".join(persona.personality_traits[:12]),
                        speaking_style=str(persona.speaking_style.get("tone", "")), source="active_persona",
                    )
                    social_universe._ensure_default_thread()
                    social_universe.sync_persona_registry(PERSONA_DIR)
        except PersonaStateMigrationError:
            raise
        except Exception:
            self._logger.exception("Backup manager failed during startup; isolating it")
            backup_manager = None
            self._recovery_state = "recovery_required"
            self._recovery_reason = "Restore manager failed during startup"

        if self._recovery_state == "clean" and not deferred and getattr(settings.features, "neko_import_enabled", False):
            try:
                from src.memory import neko_import

                source_dir = str(getattr(settings.features, "neko_import_source_dir", "") or "")
                if source_dir:
                    self._tasks.append(asyncio.create_task(
                        _await_thread_writer(neko_import.import_from_directory, memory, source_dir)
                    ))
            except Exception:
                self._logger.exception("N.E.K.O import failed during startup; skipping it")

        self._adapter = adapter
        self._memory = memory
        self._session = session
        self._user_manager = user_manager
        self._game_state_store = game_state_store
        self._archive_store = archive_store
        self._worldbook_runtime = worldbook_runtime
        self._kernel_store = kernel_store
        self._diary = diary
        self._backup_manager = backup_manager
        self._web_surfing = web_surfing
        self._thought_engine = thought_engine
        self._world_clock = world_clock
        if self._recovery_state == "clean":
            self._pending_chat_store.initialize_writable()
        self._proactive = self._mount_proactive()
        session.restore_generation = self._restore_generation
        session.require_runtime_writable = self.require_writable
        attach_bridge_state(
            session=session,
            proactive=self._proactive,
            adapter=adapter,
            emotion=emotion,
            memory=memory,
            persona=persona,
            relationship=relationship,
            settings=settings,
            user_mgr=user_manager,
            api_budget=api_budget,
            kernel_store=kernel_store,
            module_registry=module_registry,
            image_service=image_service,
            social_universe=social_universe,
            immersion=immersion,
            game_state_store=game_state_store,
            keepsakes=None,
            preview_keepsakes=preview_keepsakes,
            stickers=stickers,
            diary=diary,
            web_surfing=web_surfing,
            thought_engine=thought_engine,
            world_clock=world_clock,
            archive_store=archive_store,
            worldbook_runtime=worldbook_runtime,
            backup_manager=backup_manager,
            recovery_state=self._recovery_state,
            recovery_reason=self._recovery_reason,
            restore_coordinator=self,
            preview_pending_chat_store=self._pending_chat_store,
            preview_chat_images=True,
            preview_proactive=True,
        )
        try:
            from src.bridge.ws_bridge import _apply_imported_prompt_opts_from_archive

            _apply_imported_prompt_opts_from_archive()
        except Exception:
            self._logger.exception("Imported prompt opts failed to reload after remount")

    def _start_background_tasks(self) -> None:
        if self._recovery_state != "clean" or getattr(self, "_closed", False):
            return
        self._pending_chat_store.initialize_writable()
        if getattr(self, "_proactive", None) is not None:
            from src.conversation_summary.runtime import current_runtime_settings

            self._proactive.apply_preview_settings(current_runtime_settings(self._settings).features)
        self._tasks.extend([
            asyncio.create_task(_memory_maintenance_loop(self._memory, self._logger)),
            asyncio.create_task(_memory_reembedding_loop(self._memory, self._logger)),
        ])
        if self._diary is not None:
            self._tasks.append(asyncio.create_task(_diary_maintenance_loop(
                self._diary,
                self._settings,
                self._kernel_store,
                self._logger,
            )))
        if self._thought_engine is not None and self._world_clock is not None:
            self._tasks.append(asyncio.create_task(_web_surfing_loop(
                self._session,
                self._thought_engine,
                self._world_clock,
                self._logger,
            )))

    def require_writable(self) -> None:
        status = getattr(getattr(self, "_backup_manager", None), "recovery_status", None)
        snapshot = status() if callable(status) else {}
        if getattr(self, "_closed", False) or self._recovery_state != "clean" or snapshot.get("recovery_state", snapshot.get("state", "clean")) != "clean":
            raise RuntimeError("Recovery state blocks runtime writes")

    def start_startup_recovery(self) -> None:
        """The transport publishes authenticated read-only ready before replay."""
        if getattr(self, "_closed", False) or not self._startup_recovery_pending or self._startup_recovery_scheduled:
            return
        self._startup_recovery_scheduled = True
        self._tasks.append(asyncio.create_task(self._recover_startup()))

    async def _recover_startup(self) -> None:
        from src.bridge import ws_bridge

        if getattr(self, "_closed", False):
            return
        if threading.get_ident() != self._owner_thread:
            raise RuntimeError("Startup recovery must run on the runtime owner thread")
        try:
            self._backup_manager.recover_interrupted_restore()
            status = self._backup_manager.recovery_status()
            self._recovery_state = status.get("recovery_state", status.get("state", "recovery_required"))
            self._recovery_reason = str(status.get("reason", "") or "")
        except Exception as exc:
            self._recovery_state = "recovery_required"
            self._recovery_reason = str(exc)
        self._startup_recovery_pending = False
        self._finish_recovered_persona_state()
        ws_bridge.bridge_state.recovery_state = self._recovery_state
        ws_bridge.bridge_state.recovery_reason = self._recovery_reason
        if self._recovery_state == "clean":
            self._refresh_proactive_after_restore()
            if self._diary is not None:
                self._diary.read_only_crypto = False
            self._start_background_tasks()
        await ws_bridge.broadcast(ws_bridge.MsgType.RUNTIME_ACTIVITY, ws_bridge._runtime_activity_payload())

    async def _quiesce_restore_writers(self) -> None:
        from src.bridge import ws_bridge

        await self._stop_proactive()
        tasks = set(self._tasks)
        for task in tasks:
            task.cancel()
        coordinator = ws_bridge._chat_coordinator
        if coordinator is not None:
            await coordinator.cancel_all(reason="backup_restore")
            tasks.update(task for task in coordinator.tasks.values() if not task.done())
        summary = getattr(self._session, "conversation_summary", None)
        if summary is not None:
            for field in ("_task", "_provider_task"):
                task = getattr(summary, field, None)
                if isinstance(task, asyncio.Task) and not task.done():
                    tasks.add(task)
                    task.cancel()
        for name in ("proactive", "work_manager"):
            manager = getattr(ws_bridge.bridge_state, name, None)
            stop = getattr(manager, "stop", None)
            if callable(stop):
                result = stop()
                if asyncio.iscoroutine(result):
                    await result
            for field in ("_task", "task", "_provider_task"):
                task = getattr(manager, field, None)
                if isinstance(task, asyncio.Task) and not task.done():
                    tasks.add(task)
                    task.cancel()
        if tasks:
            # No journal or before-snapshot is created until every underlying
            # writer has actually exited. Cancelling an await alone is not a
            # statement about a thread or provider callback finishing.
            await asyncio.gather(*tasks, return_exceptions=True)
        if summary is not None and not summary.cleanup_confirmed:
            raise RuntimeError("Summary cleanup was not confirmed")
        self._tasks.clear()

    async def restore_file(self, path: Path, *, rescue: bool = False,
                           expected_sha256: str | None = None,
                           expected_file_bytes: int | None = None) -> dict[str, Any]:
        """Inspect read-only, quiesce, then apply on the SQLite owner thread."""
        from src.backup_inspection import BackupRestoreError, inspect_backup_file
        from src.bridge import ws_bridge

        if getattr(self, "_closed", False) or threading.get_ident() != self._owner_thread:
            raise BackupRestoreError("Restore must run on the runtime owner thread", code="BACKUP_RESTORE_DISABLED")
        inspection = await asyncio.to_thread(inspect_backup_file, path)
        if self._backup_manager is None:
            raise BackupRestoreError("Restore manager is unavailable", code="BACKUP_RESTORE_DISABLED")
        if getattr(self, "_legacy_restore_pending", False):
            raise BackupRestoreError("An older recovery journal requires migration", code="BACKUP_RECOVERY_REQUIRED")
        if self._recovery_state != "clean" and not rescue:
            raise BackupRestoreError("Recovery requires an explicit rescue import", code="BACKUP_RECOVERY_REQUIRED")
        async with self._restore_lock:
            try:
                prepared = self._backup_manager.prepare_file(
                    path, rescue=rescue, expected_sha256=expected_sha256 or inspection.sha256,
                    expected_file_bytes=(expected_file_bytes if expected_file_bytes is not None else inspection.file_bytes),
                )
            except BaseException:
                status = self._backup_manager.recovery_status()
                state = status.get("recovery_state", status.get("state", "recovery_required"))
                if state != "clean":
                    async with ws_bridge._persona_effect_lock:
                        self._recovery_state = "recovery_required"
                        self._recovery_reason = "Backup preparation found an unresolved recovery state"
                        ws_bridge.bridge_state.recovery_state = self._recovery_state
                        self._restore_generation += 1
                        self._session.restore_generation = self._restore_generation
                        ws_bridge.bridge_state.model_epoch += 1
                        try:
                            await self._quiesce_restore_writers()
                        finally:
                            await ws_bridge.broadcast(ws_bridge.MsgType.RUNTIME_ACTIVITY, ws_bridge._runtime_activity_payload())
                raise
            try:
                return await self._restore_prepared(prepared, rescue=rescue)
            finally:
                self._backup_manager.discard_prepared(prepared)

    async def _restore_prepared(self, prepared: Any, *, rescue: bool) -> dict[str, Any]:
        from src.backup_inspection import BackupRestoreError
        from src.bridge import ws_bridge

        async with ws_bridge._persona_effect_lock:
            self._recovery_state = "recovering"
            ws_bridge.bridge_state.recovery_state = "recovering"
            self._restore_generation += 1
            self._session.restore_generation = self._restore_generation
            # Any cached pre-restore reply also carries this model scope.
            ws_bridge.bridge_state.model_epoch += 1
            await ws_bridge.broadcast(ws_bridge.MsgType.RUNTIME_ACTIVITY, ws_bridge._runtime_activity_payload())
            try:
                await self._quiesce_restore_writers()
            except BaseException as exc:
                self._recovery_state = "recovery_required"
                self._recovery_reason = "Runtime writer quiescence was not confirmed"
                self._backup_manager._lock_recovery(self._recovery_reason)
                ws_bridge.bridge_state.recovery_state = self._recovery_state
                ws_bridge.bridge_state.recovery_reason = self._recovery_reason
                raise BackupRestoreError(self._recovery_reason, code="BACKUP_RECOVERY_REQUIRED") from exc
            try:
                # KernelStore contains thread-affine SQLite connections.
                # This application intentionally never uses to_thread.
                result = self._backup_manager.restore_prepared(prepared, rescue=rescue)
                if not isinstance(result, dict) or result.get("outcome") not in {"committed", "rolled_back"}:
                    self._backup_manager._lock_recovery("Restore did not return a confirmed terminal outcome")
                    raise BackupRestoreError("Restore outcome could not be confirmed", code="BACKUP_RECOVERY_REQUIRED")
                return result
            finally:
                status = self._backup_manager.recovery_status()
                self._recovery_state = status.get("recovery_state", status.get("state", "recovery_required"))
                self._recovery_reason = str(status.get("reason", "") or "")
                self._finish_recovered_persona_state()
                ws_bridge.bridge_state.recovery_state = self._recovery_state
                ws_bridge.bridge_state.recovery_reason = self._recovery_reason
                if self._recovery_state == "clean":
                    self._refresh_proactive_after_restore()
                    self._memory._pending_injection = []
                    if self._diary is not None:
                        self._diary.read_only_crypto = False
                    self._start_background_tasks()
                await ws_bridge.broadcast(ws_bridge.MsgType.RUNTIME_ACTIVITY, ws_bridge._runtime_activity_payload())

    async def _stop_persona_graph(self) -> None:
        worldbook_cleanup_error = None
        summary_cleanup_error = None
        await self._stop_proactive()
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        user_manager = getattr(self, "_user_manager", None)
        if user_manager is not None and self._recovery_state == "clean":
            try:
                user_manager.save()
            except Exception:
                self._logger.exception("User profile save during persona remount failed")
        session = getattr(self, "_session", None)
        if session is not None:
            try:
                await session.close()
            except Exception as exc:
                self._logger.exception("Session shutdown during persona remount failed")
                worldbook = getattr(self, "_worldbook_runtime", None)
                if worldbook is not None and not worldbook.cleanup_confirmed:
                    worldbook_cleanup_error = exc
                summary = getattr(session, "conversation_summary", None)
                if summary is not None and not summary.cleanup_confirmed:
                    summary_cleanup_error = exc
        memory = getattr(self, "_memory", None)
        if memory is not None:
            try:
                memory.store.close()
            except Exception:
                self._logger.exception("Memory database shutdown during persona remount failed")
        game_state_store = getattr(self, "_game_state_store", None)
        if game_state_store is not None:
            try:
                game_state_store.close()
            except Exception:
                self._logger.exception("Game-state store shutdown during persona remount failed")
        archive_store = getattr(self, "_archive_store", None)
        if archive_store is not None:
            try:
                archive_store.close()
            except Exception:
                self._logger.exception("Archive store shutdown during persona remount failed")

        if worldbook_cleanup_error is not None:
            raise RuntimeError("Worldbook worker cleanup was not confirmed; persona remount blocked") from worldbook_cleanup_error
        if summary_cleanup_error is not None:
            raise RuntimeError("Summary provider cleanup was not confirmed; persona remount blocked") from summary_cleanup_error

    async def remount_persona(self, persona: Any) -> None:
        """Rebuild persona-scoped modules after a privileged identity switch."""
        self.require_writable()
        from src.config.settings import (
            DATA_DIR,
            EMOTION_DIR,
            MEMORY_DIR,
            RELATIONSHIP_DIR,
        )
        from src.kernel.contracts import PersonaScopeV4
        from src.persona.identity import GLOBAL_PERSONA_EPOCH
        from src.persona.persona_card import default_persona
        from src.persona.sillytavern_import import KNOWN_LEGACY_DEFAULT_FINGERPRINTS
        from src.persona.state_scope import PersonaStateScope

        await self._stop_persona_graph()
        token = GLOBAL_PERSONA_EPOCH.token()
        envelope = GLOBAL_PERSONA_EPOCH.envelope()
        self._kernel_store.activate_persona(
            PersonaScopeV4(
                persona_id=token.persona_id,
                epoch=token.epoch,
                fingerprint=token.fingerprint,
            ),
            identity=envelope.core_identity,
            identity_version=envelope.version,
            actor="owner",
            reason="live persona remount after identity switch",
        )
        fingerprints = set(KNOWN_LEGACY_DEFAULT_FINGERPRINTS)
        fingerprints.add(default_persona().seal_identity().fingerprint)
        persona_state = PersonaStateScope(
            persona,
            registry=GLOBAL_PERSONA_EPOCH,
            base_dir=DATA_DIR / "personas",
            legacy_fingerprint_allowlist=fingerprints,
        )
        self._mount_graph(
            persona=persona,
            memory_state=persona_state.module("memory", legacy_path=MEMORY_DIR),
            emotion_state=persona_state.module("emotion", legacy_path=EMOTION_DIR),
            relationship_state=persona_state.module(
                "relationship",
                legacy_path=RELATIONSHIP_DIR,
            ),
            persona_state=persona_state,
        )
        self._start_background_tasks()

    async def run(self, *, stdio: bool, host: str, port: int) -> None:
        global _ACTIVE_DESKTOP_RUNTIME
        _ACTIVE_DESKTOP_RUNTIME = self
        self._start_background_tasks()
        try:
            if stdio:
                from src.bridge.stdio_bridge import start_stdio_bridge

                self._logger.info("Launching minimal private framed-stdio bridge")
                await start_stdio_bridge()
            else:
                from src.bridge.ws_bridge import start_bridge

                self._logger.info(
                    "Launching minimal development bridge on ws://%s:%s",
                    host,
                    port,
                )
                await start_bridge(host=host, port=port)
        finally:
            if _ACTIVE_DESKTOP_RUNTIME is self:
                _ACTIVE_DESKTOP_RUNTIME = None
            await self.close()

    async def close(self) -> None:
        self._closed = True
        worldbook_cleanup_error = None
        summary_cleanup_error = None
        await self._stop_proactive()
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        if self._recovery_state == "clean":
            try:
                self._user_manager.save()
            except Exception:
                self._logger.exception("User profile save during shutdown failed")
        try:
            await self._session.close()
        except Exception as exc:
            self._logger.exception("Session shutdown failed")
            worldbook = getattr(self, "_worldbook_runtime", None)
            if worldbook is not None and not worldbook.cleanup_confirmed:
                worldbook_cleanup_error = exc
            summary = getattr(self._session, "conversation_summary", None)
            if summary is not None and not summary.cleanup_confirmed:
                summary_cleanup_error = exc
        try:
            self._memory.store.close()
        except Exception:
            self._logger.exception("Memory database shutdown failed")
        try:
            game_state_store = getattr(self, "_game_state_store", None)
            if game_state_store is not None:
                game_state_store.close()
        except Exception:
            self._logger.exception("Game-state store shutdown failed")
        try:
            archive_store = getattr(self, "_archive_store", None)
            if archive_store is not None:
                archive_store.close()
        except Exception:
            self._logger.exception("Archive store shutdown failed")

        if worldbook_cleanup_error is not None:
            raise RuntimeError("Worldbook worker cleanup was not confirmed") from worldbook_cleanup_error
        if summary_cleanup_error is not None:
            raise RuntimeError("Summary provider cleanup was not confirmed") from summary_cleanup_error


async def run_mvp_desktop(
    *,
    persona: Any,
    settings: Any,
    memory_state: Any,
    emotion_state: Any,
    relationship_state: Any,
    persona_state: Any,
    kernel_store: Any,
    module_registry: Any,
    logger: logging.Logger,
    stdio: bool,
    host: str,
    port: int,
) -> None:
    """Create and run the single supported packaged runtime profile."""

    runtime = MvpDesktopRuntime(
        persona=persona,
        settings=settings,
        memory_state=memory_state,
        emotion_state=emotion_state,
        relationship_state=relationship_state,
        persona_state=persona_state,
        kernel_store=kernel_store,
        module_registry=module_registry,
        logger=logger,
    )
    await runtime.run(stdio=stdio, host=host, port=port)
