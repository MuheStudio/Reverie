"""Reverie — AI Companion System entry point.

Usage:
    python -m src.main
    python src/main.py
"""

from __future__ import annotations

import asyncio
import argparse
import logging
import os
import sys
from pathlib import Path

# Ensure src is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config.settings import (
    AFFAIRS_DIR,
    DATA_DIR,
    DIARY_DIR,
    EMOTION_DIR,
    INTEREST_DIR,
    MEMORY_DIR,
    PERSONA_DIR,
    RELATIONSHIP_DIR,
    SOCIAL_DIR,
    TIMELINE_DIR,
    WORLD_STATE_DB,
    load_settings,
)
from src.bootstrap import (
    UnavailableBackupManager,
    UnavailableDiary,
    UnavailableProactiveChat,
    UnavailableTimeline,
    create_cloud_service_or_local,
    optional_symbol,
)
from src.persona.persona_card import default_persona
from src.persona.sillytavern_import import (
    CharacterCardImportError,
    KNOWN_LEGACY_DEFAULT_FINGERPRINTS,
    initialize_default_persona,
    load_active_persona,
    migrate_known_legacy_default_persona,
)
from src.utils.logger import setup_logger


MAINTENANCE_INTERVAL_SECONDS = 24 * 60 * 60


def parse_runtime_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse runtime mode flags shared by the TUI and Electron bridge."""
    parser = argparse.ArgumentParser(description="Run Reverie backend services.")
    parser.add_argument(
        "--bridge",
        action="store_true",
        help="Run the development-only WebSocket bridge instead of the TUI.",
    )
    parser.add_argument(
        "--stdio-bridge",
        action="store_true",
        help="Run the production Electron framed-stdio bridge instead of the TUI.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bridge host.")
    parser.add_argument("--port", type=int, default=48913, help="Bridge port.")
    parser.add_argument(
        "--bootstrap-smoke",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser.parse_args(argv)


async def memory_maintenance_loop(
    memory: MemoryManager,
    logger: logging.Logger,
    interval_seconds: float = MAINTENANCE_INTERVAL_SECONDS,
) -> None:
    """Run memory forgetting and misremembering maintenance on a schedule."""
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            summary = await memory.run_maintenance()
            logger.info("Memory maintenance completed: %s", summary)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Memory maintenance loop error")


async def memory_reembedding_loop(
    memory: MemoryManager,
    logger: logging.Logger,
    interval_seconds: float = 30.0,
) -> None:
    """Lazily rebuild model-versioned vectors outside the renderer lifecycle."""
    while True:
        try:
            await asyncio.sleep(interval_seconds)
            result = await asyncio.to_thread(memory.run_reembedding_batch)
            if result.get("processed") or result.get("failed"):
                logger.info("Memory re-embedding batch: %s", result)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Memory re-embedding loop error")


async def main():
    """Initialize all systems and launch the chat interface."""
    runtime_args = parse_runtime_args()
    desktop_bridge = runtime_args.bridge or runtime_args.stdio_bridge

    # The packaged Electron parent writes exactly 32 key bytes to a dedicated
    # inherited pipe and closes it. This happens before any canonical database
    # is opened; no key material is accepted through argv or an environment
    # variable.
    from src.storage import initialize_storage_from_environment

    initialize_storage_from_environment()

    # Desktop starts fail-closed before any proactive/background subsystem is
    # constructed.  Electron persists and re-declares the authoritative epoch.
    from src.local_mode import get_local_mode_gate, install_desktop_socket_guard

    local_mode_gate = get_local_mode_gate()
    local_mode_gate.configure_desktop(desktop_bridge)
    if desktop_bridge:
        initial_active = os.getenv("REVERIE_LOCAL_MODE", "1").strip() == "1"
        try:
            initial_epoch = int(os.getenv("REVERIE_LOCAL_MODE_EPOCH", "0") or 0)
        except ValueError:
            initial_epoch = 0
        local_mode_gate.set(
            initial_active,
            session_id=os.getenv("REVERIE_LOCAL_MODE_SESSION_ID", ""),
            epoch=initial_epoch,
        )
        install_desktop_socket_guard()

    # Setup logging
    logger = setup_logger("reverie", level=logging.INFO)
    logger.info("Starting Reverie...")

    # Load configuration
    settings = load_settings()
    logger.info("LLM provider: %s | Model: %s", settings.llm.provider, settings.llm.model)
    logger.info("Memory: %s | Embedding: %s", settings.memory.lancedb_path, settings.memory.embedding_model)
    cloud = create_cloud_service_or_local(settings.cloud_mode)
    logger.info("Cloud service: %s", cloud.get_status())

    # registry.json is the identity commit point.  active.json is never trusted
    # by itself because doing so would make a disk edit an unprivileged persona
    # switch on the next process start.
    try:
        persona = load_active_persona(PERSONA_DIR)
    except CharacterCardImportError as exc:
        if exc.code != "active_profile_missing":
            raise
        # One historical built-in card predates registry.json.  It may migrate
        # only when its sealed fingerprint matches the compiled allowlist;
        # arbitrary loose active.json files remain fail-closed.
        persona = migrate_known_legacy_default_persona(PERSONA_DIR)
        logger.info("Migrated known legacy persona into the authoritative registry")
    if persona is None:
        persona = default_persona()
        initialize_default_persona(PERSONA_DIR, persona)
        logger.info("Created default persona: %s", persona.name)
    else:
        logger.info("Loaded authoritative persona: %s", persona.name)
    from src.persona.identity import GLOBAL_PERSONA_EPOCH

    persona_token = GLOBAL_PERSONA_EPOCH.activate_initial(persona)
    logger.info(
        "Sealed persona identity: %s (epoch %d)",
        persona_token.persona_id,
        persona_token.epoch,
    )
    from src.kernel.contracts import PersonaScopeV4
    from src.kernel.storage import KernelStore

    identity_envelope = GLOBAL_PERSONA_EPOCH.envelope()
    kernel_store = KernelStore(DATA_DIR / "runtime" / "kernel.sqlite3")
    kernel_store.activate_persona(
        PersonaScopeV4(
            persona_id=persona_token.persona_id,
            epoch=persona_token.epoch,
            fingerprint=persona_token.fingerprint,
        ),
        identity=identity_envelope.core_identity,
        identity_version=identity_envelope.version,
        actor="bootstrap",
        reason="authoritative persona registry startup",
    )
    if kernel_store.integrity_check() != "ok":
        kernel_store.close()
        raise RuntimeError("Persona kernel integrity check failed")
    archive_store = None
    game_state_store = None
    from src.kernel.modules import ModuleRegistry

    module_registry = ModuleRegistry(kernel_store)
    from src.persona.state_scope import PersonaStateScope

    built_in_fingerprints = set(KNOWN_LEGACY_DEFAULT_FINGERPRINTS)
    built_in_fingerprints.add(default_persona().seal_identity().fingerprint)
    persona_state = PersonaStateScope(
        persona,
        registry=GLOBAL_PERSONA_EPOCH,
        base_dir=DATA_DIR / "personas",
        legacy_fingerprint_allowlist=built_in_fingerprints,
    )
    # All persona-coupled durable stores derive their path from this single
    # sealed identity authority.  Unknown imported personas never inherit the
    # old unscoped built-in history.
    emotion_state = persona_state.module("emotion", legacy_path=EMOTION_DIR)
    relationship_state = persona_state.module(
        "relationship",
        legacy_path=RELATIONSHIP_DIR,
    )
    memory_state = persona_state.module("memory", legacy_path=MEMORY_DIR)

    if runtime_args.bootstrap_smoke:
        # The immutable persona/config/local-storage kernel must boot without
        # importing any detachable feature module.  Electron can still present
        # the product shell and a precise unavailable state for missing systems.
        logger.info("Persona kernel reached desktop handoff boundary")
        if archive_store is not None:
            archive_store.close()
        if game_state_store is not None:
            game_state_store.close()
        kernel_store.close()
        return

    if desktop_bridge:
        # The packaged app has one explicit composition root. Legacy feature
        # modules below are reserved for the developer TUI and are never
        # imported or instantiated by the Windows MVP.
        from src.mvp_runtime import run_mvp_desktop

        try:
            await run_mvp_desktop(
                persona=persona,
                settings=settings,
                memory_state=memory_state,
                emotion_state=emotion_state,
                relationship_state=relationship_state,
                persona_state=persona_state,
                kernel_store=kernel_store,
                module_registry=module_registry,
                logger=logger,
                stdio=runtime_args.stdio_bridge,
                host=runtime_args.host,
                port=runtime_args.port,
            )
        finally:
            if archive_store is not None:
                archive_store.close()
            kernel_store.close()
        return

    world_state = persona_state.module("world", legacy_path=WORLD_STATE_DB)
    world_state_db = world_state.file(WORLD_STATE_DB.name)
    social_state = persona_state.module("social", legacy_path=SOCIAL_DIR)
    interest_state = persona_state.module("interest", legacy_path=INTEREST_DIR)
    affairs_state = persona_state.module("affairs", legacy_path=AFFAIRS_DIR)
    diary_state = persona_state.module("diary", legacy_path=DIARY_DIR)
    timeline_state = persona_state.module("timeline", legacy_path=TIMELINE_DIR)

    # Initialize subsystems
    LLMAdapter = optional_symbol("src.api.adapter", "LLMAdapter")
    MemoryManager = optional_symbol("src.memory.manager", "MemoryManager")
    EmotionSystem = optional_symbol("src.emotion.system", "EmotionSystem")
    RelationshipTracker = optional_symbol("src.relationship.tracker", "RelationshipTracker")
    MessageScheduler = optional_symbol("src.chat.scheduler", "MessageScheduler")
    ChatSession = optional_symbol("src.chat.session", "ChatSession")
    ApiBudgetTracker = optional_symbol("src.api.budget", "ApiBudgetTracker")
    UserManager = optional_symbol("src.user", "UserManager")
    StickerManager = optional_symbol("src.stickers", "StickerManager")
    ImmersionManager = optional_symbol("src.immersion", "ImmersionManager")
    SocialCircle = optional_symbol("src.social.circle", "SocialCircle")
    InterestTracker = optional_symbol("src.interest.tracker", "InterestTracker")
    PersonalAffairManager = optional_symbol("src.affairs", "PersonalAffairManager")
    WorldClock = optional_symbol("src.world", "WorldClock")
    AmbientPresence = optional_symbol("src.ambient", "AmbientPresence")
    ThoughtOfYouEngine = optional_symbol("src.ambient", "ThoughtOfYouEngine")
    SocialUniverse = optional_symbol("src.social", "SocialUniverse")
    KeepsakeManager = optional_symbol("src.keepsakes", "KeepsakeManager")
    ReflexSystem = optional_symbol("src.chat.reflex", "ReflexSystem")
    UserPhraseAlignment = optional_symbol("src.persona.alignment", "UserPhraseAlignment")
    SpeechHabitEngine = optional_symbol("src.persona.speech_habits", "SpeechHabitEngine")
    LocalBackupManager = optional_symbol("src.backup", "LocalBackupManager")
    WorldStateStore = optional_symbol("src.world_state_store", "WorldStateStore")
    WorkManager = optional_symbol("src.work_manager", "WorkManager")
    required_runtime = {
        "llm_adapter": LLMAdapter,
        "memory": MemoryManager,
        "emotion": EmotionSystem,
        "relationship": RelationshipTracker,
        "chat_scheduler": MessageScheduler,
        "chat_session": ChatSession,
        "api_budget": ApiBudgetTracker,
        "user_profiles": UserManager,
        "stickers": StickerManager,
        "immersion": ImmersionManager,
        "social_circle": SocialCircle,
        "interests": InterestTracker,
        "affairs": PersonalAffairManager,
        "world_clock": WorldClock,
        "ambient_presence": AmbientPresence,
        "thought_of_you": ThoughtOfYouEngine,
        "social_universe": SocialUniverse,
        "keepsakes": KeepsakeManager,
        "local_reflex": ReflexSystem,
        "phrase_alignment": UserPhraseAlignment,
        "speech_habits": SpeechHabitEngine,
        "backup": LocalBackupManager,
        "world_state": WorldStateStore,
        "work_manager": WorkManager,
    }
    unavailable = [name for name, symbol in required_runtime.items() if symbol is None]
    if unavailable:
        if not desktop_bridge:
            raise RuntimeError("Interactive modules unavailable: " + ", ".join(unavailable))
        # A detachable feature must not take down the desktop process or the
        # sealed identity authority.  Bring up the authenticated bridge in an
        # explicit degraded state: persona inspection/import/activation and
        # owner policy controls remain available, while every missing feature
        # operation fails closed with a machine-readable diagnostic.
        from src.bridge.ws_bridge import attach_bridge_state

        attach_bridge_state(
            persona=persona,
            settings=settings,
            kernel_store=kernel_store,
            archive_store=archive_store,
            game_state_store=game_state_store,
            module_registry=module_registry,
            runtime_unavailable=tuple(unavailable),
        )
        logger.error(
            "Starting persona kernel with unavailable capabilities: %s",
            ", ".join(unavailable),
        )
        if runtime_args.stdio_bridge:
            from src.bridge.stdio_bridge import start_stdio_bridge

            await start_stdio_bridge()
        else:
            from src.bridge.ws_bridge import start_bridge

            await start_bridge(host=runtime_args.host, port=runtime_args.port)
        if archive_store is not None:
            archive_store.close()
        if game_state_store is not None:
            game_state_store.close()
        kernel_store.close()
        return
    from src.api.budget import ApiBudgetTracker
    # API cost limits are owner/application scoped, not persona scoped; an
    # identity switch must never reset or bypass the global usage ledger.
    api_budget = ApiBudgetTracker(settings.features)
    adapter = LLMAdapter(settings.llm, budget_tracker=api_budget)
    memory = MemoryManager(
        persona,
        settings.memory,
        adapter=adapter,
        feature_settings=settings.features,
        state_scope=memory_state,
    )
    memory.autonomous_enabled = settings.features.autonomous_memory_enabled
    emotion = EmotionSystem(
        values=dict(persona.emotions),
        state_path=emotion_state.file("state.json"),
        enabled=settings.features.emotion_system_enabled,
        carryover_days=settings.features.emotion_carryover_days,
        inertia_factor=settings.features.emotion_inertia_factor,
    )
    relationship = RelationshipTracker(
        initial_intimacy=50,
        state_path=relationship_state.file("state.json"),
    )  # Starting slightly above 0 on first run
    scheduler = MessageScheduler(
        reply_delay_min=settings.chat.reply_delay_min,
        reply_delay_max=settings.chat.reply_delay_max,
        split_messages=settings.chat.split_messages,
        typing_indicator=settings.chat.typing_indicator,
        status=settings.chat.status,
        allow_environment_description=settings.chat.allow_environment_description,
    )

    # ── User profile: persistent user information
    from src.user import UserManager
    user_mgr = UserManager()
    user_mgr.on_session_start()
    user_mgr.ensure_default_profile()
    memory.sync_user_profile(user_mgr)

    # ── Stickers: kaomoji library + collection
    from src.stickers import StickerManager
    stickers = StickerManager(user_manager=user_mgr)

    from src.immersion import ImmersionManager
    immersion = ImmersionManager(settings.features)

    # ── Web surfing: fetch and reference online content
    WebSurfingManager = optional_symbol("src.web", "WebSurfingManager")
    web_surfing = None
    if settings.features.web_surfing_enabled and WebSurfingManager is not None:
        try:
            web_surfing = WebSurfingManager(
                persona,
                adapter,
                allowed_topics=settings.features.web_allowed_topics,
                refresh_interval_minutes=settings.features.web_refresh_interval_minutes,
                search_windows=settings.features.web_search_windows,
            )
        except Exception:
            logger.exception("Web capability failed during startup; continuing without it")

    # ── Random image service: foxgirls.club vendored index
    from src.image_service import FoxgirlImageService
    image_service = None
    if settings.features.image_service_enabled:
        try:
            image_service = FoxgirlImageService()
        except Exception:
            logger.exception("Image service failed during startup; continuing without it")

    # ── N.E.K.O memory import: best-effort one-time import at startup
    if settings.features.neko_import_enabled:
        from src.memory import neko_import
        source_dir = str(settings.features.neko_import_source_dir or "").strip()
        if source_dir:
            try:
                asyncio.create_task(
                    asyncio.to_thread(neko_import.import_from_directory, memory, source_dir)
                )
            except Exception:
                logger.exception("N.E.K.O import failed during startup; skipping it")

    # ── Social Circle & Interests
    from src.social.circle import SocialCircle
    from src.interest.tracker import InterestTracker
    from src.affairs import PersonalAffairManager
    from src.world import WorldClock
    world_clock = WorldClock("Asia/Shanghai")
    from src.ambient import AmbientPresence, ThoughtOfYouEngine
    ambient_presence = AmbientPresence(
        settings.features,
        path=world_state_db,
        persona_name=persona.name,
    )
    thought_engine = ThoughtOfYouEngine(settings.features, path=world_state_db)
    if web_surfing is not None:
        thought_engine.ingest(web_surfing.approved_items(), now=world_clock.now())
    ambient_presence.advance(world_clock.now(), emotions=dict(emotion.values))
    social_circle = SocialCircle(state_scope=social_state)
    from src.social import SocialUniverse
    social_universe = SocialUniverse(
        persona,
        settings.features,
        adapter=adapter,
        path=world_state_db,
        state_scope=world_state,
        memory=memory,
    )
    social_universe.sync_persona_registry(PERSONA_DIR)
    interest_tracker = InterestTracker(state_scope=interest_state)
    social_circle.ensure_defaults(persona, now=world_clock.now())
    interest_tracker.ensure_defaults(persona, now=world_clock.now())
    affair_manager = PersonalAffairManager(
        interest_tracker=interest_tracker,
        state_scope=affairs_state,
    )
    affair_manager.ensure_defaults(persona, now=world_clock.now())

    from src.keepsakes import KeepsakeManager
    keepsakes = KeepsakeManager(
        enabled=settings.features.keepsake_collection_enabled,
        recall_probability=settings.features.keepsake_recall_probability,
    )

    from src.chat.reflex import ReflexSystem
    reflex = ReflexSystem(persona=persona)
    from src.persona.alignment import UserPhraseAlignment
    from src.persona.speech_habits import SpeechHabitEngine
    phrase_alignment = UserPhraseAlignment(path=world_state_db)
    speech_habits = SpeechHabitEngine(
        persona,
        alignment_engine=phrase_alignment,
        feature_settings=settings.features,
        relationship=relationship,
    )

    # Create session after optional managers are initialized.
    hypa_compressor = None
    if settings.features.hypa_compression_enabled:
        from src.memory.hypa_v3 import HypaMemoryV3
        from src.memory.embedding import embed_query

        class _HypaEmbedder:
            async def embed(self, text: str):
                return list(embed_query(text))

        try:
            hypa_compressor = HypaMemoryV3(
                adapter=adapter,
                embedder=_HypaEmbedder(),
                data_dir=Path(settings.memory.lancedb_path).parent / "hypa",
            )
        except Exception:
            logger.exception("HypaMemory V3 failed during startup; disabling it")
            hypa_compressor = None

    session = ChatSession(
        persona=persona,
        adapter=adapter,
        memory=memory,
        emotion=emotion,
        relationship=relationship,
        scheduler=scheduler,
        sticker_manager=stickers,
        web_surfing=web_surfing,
        social_circle=social_circle,
        interest_tracker=interest_tracker,
        affair_manager=affair_manager,
        world_clock=world_clock,
        user_manager=user_mgr,
        feature_settings=settings.features,
        keepsake_manager=keepsakes,
        speech_habit_engine=speech_habits,
        reflex_system=reflex,
        ambient_presence=ambient_presence,
        thought_engine=thought_engine,
        social_universe=social_universe,
        hypa_compressor=hypa_compressor,
    )

    # ── Diary: character's private journal
    DiaryManager = optional_symbol("src.diary", "DiaryManager")
    diary = None
    if DiaryManager is not None:
        try:
            diary = DiaryManager(
                persona,
                adapter,
                emotion,
                memory,
                speech_habit_engine=session.speech_habits,
                state_scope=diary_state,
            )
        except Exception:
            logger.exception("Diary capability failed during startup; isolating it")
    if diary is None:
        diary = UnavailableDiary("Diary module is missing or failed startup")
        diary.emotion = emotion
    else:
        diary.privacy_enabled = settings.features.diary_privacy_enabled
        diary.peek_enabled = settings.features.diary_peek_enabled

    diary_keys = None
    if diary:
        DiaryKeyManager = optional_symbol("src.diary.easter_egg", "DiaryKeyManager")
        if DiaryKeyManager is not None:
            try:
                diary_keys = DiaryKeyManager(
                    settings.features,
                    ambient=ambient_presence,
                    diary=diary,
                    relationship=relationship,
                    path=world_state_db,
                )
            except Exception:
                logger.exception("Diary-key capability failed during startup; isolating it")

    # ── Timeline: character's public social feed (朋友圈)
    TimelineManager = optional_symbol("src.timeline", "TimelineManager")
    timeline = None
    if TimelineManager is not None:
        try:
            timeline = TimelineManager(
                persona,
                adapter,
                emotion,
                memory,
                feature_settings=settings.features,
                social_circle=social_circle,
                interest_tracker=interest_tracker,
                affair_manager=affair_manager,
                sticker_manager=stickers,
                world_clock=world_clock,
                speech_habit_engine=session.speech_habits,
                state_scope=timeline_state,
            )
        except Exception:
            logger.exception("Timeline capability failed during startup; isolating it")
    if timeline is None:
        timeline = UnavailableTimeline("Timeline module is missing or failed startup")

    # Recover an interrupted multi-module restore before any autonomous task
    # can observe or mutate a partially applied world state.
    from src.backup import LocalBackupManager
    from src.world_state_store import WorldStateStore

    if diary:
        backup_manager = LocalBackupManager(
            memory=memory,
            emotion=emotion,
            relationship=relationship,
            diary=diary,
            user_manager=user_mgr,
            timeline=timeline if timeline else None,
            social_circle=social_circle,
            interest_tracker=interest_tracker,
            affair_manager=affair_manager,
            world_clock=world_clock,
            state_store=WorldStateStore(path=world_state_db),
            ambient_presence=ambient_presence,
            thought_engine=thought_engine,
            diary_keys=diary_keys,
            phrase_alignment=phrase_alignment,
            social_universe=social_universe,
        )
    else:
        backup_manager = UnavailableBackupManager(
            "Complete backup is unavailable while the required diary section is missing"
        )
    if backup_manager.recover_interrupted_restore():
        logger.warning("Recovered an interrupted world-state restore")
    backup_manager.checkpoint()

    # ── ProactiveChat: background task for character-initiated messages
    ProactiveChat = optional_symbol("src.chat.proactive", "ProactiveChat")
    proactive = None
    if ProactiveChat is not None:
        try:
            proactive = ProactiveChat(
                persona,
                adapter,
                emotion,
                scheduler,
                relationship=relationship,
                late_night_enabled=settings.features.late_night_enabled,
                late_night_probability=settings.features.late_night_probability,
                manage_status=not settings.features.diary_enabled,
                daily_limit=settings.features.proactive_daily_limit,
                min_interval_minutes=settings.features.proactive_min_interval_minutes,
                event_stories_enabled=settings.features.proactive_event_stories_enabled,
                memory=memory,
                user_manager=user_mgr,
                web_surfing=web_surfing,
                affair_manager=affair_manager,
                interest_tracker=interest_tracker,
                world_clock=world_clock,
                speech_habit_engine=session.speech_habits,
                reflex_system=reflex,
                local_reflex_probability=settings.features.local_care_reflex_probability,
                persona_epoch_registry=GLOBAL_PERSONA_EPOCH,
            )
        except Exception:
            logger.exception("Proactive capability failed during startup; isolating it")
    if proactive is None:
        proactive = UnavailableProactiveChat(
            "Proactive module is missing or failed startup"
        )
    if settings.features.proactive_chat_enabled:
        proactive.start()
    else:
        logger.info("ProactiveChat disabled by settings")

    from src.work_manager import WorkManager
    work_manager_state = persona_state.module(
        "work_manager",
        legacy_path=WorkManager.DEFAULT_STATE_PATH,
    )
    async def send_late_night_checkin(event_date: str) -> bool:
        return await proactive.enqueue_late_night_checkin(event_date=event_date, user_online=True)

    work_manager = WorkManager(
        persona=persona,
        scheduler=scheduler,
        diary=diary,
        feature_settings=settings.features,
        late_night_message_callback=send_late_night_checkin,
        affair_manager=affair_manager,
        interest_tracker=interest_tracker,
        memory=memory,
        world_clock=world_clock,
        ambient_presence=ambient_presence,
        state_scope=work_manager_state,
    )
    if (
        settings.features.diary_enabled
        or settings.features.late_night_enabled
        or settings.features.ambient_presence_enabled
    ):
        work_manager.start()
    else:
        logger.info("WorkManager background events disabled by settings")

    # ── Timeline background loop: auto-generate posts
    async def timeline_loop():
        while True:
            try:
                await asyncio.sleep(90)  # check every 90 seconds
                if not timeline or not settings.features.timeline_enabled:
                    continue
                post = await timeline.maybe_generate()
                if post:
                    await social_universe.ensure_timeline_comment(post.to_dict())
                    logger.info("Timeline post: %s", post.content[:50])
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("Timeline loop error")
    timeline_task = asyncio.create_task(timeline_loop())

    # ── Web surfing background loop
    async def web_loop():
        while True:
            try:
                await asyncio.sleep(600)  # check every 10 minutes
                active_web = session.web
                if active_web is None:
                    continue
                refreshed = await active_web.fetch_if_needed()
                if refreshed:
                    logger.info("WebSurfing: content refreshed")
                thought_engine.ingest(active_web.approved_items(), now=world_clock.now())
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("WebSurfing loop error")
    web_task = asyncio.create_task(web_loop())

    maintenance_task = asyncio.create_task(memory_maintenance_loop(memory, logger))
    reembedding_task = asyncio.create_task(memory_reembedding_loop(memory, logger))

    async def world_state_checkpoint_loop():
        while True:
            try:
                await asyncio.sleep(15 * 60)
                backup_manager.checkpoint()
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("World-state SQLite checkpoint failed")

    world_state_task = asyncio.create_task(world_state_checkpoint_loop())

    try:
        if desktop_bridge:
            from src.bridge.ws_bridge import attach_bridge_state

            attach_bridge_state(
                session=session,
                adapter=adapter,
                proactive=proactive,
                work_manager=work_manager,
                diary=diary,
                timeline=timeline,
                emotion=emotion,
                memory=memory,
                persona=persona,
                relationship=relationship,
                stickers=stickers,
                web_surfing=web_surfing,
                settings=settings,
                user_mgr=user_mgr,
                social_circle=social_circle,
                interest_tracker=interest_tracker,
                affair_manager=affair_manager,
                world_clock=world_clock,
                keepsakes=keepsakes,
                immersion=immersion,
                backup_manager=backup_manager,
                ambient_presence=ambient_presence,
                thought_engine=thought_engine,
                diary_keys=diary_keys,
                api_budget=api_budget,
                social_universe=social_universe,
                phrase_alignment=phrase_alignment,
                kernel_store=kernel_store,
                archive_store=archive_store,
                game_state_store=game_state_store,
                module_registry=module_registry,
                image_service=image_service,
            )
            if runtime_args.stdio_bridge:
                from src.bridge.stdio_bridge import start_stdio_bridge

                logger.info("Launching private framed-stdio bridge")
                await start_stdio_bridge()
            else:
                from src.bridge.ws_bridge import start_bridge

                logger.info(
                    "Launching development WebSocket bridge on ws://%s:%s",
                    runtime_args.host,
                    runtime_args.port,
                )
                await start_bridge(host=runtime_args.host, port=runtime_args.port)
        else:
            # Launch TUI
            from src.ui.tui import ReverieTUI

            app = ReverieTUI(
                session,
                proactive,
                diary=diary,
                timeline=timeline,
                web_surfing=web_surfing,
                settings=settings,
                work_manager=work_manager,
            )
            await app.run_async()
    finally:
        # Cleanup background tasks even if the UI exits with an exception.
        proactive.stop()
        work_manager.stop()
        for task in (timeline_task, web_task, maintenance_task, reembedding_task, world_state_task):
            task.cancel()
        await asyncio.gather(
            timeline_task,
            web_task,
            maintenance_task,
            reembedding_task,
            world_state_task,
            return_exceptions=True,
        )

        # Save user profile
        user_mgr.save()
        try:
            backup_manager.checkpoint()
        except Exception:
            logger.exception("Final world-state SQLite checkpoint failed")
        try:
            reflex.close()
        except Exception:
            logger.exception("Reflex system shutdown failed")
        try:
            await session.close()
        except Exception:
            logger.exception("Provider client shutdown failed")
        try:
            memory.store.close()
        except Exception:
            logger.exception("Memory database shutdown failed")
        try:
            kernel_store.close()
        except Exception:
            logger.exception("Persona kernel shutdown failed")
        try:
            if archive_store is not None:
                archive_store.close()
        except Exception:
            logger.exception("Archive module shutdown failed")
        try:
            if game_state_store is not None:
                game_state_store.close()
        except Exception:
            logger.exception("Game-state module shutdown failed")

        # Cleanup
        logger.info("Shutting down...")
        from src.config.settings import save_settings
        save_settings(settings)
        logger.info("Goodbye!")


if __name__ == "__main__":
    asyncio.run(main())
