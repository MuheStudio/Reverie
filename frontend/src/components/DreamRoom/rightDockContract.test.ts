import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), 'utf8');
}

describe('DreamRoom right-docked panel contract', () => {
  it('renders companion fallback notices through a polite live region', () => {
    const games = source('MiniGamePanel.tsx');
    expect(games).toMatch(/className=\{styles\.companionBar\} aria-live="polite"/);
    expect(games).toContain('{(comment || notice) && <span>{comment || notice}</span>}');
  });

  it('marks the dialog as right-aligned and keeps a separate close scrim', () => {
    const room = source('index.tsx');
    expect(room).toContain('data-testid="dream-room-panel"');
    expect(room).toContain("data-align={dockRight ? 'right' : undefined}");
    expect(room).toMatch(/className=\{styles\.drawerScrim\}[\s\S]*onClick=\{onClose\}/);
    expect(room).toMatch(/<section[^>]*className=\{styles\.drawerSheet\}/);
  });

  it('right-aligns desktop panels without darkening the room', () => {
    const css = source('index.module.scss');
    expect(css).toMatch(/@media \(min-width: 761px\)[\s\S]*\.roomDrawer\[data-align='right'\][\s\S]*justify-items: end/);
    expect(css).toMatch(/\.roomDrawer\[data-align='right'\] \.drawerScrim\s*\{\s*background: transparent;/);
    expect(css).toMatch(/\.drawerScrim\s*\{[\s\S]*position: absolute;[\s\S]*inset: 0;/);
  });

  it('bounds the sheet within common desktop and mobile viewports', () => {
    const css = source('index.module.scss');
    expect(css).toContain('width: min(760px, calc(100vw - 48px));');
    expect(css).toContain('width: min(980px, calc(100vw - 48px));');
    expect(css).toContain('max-height: min(760px, calc(100vh - 52px));');

    const boundedWidth = (viewportWidth: number, preferredWidth: number) => Math.min(preferredWidth, viewportWidth - 48);
    expect(boundedWidth(1440, 980)).toBe(980);
    expect(boundedWidth(1024, 980)).toBe(976);
    expect(boundedWidth(390, 760)).toBe(342);
    expect(Math.min(760, 768 - 52)).toBe(716);
  });
});
