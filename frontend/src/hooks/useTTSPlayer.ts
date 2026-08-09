/**
 * TTS playback hook — plays base64 audio parts from the backend TTS bridge.
 *
 * Parts are played sequentially in order. Audio is decoded via the Web Audio
 * API so playback can be stopped/restarted instantly, and the hook exposes
 * utterance boundaries plus a live amplitude level (0..1) that drives
 * energy-based mouth movement (a lightweight wLipSync-style lip-sync).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface TTSAudioPart {
  audio: string;
  index: number;
}

export interface TTSPlaybackOptions {
  voice?: string;
  provider?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onPartStart?: (index: number) => void;
  onPartEnd?: (index: number) => void;
  onAmplitude?: (level: number) => void;
  onError?: (error: Error) => void;
}

let audioContext: AudioContext | null = null;
function sharedAudioContext(): AudioContext {
  if (!audioContext) {
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not supported');
    audioContext = new Ctor();
  }
  if (audioContext.state === 'suspended') void audioContext.resume();
  return audioContext;
}

async function decodePart(context: AudioContext, base64: string): Promise<AudioBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return context.decodeAudioData(bytes.buffer.slice(0));
}

export function useTTSPlayer() {
  const [playing, setPlaying] = useState(false);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const cancelledRef = useRef(false);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const amplitudeFrameRef = useRef(0);

  const clearAmplitudeLoop = useCallback(() => {
    if (amplitudeFrameRef.current) {
      cancelAnimationFrame(amplitudeFrameRef.current);
      amplitudeFrameRef.current = 0;
    }
    analyserRef.current?.disconnect();
    analyserRef.current = null;
  }, []);

  const startAmplitudeLoop = useCallback((analyser: AnalyserNode, onAmplitude: (level: number) => void) => {
    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!analyserRef.current) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      // Compress into a livelier 0..1 level; very quiet audio stays near zero
      // so the mouth stays closed between phonemes.
      const level = Math.min(1, rms * 6);
      onAmplitude(level);
      amplitudeFrameRef.current = requestAnimationFrame(tick);
    };
    amplitudeFrameRef.current = requestAnimationFrame(tick);
  }, []);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    sourceRef.current?.stop();
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    clearAmplitudeLoop();
    setPlaying(false);
  }, [clearAmplitudeLoop]);

  const play = useCallback(async (
    parts: TTSAudioPart[],
    options: TTSPlaybackOptions = {},
  ) => {
    if (!parts.length) {
      options.onError?.(new Error('No audio parts to play'));
      return;
    }
    stop();
    cancelledRef.current = false;
    setPlaying(true);
    options.onStart?.();
    try {
      const context = sharedAudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      analyserRef.current = analyser;
      analyser.connect(context.destination);
      if (options.onAmplitude) startAmplitudeLoop(analyser, options.onAmplitude);
      const ordered = [...parts].sort((a, b) => a.index - b.index);
      for (let i = 0; i < ordered.length; i += 1) {
        if (cancelledRef.current) break;
        const part = ordered[i];
        options.onPartStart?.(part.index);
        const buffer = await decodePart(context, part.audio);
        if (cancelledRef.current) break;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(analyser);
        sourceRef.current = source;
        await new Promise<void>((resolve) => {
          source.onended = () => resolve();
          source.start();
        });
        if (cancelledRef.current) break;
        sourceRef.current = null;
        options.onPartEnd?.(part.index);
      }
      if (!cancelledRef.current) options.onEnd?.();
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      cancelledRef.current = true;
      sourceRef.current?.disconnect();
      sourceRef.current = null;
      clearAmplitudeLoop();
      options.onAmplitude?.(0);
      setPlaying(false);
    }
  }, [stop, clearAmplitudeLoop, startAmplitudeLoop]);

  useEffect(() => () => stop(), [stop]);

  return { play, stop, playing };
}
