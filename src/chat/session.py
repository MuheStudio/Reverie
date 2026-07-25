"""ChatSession — the central orchestrator for a conversation.

Connects:
  Persona → LLM Adapter → Memory Manager → Emotion System →
  Anti-AI Filter → Message Scheduler → Relationship Tracker

A single session represents one continuous conversation thread.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import TYPE_CHECKING

from .anti_ai import (
    build_retry_prompt,
    choose_avoidance_reply,
    filter_output_detail,
    guard_user_message,
)
from .scheduler import MessageScheduler
from ..local_mode import LocalModeBlocked
from ..memory.cognitive_decay import FUZZY_RECALL_PREFIX

if TYPE_CHECKING:
    from ..api.adapter import LLMAdapter
    from ..emotion.system import EmotionSystem
    from ..memory.manager import MemoryManager
    from ..persona.persona_card import Persona
    from ..relationship.tracker import RelationshipTracker
    from ..stickers import StickerManager
    from ..web import WebSurfingManager
    from ..social import SocialCircle
    from ..interest import InterestTracker
    from ..affairs import PersonalAffairManager
    from ..user import UserManager
    from ..config.settings import FeatureSettings
    from ..keepsakes import KeepsakeManager
    from ..persona.speech_habits import SpeechHabitEngine
    from ..world import WorldClock
    from ..ambient import AmbientPresence, ThoughtOfYouEngine
    from ..social.universe import SocialUniverse
    from .reflex import ReflexSystem

logger = logging.getLogger("reverie.chat.session")


class ChatSession:
    """Manages a single conversation with the AI companion.

    Usage:
        session = ChatSession(persona, adapter, memory, emotion, relationship)
        reply = await session.send_message("Hello!")
    """

    def __init__(
        self,
        persona: "Persona",
        adapter: "LLMAdapter",
        memory: "MemoryManager",
        emotion: "EmotionSystem",
        relationship: "RelationshipTracker",
        *,
        scheduler: MessageScheduler | None = None,
        sticker_manager: "StickerManager | None" = None,
        web_surfing: "WebSurfingManager | None" = None,
        social_circle: "SocialCircle | None" = None,
        interest_tracker: "InterestTracker | None" = None,
        affair_manager: "PersonalAffairManager | None" = None,
        world_clock: "WorldClock | None" = None,
        user_manager: "UserManager | None" = None,
        feature_settings: "FeatureSettings | None" = None,
        keepsake_manager: "KeepsakeManager | None" = None,
        speech_habit_engine: "SpeechHabitEngine | None" = None,
        reflex_system: "ReflexSystem | None" = None,
        ambient_presence: "AmbientPresence | None" = None,
        thought_engine: "ThoughtOfYouEngine | None" = None,
        social_universe: "SocialUniverse | None" = None,
    ) -> None:
        self.persona = persona
        self.adapter = adapter
        self.memory = memory
        self.emotion = emotion
        self.relationship = relationship
        self.scheduler = scheduler or MessageScheduler()
        self.stickers = sticker_manager
        self.web = web_surfing
        self.social = social_circle
        self.interest = interest_tracker
        self.affairs = affair_manager
        self.user_manager = user_manager
        self.feature_settings = feature_settings
        self.keepsakes = keepsake_manager
        self.reflex = reflex_system
        self.ambient_presence = ambient_presence
        self.thought_engine = thought_engine
        self.social_universe = social_universe
        if speech_habit_engine is None:
            from ..persona.speech_habits import SpeechHabitEngine

            speech_habit_engine = SpeechHabitEngine(persona)
        self.speech_habits = speech_habit_engine
        if world_clock is None:
            from ..world import WorldClock

            world_clock = WorldClock()
        self.world_clock = world_clock
        self._last_safe_memories: list[str] = []
        self._last_safe_emotions = dict(getattr(persona, "emotions", {}) or {})
        self._last_safe_intimacy = int(getattr(relationship, "intimacy", 0) or 0)

        # Conversation history (in-memory for this session)
        self._history: list[dict] = []
        self._committed_request_ids: set[str] = set()

        # Session start time
        self.started_at = time.time()

    # ── Public API ────────────────────────────────────────

    async def send_message(
        self,
        user_message: str,
        *,
        status_delay_applied: bool = False,
        defer_side_effects: bool = False,
        request_id: str = "",
    ) -> dict:
        """Process a user message and return the assistant's reply.

        Returns:
            {
                "reply": str,           # The assistant's reply text
                "messages": [str],      # Split into bubbles if applicable
                "delay": float,         # How long to wait before showing
                "typing_duration": float, # How long "typing..." is shown
                "emotion_changes": {},   # Emotional deltas applied
                "injection_detected": bool,
            }
        """
        logger.info("User: %s", user_message[:100])

        # ── Step 1: Input pre-processing ──────────────────
        guard = guard_user_message(user_message)
        injection_detected = guard.injection_detected
        memory_directive = self._parse_memory_directive(user_message)

        if not defer_side_effects and self.user_manager and guard.memory_safe and memory_directive != "skip":
            try:
                profile_updates = self.user_manager.extract_profile_updates(user_message)
                if profile_updates:
                    self.user_manager.update_profile(profile_updates)
                    if hasattr(self.memory, "sync_user_profile"):
                        self.memory.sync_user_profile(self.user_manager)
            except Exception:
                logger.exception("User profile update failed; continuing chat")

        # ── Step 2: Memory retrieval ──────────────────────
        if guard.memory_safe:
            try:
                memories = self.memory.retrieve_relevant(user_message)
                self._last_safe_memories = [
                    memory for memory in memories
                    if not memory.startswith(FUZZY_RECALL_PREFIX)
                ]
            except Exception:
                logger.exception("Memory retrieval failed; using last safe session snapshot")
                memories = list(self._last_safe_memories)
        else:
            memories = []

        # ── Step 3: Emotion context ───────────────────────
        try:
            if not defer_side_effects and hasattr(self.emotion, "apply_daily_carryover"):
                self.emotion.apply_daily_carryover()
            current_emotions = dict(self.emotion.values)
            emotion_intensity = self.emotion.get_intensity()
            self._last_safe_emotions = dict(current_emotions)
        except Exception:
            logger.exception("Emotion context failed; using last safe snapshot")
            current_emotions = dict(self._last_safe_emotions)
            emotion_intensity = max(current_emotions.values(), default=0.0) / 100.0

        # Update relationship using language-independent meaningful characters.
        try:
            interaction_count_before = getattr(self.relationship, "interaction_count", None)
            if not defer_side_effects:
                self.relationship.on_user_message(user_message)
            interaction_count_after = getattr(self.relationship, "interaction_count", None)
            relationship_interaction_recorded = (
                not defer_side_effects
                and (
                interaction_count_before is None
                or interaction_count_after is None
                or interaction_count_after > interaction_count_before
                )
            )
            intimacy = int(self.relationship.intimacy)
            self._last_safe_intimacy = intimacy
        except Exception:
            logger.exception("Relationship update failed; using last safe snapshot")
            relationship_interaction_recorded = False
            intimacy = self._last_safe_intimacy

        alignment = getattr(self.speech_habits, "alignment_engine", None)
        if alignment is not None and guard.memory_safe and not defer_side_effects:
            try:
                alignment.observe(user_message)
            except Exception:
                logger.exception("User phrase observation failed; continuing chat")
        if alignment is not None:
            try:
                alignment_reply = alignment.notice_reply(user_message, intimacy=intimacy)
            except Exception:
                logger.exception("Phrase-alignment notice lookup failed")
                alignment_reply = None
            if alignment_reply:
                return self._local_personality_result(
                    alignment_reply,
                    user_message=user_message,
                    guard=guard,
                    injection_detected=injection_detected,
                    status_delay_applied=status_delay_applied,
                    emotions=current_emotions,
                    defer_side_effects=defer_side_effects,
                    request_id=request_id,
                )

        if guard.identity_probe_detected and not guard.injection_detected:
            raw_reply = choose_avoidance_reply(
                emotions=current_emotions,
                intimacy=intimacy,
                persona_name=getattr(self.persona, "name", "星野幻月"),
            )
            try:
                raw_reply = self.scheduler.shape_reply_length(
                    raw_reply,
                    allow_long=False,
                    allow_environment_description=False,
                )
            except Exception:
                logger.exception("Identity-probe reply shaping failed")
            try:
                raw_reply = self.speech_habits.apply(
                    raw_reply,
                    emotions=current_emotions,
                    allow_long=False,
                )
            except Exception:
                logger.exception("Identity-probe speech habits failed")
            raw_reply = self._safe_addressing(raw_reply)
            final_filtered = filter_output_detail(raw_reply)
            if final_filtered.action == "rewrite":
                raw_reply = final_filtered.text
            elif final_filtered.action == "retry":
                raw_reply = choose_avoidance_reply(
                    emotions=current_emotions,
                    intimacy=intimacy,
                    persona_name=getattr(self.persona, "name", "星野幻月"),
                )
            if not defer_side_effects:
                self._history.append({"role": "user", "content": user_message})
                self._history.append({"role": "assistant", "content": raw_reply})
            emotion_changes = {} if defer_side_effects else self._apply_guard_emotion(guard)
            if (
                emotion_changes
                and relationship_interaction_recorded
                and hasattr(self.relationship, "on_emotional_result")
            ):
                try:
                    self.relationship.on_emotional_result(emotion_changes)
                except Exception:
                    logger.exception("Guarded relationship emotion update failed")
            try:
                delay = self.scheduler.calculate_delay(
                    len(raw_reply),
                    emotion_intensity=emotion_intensity,
                    user_message=user_message,
                    emotions=current_emotions,
                    status_delay_applied=status_delay_applied,
                )
                typing_dur = self.scheduler.typing_duration(len(raw_reply))
                clean_messages_to_show = self.scheduler.split_message(raw_reply)
            except Exception:
                logger.exception("Guarded message scheduling failed")
                delay = 0.0
                typing_dur = max(0.8, min(4.0, len(raw_reply) / 18.0))
                clean_messages_to_show = [raw_reply]
            from .typo import apply_typos

            messages_to_show = [apply_typos(msg) for msg in clean_messages_to_show]
            typo_indices = [
                index for index, (shown, clean) in enumerate(zip(messages_to_show, clean_messages_to_show))
                if shown != clean
            ]
            result = {
                "reply": raw_reply,
                "messages": messages_to_show,
                "clean_messages": clean_messages_to_show,
                "sticker": None,
                "delay": delay,
                "typing_duration": typing_dur,
                "scheduler_status": self._safe_scheduler_status(),
                "emotion_changes": emotion_changes,
                "injection_detected": injection_detected,
                "guarded": guard.guarded,
                "guard_reasons": list(guard.reasons),
                "had_typo": bool(typo_indices),
                "typo_indices": typo_indices,
            }
            return self._with_deferred_commit(
                result,
                defer_side_effects=defer_side_effects,
                request_id=request_id,
                guard=guard,
                memory_directive=memory_directive,
                web_item_id="",
                thought_item_id="",
                cross_character_event_id="",
                emotions=current_emotions,
                emotion_intensity=emotion_intensity,
            )

        # ── Step 4: Build system prompt ───────────────────
        from ..persona.prompt_builder import build_system_prompt

        # Only delayed, locally saved web fragments may enter normal chat.
        web_context = ""
        web_item_id = ""
        thought_item_id = ""
        if self.thought_engine:
            try:
                thought_now = self.world_clock.now()
                thought = self.thought_engine.select_for_chat(user_message, now=thought_now)
                if thought:
                    web_context = thought.context
                    web_item_id = thought.id
                    thought_item_id = thought.id
            except Exception:
                logger.exception("Delayed web-fragment selection failed; continuing without it")

        social_context = self._optional_context(self.social, "build_social_context")
        cross_character_event_id = ""
        if self.social_universe:
            try:
                pending_cross_character = self.social_universe.pending_cross_character_context()
                if pending_cross_character:
                    cross_character_event_id, cross_context = pending_cross_character
                    social_context = "\n".join(
                        item for item in (social_context, cross_context) if item
                    )
            except Exception:
                logger.exception("Cross-character context failed; continuing without it")
        interest_context = self._optional_context(self.interest, "build_interest_context")
        affairs_context = self._optional_context(self.affairs, "build_prompt_context")
        user_context = self._optional_context(self.user_manager, "build_prompt_context")
        keepsake_context = self._optional_context(self.keepsakes, "maybe_recall_context")
        availability_context = self._availability_prompt_context()
        try:
            current_time = self.world_clock.now()
            calendar_context = self.world_clock.build_prompt_context(current_time)
        except Exception:
            logger.exception("World clock failed; using local process time without holiday claims")
            current_time = datetime.now()
            calendar_context = f"当前时间：{current_time.strftime('%Y-%m-%d %H:%M')}；节假日状态未知，不得猜测"
        try:
            allow_environment_description = bool(getattr(self.scheduler, "allow_environment_description", False))
        except Exception:
            allow_environment_description = False
        flaws_context = ""
        if self.feature_settings:
            try:
                from ..persona.flaws import build_user_flaws_prompt_block

                flaws_context = build_user_flaws_prompt_block(
                    self.feature_settings.user_selected_flaws,
                    enabled=self.feature_settings.personality_flaws_enabled,
                )
            except Exception:
                logger.exception("Personality flaw context failed; continuing without it")

        try:
            system_prompt = build_system_prompt(
                self.persona,
                memories=memories,
                emotions=current_emotions,
                intimacy=intimacy,
                current_time=current_time,
                web_context=web_context,
                social_context=social_context,
                interest_context=interest_context,
                affairs_context=affairs_context,
                calendar_context=calendar_context,
                user_context=user_context,
                keepsake_context=keepsake_context,
                flaws_context=flaws_context,
                availability_context=availability_context,
                allow_environment_description=allow_environment_description,
            )
        except Exception:
            logger.exception("Full prompt assembly failed; using identity-safe minimal prompt")
            system_prompt = self._minimal_system_prompt(current_time, current_emotions, intimacy)

        # ── Step 5: LLM call ──────────────────────────────
        conversation_tail = list(self._history[-20:])

        raw_reply = ""
        attempt = 0
        max_retries = 2
        retry_prompt = ""
        degraded_provider_failure = False

        while attempt <= max_retries:
            messages = [
                {"role": "system", "content": f"{system_prompt}\n\n{retry_prompt}".strip()},
            ]
            messages.extend(conversation_tail)
            messages.append({"role": "user", "content": guard.llm_text})
            try:
                response = await asyncio.wait_for(
                    self.adapter.chat(messages, purpose="chat_reply", background=False),
                    timeout=30.0,
                )
                raw_reply = response.content
            except LocalModeBlocked:
                # A central local-mode veto must not be converted into retries
                # or a personality reflex that looks like a successful AI turn.
                raise
            except Exception as exc:
                logger.error("LLM call failed (attempt %d): %s", attempt + 1, exc)
                if _is_timeout_exception(exc):
                    return self._provider_timeout_result(
                        exc,
                        injection_detected,
                        guard,
                        user_message,
                        defer_side_effects=defer_side_effects,
                        request_id=request_id,
                    )
                if attempt >= max_retries:
                    try:
                        raw_reply = self.reflex.choose("timeout", context=exc.__class__.__name__) if self.reflex else ""
                    except Exception:
                        raw_reply = ""
                    if not raw_reply:
                        raw_reply = "唔，我这边突然有点接不上。让我缓一下，晚点回来找你。"
                    if not defer_side_effects and hasattr(self.scheduler, "set_temporary_status"):
                        self.scheduler.set_temporary_status("busy", 5 * 60)
                    degraded_provider_failure = True
                    break
                attempt += 1
                await asyncio.sleep(1)
                continue

            # ── Step 6: Output filtering ──────────────────
            filtered = filter_output_detail(raw_reply)
            if filtered.action == "allow":
                break  # Clean output

            if filtered.action == "rewrite":
                raw_reply = filtered.text
                break

            # "fatal" hit — retry
            logger.warning("Fatal AI-ism in output — retrying (attempt %d)", attempt + 1)
            attempt += 1
            retry_prompt = build_retry_prompt()

        if filter_output_detail(raw_reply).should_retry:
            raw_reply = choose_avoidance_reply(
                emotions=current_emotions,
                intimacy=intimacy,
                persona_name=getattr(self.persona, "name", "星野幻月"),
            )

        from .continuity_guard import enforce_continuity

        continuity = enforce_continuity(
            raw_reply,
            persona=self.persona,
            now=current_time,
            intimacy=intimacy,
            emotions=current_emotions,
            affairs_context=affairs_context,
        )
        if not continuity.allowed:
            logger.warning("Continuity guard vetoed reply: %s", continuity.violations)
        raw_reply = continuity.text
        continuity_guarded = not continuity.allowed
        continuity_violations = list(continuity.violations)

        allow_long = self._is_serious_context(user_message)
        try:
            raw_reply = self.scheduler.shape_reply_length(
                raw_reply,
                allow_long=allow_long,
                allow_environment_description=allow_environment_description,
            )
        except Exception:
            logger.exception("Reply length shaping failed; preserving guarded reply")
        style_emotions = dict(current_emotions)
        try:
            from ..emotion.system import _keyword_emotion_estimate

            projected = _keyword_emotion_estimate(user_message, raw_reply)
            for name, delta in projected.items():
                style_emotions[name] = max(0.0, min(100.0, style_emotions.get(name, 0.0) + float(delta)))
        except Exception:
            logger.debug("Speech-habit emotion projection failed", exc_info=True)
        try:
            raw_reply = self.speech_habits.apply(
                raw_reply,
                emotions=style_emotions,
                allow_long=allow_long,
            )
        except Exception:
            logger.exception("Speech habits failed; preserving guarded reply")
        raw_reply = self._safe_addressing(raw_reply)

        # Style and relationship modules run after the first guard, so guard
        # their final output as well. Imported catchphrases are not trusted.
        final_filter = filter_output_detail(raw_reply)
        if final_filter.action == "rewrite":
            raw_reply = final_filter.text
        elif final_filter.action == "retry":
            raw_reply = choose_avoidance_reply(
                emotions=current_emotions,
                intimacy=intimacy,
                persona_name=getattr(self.persona, "name", "星野幻月"),
            )
        final_continuity = enforce_continuity(
            raw_reply,
            persona=self.persona,
            now=current_time,
            intimacy=intimacy,
            emotions=current_emotions,
            affairs_context=affairs_context,
        )
        if not final_continuity.allowed:
            logger.warning("Final continuity guard vetoed styled reply: %s", final_continuity.violations)
        raw_reply = final_continuity.text
        continuity_guarded = continuity_guarded or not final_continuity.allowed
        continuity_violations = list(dict.fromkeys([
            *continuity_violations,
            *final_continuity.violations,
        ]))

        # Every normally generated reply receives an independent semantic pass
        # over atomic facts. The verifier is deliberately fail-closed for
        # identity/history claims if its own provider call is unavailable.
        semantic_status = "not_run"
        semantic_reasons: list[str] = []
        semantic_claims: list[str] = []
        try:
            from .semantic_verifier import build_fact_registry, verify_reply_semantics

            facts = build_fact_registry(
                persona=self.persona,
                now=current_time,
                intimacy=intimacy,
                emotions=current_emotions,
                memories=memories,
                relationship=self.relationship,
                user_manager=self.user_manager,
                social_circle=self.social,
                interest_tracker=self.interest,
                affair_manager=self.affairs,
                history=self._history,
            )
            semantic = await verify_reply_semantics(
                raw_reply,
                user_message=user_message,
                adapter=self.adapter,
                facts=facts,
            )
            raw_reply = semantic.text
            semantic_status = semantic.status
            semantic_reasons = list(semantic.reasons)
            semantic_claims = list(semantic.claims)
        except Exception:
            logger.exception("Semantic continuity gate failed unexpectedly")
            semantic_status = "gate_error"
            raw_reply = "等一下，我先不把还没确认的事情说死。"

        semantic_filter = filter_output_detail(raw_reply)
        if semantic_filter.action == "rewrite":
            raw_reply = semantic_filter.text
        elif semantic_filter.action == "retry":
            raw_reply = choose_avoidance_reply(
                emotions=current_emotions,
                intimacy=intimacy,
                persona_name=getattr(self.persona, "name", "星野幻月"),
            )
        semantic_continuity = enforce_continuity(
            raw_reply,
            persona=self.persona,
            now=current_time,
            intimacy=intimacy,
            emotions=current_emotions,
            affairs_context=affairs_context,
        )
        raw_reply = semantic_continuity.text
        continuity_guarded = continuity_guarded or not semantic_continuity.allowed
        continuity_violations = list(dict.fromkeys([
            *continuity_violations,
            *semantic_continuity.violations,
        ]))

        # ── Step 7: Store in history ──────────────────────
        if not defer_side_effects:
            self._history.append({"role": "user", "content": user_message})
            self._history.append({"role": "assistant", "content": raw_reply})

        # ── Step 8: Emotion update ────────────────────────
        emotion_enabled = (
            self.feature_settings.emotion_system_enabled
            if self.feature_settings
            else getattr(self.emotion, "enabled", True)
        )
        if emotion_enabled and not defer_side_effects:
            try:
                emotion_changes = await self.emotion.analyze_exchange(
                    user_message, raw_reply,
                    adapter=self.adapter,
                    memories=memories,
                )
                self.emotion.apply_event(emotion_changes)
                self.emotion.tick()
                self._last_safe_emotions = dict(self.emotion.values)
                if relationship_interaction_recorded and hasattr(self.relationship, "on_emotional_result"):
                    self.relationship.on_emotional_result(emotion_changes)
            except Exception:
                logger.exception("Emotion analysis failed; reply continuity is preserved")
                emotion_changes = {}
        else:
            emotion_changes = {}

        emotion_delta_score = 0.0
        if emotion_changes:
            emotion_delta_score = min(
                sum(abs(float(value)) for value in emotion_changes.values()) / 30.0,
                1.0,
            )

        # ── Step 9: Memory storage ────────────────────────
        try:
            current_intensity = self.emotion.get_intensity()
            memory_emotions = dict(self.emotion.values)
            self._last_safe_emotions = dict(memory_emotions)
        except Exception:
            logger.exception("Emotion snapshot for memory failed")
            current_intensity = emotion_intensity
            memory_emotions = dict(self._last_safe_emotions)
        memory_importance = max(emotion_intensity, current_intensity, emotion_delta_score)
        if defer_side_effects:
            pass
        elif memory_directive == "skip":
            logger.info("User requested not to store this exchange")
        elif memory_directive and guard.memory_safe:
            try:
                directive_layer = "long_term"
                directive_text = memory_directive
                if memory_directive.startswith("short_term::"):
                    directive_layer = "short_term"
                    directive_text = memory_directive.removeprefix("short_term::").strip()
                elif memory_directive.startswith("long_term::"):
                    directive_text = memory_directive.removeprefix("long_term::").strip()
                if directive_text:
                    self.memory.store_fact(
                        f"User asked me to remember: {directive_text}",
                        layer=directive_layer,
                    )
            except Exception:
                logger.exception("Explicit memory storage failed; reply remains available")
        elif guard.memory_safe:
            try:
                await self.memory.store_interaction(
                    user_message,
                    raw_reply,
                    emotion_intensity=memory_importance,
                    emotions=memory_emotions,
                )
            except Exception:
                logger.exception("Interaction memory storage failed; reply remains available")

        if (
            not defer_side_effects
            and self.user_manager
            and guard.memory_safe
            and memory_directive != "skip"
        ):
            try:
                emotional_memory = self.user_manager.record_emotional_memory(
                    user_message=user_message,
                    assistant_reply=raw_reply,
                    emotion_changes=emotion_changes,
                    dominant_emotions=[name for name, _ in self._safe_dominant_emotions(4)],
                    importance=max(current_intensity, emotion_delta_score),
                )
                if emotional_memory:
                    self.memory.store_fact(f"情感记忆：{emotional_memory.summary}", layer="long_term")
            except Exception:
                logger.exception("Emotional memory persistence failed; continuing chat")

        # ── Step 10: Scheduling ───────────────────────────
        try:
            delay = self.scheduler.calculate_delay(
                len(raw_reply),
                emotion_intensity=emotion_intensity,
                user_message=user_message,
                emotions=memory_emotions,
                status_delay_applied=status_delay_applied,
            )
            typing_dur = self.scheduler.typing_duration(len(raw_reply))
            messages_to_show = self.scheduler.split_message(raw_reply)
        except Exception:
            logger.exception("Message scheduling failed; delivering one guarded bubble")
            delay = 0.0
            typing_dur = max(0.8, min(4.0, len(raw_reply) / 18.0))
            messages_to_show = [raw_reply]

        # ── Step 11: Split messages ───────────────────────
        clean_messages_to_show = list(messages_to_show)

        # ── Step 12: Apply typos (display only) ───────────
        from .typo import apply_typos
        messages_to_show = [apply_typos(msg) for msg in messages_to_show]
        typo_indices = [
            index for index, (shown, clean) in enumerate(zip(messages_to_show, clean_messages_to_show))
            if shown != clean
        ]

        # ── Step 13: Insert sticker (emotion-based) ──────
        import random
        sticker_payload = None
        if not defer_side_effects and self.stickers and messages_to_show and random.random() < 0.25:
            dominant = self._safe_dominant_emotions(1)
            if dominant:
                top_emotion = dominant[0][0]
                candidates = self.stickers.pick_for_emotion(top_emotion, top_k=3)
                if candidates:
                    sticker = random.choice(candidates)
                    sticker_payload = sticker.to_dict()
                    self.stickers.record_use(sticker)

        if (
            not defer_side_effects
            and thought_item_id
            and not degraded_provider_failure
            and self.thought_engine
        ):
            try:
                self.thought_engine.mark_shared(thought_item_id)
                if self.web:
                    self.web.mark_used_by_id(web_item_id)
            except Exception:
                logger.exception("Delayed web-fragment marker failed after successful reply")

        if (
            not defer_side_effects
            and cross_character_event_id
            and not degraded_provider_failure
            and self.social_universe
        ):
            try:
                self.social_universe.mark_cross_character_if_referenced(
                    cross_character_event_id,
                    raw_reply,
                )
            except Exception:
                logger.exception("Cross-character disclosure marker failed")

        result = {
            "reply": raw_reply,
            "messages": messages_to_show,
            "clean_messages": clean_messages_to_show,
            "sticker": sticker_payload,
            "delay": delay,
            "typing_duration": typing_dur,
            "scheduler_status": self._safe_scheduler_status(),
            "emotion_changes": emotion_changes,
            "injection_detected": injection_detected,
            "guarded": guard.guarded,
            "guard_reasons": list(guard.reasons),
            "continuity_guarded": continuity_guarded,
            "continuity_violations": continuity_violations,
            "semantic_verification": semantic_status,
            "semantic_reasons": semantic_reasons,
            "semantic_claims": semantic_claims,
            "degraded_to_local_reflex": degraded_provider_failure,
            "had_typo": bool(typo_indices),
            "typo_indices": typo_indices,
        }
        return self._with_deferred_commit(
            result,
            defer_side_effects=defer_side_effects,
            request_id=request_id,
            guard=guard,
            memory_directive=memory_directive,
            web_item_id=web_item_id,
            thought_item_id=thought_item_id,
            cross_character_event_id=cross_character_event_id,
            emotions=current_emotions,
            emotion_intensity=emotion_intensity,
        )

    def _with_deferred_commit(
        self,
        result: dict,
        *,
        defer_side_effects: bool,
        request_id: str,
        guard,
        memory_directive: str | None,
        web_item_id: str,
        thought_item_id: str,
        cross_character_event_id: str,
        emotions: dict[str, float],
        emotion_intensity: float,
    ) -> dict:
        """Attach JSON-safe commit material without mutating durable identity state."""
        if not defer_side_effects:
            result["side_effects_deferred"] = False
            return result
        result["side_effects_deferred"] = True
        result["_commit_context"] = {
            "request_id": str(request_id or ""),
            "memory_safe": bool(getattr(guard, "memory_safe", False)),
            "memory_directive": memory_directive,
            "web_item_id": str(web_item_id or ""),
            "thought_item_id": str(thought_item_id or ""),
            "cross_character_event_id": str(cross_character_event_id or ""),
            "emotions": {
                str(name): float(value)
                for name, value in dict(emotions or {}).items()
                if isinstance(value, (int, float))
            },
            "emotion_intensity": float(emotion_intensity or 0.0),
        }
        return result

    async def commit_exchange(
        self,
        *,
        request_id: str,
        user_message: str,
        result: dict,
    ) -> None:
        """Apply reply side effects at most once after cached delivery is accepted.

        The delivery ledger marks ``commit_state=started`` before entering this
        method.  If the process dies midway, the caller must not run it again;
        avoiding duplicate identity, relationship, and memory changes is safer
        than pretending a distributed exactly-once transaction exists.
        """
        request_id = str(request_id or "")
        if not request_id:
            raise ValueError("request_id is required for commit")
        if request_id in self._committed_request_ids:
            return
        context = result.get("_commit_context")
        if not isinstance(context, dict):
            raise ValueError("deferred chat result is missing commit context")
        context_request = str(context.get("request_id") or "")
        if context_request and context_request != request_id:
            raise ValueError("deferred chat result request scope mismatch")
        reply = str(result.get("reply") or "").strip()
        if not reply:
            messages = [str(value) for value in result.get("clean_messages") or result.get("messages") or []]
            reply = "".join(messages).strip()
        if not reply:
            raise ValueError("cannot commit an empty assistant reply")

        memory_safe = bool(context.get("memory_safe"))
        memory_directive = context.get("memory_directive")
        emotions = {
            str(name): float(value)
            for name, value in dict(context.get("emotions") or {}).items()
            if isinstance(value, (int, float))
        }
        emotion_intensity = float(context.get("emotion_intensity") or 0.0)
        commit_errors: list[str] = []

        # Record the semantic exchange first in the in-memory conversation.
        # The set is updated only at the end, while the external ledger owns
        # crash uncertainty and prevents retries after a partial commit.
        self._history.append({"role": "user", "content": user_message})
        self._history.append({"role": "assistant", "content": reply})

        relationship_recorded = False
        try:
            before = getattr(self.relationship, "interaction_count", None)
            self.relationship.on_user_message(user_message)
            after = getattr(self.relationship, "interaction_count", None)
            relationship_recorded = before is None or after is None or after > before
            self._last_safe_intimacy = int(getattr(self.relationship, "intimacy", self._last_safe_intimacy))
        except Exception:
            logger.exception("Deferred relationship commit failed")
            commit_errors.append("relationship")

        alignment = getattr(self.speech_habits, "alignment_engine", None)
        if alignment is not None and memory_safe:
            try:
                alignment.observe(user_message)
            except Exception:
                logger.exception("Deferred phrase alignment commit failed")
                commit_errors.append("phrase_alignment")

        if self.user_manager and memory_safe and memory_directive != "skip":
            try:
                updates = self.user_manager.extract_profile_updates(user_message)
                if updates:
                    self.user_manager.update_profile(updates)
                    if hasattr(self.memory, "sync_user_profile"):
                        self.memory.sync_user_profile(self.user_manager)
            except Exception:
                logger.exception("Deferred user profile commit failed")
                commit_errors.append("user_profile")

        # Use a local deterministic estimator here.  An auxiliary model call
        # would be a second hidden API charge after the visible reply was ready.
        emotion_changes: dict[str, float] = {}
        emotion_enabled = (
            self.feature_settings.emotion_system_enabled
            if self.feature_settings
            else getattr(self.emotion, "enabled", True)
        )
        if emotion_enabled:
            try:
                from ..emotion.system import _keyword_emotion_estimate

                emotion_changes = dict(_keyword_emotion_estimate(user_message, reply))
                self.emotion.apply_event(emotion_changes)
                self.emotion.tick()
                self._last_safe_emotions = dict(self.emotion.values)
                if relationship_recorded and hasattr(self.relationship, "on_emotional_result"):
                    self.relationship.on_emotional_result(emotion_changes)
            except Exception:
                logger.exception("Deferred local emotion commit failed")
                emotion_changes = {}
                commit_errors.append("emotion")

        if memory_safe and memory_directive != "skip":
            try:
                if isinstance(memory_directive, str) and memory_directive:
                    layer = "long_term"
                    directive_text = memory_directive
                    if memory_directive.startswith("short_term::"):
                        layer = "short_term"
                        directive_text = memory_directive.removeprefix("short_term::").strip()
                    elif memory_directive.startswith("long_term::"):
                        directive_text = memory_directive.removeprefix("long_term::").strip()
                    if directive_text:
                        self.memory.store_fact(
                            f"User asked me to remember: {directive_text}",
                            layer=layer,
                        )
                else:
                    changed = sum(abs(float(value)) for value in emotion_changes.values()) / 30.0
                    await self.memory.store_interaction(
                        user_message,
                        reply,
                        emotion_intensity=max(emotion_intensity, min(changed, 1.0)),
                        emotions=dict(getattr(self.emotion, "values", {}) or emotions),
                    )
            except Exception:
                logger.exception("Deferred memory commit failed")
                commit_errors.append("memory")

        thought_item_id = str(context.get("thought_item_id") or "")
        web_item_id = str(context.get("web_item_id") or "")
        if thought_item_id and self.thought_engine:
            try:
                self.thought_engine.mark_shared(thought_item_id)
                if self.web and web_item_id:
                    self.web.mark_used_by_id(web_item_id)
            except Exception:
                logger.exception("Deferred thought marker commit failed")
                commit_errors.append("thought_marker")
        cross_id = str(context.get("cross_character_event_id") or "")
        if cross_id and self.social_universe:
            try:
                self.social_universe.mark_cross_character_if_referenced(cross_id, reply)
            except Exception:
                logger.exception("Deferred cross-character marker commit failed")
                commit_errors.append("cross_character_marker")

        if commit_errors:
            raise RuntimeError(
                "deferred commit incomplete: " + ",".join(commit_errors)
            )
        self._committed_request_ids.add(request_id)

    async def close(self) -> None:
        """Clean up session resources."""
        close = getattr(self.adapter, "close", None)
        if callable(close):
            result = close()
            if hasattr(result, "__await__"):
                await result

    def _optional_context(self, manager, method_name: str) -> str:
        if manager is None:
            return ""
        try:
            return str(getattr(manager, method_name)() or "")
        except Exception:
            logger.exception("Optional context module failed: %s", method_name)
            return ""

    def _safe_addressing(self, text: str) -> str:
        try:
            if hasattr(self.relationship, "enforce_addressing"):
                return self.relationship.enforce_addressing(text)
        except Exception:
            logger.exception("Relationship addressing failed; preserving guarded text")
        return text

    def _safe_dominant_emotions(self, limit: int) -> list[tuple[str, float]]:
        try:
            return list(self.emotion.get_dominant(limit))
        except Exception:
            logger.exception("Dominant emotion lookup failed; using safe snapshot")
            return sorted(self._last_safe_emotions.items(), key=lambda item: item[1], reverse=True)[:limit]

    def _safe_scheduler_status(self) -> dict:
        try:
            if hasattr(self.scheduler, "status_payload"):
                return self.scheduler.status_payload()
            status = getattr(self.scheduler, "status", "online")
            return {"status": status, "label": status}
        except Exception:
            logger.exception("Scheduler status lookup failed")
            return {"status": "online", "label": "在线"}

    def _provider_timeout_result(
        self,
        exc: Exception,
        injection_detected: bool,
        guard,
        user_message: str = "",
        *,
        defer_side_effects: bool = False,
        request_id: str = "",
    ) -> dict:
        """Keep a provider outage inside the character's local continuity boundary."""
        try:
            provider_text = self.reflex.choose("timeout", context=exc.__class__.__name__) if self.reflex else ""
        except Exception:
            logger.exception("Local reflex lookup failed")
            provider_text = "唔，这边忽然有点接不上。让我缓一会儿，晚点回来认真回你。"
        if not provider_text:
            provider_text = "唔，这边忽然有点接不上。让我缓一会儿，晚点回来认真回你。"
        provider_text = self._shape_reflex_text(provider_text)
        try:
            if not defer_side_effects and hasattr(self.scheduler, "set_temporary_status"):
                self.scheduler.set_temporary_status("busy", 5 * 60)
            messages = self.scheduler.split_message(provider_text)
            typing_duration = self.scheduler.typing_duration(len(provider_text))
        except Exception:
            messages = [provider_text]
            typing_duration = max(0.8, min(4.0, len(provider_text) / 18.0))
        if user_message and not defer_side_effects:
            self._history.append({"role": "user", "content": user_message})
        if not defer_side_effects:
            self._history.append({"role": "assistant", "content": provider_text})
        result = {
            "reply": provider_text,
            "messages": messages,
            "clean_messages": messages,
            "sticker": None,
            "delay": 0.0,
            "typing_duration": typing_duration,
            "scheduler_status": self._safe_scheduler_status(),
            "emotion_changes": {},
            "injection_detected": injection_detected,
            "guarded": guard.guarded,
            "guard_reasons": list(guard.reasons),
            "provider_timeout": True,
            "degraded_to_local_reflex": True,
            "provider_error_type": exc.__class__.__name__,
            "had_typo": False,
            "typo_indices": [],
        }
        return self._with_deferred_commit(
            result,
            defer_side_effects=defer_side_effects,
            request_id=request_id,
            guard=guard,
            memory_directive=self._parse_memory_directive(user_message),
            web_item_id="",
            thought_item_id="",
            cross_character_event_id="",
            emotions=dict(getattr(self.emotion, "values", {}) or self._last_safe_emotions),
            emotion_intensity=0.0,
        )

    def _local_personality_result(
        self,
        text: str,
        *,
        user_message: str,
        guard,
        injection_detected: bool,
        status_delay_applied: bool,
        emotions: dict[str, float],
        defer_side_effects: bool = False,
        request_id: str = "",
    ) -> dict:
        """Deliver a deterministic local personality response through normal guards."""
        text = self._shape_reflex_text(text)
        if not defer_side_effects:
            self._history.append({"role": "user", "content": user_message})
            self._history.append({"role": "assistant", "content": text})
        try:
            delay = self.scheduler.calculate_delay(
                len(text),
                emotion_intensity=self.emotion.get_intensity(),
                user_message=user_message,
                emotions=emotions,
                status_delay_applied=status_delay_applied,
            )
            clean_messages = self.scheduler.split_message(text)
            typing_duration = self.scheduler.typing_duration(len(text))
        except Exception:
            delay = 0.0
            clean_messages = [text]
            typing_duration = max(0.8, min(4.0, len(text) / 18.0))
        result = {
            "reply": text,
            "messages": clean_messages,
            "clean_messages": clean_messages,
            "sticker": None,
            "delay": delay,
            "typing_duration": typing_duration,
            "scheduler_status": self._safe_scheduler_status(),
            "emotion_changes": {},
            "injection_detected": injection_detected,
            "guarded": guard.guarded,
            "guard_reasons": list(guard.reasons),
            "local_personality_response": True,
            "degraded_to_local_reflex": False,
            "had_typo": False,
            "typo_indices": [],
        }
        return self._with_deferred_commit(
            result,
            defer_side_effects=defer_side_effects,
            request_id=request_id,
            guard=guard,
            memory_directive=self._parse_memory_directive(user_message),
            web_item_id="",
            thought_item_id="",
            cross_character_event_id="",
            emotions=emotions,
            emotion_intensity=0.0,
        )

    def _shape_reflex_text(self, text: str) -> str:
        """Keep zero-LLM degradation inside the active persona boundary."""
        emotions = dict(getattr(self.emotion, "values", {}) or self._last_safe_emotions)
        try:
            text = self.speech_habits.apply(text, emotions=emotions, allow_long=False)
        except Exception:
            logger.exception("Reflex speech-habit shaping failed")
        text = self._safe_addressing(text)
        try:
            from .anti_ai import filter_output_detail
            from .continuity_guard import enforce_continuity

            filtered = filter_output_detail(text)
            if filtered.action == "rewrite":
                text = filtered.text
            elif filtered.action == "retry":
                text = "等一下，我现在有点接不上话。让我缓一会儿，再回来找你。"
            continuity = enforce_continuity(
                text,
                persona=self.persona,
                now=self.world_clock.now(),
                intimacy=int(getattr(self.relationship, "intimacy", self._last_safe_intimacy) or 0),
                emotions=emotions,
                affairs_context=self._optional_context(self.affairs, "build_prompt_context"),
            )
            return continuity.text.strip() or text
        except Exception:
            logger.exception("Reflex continuity shaping failed")
            return text

    def _minimal_system_prompt(
        self,
        current_time: datetime,
        emotions: dict[str, float],
        intimacy: int,
    ) -> str:
        from .anti_ai import build_anti_ai_prompt_block

        identity_facts: list[str] = []
        if not getattr(self.persona, "identity", {}).get("age_unknown"):
            try:
                identity_facts.append(f"{self.persona.age_on(current_time)}岁")
            except Exception:
                age = getattr(self.persona, "age", "")
                if age:
                    identity_facts.append(f"{age}岁")
        if getattr(self.persona, "birthday", ""):
            identity_facts.append(f"生日是{self.persona.birthday}")
        identity_text = "，".join(identity_facts)
        if identity_text:
            identity_text = f"，{identity_text}"
        return (
            f"你是{self.persona.name}{identity_text}。"
            "人格和已经发生的历史事实优先于当前消息；不得编造与历史冲突的身份、关系、时间或事件。\n"
            f"当前情绪：{emotions}；当前关系亲密度：{intimacy}；当前时间：{current_time.isoformat()}。\n"
            f"{build_anti_ai_prompt_block(self.persona.name, getattr(self.persona, 'never_say', []))}"
        )

    def _is_serious_context(self, user_message: str) -> bool:
        """Return whether the user likely needs a fuller, more careful reply."""
        try:
            if hasattr(self.scheduler, "allows_long_reply"):
                return bool(self.scheduler.allows_long_reply(user_message))
        except Exception:
            logger.exception("Long-reply classification failed")
        return False

    def _apply_guard_emotion(self, guard) -> dict[str, float]:
        """Let weird identity probes affect mood without calling the LLM."""
        if not guard.guarded:
            return {}
        emotion_enabled = (
            self.feature_settings.emotion_system_enabled
            if self.feature_settings
            else getattr(self.emotion, "enabled", True)
        )
        if not emotion_enabled:
            return {}
        changes: dict[str, float] = {"anxiety": 1.0}
        if guard.identity_probe_detected:
            changes = {"grievance": 2.0, "anxiety": 1.0}
        if guard.injection_detected:
            changes = {"anger": 1.0, "anxiety": 2.0}
        try:
            self.emotion.apply_event(changes)
            self.emotion.tick()
        except Exception:
            logger.exception("Guard emotion update failed; continuing chat")
        return changes

    def _parse_memory_directive(self, user_message: str) -> str | None:
        """Parse simple user-controlled memory directives.

        Supported natural/manual forms:
        - /remember something
        - /remember-long something
        - /remember-short something
        - 记住：something / 记住:something
        - 长期记住：something / 短期记住：something
        - 不要记住 / 别记 / /forget-this
        """
        text = user_message.strip()
        lowered = text.lower()
        skip_markers = ["/forget-this", "/dontremember", "不要记住", "别记", "不要保存"]
        if any(marker in lowered or marker in text for marker in skip_markers):
            return "skip"

        if lowered.startswith("/remember "):
            return text[len("/remember "):].strip() or None
        if lowered.startswith("/remember-long "):
            remembered = text[len("/remember-long "):].strip()
            return f"long_term::{remembered}" if remembered else None
        if lowered.startswith("/remember-short "):
            remembered = text[len("/remember-short "):].strip()
            return f"short_term::{remembered}" if remembered else None

        for marker in ["长期记住：", "长期记住:", "列为长期记忆：", "列为长期记忆:"]:
            if marker in text:
                remembered = text.split(marker, 1)[1].strip()
                return f"long_term::{remembered}" if remembered else None

        for marker in ["短期记住：", "短期记住:", "列为短期记忆：", "列为短期记忆:"]:
            if marker in text:
                remembered = text.split(marker, 1)[1].strip()
                return f"short_term::{remembered}" if remembered else None

        for marker in ["记住：", "记住:", "帮我记住：", "帮我记住:"]:
            if marker in text:
                remembered = text.split(marker, 1)[1].strip()
                return remembered or None
        return None

    def _availability_prompt_context(self) -> str:
        try:
            status = getattr(self.scheduler, "status", "online")
        except Exception:
            logger.exception("Availability lookup failed")
            status = "online"
        if status == "sleeping":
            return (
                "Your current phone status is 睡觉. The user messaged you during rest time. "
                "If you answer quickly, sound sleepy and a little confused; if the reply is delayed until morning, "
                "refer to the user's late-night message as something from last night. You may gently ask why they slept so late."
            )
        if status == "busy":
            return (
                "Your current phone status is 忙碌. You are not ignoring the user, but replies should feel a bit delayed and concise."
            )
        if status == "away":
            return (
                "Your current phone status is 外出. You may mention being outside or doing something in life if it naturally fits."
            )
        return "Your current phone status is 在线. You can reply normally, but still with human-like pacing."


def _is_timeout_exception(exc: Exception) -> bool:
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
        return True
    name = exc.__class__.__name__.lower()
    message = str(exc).lower()
    return "timeout" in name or "timed out" in message or "timeout" in message
