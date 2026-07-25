'use strict';

/**
 * Enter companion-local mode without coupling the local timer to Python
 * availability. The host network gate is authoritative and is never reopened
 * by this function. A missing or inconsistent bridge is killed and restarted
 * inside the already-closed boundary.
 */
async function enterLocalModeWithDegradedBridge(options = {}) {
  const {
    networkGate,
    bridge,
    epoch,
    sessionId,
    broadcast = () => {},
    stopBridge = async () => {},
    startBridge = () => {},
    onBridgeFailure = () => {},
  } = options;
  if (!networkGate || !bridge) throw new TypeError('networkGate and bridge are required');

  const gateState = networkGate.enable({ epoch, sessionId });
  broadcast({ transitioning: true, backendPending: !bridge.ready });

  if (!bridge.ready) {
    if (bridge.child) await stopBridge();
    startBridge();
    broadcast({ transitioning: false, backendPending: true });
    return { ...gateState, bridgeAcknowledged: false };
  }

  try {
    const acknowledgement = await bridge.setLocalMode({
      active: true,
      epoch: gateState.epoch,
      sessionId,
    });
    if (acknowledgement.epoch !== gateState.epoch || !acknowledgement.active) {
      throw new Error('Python local-mode acknowledgement was inconsistent');
    }
    broadcast({ transitioning: false, backendPending: false });
    return { ...gateState, bridgeAcknowledged: true };
  } catch (error) {
    await stopBridge();
    onBridgeFailure(error);
    startBridge();
    broadcast({ transitioning: false, backendPending: true });
    return { ...gateState, bridgeAcknowledged: false };
  }
}

module.exports = { enterLocalModeWithDegradedBridge };
