'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  REQUIRED_MEDIA_MODULES, REQUIRED_XIANGQI_MODULES, REQUIRED_WORLDBOOK_MODULES, REQUIRED_SUMMARY_MODULES, assertSourceMigrationSource, assertSourceMigrationStage,
} = require('../script/source-migration-policy.cjs');

// Synthetic bodies exercise exact-copy detection without importing legacy GPL
// implementations into fixtures. All source/JSON examples below are invented.
const OLD_BODY = 'function retiredSyntheticProbe() { return 29; }\n';
const PYTHON_BODY = 'def retired_synthetic_worldbook(): return 47\n';
const DART_BODY = 'String retiredSyntheticDart() => "fixture";\n';
function put(root, name, data = 'module.exports = {};\n') {
  const filename = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, data);
  return filename;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-source-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project'), appRoot = path.join(root, 'stage', 'app'), resourceRoot = path.join(root, 'resources');
  for (const host of [path.join(projectRoot, 'frontend', 'electron'), path.join(appRoot, 'electron')]) {
    put(host, 'main.js', "const { HostMediaService } = require('./media-service.cjs');\n");
    for (const filename of REQUIRED_MEDIA_MODULES) put(host, filename);
  }
  for (const name of REQUIRED_XIANGQI_MODULES) put(projectRoot, `frontend/src/components/DreamRoom/${name}`, '// Synthetic independent Xiangqi source\n');
  const modules = REQUIRED_XIANGQI_MODULES.map(n => `src/components/DreamRoom/${n}`);
  put(appRoot, 'dist/retired-dependency-build-graph.json', JSON.stringify({schema:'reverie.renderer-module-retirement.v1',passed:true,modules,count:modules.length,sha256:crypto.createHash('sha256').update(JSON.stringify(modules)).digest('hex')}));
  put(projectRoot, 'src/main.py', 'print("first party")\n');
  put(resourceRoot, 'src/main.py', 'print("first party")\n');
  for (const parent of [projectRoot, resourceRoot]) {
    for (const filename of REQUIRED_WORLDBOOK_MODULES) put(parent, `src/worldbook/${filename}`, '# Synthetic replacement module\n');
    for (const filename of REQUIRED_SUMMARY_MODULES) put(parent, `src/conversation_summary/${filename}`, '# Synthetic summary module\n');
  }
  for (const [slug, filename, body] of [
    ['kazumi', 'src/anime_service/lib/main.dart', DART_BODY],
    ['cat-catch', 'src/download_service/electron_adapter.js', OLD_BODY],
    ['risu-worldbook', 'src/lorebook/__init__.py', PYTHON_BODY],
    ['risu-hypa', 'src/memory/hypa_v3.py', 'def synthetic_retired_summary(): return 123\n'],
    ['elephantops', 'frontend/node_modules/elephantops/dist/esm/synthetic.js', 'function syntheticRetiredChess() { return 80; }\n'],
  ]) {
    put(projectRoot, `LICENSES_CREDITS/history/${slug}-files.json`, JSON.stringify({
      schemaVersion: 1, sourceTreeCommit: 'a'.repeat(40), fileCount: 1, totalBytes: Buffer.byteLength(body),
      files: [{ path: filename, bytes: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') }],
    }));
  }
  return { root, projectRoot, appRoot, resourceRoot };
}

test('source and staged checks preserve current GPL declarations and historical notices', (t) => {
  const f = fixture(t);
  put(f.projectRoot, 'src/another.py', '# GPL-3.0: unrelated retained source\n');
  put(f.resourceRoot, 'LICENSES_CREDITS/LICENSE-GPLv3-cat-catch.txt', 'Historical GPL notice retained.\n');
  put(f.resourceRoot, 'LICENSES_CREDITS/history/cat-catch-files.json', JSON.stringify({ sha256: crypto.createHash('sha256').update(OLD_BODY).digest('hex') }));
  const source = assertSourceMigrationSource(f.projectRoot), stage = assertSourceMigrationStage(f);
  assert.equal(source.passed, true); assert.equal(stage.passed, true);
  assert.equal(source.inventories.length, 5);
  assert.deepEqual(source.requiredMediaModules, REQUIRED_MEDIA_MODULES);
  assert.match(source.claim, /not a complete license/);
  assert.equal(JSON.stringify(stage).includes(f.root), false);
});

test('reintroduced source directories fail even though production copy would omit them', (t) => {
  for (const name of ['anime_service', 'download_service', 'lorebook']) {
    const f = fixture(t);
    put(f.projectRoot, `src/${name}/anything.txt`, 'not executable');
    assert.throws(() => assertSourceMigrationSource(f.projectRoot), /Retired source tree reintroduced/);
  }
});

test('retired trees injected into staging after source copy are rejected', (t) => {
  const f = fixture(t);
  assert.equal(assertSourceMigrationSource(f.projectRoot).passed, true);
  put(f.resourceRoot, 'src/download_service/adapter.js');
  assert.throws(() => assertSourceMigrationStage(f), /Retired source tree reintroduced/);
});

test('all four replacement modules are required in the exact staged Electron directory', (t) => {
  for (const name of REQUIRED_MEDIA_MODULES) {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.appRoot, 'electron', name));
    assert.throws(() => assertSourceMigrationStage(f), /requires a regular Electron module/);
  }
});

test('empty replacement modules cannot satisfy the package gate', (t) => {
  const f = fixture(t);
  put(f.appRoot, 'electron/media-service.cjs', '');
  assert.throws(() => assertSourceMigrationStage(f), /Empty required/);
});

