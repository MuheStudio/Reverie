import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_VERSION,
  canContinue,
  initialOnboardingStep,
  moveStep,
  type OnboardingDraft,
} from './onboardingState';

const draft: OnboardingDraft = {
  step: 'welcome',
  experienceMode: 'full',
  age: 18,
  nickname: '',
  adultConfirmed: false,
  aiConfirmed: false,
  profileAccepted: false,
  providerCommitted: false,
  live2dInstalled: false,
};

describe('onboarding state', () => {
  it('resumes only a valid step from the current onboarding version', () => {
    expect(initialOnboardingStep('location', ONBOARDING_VERSION)).toBe('location');
    expect(initialOnboardingStep('location', 1)).toBe('welcome');
    expect(initialOnboardingStep('unknown', ONBOARDING_VERSION)).toBe('welcome');
  });

  it('does not restore an unfinished finish step', () => {
    expect(initialOnboardingStep('finish', ONBOARDING_VERSION)).toBe('welcome');
    expect(initialOnboardingStep('finish', ONBOARDING_VERSION, false)).toBe('welcome');
    expect(initialOnboardingStep('finish', ONBOARDING_VERSION, true)).toBe('finish');
    expect(initialOnboardingStep('pet', ONBOARDING_VERSION, false)).toBe('pet');
  });

  it('moves within the ordered wizard bounds', () => {
    expect(moveStep('welcome', -1)).toBe('welcome');
    expect(moveStep('welcome', 1)).toBe('mode');
    expect(moveStep('rooms', 1)).toBe('cards');
    expect(moveStep('cards', 1)).toBe('location');
    expect(moveStep('finish', 1)).toBe('finish');
  });

  it('requires age and both acknowledgements on the profile step', () => {
    expect(canContinue({ ...draft, step: 'profile' })).toBe(false);
    expect(canContinue({
      ...draft,
      step: 'profile',
      adultConfirmed: true,
      aiConfirmed: true,
    })).toBe(true);
    expect(canContinue({
      ...draft,
      step: 'profile',
      age: 17,
      adultConfirmed: true,
      aiConfirmed: true,
    })).toBe(false);
  });

  it('blocks the AI step and finish until the secure commit succeeds', () => {
    expect(canContinue({ ...draft, step: 'deepseek' })).toBe(false);
    expect(canContinue({ ...draft, step: 'finish' })).toBe(false);
    expect(canContinue({ ...draft, step: 'deepseek', providerCommitted: true })).toBe(false);
    expect(canContinue({ ...draft, step: 'deepseek', profileAccepted: true, providerCommitted: true })).toBe(true);
    expect(canContinue({
      ...draft,
      step: 'finish',
      profileAccepted: true,
      providerCommitted: true,
      live2dInstalled: true,
    })).toBe(true);
  });

  it('requires a Live2D install in full mode and allows core mode to skip it', () => {
    expect(canContinue({ ...draft, step: 'optional-media', experienceMode: 'full' })).toBe(false);
    expect(canContinue({
      ...draft,
      step: 'optional-media',
      experienceMode: 'full',
      live2dInstalled: true,
    })).toBe(true);
    expect(canContinue({ ...draft, step: 'optional-media', experienceMode: 'core' })).toBe(true);
    expect(canContinue({
      ...draft,
      step: 'finish',
      profileAccepted: true,
      providerCommitted: true,
      experienceMode: 'full',
    })).toBe(false);
    expect(canContinue({
      ...draft,
      step: 'finish',
      profileAccepted: true,
      providerCommitted: true,
      experienceMode: 'core',
    })).toBe(true);
  });
});
