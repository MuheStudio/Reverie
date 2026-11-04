import { describe, expect, it, vi } from 'vitest';
import { coerceArchivePersonaProof, createArchiveOperationScope, dispatchArchiveScopedRequest, sameArchivePersonaProof } from './archiveOperationScope';

const p1 = { persona_id: 'p1', persona_epoch: 1, persona_fingerprint: 'a'.repeat(64) };
const p2 = { persona_id: 'p2', persona_epoch: 2, persona_fingerprint: 'b'.repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe('archive operation generations', () => {
  it('does not adopt an old completion after A to B to A', async () => {
    const scope = createArchiveOperationScope(), token = scope.select(p1, true), response = deferred<string>();
    const result = scope.run(token, () => response.promise);
    scope.select(p2, true);
    const freshA = scope.select(p1, true);
    response.resolve('old archive A');
    expect(await result).toEqual({ current: false });
    expect(scope.isCurrent(token)).toBe(false);
    expect(scope.isCurrent(freshA)).toBe(true);
  });

  it('drops an old failed save without invoking retry or overwriting the new pending save', async () => {
    const scope = createArchiveOperationScope(), old = scope.select(p1, true), response = deferred<string>();
    const nextState = { pending: 'new-persona-payload', status: 'new-persona-ready', revision: 8 };
    const retry = vi.fn(() => { nextState.pending = 'old-persona-payload'; });
    const result = scope.run(old, () => response.promise).catch(retry);
    scope.select(p2, true);
    response.reject(new Error('old save failed'));
    expect(await result).toEqual({ current: false });
    expect(retry).not.toHaveBeenCalled();
    expect(nextState).toEqual({ pending: 'new-persona-payload', status: 'new-persona-ready', revision: 8 });
  });

  it('does not send a delayed file import after persona changes', async () => {
    const scope = createArchiveOperationScope(), token = scope.select(p1, true), file = deferred<string>();
    const save = vi.fn(async (_text: string) => 'saved');
    const importOperation = (async () => {
      const loaded = await scope.run(token, () => file.promise);
      if (loaded.current) return scope.run(token, () => save(loaded.value));
      return loaded;
    })();
    scope.select(p2, true);
    file.resolve('old-persona imported archive');
    expect(await importOperation).toEqual({ current: false });
    expect(save).not.toHaveBeenCalled();
  });

  it('does not migrate a stale missing-archive GET response', async () => {
    const scope = createArchiveOperationScope(), token = scope.select(p1, true), get = deferred<{ exists: boolean }>();
    const migrate = vi.fn(async () => 'migrated');
    const hydrate = (async () => {
      const result = await scope.run(token, () => get.promise);
      if (result.current && !result.value.exists) return scope.run(token, migrate);
      return result;
    })();
    scope.select(p2, true);
    get.resolve({ exists: false });
    await hydrate;
    expect(migrate).not.toHaveBeenCalled();
  });

  it('does not PUT a merged old archive when persona changes after import GET', async () => {
    const scope = createArchiveOperationScope(), token = scope.select(p1, true), get = deferred<{ worldBooks: string[] }>();
    let currentPersona = p1;
    const put = vi.fn(async (_archive: unknown) => 'saved');
    const importOperation = (async () => {
      const loaded = await scope.run(token, () => get.promise);
      if (!loaded.current) return loaded;
      return scope.run(token, () => dispatchArchiveScopedRequest(token.proof!, currentPersona,
        () => put({ worldBooks: [...loaded.value.worldBooks, 'imported-book'] })));
    })();
    currentPersona = p2;
    scope.select(p2, true);
    get.resolve({ worldBooks: ['old-persona-private-book'] });
    expect(await importOperation).toEqual({ current: false });
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects epoch/fingerprint changes and reconnects, including unchanged persona ID', async () => {
    const scope = createArchiveOperationScope(), token = scope.select(p1, true);
    expect(scope.select({ ...p1 }, true)).toBe(token);
    const changed = scope.select({ ...p1, persona_epoch: 2 }, true);
    expect(scope.isCurrent(token)).toBe(false);
    expect(scope.isCurrent(changed)).toBe(true);
    scope.select({ ...p1, persona_epoch: 2, persona_fingerprint: 'c'.repeat(64) }, true);
    expect(scope.isCurrent(changed)).toBe(false);
    scope.select(p1, false);
    const reconnect = scope.select(p1, true);
    expect(reconnect).not.toBe(token);
    const operation = vi.fn(async () => 'not sent');
    expect(await scope.run(token, operation)).toEqual({ current: false });
    expect(operation).not.toHaveBeenCalled();
  });

  it('lets a current operation complete and reports genuine current errors', async () => {
    const scope = createArchiveOperationScope(), token = scope.select(p1, true);
    expect(await scope.run(token, async () => 'current')).toEqual({ current: true, value: 'current' });
    await expect(scope.run(token, async () => { throw new Error('current failure'); })).rejects.toThrow('current failure');
  });

  it('never gains authority from a mutated caller proof object', () => {
    const scope = createArchiveOperationScope(), caller = { ...p1 }, token = scope.select(caller, true);
    caller.persona_id = 'changed';
    expect(token.proof?.persona_id).toBe('p1');
    expect(Object.isFrozen(token.proof)).toBe(true);
  });
});

describe('bridge request preflight before registering or sending a request', () => {
  it('projects an authenticated proof and rejects malformed identity metadata', () => {
    expect(coerceArchivePersonaProof({ ...p1, unrelated: 'discard' })).toEqual(p1);
    for (const value of [null, [], {}, { ...p1, persona_id: 'x'.repeat(161) }, { ...p1, persona_id: 'a\nb' },
      { ...p1, persona_epoch: -1 }, { ...p1, persona_epoch: 1.5 }, { ...p1, persona_fingerprint: 'invalid' }]) {
      expect(coerceArchivePersonaProof(value)).toBeNull();
    }
  });
  it('does not send old archive data under a freshly observed persona proof', async () => {
    const send = vi.fn(async () => 'sent under new current scope');
    await expect(dispatchArchiveScopedRequest(p1, p2, send)).rejects.toThrow('没有发送旧档案操作');
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks same-persona old epochs and fingerprints before dispatch', async () => {
    const send = vi.fn(async () => 'sent');
    await expect(dispatchArchiveScopedRequest(p1, { ...p1, persona_epoch: 2 }, send)).rejects.toThrow();
    await expect(dispatchArchiveScopedRequest(p1, { ...p1, persona_fingerprint: 'c'.repeat(64) }, send)).rejects.toThrow();
    await expect(dispatchArchiveScopedRequest(p1, null, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves existing callers and accepted current-scope dispatch', async () => {
    const send = vi.fn(async () => 'sent');
    expect(await dispatchArchiveScopedRequest(undefined, p2, send)).toBe('sent');
    expect(await dispatchArchiveScopedRequest(p1, { ...p1 }, send)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
    expect(sameArchivePersonaProof(undefined, p1)).toBe(false);
  });
});
