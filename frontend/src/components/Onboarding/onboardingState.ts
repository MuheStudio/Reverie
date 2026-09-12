export const ONBOARDING_VERSION = 3;

export const ONBOARDING_STEPS = [
  'welcome',
  'mode',
  'profile',
  'deepseek',
  'optional-media',
  'features',
  'rooms',
  'cards',
  'location',
  'pet',
  'finish',
] as const;

export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export type ExperienceMode = 'full' | 'core';
export type ProviderPreset = 'deepseek' | 'custom';

export type OnboardingDraft = {
  step: OnboardingStep;
  experienceMode: ExperienceMode;
  age: number;
  nickname: string;
  adultConfirmed: boolean;
  aiConfirmed: boolean;
  profileAccepted: boolean;
  providerCommitted: boolean;
  live2dInstalled: boolean;
};

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && ONBOARDING_STEPS.includes(value as OnboardingStep);
}

export function initialOnboardingStep(
  lastStep: unknown,
  version: unknown,
  completed: unknown = false,
): OnboardingStep {
  if (version !== ONBOARDING_VERSION || !isOnboardingStep(lastStep)) return 'welcome';
  // An unfinished wizard that last wrote "finish" must not reopen on the
  // completion page: that step's Continue is gated on session-only flags,
  // so restoring it traps the user on step 10.
  if (lastStep === 'finish' && completed !== true) return 'welcome';
  return lastStep;
}

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

export function moveStep(step: OnboardingStep, direction: 1 | -1): OnboardingStep {
  const next = Math.min(ONBOARDING_STEPS.length - 1, Math.max(0, stepIndex(step) + direction));
  return ONBOARDING_STEPS[next];
}

export function canContinue(draft: OnboardingDraft): boolean {
  if (draft.step === 'profile') {
    return Number.isInteger(draft.age)
      && draft.age >= 18
      && draft.age <= 120
      && draft.adultConfirmed
      && draft.aiConfirmed;
  }
  if (draft.step === 'deepseek') return draft.profileAccepted && draft.providerCommitted;
  if (draft.step === 'optional-media') {
    return draft.experienceMode === 'core' || draft.live2dInstalled;
  }
  if (draft.step === 'finish') {
    return draft.profileAccepted
      && draft.providerCommitted
      && (draft.experienceMode === 'core' || draft.live2dInstalled);
  }
  return true;
}
