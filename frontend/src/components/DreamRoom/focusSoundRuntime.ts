import rainUrl from '@/assets/dreamroom/focus-rain.ogg?url';
import fireUrl from '@/assets/dreamroom/focus-fire.ogg?url';
import windUrl from '@/assets/dreamroom/focus-wind.ogg?url';
import libraryUrl from '@/assets/dreamroom/focus-library.wav?url';

export type BuiltInSoundscape = 'rain' | 'wind' | 'fire' | 'library' | 'pink';
export type Soundscape = BuiltInSoundscape | `custom:${string}`;

export interface FocusSoundGraph {
  context: AudioContext;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

type FetchAudio = (input: RequestInfo | URL) => Promise<Pick<Response, 'ok' | 'arrayBuffer'>>;

// Real recorded ambiences (CC0 / CC-BY, see LICENSES_CREDITS/FOCUS-SOUNDS-NOTICE.txt).
// library keeps the gentle synthesized room hum until a suitable recording lands.
const BUILT_IN_URLS: Record<Exclude<BuiltInSoundscape, 'pink'>, string> = {
  rain: rainUrl,
  wind: windUrl,
  fire: fireUrl,
  library: libraryUrl,
};

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

export function createPinkNoiseBuffer(context: AudioContext): AudioBuffer {
  const seconds = 5;
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(2, seconds * sampleRate, sampleRate);
  const random = seeded(557);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    let pink0 = 0;
    let pink1 = 0;
    for (let index = 0; index < data.length; index += 1) {
      const white = random() * 2 - 1;
      pink0 = 0.99765 * pink0 + white * 0.099046;
      pink1 = 0.963 * pink1 + white * 0.2965164;
      data[index] = (pink0 + pink1 + white * 0.1848) * 0.1;
    }
  }
  return buffer;
}

export async function loadFocusSoundBuffer(
  context: AudioContext,
  sound: Soundscape,
  fetchAudio: FetchAudio = fetch,
  customUrl = '',
): Promise<{ buffer: AudioBuffer; usedFallback: boolean }> {
  if (sound === 'pink') {
    return { buffer: createPinkNoiseBuffer(context), usedFallback: true };
  }
  const assetUrl = sound.startsWith('custom:')
    ? customUrl
    : BUILT_IN_URLS[sound as Exclude<BuiltInSoundscape, 'pink'>];
  if (!assetUrl) throw new Error('所选专注声音文件不可用');
  try {
    const response = await fetchAudio(assetUrl);
    if (!response.ok) throw new Error('audio asset unavailable');
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.numberOfChannels < 1) {
      throw new Error('decoded audio is empty');
    }
    return { buffer, usedFallback: false };
  } catch (reason) {
    const detail = reason instanceof Error ? `: ${reason.message}` : '';
    throw new Error(`无法加载所选专注声音${detail}`);
  }
}

function startGraph(
  context: AudioContext,
  buffer: AudioBuffer,
  volume: number,
): FocusSoundGraph {
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain).connect(context.destination);
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.linearRampToValueAtTime(volume, context.currentTime + 0.55);
  try {
    source.start();
  } catch (error) {
    source.disconnect();
    gain.disconnect();
    throw error;
  }
  return { context, source, gain };
}

export async function attemptFocusPlayback(
  context: AudioContext,
  sound: Soundscape,
  volume: number,
  fetchAudio: FetchAudio = fetch,
  customUrl = '',
): Promise<{ graph: FocusSoundGraph; usedFallback: boolean } | null> {
  const loaded = await loadFocusSoundBuffer(context, sound, fetchAudio, customUrl);
  return {
    graph: startGraph(context, loaded.buffer, volume),
    usedFallback: loaded.usedFallback,
  };
}
