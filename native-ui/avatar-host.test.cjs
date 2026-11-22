'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {AvatarManager} = require('../frontend/electron/avatar-manager.cjs');

const HOST = path.join(__dirname, 'avatar-host.cjs');
const REPOSITORY = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function managerFor(storage) {
  return new AvatarManager({storageDir:storage,live2dRuntime:{
    available:false,coreAvailable:false,rendererAvailable:false,developmentOnly:true,licenseAccepted:false,
  }});
}

function minimalGlb() {
  const json = Buffer.from(JSON.stringify({asset:{version:'2.0'}, scenes:[{}], scene:0}), 'utf8');
  const padding = Buffer.alloc((4-json.length%4)%4, 0x20);
  const chunk = Buffer.concat([json,padding]);
  const header = Buffer.alloc(20);
  header.write('glTF',0,'ascii');
  header.writeUInt32LE(2,4);
  header.writeUInt32LE(header.length+chunk.length,8);
  header.writeUInt32LE(chunk.length,12);
  header.writeUInt32LE(0x4e4f534a,16);
  return Buffer.concat([header,chunk]);
}

function inventory(directory) {
  const rows = [];
  function walk(current, relative) {
    for (const name of fs.readdirSync(current).sort()) {
      const target = path.join(current,name), item = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) rows.push({path:item,type:'link',target:fs.readlinkSync(target)});
      else if (stat.isDirectory()) { rows.push({path:item,type:'directory'}); walk(target,item); }
      else rows.push({path:item,type:'file',bytes:stat.size,sha256:hash(fs.readFileSync(target))});
    }
  }
  walk(directory,'');
  return rows;
}

function invoke(fixture, action, fields = {}) {
  // Only owned synthetic storage is sent to the host. process.execPath is a
  // real executable accepted by its eager transformer validation; no Python
  // or renderer is invoked by remove/list on these synthetic GLB records.
  const environment = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR']
    .filter(key => process.env[key] !== undefined).map(key => [key,process.env[key]]));
  const result = spawnSync(process.execPath,[HOST],{
    cwd:REPOSITORY, env:environment, encoding:'utf8', timeout:10000, maxBuffer:1024*1024,
    input:JSON.stringify({storageDir:fixture.storage,python:process.execPath,runtimeAvailable:false,action,...fields}),
  });
  assert.equal(result.error,undefined,'The owned avatar host did not finish');
  assert.equal(result.signal,null,'The owned avatar host was killed');
  assert.equal(result.stderr,'','The owned avatar host emitted unexpected stderr');
  return {status:result.status,output:JSON.parse(result.stdout)};
}

function fixture(t) {
  // avatar-host intentionally requires the storage parent to be canonical.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reverie-avatar-remove-')));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const source = path.join(root,'synthetic.glb');
  fs.writeFileSync(source,minimalGlb());
  const storage = path.join(root,'avatars');
  const manager = managerFor(storage);
  function add(name) {
    const candidate = manager.beginImport(source,{displayName:name});
    manager.markPreviewReady(candidate.importId);
    return manager.commitImport({importId:candidate.importId,rightsConfirmed:true,warningAccepted:true});
  }
  const first = add('Synthetic A'), second = add('Synthetic B');
  manager.setActive(first.id);
  const value = {root,source,storage,manager,first,second};
  const baseline = invoke(value,'list');
  assert.equal(baseline.status,0);
  assert.equal(baseline.output.ok,true);
  assert.equal(baseline.output.list.activeId,first.id);
  assert.deepEqual(baseline.output.list.records.map(record => record.id),[first.id,second.id]);
  assert(baseline.output.list.records.every(record => record.status === 'ready'));
  assert.equal(baseline.output.entryPath,path.join(manager.recordsDir,first.id,'payload','avatar.glb'));
  assert.equal(hash(fs.readFileSync(baseline.output.entryPath)),hash(fs.readFileSync(source)));
  value.baseline = baseline.output;
  value.sourceSha256 = hash(fs.readFileSync(source));
  return value;
}

function patched(method,replacement,body) {
  const original = fs[method];
  fs[method] = (...args) => replacement(original,...args);
  try { return body(); } finally { fs[method] = original; }
}

