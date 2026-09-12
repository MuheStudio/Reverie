'use strict';

// Luna-ts petDrag pattern: the renderer streams TOTAL screen-space deltas
// measured from the drag start, and the window is placed at start + delta.
// Absolute placement from a fixed origin cannot accumulate rounding drift,
// and a manual protocol replaces -webkit-app-region, which swallowed every
// mousedown on transparent frameless windows (Luna v0.28.6 lesson).
function createPetDrag({ getPosition, setPosition }) {
  if (typeof getPosition !== 'function' || typeof setPosition !== 'function') {
    throw new TypeError('getPosition and setPosition are required');
  }
  let start = null;
  return {
    begin() {
      start = getPosition();
      if (!Array.isArray(start) || start.length < 2) {
        start = null;
        return null;
      }
      return [start[0], start[1]];
    },
    move(dx, dy) {
      if (!start) return null;
      const nextX = Math.round(start[0] + dx);
      const nextY = Math.round(start[1] + dy);
      setPosition(nextX, nextY);
      return [nextX, nextY];
    },
    end() {
      start = null;
    },
    get active() {
      return start !== null;
    },
  };
}

module.exports = { createPetDrag };
