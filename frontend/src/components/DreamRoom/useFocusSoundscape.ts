import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attemptFocusPlayback,
  type FocusSoundGraph,
  type Soundscape,
} from './focusSoundRuntime';
import { translate } from '@/i18';

export type { Soundscape } from './focusSoundRuntime';

const DEFAULT_PREFERENCE: Readonly<{
  sound: Soundscape;
  volume: number;
  autoStart: boolean;
}> = Object.freeze({
  sound: 'rain' as Soundscape,
  volume: 0.2,
  autoStart: true,
});

export function useFocusSoundscape(
  focusRunning: boolean,
  focusId?: string | null,
  requiresAudioRearm = false,
) {
  const [sound, setSoundState] = useState<Soundscape>(DEFAULT_PREFERENCE.sound);
  const [volume, setVolumeState] = useState(DEFAULT_PREFERENCE.volume);
  const [autoStart, setAutoStartState] = useState(DEFAULT_PREFERENCE.autoStart);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [customSounds, setCustomSounds] = useState<FocusSoundRecord[]>([]);
  const graphRef = useRef<FocusSoundGraph | null>(null);
  const armedRef = useRef<{
    context: AudioContext;
    ready: Promise<boolean>;
  } | null>(null);
  const operationRef = useRef(0);
  const previousFocusRunningRef = useRef(focusRunning);

  const persist = useCallback((nextSound: Soundscape, nextVolume: number, nextAutoStart = autoStart) => {
    void window.electronAPI?.companionPreferences?.set({
      sound: nextSound,
      volume: nextVolume,
      autoStart: nextAutoStart,
    }).catch(() => setError(translate('dream.soundStartFailed')));
  }, [autoStart]);

  useEffect(() => {
    const api = window.electronAPI?.companionPreferences;
    if (!api) return;
    void api.get().then((value) => {
      const candidate = String(value.sound || '');
      const nextSound = ['rain', 'wind', 'fire', 'library', 'pink'].includes(candidate)
        || /^custom:[0-9a-f-]{36}$/i.test(candidate)
        ? candidate as Soundscape
        : DEFAULT_PREFERENCE.sound;
      setSoundState(nextSound);
      setVolumeState(Math.min(1, Math.max(0, value.volume)));
      setAutoStartState(value.autoStart !== false);
    }).catch(() => setError(translate('dream.soundStartFailed')));
  }, []);

  const fadeOut = useCallback(async () => {
    const graph = graphRef.current;
    graphRef.current = null;
    setPlaying(false);
    if (!graph) return;
    try {
      const now = graph.context.currentTime;
      graph.gain.gain.cancelScheduledValues(now);
      graph.gain.gain.setValueAtTime(graph.gain.gain.value, now);
      graph.gain.gain.linearRampToValueAtTime(0, now + 0.55);
      await new Promise((resolve) => window.setTimeout(resolve, 560));
      graph.source.stop();
    } catch {
      // The device/context may already be gone.
    } finally {
      if (armedRef.current?.context === graph.context) armedRef.current = null;
      void graph.context.close().catch(() => undefined);
    }
  }, []);

  const arm = useCallback((): Promise<boolean> => {
    const existing = armedRef.current;
    if (existing && existing.context.state !== 'closed') return existing.ready;
    try {
      // Construct and resume inside the original click handler. Chromium may
      // revoke user activation after the first awaited IPC round trip.
      const context = new AudioContext({ latencyHint: 'playback' });
      const fail = (reason?: unknown) => {
        if (armedRef.current?.context === context) armedRef.current = null;
        void context.close().catch(() => undefined);
        setError(reason instanceof Error ? reason.message : translate('dream.soundStartFailed'));
        return false;
      };
      const ready = new Promise<boolean>((resolve) => {
        // A resume() that never settles (activation lost, device stuck) must
        // not hang the toggle forever — surface the failure after 3s.
        const timeout = window.setTimeout(() => resolve(fail()), 3000);
        context.resume().then(() => {
          window.clearTimeout(timeout);
          if (context.state !== 'running') {
            resolve(fail());
            return;
          }
          resolve(true);
        }).catch((reason) => {
          window.clearTimeout(timeout);
          resolve(fail(reason));
        });
      });
      armedRef.current = { context, ready };
      return ready;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.soundStartFailed'));
      return Promise.resolve(false);
    }
  }, []);

  const stop = useCallback(async () => {
    operationRef.current += 1;
    await fadeOut();
  }, [fadeOut]);

  const start = useCallback(async (allowSessionStart = false) => {
    if (!focusRunning && !allowSessionStart) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    await fadeOut();
    if (operation !== operationRef.current) return;
    setError('');
    let context: AudioContext | null = null;
    try {
      if (requiresAudioRearm && focusId) {
        await window.electronAPI?.focus?.acknowledgeAudioRearm(focusId);
      }
      const armed = armedRef.current;
      if (armed && armed.context.state !== 'closed') {
        if (!await armed.ready) return;
        context = armed.context;
        armedRef.current = null;
      } else {
        context = new AudioContext({ latencyHint: 'playback' });
        await context.resume();
      }
      const customId = sound.startsWith('custom:') ? sound.slice('custom:'.length) : '';
      const customUrl = customSounds.find((record) => record.id === customId)?.url || '';
      const playback = await attemptFocusPlayback(context, sound, volume, fetch, customUrl);
      if (operation !== operationRef.current) {
        playback?.graph.source.stop();
        await context.close().catch(() => undefined);
        return;
      }
      if (!playback) throw new Error('local audio playback failed');
      if (playback.usedFallback && sound !== 'pink') {
        // The bundled asset failed to load/decode and the graph silently
        // switched to pink noise. Never hide that from diagnostics — the
        // packaged protocol once 404'd every .wav and nobody knew.
        console.warn('[FocusSound] bundled asset unavailable, playing pink-noise fallback', sound);
      }
      graphRef.current = playback.graph;
      context.addEventListener('statechange', () => {
        const state = context?.state as AudioContextState | 'interrupted' | undefined;
        if (state && state !== 'running' && graphRef.current?.context === context) {
          graphRef.current = null;
          setPlaying(false);
          setError(translate('dream.soundInterrupted'));
          void context?.close().catch(() => undefined);
        }
      });
      setPlaying(true);
    } catch (reason) {
      graphRef.current = null;
      setPlaying(false);
      setError(reason instanceof Error ? reason.message : translate('dream.soundStartFailed'));
      if (context && context.state !== 'closed') {
        void context.close().catch(() => undefined);
      }
    }
  }, [customSounds, fadeOut, focusId, focusRunning, requiresAudioRearm, sound, volume]);

  useEffect(() => {
    const api = window.electronAPI?.focusSound;
    if (!api) return undefined;
    const accept = (result: { available: boolean; records: FocusSoundRecord[] }) => {
      setCustomSounds(result.available ? result.records : []);
    };
    void api.list().then(accept).catch(() => setError(translate('dream.soundStartFailed')));
    return api.onChanged(accept);
  }, []);

  useEffect(() => {
    const wasRunning = previousFocusRunningRef.current;
    previousFocusRunningRef.current = focusRunning;
    if (wasRunning && !focusRunning && playing) void stop();
  }, [focusRunning, playing, stop]);

  useEffect(() => {
    const interrupt = () => {
      if (document.hidden && graphRef.current) {
        void stop();
        setError(translate('dream.soundBackgroundStopped'));
      }
    };
    const deviceChanged = () => {
      if (graphRef.current) {
        void stop();
        setError(translate('dream.soundDeviceChanged'));
      }
    };
    const lifecycleChanged = (event: { state: string }) => {
      if (
        graphRef.current
        && ['suspend', 'hidden', 'lock', 'shutdown'].includes(event.state)
      ) {
        void stop();
        setError(translate('dream.soundSystemPaused'));
      }
    };
    document.addEventListener('visibilitychange', interrupt);
    navigator.mediaDevices?.addEventListener?.('devicechange', deviceChanged);
    const unsubscribeLifecycle = window.electronAPI?.onAppLifecycle?.(lifecycleChanged);
    return () => {
      document.removeEventListener('visibilitychange', interrupt);
      navigator.mediaDevices?.removeEventListener?.('devicechange', deviceChanged);
      unsubscribeLifecycle?.();
      void stop();
    };
  }, [stop]);

  const setSound = useCallback((next: Soundscape) => {
    setSoundState(next);
    persist(next, volume, autoStart);
    if (playing) void stop();
  }, [autoStart, persist, playing, stop, volume]);

  const setVolume = useCallback((next: number) => {
    const safe = Math.min(1, Math.max(0, next));
    setVolumeState(safe);
    persist(sound, safe, autoStart);
    const graph = graphRef.current;
    if (graph) {
      const now = graph.context.currentTime;
      graph.gain.gain.cancelScheduledValues(now);
      graph.gain.gain.linearRampToValueAtTime(safe, now + 0.08);
    }
  }, [autoStart, persist, sound]);

  const setAutoStart = useCallback((next: boolean) => {
    setAutoStartState(next);
    persist(sound, volume, next);
  }, [persist, sound, volume]);

  return {
    sound,
    setSound,
    volume,
    setVolume,
    autoStart,
    setAutoStart,
    playing,
    error,
    customSounds,
    importSound: async () => {
      const record = await window.electronAPI?.focusSound?.import();
      if (record) setSound(`custom:${record.id}`);
      return record ?? null;
    },
    removeSound: async (id: string) => {
      await window.electronAPI?.focusSound?.remove(id);
      if (sound === `custom:${id}`) setSound('rain');
    },
    startForSession: () => start(true),
    arm,
    toggle: async () => {
      if (playing) return stop();
      if (!await arm()) return;
      return start(true);
    },
    stop,
  };
}
