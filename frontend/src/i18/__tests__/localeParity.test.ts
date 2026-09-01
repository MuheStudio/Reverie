import { describe, expect, it } from 'vitest';
import translation from '../locale';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
    flattenKeys(child, prefix ? `${prefix}.${key}` : key)
  ));
}

describe('i18n locale parity', () => {
  it('zh and en expose the exact same key set', () => {
    const zhKeys = flattenKeys(translation.zh).sort();
    const enKeys = flattenKeys(translation.en).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('the zh locale is non-empty and holds the dream.* surface', () => {
    const keys = flattenKeys(translation.zh);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys).toContain('dream.focus');
    expect(keys).toContain('dream.start');
    expect(keys).toContain('dream.avatarMapping');
  });

  it('zh and en resolve the dream tab labels (es/pt/ja are stub locales)', () => {
    for (const lng of ['zh', 'en'] as const) {
      const table = translation[lng] as unknown as Record<string, string>;
      expect(table['dream.focus'], `${lng}.dream.focus`).toBeTruthy();
      expect(table['dream.chat'], `${lng}.dream.chat`).toBeTruthy();
    }
  });
});
