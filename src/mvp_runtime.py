"""Composition root for the Windows MVP.

Only the capabilities required for one-character text companionship are
constructed here. Optional legacy modules stay importable for migration and
the developer TUI, but are not loaded into the packaged desktop process.
"""

from __future__ import annotations

import asyncio
import logging
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
        self._tasks: list[asyncio.Task[Any]] = []

        api_budget = ApiBudgetTracker(settings.features)
        adapter = LLMAdapter(settings.llm, budget_tracker=api_budget)
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

        session = ChatSession(
            persona=persona,
            adapter=adapter,
            memory=memory,
            emotion=emotion,
            relationship=relationship,
            scheduler=scheduler,
            user_manager=user_manager,
            feature_settings=settings.features,
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

        self._adapter = adapter
        self._memory = memory
        self._session = session
        self._user_manager = user_manager
        self._game_state_store = game_state_store
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
        )

    async def run(self, *, stdio: bool, host: str, port: int) -> None:
        self._tasks = [
            asyncio.create_task(_memory_maintenance_loop(self._memory, self._logger)),
            asyncio.create_task(_memory_reembedding_loop(self._memory, self._logger)),
        ]
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
