'use strict';

function acquireSingleInstance(app, onSecondInstance, { onRedirected } = {}) {
  if (!app || typeof app.requestSingleInstanceLock !== 'function') {
    throw new TypeError('Electron app is required');
  }
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    // A denied second launch must never boot a second kernel against the
    // same data directory (two personas, split memories). Exit distinctly
    // and say so in the log instead of silently pretending to start.
    console.warn('[Electron] 另一个 Reverie 实例已持有单实例锁，本次启动退出。');
    app.exitCode = 2;
    app.quit();
    return false;
  }
  app.on('second-instance', () => {
    onSecondInstance();
    // The redirected launch is otherwise invisible to the user: surface a
    // notice so "double-clicked the icon and nothing happened" never reads
    // as a broken app.
    if (typeof onRedirected === 'function') {
      try {
        onRedirected();
      } catch (error) {
        console.warn('[Electron] second-instance redirect notice failed', error);
      }
    }
  });
  return true;
}

module.exports = { acquireSingleInstance };
