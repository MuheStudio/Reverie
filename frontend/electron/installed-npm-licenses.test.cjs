'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectInstalledNpmLicenses } = require('../script/collect-installed-npm-licenses.cjs');

function fixture(t, dependencies = { alpha: '1.0.0' }) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-licenses-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const frontend = path.join(temporary, 'frontend');
  const destination = path.join(temporary, 'output');
  fs.mkdirSync(frontend);
  fs.writeFileSync(path.join(frontend, 'package.json'), JSON.stringify({ dependencies, devDependencies: { 'dev-only': '1.0.0' } }));
  function packageAt(name, metadata = {}, directory = path.join(frontend, 'node_modules', name)) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', ...metadata }));
    fs.writeFileSync(path.join(directory, 'LICENSE'), `MIT notice for ${name}`);
    return directory;
  }
  return { temporary, frontend, destination, packageAt, collect: () => collectInstalledNpmLicenses(frontend, destination) };
}

test('collects transitive production, present optional and peer dependencies without dev-only packages', (t) => {
  const f = fixture(t);
  f.packageAt('alpha', { dependencies: { beta: '*' }, optionalDependencies: { optional: '*', absent: '*' },
    peerDependencies: { peer: '*', absentPeer: '*' }, peerDependenciesMeta: { absentPeer: { optional: true } } });
  f.packageAt('beta', { dependencies: { alpha: '*', url: '*' }, exports: { './entry': './index.js' } });
  f.packageAt('url'); f.packageAt('peer'); f.packageAt('optional'); f.packageAt('dev-only');
  const inventory = f.collect();
  assert.deepEqual(inventory.map((entry) => entry.name).sort(), ['alpha', 'beta', 'optional', 'peer', 'url']);
  assert.deepEqual(inventory.find((entry) => entry.name === 'alpha').missingOptionalDependencies, ['absent', 'absentPeer']);
  for (const entry of inventory) {
    assert.equal(fs.readFileSync(path.join(f.destination, entry.directory, 'LICENSE'), 'utf8'), `MIT notice for ${entry.name}`);
    assert.equal(entry.licenseTextStatus, 'included');
  }
});

test('resolves pnpm realpaths and peers from a virtual package sibling', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const virtual = path.join(f.frontend, 'node_modules', '.pnpm', 'alpha@1.0.0_peer@1.0.0', 'node_modules');
  const alpha = f.packageAt('alpha', { peerDependencies: { '@scope/peer': '*' } }, path.join(virtual, 'alpha'));
  f.packageAt('@scope/peer', {}, path.join(virtual, '@scope', 'peer'));
  fs.symlinkSync(alpha, path.join(f.frontend, 'node_modules', 'alpha'));
  assert.deepEqual(f.collect().map((entry) => entry.name).sort(), ['@scope/peer', 'alpha']);
});

test('a missing required dependency fails before output creation', (t) => {
  const f = fixture(t); f.packageAt('alpha', { dependencies: { absent: '*' } });
  assert.throws(f.collect, /Required production dependency is not installed: absent/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('a FileProvider short-read cannot silently create an empty license notice', (t) => {
  const f = fixture(t);
  const alpha = f.packageAt('alpha');
  const license = path.join(alpha, 'LICENSE');
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (filename, ...args) => (
    filename === license ? Buffer.alloc(0) : originalRead(filename, ...args)
  ));
  assert.ok(fs.statSync(license).size > 0);
  assert.throws(f.collect, /short-read or changed during collection: LICENSE/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('a package symlink outside frontend is rejected', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const outside = f.packageAt('alpha', {}, path.join(f.temporary, 'outside'));
  fs.mkdirSync(path.join(f.frontend, 'node_modules'));
  fs.symlinkSync(outside, path.join(f.frontend, 'node_modules', 'alpha'));
  assert.throws(f.collect, /escaped frontend/);
});

test('license files cannot read outside their own package', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t); const alpha = f.packageAt('alpha');
  fs.unlinkSync(path.join(alpha, 'LICENSE'));
  fs.writeFileSync(path.join(f.frontend, 'private.txt'), 'not a license');
  fs.symlinkSync(path.join(f.frontend, 'private.txt'), path.join(alpha, 'LICENSE'));
  assert.throws(f.collect, /notice escaped package/);
});

test('output symlink ancestors are rejected before creating files outside the destination', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t); f.packageAt('alpha');
  const outside = path.join(f.temporary, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.destination);
  assert.throws(() => collectInstalledNpmLicenses(f.frontend, path.join(f.destination, 'nested')), /redirected through a symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('preserves explicit license files, notices and metadata-only status without inventing license text', (t) => {
  const f = fixture(t, { alpha: '*', missing: '*' });
  const alpha = f.packageAt('alpha', { license: 'SEE LICENSE IN legal/terms.txt', author: 'Example' });
  fs.mkdirSync(path.join(alpha, 'legal'));
  fs.writeFileSync(path.join(alpha, 'legal', 'terms.txt'), 'actual license text');
  fs.writeFileSync(path.join(alpha, 'NOTICE-MIT.txt'), 'copyright notice');
  const missing = f.packageAt('missing', { license: 'ISC' }); fs.unlinkSync(path.join(missing, 'LICENSE'));
  const inventory = f.collect();
  const first = inventory.find((entry) => entry.name === 'alpha');
  assert.equal(first.packageMetadata.author, 'Example');
  assert.ok(first.licenseFiles.some((file) => file.path === 'legal/terms.txt'));
  assert.ok(first.licenseFiles.some((file) => file.path === 'NOTICE-MIT.txt'));
  assert.equal(inventory.find((entry) => entry.name === 'missing').licenseTextStatus, 'package-metadata-only');
});
