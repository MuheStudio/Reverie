import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE_REQUEST_TYPES,
  WSMsgType,
  coerceAmbientState,
  coerceApiBudget,
  coerceAuthoritativeLocalModeState,
  coerceGroupState,
  coerceKeepsakes,
  coerceDiaryEntries,
  coercePersonaScope,
  coerceStickers,
  coerceTimelinePosts,
  classifyCorrelatedResponse,
  enrichPersonaActivationPayload,
  enrichPersonaScopedPayload,
  responseTypesFor,
  transitionBridgeAuth,
} from './useReverieWS';

describe('useReverieWS protocol defaults', () => {
  it('requests all locally persistent room state after websocket connection opens', () => {
    expect(INITIAL_STATE_REQUEST_TYPES).toEqual([
      WSMsgType.CHAT_HISTORY,
      WSMsgType.EMOTION_GET,
      WSMsgType.PERSONA_GET,
      WSMsgType.RELATIONSHIP_GET,
      WSMsgType.DIARY_REQUEST,
      WSMsgType.TIMELINE_REQUEST,
      WSMsgType.AMBIENT_GET,
      WSMsgType.API_BUDGET_GET,
      WSMsgType.GROUP_REQUEST,
      WSMsgType.USER_PROFILE_GET,
      WSMsgType.KEEPSAKE_LIST,
      WSMsgType.STICKER_LIST,
      WSMsgType.ANTI_AI_STATUS,
      WSMsgType.AI_USAGE_GET,
      WSMsgType.SETTINGS_GET,
    ]);
    expect(INITIAL_STATE_REQUEST_TYPES).not.toContain(WSMsgType.SETTINGS_UPDATE);
  });

  it('bounds malformed ambient, budget, and group payloads', () => {
    expect(coerceAmbientState({
      book_page: -5,
      book_total: 0,
      pending_thoughts: -2,
      traces: [{ kind: 'sticky_note', title: '早安', body: '记得吃饭' }],
    })).toMatchObject({ book_page: 1, book_total: 2, pending_thoughts: 0 });
    expect(coerceApiBudget({
      requests: -8,
      background: { requests: -1, request_budget: 0, tokens: -2, token_budget: 0 },
    })).toMatchObject({
      requests: 0,
      background: { requests: 0, request_budget: 1, tokens: 0, token_budget: 1 },
    });
    expect(coerceGroupState({
      threads: [{ messages: [{ content: '' }, { content: '在吗', created_at: 1 }] }],
    }).threads[0].messages).toHaveLength(1);
  });

  it('accepts sticker payloads with image and emotion tags', () => {
    expect(coerceStickers({
      items: [{
        id: 's1',
        text: 'cat tired',
        emotions: ['sadness'],
        image_data_url: 'data:image/png;base64,xx',
        style_tags: ['cat'],
      }],
    })).toEqual([
      {
        id: 's1',
        text: 'cat tired',
        emotions: ['sadness'],
        image_data_url: 'data:image/png;base64,xx',
        style_tags: ['cat'],
      },
    ]);
  });

  it('accepts diary and timeline payloads from multiple backend shapes', () => {
    expect(coerceDiaryEntries({ entries: [{ date: '2026-03-02', title: '夜灯' }] })).toEqual([
      { date: '2026-03-02', title: '夜灯' },
    ]);
    expect(coerceDiaryEntries([{ title: '无日期' }])).toEqual([{ title: '无日期', date: '' }]);
    expect(coerceDiaryEntries({ entries: [{ date: '2026-03-04', title: '锁页', locked: true }] })[0])
      .toMatchObject({ date: '2026-03-04', title: '锁页', is_locked: true });

    expect(coerceTimelinePosts({ timelinePosts: [{ date: '2026-03-03', content: '今天看了月亮' }] })).toEqual([
      { date: '2026-03-03', content: '今天看了月亮' },
    ]);
    expect(coerceTimelinePosts({ data: [{ content: '还没写日期' }] })).toEqual([
      { content: '还没写日期', date: '' },
    ]);
    expect(coerceKeepsakes({ items: [{ id: 'k1', kind: 'photo', title: '月亮', tags: ['夜晚'] }] })).toEqual([
      { id: 'k1', kind: 'photo', title: '月亮', tags: ['夜晚'], last_recalled_at: null },
    ]);
  });

  it('listens to canonical and legacy backend result message names', () => {
    expect(responseTypesFor(WSMsgType.MEMORY_RESULT)).toEqual([
      WSMsgType.MEMORY_RESULT,
      'memory_query_result',
      'memory_store_result',
    ]);
    expect(responseTypesFor(WSMsgType.MEMORY_SETTINGS_RESULT)).toEqual([
      WSMsgType.MEMORY_SETTINGS_RESULT,
      'memory_settings_get_result',
    ]);
    expect(responseTypesFor(WSMsgType.DIARY_RESULT)).toEqual([
      WSMsgType.DIARY_RESULT,
      'diary_request_result',
    ]);
    expect(responseTypesFor(WSMsgType.TIMELINE_RESULT)).toEqual([
      WSMsgType.TIMELINE_RESULT,
      'timeline_request_result',
    ]);
    expect(responseTypesFor(WSMsgType.AMBIENT_RESULT)).toEqual([
      WSMsgType.AMBIENT_RESULT,
      'ambient_get_result',
    ]);
    expect(responseTypesFor(WSMsgType.API_BUDGET_RESULT)).toEqual([
      WSMsgType.API_BUDGET_RESULT,
      'api_budget_get_result',
    ]);
    expect(responseTypesFor(WSMsgType.GROUP_RESULT)).toEqual([
      WSMsgType.GROUP_RESULT,
      'group_request_result',
      'group_send_result',
    ]);
    expect(responseTypesFor(WSMsgType.USER_PROFILE_RESULT)).toEqual([
      WSMsgType.USER_PROFILE_RESULT,
      'user_profile_get_result',
      'user_profile_update_result',
    ]);
    expect(responseTypesFor(WSMsgType.KEEPSAKE_RESULT)).toEqual([
      WSMsgType.KEEPSAKE_RESULT,
      'keepsake_list_result',
      'keepsake_add_result',
    ]);
    expect(responseTypesFor(WSMsgType.BACKUP_RESULT)).toEqual([
      WSMsgType.BACKUP_RESULT,
      'backup_export_result',
      'backup_import_result',
    ]);
    expect(responseTypesFor(WSMsgType.SETTINGS_UPDATE_RESULT)).toEqual([
      WSMsgType.SETTINGS_UPDATE_RESULT,
      'settings_update_result',
    ]);
    expect(responseTypesFor(WSMsgType.STICKER_DATA)).toEqual([
      WSMsgType.STICKER_DATA,
      'sticker_list_result',
      'sticker_collect_result',
      'sticker_react_result',
    ]);
    expect(responseTypesFor(WSMsgType.ANTI_AI_STATUS_RESULT)).toEqual([
      WSMsgType.ANTI_AI_STATUS_RESULT,
      'anti_ai_status_result',
    ]);
  });

  it('never dispatches frames before authentication or replays a second auth_ok', () => {
    expect(transitionBridgeAuth('awaiting_auth', WSMsgType.CHAT_DONE)).toEqual({
      phase: 'failed',
      action: 'reject',
    });
    expect(transitionBridgeAuth('awaiting_auth', WSMsgType.BRIDGE_AUTH_OK)).toEqual({
      phase: 'authenticated',
      action: 'accept_auth',
    });
    expect(transitionBridgeAuth('authenticated', WSMsgType.CHAT_DONE)).toEqual({
      phase: 'authenticated',
      action: 'dispatch',
    });
    expect(transitionBridgeAuth('authenticated', WSMsgType.BRIDGE_AUTH_OK)).toEqual({
      phase: 'failed',
      action: 'reject',
    });
  });

  it('matches RPC responses by both request id and expected type', () => {
    const expected = new Set([WSMsgType.SETTINGS_UPDATE_RESULT]);
    expect(classifyCorrelatedResponse('rpc_12345678', expected, {
      type: WSMsgType.SETTINGS_UPDATE_RESULT,
      request_id: 'rpc_12345678',
      payload: { ok: true },
    })).toBe('match');
    expect(classifyCorrelatedResponse('rpc_12345678', expected, {
      type: WSMsgType.SETTINGS_UPDATE_RESULT,
      request_id: 'rpc_late0000',
      payload: { ok: true },
    })).toBe('ignore');
    expect(classifyCorrelatedResponse('rpc_12345678', expected, {
      type: WSMsgType.PERSONA_DATA,
      request_id: 'rpc_12345678',
      payload: {},
    })).toBe('ignore');
    expect(classifyCorrelatedResponse('rpc_12345678', expected, {
      type: WSMsgType.ERROR,
      request_id: 'rpc_12345678',
      payload: { error: 'failed' },
    })).toBe('error');
  });

  it('keeps persona scope outside persona content and stamps identity activation', () => {
    const fingerprint = 'a'.repeat(64);
    const scope = coercePersonaScope({
      persona_id: 'persona-current',
      persona_epoch: 7,
      persona_fingerprint: fingerprint,
      model_epoch: 3,
      restart_required: false,
    });
    expect(scope).toEqual({
      persona_id: 'persona-current',
      persona_epoch: 7,
      persona_fingerprint: fingerprint,
      model_epoch: 3,
      restart_required: false,
    });
    expect(enrichPersonaActivationPayload({
      profile_id: 'persona-next',
      identity_change_confirmed: true,
      actor: 'owner',
      reason: 'user selected imported persona',
      expected_persona_id: 'stale',
    }, scope)).toMatchObject({
      profile_id: 'persona-next',
      confirmed_profile_id: 'persona-next',
      expected_persona_id: 'persona-current',
      expected_persona_epoch: 7,
      expected_persona_fingerprint: fingerprint,
    });
    expect(enrichPersonaActivationPayload({
      profile_id: 'persona-next',
      identity_change_confirmed: false,
    }, scope)).toBeNull();
    expect(enrichPersonaScopedPayload({
      game_id: 'gomoku',
      expected_persona_id: 'attacker-controlled',
    }, scope)).toEqual({
      game_id: 'gomoku',
      expected_persona_id: 'persona-current',
      expected_persona_epoch: 7,
      expected_persona_fingerprint: fingerprint,
    });
  });

  it('accepts only complete authoritative desktop local-mode states', () => {
    expect(coerceAuthoritativeLocalModeState({
      enabled: true,
      epoch: 4,
      sessionId: 'manual-local-1',
      changedAtUtc: '2026-07-18T09:00:00.000Z',
      available: true,
      reason: '',
      transitioning: false,
    })).toMatchObject({
      enabled: true,
      epoch: 4,
      sessionId: 'manual-local-1',
      available: true,
      transitioning: false,
    });
    expect(coerceAuthoritativeLocalModeState({
      enabled: true,
      epoch: 4,
    })).toBeNull();
  });
});
