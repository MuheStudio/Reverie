// Equal-jitter reconnect backoff (the Luna-ts wsClient pattern): the delay
// is base/2 + random(base/2), so a reconnect storm after a bridge restart
// spreads out instead of stampeding on the same tick, while the hard-stop
// policy (5 consecutive failures → unavailable) stays with the caller.
export const RECONNECT_MAX_DELAY_MS = 30_000;

export function reconnectDelayMs(attempt: number, rng: () => number = Math.random): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const base = Math.min(1000 * 2 ** safeAttempt, RECONNECT_MAX_DELAY_MS);
  const half = base / 2;
  const jitter = half * Math.min(1, Math.max(0, rng()));
  return Math.round(half + jitter);
}
