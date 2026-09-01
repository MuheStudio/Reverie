/**
 * Startup room-mode resolution (batch L).
 *
 * `settings.ui.mode` is in-session navigation state, not a boot target:
 * startup always lands on MvpRoom. Persisted `dream` values are normalised
 * back to `mvp` on first sync so reconnect re-snapshots can never surprise
 * the user with a room switch. After the first snapshot, every settings
 * update is followed verbatim (explicit in-session navigation).
 */

export type RoomMode = 'mvp' | 'dream';

export interface BootModeDecision {
  /** Always `mvp`: startup never lands on DreamRoom, regardless of storage. */
  readonly mode: RoomMode;
  /** True when the host stored `dream` and should be written back to `mvp`. */
  readonly normalizeStored: boolean;
}

/** Coerce an untrusted stored value into a known room mode. */
export function resolveStoredRoomMode(raw: unknown): RoomMode {
  return raw === 'dream' ? 'dream' : 'mvp';
}

/**
 * Decide the boot mode from the first settings snapshot. The boot mode is
 * always MvpRoom so the renderer never flashes MvpRoom → DreamRoom while the
 * stored mode is in flight.
 */
export function decideBootMode(stored: RoomMode): BootModeDecision {
  return { mode: 'mvp', normalizeStored: stored === 'dream' };
}
