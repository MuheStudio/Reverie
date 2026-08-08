import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROTOCOL_VERSION,
  type MVPCommandName,
} from '@/contracts/protocolV4.generated';
import {
  ElectronBridgeSocket,
  isElectronIpcBridge,
  type BridgeSocketLike,
} from '@/lib/electronBridgeSocket';

const CONVERSATION_ID = 'dream-room';
const MAX_CHAT_TEXT = 20_000;
const RECONNECT_MS = 5_000;

const EVENT_NAMES = new Set([
  'chat:chunk',
  'chat:bubble',
  'chat:done',
  'chat:typing',
  'chat:state',
  'chat:error',
  'chat:retract',
  'chat:history:result',
  'emotion:update',
  'memory:result',
  'memory:settings:result',
  'memory:candidates:result',
  'group:result',
  'sticker:data',
  'persona:data',
  'relationship:data',
  'user:profile:result',
  'settings:update:result',
  'settings:get:result',
  'anti_ai:status:result',
  'error',
  'heartbeat',
]);

const INITIAL_COMMANDS: ReadonlyArray<readonly [MVPCommandName, Record<string, unknown>]> = [
  ['chat:history', { conversation_id: CONVERSATION_ID, limit: 300 }],
  ['emotion:get', {}],
  ['persona:get', {}],
  ['relationship:get', {}],
  ['user:profile:get', {}],
  ['anti_ai:status', {}],
  ['memory:settings:get', {}],
  ['memory:candidates:list', { status: 'pending', limit: 100 }],
  ['sticker:list', { limit: 100 }],
  ['settings:get', {}],
];

export type MvpConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unavailable';

export interface MvpChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAtUtc: string;
  requestId: string | null;
  deliveryState?: string;
  deliveryId?: string;
  bubbleIndex?: number;
  sticker?: Record<string, unknown> | null;
}

export interface MemoryCandidate {
  id: string;
  fact_key: string;
  proposed_text: string;
  source_text: string;
  source_type: string;
  source_uri: string;
  source_hash: string;
  confidence: number;
  status: 'pending' | 'confirmed' | 'rejected';
  created_at: number;
}

export interface ConfirmedMemory {
  id: string;
  text: string;
  fact_key: string;
  fact_revision: number;
  source_type: string;
  source_uri: string;
  source_hash: string;
  confirmation_state: 'confirmed';
  lifecycle_state: 'active';
  updated_at: number;
}

type Frame = {
  type: string;
  payload: unknown;
  request_id?: string;
};

type PendingResult = {
  expectedType: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function requestId(prefix = 'req'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function coerceChatMessage(value: unknown): MvpChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role;
  const content = stringValue(value.content);
  const id = stringValue(value.id);
  if (!['user', 'assistant', 'system'].includes(String(role)) || !content || !id) return null;
  return {
    id,
    role: role as MvpChatMessage['role'],
    content,
    createdAtUtc: stringValue(value.created_at_utc) || timestamp(),
    requestId: stringValue(value.request_id) || null,
    deliveryState: stringValue(value.delivery_state) || undefined,
    bubbleIndex: typeof value.bubble_index === 'number' ? value.bubble_index : undefined,
  };
}

function coerceCandidates(value: unknown): MemoryCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const status = stringValue(item.status);
    const proposed = stringValue(item.proposed_text);
    const source = stringValue(item.source_text);
    if (!/^mc_[a-f0-9]{32}$/.test(id)
      || !['pending', 'confirmed', 'rejected'].includes(status)
      || !proposed
      || !source) return [];
    return [{
      id,
      fact_key: stringValue(item.fact_key),
      proposed_text: proposed,
      source_text: source,
      source_type: stringValue(item.source_type),
      source_uri: stringValue(item.source_uri),
      source_hash: stringValue(item.source_hash),
      confidence: typeof item.confidence === 'number' ? item.confidence : 0,
      status: status as MemoryCandidate['status'],
      created_at: typeof item.created_at === 'number' ? item.created_at : 0,
    }];
  });
}

function coerceConfirmedMemories(value: unknown): ConfirmedMemory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const memoryText = stringValue(item.text);
    if (!id || !memoryText
      || item.confirmation_state !== 'confirmed'
      || item.lifecycle_state !== 'active') return [];
    return [{
      id,
      text: memoryText,
      fact_key: stringValue(item.fact_key),
      fact_revision: typeof item.fact_revision === 'number' ? item.fact_revision : 0,
      source_type: stringValue(item.source_type),
      source_uri: stringValue(item.source_uri),
      source_hash: stringValue(item.source_hash),
      confirmation_state: 'confirmed' as const,
      lifecycle_state: 'active' as const,
      updated_at: typeof item.updated_at === 'number' ? item.updated_at : 0,
    }];
  });
}

