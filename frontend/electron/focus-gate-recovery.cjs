'use strict';

function reconcileFocusNetworkGate(networkGate, focusManager) {
  if (!networkGate) throw new TypeError('networkGate is required');
  const gateState = networkGate.snapshot();
  if (!focusManager) {
    return {
      available: !gateState.active,
      reason: gateState.active
        ? 'Focus module is unavailable while a persisted local-mode gate is active'
        : '',
      gateState,
    };
  }
  const focusState = focusManager.getState();
  let nextGate = gateState;
  if (focusState.localModeActive && !gateState.active) {
    nextGate = networkGate.enable({
      epoch: Math.max(focusState.epoch, gateState.epoch) + 1,
      sessionId: focusState.id,
    });
    focusManager.reconcileGateEpoch(nextGate.epoch, true);
  } else if (focusState.localModeActive && gateState.active) {
    focusManager.reconcileGateEpoch(Math.max(focusState.epoch, gateState.epoch), true);
  } else if (!focusState.localModeActive && gateState.active) {
    // An active persisted gate may be a user-owned manual local-mode session,
    // or a Focus transition that crashed before its state file committed.
    // Startup cannot prove either case is safe to reopen, so preserve the
    // closed network boundary. The user can explicitly disable it after the
    // Python process acknowledges the same epoch.
    nextGate = gateState;
  }
  return { available: true, reason: '', gateState: nextGate };
}

module.exports = { reconcileFocusNetworkGate };
