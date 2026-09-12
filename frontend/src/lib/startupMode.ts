/**
 * Startup room-mode resolution (batch L).
 *
 * `settings.ui.mode` is in-session navigation state. The first settings
 * snapshot decides the boot target: if onboarding is complete and the user
 * last used DreamRoom it is honoured, otherwise MvpRoom. Incomplete
 * onboarding always lands on MvpRoom so the wizard cannot be skipped by a
 * leftover `ui.mode=dream`. The boot splash holds rendering until that first
 * snapshot arrives. After the first snapshot every settings update is
 * followed verbatim once onboarding is complete (explicit in-session
 * navigation); incomplete onboarding stays on MvpRoom.
 */

export type RoomMode = 'mvp' | 'dream';

export interface BootModeDecision {
  /** The room to land on. Incomplete onboarding always returns mvp. */
  readonly mode: RoomMode;
  /** Always false — boot never rewrites the stored mode by itself. */
  readonly normalizeStored: boolean;
}

/** Coerce an untrusted stored value into a known room mode. */
export function resolveStoredRoomMode(raw: unknown): RoomMode {
  return raw === 'dream' ? 'dream' : 'mvp';
}

export function isOnboardingComplete(ui: {
  onboarding_completed?: unknown;
  onboarding_version?: unknown;
} | null | undefined): boolean {
  return ui?.onboarding_completed === true && Number(ui?.onboarding_version) >= 2;
}

/**
 * Decide the boot mode from the first settings snapshot.
 * An unfinished wizard always opens MvpRoom, even if a previous session
 * left `ui.mode` on dream.
 */
export function decideBootMode(
  stored: RoomMode,
  onboardingComplete = false,
): BootModeDecision {
  return {
    mode: onboardingComplete ? stored : 'mvp',
    normalizeStored: false,
  };
}
