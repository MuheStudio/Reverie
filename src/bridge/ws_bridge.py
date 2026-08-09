"""
Reverie WebSocket Bridge — Python 后端与前端的实时通信层。

职责：
  1. 启动 WebSocket 服务器（端口 48913）
  2. 将 Reverie 核心系统（聊天/记忆/情绪/日记）暴露为结构化消息
  3. 管理前端连接生命周期
  4. 转发 N.E.K.O 主动通知（主动聊天、记忆更新等）
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Awaitable
from weakref import WeakSet

import websockets
from websockets.server import WebSocketServerProtocol
from ..kernel.contracts import (
    CommandEnvelopeV4,
    LEGACY_MESSAGE_TYPES,
    PersonaScopeV4,
)

logger = logging.getLogger("reverie.bridge.ws")

class MsgType:
    """Legacy event-name facade generated from the canonical V4 contract."""


for _message_name, _message_value in LEGACY_MESSAGE_TYPES:
    setattr(MsgType, _message_name, _message_value)
del _message_name, _message_value


class BridgeState:
    """持有所有 Reverie 子系统的引用，供 WebSocket 处理器访问。"""

    def __init__(self):
        self.session = None          # ChatSession
        self.adapter = None          # LLMAdapter
        self.proactive = None        # ProactiveChat
        self.work_manager = None     # WorkManager
        self.diary = None            # DiaryManager
        self.timeline = None         # TimelineManager
        self.emotion = None          # EmotionSystem
        self.memory = None           # MemoryManager
        self.persona = None          # Persona
        self.relationship = None     # RelationshipTracker
        self.stickers = None         # StickerManager
        self.web_surfing = None      # WebSurfingManager
        self.neko_memory = None      # N.E.K.O FactStore (optional)
        self.image_service = None    # foxgirls.club app (optional)
        self.settings = None         # Settings
        self.user_mgr = None         # UserManager
        self.social_circle = None    # SocialCircle
        self.interest_tracker = None  # InterestTracker
        self.affair_manager = None   # PersonalAffairManager
        self.world_clock = None      # WorldClock
        self.keepsakes = None        # KeepsakeManager
        self.immersion = None        # ImmersionManager
        self.backup_manager = None   # LocalBackupManager
        self.ambient_presence = None # AmbientPresence
        self.thought_engine = None   # ThoughtOfYouEngine
        self.diary_keys = None       # DiaryKeyManager
        self.api_budget = None       # ApiBudgetTracker
        self.social_universe = None  # SocialUniverse
        self.phrase_alignment = None # UserPhraseAlignment
        self.kernel_store = None      # KernelStore: canonical identity/chat/event ledger
        self.archive_store = None     # Optional persona-scoped archive/world-book store
        self.module_registry = None   # Failure isolation and user-visible module health
        self.game_state_store = None  # Optional persona-scoped mini-game state
        self.persona_epoch = 0       # Incremented only by privileged activation.
        self.persona_restart_required = False  # Blocks mixed old-runtime/new-identity chat.
        self.model_epoch = 0         # Isolates replies from hot-swapped providers.
        self.runtime_unavailable: tuple[str, ...] = ()


bridge_state = BridgeState()

# 活跃连接集合（用于广播）
_connections: WeakSet[WebSocketServerProtocol] = WeakSet()
# 消息处理器注册表
_handlers: dict[str, Callable[[dict, WebSocketServerProtocol], Awaitable[dict | None]]] = {}
_pending_chat_store = None
_chat_coordinator = None
_client_contexts: dict[WebSocketServerProtocol, "BridgeClientContext"] = {}
_controller_ws: WebSocketServerProtocol | None = None
_bridge_secret_value = ""
# Serializes proactive side effects/broadcasts with privileged identity changes.
# Whichever acquires this lock first defines the observable linearization order.
_persona_effect_lock = asyncio.Lock()


@dataclass
class BridgeClientContext:
    client_id: str
    protocol_version: int
    authenticated: bool = False
    conversation_id: str = ""
    persona_id: str = ""

RESPONSE_TYPE_BY_REQUEST = {
    MsgType.MEMORY_QUERY: MsgType.MEMORY_RESULT,
    MsgType.MEMORY_LIST: MsgType.MEMORY_RESULT,
    MsgType.MEMORY_EDIT: MsgType.MEMORY_RESULT,
    MsgType.MEMORY_DELETE: MsgType.MEMORY_RESULT,
    MsgType.CHAT_HISTORY: MsgType.CHAT_HISTORY_RESULT,
    MsgType.MEMORY_SETTINGS_GET: MsgType.MEMORY_SETTINGS_RESULT,
    MsgType.MEMORY_STORE: MsgType.MEMORY_RESULT,
    MsgType.MEMORY_CANDIDATE_LIST: MsgType.MEMORY_CANDIDATE_RESULT,
    MsgType.MEMORY_CANDIDATE_CONFIRM: MsgType.MEMORY_CANDIDATE_RESULT,
    MsgType.MEMORY_CANDIDATE_REJECT: MsgType.MEMORY_CANDIDATE_RESULT,
    MsgType.EMOTION_GET: MsgType.EMOTION_UPDATE,
    MsgType.PERSONA_GET: MsgType.PERSONA_DATA,
    MsgType.PERSONA_IMPORT: MsgType.PERSONA_IMPORT_RESULT,
    MsgType.PERSONA_LIST: MsgType.PERSONA_IMPORT_RESULT,
    MsgType.PERSONA_ACTIVATE: MsgType.PERSONA_IMPORT_RESULT,
    MsgType.ARCHIVE_GET: MsgType.ARCHIVE_RESULT,
    MsgType.ARCHIVE_PUT: MsgType.ARCHIVE_RESULT,
    MsgType.ARCHIVE_MIGRATE: MsgType.ARCHIVE_RESULT,
    MsgType.MODULE_LIST: MsgType.MODULE_RESULT,
    MsgType.MODULE_CONTROL: MsgType.MODULE_RESULT,
    MsgType.GAME_STATE_GET: MsgType.GAME_STATE_RESULT,
    MsgType.GAME_STATE_PUT: MsgType.GAME_STATE_RESULT,
    MsgType.RELATIONSHIP_GET: MsgType.RELATIONSHIP_DATA,
    MsgType.DIARY_REQUEST: MsgType.DIARY_RESULT,
    MsgType.TIMELINE_REQUEST: MsgType.TIMELINE_RESULT,
    MsgType.AMBIENT_GET: MsgType.AMBIENT_RESULT,
    MsgType.API_BUDGET_GET: MsgType.API_BUDGET_RESULT,
    MsgType.GROUP_REQUEST: MsgType.GROUP_RESULT,
    MsgType.GROUP_SEND: MsgType.GROUP_RESULT,
    MsgType.IMAGE_RANDOM: MsgType.IMAGE_RESULT,
    MsgType.TTS_LIST: MsgType.TTS_RESULT,
    MsgType.TTS_SYNTHESIZE: MsgType.TTS_RESULT,
    MsgType.USER_PROFILE_GET: MsgType.USER_PROFILE_RESULT,
    MsgType.USER_PROFILE_UPDATE: MsgType.USER_PROFILE_RESULT,
    MsgType.KEEPSAKE_LIST: MsgType.KEEPSAKE_RESULT,
    MsgType.KEEPSAKE_ADD: MsgType.KEEPSAKE_RESULT,
    MsgType.BACKUP_EXPORT: MsgType.BACKUP_RESULT,
    MsgType.BACKUP_IMPORT: MsgType.BACKUP_RESULT,
    MsgType.STICKER_LIST: MsgType.STICKER_DATA,
    MsgType.STICKER_COLLECT: MsgType.STICKER_DATA,
    MsgType.STICKER_REACT: MsgType.STICKER_DATA,
    MsgType.ANTI_AI_STATUS: MsgType.ANTI_AI_STATUS_RESULT,
    MsgType.IMMERSION_NEARBY: MsgType.IMMERSION_RESULT,
    MsgType.IMMERSION_CLOSEUP: MsgType.IMMERSION_RESULT,
    MsgType.IMMERSION_SMART_HOME: MsgType.IMMERSION_RESULT,
    MsgType.SETTINGS_UPDATE: MsgType.SETTINGS_UPDATE_RESULT,
    MsgType.SETTINGS_GET: MsgType.SETTINGS_GET_RESULT,
    MsgType.AI_USAGE_GET: MsgType.AI_USAGE_RESULT,
    MsgType.AI_USAGE_GRANT: MsgType.AI_USAGE_RESULT,
    MsgType.AI_USAGE_REVOKE: MsgType.AI_USAGE_RESULT,
}


def response_type_for_request(msg_type: str) -> str:
    """Return the canonical frontend message type for a backend request."""
    return RESPONSE_TYPE_BY_REQUEST.get(msg_type, msg_type.replace(":", "_") + "_result")


_POST_PERSONA_SWITCH_ALLOWED = frozenset({
    MsgType.CHAT_STOP,
    MsgType.CHAT_CANCEL,
    MsgType.CHAT_REVEAL,
    MsgType.LOCAL_MODE_SET,
    MsgType.AI_USAGE_GET,
    MsgType.AI_USAGE_GRANT,
    MsgType.AI_USAGE_REVOKE,
    MsgType.PERSONA_GET,
    MsgType.PERSONA_IMPORT,
    MsgType.PERSONA_LIST,
    MsgType.API_BUDGET_GET,
    MsgType.ARCHIVE_GET,
    MsgType.ARCHIVE_PUT,
    MsgType.ARCHIVE_MIGRATE,
    MsgType.MODULE_LIST,
    MsgType.MODULE_CONTROL,
    MsgType.GAME_STATE_GET,
    MsgType.GAME_STATE_PUT,
    MsgType.TTS_LIST,
    MsgType.TTS_SYNTHESIZE,
})


def persona_restart_blocks(msg_type: str) -> bool:
    """Fail closed for every old-runtime subsystem after identity activation."""

    return bool(
        bridge_state.persona_restart_required
        and msg_type not in _POST_PERSONA_SWITCH_ALLOWED
    )


_DEGRADED_KERNEL_ALLOWED = frozenset({
    MsgType.LOCAL_MODE_SET,
    MsgType.AI_USAGE_GET,
    MsgType.AI_USAGE_GRANT,
    MsgType.AI_USAGE_REVOKE,
    MsgType.PERSONA_GET,
    MsgType.PERSONA_IMPORT,
    MsgType.PERSONA_LIST,
    MsgType.PERSONA_ACTIVATE,
    MsgType.ARCHIVE_GET,
    MsgType.ARCHIVE_PUT,
    MsgType.ARCHIVE_MIGRATE,
    MsgType.MODULE_LIST,
    MsgType.MODULE_CONTROL,
    MsgType.GAME_STATE_GET,
    MsgType.GAME_STATE_PUT,
    MsgType.TTS_LIST,
    MsgType.TTS_SYNTHESIZE,
})


def degraded_runtime_blocks(msg_type: str) -> bool:
    """Keep the identity/settings kernel usable when feature modules are absent."""

    return bool(
        bridge_state.runtime_unavailable
        and msg_type not in _DEGRADED_KERNEL_ALLOWED
    )


_PERSONA_SCOPED_COMMANDS = frozenset({
    MsgType.CHAT_SEND,
    MsgType.CHAT_CANCEL,
    MsgType.CHAT_REVEAL,
    MsgType.CHAT_STOP,
    MsgType.CHAT_HISTORY,
    MsgType.MEMORY_QUERY,
    MsgType.MEMORY_SETTINGS_GET,
    MsgType.MEMORY_STORE,
    MsgType.MEMORY_CANDIDATE_LIST,
    MsgType.MEMORY_CANDIDATE_CONFIRM,
    MsgType.MEMORY_CANDIDATE_REJECT,
    MsgType.EMOTION_GET,
    MsgType.ARCHIVE_GET,
    MsgType.ARCHIVE_PUT,
    MsgType.ARCHIVE_MIGRATE,
    MsgType.GAME_STATE_GET,
    MsgType.GAME_STATE_PUT,
    MsgType.RELATIONSHIP_GET,
    MsgType.DIARY_REQUEST,
    MsgType.TIMELINE_REQUEST,
    MsgType.AMBIENT_GET,
    MsgType.GROUP_REQUEST,
    MsgType.GROUP_SEND,
    MsgType.IMAGE_RANDOM,
    MsgType.KEEPSAKE_LIST,
    MsgType.KEEPSAKE_ADD,
})


def _matches_expected_persona(payload: dict[str, Any]) -> bool:
    active = _active_persona_scope()
    try:
        epoch = int(payload.get("expected_persona_epoch"))
    except (TypeError, ValueError):
        return False
    expected_id = str(payload.get("expected_persona_id") or "")
    expected_fingerprint = str(payload.get("expected_persona_fingerprint") or "")
    return bool(
        expected_id
        and expected_fingerprint
        and expected_id == str(active["persona_id"])
        and epoch == int(active["persona_epoch"])
        and hmac.compare_digest(
            expected_fingerprint,
            str(active["persona_fingerprint"]),
        )
    )


def register_handler(msg_type: str):
    """装饰器：注册消息处理器。"""
    def decorator(fn):
        _handlers[msg_type] = fn
        return fn
    return decorator


async def send_to_frontend(
    ws: WebSocketServerProtocol,
    msg_type: str,
    payload: Any,
    *,
    request_id: str = "",
) -> bool:
    """向单个前端连接发送消息。"""
    try:
        envelope: dict[str, Any] = {"type": msg_type, "payload": payload}
        if request_id:
            envelope["request_id"] = request_id
        await ws.send(json.dumps(envelope, ensure_ascii=False))
        return True
    except websockets.ConnectionClosed:
        return False


async def broadcast(msg_type: str, payload: Any):
    """向所有前端连接广播消息。"""
    if not _connections:
        return
    msg = json.dumps({"type": msg_type, "payload": payload}, ensure_ascii=False)

    async def send_one(ws: WebSocketServerProtocol) -> bool:
        try:
            await asyncio.wait_for(ws.send(msg), timeout=5.0)
            return True
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            return False

    snapshot = tuple(_connections)
    results = await asyncio.gather(
        *(send_one(ws) for ws in snapshot),
        return_exceptions=True,
    )
    dead = [ws for ws, ok in zip(snapshot, results) if not ok]
    if dead:
        _connections.difference_update(dead)


def _runtime_activity_payload() -> dict[str, Any]:
    """Return durable background activity, independent of renderer timers."""
    work_manager = bridge_state.work_manager
    timeline_revision = ""
    timeline = bridge_state.timeline
    if timeline and hasattr(timeline, "get_recent"):
        try:
            recent = list(timeline.get_recent(1) or [])
            if recent:
                post = recent[0]
                data = post.to_dict() if hasattr(post, "to_dict") else post
                if isinstance(data, dict):
                    timeline_revision = "|".join(
                        str(data.get(key, "")) for key in ("id", "date", "updated_at")
                    ).strip("|")
        except Exception:
            logger.debug("Could not read timeline activity revision", exc_info=True)
    return {
        "diary_writing": bool(getattr(work_manager, "diary_writing", False)),
        "timeline_revision": timeline_revision,
    }


async def _runtime_activity_loop() -> None:
    """Publish activity changes even when Chromium throttles the renderer."""
    previous: dict[str, Any] | None = None
    while True:
        try:
            await asyncio.sleep(0.4)
            current = _runtime_activity_payload()
            if current != previous:
                previous = current
                await broadcast(MsgType.RUNTIME_ACTIVITY, current)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Runtime activity broadcast failed")
            await asyncio.sleep(1)


def _apply_proactive_result_state(payload: dict) -> None:
    """Persist emotion, relationship, and diary effects of a life event."""
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    story_event = metadata.get("story_event") if isinstance(metadata, dict) else None
    emotion_changes = payload.get("emotion_changes")
    if isinstance(emotion_changes, dict) and emotion_changes and bridge_state.emotion:
        bridge_state.emotion.apply_event(emotion_changes)
        if bridge_state.relationship and hasattr(bridge_state.relationship, "on_emotional_result"):
            bridge_state.relationship.on_emotional_result(emotion_changes)
    if story_event and bridge_state.diary and hasattr(bridge_state.diary, "record_external_highlight"):
        bridge_state.diary.record_external_highlight(
            str(story_event.get("date", "")),
            str(story_event.get("content", "")),
        )
        if bridge_state.relationship and hasattr(bridge_state.relationship, "on_special_event"):
            bridge_state.relationship.on_special_event(importance=0.4)
    if story_event and bridge_state.timeline and hasattr(bridge_state.timeline, "record_event_fact"):
        bridge_state.timeline.record_event_fact(
            event_id=str(story_event.get("story_id", "story")),
            title=str(story_event.get("title", "持续中的生活事件")),
            fact=str(story_event.get("content", "")),
            date=str(story_event.get("date", "")) or None,
        )


async def _proactive_broadcast_loop() -> None:
    """Drain proactive messages and push them to connected frontends."""
    while True:
        try:
            await asyncio.sleep(5)
            proactive = bridge_state.proactive
            if not proactive or not hasattr(proactive, "drain_pending"):
                continue
            electron_host = os.environ.get("REVERIE_BRIDGE_MODE") == "1"
            if not _connections and not electron_host:
                continue
            for result in proactive.drain_pending():
                async with _persona_effect_lock:
                    is_current = getattr(proactive, "is_result_current", None)
                    if not callable(is_current) or not is_current(result):
                        logger.info("Discarded stale proactive result before bridge side effects")
                        continue
                    messages = list(getattr(result, "messages", []) or [])
                    if not messages:
                        continue
                    notifications_enabled = bool(
                        getattr(
                            getattr(bridge_state.settings, "features", None),
                            "proactive_notifications_enabled",
                            True,
                        )
                    )
                    if electron_host and notifications_enabled:
                        try:
                            from src.notifications import NotificationOutbox

                            NotificationOutbox().enqueue(
                                messages[0],
                                title=str(getattr(bridge_state.persona, "name", "Reverie")),
                                category=str(getattr(result, "trigger", "care")),
                            )
                        except Exception:
                            logger.exception("Failed to enqueue native proactive notification")
                    payload = {
                        "messages": messages,
                        "text": "\n".join(messages),
                        "trigger": getattr(result, "trigger", ""),
                        "emotion_changes": getattr(result, "emotion_changes", {}),
                        "metadata": getattr(result, "metadata", {}),
                        "persona_id": result.persona_token.persona_id,
                        "persona_epoch": result.persona_token.epoch,
                        "persona_fingerprint": result.persona_token.fingerprint,
                        "notify": notifications_enabled and not electron_host,
                    }
                    _apply_proactive_result_state(payload)
                    if _connections:
                        try:
                            await asyncio.wait_for(
                                broadcast(MsgType.PROACTIVE_MESSAGE, payload),
                                timeout=2.0,
                            )
                        except asyncio.TimeoutError:
                            # A wedged renderer must not hold the persona
                            # linearization gate and block an identity switch.
                            logger.warning("Timed out broadcasting proactive result")
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("Proactive broadcast loop failed")


def _scheduler_status_payload() -> dict:
    scheduler = getattr(getattr(bridge_state, "session", None), "scheduler", None)
    if scheduler and hasattr(scheduler, "status_payload"):
        try:
            payload = scheduler.status_payload()
            if isinstance(payload, dict):
                status = payload.get("status", "online")
                if status not in {"online", "busy", "away", "sleeping"}:
                    status = "online"
                label = payload.get("label")
                if not isinstance(label, str):
                    label = {"online": "在线", "busy": "忙碌", "away": "外出", "sleeping": "睡觉"}[status]
                return {
                    "status": status,
                    "label": label,
                    "is_available": bool(payload.get("is_available", status != "sleeping")),
                    "immediate_reply_probability": payload.get("immediate_reply_probability"),
                }
        except Exception:
            logger.debug("Scheduler status payload unavailable", exc_info=True)
    status = getattr(scheduler, "status", "online")
    if status not in {"online", "busy", "away", "sleeping"}:
        status = "online"
    label = {"online": "在线", "busy": "忙碌", "away": "外出", "sleeping": "睡觉"}[status]
    return {"status": status, "label": label, "is_available": status != "sleeping"}


def _immersion_manager():
    if bridge_state.immersion is None:
        from src.immersion import ImmersionManager

        bridge_state.immersion = ImmersionManager(
            getattr(bridge_state.settings, "features", None)
            if bridge_state.settings
            else None
        )
    return bridge_state.immersion


def _local_backup_manager():
    if bridge_state.backup_manager is not None:
        return bridge_state.backup_manager, None
    missing = [
        name
        for name in ("memory", "emotion", "relationship", "diary", "user_mgr")
        if getattr(bridge_state, name, None) is None
    ]
    if missing:
        return None, "本地备份系统未初始化：" + "、".join(missing)
    from src.backup import LocalBackupManager

    return (
        LocalBackupManager(
            memory=bridge_state.memory,
            emotion=bridge_state.emotion,
            relationship=bridge_state.relationship,
            diary=bridge_state.diary,
            user_manager=bridge_state.user_mgr,
            timeline=bridge_state.timeline,
            social_circle=bridge_state.social_circle,
            interest_tracker=bridge_state.interest_tracker,
            affair_manager=bridge_state.affair_manager,
            world_clock=bridge_state.world_clock,
            ambient_presence=bridge_state.ambient_presence,
            thought_engine=bridge_state.thought_engine,
            diary_keys=bridge_state.diary_keys,
            phrase_alignment=bridge_state.phrase_alignment,
            social_universe=bridge_state.social_universe,
        ),
        None,
    )


def _get_pending_chat_store():
    global _pending_chat_store
    if _pending_chat_store is None:
        from src.chat.pending import PendingChatStore

        _pending_chat_store = PendingChatStore()
    return _pending_chat_store


def _active_persona_id() -> str:
    try:
        from src.persona.identity import GLOBAL_PERSONA_EPOCH

        return GLOBAL_PERSONA_EPOCH.token().persona_id
    except RuntimeError:
        pass
    persona = bridge_state.persona
    for attribute in ("profile_id", "persona_id", "id", "name"):
        value = str(getattr(persona, attribute, "") or "").strip()
        if value:
            return value
    return "default"


def _active_persona_scope() -> dict[str, Any]:
    try:
        from src.persona.identity import GLOBAL_PERSONA_EPOCH

        token = GLOBAL_PERSONA_EPOCH.token()
        return {
            "persona_id": token.persona_id,
            "persona_epoch": token.epoch,
            "persona_fingerprint": token.fingerprint,
        }
    except RuntimeError:
        return {
            "persona_id": _active_persona_id(),
            "persona_epoch": int(getattr(bridge_state, "persona_epoch", 0) or 0),
            "persona_fingerprint": "",
        }


def _model_fingerprint() -> str:
    llm = getattr(getattr(bridge_state, "settings", None), "llm", None)
    material = "\0".join(
        str(getattr(llm, attribute, "") or "")
        for attribute in ("provider", "model", "base_url")
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def _chat_scope_is_current(item: dict[str, Any]) -> bool:
    active_scope = _active_persona_scope()
    persona_id = str(item.get("persona_id") or "")
    if not persona_id or persona_id != active_scope["persona_id"]:
        return False
    try:
        persona_epoch = int(item.get("persona_epoch") or 0)
        model_epoch = int(item.get("model_epoch"))
    except (TypeError, ValueError):
        return False
    if persona_epoch <= 0 or persona_epoch != int(active_scope["persona_epoch"]):
        return False
    persona_fingerprint = str(item.get("persona_fingerprint") or "")
    if not persona_fingerprint or not hmac.compare_digest(
        persona_fingerprint,
        str(active_scope["persona_fingerprint"]),
    ):
        return False
    if model_epoch != int(getattr(bridge_state, "model_epoch", 0) or 0):
        return False
    fingerprint = str(item.get("model_fingerprint") or "")
    return bool(fingerprint) and hmac.compare_digest(fingerprint, _model_fingerprint())


async def _emit_chat_event(client_id: str, msg_type: str, payload: dict[str, Any]) -> bool:
    """Deliver only to the authenticated controller that owns the request."""
    targets = [
        (ws, context)
        for ws, context in tuple(_client_contexts.items())
        if context.authenticated and context.client_id == client_id and ws in _connections
    ]
    if not targets:
        return False
    delivered = False
    for ws, context in targets:
        if context.protocol_version >= 4:
            delivered = await send_to_frontend(ws, msg_type, payload) or delivered
            continue
        # Compatibility is a per-connection projection, never a second source
        # of truth.  A v2 client therefore never receives duplicate legacy state.
        if msg_type == MsgType.CHAT_STATE:
            state = str(payload.get("state") or "")
            legacy_status = {
                "queued": "waiting",
                "generating": "thinking",
                "ready_waiting": "ready",
                "delivering": "typing",
            }.get(state, state)
            delivered = await send_to_frontend(
                ws,
                MsgType.CHAT_TYPING,
                {**payload, "status": legacy_status},
            ) or delivered
        else:
            delivered = await send_to_frontend(ws, msg_type, payload) or delivered
    return delivered


def _get_chat_coordinator():
    global _chat_coordinator
    if _chat_coordinator is None:
        from src.chat.delivery import ChatDeliveryCoordinator

        _chat_coordinator = ChatDeliveryCoordinator(
            store=_get_pending_chat_store(),
            get_session=lambda: bridge_state.session,
            emit=_emit_chat_event,
            scope_is_current=_chat_scope_is_current,
            kernel_store=bridge_state.kernel_store,
        )
    return _chat_coordinator


# ── 消息处理器 ────────────────────────────────────────

@register_handler(MsgType.CHAT_HISTORY)
async def handle_chat_history(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Read authoritative, persona-scoped chat history from the kernel."""
    store = bridge_state.kernel_store
    if store is None:
        return {
            "items": [],
            "has_more": False,
            "next_cursor": None,
            "error": "authoritative chat ledger is unavailable",
        }
    conversation_id = str(payload.get("conversation_id") or "dream-room")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", conversation_id):
        raise ValueError("invalid conversation_id")
    try:
        limit = int(payload.get("limit") or 300)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid chat history limit") from exc
    before_sequence = None
    raw_cursor = payload.get("before")
    if raw_cursor is not None:
        if not isinstance(raw_cursor, dict):
            raise ValueError("invalid chat history cursor")
        raw_sequence = raw_cursor.get("sequence")
        if isinstance(raw_sequence, bool):
            raise ValueError("invalid chat history cursor")
        try:
            before_sequence = int(raw_sequence)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid chat history cursor") from exc
        if before_sequence < 1:
            raise ValueError("invalid chat history cursor")
    persona_scope = _active_persona_scope()
    page = store.message_page(
        conversation_id,
        limit=limit,
        before_sequence=before_sequence,
        persona_id=str(persona_scope["persona_id"]),
    )
    committed_request_ids = {
        str(item.get("request_id") or "") for item in page["items"]
    }
    items = [
        {
            "id": item["message_id"],
            "role": item["role"],
            "content": item["content"],
            "request_id": item["request_id"],
            "conversation_id": conversation_id,
            "persona_id": persona_scope["persona_id"],
            "created_at_utc": item["created_at_utc"],
            "timestamp_status": "known",
            "source": item["role"],
            "delivery_state": item["delivery_state"],
            "bubble_index": item["bubble_index"],
        }
        for item in page["items"]
    ]
    if before_sequence is None:
        for pending in _get_pending_chat_store().list_active():
            request_id = str(pending.get("request_id") or "")
            if (
                request_id in committed_request_ids
                or str(pending.get("conversation_id") or "") != conversation_id
                or str(pending.get("persona_id") or "") != persona_scope["persona_id"]
            ):
                continue
            items.append(
                {
                    "id": f"pending_user_{request_id}",
                    "role": "user",
                    "content": str(pending.get("text") or ""),
                    "request_id": request_id,
                    "conversation_id": conversation_id,
                    "persona_id": persona_scope["persona_id"],
                    "created_at_utc": str(pending.get("created_at_utc") or ""),
                    "timestamp_status": "known",
                    "source": str(pending.get("source") or "user"),
                    "delivery_state": str(pending.get("state") or "queued"),
                    "bubble_index": 0,
                }
            )
    items.sort(key=lambda item: (item["created_at_utc"], item["id"]))
    return {**page, "items": items}


