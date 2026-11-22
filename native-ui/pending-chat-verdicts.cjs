'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PENDING_CHAT_CONTRACT = 'reverie.native.pending-chat.verdict.v1';
const PENDING_CHAT_FILE = 'pending_chat.json';
const PENDING_CHAT_TEMP = 'pending_chat.json.tmp';
const CHUNK_BYTES = 64 * 1024;

function walk(root, visit, directoryError) {
  function visitDirectory(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      directoryError(error, path.relative(root, directory));
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visitDirectory(file);
      else visit(entry, file, path.relative(root, file));
    }
  }
  visitDirectory(root);
}

function countPendingChatFiles(root, cycle) {
  const observation = {cycle, pendingChatFiles: 0, pendingChatTempFiles: 0};
  walk(root, entry => {
    if (entry.name === PENDING_CHAT_FILE) observation.pendingChatFiles++;
    if (entry.name === PENDING_CHAT_TEMP) observation.pendingChatTempFiles++;
  }, error => { throw error; });
  return observation;
}

function verifyPendingChatCycle(observation, cycle) {
  assert.equal(observation?.cycle, cycle, 'PENDING_CHAT_CYCLE_ORDER');
  for (const key of ['pendingChatFiles', 'pendingChatTempFiles']) {
    assert(Number.isSafeInteger(observation[key]) && observation[key] >= 0,
      `PENDING_CHAT_FILE_COUNT_INVALID:${cycle}:${key}`);
    assert.equal(observation[key], 0, `PENDING_CHAT_FILE_PRESENT:${cycle}:${key}`);
  }
}

function verifyPendingChatFiles(observations) {
  assert(Array.isArray(observations) && observations.length === 2, 'PENDING_CHAT_TWO_CYCLES_REQUIRED');
  for (const cycle of [1, 2]) verifyPendingChatCycle(observations[cycle - 1], cycle);
  return {passed: true, contract: PENDING_CHAT_CONTRACT, cycles: observations};
}

function scanFile(file, needles, overlapBytes, buffer) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) return {skipped: 'not-regular'};
    if (stats.nlink !== 1) return {skipped: 'hard-linked'};
    let carry = Buffer.alloc(0);
    let remaining = needles;
    let bytes = 0;
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (!remaining.length) continue;
      const chunk = buffer.subarray(0, read);
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      remaining = remaining.filter(needle => !data.includes(needle));
      carry = Buffer.from(data.subarray(Math.max(0, data.length - overlapBytes)));
    }
    return {bytes, matchedMessages: needles.length - remaining.length};
  } finally {
    fs.closeSync(descriptor);
  }
}

function scanPendingChatWorkspace(root, messages, {encryptedDatabase, backendStderr}) {
  const texts = new Set();
  for (const {content} of messages) {
    assert.equal(typeof content, 'string', 'PENDING_CHAT_HISTORY_TEXT_MISSING');
    if (Array.from(content).length >= 8) texts.add(content);
  }
  const needles = Array.from(texts, content => Buffer.from(content, 'utf8'));
  const overlapBytes = needles.reduce((size, needle) => Math.max(size, needle.length - 1), 0);
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const excluded = new Set(['', '-wal', '-shm', '-journal'].map(suffix => encryptedDatabase + suffix));
  const result = {scope: 'owned-isolation-run-root', distinctHistoryTexts: needles.length,
    scannedFiles: 0, scannedBytes: 0, skippedFiles: 0, skippedDirectories: 0, skippedReasons: {}, matches: [],
    backendStderr: {path: backendStderr, status: 'not-observed'}};
  function skip(relative, reason, directory = false) {
    if (directory) result.skippedDirectories++;
    else result.skippedFiles++;
    result.skippedReasons[reason] = (result.skippedReasons[reason] || 0) + 1;
    if (relative === backendStderr) result.backendStderr.status = reason;
  }
  walk(root, (entry, file, relative) => {
    if (entry.isSymbolicLink()) return skip(relative, 'symbolic-link');
    if (!entry.isFile()) return skip(relative, 'not-regular');
    if (excluded.has(relative)) return skip(relative, 'encrypted-database');
    let observation;
    try {
      observation = scanFile(file, needles, overlapBytes, buffer);
    } catch {
      return skip(relative, 'file-read-error');
    }
    if (observation.skipped) return skip(relative, observation.skipped);
    result.scannedFiles++;
    result.scannedBytes += observation.bytes;
    if (relative === backendStderr) result.backendStderr.status = 'scanned';
    if (observation.matchedMessages) result.matches.push({path: relative, matchedMessages: observation.matchedMessages});
  }, (_error, relative) => skip(relative, 'directory-read-error', true));
  result.status = result.skippedReasons['directory-read-error'] || result.skippedReasons['file-read-error'] ? 'partial' : 'complete';
  result.matches.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

module.exports = {countPendingChatFiles, verifyPendingChatCycle, verifyPendingChatFiles, scanPendingChatWorkspace};
