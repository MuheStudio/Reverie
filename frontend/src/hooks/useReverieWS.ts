/**
 * Reverie WebSocket Hook — 前端与 Python 后端的实时通信层。
 *
 * 对接 src/bridge/ws_bridge.py (MsgType 协议)。
 * 提供连接管理、自动重连、消息收发、状态订阅。
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  markRevealSent,
  migrateChatMessages,
  upsertRequestState,
  type ChatDeliveryState,
  type ChatMessageV2,
  type ChatRequestState,
} from '@/components/DreamRoom/chatDeliveryMachine';
import { WSMsgType } from '@/contracts/protocolV4.generated';
import {
  ElectronBridgeSocket,
  isElectronIpcBridge,
  type BridgeSocketLike,
} from '@/lib/electronBridgeSocket';
export {
  PROTOCOL_VERSION,
  WSMsgType,
  type CommandEnvelopeV4,
  type CommandResultV4,
  type DomainEventV4,
  type PersonaScopeV4,
} from '@/contracts/protocolV4.generated';

export const WS_RESPONSE_ALIASES: Record<string, string[]> = {
  [WSMsgType.MEMORY_RESULT]: ['memory_query_result', 'memory_store_result'],
  [WSMsgType.MEMORY_SETTINGS_RESULT]: ['memory_settings_get_result'],
  [WSMsgType.EMOTION_UPDATE]: ['emotion_get_result'],
  [WSMsgType.PERSONA_DATA]: ['persona_get_result'],
  [WSMsgType.PERSONA_IMPORT_RESULT]: [
    'persona_import_result',
    'persona_list_result',
    'persona_activate_result',
  ],
  [WSMsgType.RELATIONSHIP_DATA]: ['relationship_get_result'],
  [WSMsgType.DIARY_RESULT]: ['diary_request_result'],
  [WSMsgType.TIMELINE_RESULT]: ['timeline_request_result'],
  [WSMsgType.AMBIENT_RESULT]: ['ambient_get_result'],
  [WSMsgType.API_BUDGET_RESULT]: ['api_budget_get_result'],
  [WSMsgType.GROUP_RESULT]: ['group_request_result', 'group_send_result'],
  [WSMsgType.IMAGE_RESULT]: ['image_random_result'],
  [WSMsgType.USER_PROFILE_RESULT]: ['user_profile_get_result', 'user_profile_update_result'],
  [WSMsgType.KEEPSAKE_RESULT]: ['keepsake_list_result', 'keepsake_add_result'],
  [WSMsgType.BACKUP_RESULT]: ['backup_export_result', 'backup_import_result'],
  [WSMsgType.SETTINGS_UPDATE_RESULT]: ['settings_update_result'],
  [WSMsgType.STICKER_DATA]: ['sticker_list_result', 'sticker_collect_result', 'sticker_react_result'],
  [WSMsgType.ANTI_AI_STATUS_RESULT]: ['anti_ai_status_result'],
  [WSMsgType.IMMERSION_RESULT]: ['immersion_nearby_result', 'immersion_closeup_result', 'immersion_smart_home_result'],
};

export function responseTypesFor(canonicalType: string): string[] {
  return [canonicalType, ...(WS_RESPONSE_ALIASES[canonicalType] ?? [])];
}

export const INITIAL_STATE_REQUEST_TYPES = [
  WSMsgType.CHAT_HISTORY,
  WSMsgType.EMOTION_GET,
  WSMsgType.PERSONA_GET,
  WSMsgType.RELATIONSHIP_GET,
  WSMsgType.USER_PROFILE_GET,
  WSMsgType.ANTI_AI_STATUS,
  WSMsgType.MEMORY_SETTINGS_GET,
  WSMsgType.SETTINGS_GET,
] as const;

// ── 类型 ──────────────────────────────────────────────

export interface WSMessage {
  type: string;
  payload: any;
  request_id?: string;
}

export interface WSRequestOptions {
  expectedType: string | readonly string[];
  timeout?: number;
}

export interface StickerItem {
  id: string;
  text: string;
  emotions: string[];
  source?: string;
  usage_count?: number;
  last_used?: string;
  image_path?: string;
  image_data_url?: string;
  style_tags?: string[];
  favorite_score?: number;
}
export interface ChatMessage extends ChatMessageV2 {
  sticker?: StickerItem | null;
  deliveryId?: string;
  bubbleIndex?: number;
}
export interface ChatChunk { text: string; sticker?: StickerItem | null; }
export interface ChatBubble {
  text: string;
  index?: number;
  total?: number;
  delivery_id?: string;
  request_id?: string;
  conversation_id?: string;
  persona_id?: string | null;
  created_at_utc?: string;
}
export interface ChatPresence {
  status: 'online' | 'busy' | 'away' | 'sleeping' | 'typing';
  label: string;
  is_available?: boolean;
}
export interface ChatTypingPayload {
  status?: string;
  label?: string;
  delay?: number;
  typing_duration?: number;
  presence?: Partial<ChatPresence>;
}
export interface ChatStatePayload {
  request_id?: string;
  conversation_id?: string;
  persona_id?: string | null;
  state?: ChatDeliveryState | string;
  status?: ChatDeliveryState | string;
  label?: string;
  error?: string;
  updated_at_utc?: string;
}
export interface ChatRetractPayload {
  notice?: string;
  replacement?: string;
  delivery_id?: string;
  bubble_index?: number;
}
export interface EmotionState { emotions: Record<string, number>; }
export interface RuntimeActivity {
  diary_writing: boolean;
  timeline_revision: string;
}
export interface AuthoritativeSettingsSnapshot {
  chat?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  features?: Record<string, unknown>;
  ui?: {
    onboarding_completed?: boolean;
    onboarding_completed_at_utc?: string;
  };
  llm?: {
    provider?: string;
    model?: string;
    base_url?: string;
    has_api_key?: boolean;
  };
}
export interface PersonaScope {
  persona_id: string;
  persona_epoch: number;
  persona_fingerprint: string;
  model_epoch?: number;
  restart_required?: boolean;
}
export interface PersonaData extends Partial<PersonaScope> {
  persona: any;
}
interface AuthoritativeLocalModeState {
  enabled: boolean;
  epoch: number;
  sessionId: string | null;
  changedAtUtc: string;
  available: boolean;
  reason: string;
  transitioning: boolean;
}
export interface RelationshipData {
  intimacy: number;
  trust?: number;
  stage: string;
  stage_key?: string;
  stage_number?: number;
  stage_detail?: string;
  thresholds?: Array<{ key: string; label: string; min: number; max?: number | null; behavior?: string }>;
}
export interface DiaryEntry {
  date: string;
  title?: string;
  content?: string;
  mood?: string;
  is_locked?: boolean;
  peekable?: boolean;
  can_peek?: boolean;
  status_label?: string;
  key_available?: boolean;
  key_unlocked?: boolean;
  emotions?: Record<string, number>;
}
export interface TimelineComment {
  id: string;
  author_id?: string;
  author_name: string;
  content: string;
  created_at?: number;
  provenance?: string;
}
export interface TimelinePost {
  id?: string;
  date: string;
  content?: string;
  mood?: string;
  emotions?: Record<string, number>;
  tags?: string[];
  event_id?: string;
  event_type?: string;
  sticker_ref?: string;
  sticker_text?: string;
  sticker_data_url?: string;
  media_url?: string;
  media_kind?: string;
  creative_ref?: string;
  creative_title?: string;
  visual_stage?: string;
  visual_prompt?: string;
  comments?: TimelineComment[];
}
export interface AmbientTrace {
  id: string;
  kind: string;
  title: string;
  body: string;
  occurred_at?: string;
  seen?: boolean;
}
export interface AmbientState {
  book_page: number;
  book_total: number;
  traces: AmbientTrace[];
  latest_sticky: AmbientTrace | null;
  pending_thoughts: number;
  happy_streak: number;
}
export interface ApiBudgetState {
  tracking_enabled: boolean;
  background_enforced?: boolean;
  requests: number;
  succeeded: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_unreported_tokens: number;
  background: {
    requests: number;
    request_budget: number;
    tokens: number;
    token_budget: number;
  };
  by_purpose: Array<{ purpose: string; requests: number; measured_tokens: number }>;
  currency_note?: string;
  error?: string;
}
export interface GroupMessage {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  created_at: number;
  kind: string;
  provenance?: string;
}
export interface GroupMember { id: string; name: string; role?: string; }
export interface GroupThread {
  id: string;
  title: string;
  members: GroupMember[];
  messages: GroupMessage[];
}
export interface GroupState {
  enabled: boolean;
  threads: GroupThread[];
  characters: GroupMember[];
  simulation_notice: string;
  error?: string;
}
export interface MemoryItem { content: string; layer: string; score: number; }
export interface ImageResult { url: string | null; mode: string; error?: string; }
export interface KeepsakeItem {
  id: string;
  kind: string;
  title: string;
  content?: string;
  source_path?: string;
  media_data_url?: string;
  tags?: string[];
  created_at?: string;
  last_recalled_at?: string | null;
  importance?: number;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'unavailable';

export type BridgeAuthPhase =
  | 'idle'
  | 'awaiting_auth'
  | 'authenticated'
  | 'failed';

export type BridgeInboundAction =
  | 'accept_auth'
  | 'dispatch'
  | 'reject';

export interface BridgeAuthTransition {
  phase: BridgeAuthPhase;
  action: BridgeInboundAction;
}

type CorrelatedResponseAction = 'match' | 'error' | 'ignore';

export function classifyCorrelatedResponse(
  requestId: string,
  expectedTypes: ReadonlySet<string>,
  frame: WSMessage,
): CorrelatedResponseAction {
  if (frame.request_id !== requestId) return 'ignore';
  if (frame.type === WSMsgType.ERROR) return 'error';
  return expectedTypes.has(frame.type) ? 'match' : 'ignore';
}

/**
 * A bridge connection accepts exactly one authentication response. Business
 * frames before it, and repeated authentication frames after it, are protocol
 * violations rather than events that the application may accidentally trust.
 */
