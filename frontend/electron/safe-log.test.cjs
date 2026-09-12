'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SafeLogger } = require('./safe-log.cjs');

function tempLogger(t) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-log-test-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  return new SafeLogger({ logDir });
}

test('wrapped console survives a terminal-side EPIPE and still logs to file', (t) => {
  const logger = tempLogger(t);
  const realWarn = console.warn;
  // A closed parent terminal makes the native stderr write throw EPIPE.
  console.warn = () => {
    const error = new Error('write EPIPE');
    error.code = 'EPIPE';
    throw error;
  };
  const uninstall = logger.installConsole();
  try {
    assert.doesNotThrow(() => console.warn('bridge supervisor warning', { code: 'REVERIE_BRIDGE_EXIT' }));
    const logFile = fs.readFileSync(path.join(logger.logDir, 'electron.log'), 'utf8');
    assert.match(logFile, /\[WARN\] bridge supervisor warning/);
    assert.match(logFile, /REVERIE_BRIDGE_EXIT/);
  } finally {
    uninstall();
    console.warn = realWarn;
  }
});

test('redaction still applies on the durable copy after a swallowed EPIPE', (t) => {
  const logger = tempLogger(t);
  const realError = console.error;
  console.error = () => {
    const error = new Error('write EPIPE');
    error.code = 'EPIPE';
    throw error;
  };
  const uninstall = logger.installConsole();
  try {
    console.error('token=supersecret-value-1234');
    const logFile = fs.readFileSync(path.join(logger.logDir, 'electron.log'), 'utf8');
    assert.match(logFile, /\[ERROR\] token=\[REDACTED\]/);
    assert.equal(logFile.includes('supersecret-value-1234'), false);
  } finally {
    uninstall();
    console.error = realError;
  }
});

test('uninstall stops the durable log copy and restores native console output', (t) => {
  const logger = tempLogger(t);
  const uninstall = logger.installConsole();
  console.log('safe-log marker during install');
  uninstall();
  console.log('safe-log marker after uninstall');
  const logFile = fs.readFileSync(path.join(logger.logDir, 'electron.log'), 'utf8');
  assert.match(logFile, /safe-log marker during install/);
  assert.equal(logFile.includes('safe-log marker after uninstall'), false);
});
