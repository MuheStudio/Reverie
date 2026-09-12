import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decideBootMode,
  isOnboardingComplete,
  resolveStoredRoomMode,
} from '../startupMode';

describe('startupMode (batch L: no MvpRoom ↔ DreamRoom flash at boot)', () => {
  it('coerces unknown stored modes to mvp', () => {
    expect(resolveStoredRoomMode('dream')).toBe('dream');
    expect(resolveStoredRoomMode('mvp')).toBe('mvp');
    expect(resolveStoredRoomMode(undefined)).toBe('mvp');
    expect(resolveStoredRoomMode(null)).toBe('mvp');
    expect(resolveStoredRoomMode('DREAM')).toBe('mvp');
    expect(resolveStoredRoomMode(42)).toBe('mvp');
  });

  it('treats only completed version 2+ as finished onboarding', () => {
    expect(isOnboardingComplete(null)).toBe(false);
    expect(isOnboardingComplete({ onboarding_completed: false, onboarding_version: 2 })).toBe(false);
    expect(isOnboardingComplete({ onboarding_completed: true, onboarding_version: 1 })).toBe(false);
    expect(isOnboardingComplete({ onboarding_completed: true, onboarding_version: 2 })).toBe(true);
  });

  it('forces MvpRoom while onboarding is incomplete even if dream was stored', () => {
    expect(decideBootMode('dream').mode).toBe('mvp');
    expect(decideBootMode('dream', false).mode).toBe('mvp');
    expect(decideBootMode('mvp', false).mode).toBe('mvp');
  });

  it('honours the persisted room mode once onboarding is complete', () => {
    // The splash holds rendering until the first snapshot arrives, so landing
    // directly on the stored mode never produces a MvpRoom → DreamRoom flash.
    expect(decideBootMode('dream', true).mode).toBe('dream');
    expect(decideBootMode('mvp', true).mode).toBe('mvp');
  });

  it('never rewrites the stored mode', () => {
    // ui.mode is in-session navigation state and is also the boot target;
    // incomplete onboarding only changes the landing room, not the stored value.
    expect(decideBootMode('dream', true).normalizeStored).toBe(false);
    expect(decideBootMode('mvp', false).normalizeStored).toBe(false);
  });

  it('lands once, on the stored mode, with no room flash when onboarding is complete', () => {
    const renderedRooms: string[] = ['splash'];
    const stored = resolveStoredRoomMode('dream');
    const boot = decideBootMode(stored, true);
    renderedRooms.push(boot.mode);
    expect(renderedRooms).toEqual(['splash', 'dream']);
  });
});

describe('index.tsx boot contracts (source)', () => {
  const source = readFileSync(new URL('../../index.tsx', import.meta.url), 'utf8');

  it('renders the splash instead of MvpRoom while the mode is unknown', () => {
    expect(source).toContain('if (!modeKnown && !bootTimedOut)');
    expect(source).toContain('<BootSplash />');
    expect(source).not.toContain('if (!modeKnown) return <MvpRoom />;');
  });

  it('prefetches the DreamRoom chunk after settings arrive', () => {
    expect(source).toContain('requestIdleCallback');
    expect(source).toContain("void import('@/components/DreamRoom')");
  });

  it('has a 3s Murphy fallback and keeps the wizard visible while Python is down', () => {
    expect(source).toContain('setBootTimedOut(true), 3000');
    expect(source).toContain('bootTimedOut && !hostReady');
    expect(source).toContain('新手引导可以先导入 Live2D');
  });

  it('can mount the wizard over the splash before Python settings.ui arrives', () => {
    expect(source).toContain('window.electronAPI?.appState?.getUiSnapshot');
    expect(source).toContain('const wizard = electronUiKnown && !onboardingCompleted');
    expect(source).toContain('<BootSplash />');
    expect(source).toContain('{wizard}');
  });

  it('gates first sync on onboarding completion so leftover dream cannot hide the wizard', () => {
    expect(source).toContain('const boot = decideBootMode(stored, complete);');
    expect(source).toContain('setMode(boot.mode);');
    expect(source).toContain('<OnboardingWizard');
    expect(source).toContain('onboardingDismissed');
    expect(source).toContain('key="reverie-onboarding"');
    expect(source).not.toContain("updateSettings({ section: 'ui', mode: 'mvp' })");
  });
});
