'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  attachNotificationClick,
  nativeNotificationOptions,
  payloadHash,
  processNotificationOutbox,
} = require('./notification-outbox.cjs');

const ID = `proactive_${'a'.repeat(32)}`;
const OTHER_ID = `proactive_${'b'.repeat(32)}`;

function fixture(id = ID) {
  return {
    schema: 'reverie.notification.v1',
    id,
    title: 'Private title',
    body: 'Private body',
    category: 'care',
    only_when_unfocused: true,
    created_at: '2026-09-01T08:00:00.000Z',
  };
}

function withOutbox(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-notification-'));
  const outbox = path.join(root, 'outbox');
  fs.mkdirSync(outbox);
  try { run({ root, outbox }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function writeItem(directory, payload = fixture(), name = `${payload.id}.json`) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), JSON.stringify(payload));
}

function poll(outbox, overrides = {}) {
  const shown = [];
  processNotificationOutbox({
    fs,
    path,
    outbox,
    now: () => Date.parse('2026-09-01T09:00:00.000Z'),
    showNotification: (payload) => { shown.push(payload); return true; },
    ...overrides,
  });
  return shown;
}

test('complete item is atomically claimed, shown, receipted, and consumed', () => withOutbox(({ root, outbox }) => {
  writeItem(outbox);
  assert.equal(poll(outbox).length, 1);
  assert.deepEqual(fs.readdirSync(outbox), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'processing')), []);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'receipts', `${ID}.json`), 'utf8'));
  assert.equal(receipt.id, ID);
  assert.equal(receipt.payload_hash, payloadHash(fixture()));
  assert.equal(receipt.outcome, 'shown');
}));

test('non-JSON producer temp files do not consume the batch limit', () => withOutbox(({ outbox }) => {
  for (let index = 0; index < 25; index += 1) {
    fs.writeFileSync(path.join(outbox, `.producer-${String(index).padStart(2, '0')}.tmp`), 'partial');
  }
  writeItem(outbox);
  assert.equal(poll(outbox).length, 1);
  assert.equal(fs.readdirSync(outbox).filter((name) => name.endsWith('.tmp')).length, 25);
}));

test('processing item resumes on startup', () => withOutbox(({ root, outbox }) => {
  writeItem(path.join(root, 'processing'));
  assert.equal(poll(outbox).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, 'processing')), []);
}));

test('foreground, focus mode, and expiration create terminal receipts', () => {
  const cases = [
    [{ windowFocused: () => true }, 'foreground_suppressed'],
    [{ focusActive: () => true }, 'focus_suppressed'],
    [{ now: () => Date.parse('2026-09-02T09:00:00.000Z') }, 'expired'],
  ];
  for (const [override, outcome] of cases) {
    withOutbox(({ root, outbox }) => {
      writeItem(outbox);
      assert.equal(poll(outbox, override).length, 0);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, 'receipts', `${ID}.json`), 'utf8'));
      assert.equal(receipt.outcome, outcome);
    });
  }
});

test('false or thrown native show remains retryable in processing', () => {
  for (const showNotification of [() => false, () => { throw new Error('native failure'); }]) {
    withOutbox(({ root, outbox }) => {
      writeItem(outbox);
      poll(outbox, { showNotification });
      assert.deepEqual(fs.readdirSync(path.join(root, 'processing')), [`${ID}.json`]);
      assert.deepEqual(fs.readdirSync(path.join(root, 'rejected')), []);
      assert.equal(poll(outbox).length, 1);
    });
  }
});

test('malformed payload and filename mismatch are rejected', () => {
  for (const [name, payload] of [
    [`${ID}.json`, '{'],
    [`${OTHER_ID}.json`, JSON.stringify(fixture())],
  ]) {
    withOutbox(({ root, outbox }) => {
      fs.writeFileSync(path.join(outbox, name), payload);
      assert.equal(poll(outbox).length, 0);
      assert.equal(fs.readdirSync(path.join(root, 'rejected')).length, 1);
    });
  }
});

test('crash after receipt before delete resumes without showing twice', () => withOutbox(({ root, outbox }) => {
  writeItem(outbox);
  assert.throws(() => poll(outbox, { afterReceipt: () => { throw new Error('crash'); } }), /crash/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'processing')), [`${ID}.json`]);
  assert.equal(poll(outbox).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'processing')), []);
}));

test('matching receipt suppresses a recreated outbox item', () => withOutbox(({ outbox }) => {
  writeItem(outbox);
  assert.equal(poll(outbox).length, 1);
  writeItem(outbox);
  assert.equal(poll(outbox).length, 0);
  assert.deepEqual(fs.readdirSync(outbox), []);
}));

test('locked notification is generic and preserves deterministic identity', () => {
  assert.deepEqual(nativeNotificationOptions(fixture(), { locked: true }), {
    title: 'Reverie',
    body: '你有一条本地提醒。',
    silent: false,
    id: ID,
    groupId: ID,
  });
});

test('notification click delegates to app restore/focus handler', () => {
  let click;
  let restored = 0;
  attachNotificationClick({ on: (event, handler) => { assert.equal(event, 'click'); click = handler; } }, () => { restored += 1; });
  click();
  assert.equal(restored, 1);
});
