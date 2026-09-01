import { describe, expect, it, vi } from 'vitest';
import {
  requestCompanionMove,
  type CompanionMoveClient,
  type CompanionMoveInput,
} from './useCompanionOpponent';

function input(apply: CompanionMoveInput['apply']): CompanionMoveInput {
  return {
    boardText: 'board',
    side: 'black',
    apply,
    fallback: vi.fn(),
  };
}

function client(...results: Array<unknown>): CompanionMoveClient {
  return { request: vi.fn().mockImplementation(() => Promise.resolve(results.shift())) };
}

describe('companion opponent move policy', () => {
  it('applies one legal provider move exactly once', async () => {
    const apply = vi.fn().mockReturnValue(null);
    const moveInput = input(apply);
    const moveClient = client({ ok: true, move: 'e7e5', comment: 'Your turn' });

    await expect(requestCompanionMove('chess', moveClient, moveInput)).resolves.toEqual({
      kind: 'companion',
      comment: '她说：Your turn',
    });
    expect(moveClient.request).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(moveInput.fallback).not.toHaveBeenCalled();
  });

  it('retries one illegal move once and applies the legal retry', async () => {
    const apply = vi.fn().mockReturnValueOnce('occupied').mockReturnValueOnce(null);
    const moveInput = input(apply);
    const moveClient = client(
      { ok: true, move: 'bad' },
      { ok: true, move: 'good' },
    );

    await expect(requestCompanionMove('go', moveClient, moveInput)).resolves.toMatchObject({ kind: 'companion' });
    expect(moveClient.request).toHaveBeenCalledTimes(2);
    expect(moveClient.request).toHaveBeenNthCalledWith(
      2,
      'game:move',
      expect.objectContaining({ retry_note: 'occupied' }),
      expect.anything(),
    );
    expect(apply).toHaveBeenCalledTimes(2);
    expect(moveInput.fallback).not.toHaveBeenCalled();
  });

  it('falls back after two illegal moves', async () => {
    const moveInput = input(vi.fn().mockReturnValue('illegal'));
    const outcome = await requestCompanionMove(
      'gomoku',
      client({ ok: true, move: 'bad-1' }, { ok: true, move: 'bad-2' }),
      moveInput,
    );

    expect(outcome).toEqual({ kind: 'fallback', notice: '她的走法不合法，这一步由陪练代走。' });
    expect(moveInput.fallback).toHaveBeenCalledOnce();
  });

  it('identifies timeout/error fallback and keeps the RPC timeout bounded', async () => {
    const moveInput = input(vi.fn());
    const moveClient: CompanionMoveClient = { request: vi.fn().mockRejectedValue(new Error('timeout')) };
    const outcome = await requestCompanionMove('xiangqi', moveClient, moveInput);

    expect(outcome).toEqual({ kind: 'fallback', notice: '她暂时连不上，这一步由陪练代走。' });
    expect(moveInput.fallback).toHaveBeenCalledOnce();
    expect(moveClient.request).toHaveBeenCalledWith(
      'game:move',
      expect.anything(),
      { expectedType: 'game:move:result', timeout: 28_000 },
    );
  });

  it('does not mutate or fall back when a late response belongs to a changed game', async () => {
    let resolve!: (value: unknown) => void;
    let current = true;
    const moveClient: CompanionMoveClient = {
      request: vi.fn().mockReturnValue(new Promise((done) => { resolve = done; })),
    };
    const apply = vi.fn().mockReturnValue(null);
    const moveInput = input(apply);
    const pending = requestCompanionMove('go', moveClient, moveInput, () => current);

    current = false;
    resolve({ ok: true, move: '4,4' });

    await expect(pending).resolves.toEqual({ kind: 'cancelled' });
    expect(apply).not.toHaveBeenCalled();
    expect(moveInput.fallback).not.toHaveBeenCalled();
  });
});