@register_handler(MsgType.CHAT_SEND)
async def handle_chat_send(payload: dict, ws: WebSocketServerProtocol) -> dict | None:
    """Accept a scoped request and return immediately; generation runs in a Task."""
    context = _client_contexts.get(ws)
    if not context or not context.authenticated:
        return {"error": "bridge authentication required"}
    if bridge_state.persona_restart_required:
        await send_to_frontend(
            ws,
            MsgType.ERROR,
            {
                "message": "Persona changed; restart Reverie before sending another message",
                "request_id": str((payload or {}).get("request_id") or ""),
                "scope": "chat",
                "code": "persona_restart_required",
            },
        )
        return None
    request_payload = dict(payload or {})
    if not request_payload.get("conversation_id"):
        request_payload["conversation_id"] = context.conversation_id or "default"
    if not request_payload.get("persona_id"):
        request_payload["persona_id"] = context.persona_id or _active_persona_id()
    persona_scope = _active_persona_scope()
    # Renderer scope fields are descriptive only.  The authenticated process
    # stamps the authoritative identity generation before persistence.
    request_payload["persona_id"] = persona_scope["persona_id"]
    request_payload["persona_epoch"] = persona_scope["persona_epoch"]
    request_payload["persona_fingerprint"] = persona_scope["persona_fingerprint"]
    request_payload.setdefault("model_epoch", int(getattr(bridge_state, "model_epoch", 0) or 0))
    request_payload.setdefault("model_fingerprint", _model_fingerprint())
    try:
        await _get_chat_coordinator().accept(request_payload, client_id=context.client_id)
        text = str(request_payload.get("text") or "")
        if bridge_state.proactive and hasattr(bridge_state.proactive, "mark_user_replied"):
            try:
                bridge_state.proactive.mark_user_replied(text)
            except TypeError:
                bridge_state.proactive.mark_user_replied()
    except Exception as exc:
        logger.warning("Chat request rejected: %s", exc)
        await send_to_frontend(
            ws,
            MsgType.ERROR,
            {
                "message": str(exc),
                "request_id": request_payload.get("request_id"),
                "scope": "chat",
            },
        )
    return None


@register_handler(MsgType.CHAT_CANCEL)
async def handle_chat_cancel(payload: dict, ws: WebSocketServerProtocol) -> dict | None:
    context = _client_contexts.get(ws)
    if not context or not context.authenticated:
        return {"error": "bridge authentication required"}
    request_id = str(payload.get("request_id") or "")
    await _get_chat_coordinator().cancel(request_id, client_id=context.client_id)
    return None


@register_handler(MsgType.CHAT_STOP)
async def handle_chat_stop(payload: dict, ws: WebSocketServerProtocol) -> dict | None:
    """Legacy alias: it may cancel only this controller's explicitly named request."""
    if not payload.get("request_id"):
        await send_to_frontend(
            ws,
            MsgType.ERROR,
            {"message": "chat:stop requires request_id; global cancellation is forbidden"},
        )
        return None
    return await handle_chat_cancel(payload, ws)


@register_handler(MsgType.CHAT_REVEAL)
async def handle_chat_reveal(payload: dict, ws: WebSocketServerProtocol) -> dict | None:
    context = _client_contexts.get(ws)
    if not context or not context.authenticated:
        return {"error": "bridge authentication required"}
    await _get_chat_coordinator().reveal(
        str(payload.get("request_id") or ""),
        client_id=context.client_id,
    )
    return None


