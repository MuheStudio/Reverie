import { describe, expect, it } from 'vitest';

import { detectTextLang, pickVoice, type VoiceLike } from './browserSpeech';

describe('browser speech fallback', () => {
  it('detects CJK languages before latin', () => {
    expect(detectTextLang('こんにちは')).toBe('ja-JP');
    expect(detectTextLang('今天累死了')).toBe('zh-CN');
    expect(detectTextLang('안녕하세요')).toBe('ko-KR');
    expect(detectTextLang('See you tomorrow!')).toBe('en-US');
  });

  it('prefers same-language female voices and never picks marked male voices', () => {
    const voices: VoiceLike[] = [
      { name: 'Microsoft Kangkang', lang: 'zh-CN', localService: true },
      { name: 'Microsoft Huihui', lang: 'zh-CN', localService: true },
      { name: 'Microsoft Zira', lang: 'en-US', localService: true },
    ];
    const picked = pickVoice(voices, 'zh-CN');
    expect(picked?.name).toBe('Microsoft Huihui');
    // Wrong-language voices are never eligible, even as fallback.
    expect(pickVoice(voices, 'ko-KR')).toBeNull();
  });

  it('scores exact locale above same-language and rewards local service', () => {
    const voices: VoiceLike[] = [
      { name: 'Google 小姐', lang: 'zh-TW', localService: false },
      { name: 'Microsoft Yaoyao', lang: 'zh-CN', localService: true },
    ];
    expect(pickVoice(voices, 'zh-CN')?.name).toBe('Microsoft Yaoyao');
  });

  it('handles the Fe-male trap with word boundaries', () => {
    const voices: VoiceLike[] = [
      { name: 'Fe-male Bot', lang: 'zh-CN', localService: false },
      { name: 'Microsoft Hanhan', lang: 'zh-CN', localService: true },
    ];
    expect(pickVoice(voices, 'zh-CN')?.name).toBe('Microsoft Hanhan');
  });
});
