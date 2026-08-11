'use strict';

class ProviderMutationQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  enqueue(operation) {
    if (typeof operation !== 'function') throw new TypeError('provider mutation must be a function');
    const queued = this.tail.then(operation);
    this.tail = queued.catch(() => undefined);
    return queued;
  }
}

module.exports = { ProviderMutationQueue };
