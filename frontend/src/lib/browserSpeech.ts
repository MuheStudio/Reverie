// Browser SpeechSynthesis fallback (Luna-ts webSpeechSink + voicePick
// pattern, trimmed for React): when the cloud TTS backend is unconfigured or
// fails, Windows built-in voices keep her speaking. Voice lists load
// asynchronously (voiceschanged) and are often empty on the first call, so
// they are warmed with a bounded timeout. A failed fallback must never block
// chat delivery — speak() resolves false and the caller moves on.

const VOICE_WARMUP_TIMEOUT_MS = 1_200;

// Word-boundary matching for Latin tokens so "male" never matches "Fe-male";
// plain substring for CJK gender markers (Luna voicePick lesson).
const FEMALE_MARKERS = [
  'female', 'woman', 'girl', 'huihui', 'yaoyao', 'tingting', 'meijia',
  'hanhan', 'xiaoxiao', 'xiaoyi', 'yunxi-female', 'ayu', 'kangkana',
];
const MALE_MARKERS = ['male', 'man', 'boy', 'kangkang', 'yunyang', 'zhiwei'];

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function speechSynthesis(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null;
}

export function browserSpeechSupported(): boolean {
  return speechSynthesis() !== null;
}

export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = speechSynthesis();
  if (!synth) return Promise.resolve([]);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const immediate = synth.getVoices();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }
    let settled = false;
    const finish = (voices: SpeechSynthesisVoice[]) => {
      if (settled) return;
      settled = true;
      synth.removeEventListener('voiceschanged', onChanged);
      resolve(voices);
    };
    const onChanged = () => finish(synth.getVoices());
    synth.addEventListener('voiceschanged', onChanged);
    window.setTimeout(() => finish(synth.getVoices()), VOICE_WARMUP_TIMEOUT_MS);
  });
  return voicesPromise;
}

export function detectTextLang(text: string): string {
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja-JP';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko-KR';
  return 'en-US';
}

// Structural subset so pure tests can run without the DOM
// (SpeechSynthesisVoice satisfies it).
export type VoiceLike = {
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
};

function wordBoundaryMatch(name: string, marker: string): boolean {
  if (/[\u4e00-\u9fff]/.test(marker)) return name.includes(marker);
  return new RegExp(`\\b${marker}\\b`, 'i').test(name);
}

export function pickVoice<T extends VoiceLike>(
  voices: T[],
  lang: string,
): T | null {
  if (!voices.length) return null;
  let best: { voice: T; score: number } | null = null;
  for (const voice of voices) {
    const name = voice.name || '';
    if (MALE_MARKERS.some((marker) => wordBoundaryMatch(name, marker))) continue;
    let score = 0;
    if (voice.lang === lang) score += 100;
    else if (voice.lang?.replace('_', '-').toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())) score += 40;
    else continue;
    if (FEMALE_MARKERS.some((marker) => wordBoundaryMatch(name, marker))) score += 60;
    if (voice.localService) score += 5;
    if (voice.default) score -= 1;
    if (!best || score > best.score) best = { voice, score };
  }
  return best?.voice ?? null;
}

export function cancelBrowserSpeech(): void {
  speechSynthesis()?.cancel();
}

export async function speakWithBrowserVoice(text: string): Promise<boolean> {
  const synth = speechSynthesis();
  const trimmed = text.trim().slice(0, 4_000);
  if (!synth || !trimmed) return false;
  try {
    const voices = await loadVoices();
    const lang = detectTextLang(trimmed);
    const utterance = new SpeechSynthesisUtterance(trimmed);
    const voice = pickVoice(voices, lang);
    if (voice) utterance.voice = voice;
    // Even with no matching voice, setting lang lets the engine pick one.
    utterance.lang = voice?.lang || lang;
    utterance.rate = 1.02;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      utterance.onend = done;
      utterance.onerror = done;
      // Some engines never fire onstart/onerror (WebKit quirk); a watchdog
      // guarantees the promise settles so the chat flow is never held.
      window.setTimeout(done, Math.max(6_000, trimmed.length * 180));
      synth.speak(utterance);
    });
    return true;
  } catch {
    return false;
  }
}
