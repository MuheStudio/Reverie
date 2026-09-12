'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PetBoundsStore, clampBounds } = require('./pet-bounds-store.cjs');

test('pet bounds clamp back into an available display after monitor removal', () => {
  const result = clampBounds(
    { displayId: 'gone', bounds: { x: 5000, y: -2000, width: 460, height: 680 } },
    [{ id: 'primary', workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    { x: 100, y: 100, width: 460, height: 680 },
  );
  assert.deepEqual(result, { x: 1460, y: 0, width: 460, height: 680 });
});

test('pet bounds persist atomically without accepting corrupt state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-pet-bounds-'));
  try {
    const store = new PetBoundsStore(root);
    store.save('1', { x: 40, y: 60, width: 460, height: 680 }, 1.25);
    assert.equal(store.load().displayId, '1');
    fs.writeFileSync(path.join(root, 'pet-bounds.json'), '{bad', 'utf8');
    assert.equal(store.load(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('preserves legitimate zero edge positions instead of treating them as missing', () => {
  const saved = {
    displayId: 'primary',
    bounds: { x: 0, y: 0, width: 460, height: 680 },
  };
  const result = clampBounds(
    saved,
    [{ id: 'primary', workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    { x: 100, y: 100, width: 460, height: 680 },
  );
  assert.deepEqual(result, { x: 0, y: 0, width: 460, height: 680 });
});
