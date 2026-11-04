export interface ArchivePersonaProof {
  persona_id: string;
  persona_epoch: number;
  persona_fingerprint: string;
}
export interface ArchiveOperationToken {
  readonly generation: number;
  readonly proof: Readonly<ArchivePersonaProof> | null;
}
export function coerceArchivePersonaProof(value: unknown): ArchivePersonaProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (typeof source.persona_id !== 'string' || !source.persona_id || source.persona_id.length > 160
    || /[\u0000-\u001f\u007f]/u.test(source.persona_id) || !Number.isSafeInteger(source.persona_epoch)
    || Number(source.persona_epoch) < 0 || typeof source.persona_fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/i.test(source.persona_fingerprint)) return null;
  return { persona_id: source.persona_id, persona_epoch: source.persona_epoch as number, persona_fingerprint: source.persona_fingerprint };
}

export function sameArchivePersonaProof(expected: ArchivePersonaProof | null | undefined, current: ArchivePersonaProof | null | undefined): boolean {
  return Boolean(expected && current && expected.persona_id === current.persona_id
    && expected.persona_epoch === current.persona_epoch && expected.persona_fingerprint === current.persona_fingerprint);
}

export function dispatchArchiveScopedRequest<T>(
  expected: ArchivePersonaProof | undefined,
  current: ArchivePersonaProof | null,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (expected && !sameArchivePersonaProof(expected, current)) return Promise.reject(new Error('人格已变化；没有发送旧档案操作。'));
  return dispatch();
}

/** Local cancellation capability. It never supplies authority to the bridge. */
export function createArchiveOperationScope() {
  let sequence = 0;
  let current: ArchiveOperationToken = Object.freeze({ generation: sequence, proof: null });
  return {
    select(proof: ArchivePersonaProof | null, connected: boolean): ArchiveOperationToken {
      const next = connected && proof ? proof : null;
      if ((next === null && current.proof === null) || sameArchivePersonaProof(next, current.proof)) return current;
      current = Object.freeze({ generation: ++sequence, proof: next ? Object.freeze({
        persona_id: next.persona_id, persona_epoch: next.persona_epoch, persona_fingerprint: next.persona_fingerprint,
      }) : null });
      return current;
    },
    isCurrent(token: ArchiveOperationToken): boolean { return token === current && token.proof !== null; },
    async run<T>(token: ArchiveOperationToken, operation: () => Promise<T>): Promise<{ current: false } | { current: true; value: T }> {
      if (token !== current || !token.proof) return { current: false };
      try {
        const value = await operation();
        return token === current ? { current: true, value } : { current: false };
      } catch (error) {
        if (token !== current) return { current: false };
        throw error;
      }
    },
  };
}
