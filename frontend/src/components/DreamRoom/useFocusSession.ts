import { useCallback, useEffect, useRef, useState } from 'react';
import { translate } from '@/i18';

const IDLE_STATE: FocusState = {
  phase: 'idle',
  id: null,
  durationSeconds: 0,
  remainingSeconds: 0,
  startedAtUtc: null,
  endsAtUtc: null,
  pausedAtUtc: null,
};

function clampDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return 25;
  return Math.min(180, Math.max(1, Math.round(minutes)));
}

export function useFocusSession(onCompleted: (id: string, durationSeconds: number) => void) {
  const api = window.electronAPI?.focus;
  const [state, setState] = useState<FocusState>(IDLE_STATE);
  const [displayRemaining, setDisplayRemaining] = useState(0);
  const [error, setError] = useState('');
  const completedRef = useRef(new Set<string>());
  const displayAnchorRef = useRef({ remaining: 0, monotonicMs: 0 });

  const acceptState = useCallback((next: FocusState) => {
    setState(next);
    const remaining = Math.max(0, Math.round(next.remainingSeconds || 0));
    displayAnchorRef.current = { remaining, monotonicMs: performance.now() };
    setDisplayRemaining(remaining);
    if (next.phase === 'completed' && next.id && !completedRef.current.has(next.id)) {
      completedRef.current.add(next.id);
      onCompleted(next.id, next.durationSeconds);
    }
  }, [onCompleted]);

  const refresh = useCallback(async () => {
    if (!api) {
      setState(IDLE_STATE);
      setError(translate('dream.focusServiceUnavailable'));
      return;
    }
    try {
      acceptState(await api.getState());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.focusReadFailed'));
    }
  }, [acceptState, api]);

  useEffect(() => {
    void refresh();
    const unsubscribe = api?.onChanged(acceptState);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe?.();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [acceptState, api, refresh]);

  useEffect(() => {
    if (state.phase !== 'running') return undefined;
    const update = () => {
      const anchor = displayAnchorRef.current;
      const elapsed = Math.max(0, (performance.now() - anchor.monotonicMs) / 1000);
      setDisplayRemaining(Math.max(0, Math.ceil(anchor.remaining - elapsed)));
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  const run = useCallback(async (action: () => Promise<FocusState>) => {
    if (!api) return false;
    setError('');
    try {
      acceptState(await action());
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.focusActionFailed'));
      return false;
    }
  }, [acceptState, api]);

  const start = useCallback((minutes: number) => {
    const safeMinutes = clampDuration(minutes);
    return run(() => api!.start(safeMinutes * 60));
  }, [api, run]);
  const pause = useCallback(() => (
    state.id ? run(() => api!.pause(state.id!)) : Promise.resolve(false)
  ), [api, run, state.id]);
  const resume = useCallback(() => (
    state.id ? run(() => api!.resume(state.id!)) : Promise.resolve(false)
  ), [api, run, state.id]);
  const stop = useCallback(() => (
    state.id ? run(() => api!.stop(state.id!)) : Promise.resolve(false)
  ), [api, run, state.id]);

  return {
    available: Boolean(api),
    state,
    displayRemaining,
    error,
    start,
    pause,
    resume,
    stop,
    refresh,
  };
}
