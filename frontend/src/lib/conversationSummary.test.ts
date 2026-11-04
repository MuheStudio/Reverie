import { describe, expect, it, vi } from 'vitest';
import { legacySummaryPayload, readLegacySummaryFile } from './conversationSummary';
import { createArchiveOperationScope } from './archiveOperationScope';

describe('explicit bounded legacy summary input', () => {
  it('preserves exact UTF-8 including BOM for source identity instead of rewriting JSON', async () => {
    const bytes = new TextEncoder().encode('\ufeff{"summaries":[]}');
    const text = await readLegacySummaryFile({ size: bytes.length, arrayBuffer: async () => bytes.buffer });
    expect(text).toBe('\ufeff{"summaries":[]}');
    expect(legacySummaryPayload(text)).toEqual({ content: text });
  });
  it('bounds bytes before reading the selected file', async () => {
    const read = vi.fn();
    await expect(readLegacySummaryFile({ size: 128 * 1024 + 1, arrayBuffer: read })).rejects.toThrow('128 KiB');
    expect(read).not.toHaveBeenCalled();
  });
  it('does not count Chinese characters as one UTF-8 byte', () => {
    expect(() => legacySummaryPayload('界'.repeat(45000))).toThrow('128 KiB');
  });
  it('rejects malformed UTF-8 without silently substituting text', async () => {
    await expect(readLegacySummaryFile({ size: 2, arrayBuffer: async () => new Uint8Array([255, 255]).buffer })).rejects.toThrow();
  });
  it('rejects changed size and oversized serialized content', async () => {
    await expect(readLegacySummaryFile({ size: 2, arrayBuffer: async () => new Uint8Array([65]).buffer })).rejects.toThrow('变化');
    expect(() => legacySummaryPayload('\u0000'.repeat(60000))).toThrow('传输');
  });
  it('cannot deliver a preview read under an old persona into the new persona state', async () => {
    const scope = createArchiveOperationScope();
    const token = scope.select({ persona_id: 'a', persona_epoch: 1, persona_fingerprint: 'a'.repeat(64) }, true);
    let complete!: (value: string) => void;
    const pending = scope.run(token, () => new Promise<string>(resolve => { complete = resolve; }));
    scope.select({ persona_id: 'b', persona_epoch: 1, persona_fingerprint: 'b'.repeat(64) }, true);
    complete('old-content');
    expect(await pending).toEqual({ current: false });
    expect(scope.isCurrent(token)).toBe(false);
  });
});