async def _apply_local_mode(active: bool, *, epoch: int, session_id: str) -> dict[str, Any]:
    """Close the gate first, then cancel and discard work without catch-up."""
    from src.local_mode import get_local_mode_gate

    gate = get_local_mode_gate()
    snapshot = gate.set(bool(active), session_id=session_id, epoch=epoch)
    cancelled: list[dict[str, Any]] = []
    discarded_proactive = 0
    if snapshot.enabled:
        cancelled = await _get_chat_coordinator().cancel_all(reason="local_mode")
        proactive = bridge_state.proactive
        if proactive and hasattr(proactive, "drain_pending"):
            try:
                discarded_proactive = len(list(proactive.drain_pending()))
            except Exception:
                logger.exception("Could not discard proactive queue during local mode")
    return {
        "ok": True,
        **snapshot.to_dict(),
        "cancelled_requests": len(cancelled),
        "discarded_proactive": discarded_proactive,
    }


@register_handler(MsgType.LOCAL_MODE_SET)
async def handle_local_mode_set(payload: dict, ws: WebSocketServerProtocol) -> dict | None:
    """Apply Electron's persisted epoch before acknowledging Focus startup."""
    context = _client_contexts.get(ws)
    if not context or not context.authenticated or ws is not _controller_ws:
        return {"error": "authenticated controller required"}
    active_value = payload.get("enabled", payload.get("active"))
    if not isinstance(active_value, bool):
        return {"error": "enabled must be a boolean"}
    try:
        epoch = int(payload.get("epoch"))
    except (TypeError, ValueError):
        return {"error": "epoch must be an integer"}
    session_id = str(payload.get("session_id", payload.get("sessionId")) or "")
    if len(session_id) > 160 or any(ord(char) < 32 for char in session_id):
        return {"error": "invalid session_id"}

    try:
        result = await _apply_local_mode(bool(active_value), epoch=epoch, session_id=session_id)
    except ValueError as exc:
        from src.local_mode import get_local_mode_gate

        gate = get_local_mode_gate()
        await send_to_frontend(
            ws,
            MsgType.LOCAL_MODE_STATE,
            {"ok": False, "error": str(exc), **gate.snapshot().to_dict()},
        )
        return None
    await send_to_frontend(ws, MsgType.LOCAL_MODE_STATE, result)
    return None


def _ai_usage_snapshot() -> dict[str, Any]:
    from src.config.usage_policy import FEATURE_DESCRIPTIONS, get_usage_policy

    policy = getattr(bridge_state.adapter, "usage_policy", None) or get_usage_policy()
    snapshot = policy.snapshot()
    for feature, item in snapshot.items():
        description = FEATURE_DESCRIPTIONS[feature]
        provider = str(item.get("current_provider") or "")
        origin = str(item.get("current_origin") or "")
        item["consent_digest"] = hashlib.sha256(
            f"{feature}\0{description}\0{provider}\0{origin}".encode("utf-8")
        ).hexdigest()
    return {
        "schema": "reverie.ai-usage-consent.v2",
        "features": snapshot,
        "default": "denied",
    }


def _require_usage_controller(ws: WebSocketServerProtocol) -> None:
    context = _client_contexts.get(ws)
    if not context or not context.authenticated or ws is not _controller_ws:
        raise PermissionError("authenticated controller required")


@register_handler(MsgType.AI_USAGE_GET)
async def handle_ai_usage_get(_payload: dict, ws: WebSocketServerProtocol) -> dict:
    _require_usage_controller(ws)
    return _ai_usage_snapshot()


@register_handler(MsgType.AI_USAGE_GRANT)
async def handle_ai_usage_grant(payload: dict, ws: WebSocketServerProtocol) -> dict:
    """Accept only a current, explicit, cost-aware per-feature grant."""
    _require_usage_controller(ws)
    from src.config.usage_policy import FEATURE_DESCRIPTIONS, get_usage_policy

    feature = str(payload.get("feature") or "")
    description = FEATURE_DESCRIPTIONS.get(feature)
    if description is None:
        raise ValueError("unknown AI usage feature")
    current = _ai_usage_snapshot()["features"][feature]
    expected_digest = str(current["consent_digest"])
    if not hmac.compare_digest(str(payload.get("consent_digest") or ""), expected_digest):
        raise ValueError("AI usage disclosure changed; review the current description")
    if payload.get("api_cost_acknowledged") is not True or payload.get("user_confirmed") is not True:
        raise ValueError("explicit API-cost acknowledgement is required")
    policy = getattr(bridge_state.adapter, "usage_policy", None) or get_usage_policy()
    policy.grant(feature)
    return _ai_usage_snapshot()


@register_handler(MsgType.AI_USAGE_REVOKE)
async def handle_ai_usage_revoke(payload: dict, ws: WebSocketServerProtocol) -> dict:
    _require_usage_controller(ws)
    from src.config.usage_policy import FEATURE_DESCRIPTIONS, get_usage_policy

    feature = str(payload.get("feature") or "")
    if feature not in FEATURE_DESCRIPTIONS:
        raise ValueError("unknown AI usage feature")
    policy = getattr(bridge_state.adapter, "usage_policy", None) or get_usage_policy()
    cancelled = policy.revoke(feature)
    result = _ai_usage_snapshot()
    result["cancelled_in_flight"] = cancelled
    return result


@register_handler(MsgType.MEMORY_QUERY)
async def handle_memory_query(payload: dict, ws: WebSocketServerProtocol) -> dict:
    """语义搜索记忆。"""
    if not bridge_state.memory:
        return {"memories": [], "error": "记忆系统未初始化"}
    query = payload.get("query", "")
    top_k = payload.get("top_k", 10)
    results = bridge_state.memory.search(query, k=top_k)
    return {"memories": results}


@register_handler(MsgType.MEMORY_LIST)
async def handle_memory_list(
    payload: dict,
    ws: WebSocketServerProtocol,
) -> dict:
    _require_memory_controller(ws)
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized", "memories": []}
    memories = bridge_state.memory.list_confirmed_memories(
        limit=int(payload.get("limit") or 100),
    )
    return {"ok": True, "memories": memories}


@register_handler(MsgType.MEMORY_EDIT)
async def handle_memory_edit(
    payload: dict,
    ws: WebSocketServerProtocol,
) -> dict:
    _require_memory_controller(ws)
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized"}
    result = bridge_state.memory.correct_confirmed_memory(
        str(payload.get("memory_id") or ""),
        str(payload.get("text") or ""),
    )
    return {"ok": True, **result}


@register_handler(MsgType.MEMORY_DELETE)
async def handle_memory_delete(
    payload: dict,
    ws: WebSocketServerProtocol,
) -> dict:
    _require_memory_controller(ws)
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized"}
    return {
        "ok": True,
        **bridge_state.memory.delete_confirmed_memory(
            str(payload.get("memory_id") or ""),
        ),
    }


@register_handler(MsgType.MEMORY_SETTINGS_GET)
async def handle_memory_settings_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Return the running memory configuration."""
    if bridge_state.memory and hasattr(bridge_state.memory, "settings_snapshot"):
        return {"settings": bridge_state.memory.settings_snapshot()}
    if bridge_state.settings:
        memory = bridge_state.settings.memory
        features = bridge_state.settings.features
        return {
            "settings": {
                "embedding_model": memory.embedding_model,
                "vector_quantization": memory.vector_quantization,
                "vector_partitioning_enabled": memory.vector_partitioning_enabled,
                "retention_days": memory.retention_days,
                "forgetting_enabled": memory.forgetting_enabled,
                "long_term_forgetting_enabled": memory.long_term_forgetting_enabled,
                "short_term_forgetting_enabled": memory.short_term_forgetting_enabled,
                "long_term_forget_days": memory.long_term_forget_days,
                "short_term_forget_days": memory.short_term_forget_days,
                "long_term_forget_probability": memory.long_term_forget_probability,
                "short_term_forget_probability": memory.short_term_forget_probability,
                "decay_lambda": memory.decay_lambda,
                "recall_reinforcement_alpha": memory.recall_reinforcement_alpha,
                "minimum_retrieval_retention": memory.minimum_retrieval_retention,
                "misremembering_enabled": memory.misremembering_enabled,
                "misremember_probability": memory.misremember_probability,
                "long_term_misremembering_enabled": memory.long_term_misremembering_enabled,
                "short_term_misremembering_enabled": memory.short_term_misremembering_enabled,
                "long_term_misremember_probability": memory.long_term_misremember_probability,
                "short_term_misremember_probability": memory.short_term_misremember_probability,
                "autonomous_memory_enabled": features.autonomous_memory_enabled,
                "autonomous_memory_llm_enabled": features.autonomous_memory_llm_enabled,
                "self_growth_enabled": features.self_growth_enabled,
                "self_growth_from_web_enabled": False,
                "self_growth_from_memory_enabled": features.self_growth_from_memory_enabled,
                "self_growth_interval_days": features.self_growth_interval_days,
                "vector_store": "SQLite 事实库 + sqlite-vec 可重建索引",
            }
        }
    return {"settings": None, "error": "Settings are not initialized"}


@register_handler(MsgType.MEMORY_STORE)
async def handle_memory_store(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Store a user-selected chat record in long-term or short-term memory."""
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized"}
    text = str(payload.get("text", "")).strip()
    layer = str(payload.get("layer", "long_term")).strip()
    if layer not in {"long_term", "short_term", "permanent"}:
        return {"ok": False, "error": f"Unsupported memory layer: {layer}"}
    if not text:
        return {"ok": False, "error": "Memory text is empty"}
    try:
        if hasattr(bridge_state.memory, "store_manual_memory"):
            memory_id = bridge_state.memory.store_manual_memory(text, layer)
        else:
            memory_id = bridge_state.memory.store_fact(f"Manual memory: {text}", layer=layer)
        return {"ok": True, "id": memory_id, "layer": layer}
    except Exception as exc:
        logger.exception("Manual memory store failed")
        return {"ok": False, "error": str(exc), "layer": layer}


def _require_memory_controller(ws: WebSocketServerProtocol) -> None:
    context = _client_contexts.get(ws)
    if not context or not context.authenticated or ws is not _controller_ws:
        raise PermissionError("authenticated controller required")


@register_handler(MsgType.MEMORY_CANDIDATE_LIST)
async def handle_memory_candidate_list(
    payload: dict,
    ws: WebSocketServerProtocol,
) -> dict:
    _require_memory_controller(ws)
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized", "candidates": []}
    status = str(payload.get("status") or "pending")
    limit = max(1, min(200, int(payload.get("limit") or 100)))
    candidates = bridge_state.memory.list_memory_candidates(status=status, limit=limit)
    return {"ok": True, "status": status, "candidates": candidates}


@register_handler(MsgType.MEMORY_CANDIDATE_CONFIRM)
async def handle_memory_candidate_confirm(
    payload: dict,
    ws: WebSocketServerProtocol,
) -> dict:
    _require_memory_controller(ws)
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized"}
    candidate_id = str(payload.get("candidate_id") or "")
    if not re.fullmatch(r"mc_[a-f0-9]{32}", candidate_id):
        raise ValueError("invalid memory candidate id")
    result = bridge_state.memory.confirm_memory_candidate(candidate_id)
    return {"ok": True, **result}


@register_handler(MsgType.MEMORY_CANDIDATE_REJECT)
async def handle_memory_candidate_reject(
    payload: dict,
    ws: WebSocketServerProtocol,
) -> dict:
    _require_memory_controller(ws)
    if not bridge_state.memory:
        return {"ok": False, "error": "Memory system is not initialized"}
    candidate_id = str(payload.get("candidate_id") or "")
    if not re.fullmatch(r"mc_[a-f0-9]{32}", candidate_id):
        raise ValueError("invalid memory candidate id")
    candidate = bridge_state.memory.reject_memory_candidate(candidate_id)
    return {"ok": True, "candidate": candidate}


@register_handler(MsgType.EMOTION_GET)
async def handle_emotion_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """获取当前情绪状态。"""
    if not bridge_state.emotion:
        return {"emotions": {}, "error": "情绪系统未初始化"}
    return {
        "emotions": dict(bridge_state.emotion.values),
        "mood": bridge_state.emotion.get_mood_label(),
        "dominant": [
            {"name": name, "value": value}
            for name, value in bridge_state.emotion.get_dominant(4)
        ],
        "intensity": bridge_state.emotion.get_intensity(),
    }


@register_handler(MsgType.PERSONA_GET)
async def handle_persona_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """获取角色人设。"""
    if not bridge_state.persona:
        return {"persona": None, "error": "人设未加载"}
    scope = _active_persona_scope()
    return {
        "persona": bridge_state.persona.to_dict(),
        **scope,
        "restart_required": bool(bridge_state.persona_restart_required),
    }


