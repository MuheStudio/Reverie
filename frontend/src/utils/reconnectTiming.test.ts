import { describe, expect, it } from 'vitest';

import { RECONNECT_MAX_DELAY_MS, reconnectDelayMs } from './reconnectTiming';

describe('reconnect backoff timing', () => {
  it('doubles the base per attempt and never exceeds the cap', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(1, () => 0)).toBe(1000);
    expect(reconnectDelayMs(2, () => 0)).toBe(2000);
    expect(reconnectDelayMs(4, () => 0)).toBe(8000);
    expect(reconnectDelayMs(12, () => 0)).toBe(15_000);
    expect(reconnectDelayMs(12, () => 1)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('keeps every delay inside the equal-jitter band [base/2, base]', () => {
    for (let attempt = 0; attempt <= 8; attempt += 1) {
      const base = Math.min(1000 * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      for (const rngValue of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = reconnectDelayMs(attempt, () => rngValue);
        expect(delay).toBeGreaterThanOrEqual(base / 2);
        expect(delay).toBeLessThanOrEqual(base);
      }
    }
  });

  it('jitters the same attempt differently across draws', () => {
    const rng = jestLikeRng();
    const delays = new Set(Array.from({ length: 20 }, () => reconnectDelayMs(3, rng)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('clamps invalid attempts to the first delay', () => {
    expect(reconnectDelayMs(Number.NaN, () => 0)).toBe(500);
    expect(reconnectDelayMs(-3, () => 0)).toBe(500);
    expect(reconnectDelayMs(2.9, () => 0)).toBe(2000);
  });
});

function jestLikeRng(): () => number {
  let seed = 42;
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}
