import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseNotificationTimestamp } = require('../../../electron/notification-outbox.cjs') as {
  parseNotificationTimestamp: (value: unknown) => number;
};

describe('notification outbox timestamps', () => {
  it('accepts ISO timestamps and legacy Unix seconds', () => {
    expect(parseNotificationTimestamp('2026-07-15T12:00:00+00:00')).toBe(1784116800000);
    expect(parseNotificationTimestamp(1784116800)).toBe(1784116800000);
    expect(parseNotificationTimestamp('1784116800.5')).toBe(1784116800500);
  });

  it('rejects empty or malformed timestamps', () => {
    expect(Number.isNaN(parseNotificationTimestamp(''))).toBe(true);
    expect(Number.isNaN(parseNotificationTimestamp('not-a-date'))).toBe(true);
  });
});
