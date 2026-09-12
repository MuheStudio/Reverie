'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPetDrag } = require('./pet-drag.cjs');

test('the window is placed at drag start plus the total delta, rounded', () => {
  let position = [120, 80];
  const moves = [];
  const drag = createPetDrag({
    getPosition: () => position,
    setPosition: (x, y) => { moves.push([x, y]); position = [x, y]; },
  });
  assert.deepEqual(drag.begin(), [120, 80]);
  drag.move(10.4, -3.2);
  assert.deepEqual(moves[0], [130, 77], 'start + total delta, rounded');
  // A late/duplicate event with an older total delta just re-places the
  // window; the next event corrects it. No drift can accumulate.
  drag.move(10.4, -3.2);
  assert.deepEqual(moves[1], [130, 77]);
  drag.move(52, 40);
  assert.deepEqual(moves[2], [172, 120]);
  assert.equal(drag.active, true);
});

test('move before begin and after end are no-ops', () => {
  const moves = [];
  const drag = createPetDrag({
    getPosition: () => [0, 0],
    setPosition: (x, y) => moves.push([x, y]),
  });
  assert.equal(drag.move(10, 10), null);
  drag.begin();
  drag.end();
  assert.equal(drag.active, false);
  assert.equal(drag.move(10, 10), null);
  assert.deepEqual(moves, []);
});

test('a bogus initial position refuses to start the drag', () => {
  const drag = createPetDrag({
    getPosition: () => undefined,
    setPosition: () => { throw new Error('must not be called'); },
  });
  assert.equal(drag.begin(), null);
  assert.equal(drag.active, false);
});

test('constructor requires injectable position seams', () => {
  assert.throws(() => createPetDrag({}), /getPosition and setPosition/);
});
