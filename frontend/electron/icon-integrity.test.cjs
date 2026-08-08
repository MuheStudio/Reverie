'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const EXPECTED_SHA256 = '13cd9611c1558c0a253897627111940c4728f3d8ca2e81b2cc28090185c0b531';
const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256];

test('Windows icon is the approved multi-resolution ICO', () => {
  const iconPath = path.join(__dirname, '..', 'public', 'icon.ico');
  const bytes = fs.readFileSync(iconPath);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), EXPECTED_SHA256);
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  assert.equal(count, EXPECTED_SIZES.length);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = bytes[offset] || 256;
    const height = bytes[offset + 1] || 256;
    assert.equal(width, height);
    assert.equal(bytes.readUInt16LE(offset + 4), 1);
    assert.equal(bytes.readUInt16LE(offset + 6), 32);
    sizes.push(width);
  }
  assert.deepEqual(sizes.sort((left, right) => left - right), EXPECTED_SIZES);
});

test('window, tray, and installer all use icon.ico', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.config.cjs'), 'utf8');
  const portable = fs.readFileSync(path.join(__dirname, '..', 'script', 'package-win-test.cjs'), 'utf8');
  assert.match(main, /public', 'icon\.ico'/);
  assert.match(main, /process\.resourcesPath, 'icon\.ico'/);
  assert.match(builder, /public', 'icon\.ico'/);
  assert.match(portable, /resourcesDir, 'icon\.ico'/);
});
