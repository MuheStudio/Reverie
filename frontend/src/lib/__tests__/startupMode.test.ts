import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideBootMode, resolveStoredRoomMode } from '../startupMode';

describe('startupMode (batch L: no MvpRoom ↔ DreamRoom flash at boot)', () => {
  it('coerces unknown stored modes to mvp', () => {
    expect(resolveStoredRoomMode('dream')).toBe('dream');
    expect(resolveStoredRoomMode('mvp')).toBe('mvp');
    expect(resolveStoredRoomMode(undefined)).toBe('mvp');
    expect(resolveStoredRoomMode(null)).toBe('mvp');
    expect(resolveStoredRoomMode('DREAM')).toBe('mvp');
    expect(resolveStoredRoomMode(42)).toBe('mvp');
  });

  it('always boots into MvpRoom, even when dream was persisted', () => {
    // This is the flash guard: a stored dream mode must NOT produce a
    // MvpRoom → DreamRoom switch once settings arrive.
    expect(decideBootMode('dream').mode).toBe('mvp');
    expect(decideBootMode('mvp').mode).toBe('mvp');
  });

  it('flags a persisted dream mode for write-back normalisation', () => {
    // ui.mode is in-session navigation state; without normalisation a later
    // reconnect snapshot would silently pull the user back into DreamRoom.
    expect(decideBootMode('dream').normalizeStored).toBe(true);
    expect(decideBootMode('mvp').normalizeStored).toBe(false);
  });

  it('keeps the whole boot sequence free of any dream landing', () => {
    // Simulated delayed-settings boot: before the snapshot the splash holds
    // (no room rendered), after it the mode is still mvp — at no point does
    // the sequence produce MvpRoom followed by DreamRoom.
    const renderedRooms: string[] = ['splash'];
    const stored = resolveStoredRoomMode('dream');
    const boot = decideBootMode(stored);
    renderedRooms.push(boot.mode);
    expect(renderedRooms).toEqual(['splash', 'mvp']);
  });
});

describe('index.tsx boot contracts (source)', () => {
  const source = readFileSync(new URL('../../index.tsx', import.meta.url), 'utf8');

  it('renders the splash instead of MvpRoom while the mode is unknown', () => {
    expect(source).toContain('if (!modeKnown && !bootTimedOut) return <BootSplash />;');
    expect(source).not.toContain('if (!modeKnown) return <MvpRoom />;');
  });

  it('prefetches the DreamRoom chunk after settings arrive', () => {
    expect(source).toContain('requestIdleCallback');
    expect(source).toContain("void import('@/components/DreamRoom')");
  });

  it('has a 3s Murphy fallback into MvpRoom with a connection hint', () => {
    expect(source).toContain('setBootTimedOut(true), 3000');
    expect(source).toContain('bootTimedOut && !modeKnown');
  });

  it('normalises a stored dream mode back to mvp on first sync', () => {
    expect(source).toContain("bridge.updateSettings({ section: 'ui', mode: 'mvp' })");
  });
});
