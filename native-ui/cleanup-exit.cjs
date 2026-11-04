'use strict';
// The verified --remove-test-key branch opens no window and spawns no children.
// A process that has already exited cannot be inspected or acted upon. Confirm
// only our ChildProcess completion; never rediscover a PID or retry an action.
async function cleanupExitedSuccessfully(child, evidence, maximumWaitMs = 50) {
  if (evidence?.cycle !== 'cleanup' || evidence.processAbsent !== true || evidence.spawnConfirmed !== true || evidence.spawnError ||
      evidence.registrationError?.code !== 'ERR_ASSERTION' || evidence.registrationError.message !== 'Spawned process identity is absent or changed') return false;
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode === 0 && child.signalCode === null;
  return new Promise(resolve => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve(child.exitCode === 0 && child.signalCode === null);
    };
    child.once('exit', finish);
    timer = setTimeout(finish, maximumWaitMs);
  });
}
module.exports = { cleanupExitedSuccessfully };