export function useMvpBridge() {
  const socketRef = useRef<BridgeSocketLike | null>(null);
  const mountedRef = useRef(false);
  const authenticatedRef = useRef(false);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();
  const connectRef = useRef<() => void>(() => undefined);
  const memoryRequestKindRef = useRef(new Map<string, 'list' | 'query' | 'edit' | 'delete' | 'store'>());
  const pendingResultsRef = useRef(new Map<string, PendingResult>());
  const [connection, setConnection] = useState<MvpConnectionState>('connecting');
  const [messages, setMessages] = useState<MvpChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [persona, setPersona] = useState<Record<string, unknown> | null>(null);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<Record<string, unknown>>({});
  const [emotions, setEmotions] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [userProfile, setUserProfile] = useState<Record<string, unknown> | null>(null);
  const [memorySettings, setMemorySettings] = useState<Record<string, unknown>>({});
  const [memoryCandidates, setMemoryCandidates] = useState<MemoryCandidate[]>([]);
  const [confirmedMemories, setConfirmedMemories] = useState<ConfirmedMemory[]>([]);
  const [memoryResults, setMemoryResults] = useState<Record<string, unknown>[]>([]);
  const [groupState, setGroupState] = useState<Record<string, unknown>>({});
  const [stickers, setStickers] = useState<Record<string, unknown>[]>([]);
  const [antiAiStatus, setAntiAiStatus] = useState<Record<string, unknown>>({});
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');

  const sendOn = useCallback((
    socket: BridgeSocketLike,
    command: MVPCommandName,
    payload: Record<string, unknown>,
    suppliedRequestId = requestId(),
  ) => {
    socket.send(JSON.stringify({
      type: command,
      payload,
      request_id: suppliedRequestId,
    }));
    return suppliedRequestId;
  }, []);

  const refreshCandidatesOn = useCallback((socket: BridgeSocketLike) => {
    sendOn(socket, 'memory:candidates:list', { status: 'pending', limit: 100 });
  }, [sendOn]);

  const refreshConfirmedOn = useCallback((socket: BridgeSocketLike) => {
    const id = sendOn(socket, 'memory:list', { limit: 100 });
    memoryRequestKindRef.current.set(id, 'list');
  }, [sendOn]);

  const refreshStickersOn = useCallback((socket: BridgeSocketLike) => {
    sendOn(socket, 'sticker:list', { limit: 100 });
  }, [sendOn]);

  const applyFrame = useCallback((frame: Frame, socket: BridgeSocketLike) => {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const correlatedId = stringValue(frame.request_id);
    const pending = pendingResultsRef.current.get(correlatedId);
    if (pending && (frame.type === pending.expectedType || frame.type === 'error')) {
      clearTimeout(pending.timer);
      pendingResultsRef.current.delete(correlatedId);
      if (frame.type === 'error') pending.reject(new Error('command rejected'));
      else pending.resolve(payload);
    }
    switch (frame.type) {
      case 'chat:history:result': {
        const items = Array.isArray(payload.items) ? payload.items : [];
        setMessages(items.map(coerceChatMessage).filter(
          (item): item is MvpChatMessage => item !== null,
        ));
        break;
      }
      case 'chat:chunk':
        setStreamingText((current) => current + stringValue(payload.text));
        break;
      case 'chat:bubble': {
        const content = stringValue(payload.text).trim();
        if (!content) break;
        const deliveryId = stringValue(payload.delivery_id);
        const bubbleIndex = typeof payload.index === 'number' ? payload.index : 0;
        setStreamingText('');
        setMessages((current) => {
          if (deliveryId && current.some(
            (item) => item.deliveryId === deliveryId && item.bubbleIndex === bubbleIndex,
          )) return current;
          return [...current, {
            id: deliveryId ? `${deliveryId}:${bubbleIndex}` : requestId('assistant'),
            role: 'assistant',
            content,
            createdAtUtc: stringValue(payload.created_at_utc) || timestamp(),
            requestId: stringValue(payload.request_id) || null,
            deliveryId: deliveryId || undefined,
            bubbleIndex,
            deliveryState: 'delivering',
          }];
        });
        break;
      }
      case 'chat:done': {
        const completedRequest = stringValue(payload.request_id);
        setIsTyping(false);
        setActiveRequestId((current) => current === completedRequest || !completedRequest ? null : current);
        setStreamingText((streamed) => {
          const values = Array.isArray(payload.messages)
            ? payload.messages.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
            : [];
          const contents = payload.incremental_delivery === true
            ? []
            : values.length ? values : streamed.trim() ? [streamed.trim()] : [];
          if (contents.length) {
            const attachedSticker = isRecord(payload.sticker) ? payload.sticker : null;
            setMessages((current) => [
              ...current,
              ...contents.map((content, index) => ({
                id: requestId('assistant'),
                role: 'assistant' as const,
                content,
                createdAtUtc: timestamp(),
                requestId: completedRequest || null,
                bubbleIndex: index,
                deliveryState: 'done',
                sticker: index === 0 ? attachedSticker : null,
              })),
            ]);
          }
          return '';
        });
        break;
      }
      case 'chat:state': {
        const id = stringValue(payload.request_id);
        const state = stringValue(payload.state) || stringValue(payload.status);
        if (!id || !state) break;
        if (['done', 'cancelled', 'failed', 'failed_uncertain', 'error'].includes(state)) {
          setActiveRequestId((current) => current === id ? null : current);
        } else {
          setActiveRequestId(id);
        }
        setIsTyping(state === 'delivering' || state === 'thinking' || state === 'generating');
        setMessages((current) => current.map((item) => (
          item.requestId === id ? { ...item, deliveryState: state } : item
        )));
        break;
      }
      case 'chat:error':
        setIsTyping(false);
        setActiveRequestId(null);
        setError('消息生成失败；没有自动重试，以免产生重复回复。');
        break;
      case 'chat:retract': {
        const replacement = stringValue(payload.replacement).trim();
        setMessages((current) => [
          ...current.filter((item) => (
            !payload.delivery_id || item.deliveryId !== payload.delivery_id
          )),
          {
            id: requestId('system'),
            role: 'system',
            content: stringValue(payload.notice) || '角色撤回了一条消息。',
            createdAtUtc: timestamp(),
            requestId: null,
          },
          ...(replacement ? [{
            id: requestId('assistant'),
            role: 'assistant' as const,
            content: replacement,
            createdAtUtc: timestamp(),
            requestId: null,
          }] : []),
        ]);
        break;
      }
      case 'emotion:update':
        if (isRecord(payload.emotions)) {
          setEmotions(Object.fromEntries(Object.entries(payload.emotions).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
          )));
        }
        break;
      case 'persona:data':
        setPersona(isRecord(payload.persona) ? payload.persona : null);
        // persona_id lives at the top level of the payload (persona card + scope).
        setPersonaId(stringValue(payload.persona_id) || null);
        break;
      case 'relationship:data':
        setRelationship(payload);
        break;
      case 'settings:get:result':
        if (payload.ok !== false) setSettings(payload);
        break;
      case 'settings:update:result':
        if (payload.ok === true) setSettings((current) => ({ ...current, ...payload }));
        break;
      case 'user:profile:result':
        setUserProfile(isRecord(payload.profile) ? payload.profile : null);
        break;
      case 'memory:settings:result':
        setMemorySettings(isRecord(payload.settings) ? payload.settings : {});
        break;
      case 'memory:result':
        {
          const id = stringValue(frame.request_id);
          const kind = memoryRequestKindRef.current.get(id);
          if (id) memoryRequestKindRef.current.delete(id);
          if (kind === 'list') {
            setConfirmedMemories(coerceConfirmedMemories(payload.memories));
          } else if (kind === 'query') {
            setMemoryResults(Array.isArray(payload.memories)
              ? payload.memories.filter(isRecord)
              : []);
          } else if (kind === 'edit' || kind === 'delete' || kind === 'store') {
            refreshConfirmedOn(socket);
          }
        }
        break;
      case 'memory:candidates:result':
        if (Array.isArray(payload.candidates)) {
          setMemoryCandidates(coerceCandidates(payload.candidates));
        } else {
          refreshCandidatesOn(socket);
          refreshConfirmedOn(socket);
        }
        break;
      case 'group:result':
        if (isRecord(payload)) setGroupState(payload);
        break;
      case 'sticker:data':
        if (Array.isArray(payload.items)) {
          setStickers(payload.items.filter(isRecord));
        } else {
          refreshStickersOn(socket);
        }
        break;
      case 'anti_ai:status:result':
        setAntiAiStatus(payload);
        break;
      case 'error':
        setError('本地服务拒绝了这次操作。为避免泄露内部信息，详细错误未显示。');
        break;
      default:
        break;
    }
  }, [refreshCandidatesOn, refreshConfirmedOn]);

  const connect = useCallback(async () => {
    if (!mountedRef.current) return;
    const readyState = socketRef.current?.readyState;
    if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) return;
    setConnection('connecting');
    let config: BridgeConnectionConfig | null = null;
    try {
      config = await window.electronAPI?.bridge?.getConnectionConfig() ?? null;
    } catch {
      config = null;
    }
    if (!mountedRef.current) return;
    if (!config || config.protocolVersion !== PROTOCOL_VERSION || !config.url) {
      setConnection('unavailable');
      return;
    }
    let socket: BridgeSocketLike;
    if (isElectronIpcBridge(config) && window.electronAPI?.bridge) {
      socket = new ElectronBridgeSocket(window.electronAPI.bridge, config);
    } else if (import.meta.env.DEV) {
      socket = new WebSocket(config.url);
    } else {
      setConnection('unavailable');
      return;
    }
    socketRef.current = socket;
    authenticatedRef.current = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'bridge:auth',
        payload: {
          secret: config.secret,
          protocol_version: PROTOCOL_VERSION,
          origin: config.origin,
        },
      }));
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as Frame;
        if (!frame || typeof frame.type !== 'string' || frame.type.length > 80) {
          throw new Error('invalid frame');
        }
        if (!authenticatedRef.current) {
          if (frame.type !== 'bridge:auth_ok' || !isRecord(frame.payload)
            || frame.payload.protocol_version !== PROTOCOL_VERSION
            || !stringValue(frame.payload.client_id)) {
            throw new Error('invalid authentication');
          }
          authenticatedRef.current = true;
          setConnection('connected');
          setError('');
          for (const [command, payload] of INITIAL_COMMANDS) sendOn(socket, command, payload);
          refreshConfirmedOn(socket);
          return;
        }
        if (!EVENT_NAMES.has(frame.type)) throw new Error('undeclared event');
        applyFrame(frame, socket);
      } catch {
        authenticatedRef.current = false;
        setConnection('unavailable');
        socket.close(1002, 'invalid protocol frame');
      }
    };
    socket.onerror = () => {
      // A single failed frame must not tear down a healthy bridge. Real
      // unavailability is signalled by onChanged(ready=false) which closes the
      // socket; a transient send failure only surfaces a recoverable hint.
      if (authenticatedRef.current) setError('本地服务暂时无法接收消息，正在等待恢复。');
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      authenticatedRef.current = false;
      for (const pending of pendingResultsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('bridge disconnected'));
      }
      pendingResultsRef.current.clear();
      // Release the chat gate and clear stale streaming state so a bridge
      // restart mid-generation cannot permanently lock message sending.
      setActiveRequestId(null);
      setStreamingText('');
      setMessages((current) => current.map((item) => (
        item.deliveryState
          && !['done', 'cancelled', 'failed', 'failed_uncertain', 'error'].includes(item.deliveryState)
          ? { ...item, deliveryState: 'failed_uncertain' }
          : item
      )));
      if (!mountedRef.current) return;
      setConnection((current) => current === 'unavailable' ? current : 'disconnected');
      reconnectRef.current = setTimeout(() => connectRef.current(), RECONNECT_MS);
    };
  }, [applyFrame, refreshConfirmedOn, sendOn]);

  useEffect(() => {
    connectRef.current = () => { void connect(); };
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    void connect();
    const unsubscribe = window.electronAPI?.bridge?.onChanged?.((state) => {
      if (state.ready) void connectRef.current();
      else socketRef.current?.close(1011, 'bridge unavailable');
    });
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      for (const pending of pendingResultsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('bridge closed'));
      }
      pendingResultsRef.current.clear();
      unsubscribe?.();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect]);

  const command = useCallback((
    name: MVPCommandName,
    payload: Record<string, unknown>,
    id = requestId(),
  ) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !authenticatedRef.current) {
      setError('本地服务尚未连接。');
      return null;
    }
    try {
      sendOn(socket, name, payload, id);
      return id;
    } catch {
      setError('命令未发送；请等待本地服务恢复。');
      return null;
    }
  }, [sendOn]);

  const sendChat = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || text.length > MAX_CHAT_TEXT || activeRequestId) return null;
    const id = requestId('chat');
    const sentAtUtc = timestamp();
    if (!command('chat:send', {
      text,
      request_id: id,
      conversation_id: CONVERSATION_ID,
      sent_at_utc: sentAtUtc,
    }, id)) return null;
    setMessages((current) => [...current, {
      id: requestId('user'),
      role: 'user',
      content: text,
      createdAtUtc: sentAtUtc,
      requestId: id,
      deliveryState: 'queued',
    }]);
    setActiveRequestId(id);
    setError('');
    return id;
  }, [activeRequestId, command]);

  const cancelChat = useCallback(() => {
    if (!activeRequestId) return false;
    return Boolean(command('chat:cancel', { request_id: activeRequestId }));
  }, [activeRequestId, command]);

  const requestResult = useCallback((
    name: MVPCommandName,
    payload: Record<string, unknown>,
    expectedType: string,
    timeoutMs = 10_000,
  ) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = requestId('commit');
    const timer = setTimeout(() => {
      pendingResultsRef.current.delete(id);
      reject(new Error('command acknowledgement timed out'));
    }, timeoutMs);
    pendingResultsRef.current.set(id, { expectedType, resolve, reject, timer });
    if (!command(name, payload, id)) {
      clearTimeout(timer);
      pendingResultsRef.current.delete(id);
      reject(new Error('command was not sent'));
    }
  }), [command]);

  const completeOnboarding = useCallback(async (profile: Record<string, unknown>) => {
    try {
      const savedProfile = await requestResult(
        'user:profile:update',
        { profile },
        'user:profile:result',
      );
      if (savedProfile.error || !isRecord(savedProfile.profile)) {
        throw new Error('profile was not committed');
      }
      const completed = await requestResult(
        'settings:update',
        { section: 'onboarding', completed: true },
        'settings:update:result',
      );
      if (completed.ok !== true) throw new Error('onboarding marker was not committed');
      return true;
    } catch {
      setError('引导信息没有完整保存；完成标记未写入，请稍后重试。');
      return false;
    }
  }, [requestResult]);

  return {
    connection,
    messages,
    streamingText,
    activeRequestId,
    persona,
    personaId,
    relationship,
    emotions,
    settings,
    userProfile,
    memorySettings,
    memoryCandidates,
    confirmedMemories,
    memoryResults,
    groupState,
    antiAiStatus,
    isTyping,
    stickers,
    error,
    clearError: () => setError(''),
    sendChat,
    cancelChat,
    queryMemory: (query: string) => {
      const cleaned = query.trim();
      if (!cleaned) return null;
      const id = command('memory:query', { query: cleaned, top_k: 10 });
      if (id) memoryRequestKindRef.current.set(id, 'query');
      return id;
    },
    refreshConfirmedMemories: () => {
      const id = command('memory:list', { limit: 100 });
      if (id) memoryRequestKindRef.current.set(id, 'list');
      return id;
    },
    refreshMemoryCandidates: () => command(
      'memory:candidates:list',
      { status: 'pending', limit: 100 },
    ),
    confirmMemoryCandidate: (id: string) => command(
      'memory:candidates:confirm',
      { candidate_id: id },
    ),
    rejectMemoryCandidate: (id: string) => command(
      'memory:candidates:reject',
      { candidate_id: id },
    ),
    editConfirmedMemory: (id: string, value: string) => {
      const cleaned = value.trim();
      if (!cleaned) return null;
      const request = command('memory:edit', { memory_id: id, text: cleaned });
      if (request) memoryRequestKindRef.current.set(request, 'edit');
      return request;
    },
    deleteConfirmedMemory: (id: string) => {
      const request = command('memory:delete', { memory_id: id });
      if (request) memoryRequestKindRef.current.set(request, 'delete');
      return request;
    },
    storeMemory: (text: string, layer: 'long_term' | 'short_term' | 'permanent') => {
      const cleaned = text.trim();
      if (!cleaned || !['long_term', 'short_term', 'permanent'].includes(layer)) return null;
      const request = command('memory:store', { text: cleaned, layer });
      if (request) memoryRequestKindRef.current.set(request, 'store');
      return request;
    },
    updateSettings: (payload: Record<string, unknown>) => command('settings:update', payload),
    updateUserProfile: (profile: Record<string, unknown>) => command(
      'user:profile:update',
      { profile },
    ),
    refreshGroup: () => command('group:request', {}),
    sendGroupMessage: (text: string) => {
      const cleaned = text.trim();
      if (!cleaned) return null;
      return command('group:send', { text: cleaned, thread_id: 'local-friends' });
    },
    refreshStickers: () => command('sticker:list', { limit: 100 }),
    collectSticker: (value: { text?: string; imageDataUrl?: string; emotions?: string[] }) => {
      if (!value.text?.trim() && !value.imageDataUrl) return null;
      return command('sticker:collect', {
        text: value.text || '',
        image_data_url: value.imageDataUrl || '',
        emotions: value.emotions || [],
      });
    },
    reactToSticker: (id: string, liked: boolean) => command('sticker:react', { id, liked }),
    completeOnboarding,
  };
}