function assertRefusedUnchanged(value,id,reason) {
  const before = inventory(value.storage);
  const result = invoke(value,'remove',{id});
  assert.equal(result.status,1);
  assert.equal(result.output.ok,false);
  assert.match(result.output.error,reason);
  assert.deepEqual(inventory(value.storage),before);
  const reread = invoke(value,'list');
  assert.equal(reread.status,0);
  assert.deepEqual(reread.output,value.baseline);
  assert.equal(hash(fs.readFileSync(value.source)),value.sourceSha256);
}

test('avatar host removes a noncurrent record and preserves the current path and original source',t => {
  const value = fixture(t);
  const activeBefore = inventory(path.join(value.manager.recordsDir,value.first.id));
  const activeFileBefore = fs.readFileSync(value.manager.activePath);
  const removed = invoke(value,'remove',{id:value.second.id});
  assert.equal(removed.status,0);
  assert.equal(removed.output.ok,true);
  assert.equal(removed.output.list.activeId,value.first.id);
  assert.equal(removed.output.entryPath,value.baseline.entryPath);
  assert.deepEqual(removed.output.list.records,[value.baseline.list.records[0]]);
  assert.equal(fs.existsSync(path.join(value.manager.recordsDir,value.second.id)),false);
  assert.equal(fs.existsSync(path.join(value.manager.recordsDir,`${value.second.id}.removing`)),false);
  assert.deepEqual(inventory(path.join(value.manager.recordsDir,value.first.id)),activeBefore);
  assert.deepEqual(fs.readFileSync(value.manager.activePath),activeFileBefore);
  assert.equal(hash(fs.readFileSync(value.source)),value.sourceSha256);
  const restarted = invoke(value,'list');
  assert.equal(restarted.status,0);
  assert.deepEqual(restarted.output,removed.output);
});

test('avatar host refuses the current avatar without changing any stored record',t => {
  const value = fixture(t);
  assertRefusedUnchanged(value,value.first.id,/^Choose another avatar before removing the active avatar$/);
});

test('avatar host refuses a traversal identifier without changing valid synthetic storage',t => {
  const value = fixture(t);
  assertRefusedUnchanged(value,'../x',/^Invalid avatar identifier$/);
});

test('avatar host refuses an empty identifier without changing valid synthetic storage',t => {
  const value = fixture(t);
  assertRefusedUnchanged(value,'',/^Invalid avatar identifier$/);
});

test('avatar host refuses a missing valid identifier without changing valid synthetic storage',t => {
  const value = fixture(t);
  assertRefusedUnchanged(value,'ffffffff-ffff-ffff-ffff-ffffffffffff',/^ENOENT:/);
});

test('avatar host refuses a corrupted record and leaves the current avatar and other records unchanged',t => {
  const value = fixture(t);
  // Mutation happens only after fixture() demonstrated a successful host list
  // with two valid records. Match the precise manifest refusal, not any error.
  const manifest = path.join(value.manager.recordsDir,value.second.id,'manifest.json');
  const document = JSON.parse(fs.readFileSync(manifest,'utf8'));
  document.schema = 'synthetic-corrupted-schema';
  fs.writeFileSync(manifest,JSON.stringify(document));
  const before = inventory(value.storage);
  const result = invoke(value,'remove',{id:value.second.id});
  assert.equal(result.status,1);
  assert.deepEqual(result.output,{ok:false,error:'Avatar manifest schema is invalid'});
  assert.deepEqual(inventory(value.storage),before);
  const reread = invoke(value,'list');
  assert.equal(reread.status,0);
  assert.equal(reread.output.list.activeId,value.first.id);
  assert.equal(reread.output.entryPath,value.baseline.entryPath);
  assert.deepEqual(reread.output.list.records.find(record => record.id === value.first.id),value.baseline.list.records[0]);
  assert.equal(reread.output.list.records.find(record => record.id === value.second.id).status,'error');
  assert.equal(hash(fs.readFileSync(value.source)),value.sourceSha256);
});

