'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  EXPECTED_URL,
  installLive2DCoreProtocol,
} = require('./live2d-core-protocol.cjs');

test('Live2D Core protocol exposes only the fixed gated runtime URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-live2d-core-'));
  const core = path.join(root, 'Live2DCubismCore.js');
  fs.writeFileSync(core, 'globalThis.Live2DCubismCore = {};');
  let handler;
  const protocol = {
    handle: (_scheme, next) => { handler = next; },
    unhandle() {},
  };
  installLive2DCoreProtocol(protocol, core);

  const ok = await handler(new Request(EXPECTED_URL));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Live2DCubismCore/);
  assert.equal((await handler(new Request('reverie-live2d-core://runtime/other.js'))).status, 404);
  assert.equal((await handler(new Request(EXPECTED_URL, { method: 'POST' }))).status, 405);
});
