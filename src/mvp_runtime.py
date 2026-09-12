"""Composition root for the Windows MVP.

Only the capabilities required for one-character text companionship are
constructed here. Optional legacy modules stay importable for migration and
the developer TUI, but are not loaded into the packaged desktop process.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from src.api.adapter import LLMAdapter
from src.api.budget import ApiBudgetTracker
from src.bridge.ws_bridge import attach_bridge_state
from src.chat.scheduler import MessageScheduler
from src.chat.session import ChatSession
from src.emotion.system import EmotionSystem
from src.memory.manager import MemoryManager
from src.relationship.tracker import RelationshipTracker
from src.user import UserManager


async def _memory_maintenance_loop(memory: MemoryManager, logger: logging.Logger) -> None:
    while True:
        try:
            await asyncio.sleep(24 * 60 * 60)
            logger.info("Memory maintenance completed: %s", await memory.run_maintenance())
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
    while True:
        try:
            await asyncio.sleep(DIARY_CHECK_INTERVAL_S)
            if diary is None or not getattr(settings.features, "diary_enabled", False):
                continue
            today = datetime.now().strftime("%Y-%m-%d")
            if diary.load_entry(today) is not None:
                continue
            if kernel_store is None or kernel_store.count_user_messages_on_date(today) < DIARY_MIN_EXCHANGES:
                continue
            logger.info("Diary: generating the daily entry for %s", today)
            entry = await diary.generate_daily_entry(today, trigger="daily_auto")
            if entry is not None:
                logger.info("Diary: daily entry saved for %s", today)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Diary maintenance loop error")


async def _memory_reembedding_loop(memory: MemoryManager, logger: logging.Logger) -> None:
    while True:
        try:
            await asyncio.sleep(30)
            result = await asyncio.to_thread(memory.run_reembedding_batch)
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

    @staticmethod
    def _build_hypa_compressor(adapter: Any, settings: Any) -> Any:
        """Build the HypaMemory V3 compressor when the owner enables it."""
        import asyncio

        from src.memory.embedding import embed_query
        from src.memory.hypa_v3 import HypaMemoryV3

        embedding_model = str(getattr(settings.memory, "embedding_model", "") or "").strip() or None
        lancedb_path = str(getattr(settings.memory, "lancedb_path", "") or "")

        class _HypaEmbedder:
            async def embed(self, text: str) -> list[float]:
                kwargs = {"model_name": embedding_model} if embedding_model else {}
                return list(embed_query(text, **kwargs))

        return HypaMemoryV3(
            adapter=adapter,
            embedder=_HypaEmbedder(),
            data_dir=Path(lancedb_path).parent / "hypa",
        )

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
        self._module_registry = module_registry
        self._tasks: list[asyncio.Task[Any]] = []
        self._user_manager = None
        self._mount_graph(
            persona=persona,
            memory_state=memory_state,
            emotion_state=emotion_state,
            relationship_state=relationship_state,
            persona_state=persona_state,
        )

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
        api_budget = ApiBudgetTracker(settings.features)
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
        )
        # The MVP stores only user-grounded interaction evidence. Autonomous
        # extraction remains outside the packaged composition root.
        memory.autonomous_enabled = False
        emotion = EmotionSystem(
            values=dict(persona.emotions),
            state_path=emotion_state.file("state.json"),
            document_store=kernel_store,
            enabled=settings.features.emotion_system_enabled,
            carryover_days=settings.features.emotion_carryover_days,
            inertia_factor=settings.features.emotion_inertia_factor,
        )
        relationship = RelationshipTracker(
            initial_intimacy=50,
            state_path=relationship_state.file("state.json"),
            document_store=kernel_store,
        )
        scheduler = MessageScheduler(
            reply_delay_min=settings.chat.reply_delay_min,
            reply_delay_max=settings.chat.reply_delay_max,
            split_messages=settings.chat.split_messages,
            typing_indicator=settings.chat.typing_indicator,
            status=settings.chat.status,
            allow_environment_description=settings.chat.allow_environment_description,
        )
        user_manager = UserManager(document_store=kernel_store)
        user_manager.on_session_start()
        # Never turn the historical developer sample into a new user's
        # identity or seed fabricated facts into long-term memory.
        memory.sync_user_profile(user_manager)

        hypa_compressor = None
        if getattr(settings.features, "hypa_compression_enabled", False):
            try:
                hypa_compressor = self._build_hypa_compressor(adapter, settings)
            except Exception:
                self._logger.exception("HypaMemory V3 failed during startup; disabling it")
                hypa_compressor = None

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

            world_clock = WorldClock("Asia/Shanghai")
            web_world_state = persona_state.module("world", legacy_path=WORLD_STATE_DB)
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

        if web_surfing is not None and thought_engine is not None and world_clock is not None:
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
        lorebook_mgr = None
        try:
            from src.archive import ArchiveStore

            archive_state = persona_state.module("archive", legacy_path=None)
            archive_store = ArchiveStore(archive_state.file("archive.sqlite3"))
        except Exception:
            self._logger.exception("Archive store failed during startup; isolating it")
            archive_store = None
        try:
            from src.lorebook import LorebookManager
            from src.persona.identity import GLOBAL_PERSONA_EPOCH

            try:
                persona_id = GLOBAL_PERSONA_EPOCH.token().persona_id
            except Exception:
                persona_id = str(getattr(persona, "name", "default") or "default")
            lorebook_mgr = LorebookManager(persona_name=persona_id)
            if archive_store is not None:
                try:
                    current = archive_store.get(persona_id)
                    existing = current.get("archive") if current.get("exists") else None
                    for book in (existing or {}).get("worldBooks", []):
                        lorebook_mgr.load_world_book(book)
                except Exception:
                    self._logger.exception("World book load from archive failed; starting empty")
        except Exception:
            self._logger.exception("World book matcher failed during startup; isolating it")
            lorebook_mgr = None

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
            lorebook_mgr=lorebook_mgr,
            hypa_compressor=hypa_compressor,
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
            )
            social_universe.sync_persona_registry(PERSONA_DIR)
        except Exception:
            self._logger.exception("Social universe failed during startup; isolating it")
            social_universe = None

        if getattr(settings.features, "neko_import_enabled", False):
            try:
                from src.memory import neko_import

                source_dir = str(getattr(settings.features, "neko_import_source_dir", "") or "")
                if source_dir:
                    self._tasks.append(asyncio.create_task(
                        asyncio.to_thread(neko_import.import_from_directory, memory, source_dir)
                    ))
            except Exception:
                self._logger.exception("N.E.K.O import failed during startup; skipping it")

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
            )
        except Exception:
            self._logger.exception("Backup manager failed during startup; isolating it")
            backup_manager = None

        self._adapter = adapter
        self._memory = memory
        self._session = session
        self._user_manager = user_manager
        self._game_state_store = game_state_store
        self._archive_store = archive_store
        self._lorebook_mgr = lorebook_mgr
        self._kernel_store = kernel_store
        self._diary = diary
        self._backup_manager = backup_manager
        self._web_surfing = web_surfing
        self._thought_engine = thought_engine
        self._world_clock = world_clock
        attach_bridge_state(
            session=session,
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
            keepsakes=keepsakes,
            stickers=stickers,
            diary=diary,
            web_surfing=web_surfing,
            thought_engine=thought_engine,
            world_clock=world_clock,
            archive_store=archive_store,
            lorebook_mgr=lorebook_mgr,
            backup_manager=backup_manager,
        )
        try:
            from src.bridge.ws_bridge import _apply_imported_prompt_opts_from_archive

            _apply_imported_prompt_opts_from_archive()
        except Exception:
            self._logger.exception("Imported prompt opts failed to reload after remount")

    def _start_background_tasks(self) -> None:
        self._tasks = [
            asyncio.create_task(_memory_maintenance_loop(self._memory, self._logger)),
            asyncio.create_task(_memory_reembedding_loop(self._memory, self._logger)),
        ]
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

    async def _stop_persona_graph(self) -> None:
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        user_manager = getattr(self, "_user_manager", None)
        if user_manager is not None:
            try:
                user_manager.save()
            except Exception:
                self._logger.exception("User profile save during persona remount failed")
        session = getattr(self, "_session", None)
        if session is not None:
            try:
                await session.close()
            except Exception:
                self._logger.exception("Provider client shutdown during persona remount failed")
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

    async def remount_persona(self, persona: Any) -> None:
        """Rebuild persona-scoped modules after a privileged identity switch."""
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
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        try:
            self._user_manager.save()
        except Exception:
            self._logger.exception("User profile save during shutdown failed")
        try:
            await self._session.close()
        except Exception:
            self._logger.exception("Provider client shutdown failed")
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