@register_handler(MsgType.PERSONA_IMPORT)
async def handle_persona_import(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Strictly validate and persist an untrusted SillyTavern JSON card."""
    from src.config.settings import PERSONA_DIR
    from src.persona.sillytavern_import import (
        CharacterCardImportError,
        parse_sillytavern_json,
        save_imported_persona,
    )

    raw = payload.get("json")
    filename = str(payload.get("filename", "character.json"))
    if not isinstance(raw, str):
        return {"ok": False, "error": "角色卡内容必须是 JSON 文本", "code": "invalid_payload"}
    try:
        report = parse_sillytavern_json(raw, filename=filename)
        result = save_imported_persona(report, PERSONA_DIR, activate=False)
        return {
            "ok": True,
            **result,
            "persona": report.persona.to_dict(),
            "first_message": report.metadata.get("first_message", ""),
            "creator_notes": report.metadata.get("creator_notes", ""),
        }
    except CharacterCardImportError as exc:
        return {"ok": False, "error": str(exc), "code": exc.code}
    except Exception:
        logger.exception("SillyTavern character import failed")
        return {"ok": False, "error": "角色卡导入失败，未写入任何档案", "code": "internal_error"}


@register_handler(MsgType.PERSONA_LIST)
async def handle_persona_list(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    from src.config.settings import PERSONA_DIR
    from src.persona.sillytavern_import import list_imported_personas

    return {"ok": True, **list_imported_personas(PERSONA_DIR)}




@register_handler(MsgType.PERSONA_ACTIVATE)
async def handle_persona_activate(payload: dict, ws: WebSocketServerProtocol) -> dict:
    """Commit an explicitly confirmed identity switch before changing epoch."""

    from src.config.settings import PERSONA_DIR
    from src.persona.identity import (
        GLOBAL_PERSONA_EPOCH,
        PersonaIdentityViolation,
    )
    from src.persona.sillytavern_import import (
        CharacterCardImportError,
        activate_imported_persona,
        load_imported_persona,
    )

    context = _client_contexts.get(ws)
    if not context or not context.authenticated or ws is not _controller_ws:
        return {
            "ok": False,
            "error": "authenticated controller required",
            "code": "forbidden",
        }
    profile_id = str(payload.get("profile_id") or "").strip()
    if (
        payload.get("identity_change_confirmed") is not True
        or str(payload.get("confirmed_profile_id") or "") != profile_id
    ):
        return {
            "ok": False,
            "error": "Identity change requires explicit confirmation of the selected profile",
            "code": "identity_confirmation_required",
        }
    actor = str(payload.get("actor") or "")
    reason = str(payload.get("reason") or "").strip()
    if actor not in {"owner", "local_admin"} or len(reason) < 3:
        return {
            "ok": False,
            "error": "Identity change requires an owner/admin audit reason",
            "code": "identity_authorization_required",
        }

    active = _active_persona_scope()
    try:
        expected_epoch = int(payload.get("expected_persona_epoch"))
    except (TypeError, ValueError):
        expected_epoch = -1
    expected_id = str(payload.get("expected_persona_id") or "")
    expected_fingerprint = str(payload.get("expected_persona_fingerprint") or "")
    if (
        expected_id != str(active["persona_id"])
        or expected_epoch != int(active["persona_epoch"])
        or not expected_fingerprint
        or not hmac.compare_digest(
            expected_fingerprint,
            str(active["persona_fingerprint"]),
        )
    ):
        return {
            "ok": False,
            "error": "Persona changed after the confirmation view was shown",
            "code": "identity_conflict",
            "conflict": True,
            **active,
        }

    try:
        candidate = load_imported_persona(PERSONA_DIR, profile_id)
        candidate_fingerprint = candidate.identity_envelope.fingerprint
        async with _persona_effect_lock:
            linearized_active = _active_persona_scope()
            if (
                expected_id != str(linearized_active["persona_id"])
                or expected_epoch != int(linearized_active["persona_epoch"])
                or not hmac.compare_digest(
                    expected_fingerprint,
                    str(linearized_active["persona_fingerprint"]),
                )
            ):
                return {
                    "ok": False,
                    "error": "Persona changed while this activation was waiting to commit",
                    "code": "identity_conflict",
                    "conflict": True,
                    **linearized_active,
                }
            authorization = GLOBAL_PERSONA_EPOCH.authorize_update(
                actor=actor,
                reason=reason,
                user_confirmed=True,
            )
            token, result = GLOBAL_PERSONA_EPOCH.activate_update_with_commit(
                candidate,
                authorization,
                lambda: activate_imported_persona(
                    PERSONA_DIR,
                    profile_id,
                    expected_fingerprint=candidate_fingerprint,
                ),
            )
            # Epoch invalidation happens before stopping/draining.  A provider
            # task that ignores cancellation still cannot queue its old result.
            bridge_state.persona_epoch = token.epoch
            bridge_state.model_epoch = int(bridge_state.model_epoch or 0) + 1
            bridge_state.persona_restart_required = True
            proactive = bridge_state.proactive
            if proactive:
                try:
                    if hasattr(proactive, "stop"):
                        proactive.stop()
                    if hasattr(proactive, "drain_pending"):
                        proactive.drain_pending()
                except Exception:
                    logger.exception("Identity changed but proactive shutdown degraded")
            work_manager = bridge_state.work_manager
            if work_manager and hasattr(work_manager, "stop"):
                try:
                    work_manager.stop()
                except Exception:
                    logger.exception("Identity changed but background work shutdown degraded")
    except CharacterCardImportError as exc:
        return {"ok": False, "error": str(exc), "code": exc.code}
    except (PermissionError, PersonaIdentityViolation, ValueError) as exc:
        return {"ok": False, "error": str(exc), "code": "identity_update_rejected"}
    except Exception:
        logger.exception("Privileged persona activation failed")
        return {"ok": False, "error": "Persona activation failed", "code": "internal_error"}

    # The identity token changes synchronously before the event loop can emit
    # an old reply.  New chat is then blocked until every runtime subsystem is
    # reconstructed around the new persona on process restart.
    cancellation_warning = ""
    try:
        await _get_chat_coordinator().cancel_all(reason="persona_changed")
    except Exception as exc:
        logger.exception("Identity changed but pending chat cancellation failed")
        cancellation_warning = f"pending chat cancellation degraded: {type(exc).__name__}"
    return {
        **result,
        "ok": True,
        "persona_id": token.persona_id,
        "persona_epoch": token.epoch,
        "persona_fingerprint": token.fingerprint,
        "restart_required": True,
        **({"warning": cancellation_warning} if cancellation_warning else {}),
    }


@register_handler(MsgType.RELATIONSHIP_GET)
async def handle_relationship_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """获取关系状态。"""
    if not bridge_state.relationship:
        return {"intimacy": 0, "error": "关系系统未初始化"}
    if hasattr(bridge_state.relationship, "snapshot"):
        return bridge_state.relationship.snapshot()
    return {
        "intimacy": bridge_state.relationship.intimacy,
        "stage": bridge_state.relationship.stage,
    }


@register_handler(MsgType.IMAGE_RANDOM)
async def handle_image_random(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """获取随机图片（SFW/NSFW/随机）。"""
    mode = payload.get("mode", "sfw")  # sfw | nsfw | random
    if not bridge_state.image_service:
        return {"url": None, "error": "图片服务未初始化"}
    from src.config.usage_policy import UsagePolicyDenied, get_usage_policy
    from src.local_mode import LocalModeBlocked, get_local_mode_gate

    policy = get_usage_policy()
    lease = None
    try:
        get_local_mode_gate().require_remote("image service")
        lease = policy.begin("image_generation")
        result = await bridge_state.image_service.get_random(mode)
        policy.validate(lease)
        return {"url": result.get("url"), "mode": mode}
    except (UsagePolicyDenied, LocalModeBlocked) as exc:
        return {"url": None, "error": str(exc), "code": "consent_required"}
    except Exception as e:
        logger.exception("随机图片获取失败")
        return {"url": None, "error": str(e)}
    finally:
        if lease is not None:
            policy.finish(lease)


@register_handler(MsgType.TTS_LIST)
async def handle_tts_list(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """枚举可用 TTS 提供方与当前选择/可用状态。"""
    from src.tts import registered_providers

    settings = bridge_state.settings.tts if bridge_state.settings else None
    providers = [
        {
            "key": provider.key,
            "label": provider.label,
            "kind": provider.kind,
            "voices": list(provider.voice_options),
        }
        for provider in registered_providers()
    ]
    active = settings.provider if settings else None
    return {
        "providers": providers,
        "active": active,
        "enabled": bool(settings and settings.enabled),
        "voice": settings.voice if settings else "",
        "configured": bool(settings and settings.resolved_api_key),
    }


@register_handler(MsgType.TTS_SYNTHESIZE)
async def handle_tts_synthesize(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """将文本合成为有序音频片段（并发合成、按句序返回）。"""
    text = str(payload.get("text") or "").strip()
    if not text:
        return {"error": "文本不能为空"}
    if len(text) > 5000:
        text = text[:5000]
    if not bridge_state.settings:
        return {"error": "设置系统未初始化"}
    from src.tts import TTSUnavailableError, build_selected, synthesize_ordered

    tts_settings = bridge_state.settings.tts
    if not tts_settings.enabled:
        return {"error": "语音合成未启用", "code": "tts_disabled"}
    if not tts_settings.resolved_api_key:
        return {"error": "所选语音提供方未配置 API 密钥", "code": "tts_not_configured"}
    voice = str(payload.get("voice") or tts_settings.voice or "").strip()
    settings = {
        "provider": tts_settings.provider,
        "api_key": tts_settings.resolved_api_key,
        "model": tts_settings.model,
        "voice": voice,
        "timeout": 60.0,
    }
    try:
        synthesize = build_selected(settings)
        if synthesize is None:
            return {"error": f"未知语音提供方: {tts_settings.provider}"}
        audio_parts = await synthesize_ordered(synthesize, text, voice)
        if not audio_parts:
            return {"error": "语音合成未产生音频"}
        return {
            "parts": [
                {"audio": base64.b64encode(part).decode("ascii"), "index": i}
                for i, part in enumerate(audio_parts)
            ],
            "provider": tts_settings.provider,
            "voice": voice,
            "count": len(audio_parts),
        }
    except TTSUnavailableError as exc:
        return {"error": str(exc), "code": "tts_unavailable"}
    except Exception as exc:
        logger.exception("TTS 合成失败")
        return {"error": str(exc), "code": "tts_failed"}


@register_handler(MsgType.DIARY_REQUEST)
async def handle_diary_request(payload: dict, ws: WebSocketServerProtocol) -> dict:
    """获取日记列表。"""
    if not bridge_state.diary:
        return {"entries": [], "error": "日记系统未初始化"}
    try:
        scheduler = getattr(bridge_state.session, "scheduler", None)
        proactive = bridge_state.proactive
        work_manager = bridge_state.work_manager
        late_night_active = getattr(
            work_manager,
            "late_night_active",
            getattr(proactive, "late_night_active", False),
        )
        action = str(payload.get("action", "list"))
        if action == "unlock_key":
            if not bridge_state.diary_keys:
                return {"ok": False, "error": "日记钥匙系统未初始化"}
            try:
                return bridge_state.diary_keys.unlock(str(payload.get("date", "")))
            except (ValueError, PermissionError) as exc:
                return {"ok": False, "error": str(exc)}
        if action == "read":
            if bridge_state.diary_keys:
                try:
                    return bridge_state.diary_keys.read(
                        str(payload.get("date", "")),
                        status=getattr(scheduler, "status", "online"),
                        late_night_active=late_night_active,
                    )
                except (ValueError, PermissionError) as exc:
                    return {"ok": False, "error": str(exc)}
            return {"ok": False, "error": "日记读取系统未初始化"}
        entries = bridge_state.diary.list_entries_with_metadata(
            status=getattr(scheduler, "status", "online"),
            late_night_active=late_night_active,
        )
        if bridge_state.diary_keys:
            entries = bridge_state.diary_keys.decorate_entries(entries)
        return {
            "entries": entries or [],
            "writing": bool(getattr(work_manager, "diary_writing", False)),
        }
    except Exception as exc:
        logger.exception("日记请求失败")
        return {"entries": [], "error": str(exc)}


@register_handler(MsgType.TIMELINE_REQUEST)
async def handle_timeline_request(payload: dict, ws: WebSocketServerProtocol) -> dict:
    """获取时间线/朋友圈。"""
    if not bridge_state.timeline:
        return {"posts": [], "error": "时间线未初始化"}
    try:
        posts = [post.to_dict() for post in bridge_state.timeline.get_recent(20)]
        if bridge_state.social_universe:
            for post in posts:
                post["comments"] = bridge_state.social_universe.comments_for_post(
                    str(post.get("id", ""))
                )
        return {"posts": posts}
    except Exception as exc:
        logger.exception("时间线请求失败")
        return {"posts": [], "error": str(exc)}


@register_handler(MsgType.AMBIENT_GET)
async def handle_ambient_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Return renderer-safe local life traces and delayed-fragment counts."""
    if not bridge_state.ambient_presence:
        return {"book_page": 12, "book_total": 320, "traces": [], "pending_thoughts": 0}
    try:
        result = bridge_state.ambient_presence.snapshot()
        result["pending_thoughts"] = (
            bridge_state.thought_engine.pending_count()
            if bridge_state.thought_engine else 0
        )
        return result
    except Exception as exc:
        logger.exception("环境陪伴状态读取失败")
        return {"book_page": 12, "book_total": 320, "traces": [], "error": str(exc)}


@register_handler(MsgType.API_BUDGET_GET)
async def handle_api_budget_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    if not bridge_state.api_budget:
        return {"tracking_enabled": False, "error": "API 预算账本未初始化"}
    try:
        return bridge_state.api_budget.snapshot()
    except Exception as exc:
        logger.exception("API 预算账本读取失败")
        return {"tracking_enabled": False, "error": str(exc)}


@register_handler(MsgType.GROUP_REQUEST)
async def handle_group_request(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    if not bridge_state.social_universe:
        return {"threads": [], "characters": [], "error": "本地角色世界未初始化"}
    try:
        return bridge_state.social_universe.list_state()
    except Exception as exc:
        logger.exception("群聊状态读取失败")
        return {"threads": [], "characters": [], "error": str(exc)}


@register_handler(MsgType.GROUP_SEND)
async def handle_group_send(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    if not bridge_state.social_universe:
        return {"threads": [], "characters": [], "error": "本地角色世界未初始化"}
    text = str(payload.get("text", "")).strip()
    if not text:
        return {"threads": [], "characters": [], "error": "群聊消息不能为空"}
    try:
        return await bridge_state.social_universe.send_user_message(
            text,
            thread_id=str(payload.get("thread_id", "local-friends")),
            user_name=str(payload.get("user_name", "你")),
        )
    except Exception as exc:
        logger.exception("群聊消息处理失败")
        return {**bridge_state.social_universe.list_state(), "error": str(exc)}


@register_handler(MsgType.USER_PROFILE_GET)
async def handle_user_profile_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """获取用户档案与最近情感记忆。"""
    if not bridge_state.user_mgr:
        return {"profile": None, "emotional_memories": [], "error": "用户档案系统未初始化"}
    return {
        "profile": bridge_state.user_mgr.profile.to_dict(),
        "emotional_memories": [
            memory.to_dict()
            for memory in bridge_state.user_mgr.get_recent_emotional_memories(20)
        ],
    }


@register_handler(MsgType.USER_PROFILE_UPDATE)
async def handle_user_profile_update(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """保存用户档案并同步到长期记忆。"""
    if not bridge_state.user_mgr:
        return {"profile": None, "emotional_memories": [], "error": "用户档案系统未初始化"}
    try:
        profile_payload = payload.get("profile", payload)
        if not isinstance(profile_payload, dict):
            return {"profile": bridge_state.user_mgr.profile.to_dict(), "error": "用户档案格式无效"}
        profile = bridge_state.user_mgr.update_profile(profile_payload)
        if bridge_state.memory and hasattr(bridge_state.memory, "sync_user_profile"):
            bridge_state.memory.sync_user_profile(bridge_state.user_mgr)
        return {
            "profile": profile.to_dict(),
            "emotional_memories": [
                memory.to_dict()
                for memory in bridge_state.user_mgr.get_recent_emotional_memories(20)
            ],
        }
    except Exception as exc:
        logger.exception("用户档案更新失败")
        return {
            "profile": bridge_state.user_mgr.profile.to_dict(),
            "emotional_memories": [
                memory.to_dict()
                for memory in bridge_state.user_mgr.get_recent_emotional_memories(20)
            ],
            "error": str(exc),
        }


def _module_status_payload(status: Any) -> dict[str, Any]:
    state = getattr(status, "state", "")
    return {
        "module_id": str(getattr(status, "module_id", "")),
        "state": str(getattr(state, "value", state)),
        "failures": int(getattr(status, "failures", 0) or 0),
        "last_error_code": str(getattr(status, "last_error_code", "") or ""),
        "last_error_at_utc": str(getattr(status, "last_error_at_utc", "") or ""),
        "details": dict(getattr(status, "details", {}) or {}),
    }


@register_handler(MsgType.MODULE_LIST)
async def handle_module_list(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    registry = bridge_state.module_registry
    if registry is None:
        return {
            "ok": False,
            "code": "module_registry_unavailable",
            "modules": [],
            "error": "Module health registry is unavailable",
        }
    return {
        "ok": True,
        "modules": [_module_status_payload(status) for status in registry.statuses()],
    }


@register_handler(MsgType.MODULE_CONTROL)
async def handle_module_control(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    registry = bridge_state.module_registry
    if registry is None:
        return {
            "ok": False,
            "code": "module_registry_unavailable",
            "modules": [],
            "error": "Module health registry is unavailable",
        }
    module_id = str(payload.get("module_id") or "")
    action = str(payload.get("action") or "")
    if not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", module_id):
        return {"ok": False, "code": "invalid_request", "error": "Invalid module id"}
    try:
        if action == "disable":
            status = registry.stop(module_id, disable=True)
        elif action == "stop":
            status = registry.stop(module_id)
        elif action in {"enable", "start"}:
            status = registry.start(module_id)
        elif action == "retry":
            status = registry.retry(module_id)
        else:
            return {
                "ok": False,
                "code": "invalid_request",
                "error": "Unsupported module action",
            }
    except KeyError:
        return {"ok": False, "code": "module_unknown", "error": "Unknown module"}
    return {
        "ok": True,
        "module": _module_status_payload(status),
        "modules": [_module_status_payload(item) for item in registry.statuses()],
    }


def _optional_module_unavailable(module_id: str) -> dict[str, Any] | None:
    registry = bridge_state.module_registry
    if registry is None:
        return None
    try:
        status = registry.status(module_id)
    except KeyError:
        return None
    if str(getattr(status.state, "value", status.state)) == "running":
        return None
    return {
        "ok": False,
        "code": "module_unavailable",
        "module": _module_status_payload(status),
        "error": f"{module_id} module is not running; persona and chat remain active",
    }


@register_handler(MsgType.GAME_STATE_GET)
async def handle_game_state_get(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    unavailable = _optional_module_unavailable("games")
    if unavailable:
        return unavailable
    store = bridge_state.game_state_store
    if store is None:
        return {
            "ok": False,
            "code": "module_unavailable",
            "error": "Game-state module is unavailable",
        }
    try:
        return {
            "ok": True,
            **store.get(_active_persona_id(), str(payload.get("game_id") or "")),
        }
    except Exception as exc:
        logger.exception("Game-state module read failed")
        return {"ok": False, "code": "module_degraded", "error": str(exc)}


@register_handler(MsgType.GAME_STATE_PUT)
async def handle_game_state_put(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    unavailable = _optional_module_unavailable("games")
    if unavailable:
        return unavailable
    store = bridge_state.game_state_store
    if store is None:
        return {
            "ok": False,
            "code": "module_unavailable",
            "error": "Game-state module is unavailable",
        }
    raw_revision = payload.get("expected_revision", 0)
    if isinstance(raw_revision, bool) or not isinstance(raw_revision, (int, float)):
        return {"ok": False, "code": "invalid_request", "error": "Invalid game revision"}
    if isinstance(raw_revision, float) and not raw_revision.is_integer():
        return {"ok": False, "code": "invalid_request", "error": "Invalid game revision"}
    try:
        expected_revision = int(raw_revision)
        result = store.put(
            _active_persona_id(),
            str(payload.get("game_id") or ""),
            payload.get("state"),
            expected_revision=expected_revision,
        )
        return {"ok": True, **result}
    except Exception as exc:
        from src.games import GameStateConflict

        if isinstance(exc, GameStateConflict):
            current = await handle_game_state_get(payload, _ws)
            return {**current, "ok": False, "code": "conflict", "error": str(exc)}
        logger.exception("Game-state module write failed")
        return {"ok": False, "code": "module_degraded", "error": str(exc)}


def _archive_module_snapshot() -> dict[str, Any]:
    unavailable = _optional_module_unavailable("archive")
    if unavailable:
        return unavailable
    store = bridge_state.archive_store
    if store is None:
        return {
            "ok": False,
            "code": "module_unavailable",
            "error": "Archive module is unavailable; persona and chat remain active",
        }
    try:
        return {"ok": True, **store.get(_active_persona_id())}
    except Exception as exc:
        logger.exception("Archive module read failed")
        return {
            "ok": False,
            "code": "module_degraded",
            "error": str(exc),
        }


@register_handler(MsgType.ARCHIVE_GET)
async def handle_archive_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    return _archive_module_snapshot()


async def _commit_archive(
    payload: dict,
    ws: WebSocketServerProtocol,
    *,
    migrate_only: bool,
) -> dict:
    availability = _archive_module_snapshot()
    if availability.get("ok") is not True:
        return availability
    store = bridge_state.archive_store
    if store is None:
        return {
            "ok": False,
            "code": "module_unavailable",
            "error": "Archive module is unavailable; persona and chat remain active",
        }
    raw_revision = payload.get("expected_revision", 0)
    if isinstance(raw_revision, bool):
        return {"ok": False, "code": "invalid_request", "error": "Invalid archive revision"}
    try:
        expected_revision = int(raw_revision)
    except (TypeError, ValueError):
        return {"ok": False, "code": "invalid_request", "error": "Invalid archive revision"}
    try:
        result = store.put(
            _active_persona_id(),
            payload.get("archive"),
            expected_revision=expected_revision,
            migrate_only=migrate_only,
        )
    except Exception as exc:
        from src.archive import ArchiveConflict

        if isinstance(exc, ArchiveConflict):
            current = _archive_module_snapshot()
            return {
                **current,
                "ok": False,
                "code": "conflict",
                "error": str(exc),
            }
        logger.exception("Archive module write failed")
        return {
            "ok": False,
            "code": "module_degraded",
            "error": str(exc),
        }

    active_ids = set(result["archive"].get("activeCharacterIds", []))
    active_cards = [
        card
        for card in result["archive"].get("characters", [])
        if card.get("id") in active_ids
    ]
    social = await handle_settings_update(
        {"section": "archive_social", "characters": active_cards},
        ws,
    )
    return {
        "ok": True,
        **result,
        "social_sync": {
            "ok": social.get("ok") is True,
            "synced": int(social.get("synced") or 0),
            **({"warning": str(social.get("error"))} if social.get("ok") is not True else {}),
        },
    }


@register_handler(MsgType.ARCHIVE_PUT)
async def handle_archive_put(payload: dict, ws: WebSocketServerProtocol) -> dict:
    return await _commit_archive(payload, ws, migrate_only=False)


@register_handler(MsgType.ARCHIVE_MIGRATE)
async def handle_archive_migrate(payload: dict, ws: WebSocketServerProtocol) -> dict:
    return await _commit_archive(payload, ws, migrate_only=True)


@register_handler(MsgType.BACKUP_EXPORT)
async def handle_backup_export(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Export the complete local memory state as a JSON-safe payload."""
    manager, error = _local_backup_manager()
    if error:
        return {"ok": False, "error": error}
    try:
        return {"ok": True, "backup": manager.export_payload()}
    except Exception as exc:
        logger.exception("本地备份导出失败")
        return {"ok": False, "error": str(exc)}


@register_handler(MsgType.BACKUP_IMPORT)
async def handle_backup_import(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Restore the complete local memory state from a JSON-safe payload."""
    manager, error = _local_backup_manager()
    if error:
        return {"ok": False, "error": error}
    backup_payload = payload.get("backup", payload)
    if not isinstance(backup_payload, dict):
        return {"ok": False, "error": "备份数据格式无效"}
    try:
        result = manager.import_payload(
            backup_payload,
            replace_memory=bool(payload.get("replace_memory", True)),
        )
        return {"ok": True, "result": result}
    except Exception as exc:
        logger.exception("本地备份导入失败")
        return {"ok": False, "error": str(exc)}


@register_handler(MsgType.KEEPSAKE_LIST)
async def handle_keepsake_list(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """List collected keepsakes."""
    if not bridge_state.keepsakes:
        return {"items": [], "error": "回忆收藏未初始化"}
    limit = int(payload.get("limit", 20) or 20)
    return {
        "items": [item.to_dict() for item in bridge_state.keepsakes.list_recent(limit)]
    }


@register_handler(MsgType.KEEPSAKE_ADD)
async def handle_keepsake_add(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Add a user-selected photo/sticker/screenshot/special memory keepsake."""
    if not bridge_state.keepsakes:
        return {"ok": False, "items": [], "error": "回忆收藏未初始化"}
    try:
        item = bridge_state.keepsakes.add(
            kind=str(payload.get("kind", "text")),
            title=str(payload.get("title", "")),
            content=str(payload.get("content", "")),
            source_path=str(payload.get("source_path", "")),
            media_data_url=str(payload.get("media_data_url", "")),
            tags=payload.get("tags", []),
            importance=float(payload.get("importance", 0.5) or 0.5),
        )
        return {
            "ok": True,
            "item": item.to_dict(),
            "items": [entry.to_dict() for entry in bridge_state.keepsakes.list_recent(20)],
        }
    except Exception as exc:
        logger.exception("Keepsake add failed")
        items = (
            [entry.to_dict() for entry in bridge_state.keepsakes.list_recent(20)]
            if bridge_state.keepsakes
            else []
        )
        return {"ok": False, "items": items, "error": str(exc)}


@register_handler(MsgType.STICKER_LIST)
async def handle_sticker_list(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """List user-collected and default stickers."""
    if not bridge_state.stickers:
        return {"items": [], "error": "表情包系统尚未初始化"}
    limit = int(payload.get("limit", 100) or 100)
    return {"items": [item.to_dict() for item in bridge_state.stickers.list_items(limit)]}


@register_handler(MsgType.STICKER_COLLECT)
async def handle_sticker_collect(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Collect a user-provided sticker image/text with emotion/style tags."""
    if not bridge_state.stickers:
        return {"ok": False, "items": [], "error": "表情包系统尚未初始化"}
    try:
        item = bridge_state.stickers.collect(
            text=str(payload.get("text", "")),
            emotions=payload.get("emotions"),
            image_data_url=str(payload.get("image_data_url", "")),
            style_tags=payload.get("style_tags"),
        )
        return {
            "ok": True,
            "item": item.to_dict(),
            "items": [entry.to_dict() for entry in bridge_state.stickers.list_items(100)],
        }
    except Exception as exc:
        logger.exception("Sticker collect failed")
        return {
            "ok": False,
            "items": [entry.to_dict() for entry in bridge_state.stickers.list_items(100)],
            "error": str(exc),
        }


@register_handler(MsgType.STICKER_REACT)
async def handle_sticker_react(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Record user feedback for sticker reuse preferences."""
    if not bridge_state.stickers:
        return {"ok": False, "items": [], "error": "表情包系统尚未初始化"}
    sticker_id = str(payload.get("id", ""))
    liked = bool(payload.get("liked", True))
    item = bridge_state.stickers.record_user_feedback(sticker_id, liked=liked)
    return {
        "ok": bool(item),
        "item": item.to_dict() if item else None,
        "items": [entry.to_dict() for entry in bridge_state.stickers.list_items(100)],
    }


@register_handler(MsgType.ANTI_AI_STATUS)
async def handle_anti_ai_status(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Return the active anti-AI flavor guard status."""
    from src.chat.anti_ai import anti_ai_status_payload

    return anti_ai_status_payload()


@register_handler(MsgType.IMMERSION_NEARBY)
async def handle_immersion_nearby(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Build privacy-preserving nearby life context from a user-granted location."""
    manager = _immersion_manager()
    return await manager.nearby_life_context_async(
        latitude=payload.get("latitude", 999),
        longitude=payload.get("longitude", 999),
        place_types=payload.get("place_types"),
        radius_m=payload.get("radius_m", 1200),
    )


@register_handler(MsgType.IMMERSION_CLOSEUP)
async def handle_immersion_closeup(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Return a close-up generation plan without calling a paid multimodal API."""
    manager = _immersion_manager()
    return manager.closeup_prompt_plan(str(payload.get("kind", "meal")))


@register_handler(MsgType.IMMERSION_SMART_HOME)
async def handle_immersion_smart_home(payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Return a dry-run smart-home command envelope."""
    manager = _immersion_manager()
    return manager.smart_home_command(
        provider=str(payload.get("provider", "manual")),
        device=str(payload.get("device", "")),
        action=str(payload.get("action", "")),
    )


def _provider_settings_snapshot() -> dict[str, Any]:
    settings = bridge_state.settings
    if settings is None:
        raise RuntimeError("Settings are not initialized")
    return {
        "provider": settings.llm.provider,
        "model": settings.llm.model,
        "base_url": settings.llm.base_url,
        "has_api_key": bool(settings.llm.api_key),
        "model_epoch": int(bridge_state.model_epoch or 0),
    }


async def _configure_runtime_provider(payload: Any) -> dict[str, Any]:
    """Commit public provider metadata before accepting endpoint-bound secrets.

    On a destination change the previous runtime key is deliberately cleared.
    Electron applies only credentials cryptographically bound to the resulting
    provider/origin after this durable settings commit succeeds.
    """

    if not isinstance(payload, dict):
        raise ValueError("provider metadata must be an object")
    credential_fields = {"api_key", "apiKey", "custom_headers", "customHeaders"}
    if credential_fields.intersection(payload):
        raise ValueError("credentials require the private Electron control channel")
    provider = str(payload.get("provider", "ollama")).strip().lower()
    provider_aliases = {"z.ai": "glm", "zai": "glm", "claude": "anthropic"}
    provider = provider_aliases.get(provider, provider)
    from src.config.settings import (
        SUPPORTED_PROVIDER_NAMES,
        PROVIDER_DEFAULTS,
        environment_api_key,
        normalize_provider_endpoint,
        save_settings,
    )

    if provider not in SUPPORTED_PROVIDER_NAMES:
        raise ValueError(f"Unsupported provider: {provider}")
    if not bridge_state.settings:
        raise RuntimeError("Settings are not initialized")

    previous_llm = bridge_state.settings.llm
    candidate = previous_llm.model_copy(deep=True)
    provider_changed = candidate.provider != provider
    candidate.provider = provider
    if "model" in payload and str(payload.get("model") or "").strip():
        candidate.model = str(payload["model"]).strip()
    elif provider_changed:
        from src.api.providers import get_provider

        provider_info = get_provider(provider)
        if provider_info and provider_info.models:
            candidate.model = provider_info.models[0]
    if "base_url" in payload:
        requested_base_url = str(payload.get("base_url") or "").strip()
    elif provider_changed:
        requested_base_url = ""
    else:
        requested_base_url = candidate.base_url

    candidate.base_url = normalize_provider_endpoint(provider, requested_base_url)
    candidate.resolve()
    destination_changed = (
        previous_llm.provider != candidate.provider
        or previous_llm.base_url.rstrip("/") != candidate.base_url.rstrip("/")
    )
    if destination_changed:
        # Never carry a credential across provider/origin boundaries. An
        # explicitly configured provider environment variable may be loaded by
        # resolve(); otherwise Electron must bind and re-apply a matching key.
        provider_env_key = str(PROVIDER_DEFAULTS.get(provider, {}).get("env_key") or "")
        candidate.api_key = environment_api_key(provider_env_key)

    cancelled_optional = 0
    adapter = bridge_state.adapter
    policy = getattr(adapter, "usage_policy", None)
    if destination_changed and policy is not None:
        cancelled_optional = policy.revoke_all_for_provider_change()

    bridge_state.settings.llm = candidate
    try:
        save_settings(bridge_state.settings)
    except Exception:
        bridge_state.settings.llm = previous_llm
        raise
    if adapter:
        adapter.settings = candidate
        reset_client = getattr(adapter, "reset_client", None)
        if callable(reset_client):
            reset_client()

    await _get_chat_coordinator().cancel_all(reason="model_changed")
    bridge_state.model_epoch = int(bridge_state.model_epoch or 0) + 1
    return {
        "ok": True,
        "optional_ai_consents_revoked": destination_changed,
        "cancelled_optional_ai_tasks": cancelled_optional,
        "llm": _provider_settings_snapshot(),
    }


async def _test_runtime_provider(payload: Any, credential: Any) -> dict[str, Any]:
    """Make one minimal, non-persistent request against a candidate endpoint."""

    if os.getenv("REVERIE_BRIDGE_MODE", "").strip() != "1":
        raise PermissionError("provider tests require the Electron owner")
    if not isinstance(payload, dict):
        raise ValueError("provider metadata must be an object")
    if not isinstance(credential, dict):
        raise ValueError("provider credential must be an object")
    if not bridge_state.settings:
        raise RuntimeError("settings are not initialized")

    from src.api.adapter import LLMAdapter, ProviderRequestError, parse_custom_headers
    from src.api.provider_probe import ProviderProbe
    from src.config.settings import SUPPORTED_PROVIDER_NAMES, normalize_provider_endpoint

    provider = str(payload.get("provider", "")).strip().lower()
    provider = {"z.ai": "glm", "zai": "glm", "claude": "anthropic"}.get(
        provider,
        provider,
    )
    if provider not in SUPPORTED_PROVIDER_NAMES:
        raise ValueError(f"Unsupported provider: {provider}")
    model = str(payload.get("model") or "").strip()
    if not model or len(model) > 512 or any(ord(char) < 32 for char in model):
        raise ValueError("provider model is invalid")
    base_url = normalize_provider_endpoint(
        provider,
        str(payload.get("base_url") or "").strip(),
    )
    api_key = str(credential.get("apiKey") or "")
    if len(api_key) > 16 * 1024 or "\x00" in api_key or "\r" in api_key or "\n" in api_key:
        raise ValueError("provider API key is invalid")
    if provider != "ollama" and not api_key:
        raise ProviderRequestError(
            "PROVIDER_UNAUTHORIZED",
            retryable=False,
            outcome_unknown=False,
        )
    headers = parse_custom_headers(str(credential.get("customHeaders") or ""))

    candidate = bridge_state.settings.llm.model_copy(deep=True)
    candidate.provider = provider
    candidate.model = model
    candidate.base_url = base_url
    candidate.api_key = api_key
    owner_adapter = bridge_state.adapter
    candidate_adapter = LLMAdapter(
        settings=candidate,
        local_mode_gate=getattr(owner_adapter, "local_mode_gate", None),
        custom_headers=headers,
    )
    try:
        result = await ProviderProbe(candidate_adapter).run(
            provider=provider,
            model=model,
            base_url=base_url,
        )
    finally:
        await candidate_adapter.close()
    return {
        "provider": result.provider,
        "model": result.model,
        "latency_ms": result.latency_ms,
        "finish_reason": result.finish_reason,
    }


@register_handler(MsgType.SETTINGS_GET)
async def handle_settings_get(_payload: dict, _ws: WebSocketServerProtocol) -> dict:
    """Return the public authoritative settings projection without secrets."""
    settings = bridge_state.settings
    if settings is None:
        return {"ok": False, "error": "Settings are not initialized"}
    return {
        "ok": True,
        "chat": settings.chat.model_dump(),
        "memory": settings.memory.model_dump(
            exclude={"lancedb_path", "sqlite_path"},
        ),
        "features": settings.features.model_dump(),
        "ui": settings.ui.model_dump(),
        "tts": {
            **settings.tts.model_dump(),
            "configured": bool(settings.tts.resolved_api_key),
        },
        "llm": _provider_settings_snapshot(),
    }


@register_handler(MsgType.SETTINGS_UPDATE)
async def handle_settings_update(payload: dict, ws: WebSocketServerProtocol) -> dict:
    """更新设置（API Key、Lorebook 等）。"""
    section = payload.get("section", "")
    if section == "lorebook":
        # 保存世界书到文件
        # Retired before V4. Accepting this legacy write would recreate a second
        # world-book fact source beside the persona-scoped ArchiveStore.
        return {
            "ok": False,
            "code": "retired_fact_source",
            "error": "World books are owned by the persona-scoped archive module",
            "retryable": False,
        }
    elif section == "llm":
        try:
            return await _configure_runtime_provider(payload)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "features":
        try:
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}

            def as_bool(value: Any) -> bool:
                if isinstance(value, bool):
                    return value
                if isinstance(value, str):
                    return value.strip().lower() in {"1", "true", "yes", "on"}
                return bool(value)

            features = bridge_state.settings.features
            bool_fields = {
                "diary_enabled",
                "diary_privacy_enabled",
                "diary_peek_enabled",
                "late_night_enabled",
                "late_night_message_enabled",
            }
            for key in bool_fields:
                if key in payload:
                    setattr(features, key, as_bool(payload[key]))

            if "late_night_probability" in payload:
                value = float(payload["late_night_probability"])
                features.late_night_probability = min(0.30, max(0.01, value))

            if bridge_state.diary:
                bridge_state.diary.privacy_enabled = features.diary_privacy_enabled
                bridge_state.diary.peek_enabled = features.diary_peek_enabled

            if bridge_state.proactive:
                bridge_state.proactive.late_night_enabled = features.late_night_enabled
                bridge_state.proactive.late_night_probability = features.late_night_probability
                if hasattr(bridge_state.proactive, "manage_status"):
                    bridge_state.proactive.manage_status = not features.diary_enabled

            if bridge_state.work_manager:
                bridge_state.work_manager.apply_settings(features)
                if features.diary_enabled or features.late_night_enabled:
                    bridge_state.work_manager.start()
                else:
                    bridge_state.work_manager.stop()

            save_settings(bridge_state.settings)
            return {
                "ok": True,
                "features": bridge_state.settings.features.model_dump(),
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "tts":
        try:
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}
            tts = bridge_state.settings.tts
            if "tts_enabled" in payload:
                tts.enabled = bool(payload["tts_enabled"])
            if "tts_provider" in payload:
                provider = str(payload["tts_provider"])
                if provider not in {"gemini", "openai"}:
                    return {"ok": False, "error": f"unknown TTS provider: {provider}"}
                tts.provider = provider
            if "tts_voice" in payload:
                tts.voice = str(payload["tts_voice"])[:64]
            if "tts_model" in payload:
                tts.model = str(payload["tts_model"])[:128]
            save_settings(bridge_state.settings)
            return {
                "ok": True,
                "tts": {
                    **bridge_state.settings.tts.model_dump(),
                    "configured": bool(bridge_state.settings.tts.resolved_api_key),
                },
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "onboarding":
        try:
            from datetime import datetime, timezone
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}
            completed = payload.get("completed")
            if not isinstance(completed, bool):
                return {"ok": False, "error": "completed must be a boolean"}
            bridge_state.settings.ui.onboarding_completed = completed
            bridge_state.settings.ui.onboarding_completed_at_utc = (
                datetime.now(timezone.utc).isoformat() if completed else ""
            )
            save_settings(bridge_state.settings)
            return {
                "ok": True,
                "ui": bridge_state.settings.ui.model_dump(),
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "ui":
        try:
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}
            mode = str(payload.get("mode", "") or "").strip()
            if mode not in {"mvp", "dream"}:
                return {"ok": False, "error": "mode must be mvp or dream"}
            bridge_state.settings.ui.mode = mode  # type: ignore[assignment]
            save_settings(bridge_state.settings)
            return {
                "ok": True,
                "ui": bridge_state.settings.ui.model_dump(),
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "memory":
        try:
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}

            def as_bool(value: Any) -> bool:
                if isinstance(value, bool):
                    return value
                if isinstance(value, str):
                    return value.strip().lower() in {"1", "true", "yes", "on"}
                return bool(value)

            def clamp_int(value: Any, minimum: int, maximum: int) -> int:
                return min(maximum, max(minimum, int(float(value))))

            def clamp_float(value: Any, minimum: float, maximum: float) -> float:
                return min(maximum, max(minimum, float(value)))

            memory_settings = bridge_state.settings.memory
            features = bridge_state.settings.features
            if "retention_days" in payload:
                try:
                    retention_days = int(payload["retention_days"])
                except (TypeError, ValueError):
                    return {"ok": False, "error": "记忆保留时间必须是 1、2 或 3 年"}
                if retention_days not in {365, 730, 1095}:
                    return {"ok": False, "error": "记忆保留时间必须精确选择 1、2 或 3 年"}
                memory_settings.retention_days = retention_days
            if "embedding_model" in payload:
                model_name = str(payload["embedding_model"]).strip()
                if not model_name or len(model_name) > 200 or any(ord(char) < 32 for char in model_name):
                    return {"ok": False, "error": "Embedding 模型名称无效"}
                memory_settings.embedding_model = model_name
            if "vector_quantization" in payload:
                quantization = str(payload["vector_quantization"]).strip().lower()
                if quantization not in {"float32", "int8"}:
                    return {"ok": False, "error": "向量格式必须是 float32 或 int8"}
                memory_settings.vector_quantization = quantization

            bool_fields = {
                "forgetting_enabled", "long_term_forgetting_enabled",
                "short_term_forgetting_enabled", "misremembering_enabled",
                "long_term_misremembering_enabled", "short_term_misremembering_enabled",
                "vector_partitioning_enabled",
            }
            for key in bool_fields:
                if key in payload:
                    setattr(memory_settings, key, as_bool(payload[key]))
            if "long_term_forget_days" in payload:
                memory_settings.long_term_forget_days = clamp_int(payload["long_term_forget_days"], 60, 365)
            if "short_term_forget_days" in payload:
                memory_settings.short_term_forget_days = clamp_int(payload["short_term_forget_days"], 1, 59)
            if "long_term_forget_probability" in payload:
                memory_settings.long_term_forget_probability = clamp_float(
                    payload["long_term_forget_probability"], 0.01, 0.10
                )
            if "short_term_forget_probability" in payload:
                memory_settings.short_term_forget_probability = clamp_float(
                    payload["short_term_forget_probability"], 0.001, 0.01
                )
            for key in (
                "misremember_probability", "long_term_misremember_probability",
                "short_term_misremember_probability",
            ):
                if key in payload:
                    setattr(memory_settings, key, clamp_float(payload[key], 0.01, 0.10))
            if "decay_lambda" in payload:
                memory_settings.decay_lambda = clamp_float(payload["decay_lambda"], 0.0001, 0.10)
            if "recall_reinforcement_alpha" in payload:
                memory_settings.recall_reinforcement_alpha = clamp_float(
                    payload["recall_reinforcement_alpha"], 0.0, 0.50
                )
            if "minimum_retrieval_retention" in payload:
                memory_settings.minimum_retrieval_retention = clamp_float(
                    payload["minimum_retrieval_retention"], 0.0, 0.95
                )

            feature_bools = {
                "autonomous_memory_enabled", "autonomous_memory_llm_enabled",
                "self_growth_enabled", "self_growth_from_memory_enabled",
            }
            for key in feature_bools:
                if key in payload:
                    setattr(features, key, as_bool(payload[key]))
            features.self_growth_from_web_enabled = False
            if "self_growth_interval_days" in payload:
                features.self_growth_interval_days = clamp_int(payload["self_growth_interval_days"], 30, 365)

            if bridge_state.memory and hasattr(bridge_state.memory, "apply_settings"):
                bridge_state.memory.apply_settings(memory_settings, features)
            save_settings(bridge_state.settings)
            snapshot = (
                bridge_state.memory.settings_snapshot()
                if bridge_state.memory and hasattr(bridge_state.memory, "settings_snapshot")
                else memory_settings.model_dump()
            )
            return {"ok": True, "settings": snapshot}
        except Exception as exc:
            logger.exception("Memory settings update failed")
            return {"ok": False, "error": str(exc)}
    elif section == "chat":
        try:
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}

            def clamp_float(value: Any, minimum: float, maximum: float) -> float:
                return min(maximum, max(minimum, float(value)))

            def as_bool(value: Any) -> bool:
                if isinstance(value, bool):
                    return value
                if isinstance(value, str):
                    return value.strip().lower() in {"1", "true", "yes", "on"}
                return bool(value)

            chat = bridge_state.settings.chat
            if "reply_delay_min" in payload:
                chat.reply_delay_min = clamp_float(payload["reply_delay_min"], 1.0, 60.0)
            if "reply_delay_max" in payload:
                chat.reply_delay_max = clamp_float(payload["reply_delay_max"], 1.0, 60.0)
            if chat.reply_delay_min > chat.reply_delay_max:
                chat.reply_delay_min, chat.reply_delay_max = chat.reply_delay_max, chat.reply_delay_min

            if "split_messages" in payload:
                chat.split_messages = as_bool(payload["split_messages"])
            if "typing_indicator" in payload:
                chat.typing_indicator = as_bool(payload["typing_indicator"])
            if "allow_environment_description" in payload:
                chat.allow_environment_description = as_bool(payload["allow_environment_description"])
            if "status" in payload:
                status = str(payload["status"]).strip()
                if status in {"online", "busy", "away", "sleeping"}:
                    chat.status = status

            scheduler = getattr(getattr(bridge_state, "session", None), "scheduler", None)
            if scheduler:
                scheduler.reply_delay_min = chat.reply_delay_min
                scheduler.reply_delay_max = chat.reply_delay_max
                scheduler.split_messages = chat.split_messages
                scheduler.typing_indicator = chat.typing_indicator
                scheduler.allow_environment_description = chat.allow_environment_description
                if hasattr(scheduler, "set_status"):
                    scheduler.set_status(chat.status)

            save_settings(bridge_state.settings)
            return {
                "ok": True,
                "chat": bridge_state.settings.chat.model_dump(),
                "presence": _scheduler_status_payload(),
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "personality":
        try:
            from src.config.settings import save_settings
            from src.persona.flaws import sanitize_user_flaws

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}

            def as_bool(value: Any) -> bool:
                if isinstance(value, bool):
                    return value
                if isinstance(value, str):
                    return value.strip().lower() in {"1", "true", "yes", "on"}
                return bool(value)

            def clamp_int(value: Any, minimum: int, maximum: int) -> int:
                return min(maximum, max(minimum, int(float(value))))

            def clamp_float(value: Any, minimum: float, maximum: float) -> float:
                return min(maximum, max(minimum, float(value)))

            features = bridge_state.settings.features
            bool_fields = {
                "personality_flaws_enabled",
                "personality_flaws_disclaimer_acknowledged",
                "emotion_system_enabled",
                "world_life_enabled",
                "timeline_enabled",
                "timeline_visuals_enabled",
                "group_social_enabled",
                "group_social_permanent_memory_enabled",
                "group_social_api_replies_enabled",
                "proactive_chat_enabled",
                "proactive_notifications_enabled",
                "proactive_event_stories_enabled",
                "web_surfing_enabled",
                "web_disclaimer_acknowledged",
                "keepsake_collection_enabled",
                "ambient_presence_enabled",
                "ambient_sticky_notes_enabled",
                "thought_of_you_enabled",
                "diary_key_easter_egg_enabled",
                "user_phrase_alignment_enabled",
                "api_budget_tracking_enabled",
                "api_background_budget_enforced",
            }
            for key in bool_fields:
                if key in payload:
                    setattr(features, key, as_bool(payload[key]))

            if "user_selected_flaws" in payload:
                features.user_selected_flaws = sanitize_user_flaws(str(payload["user_selected_flaws"]))
            if "emotion_carryover_days" in payload:
                features.emotion_carryover_days = clamp_int(payload["emotion_carryover_days"], 1, 7)
            if "emotion_inertia_factor" in payload:
                features.emotion_inertia_factor = clamp_float(payload["emotion_inertia_factor"], 0.01, 0.60)
            if "web_allowed_topics" in payload:
                from src.web import SAFE_TOPICS

                topics = payload["web_allowed_topics"]
                if isinstance(topics, str):
                    topics = topics.replace("，", "、").replace(",", "、").split("、")
                if isinstance(topics, list):
                    filtered = [
                        str(topic).strip()
                        for topic in topics
                        if str(topic).strip() in SAFE_TOPICS
                    ]
                    if filtered:
                        features.web_allowed_topics = filtered
            if "web_search_windows" in payload:
                windows = payload["web_search_windows"]
                if isinstance(windows, str):
                    windows = windows.replace("，", ",").replace("、", ",").split(",")
                if isinstance(windows, list):
                    from src.web import _sanitize_windows

                    features.web_search_windows = _sanitize_windows([str(item) for item in windows])
            if "web_refresh_interval_minutes" in payload:
                features.web_refresh_interval_minutes = clamp_int(payload["web_refresh_interval_minutes"], 30, 1440)
            if "keepsake_recall_probability" in payload:
                features.keepsake_recall_probability = clamp_float(payload["keepsake_recall_probability"], 0.01, 0.30)
            if "proactive_daily_limit" in payload:
                features.proactive_daily_limit = clamp_int(payload["proactive_daily_limit"], 1, 12)
            if "proactive_min_interval_minutes" in payload:
                features.proactive_min_interval_minutes = clamp_int(payload["proactive_min_interval_minutes"], 15, 1440)
            if "ambient_book_pages_per_hour" in payload:
                features.ambient_book_pages_per_hour = clamp_float(payload["ambient_book_pages_per_hour"], 0.1, 12.0)
            if "ambient_trace_interval_minutes" in payload:
                features.ambient_trace_interval_minutes = clamp_int(payload["ambient_trace_interval_minutes"], 30, 1440)
            if "ambient_offline_replay_max_days" in payload:
                features.ambient_offline_replay_max_days = clamp_int(payload["ambient_offline_replay_max_days"], 1, 90)
            if "thought_share_probability" in payload:
                features.thought_share_probability = clamp_float(payload["thought_share_probability"], 0.0, 1.0)
            thought_min = (
                clamp_int(payload["thought_min_delay_minutes"], 30, 4320)
                if "thought_min_delay_minutes" in payload
                else features.thought_min_delay_minutes
            )
            thought_max = (
                clamp_int(payload["thought_max_delay_minutes"], 60, 10080)
                if "thought_max_delay_minutes" in payload
                else features.thought_max_delay_minutes
            )
            if thought_min > thought_max:
                thought_min = min(thought_max, 4320)
            # Update the validated pair atomically; validate_assignment would
            # otherwise reject a harmless intermediate ordering.
            features = features.model_copy(
                update={
                    "thought_min_delay_minutes": thought_min,
                    "thought_max_delay_minutes": thought_max,
                }
            )
            if "thought_share_start_hour" in payload:
                features.thought_share_start_hour = clamp_int(payload["thought_share_start_hour"], 0, 23)
            if "thought_share_end_hour" in payload:
                features.thought_share_end_hour = clamp_int(payload["thought_share_end_hour"], 1, 24)
            if "diary_key_intimacy_threshold" in payload:
                features.diary_key_intimacy_threshold = clamp_int(payload["diary_key_intimacy_threshold"], 100, 10000)
            if "diary_key_happy_days" in payload:
                features.diary_key_happy_days = clamp_int(payload["diary_key_happy_days"], 3, 30)
            if "diary_key_private_emotion_threshold" in payload:
                features.diary_key_private_emotion_threshold = clamp_float(
                    payload["diary_key_private_emotion_threshold"], 40.0, 95.0
                )
            if "user_phrase_alignment_probability" in payload:
                features.user_phrase_alignment_probability = clamp_float(
                    payload["user_phrase_alignment_probability"], 0.0, 0.20
                )
            if "user_phrase_min_count" in payload:
                features.user_phrase_min_count = clamp_int(payload["user_phrase_min_count"], 2, 20)
            if "local_care_reflex_probability" in payload:
                features.local_care_reflex_probability = clamp_float(
                    payload["local_care_reflex_probability"], 0.0, 1.0
                )
            if "api_background_daily_request_budget" in payload:
                features.api_background_daily_request_budget = clamp_int(
                    payload["api_background_daily_request_budget"], 1, 10000
                )
            if "api_background_daily_token_budget" in payload:
                features.api_background_daily_token_budget = clamp_int(
                    payload["api_background_daily_token_budget"], 1000, 10000000
                )
            if "group_social_comment_probability" in payload:
                features.group_social_comment_probability = clamp_float(
                    payload["group_social_comment_probability"], 0.0, 1.0
                )
            if "group_social_backchannel_probability" in payload:
                features.group_social_backchannel_probability = clamp_float(
                    payload["group_social_backchannel_probability"], 0.0, 0.5
                )
            if "group_social_max_api_calls_per_action" in payload:
                features.group_social_max_api_calls_per_action = clamp_int(
                    payload["group_social_max_api_calls_per_action"], 0, 3
                )

            bridge_state.settings.features = features
            if bridge_state.emotion:
                bridge_state.emotion.enabled = features.emotion_system_enabled
                bridge_state.emotion.carryover_days = features.emotion_carryover_days
                bridge_state.emotion.inertia_factor = features.emotion_inertia_factor
            if bridge_state.session:
                bridge_state.session.feature_settings = features
                if bridge_state.keepsakes:
                    bridge_state.session.keepsakes = bridge_state.keepsakes
            if bridge_state.timeline:
                bridge_state.timeline.feature_settings = features
            if bridge_state.keepsakes:
                bridge_state.keepsakes.apply_settings(
                    enabled=features.keepsake_collection_enabled,
                    recall_probability=features.keepsake_recall_probability,
                )
            if features.web_surfing_enabled and bridge_state.web_surfing is None:
                from src.web import WebSurfingManager

                bridge_state.web_surfing = WebSurfingManager(
                    bridge_state.persona,
                    bridge_state.adapter,
                    allowed_topics=features.web_allowed_topics,
                    refresh_interval_minutes=features.web_refresh_interval_minutes,
                    search_windows=features.web_search_windows,
                )
            if bridge_state.web_surfing:
                from src.web import SAFE_TOPICS

                bridge_state.web_surfing.allowed_topics = [
                    topic for topic in features.web_allowed_topics
                    if topic in SAFE_TOPICS
                ] or bridge_state.web_surfing.allowed_topics
                bridge_state.web_surfing.refresh_interval_minutes = features.web_refresh_interval_minutes
                bridge_state.web_surfing.search_windows = list(features.web_search_windows)
                if bridge_state.session:
                    bridge_state.session.web = (
                        bridge_state.web_surfing
                        if features.web_surfing_enabled
                        else None
                    )
            if bridge_state.proactive:
                bridge_state.proactive.daily_limit = features.proactive_daily_limit
                bridge_state.proactive.min_interval_minutes = features.proactive_min_interval_minutes
                bridge_state.proactive.event_stories_enabled = features.proactive_event_stories_enabled
                bridge_state.proactive.local_reflex_probability = features.local_care_reflex_probability
                if hasattr(bridge_state.proactive, "web_surfing"):
                    bridge_state.proactive.web_surfing = (
                        bridge_state.web_surfing if features.web_surfing_enabled else None
                    )
                if hasattr(bridge_state.proactive, "start") and hasattr(bridge_state.proactive, "stop"):
                    if features.proactive_chat_enabled and not bridge_state.proactive.running:
                        bridge_state.proactive.start()
                    elif not features.proactive_chat_enabled and bridge_state.proactive.running:
                        bridge_state.proactive.stop()

            save_settings(bridge_state.settings)
            return {"ok": True, "features": bridge_state.settings.features.model_dump()}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "immersion":
        try:
            from src.config.settings import save_settings

            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}

            def as_bool(value: Any) -> bool:
                if isinstance(value, bool):
                    return value
                if isinstance(value, str):
                    return value.strip().lower() in {"1", "true", "yes", "on"}
                return bool(value)

            def clamp_int(value: Any, minimum: int, maximum: int) -> int:
                return min(maximum, max(minimum, int(float(value))))

            features = bridge_state.settings.features
            for key in {
                "immersion_location_enabled",
                "immersion_closeups_enabled",
                "immersion_smart_home_enabled",
            }:
                if key in payload:
                    setattr(features, key, as_bool(payload[key]))
            if "immersion_location_radius_m" in payload:
                features.immersion_location_radius_m = clamp_int(
                    payload["immersion_location_radius_m"],
                    300,
                    5000,
                )
            if bridge_state.immersion:
                bridge_state.immersion.feature_settings = features
            save_settings(bridge_state.settings)
            return {
                "ok": True,
                "features": bridge_state.settings.features.model_dump(),
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    elif section == "archive_social":
        try:
            if not bridge_state.settings:
                return {"ok": False, "error": "Settings are not initialized"}
            features = bridge_state.settings.features
            if not features.group_social_enabled:
                return {"ok": True, "synced": 0, "reason": "disabled"}
            if not bridge_state.social_circle:
                return {"ok": False, "error": "Social circle is not initialized"}

            cards = payload.get("characters", [])
            if not isinstance(cards, list):
                return {"ok": False, "error": "characters must be a list"}
            owner = getattr(bridge_state.persona, "name", "")
            safe_cards = [card for card in cards if isinstance(card, dict)]
            synced = bridge_state.social_circle.sync_character_cards(safe_cards, owner_name=owner)
            if bridge_state.social_universe:
                bridge_state.social_universe.sync_character_cards(safe_cards)
            if (
                synced
                and features.group_social_permanent_memory_enabled
                and bridge_state.memory
            ):
                for card in safe_cards:
                    name = str(card.get("name", "")).strip()
                    if not name or name == owner:
                        continue
                    role = str(card.get("role", "") or card.get("identity", "")).strip()
                    prefix = f"群体社交：{owner}认识{name}"
                    store = getattr(bridge_state.memory, "store", None)
                    if store and hasattr(store, "list_by_layer") and hasattr(store, "delete"):
                        for row in store.list_by_layer("permanent"):
                            text = str(row.get("text", ""))
                            row_id = str(row.get("id", ""))
                            if row_id and text.startswith(prefix):
                                store.delete(row_id)
                    bridge_state.memory.store_fact(
                        f"{prefix}，关系来源是用户关联的角色卡。{role}",
                        layer="permanent",
                    )
            return {"ok": True, "synced": synced}
        except Exception as exc:
            logger.exception("Archive social sync failed")
            return {"ok": False, "error": str(exc)}
    return {"ok": True}


# ── 连接处理 ──────────────────────────────────────────

def _allowed_bridge_origins() -> list[str | None]:
    configured = [
        value.strip()
        for value in os.getenv("REVERIE_BRIDGE_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    ]
    defaults = [
        "file://",
        "null",
        "reverie-desktop",
        "reverie-app://app",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    origins: list[str | None] = list(dict.fromkeys([*configured, *defaults]))
    if (
        os.getenv("REVERIE_ALLOW_ORIGINLESS_BRIDGE", "").strip() == "1"
        and os.getenv("REVERIE_BRIDGE_MODE", "").strip() != "1"
    ):
        origins.append(None)
    return origins


def _connection_origin(ws: WebSocketServerProtocol) -> str | None:
    request = getattr(ws, "request", None)
    headers = getattr(request, "headers", None) or getattr(ws, "request_headers", None)
    if headers is None:
        return None
    try:
        return headers.get("Origin")
    except Exception:
        return None


def _write_bridge_control(payload: dict[str, Any]) -> None:
    print(
        "REVERIE_BRIDGE_CONTROL "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        flush=True,
    )


def _validated_backup_control_path(value: Any, *, must_exist: bool) -> Path:
    """Validate a path received only from Electron's private owner pipe."""
    if os.getenv("REVERIE_BRIDGE_MODE", "").strip() != "1":
        raise PermissionError("native file backup requires the Electron owner")
    if not isinstance(value, str) or not value or len(value) > 32_767:
        raise ValueError("backup path is invalid")
    if "\x00" in value or any(ord(char) < 32 for char in value):
        raise ValueError("backup path contains control characters")
    candidate = Path(value)
    if not candidate.is_absolute() or candidate.suffix.lower() != ".json":
        raise ValueError("backup path must be an absolute JSON file path")
    candidate = candidate.resolve(strict=False)
    if not candidate.parent.is_dir():
        raise ValueError("backup parent directory does not exist")
    if candidate.exists():
        if candidate.is_symlink() or not candidate.is_file():
            raise ValueError("backup path must be a regular non-symlink file")
    elif must_exist:
        raise FileNotFoundError("backup file does not exist")
    return candidate


def _normalize_runtime_credentials(
    value: Any,
) -> dict[str, dict[str, str] | None]:
    if not isinstance(value, dict):
        raise ValueError("credentials must be an object")
    if set(value) - {"llm", "imageGen"}:
        raise ValueError("unsupported credential scope")
    result: dict[str, dict[str, str] | None] = {}
    for scope in ("llm", "imageGen"):
        if scope not in value:
            continue
        raw = value.get(scope)
        if raw is None:
            result[scope] = None
            continue
        if not isinstance(raw, dict):
            raise ValueError(f"{scope} credentials must be an object")
        if set(raw) - {"apiKey", "customHeaders"}:
            raise ValueError(f"unsupported {scope} credential field")
        normalized: dict[str, str] = {}
        for field in ("apiKey", "customHeaders"):
            item = raw.get(field, "")
            if not isinstance(item, str) or len(item) > 64 * 1024 or "\x00" in item:
                raise ValueError(f"{scope}.{field} is invalid")
            if item:
                normalized[field] = item
        result[scope] = normalized
    return result


async def _apply_runtime_credentials(value: Any) -> dict[str, bool]:
    """Apply decrypted credentials from Electron without persisting them."""
    if os.getenv("REVERIE_BRIDGE_MODE", "").strip() != "1":
        raise PermissionError("runtime credentials require the Electron owner")
    credentials = _normalize_runtime_credentials(value)
    if not bridge_state.settings:
        raise RuntimeError("settings are not initialized")
    llm = bridge_state.settings.llm
    previous_key = str(getattr(llm, "api_key", "") or "")
    llm_credentials = credentials.get("llm", ...)
    if llm_credentials is None:
        next_key = ""
    elif llm_credentials is ... or "apiKey" not in llm_credentials:
        next_key = previous_key
    else:
        next_key = llm_credentials["apiKey"]
    llm.api_key = next_key
    adapter = bridge_state.adapter
    if adapter:
        from src.api.adapter import parse_custom_headers

        adapter.settings = llm
        if llm_credentials is None:
            adapter.custom_headers = {}
        elif llm_credentials is not ...:
            adapter.custom_headers = parse_custom_headers(
                str(llm_credentials.get("customHeaders") or "")
            )
        reset_client = getattr(adapter, "reset_client", None)
        if callable(reset_client):
            reset_client()
    if previous_key != next_key:
        await _get_chat_coordinator().cancel_all(reason="credentials_changed")
        bridge_state.model_epoch = int(bridge_state.model_epoch or 0) + 1
    # The current Python image service doesn't consume a generation-provider
    # credential. Keep the encrypted value in Electron, but don't pretend it
    # was applied to a backend that cannot use it.
    return {"llm": True, "imageGen": False}


async def _run_native_backup(operation: str, raw_path: Any) -> dict[str, Any]:
    manager, error = _local_backup_manager()
    if manager is None:
        raise RuntimeError(str(error or "local backup manager is unavailable"))
    if operation == "export":
        target = _validated_backup_control_path(raw_path, must_exist=False)
        await asyncio.to_thread(manager.backup_to_file, target)
        return {"operation": "export"}
    if operation != "import":
        raise ValueError("unsupported backup operation")
    source = _validated_backup_control_path(raw_path, must_exist=True)
    await _get_chat_coordinator().cancel_all(reason="backup_restore")
    proactive = bridge_state.proactive
    work_manager = bridge_state.work_manager
    proactive_was_running = bool(getattr(proactive, "running", False))
    work_was_running = bool(getattr(work_manager, "running", False))
    if proactive_was_running and callable(getattr(proactive, "stop", None)):
        proactive.stop()
    if work_was_running and callable(getattr(work_manager, "stop", None)):
        work_manager.stop()
    try:
        result = await asyncio.to_thread(manager.restore_from_file, source)
    finally:
        if proactive_was_running and callable(getattr(proactive, "start", None)):
            proactive.start()
        if work_was_running and callable(getattr(work_manager, "start", None)):
            work_manager.start()
    return {
        "operation": "import",
        "result": result if isinstance(result, dict) else {},
    }


async def _bridge_control_loop(shutdown_event: asyncio.Event | None = None) -> None:
    """Receive privileged host commands over Electron's private stdin."""
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if line == "":
            if (
                shutdown_event is not None
                and os.getenv("REVERIE_BRIDGE_MODE", "").strip() == "1"
            ):
                # Electron owns this private pipe.  EOF means the owner is
                # gone, so leaving a network-capable orphan is never useful.
                shutdown_event.set()
            return
        if len(line.encode("utf-8", errors="ignore")) > 64 * 1024:
            _write_bridge_control(
                {
                    "schema": "reverie.bridge.control.ack.v1",
                    "requestId": "",
                    "active": True,
                    "epoch": 0,
                    "sessionId": None,
                    "ok": False,
                    "error": "control frame too large",
                }
            )
            continue
        request_id = ""
        control_type = ""
        active = True
        epoch = 0
        session_id = ""
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("control frame must be an object")
            if message.get("schema") != "reverie.bridge.control.v1":
                raise ValueError("invalid control schema")
            control_type = str(message.get("type") or "")
            request_id = str(message.get("requestId") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", request_id):
                raise ValueError("invalid requestId")
            if control_type == "local_mode:set":
                active = message.get("active")
                if not isinstance(active, bool):
                    raise ValueError("active must be a boolean")
                epoch = int(message.get("epoch"))
                session_id = str(message.get("sessionId") or "")
                if epoch < 0:
                    raise ValueError("epoch must be non-negative")
                if len(session_id) > 160 or any(ord(char) < 32 for char in session_id):
                    raise ValueError("invalid sessionId")
                result = await _apply_local_mode(active, epoch=epoch, session_id=session_id)
                _write_bridge_control(
                    {
                        "schema": "reverie.bridge.control.ack.v1",
                        "requestId": request_id,
                        "active": bool(result["enabled"]),
                        "epoch": int(result["epoch"]),
                        "sessionId": result.get("session_id") or None,
                        "ok": True,
                    }
                )
            elif control_type == "credentials:set":
                applied = await _apply_runtime_credentials(message.get("credentials"))
                _write_bridge_control(
                    {
                        "schema": "reverie.bridge.control.ack.v1",
                        "type": control_type,
                        "requestId": request_id,
                        "applied": applied,
                        "ok": True,
                    }
                )
            elif control_type in {"backup:file:export", "backup:file:import"}:
                operation = "export" if control_type.endswith(":export") else "import"
                backup_result = await _run_native_backup(operation, message.get("path"))
                _write_bridge_control(
                    {
                        "schema": "reverie.bridge.control.ack.v1",
                        "type": control_type,
                        "requestId": request_id,
                        **backup_result,
                        "ok": True,
                    }
                )
            else:
                raise ValueError("unsupported control type")
        except Exception as exc:
            if control_type == "local_mode:set":
                from src.local_mode import get_local_mode_gate

                snapshot = get_local_mode_gate().snapshot()
                failure = {
                    "active": snapshot.enabled,
                    "epoch": snapshot.epoch,
                    "sessionId": snapshot.session_id or None,
                }
            else:
                failure = {"type": control_type}
            _write_bridge_control(
                {
                    "schema": "reverie.bridge.control.ack.v1",
                    "requestId": request_id,
                    **failure,
                    "ok": False,
                    "error": str(exc)[:240],
                }
            )


def _parent_process_is_alive(pid: int) -> bool:
    """Best-effort owner liveness check without adding a runtime dependency."""
    if pid <= 1 or pid == os.getpid():
        return pid == os.getpid()
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, wintypes.LPDWORD]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            # Access denied doesn't prove death (for example, an elevated
            # parent).  Every other failure means the PID cannot be opened.
            return ctypes.get_last_error() == 5
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (ProcessLookupError, OSError):
        return False


async def _parent_watch_loop(shutdown_event: asyncio.Event) -> None:
    raw_pid = os.getenv("REVERIE_PARENT_PID", "").strip()
    if not raw_pid:
        return
    try:
        parent_pid = int(raw_pid)
    except ValueError:
        logger.error("Ignoring invalid REVERIE_PARENT_PID")
        shutdown_event.set()
        return
    while not shutdown_event.is_set():
        if not _parent_process_is_alive(parent_pid):
            logger.warning("Electron owner process %d exited; stopping bridge", parent_pid)
            shutdown_event.set()
            return
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=2.0)
        except TimeoutError:
            continue


async def _authenticate_bridge_client(ws: WebSocketServerProtocol) -> BridgeClientContext:
    origin = _connection_origin(ws)
    if origin not in _allowed_bridge_origins():
        raise PermissionError("untrusted WebSocket Origin")
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
    except TimeoutError as exc:
        raise PermissionError("bridge authentication timeout") from exc
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 16 * 1024:
        raise PermissionError("invalid bridge authentication frame")
    try:
        message = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PermissionError("invalid bridge authentication JSON") from exc
    if not isinstance(message, dict) or message.get("type") != "bridge:auth":
        raise PermissionError("bridge:auth must be the first frame")
    payload = message.get("payload")
    if not isinstance(payload, dict):
        raise PermissionError("invalid bridge authentication payload")
    supplied = str(payload.get("secret") or "")
    if not _bridge_secret_value or not hmac.compare_digest(supplied, _bridge_secret_value):
        raise PermissionError("invalid bridge credential")
    client_id = str(payload.get("client_id") or "")
    if not client_id:
        client_id = "desktop_" + hashlib.sha256(supplied.encode("utf-8")).hexdigest()[:24]
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", client_id):
        raise PermissionError("invalid bridge client_id")
    try:
        protocol_version = int(
            payload.get("protocol_version")
            or payload.get("protocolVersion")
            or os.getenv("REVERIE_BRIDGE_PROTOCOL_VERSION", "4")
        )
    except (TypeError, ValueError) as exc:
        raise PermissionError("invalid bridge protocol version") from exc
    if protocol_version != 4:
        raise PermissionError("unsupported bridge protocol version")
    return BridgeClientContext(
        client_id=client_id,
        protocol_version=protocol_version,
        authenticated=True,
        conversation_id=str(payload.get("conversation_id") or "default")[:160],
        persona_id=str(payload.get("persona_id") or _active_persona_id())[:160],
    )


async def dispatch_authenticated_message(
    message: Any,
    endpoint: WebSocketServerProtocol,
    *,
    emit_result: bool = True,
) -> dict[str, Any] | None:
    """Dispatch one already-owner-authenticated V2 compatibility frame.

    Production stdio and the development WebSocket adapter share this exact
    business dispatcher. Authentication and transport framing stay outside it.
    """
    request_id = ""
    try:
        if not isinstance(message, dict):
            raise ValueError("message must be an object")
        msg_type = message.get("type", "")
        payload = message.get("payload", {})
        if not isinstance(msg_type, str) or not re.fullmatch(r"[A-Za-z0-9:_-]{1,80}", msg_type):
            raise ValueError("invalid message type")
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        raw_request_id = message.get("request_id", "")
        if raw_request_id:
            candidate_request_id = str(raw_request_id)
            if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", candidate_request_id):
                raise ValueError("invalid request_id")
            request_id = candidate_request_id

        handler = _handlers.get(msg_type)
        if handler is None:
            await send_to_frontend(
                endpoint,
                MsgType.ERROR,
                {"message": f"未知消息类型: {msg_type}"},
                request_id=request_id,
            )
            return None
        context = _client_contexts.get(endpoint)
        persona_scoped = msg_type in _PERSONA_SCOPED_COMMANDS
        if (
            context is not None
            and context.protocol_version >= 3
            and persona_scoped
            and not _matches_expected_persona(payload)
        ):
            result = {
                "ok": False,
                "error": "Persona changed before the command could run",
                "code": "stale_persona",
                "retryable": False,
                **_active_persona_scope(),
            }
        elif degraded_runtime_blocks(msg_type):
            result = {
                "ok": False,
                "error": "Capability modules are unavailable; the persona kernel remains active",
                "code": "runtime_capability_unavailable",
                "unavailable": list(bridge_state.runtime_unavailable),
            }
        elif persona_restart_blocks(msg_type):
            result = {
                "ok": False,
                "error": "Persona changed; restart is required before this operation",
                "code": "persona_restart_required",
                "restart_required": True,
            }
        elif persona_scoped:
            # Linearize persona-scoped local reads/writes against privileged
            # identity activation. Chat generation itself remains asynchronous
            # and carries its own epoch/fingerprint rejection barrier.
            async with _persona_effect_lock:
                result = await handler(payload, endpoint)
        else:
            result = await handler(payload, endpoint)
        if result is not None and emit_result:
            await send_to_frontend(
                endpoint,
                response_type_for_request(msg_type),
                result,
                request_id=request_id,
            )
        return result
    except ValueError as exc:
        await send_to_frontend(
            endpoint,
            MsgType.ERROR,
            {"message": str(exc)},
            request_id=request_id,
        )
        return None
    except Exception:
        logger.exception("Authenticated bridge message failed")
        await send_to_frontend(
            endpoint,
            MsgType.ERROR,
            {"message": "内部错误"},
            request_id=request_id,
        )
        return None


async def websocket_handler(ws: WebSocketServerProtocol):
    """Handle the sole authenticated desktop controller."""
    global _controller_ws
    try:
        context = await _authenticate_bridge_client(ws)
    except PermissionError as exc:
        logger.warning("Rejected bridge client: %s", exc)
        await ws.close(code=4401, reason="bridge authentication failed")
        return
    if _controller_ws is not None and _controller_ws is not ws:
        await ws.close(code=4009, reason="controller already connected")
        return
    _controller_ws = ws
    _client_contexts[ws] = context
    _connections.add(ws)
    logger.info("Authenticated frontend connected (%d active)", len(_connections))
    persona_scope = _active_persona_scope()
    await send_to_frontend(
        ws,
        "bridge:auth_ok",
        {
            "protocol_version": context.protocol_version,
            "client_id": context.client_id,
            "persona_id": persona_scope["persona_id"],
            "persona_epoch": persona_scope["persona_epoch"],
            "persona_fingerprint": persona_scope["persona_fingerprint"],
            "model_epoch": int(getattr(bridge_state, "model_epoch", 0) or 0),
            "persona_restart_required": bool(bridge_state.persona_restart_required),
            "runtime_degraded": bool(bridge_state.runtime_unavailable),
            "runtime_unavailable": list(bridge_state.runtime_unavailable),
        },
    )
    await send_to_frontend(ws, MsgType.RUNTIME_ACTIVITY, _runtime_activity_payload())
    if bridge_state.session is not None:
        await _get_chat_coordinator().resume(
            client_id=context.client_id,
            conversation_id=context.conversation_id,
            persona_id=str(persona_scope["persona_id"]),
        )
    try:
        async for raw in ws:
            request_id = ""
            try:
                if not isinstance(raw, str):
                    await send_to_frontend(ws, MsgType.ERROR, {"message": "binary frames are not supported"})
                    continue
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    raise ValueError("message must be an object")
                msg_type = msg.get("type", "")
                payload = msg.get("payload", {})
                if not isinstance(msg_type, str) or len(msg_type) > 80:
                    raise ValueError("invalid message type")
                if not isinstance(payload, dict):
                    raise ValueError("payload must be an object")
                carries_persona_proof = any(
                    field in payload
                    for field in (
                        "expected_persona_id",
                        "expected_persona_epoch",
                        "expected_persona_fingerprint",
                    )
                )
                if carries_persona_proof and not _matches_expected_persona(payload):
                    raise ValueError("stale persona proof")
                sanitized_payload = dict(payload)
                for field in (
                    "expected_persona_id",
                    "expected_persona_epoch",
                    "expected_persona_fingerprint",
                ):
                    sanitized_payload.pop(field, None)
                raw_request_id = str(msg.get("request_id") or "")
                if not raw_request_id and msg_type == MsgType.CHAT_SEND:
                    raw_request_id = str(sanitized_payload.get("request_id") or "")
                candidate_request_id = raw_request_id or f"dev_{secrets.token_hex(16)}"
                active = _active_persona_scope()
                envelope = CommandEnvelopeV4(
                    request_id=candidate_request_id,
                    idempotency_key=candidate_request_id,
                    command=msg_type,
                    persona=PersonaScopeV4(
                        persona_id=str(active["persona_id"]),
                        epoch=int(active["persona_epoch"]),
                        fingerprint=str(active["persona_fingerprint"]),
                    ),
                    payload=sanitized_payload,
                )
                request_id = envelope.request_id
                msg_type = envelope.command
                payload = dict(envelope.payload)
                payload.update(
                    expected_persona_id=envelope.persona.persona_id,
                    expected_persona_epoch=envelope.persona.epoch,
                    expected_persona_fingerprint=envelope.persona.fingerprint,
                )

                handler = _handlers.get(msg_type)
                if handler:
                    if degraded_runtime_blocks(msg_type):
                        result = {
                            "ok": False,
                            "error": "Capability modules are unavailable; the persona kernel remains active",
                            "code": "runtime_capability_unavailable",
                            "unavailable": list(bridge_state.runtime_unavailable),
                        }
                    elif persona_restart_blocks(msg_type):
                        result = {
                            "ok": False,
                            "error": "Persona changed; restart is required before this operation",
                            "code": "persona_restart_required",
                            "restart_required": True,
                        }
                    else:
                        result = await handler(payload, ws)
                    if result is not None:
                        await send_to_frontend(
                            ws,
                            response_type_for_request(msg_type),
                            result,
                            request_id=request_id,
                        )
                else:
                    await send_to_frontend(
                        ws,
                        MsgType.ERROR,
                        {"message": f"未知消息类型: {msg_type}"},
                        request_id=request_id,
                    )
            except json.JSONDecodeError:
                await send_to_frontend(ws, MsgType.ERROR, {"message": "无效 JSON"})
            except ValueError as exc:
                del exc
                await send_to_frontend(
                    ws,
                    MsgType.ERROR,
                    {"message": "The command was rejected"},
                    request_id=request_id,
                )
            except Exception:
                logger.exception("消息处理异常")
                await send_to_frontend(
                    ws,
                    MsgType.ERROR,
                    {"message": "内部错误"},
                    request_id=request_id,
                )
    except websockets.ConnectionClosed:
        pass
    finally:
        _connections.discard(ws)
        _client_contexts.pop(ws, None)
        if _controller_ws is ws:
            _controller_ws = None
        logger.info("Authenticated frontend disconnected (%d active)", len(_connections))


async def start_bridge(host: str = "127.0.0.1", port: int = 48913):
    """启动 WebSocket 桥接服务器。"""
    global _bridge_secret_value
    if str(host).strip().lower() not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("WebSocket bridge may listen only on loopback")
    configured_secret = (
        os.getenv("REVERIE_BRIDGE_SECRET", "").strip()
        or os.getenv("REVERIE_WS_SECRET", "").strip()
    )
    valid_secret = bool(
        re.fullmatch(r"[A-Fa-f0-9]{64}", configured_secret)
        or re.fullmatch(r"[A-Za-z0-9_-]{43}", configured_secret)
    )
    if configured_secret and not valid_secret:
        raise RuntimeError("bridge secret must encode exactly 32 random bytes")
    if not configured_secret:
        if os.getenv("REVERIE_ALLOW_INSECURE_DEV_BRIDGE", "").strip() == "1":
            configured_secret = secrets.token_hex(32)
        else:
            raise RuntimeError("REVERIE_WS_SECRET is required for the WebSocket bridge")
    _bridge_secret_value = configured_secret
    shutdown_event = asyncio.Event()
    proactive_task = asyncio.create_task(_proactive_broadcast_loop())
    activity_task = asyncio.create_task(_runtime_activity_loop())
    control_task = asyncio.create_task(_bridge_control_loop(shutdown_event))
    parent_task = asyncio.create_task(_parent_watch_loop(shutdown_event))
    try:
        async with websockets.serve(
            websocket_handler,
            host,
            port,
            origins=_allowed_bridge_origins(),
            max_size=256 * 1024,
            max_queue=16,
            compression=None,
            server_header=None,
        ) as server:
            actual_port = int(server.sockets[0].getsockname()[1])
            logger.info("WebSocket bridge ready on loopback port %d", actual_port)
            from src.local_mode import get_local_mode_gate

            gate_snapshot = get_local_mode_gate().snapshot()
            persona_scope = _active_persona_scope()
            ready = {
                "schema": "reverie.bridge.ready.v1",
                "host": host,
                "port": actual_port,
                "pid": os.getpid(),
                "secretSha256": hashlib.sha256(configured_secret.encode("utf-8")).hexdigest(),
                "protocolVersion": 4,
                "localModeEpoch": gate_snapshot.epoch,
                "localModeSessionId": gate_snapshot.session_id or None,
                "personaId": persona_scope["persona_id"],
                "personaEpoch": persona_scope["persona_epoch"],
                "personaFingerprint": persona_scope["persona_fingerprint"],
                "runtimeDegraded": bool(bridge_state.runtime_unavailable),
                "runtimeUnavailable": list(bridge_state.runtime_unavailable),
            }
            print(
                "REVERIE_BRIDGE_READY "
                + json.dumps(ready, ensure_ascii=False, separators=(",", ":")),
                flush=True,
            )
            await shutdown_event.wait()
    finally:
        proactive_task.cancel()
        activity_task.cancel()
        control_task.cancel()
        parent_task.cancel()
        await asyncio.gather(
            proactive_task,
            activity_task,
            control_task,
            parent_task,
            return_exceptions=True,
        )
        if _chat_coordinator is not None:
            await _chat_coordinator.shutdown()
        _bridge_secret_value = ""


def attach_bridge_state(**kwargs):
    """将 Reverie 子系统注入桥接状态。"""
    global _chat_coordinator
    for name, obj in kwargs.items():
        if hasattr(bridge_state, name):
            setattr(bridge_state, name, obj)
            logger.info("桥接状态注入: %s", name)
        else:
            logger.warning("未知桥接状态字段: %s", name)
    if "session" in kwargs or "kernel_store" in kwargs:
        _chat_coordinator = None
