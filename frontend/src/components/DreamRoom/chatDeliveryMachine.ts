export type ChatDeliveryState =
  | 'queued'
  | 'generating'
  | 'ready_waiting'
  | 'delivering'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'failed_uncertain'
  | 'error';

export type ChatTimestampStatus = 'known' | 'unknown';
export type ChatMessageSource = 'user' | 'assistant' | 'system' | 'proactive' | 'local_focus';

export interface ChatMessageV2 {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at_utc: string | null;
  timestamp_status: ChatTimestampStatus;
  request_id: string | null;
  conversation_id: string | null;
  persona_id: string | null;
  source: ChatMessageSource;
  delivery_state?: ChatDeliveryState;
  error?: string;
  delivery_id?: string;
  bubble_index?: number;
  proactive_id?: string;
}

export interface ChatRequestState {
  request_id: string;
  conversation_id: string;
  persona_id: string | null;
  state: ChatDeliveryState;
  label?: string;
  error?: string;
  updated_at_utc: string;
  reveal_sent: boolean;
}

type LegacyMessage = Partial<ChatMessageV2> & {
  role?: string;
  content?: string;
  deliveryId?: string;
  bubbleIndex?: number;
};

const DELIVERY_STATES = new Set<ChatDeliveryState>([
  'queued',
  'generating',
  'ready_waiting',
  'delivering',
  'done',
  'cancelled',
  'failed',
  'failed_uncertain',
  'error',
]);

const TERMINAL_STATES = new Set<ChatDeliveryState>([
  'done',
  'cancelled',
  'failed',
  'failed_uncertain',
  'error',
]);

const STATE_ORDER: Partial<Record<ChatDeliveryState, number>> = {
  queued: 0,
  generating: 1,
  ready_waiting: 2,
  delivering: 3,
  done: 4,
};

export function migrateChatMessages(value: unknown): ChatMessageV2[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const raw = candidate as LegacyMessage;
    const content = typeof raw.content === 'string' ? raw.content : '';
    const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system'
      ? raw.role
      : 'system';
    const candidateCreatedAt = typeof raw.created_at_utc === 'string'
      ? raw.created_at_utc.trim()
      : '';
    const createdAt = candidateCreatedAt && Number.isFinite(Date.parse(candidateCreatedAt))
      ? candidateCreatedAt
      : null;
    const deliveryState = typeof raw.delivery_state === 'string'
      && DELIVERY_STATES.has(raw.delivery_state as ChatDeliveryState)
      ? raw.delivery_state as ChatDeliveryState
      : undefined;
    return [{
      id: typeof raw.id === 'string' && raw.id ? raw.id : `migrated_${index}`,
      role,
      content,
      created_at_utc: createdAt,
      timestamp_status: createdAt ? 'known' : 'unknown',
      request_id: typeof raw.request_id === 'string' ? raw.request_id : null,
      conversation_id: typeof raw.conversation_id === 'string' ? raw.conversation_id : null,
      persona_id: typeof raw.persona_id === 'string' ? raw.persona_id : null,
      source: raw.source === 'local_focus' || raw.source === 'proactive'
        ? raw.source
        : role === 'user'
          ? 'user'
          : role === 'assistant'
            ? 'assistant'
            : 'system',
      delivery_state: deliveryState,
      error: typeof raw.error === 'string' ? raw.error : undefined,
      delivery_id: typeof raw.delivery_id === 'string'
        ? raw.delivery_id
        : typeof raw.deliveryId === 'string'
          ? raw.deliveryId
          : undefined,
      bubble_index: typeof raw.bubble_index === 'number'
        ? raw.bubble_index
        : typeof raw.bubbleIndex === 'number'
          ? raw.bubbleIndex
          : undefined,
      proactive_id: typeof raw.proactive_id === 'string' && raw.proactive_id
        ? raw.proactive_id
        : undefined,
    }];
  });
}

export function requestStateLabel(state: ChatDeliveryState): string {
  switch (state) {
    case 'queued': return '已排队';
    case 'generating': return '正在组织回复';
    case 'ready_waiting': return '回复已准备好';
    case 'delivering': return '正在送达';
    case 'done': return '已送达';
    case 'cancelled': return '已取消';
    case 'failed_uncertain': return '连接中断，未自动重试';
    case 'failed': return '生成失败';
    case 'error': return '发送失败';
    default: return '状态未知';
  }
}

/**
 * Network messages can be duplicated, delayed, or arrive out of order. A
 * terminal state is immutable and a normal request may only move forward.
 * This keeps a late "generating" frame from resurrecting a finished request.
 */
export function canApplyRequestTransition(
  previous: ChatDeliveryState | undefined,
  next: ChatDeliveryState,
): boolean {
  if (!previous || previous === next) return true;
  if (TERMINAL_STATES.has(previous)) return false;
  if (TERMINAL_STATES.has(next)) return true;
  const left = STATE_ORDER[previous];
  const right = STATE_ORDER[next];
  return typeof left === 'number' && typeof right === 'number' && right >= left;
}

export function upsertRequestState(
  states: Record<string, ChatRequestState>,
  next: Omit<ChatRequestState, 'reveal_sent'> & { reveal_sent?: boolean },
): Record<string, ChatRequestState> {
  const previous = states[next.request_id];
  if (previous && !canApplyRequestTransition(previous.state, next.state)) return states;
  return {
    ...states,
    [next.request_id]: {
      ...next,
      reveal_sent: next.reveal_sent ?? previous?.reveal_sent ?? false,
    },
  };
}

export function markRevealSent(
  states: Record<string, ChatRequestState>,
  requestId: string,
): Record<string, ChatRequestState> {
  const current = states[requestId];
  if (!current || current.reveal_sent) return states;
  return { ...states, [requestId]: { ...current, reveal_sent: true } };
}

export function latestPendingRequest(
  states: Record<string, ChatRequestState>,
): ChatRequestState | null {
  return Object.values(states)
    .filter((item) => !TERMINAL_STATES.has(item.state))
    .sort((left, right) => Date.parse(right.updated_at_utc) - Date.parse(left.updated_at_utc))[0] ?? null;
}

/**
 * Mirror of useMvpBridge's disconnect sweep: when the bridge socket closes,
 * queued/generating bubbles must flip to a visible terminal state instead of
 * staying "已排队" forever. The reconnect re-fetches authoritative history, so
 * this only has to keep the UI honest while the connection is down.
 */
export function sweepDisconnectedChatMessages(
  messages: ChatMessageV2[],
): ChatMessageV2[] {
  return messages.map((item) => (
    item.delivery_state && !TERMINAL_STATES.has(item.delivery_state)
      ? { ...item, delivery_state: 'failed_uncertain' as const }
      : item
  ));
}

export function sweepDisconnectedRequestStates(
  states: Record<string, ChatRequestState>,
): Record<string, ChatRequestState> {
  const next: Record<string, ChatRequestState> = {};
  for (const [key, value] of Object.entries(states)) {
    next[key] = TERMINAL_STATES.has(value.state)
      ? value
      : { ...value, state: 'failed_uncertain', label: '连接中断，未自动重试' };
  }
  return next;
}
