'use strict';

function acquireSingleInstance(app, onSecondInstance) {
  if (!app || typeof app.requestSingleInstanceLock !== 'function') {
    throw new TypeError('Electron app is required');
  }
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    app.quit();
    return false;
  }
  app.on('second-instance', () => onSecondInstance());
  return true;
}

module.exports = { acquireSingleInstance };
