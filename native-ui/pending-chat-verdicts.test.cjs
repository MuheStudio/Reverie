'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {countPendingChatFiles, verifyPendingChatCycle, verifyPendingChatFiles, scanPendingChatWorkspace} =
  require('./pending-chat-verdicts.cjs');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-chat-verdict-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function emptyCounts(cycle) {
  return {cycle, pendingChatFiles: 0, pendingChatTempFiles: 0};
}

const layout = {encryptedDatabase: 'data/data/runtime/kernel.sqlite3', backendStderr: 'data/backend.log'};

test('pending chat counts both exact names throughout the isolated workspace', t => {
  const root = workspace(t);
  const runtime = path.join(root, 'data', 'runtime');
  fs.mkdirSync(runtime, {recursive: true});
  fs.writeFileSync(path.join(runtime, 'pending_chat.json'), '');
  fs.writeFileSync(path.join(runtime, 'pending_chat.json.tmp'), '');
  fs.writeFileSync(path.join(root, 'pending_chat.json'), '');
  fs.writeFileSync(path.join(root, 'pending_chat.json.bak'), '');
  assert.deepEqual(countPendingChatFiles(root, 1), {cycle: 1, pendingChatFiles: 2, pendingChatTempFiles: 1});
});

test('pending chat count cannot pass on an unread traversal', t => {
  const root = workspace(t);
  assert.throws(() => countPendingChatFiles(path.join(root, 'missing'), 1), {code: 'ENOENT'});
});

test('pending chat verdict accepts two ordered zero readings', () => {
  const observations = [emptyCounts(1), emptyCounts(2)];
  assert.deepEqual(verifyPendingChatFiles(observations), {
    passed: true, contract: 'reverie.native.pending-chat.verdict.v1', cycles: observations,
  });
});

test('pending chat verdict rejects a ledger file after the first cycle', () => {
  const first = {...emptyCounts(1), pendingChatFiles: 1};
  assert.throws(() => verifyPendingChatCycle(first, 1), /PENDING_CHAT_FILE_PRESENT:1:pendingChatFiles/);
  assert.throws(() => verifyPendingChatFiles([first, emptyCounts(2)]), /PENDING_CHAT_FILE_PRESENT:1:pendingChatFiles/);
});

test('pending chat verdict rejects a temporary ledger file after restart', () => {
  const second = {...emptyCounts(2), pendingChatTempFiles: 1};
  assert.throws(() => verifyPendingChatFiles([emptyCounts(1), second]), /PENDING_CHAT_FILE_PRESENT:2:pendingChatTempFiles/);
});

test('pending chat verdict rejects a missing cycle', () => {
  assert.throws(() => verifyPendingChatFiles([emptyCounts(1)]), /PENDING_CHAT_TWO_CYCLES_REQUIRED/);
});

test('pending chat verdict rejects duplicate cycle identities', () => {
  assert.throws(() => verifyPendingChatFiles([emptyCounts(1), emptyCounts(1)]), /PENDING_CHAT_CYCLE_ORDER/);
});

test('pending chat verdict rejects a nonnumeric count', () => {
  assert.throws(() => verifyPendingChatFiles([emptyCounts(1), {...emptyCounts(2), pendingChatFiles: '0'}]),
    /PENDING_CHAT_FILE_COUNT_INVALID:2:pendingChatFiles/);
});

test('pending chat scan detects full history texts across chunks and records only path and count', t => {
  const root = workspace(t);
  const first = '这是合成消息的原文🌠';
  const second = 'This is an isolated response.';
  const short = '短句🌠';
  const runtime = path.join(root, 'data', 'data', 'runtime');
  fs.mkdirSync(runtime, {recursive: true});
  const log = Buffer.concat([Buffer.alloc(64 * 1024 - 2, 'x'), Buffer.from(first + '\n' + second + '\n' + first)]);
  fs.writeFileSync(path.join(root, layout.backendStderr), log);
  fs.writeFileSync(path.join(root, 'other.txt'), short);
  fs.writeFileSync(path.join(root, layout.encryptedDatabase), first);
  fs.writeFileSync(path.join(root, layout.encryptedDatabase + '-wal'), second);
  fs.writeFileSync(path.join(runtime, 'another.sqlite3'), second);
  const scan = scanPendingChatWorkspace(root, [{content: first}, {content: second}, {content: first}, {content: short}], layout);
  assert.equal(scan.distinctHistoryTexts, 2);
  assert.equal(scan.scannedFiles, 3);
  assert.equal(scan.scannedBytes, log.length + Buffer.byteLength(short) + Buffer.byteLength(second));
  assert.equal(scan.skippedFiles, 2);
  assert.deepEqual(scan.skippedReasons, {'encrypted-database': 2});
  assert.deepEqual(scan.matches, [
    {path: layout.backendStderr, matchedMessages: 2},
    {path: 'data/data/runtime/another.sqlite3', matchedMessages: 1},
  ]);
  assert.deepEqual(scan.backendStderr, {path: layout.backendStderr, status: 'scanned'});
  assert(!JSON.stringify(scan).includes(first));
  assert(!JSON.stringify(scan).includes(second));
});

test('pending chat scan records link skips without reading an outside target', t => {
  const parent = workspace(t);
  const root = path.join(parent, 'isolation');
  fs.mkdirSync(root);
  const outside = path.join(parent, 'outside.txt');
  const content = 'isolated test text for linked files';
  fs.writeFileSync(outside, content);
  fs.symlinkSync(outside, path.join(root, 'symbolic'));
  fs.symlinkSync(parent, path.join(root, 'directory-alias'));
  fs.linkSync(outside, path.join(root, 'hard-link'));
  const scan = scanPendingChatWorkspace(root, [{content}], layout);
  assert.equal(scan.scannedFiles, 0);
  assert.equal(scan.scannedBytes, 0);
  assert.equal(scan.skippedFiles, 3);
  assert.deepEqual(scan.skippedReasons, {'symbolic-link': 2, 'hard-linked': 1});
  assert.deepEqual(scan.matches, []);
});

test('pending chat scan records an unread directory without treating it as scanned', t => {
  const root = workspace(t);
  const scan = scanPendingChatWorkspace(path.join(root, 'missing'), [], layout);
  assert.equal(scan.scannedFiles, 0);
  assert.equal(scan.scannedBytes, 0);
  assert.equal(scan.skippedDirectories, 1);
  assert.deepEqual(scan.skippedReasons, {'directory-read-error': 1});
});