export function transitionBridgeAuth(
  phase: BridgeAuthPhase,
  frameType: string,
): BridgeAuthTransition {
  if (phase === 'awaiting_auth') {
    if (frameType === WSMsgType.BRIDGE_AUTH_OK) {
      return { phase: 'authenticated', action: 'accept_auth' };
    }
    return { phase: 'failed', action: 'reject' };
  }
  if (phase === 'authenticated') {
    if (
      frameType === WSMsgType.BRIDGE_AUTH_OK
      || frameType === WSMsgType.BRIDGE_AUTH_ERROR
    ) {
      return { phase: 'failed', action: 'reject' };
    }
    return { phase, action: 'dispatch' };
  }
  return { phase: 'failed', action: 'reject' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractArrayPayload(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

export function coercePersonaScope(payload: unknown): PersonaScope | null {
  if (!isRecord(payload)) return null;
  const personaId = optionalString(payload.persona_id);
  const personaEpoch = nonNegativeInteger(payload.persona_epoch);
  const personaFingerprint = optionalString(payload.persona_fingerprint);
  if (
    !personaId
    || personaId.length > 160
    || /[\u0000-\u001f\u007f]/u.test(personaId)
    || personaEpoch === undefined
    || !personaFingerprint
    || !/^[a-f0-9]{64}$/i.test(personaFingerprint)
  ) return null;
  const modelEpoch = nonNegativeInteger(payload.model_epoch);
  const restartRequired = optionalBoolean(
    payload.restart_required ?? payload.persona_restart_required,
  );
  return {
    persona_id: personaId,
    persona_epoch: personaEpoch,
    persona_fingerprint: personaFingerprint,
    ...(modelEpoch === undefined ? {} : { model_epoch: modelEpoch }),
    ...(restartRequired === undefined ? {} : { restart_required: restartRequired }),
  };
}

export function coerceAuthoritativeLocalModeState(
  payload: unknown,
): AuthoritativeLocalModeState | null {
  if (!isRecord(payload)) return null;
  const epoch = nonNegativeInteger(payload.epoch);
  const sessionId = payload.sessionId;
  const changedAtUtc = optionalString(payload.changedAtUtc);
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  if (
    typeof payload.enabled !== 'boolean'
    || epoch === undefined
    || (sessionId !== null && typeof sessionId !== 'string')
    || (typeof sessionId === 'string' && (
      sessionId.length > 160 || /[\u0000-\u001f\u007f]/u.test(sessionId)
    ))
    || !changedAtUtc
    || !Number.isFinite(Date.parse(changedAtUtc))
    || typeof payload.available !== 'boolean'
    || reason === undefined
    || reason.length > 500
  ) return null;
  return {
    enabled: payload.enabled,
    epoch,
    sessionId,
    changedAtUtc,
    available: payload.available,
    reason,
    transitioning: payload.transitioning === true,
  };
}

export function enrichPersonaActivationPayload(
  payload: unknown,
  scope: PersonaScope | null,
): Record<string, unknown> | null {
  if (!isRecord(payload) || !scope) return null;
  const profileId = optionalString(payload.profile_id);
  if (!profileId || payload.identity_change_confirmed !== true) return null;
  return {
    ...payload,
    confirmed_profile_id: profileId,
    expected_persona_id: scope.persona_id,
    expected_persona_epoch: scope.persona_epoch,
    expected_persona_fingerprint: scope.persona_fingerprint,
  };
}

export function enrichPersonaScopedPayload(
  payload: unknown,
  scope: PersonaScope | null,
): Record<string, unknown> | null {
  if (!isRecord(payload) || !scope) return null;
  return {
    ...payload,
    expected_persona_id: scope.persona_id,
    expected_persona_epoch: scope.persona_epoch,
    expected_persona_fingerprint: scope.persona_fingerprint,
  };
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return items.length ? items : undefined;
}

function optionalNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function payloadError(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = optionalString(payload.error);
  return error || null;
}

function nowUtc(): string {
  return new Date().toISOString();
}

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function makeChatMessage(
  role: ChatMessage['role'],
  content: string,
  id: string,
  options: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    role,
    content,
    id,
    created_at_utc: options.created_at_utc ?? nowUtc(),
    timestamp_status: options.timestamp_status ?? 'known',
    request_id: options.request_id ?? null,
    conversation_id: options.conversation_id ?? null,
    persona_id: options.persona_id ?? null,
    source: options.source ?? (role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system'),
    ...options,
  };
}

export function coerceDiaryEntries(payload: unknown): DiaryEntry[] {
  return extractArrayPayload(payload, ['entries', 'diaryEntries', 'items', 'data'])
    .filter(isRecord)
    .map((entry) => ({
      date: optionalString(entry.date) || '',
      title: optionalString(entry.title),
      content: optionalString(entry.content),
      mood: optionalString(entry.mood),
      is_locked: optionalBoolean(entry.is_locked) ?? optionalBoolean(entry.locked),
      peekable: optionalBoolean(entry.peekable),
      can_peek: optionalBoolean(entry.can_peek),
      status_label: optionalString(entry.status_label),
      key_available: optionalBoolean(entry.key_available),
      key_unlocked: optionalBoolean(entry.key_unlocked),
      emotions: optionalNumberRecord(entry.emotions),
    }))
    .filter((entry) => entry.date || entry.title || entry.content || entry.status_label);
}

export function coerceTimelinePosts(payload: unknown): TimelinePost[] {
  return extractArrayPayload(payload, ['posts', 'timelinePosts', 'items', 'data'])
    .filter(isRecord)
    .map((post) => ({
      id: optionalString(post.id),
      date: optionalString(post.date) || '',
      content: optionalString(post.content),
      mood: optionalString(post.mood),
      tags: optionalStringArray(post.tags),
      event_id: optionalString(post.event_id),
      event_type: optionalString(post.event_type),
      sticker_ref: optionalString(post.sticker_ref),
      sticker_text: optionalString(post.sticker_text),
      sticker_data_url: optionalString(post.sticker_data_url),
      media_url: optionalString(post.media_url),
      media_kind: optionalString(post.media_kind),
      creative_ref: optionalString(post.creative_ref),
      creative_title: optionalString(post.creative_title),
      visual_stage: optionalString(post.visual_stage),
      visual_prompt: optionalString(post.visual_prompt),
      emotions: optionalNumberRecord(post.emotions),
      comments: Array.isArray(post.comments)
        ? post.comments.filter(isRecord).map((comment) => ({
          id: optionalString(comment.id) || `${optionalString(comment.author_name) || 'comment'}-${String(comment.created_at || '')}`,
          author_id: optionalString(comment.author_id),
          author_name: optionalString(comment.author_name) || '朋友',
          content: optionalString(comment.content) || '',
          created_at: typeof comment.created_at === 'number' && Number.isFinite(comment.created_at)
            ? comment.created_at
            : undefined,
          provenance: optionalString(comment.provenance),
        })).filter((comment) => comment.content)
        : undefined,
    }))
    .filter((post) => post.date || post.content || post.tags?.length || post.event_id);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function coerceAmbientState(payload: unknown): AmbientState {
  const record = isRecord(payload) ? payload : {};
  const traces = Array.isArray(record.traces)
    ? record.traces.filter(isRecord).map((trace) => ({
      id: optionalString(trace.id) || `${optionalString(trace.kind) || 'trace'}-${String(trace.occurred_at || '')}`,
      kind: optionalString(trace.kind) || 'trace',
      title: optionalString(trace.title) || '房间有一点变化',
      body: optionalString(trace.body) || '',
      occurred_at: optionalString(trace.occurred_at),
      seen: optionalBoolean(trace.seen),
    })).filter((trace) => trace.body || trace.title)
    : [];
  const stickyRecord = isRecord(record.latest_sticky) ? record.latest_sticky : null;
  const sticky = stickyRecord
    ? traces.find((trace) => trace.id === optionalString(stickyRecord.id))
      || {
        id: optionalString(stickyRecord.id) || 'sticky',
        kind: 'sticky_note',
        title: optionalString(stickyRecord.title) || '留在桌边的便笺',
        body: optionalString(stickyRecord.body) || '',
        occurred_at: optionalString(stickyRecord.occurred_at),
      }
    : null;
  return {
    book_page: Math.max(1, Math.round(finiteNumber(record.book_page, 12))),
    book_total: Math.max(2, Math.round(finiteNumber(record.book_total, 320))),
    traces,
    latest_sticky: sticky,
    pending_thoughts: Math.max(0, Math.round(finiteNumber(record.pending_thoughts))),
    happy_streak: Math.max(0, Math.round(finiteNumber(record.happy_streak))),
  };
}

export function coerceApiBudget(payload: unknown): ApiBudgetState {
  const record = isRecord(payload) ? payload : {};
  const background = isRecord(record.background) ? record.background : {};
  const byPurpose = Array.isArray(record.by_purpose)
    ? record.by_purpose.filter(isRecord).map((item) => ({
      purpose: optionalString(item.purpose) || '未标记用途',
      requests: Math.max(0, Math.round(finiteNumber(item.requests))),
      measured_tokens: Math.max(0, Math.round(finiteNumber(item.measured_tokens))),
    }))
    : [];
  return {
    tracking_enabled: optionalBoolean(record.tracking_enabled) ?? false,
    background_enforced: optionalBoolean(record.background_enforced),
    requests: Math.max(0, Math.round(finiteNumber(record.requests))),
    succeeded: Math.max(0, Math.round(finiteNumber(record.succeeded))),
    failed: Math.max(0, Math.round(finiteNumber(record.failed))),
    prompt_tokens: Math.max(0, Math.round(finiteNumber(record.prompt_tokens))),
    completion_tokens: Math.max(0, Math.round(finiteNumber(record.completion_tokens))),
    estimated_unreported_tokens: Math.max(0, Math.round(finiteNumber(record.estimated_unreported_tokens))),
    background: {
      requests: Math.max(0, Math.round(finiteNumber(background.requests))),
      request_budget: Math.max(1, Math.round(finiteNumber(background.request_budget, 1))),
      tokens: Math.max(0, Math.round(finiteNumber(background.tokens))),
      token_budget: Math.max(1, Math.round(finiteNumber(background.token_budget, 1))),
    },
    by_purpose: byPurpose,
    currency_note: optionalString(record.currency_note),
    error: optionalString(record.error),
  };
}

export function coerceGroupState(payload: unknown): GroupState {
  const record = isRecord(payload) ? payload : {};
  const characters = Array.isArray(record.characters)
    ? record.characters.filter(isRecord).map((item) => ({
      id: optionalString(item.id) || optionalString(item.name) || 'character',
      name: optionalString(item.name) || '未命名角色',
      role: optionalString(item.role),
    }))
    : [];
  const threads = Array.isArray(record.threads)
    ? record.threads.filter(isRecord).map((thread) => ({
      id: optionalString(thread.id) || 'local-friends',
      title: optionalString(thread.title) || '我们的小群',
      members: Array.isArray(thread.members)
        ? thread.members.filter(isRecord).map((member) => ({
          id: optionalString(member.id) || optionalString(member.name) || 'member',
          name: optionalString(member.name) || '未命名角色',
          role: optionalString(member.role),
        }))
        : [],
      messages: Array.isArray(thread.messages)
        ? thread.messages.filter(isRecord).map((message) => ({
          id: optionalString(message.id) || `group-${String(message.created_at || '')}`,
          sender_id: optionalString(message.sender_id) || 'unknown',
          sender_name: optionalString(message.sender_name) || '未知',
          content: optionalString(message.content) || '',
          created_at: finiteNumber(message.created_at),
          kind: optionalString(message.kind) || 'character',
          provenance: optionalString(message.provenance),
        })).filter((message) => message.content)
        : [],
    }))
    : [];
  return {
    enabled: optionalBoolean(record.enabled) ?? false,
    threads,
    characters,
    simulation_notice: optionalString(record.simulation_notice)
      || '这是保存在本机的角色世界模拟，不代表真实人物或外部账号正在通信。',
    error: optionalString(record.error),
  };
}

export function coerceKeepsakes(payload: unknown): KeepsakeItem[] {
  return extractArrayPayload(payload, ['items', 'keepsakes', 'data'])
    .filter(isRecord)
    .map((item) => ({
      id: optionalString(item.id) || `${optionalString(item.title) || 'keepsake'}-${optionalString(item.created_at) || ''}`,
      kind: optionalString(item.kind) || 'text',
      title: optionalString(item.title) || '一段回忆',
      content: optionalString(item.content),
      source_path: optionalString(item.source_path),
      media_data_url: optionalString(item.media_data_url),
      tags: optionalStringArray(item.tags),
      created_at: optionalString(item.created_at),
      last_recalled_at: optionalString(item.last_recalled_at) || null,
      importance: typeof item.importance === 'number' && Number.isFinite(item.importance)
        ? item.importance
        : undefined,
    }))
    .filter((item) => item.id || item.title || item.content);
}

export function coerceStickers(payload: unknown): StickerItem[] {
  return extractArrayPayload(payload, ['items', 'stickers', 'data'])
    .filter(isRecord)
    .map((item) => ({
      id: optionalString(item.id) || `${optionalString(item.text) || 'sticker'}-${optionalString(item.last_used) || ''}`,
      text: optionalString(item.text) || '',
      emotions: optionalStringArray(item.emotions) || ['joy'],
      source: optionalString(item.source),
      usage_count: typeof item.usage_count === 'number' && Number.isFinite(item.usage_count)
        ? item.usage_count
        : undefined,
      last_used: optionalString(item.last_used),
      image_path: optionalString(item.image_path),
      image_data_url: optionalString(item.image_data_url),
      style_tags: optionalStringArray(item.style_tags),
      favorite_score: typeof item.favorite_score === 'number' && Number.isFinite(item.favorite_score)
        ? item.favorite_score
        : undefined,
    }))
    .filter((item) => item.id && (item.text || item.image_data_url || item.image_path));
}

function coerceSticker(payload: unknown): StickerItem | null {
  if (!isRecord(payload)) return null;
  return coerceStickers({ items: [payload] })[0] ?? null;
}

// ── Hook ──────────────────────────────────────────────

function showBrowserNotification(text: string): void {
  try {
    if (typeof window === 'undefined') return;
    if (!document.hidden) return;
    if (window.electronAPI?.showNotification) {
      void window.electronAPI.showNotification('Reverie', text.slice(0, 500));
      return;
    }
    if (typeof Notification === 'undefined') return;
    const fire = () => new Notification('Reverie', { body: text.slice(0, 120) });
    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission === 'default') {
      Notification.requestPermission()
        .then((permission) => {
          if (permission === 'granted') fire();
        })
        .catch(() => undefined);
    }
  } catch {
    // Notification failures must never break chat rendering.
  }
}

export function useReverieWS(wsUrl?: string) {
  const wsRef = useRef<BridgeSocketLike | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(false);
  const connectAttemptRef = useRef(0);
  const authenticatedRef = useRef(false);
  const authPhaseRef = useRef<BridgeAuthPhase>('idle');
  const handlerRef = useRef<Map<string, Set<(payload: any) => void>>>(new Map());
  const pendingRequestRef = useRef(new Map<string, {
    expectedTypes: ReadonlySet<string>;
    timer: ReturnType<typeof setTimeout>;
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
  }>());
  const messageIdSeq = useRef(0);
  const personaScopeRef = useRef<PersonaScope | null>(null);
  const localModeOperationRef = useRef(false);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [personaScope, setPersonaScope] = useState<PersonaScope | null>(null);
  const [localMode, setLocalModeState] = useState(false);
  const [localModePending, setLocalModePending] = useState(false);
  const [localModeAvailable, setLocalModeAvailable] = useState(false);
  const [localModeReason, setLocalModeReason] = useState('');

  const rememberPersonaScope = useCallback((payload: unknown) => {
    const scope = coercePersonaScope(payload);
    if (!scope) return false;
    personaScopeRef.current = scope;
    setPersonaScope(scope);
    return true;
  }, []);

  const applyAuthoritativeLocalMode = useCallback((payload: unknown) => {
    const snapshot = coerceAuthoritativeLocalModeState(payload);
    if (!snapshot) return null;
    setLocalModeState(snapshot.enabled);
    setLocalModeAvailable(snapshot.available);
    setLocalModeReason(snapshot.reason);
    setLocalModePending(snapshot.transitioning || localModeOperationRef.current);
    return snapshot;
  }, []);

  const rejectPendingRequests = useCallback((reason: string) => {
    const error = new Error(reason);
    for (const pending of pendingRequestRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequestRef.current.clear();
  }, []);

  // ── 连接管理 ──────────────────────────────────────

  useEffect(() => {
    const api = window.electronAPI?.localMode;
    if (!api) {
      setLocalModeAvailable(false);
      setLocalModeReason('Authoritative desktop local mode is unavailable');
      return undefined;
    }
    let disposed = false;
    const apply = (payload: unknown) => {
      if (disposed) return;
      if (!applyAuthoritativeLocalMode(payload)) {
        setLocalModeAvailable(false);
        setLocalModeReason('The authoritative local-mode state was invalid');
      }
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = api.onChanged(apply);
      void api.get()
        .then(apply)
        .catch(() => {
          if (disposed) return;
          setLocalModeAvailable(false);
          setLocalModeReason('Could not read authoritative local-mode state');
        });
    } catch {
      setLocalModeAvailable(false);
      setLocalModeReason('Could not subscribe to authoritative local-mode state');
    }
    return () => {
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
        // The owning desktop module may already have been disposed.
      }
    };
  }, [applyAuthoritativeLocalMode]);

  const connect = useCallback(async () => {
    if (!mountedRef.current) return;
    const currentState = wsRef.current?.readyState;
    if (currentState === WebSocket.OPEN || currentState === WebSocket.CONNECTING) return;
    const attempt = connectAttemptRef.current + 1;
    connectAttemptRef.current = attempt;
    setConnState('connecting');
    let connection: BridgeConnectionConfig | null = null;
    try {
      if (window.electronAPI?.bridge?.getConnectionConfig) {
        connection = await window.electronAPI.bridge.getConnectionConfig();
      } else if (import.meta.env.DEV && wsUrl) {
        // Explicit URLs are reserved for isolated browser tests/development.
        connection = { url: wsUrl, secret: '', protocolVersion: 4 };
      }
    } catch {
      connection = null;
    }
    if (!mountedRef.current || attempt !== connectAttemptRef.current) return;
    if (!connection?.url || connection.protocolVersion !== 4) {
      setConnState('unavailable');
      return;
    }
    let ws: BridgeSocketLike;
    if (isElectronIpcBridge(connection) && window.electronAPI?.bridge) {
      ws = new ElectronBridgeSocket(window.electronAPI.bridge, connection);
    } else if (import.meta.env.DEV) {
      ws = new WebSocket(connection.url);
    } else {
      setConnState('unavailable');
      return;
    }
    wsRef.current = ws;
    authenticatedRef.current = false;
    authPhaseRef.current = 'idle';

    ws.onopen = () => {
      if (!mountedRef.current || wsRef.current !== ws) {
        ws.close();
        return;
      }
      authPhaseRef.current = 'awaiting_auth';
      setConnState('authenticating');
      ws.send(JSON.stringify({
        type: WSMsgType.BRIDGE_AUTH,
        payload: {
          secret: connection.secret,
          protocol_version: connection.protocolVersion,
          origin: connection.origin,
        },
      }));
    };

    ws.onmessage = (event) => {
      try {
        if (!mountedRef.current || wsRef.current !== ws) return;
        const parsed: unknown = JSON.parse(event.data);
        if (!isRecord(parsed) || typeof parsed.type !== 'string' || parsed.type.length > 80) {
          throw new Error('invalid bridge frame');
        }
        if (
          parsed.request_id !== undefined
          && (
            typeof parsed.request_id !== 'string'
            || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.request_id)
          )
        ) {
          throw new Error('invalid bridge request id');
        }
        const msg: WSMessage = {
          type: parsed.type,
          payload: parsed.payload,
          ...(typeof parsed.request_id === 'string'
            ? { request_id: parsed.request_id }
            : {}),
        };
        const transition = transitionBridgeAuth(authPhaseRef.current, msg.type);
        authPhaseRef.current = transition.phase;
        if (transition.action === 'accept_auth') {
          if (
            !isRecord(msg.payload)
            || msg.payload.protocol_version !== 4
            || !optionalString(msg.payload.client_id)
          ) {
            throw new Error('invalid bridge authentication response');
          }
          authenticatedRef.current = true;
          rememberPersonaScope(msg.payload);
          setConnState('connected');
          INITIAL_STATE_REQUEST_TYPES.forEach((type) => {
            ws.send(JSON.stringify({ type, payload: {} }));
          });
          return;
        }
        if (transition.action === 'reject') {
          authenticatedRef.current = false;
          setConnState('unavailable');
          rejectPendingRequests('Bridge authentication was rejected');
          ws.close(
            msg.type === WSMsgType.BRIDGE_AUTH_ERROR ? 4003 : 1002,
            msg.type === WSMsgType.BRIDGE_AUTH_ERROR
              ? 'bridge authentication failed'
              : 'unexpected bridge authentication frame',
          );
          return;
        }
        if (msg.request_id) {
          const pending = pendingRequestRef.current.get(msg.request_id);
          if (!pending) return;
          const action = classifyCorrelatedResponse(
            msg.request_id,
            pending.expectedTypes,
            msg,
          );
          if (action === 'ignore') return;
          pendingRequestRef.current.delete(msg.request_id);
          clearTimeout(pending.timer);
          if (action === 'error') {
            const detail = isRecord(msg.payload)
              ? optionalString(msg.payload.message) || optionalString(msg.payload.error)
              : undefined;
            pending.reject(new Error(detail || 'Bridge request failed'));
          } else {
            pending.resolve(msg.payload);
          }
          return;
        }
        const handlers = handlerRef.current.get(msg.type);
        if (handlers) {
          handlers.forEach((fn) => {
            try {
              fn(msg.payload);
            } catch {
              // A malformed optional-module payload must not tear down the
              // authenticated bridge or interrupt persona/chat continuity.
              console.error(`[Reverie bridge] subscriber failed for ${msg.type}`);
            }
          });
        }
      } catch {
        authenticatedRef.current = false;
        authPhaseRef.current = 'failed';
        setConnState('unavailable');
        rejectPendingRequests('The bridge sent an invalid frame');
        ws.close(1002, 'invalid bridge frame');
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      authenticatedRef.current = false;
      authPhaseRef.current = 'idle';
      rejectPendingRequests('The bridge connection closed');
      if (!mountedRef.current) return;
      setConnState((current) => current === 'unavailable' ? current : 'disconnected');
      reconnectTimer.current = setTimeout(() => void connect(), 5000);
    };

    ws.onerror = () => {
      // A single rejected frame must not close the bridge. Genuine loss is
      // reported by onChanged(ready=false) for the IPC transport and by the
      // browser calling onclose after a transport-level error in dev mode.
    };
  }, [rejectPendingRequests, rememberPersonaScope, wsUrl]);

  useEffect(() => {
    mountedRef.current = true;
    void connect();
    return () => {
      mountedRef.current = false;
      connectAttemptRef.current += 1;
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
      const ws = wsRef.current;
      wsRef.current = null;
      authenticatedRef.current = false;
      authPhaseRef.current = 'idle';
      rejectPendingRequests('The bridge connection was disposed');
      ws?.close();
    };
  }, [connect, rejectPendingRequests]);

  useEffect(() => {
    const api = window.electronAPI?.bridge;
    if (!api?.onChanged) return undefined;
    return api.onChanged((state) => {
      if (state?.ready === true) {
        void connect();
        return;
      }
      wsRef.current?.close(1011, 'bridge unavailable');
    });
  }, [connect]);

  // ── 发送消息 ──────────────────────────────────────

  const sendEnvelope = useCallback((
    type: string,
    payload: any = {},
    requestId = '',
  ) => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN
      && (authenticatedRef.current || type === WSMsgType.BRIDGE_AUTH)
    ) {
      let outboundPayload = payload;
      if (type === WSMsgType.PERSONA_ACTIVATE) {
        outboundPayload = enrichPersonaActivationPayload(payload, personaScopeRef.current);
        if (!outboundPayload) return false;
      } else if (type !== WSMsgType.BRIDGE_AUTH && personaScopeRef.current) {
        outboundPayload = enrichPersonaScopedPayload(payload, personaScopeRef.current);
        if (!outboundPayload) return false;
      }
      try {
        wsRef.current.send(JSON.stringify({
          type,
          payload: outboundPayload,
          ...(requestId ? { request_id: requestId } : {}),
        }));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const send = useCallback((type: string, payload: any = {}) => (
    sendEnvelope(type, payload)
  ), [sendEnvelope]);

  const request = useCallback(<T = unknown>(
    type: string,
    payload: any,
    options: WSRequestOptions,
  ): Promise<T> => {
    const expected = Array.isArray(options.expectedType)
      ? options.expectedType
      : [options.expectedType];
    const expectedTypes = new Set(
      expected.filter((value): value is string => (
        typeof value === 'string' && value.length > 0 && value.length <= 80
      )),
    );
    if (!expectedTypes.size) {
      return Promise.reject(new Error('A bridge request requires an expected response type'));
    }
    const requestedTimeout = typeof options.timeout === 'number' && Number.isFinite(options.timeout)
      ? options.timeout
      : 8_000;
    const timeout = Math.min(60_000, Math.max(250, Math.round(requestedTimeout)));
    const requestId = `rpc_${newRequestId()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pendingRequestRef.current.delete(requestId)) return;
        reject(new Error(`Bridge request timed out after ${timeout} ms`));
      }, timeout);
      pendingRequestRef.current.set(requestId, {
        expectedTypes,
        timer,
        resolve: (result) => resolve(result as T),
        reject,
      });
      if (!sendEnvelope(type, payload, requestId)) {
        pendingRequestRef.current.delete(requestId);
        clearTimeout(timer);
        reject(new Error('The authenticated bridge is unavailable'));
      }
    });
  }, [sendEnvelope]);

  // ── 事件订阅 ──────────────────────────────────────

  const subscribe = useCallback((type: string, handler: (payload: any) => void) => {
    if (!handlerRef.current.has(type)) {
      handlerRef.current.set(type, new Set());
    }
    handlerRef.current.get(type)!.add(handler);
    return () => {
      handlerRef.current.get(type)?.delete(handler);
    };
  }, []);

  // ── 便利方法 ──────────────────────────────────────

  const sendChat = useCallback((
    text: string,
    sticker?: StickerItem,
    suppliedRequestId?: string,
  ): string | null => {
    const requestId = suppliedRequestId || newRequestId();
    const sentAtUtc = nowUtc();
    const payload = {
      text,
      request_id: requestId,
      conversation_id: 'dream-room',
      persona_id: null,
      sent_at_utc: sentAtUtc,
      ...(sticker ? { sticker } : {}),
    };
    return send(WSMsgType.CHAT_SEND, payload) ? requestId : null;
  }, [send]);
  const cancelChat = useCallback((requestId: string) => (
    send(WSMsgType.CHAT_CANCEL, { request_id: requestId })
  ), [send]);
  const revealChat = useCallback((requestId: string) => (
    send(WSMsgType.CHAT_REVEAL, { request_id: requestId })
  ), [send]);
  const setLocalMode = useCallback(async (enabled: boolean): Promise<boolean> => {
    const api = window.electronAPI?.localMode;
    if (!api || localModeOperationRef.current) return false;
    localModeOperationRef.current = true;
    setLocalModePending(true);
    try {
      const snapshot = applyAuthoritativeLocalMode(await api.set(enabled));
      return Boolean(
        snapshot
        && snapshot.available
        && !snapshot.transitioning
        && snapshot.enabled === enabled,
      );
    } catch {
      try {
        applyAuthoritativeLocalMode(await api.get());
      } catch {
        setLocalModeAvailable(false);
        setLocalModeReason('Could not verify authoritative local-mode state');
      }
      return false;
    } finally {
      localModeOperationRef.current = false;
      setLocalModePending(false);
    }
  }, [applyAuthoritativeLocalMode]);
  const stopChat = useCallback((): boolean => {
    const generating = Object.entries(chatRequestStates).find(
      ([, request]) => request.state === 'generating',
    );
    if (!generating) return false;
    return send(WSMsgType.CHAT_STOP, { request_id: generating[0] });
  }, [send, chatRequestStates]);
  const queryMemory = useCallback((query: string, topK = 10) => send(WSMsgType.MEMORY_QUERY, { query, top_k: topK }), [send]);
  const storeMemory = useCallback((text: string, layer: 'long_term' | 'short_term') =>
    send(WSMsgType.MEMORY_STORE, { text, layer }), [send]);
  const getRandomImage = useCallback((mode: 'sfw' | 'nsfw' | 'random' = 'sfw') => send(WSMsgType.IMAGE_RANDOM, { mode }), [send]);
  const refreshDiary = useCallback(() => send(WSMsgType.DIARY_REQUEST, {}), [send]);
  const refreshTimeline = useCallback(() => send(WSMsgType.TIMELINE_REQUEST, {}), [send]);
  const refreshAmbient = useCallback(() => send(WSMsgType.AMBIENT_GET, {}), [send]);
  const refreshApiBudget = useCallback(() => send(WSMsgType.API_BUDGET_GET, {}), [send]);
  const refreshGroup = useCallback(() => send(WSMsgType.GROUP_REQUEST, {}), [send]);
  const sendGroupMessage = useCallback((text: string, threadId = 'local-friends') => (
    send(WSMsgType.GROUP_SEND, { text, thread_id: threadId })
  ), [send]);
  const unlockDiaryKey = useCallback((hostDate: string) => (
    send(WSMsgType.DIARY_REQUEST, { action: 'unlock_key', host_date: hostDate })
  ), [send]);
  const readDiaryEntry = useCallback((date: string) => (
    send(WSMsgType.DIARY_REQUEST, { action: 'read', date })
  ), [send]);
  const refreshKeepsakes = useCallback(() => send(WSMsgType.KEEPSAKE_LIST, {}), [send]);
  const refreshStickers = useCallback(() => send(WSMsgType.STICKER_LIST, {}), [send]);
  const exportBackup = useCallback(() => send(WSMsgType.BACKUP_EXPORT, {}), [send]);
  const importBackup = useCallback((backup: Record<string, unknown>, replaceMemory = true) =>
    send(WSMsgType.BACKUP_IMPORT, { backup, replace_memory: replaceMemory }), [send]);
  const collectSticker = useCallback((payload: {
    text?: string;
    emotions?: string[];
    style_tags?: string[];
    image_data_url?: string;
  }) => send(WSMsgType.STICKER_COLLECT, payload), [send]);
  const reactSticker = useCallback((id: string, liked = true) =>
    send(WSMsgType.STICKER_REACT, { id, liked }), [send]);

  // ── 状态存储 ──────────────────────────────────────

  const [emotions, setEmotions] = useState<Record<string, number>>({});
  const [persona, setPersona] = useState<any>(null);
  const [relationship, setRelationship] = useState<RelationshipData>({ intimacy: 0, stage: '初识期' });
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatRequestStates, setChatRequestStates] = useState<Record<string, ChatRequestState>>({});
  const v2RequestsSeenRef = useRef(new Set<string>());
  const revealSentRef = useRef(new Set<string>());
  const [isTyping, setIsTyping] = useState(false);
  const [currentChunk, setCurrentChunk] = useState('');
  // Mirror of currentChunk kept outside the render cycle. CHAT_CHUNK writes
  // both the ref (authoritative) and the state (render); CHAT_DONE reads the
  // ref so no state-updater side effect is needed, which keeps every updater
  // pure (React StrictMode double-invokes updaters).
  const currentChunkRef = useRef('');
  const [chatPresence, setChatPresence] = useState<ChatPresence>({
    status: 'online',
    label: '在线',
    is_available: true,
  });
  const [diaryEntries, setDiaryEntries] = useState<DiaryEntry[]>([]);
  const [timelinePosts, setTimelinePosts] = useState<TimelinePost[]>([]);
  const [ambient, setAmbient] = useState<AmbientState>(() => coerceAmbientState({}));
  const [apiBudget, setApiBudget] = useState<ApiBudgetState>(() => coerceApiBudget({}));
  const [groupState, setGroupState] = useState<GroupState>(() => coerceGroupState({}));
  const [keepsakes, setKeepsakes] = useState<KeepsakeItem[]>([]);
  const [stickers, setStickers] = useState<StickerItem[]>([]);
  const [diaryError, setDiaryError] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [runtimeActivity, setRuntimeActivity] = useState<RuntimeActivity>({
    diary_writing: false,
    timeline_revision: '',
  });
  const [settingsSnapshot, setSettingsSnapshot] = useState<AuthoritativeSettingsSnapshot>({});

  useEffect(() => {
    if (connState === 'disconnected') {
      setRuntimeActivity((current) => ({ ...current, diary_writing: false }));
    }
  }, [connState]);

  const nextMessageId = useCallback((prefix: string) => {
    messageIdSeq.current += 1;
    return `${prefix}_${Date.now()}_${messageIdSeq.current}`;
  }, []);

  // 订阅后端推送
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    const subscribeResult = (type: string, handler: (payload: any) => void) => {
      responseTypesFor(type).forEach((resultType) => unsubs.push(subscribe(resultType, handler)));
    };

    subscribeResult(WSMsgType.EMOTION_UPDATE, (p: EmotionState) => setEmotions(p.emotions || {}));
    subscribeResult(WSMsgType.PERSONA_DATA, (p: PersonaData) => {
      setPersona(p.persona);
      rememberPersonaScope(p);
    });
    subscribeResult(WSMsgType.RELATIONSHIP_DATA, (p: RelationshipData) => setRelationship(p));
    subscribeResult(WSMsgType.CHAT_HISTORY_RESULT, (payload: unknown) => {
      const items = extractArrayPayload(payload, ['items', 'messages', 'data']);
      setChatMessages(migrateChatMessages(items) as ChatMessage[]);
    });
    subscribeResult(WSMsgType.DIARY_RESULT, (p: unknown) => {
      const error = payloadError(p);
      setDiaryError(error);
      const directEntry = isRecord(p) && isRecord(p.entry)
        ? coerceDiaryEntries({ entries: [p.entry] })[0]
        : undefined;
      if (directEntry) {
        setDiaryEntries((current) => {
          const remaining = current.filter((entry) => entry.date !== directEntry.date);
          const next = [...remaining, directEntry];
          return next;
        });
        window.setTimeout(() => send(WSMsgType.DIARY_REQUEST, {}), 0);
        return;
      }
      const entries = coerceDiaryEntries(p);
      if (entries.length || !error) {
        setDiaryEntries(entries);
      }
      if (isRecord(p) && typeof p.writing === 'boolean') {
        setRuntimeActivity((current) => ({ ...current, diary_writing: p.writing as boolean }));
      }
    });
    subscribeResult(WSMsgType.TIMELINE_RESULT, (p: unknown) => {
      const error = payloadError(p);
      setTimelineError(error);
      const posts = coerceTimelinePosts(p);
      if (posts.length || !error) {
        setTimelinePosts(posts);
      }
    });
    subscribeResult(WSMsgType.AMBIENT_RESULT, (p: unknown) => setAmbient(coerceAmbientState(p)));
    subscribeResult(WSMsgType.API_BUDGET_RESULT, (p: unknown) => setApiBudget(coerceApiBudget(p)));
    subscribeResult(WSMsgType.GROUP_RESULT, (p: unknown) => setGroupState(coerceGroupState(p)));
    subscribeResult(WSMsgType.KEEPSAKE_RESULT, (p: unknown) => {
      setKeepsakes(coerceKeepsakes(p));
    });
    subscribeResult(WSMsgType.STICKER_DATA, (p: unknown) => {
      setStickers(coerceStickers(p));
    });
    subscribeResult(WSMsgType.SETTINGS_GET_RESULT, (payload: unknown) => {
      if (!isRecord(payload) || payload.ok === false) return;
      setSettingsSnapshot({
        chat: isRecord(payload.chat) ? payload.chat : undefined,
        memory: isRecord(payload.memory) ? payload.memory : undefined,
        features: isRecord(payload.features) ? payload.features : undefined,
        ui: isRecord(payload.ui)
          ? payload.ui as AuthoritativeSettingsSnapshot['ui']
          : undefined,
        llm: isRecord(payload.llm)
          ? payload.llm as AuthoritativeSettingsSnapshot['llm']
          : undefined,
      });
    });
    subscribeResult(WSMsgType.SETTINGS_UPDATE_RESULT, (payload: unknown) => {
      if (!isRecord(payload) || payload.ok !== true) return;
      setSettingsSnapshot((current) => ({
        ...current,
        ...(isRecord(payload.chat) ? { chat: payload.chat } : {}),
        ...(isRecord(payload.settings) ? { memory: payload.settings } : {}),
        ...(isRecord(payload.features) ? { features: payload.features } : {}),
        ...(isRecord(payload.ui) ? { ui: payload.ui as AuthoritativeSettingsSnapshot['ui'] } : {}),
        ...(isRecord(payload.llm) ? { llm: payload.llm as AuthoritativeSettingsSnapshot['llm'] } : {}),
      }));
    });
    unsubs.push(subscribe(WSMsgType.RUNTIME_ACTIVITY, (payload: unknown) => {
      if (!isRecord(payload)) return;
      setRuntimeActivity((current) => ({
        diary_writing: typeof payload.diary_writing === 'boolean'
          ? payload.diary_writing
          : current.diary_writing,
        timeline_revision: typeof payload.timeline_revision === 'string'
          ? payload.timeline_revision
          : current.timeline_revision,
      }));
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_STATE, (payload: ChatStatePayload) => {
      const requestId = optionalString(payload?.request_id);
      const rawState = optionalString(payload?.state) || optionalString(payload?.status);
      if (!requestId || !rawState) return;
      const acceptedStates: ChatDeliveryState[] = [
        'queued',
        'generating',
        'ready_waiting',
        'delivering',
        'done',
        'cancelled',
        'failed',
        'failed_uncertain',
        'error',
      ];
      if (!acceptedStates.includes(rawState as ChatDeliveryState)) return;
      const state = rawState as ChatDeliveryState;
      v2RequestsSeenRef.current.add(requestId);
      setChatRequestStates((current) => upsertRequestState(current, {
        request_id: requestId,
        conversation_id: optionalString(payload.conversation_id) || 'dream-room',
        persona_id: optionalString(payload.persona_id) || null,
        state,
        label: optionalString(payload.label),
        error: optionalString(payload.error),
        updated_at_utc: optionalString(payload.updated_at_utc) || nowUtc(),
      }));
      setChatMessages((current) => {
        let changed = false;
        const next = current.map((message) => {
          if (message.request_id !== requestId || message.delivery_state === state) return message;
          changed = true;
          return {
            ...message,
            delivery_state: state,
            ...(payload.error ? { error: payload.error } : {}),
          };
        });
        return changed ? next : current;
      });
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_ERROR, (payload: ChatStatePayload) => {
      const requestId = optionalString(payload?.request_id);
      if (!requestId) return;
      v2RequestsSeenRef.current.add(requestId);
      setChatRequestStates((current) => upsertRequestState(current, {
        request_id: requestId,
        conversation_id: optionalString(payload.conversation_id) || 'dream-room',
        persona_id: optionalString(payload.persona_id) || null,
        state: 'failed',
        label: optionalString(payload.label),
        error: optionalString(payload.error) || '生成失败',
        updated_at_utc: optionalString(payload.updated_at_utc) || nowUtc(),
      }));
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_TYPING, (payload: ChatTypingPayload) => {
      // Legacy typing frames are display-only. "waiting" and "generating"
      // are not represented as the other person physically typing.
      const isActivelyTyping = payload?.status === 'typing' || payload?.status === 'delivering';
      setIsTyping(isActivelyTyping);
      currentChunkRef.current = '';
      setCurrentChunk('');
      const presence = payload?.presence;
      setChatPresence({
        status: isActivelyTyping
          ? 'typing'
          : ((presence?.status && presence.status !== 'typing' ? presence.status : 'online') as ChatPresence['status']),
        label: payload?.label || (isActivelyTyping ? '正在送达' : '在线'),
        is_available: presence?.is_available,
      });
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_CHUNK, (p: ChatChunk) => {
      currentChunkRef.current += p.text || '';
      setCurrentChunk(currentChunkRef.current);
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_BUBBLE, (payload: ChatBubble) => {
      const content = payload?.text?.trim();
      if (!content) return;
      currentChunkRef.current = '';
      setCurrentChunk('');
      setChatMessages((prev) => {
        if (
          payload.delivery_id
          && prev.some((message) => (
            message.deliveryId === payload.delivery_id
            && message.bubbleIndex === payload.index
          ))
        ) return prev;
        const next = [...prev, {
          ...makeChatMessage('assistant', content, nextMessageId('msg'), {
            created_at_utc: optionalString(payload.created_at_utc) || nowUtc(),
            request_id: optionalString(payload.request_id) || null,
            conversation_id: optionalString(payload.conversation_id) || 'dream-room',
            persona_id: optionalString(payload.persona_id) || null,
            source: 'assistant',
            delivery_state: 'delivering',
            delivery_id: payload.delivery_id,
            bubble_index: payload.index,
          }),
          deliveryId: payload.delivery_id,
          bubbleIndex: payload.index,
        }];
        return next;
      });
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_DONE, (payload: any) => {
      setIsTyping(false);
      const presence = payload?.scheduler_status;
      if (isRecord(presence)) {
        const status = optionalString(presence.status) as ChatPresence['status'] | undefined;
        setChatPresence({
          status: status && status !== 'typing' ? status : 'online',
          label: optionalString(presence.label) || '在线',
          is_available: optionalBoolean(presence.is_available),
        });
      }
      const chunk = currentChunkRef.current;
      const payloadMessages = Array.isArray(payload?.messages)
        ? payload.messages.map((item: unknown) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
        : [];
      const requestId = optionalString(payload?.request_id);
      const messages = payload?.incremental_delivery
        ? []
        : (payloadMessages.length ? payloadMessages : (chunk ? [chunk] : []));
      const sticker = coerceSticker(payload?.sticker);
      currentChunkRef.current = '';
      setCurrentChunk('');
      if (messages.length || sticker) {
        setChatMessages((prev) => {
          const deliveryId = optionalString(payload?.delivery_id);
          const shouldAddSticker = sticker && !(
            deliveryId
            && prev.some((message) => message.deliveryId === deliveryId && message.bubbleIndex === -1)
          );
          const next = [
            ...prev,
            ...messages.map((content: string) => ({
              ...makeChatMessage('assistant', content, nextMessageId('msg'), {
                request_id: requestId || null,
                conversation_id: optionalString(payload?.conversation_id) || 'dream-room',
                persona_id: optionalString(payload?.persona_id) || null,
                delivery_state: 'done',
              }),
            })),
            ...(shouldAddSticker ? [{
              ...makeChatMessage('assistant', sticker.text || '', nextMessageId('stk'), {
                request_id: requestId || null,
                conversation_id: optionalString(payload?.conversation_id) || 'dream-room',
                persona_id: optionalString(payload?.persona_id) || null,
                delivery_state: 'done',
                delivery_id: deliveryId,
                bubble_index: -1,
              }),
              sticker,
              deliveryId,
              bubbleIndex: -1,
            }] : []),
          ];
          return next;
        });
      }
    }));
    unsubs.push(subscribe(WSMsgType.CHAT_RETRACT, (payload: ChatRetractPayload) => {
      setChatMessages((prev) => {
        const next = [...prev];
        const exactIndex = payload?.delivery_id
          ? next.findIndex((message) => (
            message.role === 'assistant'
            && message.deliveryId === payload.delivery_id
            && message.bubbleIndex === payload.bubble_index
          ))
          : -1;
        if (exactIndex >= 0) {
          next.splice(exactIndex, 1);
        } else {
          for (let index = next.length - 1; index >= 0; index -= 1) {
            if (next[index].role === 'assistant' && next[index].bubbleIndex !== -1) {
              next.splice(index, 1);
              break;
            }
          }
        }
        const notice = payload?.notice || '对方撤回了一条消息';
        next.push(makeChatMessage('system', notice, nextMessageId('ret')));
        if (payload?.replacement?.trim()) {
          next.push(makeChatMessage('assistant', payload.replacement.trim(), nextMessageId('fix')));
        }
        return next;
      });
    }));
    unsubs.push(subscribe(WSMsgType.PROACTIVE_MESSAGE, (p: { text?: string; messages?: string[]; notify?: boolean }) => {
      const messages = Array.isArray(p.messages)
        ? p.messages.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
        : [p.text || ''].filter(Boolean);
      if (!messages.length) return;
      setChatMessages((prev) => {
        const next = [
          ...prev,
          ...messages.map((content) => makeChatMessage(
            'assistant',
            content,
            nextMessageId('pro'),
            { source: 'proactive' },
          )),
        ];
        return next;
      });
      if (p.notify) {
        showBrowserNotification(messages[0]);
      }
    }));
    return () => unsubs.forEach((u) => u());
  }, [nextMessageId, rememberPersonaScope, send, subscribe]);

  const addUserMessage = useCallback((
    text: string,
    sticker?: StickerItem,
    requestId: string | null = null,
  ) => {
    const id = nextMessageId('usr');
    setChatMessages((prev) => {
      const next = [...prev, makeChatMessage('user', text, id, {
        sticker,
        request_id: requestId,
        conversation_id: 'dream-room',
        delivery_state: requestId ? 'queued' : undefined,
      })];
      return next;
    });
  }, [nextMessageId]);

  const addLocalFocusMessage = useCallback((content: string, sessionId: string) => {
    const id = nextMessageId('focus');
    setChatMessages((prev) => {
      if (prev.some((message) => message.source === 'local_focus' && message.request_id === sessionId)) {
        return prev;
      }
      const next = [...prev, makeChatMessage('system', content, id, {
        source: 'local_focus',
        request_id: sessionId,
        conversation_id: 'dream-room',
        delivery_state: 'done',
      })];
      return next;
    });
  }, [nextMessageId]);

  const revealRequest = useCallback((requestId: string) => {
    if (revealSentRef.current.has(requestId)) return false;
    const request = chatRequestStates[requestId];
    if (!request || request.state !== 'ready_waiting' || request.reveal_sent) return false;
    revealSentRef.current.add(requestId);
    setChatRequestStates((current) => {
      return markRevealSent(current, requestId);
    });
    const sent = revealChat(requestId);
    if (!sent) {
      revealSentRef.current.delete(requestId);
      setChatRequestStates((current) => {
        const value = current[requestId];
        return value ? { ...current, [requestId]: { ...value, reveal_sent: false } } : current;
      });
    }
    return sent;
  }, [chatRequestStates, revealChat]);

  return {
    connState, send, request, subscribe,
    sendChat, cancelChat, revealChat: revealRequest, stopChat, setLocalMode, queryMemory, storeMemory, getRandomImage,
    refreshDiary, refreshTimeline, refreshAmbient, refreshApiBudget, refreshGroup,
    refreshKeepsakes, refreshStickers,
    sendGroupMessage, unlockDiaryKey, readDiaryEntry,
    exportBackup, importBackup,
    collectSticker, reactSticker,
    emotions, setEmotions,
    persona, setPersona, personaScope,
    relationship,
    chatPresence,
    diaryEntries, timelinePosts, ambient, apiBudget, groupState,
    runtimeActivity,
    settingsSnapshot,
    keepsakes, stickers,
    diaryError, timelineError,
    chatMessages, setChatMessages, chatRequestStates,
    localMode, localModePending, localModeAvailable, localModeReason,
    isTyping, currentChunk,
    addUserMessage, addLocalFocusMessage,
  };
}
