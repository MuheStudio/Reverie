'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { inventory, audit } = require('./audit-macos-source.cjs');
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-source-audit-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
test('real bundle inventory notices same-size corruption and added files', t => {
  const root=fixture(t);fs.writeFileSync(path.join(root,'payload'),'original');
  const before=inventory(root);fs.writeFileSync(path.join(root,'payload'),'corrupt!');
  assert.notEqual(inventory(root).sha256,before.sha256);
  fs.writeFileSync(path.join(root,'payload'),'original');assert.deepEqual(inventory(root),before);
  fs.writeFileSync(path.join(root,'unexpected'),'x');assert.notEqual(inventory(root).sha256,before.sha256);
});
test('existing audit output is never overwritten even if the input is missing', t => {
  const root=fixture(t), output=path.join(root,'result.json');fs.writeFileSync(output,'keep');
  assert.throws(()=>audit(path.join(root,'missing.json'),output),/already exists/);
  assert.equal(fs.readFileSync(output,'utf8'),'keep');
});
if(process.platform!=='win32') test('contained links remain distinct identities and escaping links are refused', t => {
  const root=fixture(t), app=path.join(root,'app');fs.mkdirSync(app);fs.writeFileSync(path.join(app,'a'),'one');
  fs.symlinkSync('a',path.join(app,'link'));assert.deepEqual(inventory(app).files.find(x=>x.path==='link'),{path:'link',symlink:'a'});
  fs.writeFileSync(path.join(root,'sentinel'),'outside');fs.unlinkSync(path.join(app,'link'));fs.symlinkSync('../sentinel',path.join(app,'link'));
  assert.throws(()=>inventory(app),/Escaping/);assert.equal(fs.readFileSync(path.join(root,'sentinel'),'utf8'),'outside');
});
