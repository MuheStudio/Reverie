'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {readInputs,modelInventory}=require('./macos-ui-materials.cjs');
test('no supplied material is explicitly not-run, not successful real rendering',()=>{assert.equal(readInputs([]).status,'not-run');assert.equal(readInputs([]).missing.length,3);});
test('local input validation rejects unconfirmed rights and wrong hashes',()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reverie-material-fixture-')));
 try{
  const core=path.join(root,'core.js'),model=path.join(root,'model'),manifest=path.join(root,'materials.json');fs.mkdirSync(model);fs.writeFileSync(core,'synthetic Live2DCubismCore fixture; not a real SDK');fs.writeFileSync(path.join(model,'fixture.model3.json'),'{}');
  const value={schema:'reverie.live2d.local-validation-materials.v1',purpose:'local-development-only',core:{version:'synthetic',sourceUrl:'https://www.live2d.com/sdk/',termsAccepted:true,sha256:crypto.createHash('sha256').update(fs.readFileSync(core)).digest('hex')},model:{rightsHolder:'synthetic test fixture',localTestingPermitted:true,treeSha256:modelInventory(model).sha256}};
  const write=()=>fs.writeFileSync(manifest,JSON.stringify(value));write();const args=['--core',core,'--model',model,'--materials',manifest];assert.equal(readInputs(args).status,'ready');
  value.core.termsAccepted=false;write();assert.throws(()=>readInputs(args),/not confirmed/);value.core.termsAccepted=true;
  value.model.treeSha256='0'.repeat(64);write();assert.throws(()=>readInputs(args),/hashes/);
  value.model.treeSha256=modelInventory(model).sha256;
  value.schema='reverie.live2d.local-validation-materials.v2';delete value.model.rightsHolder;
  value.model.permissionBasis={kind:'direct-user-request',statement:'User supplied this synthetic fixture for local validation only'};write();
  const supplied=readInputs(args);assert.equal(supplied.status,'ready');assert.equal(supplied.evidence.model.rightsHolder,null);assert.equal(supplied.evidence.distributionAuthorized,false);
  value.model.permissionBasis.statement='';write();assert.throws(()=>readInputs(args),/not confirmed/);
  value.model.permissionBasis.statement='synthetic local-use instruction';value.core.termsAccepted=false;write();assert.throws(()=>readInputs(args),/not confirmed/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('POSIX model links are rejected',{skip:process.platform==='win32'},()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'reverie-material-link-')));
 try{fs.writeFileSync(path.join(root,'fixture.model3.json'),'{}');fs.symlinkSync(path.join(root,'fixture.model3.json'),path.join(root,'alias'));assert.throws(()=>modelInventory(root),/links/);}
 finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('partial and relative input never starts an application',()=>{assert.throws(()=>readInputs(['--core','relative']),/Missing/);assert.throws(()=>readInputs(['--unknown','x']),/Usage/);});
