import { describe, expect, it, vi } from 'vitest';
import { WSMsgType } from '@/hooks/useReverieWS';
import { confirmMemoryRetention } from './retentionSetup';

describe('confirmMemoryRetention', () => {
  it('returns preferences only after the correlated backend acknowledgement', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const preferences = await confirmMemoryRetention({ request }, 3);

    expect(request).toHaveBeenCalledWith(
      WSMsgType.SETTINGS_UPDATE,
      { section: 'memory', retention_days: 1095 },
      { expectedType: WSMsgType.SETTINGS_UPDATE_RESULT, timeout: 8_000 },
    );
    expect(preferences.memoryRetentionYears).toBe(3);
    expect(preferences.memoryRetentionDays).toBe(1095);
  });

  it('does not accept a rejection or missing acknowledgement', async () => {
    await expect(confirmMemoryRetention({
      request: vi.fn().mockResolvedValue({ ok: false, error: 'rejected' }),
    }, 1)).rejects.toThrow('rejected');
    await expect(confirmMemoryRetention({
      request: vi.fn().mockRejectedValue(new Error('timeout')),
    }, 2)).rejects.toThrow('timeout');
  });
});
