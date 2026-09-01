import { describe, expect, it, vi } from 'vitest';
import {
  attemptFocusPlayback,
  loadFocusSoundBuffer,
} from './focusSoundRuntime';

function audioBuffer(channels = 2, length = 128, sampleRate = 16_000): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    duration: length / sampleRate,
    length,
    numberOfChannels: channels,
    sampleRate,
    getChannelData: (channel: number) => data[channel],
  } as AudioBuffer;
}

function audioContext(options: { startFails?: boolean } = {}): AudioContext {
  const gain = {
    gain: {
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  gain.connect.mockReturnValue(gain);
  return {
    sampleRate: 16_000,
    currentTime: 0,
    destination: {},
    createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => (
      audioBuffer(channels, length, sampleRate)
    )),
    decodeAudioData: vi.fn(async () => audioBuffer()),
    createGain: vi.fn(() => gain),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      loop: false,
      connect: vi.fn(() => gain),
      disconnect: vi.fn(),
      start: vi.fn(() => {
        if (options.startFails) throw new Error('output device unavailable');
      }),
      stop: vi.fn(),
    })),
  } as unknown as AudioContext;
}

describe('focus sound runtime', () => {
  it('rejects instead of substituting pink noise when a recorded asset returns 404', async () => {
    const context = audioContext();
    const fetchAudio = vi.fn(async () => ({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    await expect(loadFocusSoundBuffer(context, 'rain', fetchAudio))
      .rejects.toThrow('无法加载所选专注声音: audio asset unavailable');

    expect(fetchAudio).toHaveBeenCalledOnce();
    expect(context.createBuffer).not.toHaveBeenCalled();
    expect(context.decodeAudioData).not.toHaveBeenCalled();
  });

  it('surfaces recorded playback failure without trying pink noise', async () => {
    const context = audioContext({ startFails: true });
    const fetchAudio = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));

    await expect(attemptFocusPlayback(context, 'fire', 0.2, fetchAudio))
      .rejects.toThrow('output device unavailable');

    expect(context.createBufferSource).toHaveBeenCalledOnce();
    expect(context.createBuffer).not.toHaveBeenCalled();
  });

  it.each(['rain', 'fire', 'wind'] as const)(
    'decodes the recorded %s asset from its bundled url',
    async (sound) => {
    const context = audioContext();
    const fetchAudio = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    const result = await loadFocusSoundBuffer(context, sound, fetchAudio);
    expect(fetchAudio).toHaveBeenCalledOnce();
    expect(String(fetchAudio.mock.calls[0]?.[0])).toContain(`focus-${sound}`);
    expect(result.usedFallback).toBe(false);
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
    },
  );

  it('reports the fallback instead of failing when the pink-noise path is used directly', async () => {
    const context = audioContext();
    const fetchAudio = vi.fn(async () => ({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const result = await loadFocusSoundBuffer(context, 'pink', fetchAudio);
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(result.usedFallback).toBe(true);
  });
});
