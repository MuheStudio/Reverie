'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const frontendRoot = path.resolve(__dirname, '..');
const electronRoot = path.join(frontendRoot, 'electron');
const electronTests = [
  'app-protocol.test.cjs',
  'avatar-manager.test.cjs',
  'bridge-host-proxy.test.cjs',
  'credential-vault.test.cjs',
  'desktop-schemes.test.cjs',
  'focus-gate-recovery.test.cjs',
  'focus-local-mode-transition.test.cjs',
  'framed-bridge-supervisor.test.cjs',
  'icon-integrity.test.cjs',
  'live2d-core-protocol.test.cjs',
  'live2d-import-transform.test.cjs',
  'live2d-release-gate.test.cjs',
  'live2d-runtime-assets.test.cjs',
  'local-network-gate.test.cjs',
  'mvp-authority.test.cjs',
  'notification-outbox.test.cjs',
  'optional-runtime-provisioner.test.cjs',
  'package-win-test-security.test.cjs',
  'pet-preload.test.cjs',
  'pet-bounds-store.test.cjs',
  'pet-drag.test.cjs',
  'preload-sandbox.test.cjs',
  'provider-config-store.test.cjs',
  'provider-mutation-queue.test.cjs',
  'provider-transaction-journal.test.cjs',
  'runtime-security.test.cjs',
  'safe-log.test.cjs',
  'single-instance.test.cjs',
  'storage-key-vault.test.cjs',
  'test-user-data.test.cjs',
  'windows-app-identity.test.cjs',
  'voice-pack-manager.test.cjs',
].map((name) => path.join(electronRoot, name));

for (const testFile of electronTests) {
  if (!fs.existsSync(testFile)) throw new Error(`MVP test gate is missing: ${testFile}`);
}

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: frontendRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(['--test', ...electronTests]);
run([path.join(__dirname, 'run-clean-tool.cjs'), 'vitest', 'run', '--coverage']);
