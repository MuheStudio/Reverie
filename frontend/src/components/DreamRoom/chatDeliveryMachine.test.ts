import { describe, expect, it } from 'vitest';
import {
  canApplyRequestTransition,
  markRevealSent,
  migrateChatMessages,
  sweepDisconnectedChatMessages,
  sweepDisconnectedRequestStates,
  upsertRequestState,
  type ChatMessageV2,
  type ChatRequestState,
} from './chatDeliveryMachine';

function request(state: ChatRequestState['state']): ChatRequestState {
  return {
    request_id: 'req-1',
    conversation_id: 'dream-room',
    persona_id: 'persona-1',
    state,
    updated_at_utc: '2026-07-16T00:00:00.000Z',
    reveal_sent: false,
  };
}

function message(deliveryState?: ChatMessageV2['delivery_state']): ChatMessageV2 {
  return {
    id: `msg-${deliveryState ?? 'none'}`,
    role: 'user',
    content: '你好',
    created_at_utc: null,
    timestamp_status: 'unknown',
    request_id: 'req-1',
    conversation_id: 'dream-room',
    persona_id: 'persona-1',
    source: 'user',
    ...(deliveryState ? { delivery_state: deliveryState } : {}),
  };
}

describe('chat delivery machine adversarial invariants', () => {
  it('migrates legacy messages without inventing a timestamp', () => {
    const [message] = migrateChatMessages([{ role: 'assistant', content: 'old', id: 'legacy' }]);
    expect(message.created_at_utc).toBeNull();
    expect(message.timestamp_status).toBe('unknown');
  });

  it('rejects invalid historical timestamps rather than presenting them as known', () => {
    const [message] = migrateChatMessages([{
      role: 'assistant',
      content: 'old',
      created_at_utc: 'not-a-real-date',
    }]);
    expect(message.created_at_utc).toBeNull();
    expect(message.timestamp_status).toBe('unknown');
  });

  it('never resurrects a terminal request from a delayed network frame', () => {
    expect(canApplyRequestTransition('done', 'generating')).toBe(false);
    expect(canApplyRequestTransition('cancelled', 'delivering')).toBe(false);
    expect(canApplyRequestTransition('failed_uncertain', 'queued')).toBe(false);
  });

  it('allows monotonic delivery and terminal failure transitions', () => {
    expect(canApplyRequestTransition('queued', 'generating')).toBe(true);
    expect(canApplyRequestTransition('generating', 'ready_waiting')).toBe(true);
    expect(canApplyRequestTransition('ready_waiting', 'delivering')).toBe(true);
    expect(canApplyRequestTransition('generating', 'failed_uncertain')).toBe(true);
  });

  it('keeps reveal idempotent and does not accept an out-of-order regression', () => {
    const ready = request('ready_waiting');
    const initial = { [ready.request_id]: ready };
    const revealed = markRevealSent(initial, ready.request_id);
    expect(revealed[ready.request_id].reveal_sent).toBe(true);
    expect(markRevealSent(revealed, ready.request_id)).toBe(revealed);

    const regressed = upsertRequestState(revealed, {
      ...request('generating'),
      updated_at_utc: '2026-07-16T00:00:01.000Z',
    });
    expect(regressed).toBe(revealed);
  });

  it('disconnect sweep flips in-flight states but never touches terminal ones', () => {
    const messages = [
      message('queued'),
      message('generating'),
      message('ready_waiting'),
      message('delivering'),
      message('done'),
      message('failed'),
      message('failed_uncertain'),
      message('cancelled'),
      message('error'),
      message(undefined),
    ];
    const swept = sweepDisconnectedChatMessages(messages);
    expect(swept.filter((item) => item.delivery_state === 'failed_uncertain').map((item) => item.id))
      .toEqual([
        'msg-queued',
        'msg-generating',
        'msg-ready_waiting',
        'msg-delivering',
        // already terminal — swept list matches it, but the object is untouched
        'msg-failed_uncertain',
      ]);
    // Terminal and state-less bubbles are returned untouched.
    expect(swept[4]).toBe(messages[4]);
    expect(swept[9]).toBe(messages[9]);
  });

  it('disconnect sweep marks every non-terminal request as failed_uncertain', () => {
    const states = {
      a: request('queued'),
      b: { ...request('generating'), request_id: 'req-2' },
      c: { ...request('done'), request_id: 'req-3' },
    };
    const swept = sweepDisconnectedRequestStates(states);
    expect(swept.a.state).toBe('failed_uncertain');
    expect(swept.b.state).toBe('failed_uncertain');
    expect(swept.c).toBe(states.c);
  });
});
