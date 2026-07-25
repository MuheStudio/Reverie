import { describe, expect, it, vi } from 'vitest';
import {
  attemptFocusPlayback,
  createWindNoiseBuffer,
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
    createBuffer: (channels: number, length: number, sampleRate: number) => (
      audioBuffer(channels, length, sampleRate)
    ),
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
  it('falls back to generated pink noise when a bundled asset returns 404', async () => {
    const context = audioContext();
    const fetchAudio = vi.fn(async () => ({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    const result = await loadFocusSoundBuffer(context, 'rain', fetchAudio);

    expect(fetchAudio).toHaveBeenCalledOnce();
    expect(result.usedFallback).toBe(true);
    expect(result.buffer.duration).toBe(5);
    expect(context.decodeAudioData).not.toHaveBeenCalled();
  });

  it('returns no graph when both asset and pink-noise playback fail', async () => {
    const context = audioContext({ startFails: true });
    const fetchAudio = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));

    const result = await attemptFocusPlayback(context, 'fire', 0.2, fetchAudio);

    expect(result).toBeNull();
    expect(context.createBufferSource).toHaveBeenCalledTimes(2);
  });

  it('generates the bundled wind sound locally without fetching a remote asset', async () => {
    const context = audioContext();
    const fetchAudio = vi.fn();
    const result = await loadFocusSoundBuffer(context, 'wind', fetchAudio);
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(result.usedFallback).toBe(false);
    expect(result.buffer.duration).toBe(8);
    expect(createWindNoiseBuffer(context).numberOfChannels).toBe(2);
  });
});