test('avatar manager treats partial physical deletion after rename as success and cleans it on reconstruction',t => {
  const value = fixture(t), target = path.join(value.manager.recordsDir,value.second.id);
  const removing = `${target}.removing`, activeFileBefore = fs.readFileSync(value.manager.activePath);
  patched('rmSync',(original,filename,options) => {
    if (filename === removing) {
      // Model an interrupted recursive delete that already lost its manifest.
      fs.unlinkSync(path.join(removing,'manifest.json'));
      const error = new Error('injected removal failure'); error.code = 'EACCES'; throw error;
    }
    return original(filename,options);
  },() => assert.deepEqual(value.manager.remove(value.second.id),{removed:true}));
  assert.equal(fs.existsSync(target),false);
  assert.equal(fs.existsSync(removing),true);
  assert.equal(fs.existsSync(path.join(removing,'manifest.json')),false);
  assert.deepEqual(value.manager.list(),{...value.baseline.list,records:[value.baseline.list.records[0]]});
  assert.deepEqual(fs.readFileSync(value.manager.activePath),activeFileBefore);
  const restarted = managerFor(value.storage);
  assert.equal(fs.existsSync(removing),false);
  assert.deepEqual(restarted.list().records,[value.baseline.list.records[0]]);
  assert.equal(restarted.list().activeId,value.first.id);
  assert.equal(hash(fs.readFileSync(value.source)),value.sourceSha256);
});

test('avatar manager propagates rename failure and retains the original list and bytes',t => {
  const value = fixture(t), target = path.join(value.manager.recordsDir,value.second.id);
  const before = inventory(value.storage);
  patched('renameSync',(original,from,to) => {
    if (from === target && to === `${target}.removing`) {
      const error = new Error('injected rename failure'); error.code = 'EACCES'; throw error;
    }
    return original(from,to);
  },() => assert.throws(() => value.manager.remove(value.second.id),error =>
    error.code === 'EACCES' && error.message === 'injected rename failure'));
  assert.deepEqual(inventory(value.storage),before);
  assert.deepEqual(value.manager.list(),value.baseline.list);
  assert.equal(fs.existsSync(`${target}.removing`),false);
});

test('avatar manager reconstruction removes only valid record tombstone directories',t => {
  const value = fixture(t), records = value.manager.recordsDir;
  const valid = path.join(records,`${crypto.randomUUID()}.removing`);
  const unrelated = path.join(records,'not-an-avatar.removing');
  const partial = path.join(records,`${crypto.randomUUID()}.partial`);
  const regular = path.join(records,`${crypto.randomUUID()}.removing`);
  const linked = path.join(records,`${crypto.randomUUID()}.removing`);
  const outside = path.join(value.root,'outside-owned-sentinel');
  for (const directory of [valid,unrelated,partial,outside]) {
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory,'sentinel'),'owned synthetic bytes');
  }
  fs.writeFileSync(regular,'owned synthetic regular file');
  fs.symlinkSync(outside,linked,'dir');
  const outsideBefore = inventory(outside), recordsBefore = value.baseline.list.records;
  const restarted = managerFor(value.storage);
  assert.equal(fs.existsSync(valid),false);
  assert.equal(fs.existsSync(unrelated),true);
  assert.equal(fs.existsSync(partial),true);
  assert.equal(fs.readFileSync(regular,'utf8'),'owned synthetic regular file');
  assert.equal(fs.lstatSync(linked).isSymbolicLink(),true);
  assert.deepEqual(inventory(outside),outsideBefore);
  assert.deepEqual(restarted.list().records,recordsBefore);
  assert.equal(restarted.list().activeId,value.first.id);
});

test('avatar manager constructor cleanup is best effort and keeps tombstones hidden until retry',t => {
  const value = fixture(t), target = path.join(value.manager.recordsDir,value.second.id);
  const removing = `${target}.removing`;
  fs.renameSync(target,removing); // Simulate interruption immediately after the logical commit.
  let restarted;
  patched('rmSync',(original,filename,options) => {
    if (filename === removing) { const error = new Error('injected cleanup failure'); error.code = 'EACCES'; throw error; }
    return original(filename,options);
  },() => { restarted = managerFor(value.storage); });
  assert.equal(fs.existsSync(removing),true);
  assert.deepEqual(restarted.list().records,[value.baseline.list.records[0]]);
  assert.equal(restarted.list().activeId,value.first.id);
  const retried = managerFor(value.storage);
  assert.equal(fs.existsSync(removing),false);
  assert.deepEqual(retried.list().records,[value.baseline.list.records[0]]);
});

test('avatar manager constructor tolerates an unreadable tombstone inventory',t => {
  const value = fixture(t);
  let restarted;
  patched('readdirSync',(original,directory,...args) => {
    if (directory === value.manager.recordsDir) { const error = new Error('injected inventory failure'); error.code = 'EACCES'; throw error; }
    return original(directory,...args);
  },() => { restarted = managerFor(value.storage); });
  assert.deepEqual(restarted.list(),value.baseline.list);
});
