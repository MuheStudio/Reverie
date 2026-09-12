import { describe, expect, it } from 'vitest';
import {
  formatFileSize,
  isExactGptSovitsV2,
  live2dPreviewFailureMessage,
  live2dRuntimeUnavailableMessage,
  parseVoicePackScan,
} from './optionalMediaHelpers';

describe('optional media helpers', () => {
  it('extracts a safe voice-pack scan summary', () => {
    const summary = parseVoicePackScan({
      previewId: 'preview-id',
      format: 'legacy-gpt-sovits',
      runtimeFamily: 'gpt-sovits',
      runtimeVersion: 'v2',
      wrapperDirectory: 'voice',
      files: [
        { role: 'referenceAudio', originalName: 'reference.wav', size: 2048, absolutePath: 'secret' },
        { role: 4, originalName: 'ignored.txt', size: 2 },
      ],
      referenceAudio: { durationSeconds: 4.5, sampleRate: 32000, channels: 1 },
      transcript: { characters: 42 },
    });

    expect(summary).toEqual({
      previewId: 'preview-id',
      format: 'legacy-gpt-sovits',
      runtimeFamily: 'gpt-sovits',
      runtimeVersion: 'v2',
      wrapperDirectory: 'voice',
      files: [{ role: 'referenceAudio', name: 'reference.wav', size: 2048 }],
      referenceAudio: { durationSeconds: 4.5, sampleRate: 32000, channels: 1 },
      transcriptCharacters: 42,
    });
    expect(isExactGptSovitsV2(summary)).toBe(true);
  });

  it('rejects malformed scans and non-v2 runtimes', () => {
    expect(parseVoicePackScan(null)).toBeNull();
    expect(parseVoicePackScan({ runtimeFamily: 'gpt-sovits' })).toBeNull();
    expect(isExactGptSovitsV2(parseVoicePackScan({
      previewId: 'preview-id', runtimeFamily: 'gpt-sovits', runtimeVersion: 'v1',
    }))).toBe(false);
  });

  it('formats scan file sizes without exposing paths', () => {
    expect(formatFileSize(null)).toBe('大小未知');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('explains a disabled Live2D runtime before the user picks a folder', () => {
    expect(live2dRuntimeUnavailableMessage(undefined)).toBeNull();
    expect(live2dRuntimeUnavailableMessage({ live2d: { available: true } })).toBeNull();
    expect(live2dRuntimeUnavailableMessage({ live2d: { available: false, reason: 'gated' } }))
      .toContain('此构建未启用 Live2D 运行时：gated');
  });

  it('adds a Cubism Core version hint when preview rendering fails', () => {
    expect(live2dPreviewFailureMessage('Live2D 候选模型未能成功渲染。'))
      .toContain('修复建议');
    expect(live2dPreviewFailureMessage('Live2D 候选模型未能成功渲染。', 4))
      .toContain('Cubism Core 4+');
  });
});