test('legacy adapter symbol and require path cannot survive in the host entrypoint', (t) => {
  for (const body of [
    'const service = getDownloadAdapter();',
    'require("../../src/download_service/electron_adapter.js");',
    'const dir = path.join(root, "download_service");',
  ]) {
    const f = fixture(t);
    put(f.appRoot, 'electron/main.js', body);
    assert.throws(() => assertSourceMigrationStage(f), /still references the retired download adapter/);
  }
});

test('known retired bodies are rejected after renaming paths and file extensions', (t) => {
  for (const [destination, body] of [['src/util.dat', OLD_BODY], ['frontend/src/component.ts', DART_BODY], ['src/renamed.txt', PYTHON_BODY]]) {
    const f = fixture(t);
    put(f.projectRoot, destination, body);
    assert.throws(() => assertSourceMigrationSource(f.projectRoot), /Retired executable body reintroduced/);
  }
});

test('known body copied to a staged renderer asset is rejected', (t) => {
  const f = fixture(t);
  put(f.appRoot, 'dist/assets/renamed.js', OLD_BODY);
  assert.throws(() => assertSourceMigrationStage(f), /Retired executable body reintroduced/);
});

test('missing or corrupt historical inventory fails closed', (t) => {
  const f = fixture(t);
  const inventory = path.join(f.projectRoot, 'LICENSES_CREDITS/history/kazumi-files.json');
  fs.unlinkSync(inventory);
  assert.throws(() => assertSourceMigrationSource(f.projectRoot), /requires a regular/);
  put(f.projectRoot, 'LICENSES_CREDITS/history/kazumi-files.json', '{"schemaVersion":1,"files":[]}');
  assert.throws(() => assertSourceMigrationSource(f.projectRoot), /Invalid source migration history inventory/);
});

test('the gate requires staged backend source instead of checking only Electron', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.resourceRoot, 'src'), { recursive: true });
  assert.throws(() => assertSourceMigrationStage(f), /real staged Python source directory/);
});

test('source symlinks cannot bypass source/body inspection', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  fs.symlinkSync('/nonexistent/reverie-test-only', path.join(f.projectRoot, 'src/redirect'));
  assert.throws(() => assertSourceMigrationSource(f.projectRoot), /refuses a source symlink/);
});


test('all independent worldbook modules are required in source and staged payloads', t => {
  for (const filename of REQUIRED_WORLDBOOK_MODULES) {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.projectRoot, 'src', 'worldbook', filename));
    assert.throws(() => assertSourceMigrationSource(f.projectRoot), /requires a regular worldbook module/);
    fs.unlinkSync(path.join(f.resourceRoot, 'src', 'worldbook', filename));
    assert.throws(() => assertSourceMigrationStage(f), /requires a regular worldbook module/);
  }
});

test('active legacy worldbook imports fail in source and staged modules', t => {
  for (const code of ['from src.lorebook import Matcher', 'from lorebook import Matcher', 'from .lorebook import Matcher',
    'import src.lorebook as old', 'import os, lorebook', 'from src import lorebook', 'from . import lorebook', 'from src import (\n lorebook, other\n)',
    'importlib.import_module("src.lorebook")', 'importlib.import_module(".lorebook", package="src")', '__import__("lorebook")']) {
    const f = fixture(t);
    put(f.projectRoot, 'src/active.py', code);
    assert.throws(() => assertSourceMigrationSource(f.projectRoot), /imports the retired worldbook/, code);
    put(f.resourceRoot, 'src/active.py', code);
    assert.throws(() => assertSourceMigrationStage(f), /imports the retired worldbook/);
  }
});

test('historical comments and archive field names are not license-removal false positives', t => {
  const f = fixture(t);
  put(f.projectRoot, 'src/retained.py', '# from src.lorebook import HistoricalClass\n# from src.memory.hypa_v3 import HistoricalSummary\n# import_module("src.memory.hypa_v3")\nfield = "lorebook"\nimport os # from src import lorebook\nexample = \'import_module("src.lorebook")\'\ntext = \'\'\'\nfrom src.lorebook import Old\n\'\'\'\n');
  assert.equal(assertSourceMigrationSource(f.projectRoot).passed, true);
});

test('renamed old Python executable body cannot return inside final staged resources', t => {
  const f = fixture(t);
  put(f.resourceRoot, 'src/worldbook/cached.data', PYTHON_BODY);
  assert.throws(() => assertSourceMigrationStage(f), /Retired executable body reintroduced/);
});

for (const code of ['from src.memory.hypa_v3 import Old', 'from .memory import hypa_v3', 'from src.memory import (\n hypa_v3\n)', 'importlib.import_module("src.memory.hypa_v3")']) {
  test(`rejects active retired summary import: ${code}`, t => {
    const f = fixture(t); put(f.projectRoot, 'src/reintroduced.py', code);
    assert.throws(() => assertSourceMigrationSource(f.projectRoot), /retired summary/);
  });
}
test('retired summary body and missing independent module cannot ship', t => {
  const f = fixture(t);
  put(f.projectRoot, 'src/memory/hypa_v3.py', '# unneeded');
  assert.throws(() => assertSourceMigrationSource(f.projectRoot), /Retired source/);
  for (const name of REQUIRED_SUMMARY_MODULES) {
    const g = fixture(t); fs.unlinkSync(path.join(g.resourceRoot, 'src/conversation_summary', name));
    assert.throws(() => assertSourceMigrationStage(g), /regular summary module/);
  }
  const g = fixture(t); put(g.resourceRoot, 'src/renamed.py', 'def synthetic_retired_summary(): return 123\n');
  assert.throws(() => assertSourceMigrationStage(g), /Retired executable body/);
});
