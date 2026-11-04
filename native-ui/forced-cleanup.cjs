'use strict';

const MAX_ERRORS = 8;
const MAX_ERROR_LENGTH = 240;

function runForcedCleanup(active, guard) {
  const result = {
    forcedCleanup: false,
    forcedCleanupTargets: 0,
    forcedCleanupSignalsSent: 0,
    forcedCleanupIdentityChanged: 0,
    forcedCleanupErrors: []
  };
  function recordError(operation, error) {
    if (result.forcedCleanupErrors.length >= MAX_ERRORS) return;
    let message = 'Unknown cleanup error';
    try { message = String(error?.message || error); } catch {}
    result.forcedCleanupErrors.push(`${operation}: ${message}`.slice(0, MAX_ERROR_LENGTH));
  }

  for (const running of active) {
    if (!running.rootIdentity) continue;
    let targets;
    try {
      targets = [...guard.remainingProcesses(running)].sort((a, b) => b.pid - a.pid);
    } catch (error) {
      recordError('remainingProcesses', error);
      continue;
    }
    if (targets.length) result.forcedCleanup = true;
    result.forcedCleanupTargets += targets.length;
    for (const target of targets) {
      try {
        const sent = guard.signalOwned(running, target, 'SIGKILL');
        // This counts guard true returns, including an ESRCH handled by the
        // guard. It does not prove that a signal was actually delivered.
        if (sent === true) result.forcedCleanupSignalsSent += 1;
        else if (sent === false) result.forcedCleanupIdentityChanged += 1;
      } catch (error) {
        recordError('signalOwned', error);
      }
    }
  }
  return result;
}

module.exports = { runForcedCleanup };
