'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {verifyAvatarManage,readAvatarStorage,captureAvatarManage} = require('./avatar-manage-verdicts.cjs');

const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const IMPORT='I'.repeat(32), CURRENT='先切换到其他形象，再删除。';
const NOTICE='这会删除应用保存的副本。原来的模型文件夹不受影响，需要时可以重新导入。';
const NAME='Synthetic <b>avatar</b>', CANARY='MODEL_PAYLOAD_MUST_NOT_BE_COPIED';
const hash=value => crypto.createHash('sha256').update(value).digest('hex');
const clone=value => JSON.parse(JSON.stringify(value));
const SCOPE=`builtin_hoshino_yumetsuki:1:${hash('synthetic-persona')}`;
const CHECKS=[
  ['initial-current-avatar-delete-disabled','current-reselect-keeps-ready-path-and-loads',
    'duplicate-preview-disables-delete','duplicate-import-keeps-two-records-and-selects-new',
    'switch-back-restores-original-ready-avatar','delete-cancel-dispatches-nothing',
    'delete-confirm-removes-only-inactive-without-reload','tail-preserves-archive-and-messages'],
  ['restart-loads-only-surviving-original-avatar','restart-sends-no-model-actions','restart-preserves-archive-and-messages'],
];
function modelBytes() {
  const json=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{}],scene:0,extras:{canary:CANARY}}));
  const payload=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]), header=Buffer.alloc(20);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+payload.length,8);
  header.writeUInt32LE(payload.length,12);header.writeUInt32LE(0x4e4f534a,16);return Buffer.concat([header,payload]);
}
function manifestDocument() {
  const bytes=modelBytes();
  return {schema:'reverie.avatar.v1',id:A,name:NAME,kind:'glb',entryRelative:'avatar.glb',
    files:[{path:'avatar.glb',size:bytes.length,sha256:hash(bytes)}],rightsConfirmed:true};
}
function geometry() {
  return {found:true,visible:true,fullyVisible:true,sceneX:10,sceneY:10,sceneWidth:80,sceneHeight:30,
    clipX:0,clipY:0,clipWidth:100,clipHeight:100};
}
function input(step,control,kind) {
  const snapshot={...geometry(),scope:SCOPE,ready:true,enabled:true,bound:true,geometryValid:true,
    integerPointInsideClip:true,pointX:50,pointY:25};
  const value={step,control,kind,elapsedMs:80,deadlineMs:4000,frame:step*10+2,
    layout:{...snapshot,layoutStable:true,elapsedMs:60,stableSinceMs:20,stableFrameSerial:step*10,frameSerial:step*10+1},
    gate:{performed:true,polls:1,sampleLimit:6,pollIntervalMs:40,last:{...snapshot,elapsedMs:60},samples:[{...snapshot,elapsedMs:60}]},
    hit:{hitResult:'descendant',acceptorFound:true}};
  if(kind==='path-handoff')Object.assign(value,{pathHandoffCount:1,mouseDispatchCount:0});
  else if(kind==='checkbox')Object.assign(value,{mouseDispatchCount:1,clickedSignals:1,toggledSignals:1,checked:true});
  else Object.assign(value,{mouseDispatchCount:1,clickedSignals:1});
  return value;
}
function job(serial,action,id,importId,activeId,recordIds) {
  return {serial,action,id,importId,activeId,recordIds:recordIds.slice().sort(),status:'completed',started:true,exitCode:0,ok:true};
}
function trace(records) { return {dispatched:records.length,started:records.length,completed:records.length,truncated:false,records:clone(records)}; }
function gate(id,enabled,blocker) { return {id,enabled,blocker,visible:true,wholeVisibility:geometry()}; }
function dialog() { return {targetId:B,name:NAME,title:'删除这个形象？',notice:NOTICE,namePlainText:true,noticePlainText:true,visible:true}; }
function fixture(data='/owned-avatar-manage') {
  const recordsPath=path.join(data,'avatars','records'), pathA=path.join(recordsPath,A,'payload','avatar.glb');
  const pathB=path.join(recordsPath,B,'payload','avatar.glb'), preview=path.join(data,'avatars','staging',IMPORT,'payload','avatar.glb');
  function snapshot(recordIds,activeId,currentPath,loads,count,candidateEmpty=true) {
    return {activeId,recordIds:recordIds.slice().sort(),names:Object.fromEntries(recordIds.map(id=>[id,NAME])),
      statuses:Object.fromEntries(recordIds.map(id=>[id,'ready'])),
      entryUrlsById:Object.fromEntries(recordIds.map(id=>[id,`reverie-avatar://asset/${id}/avatar.glb`])),
      path:currentPath,modelPath:currentPath,loads,ready:true,state:'形象已就绪',candidateEmpty,busy:false,
      jobDispatched:count,jobStarted:count,jobCompleted:count};
  }
  const startup=job(1,'list','','',A,[A]), jobs=[
    job(2,'select',A,'',A,[A]),job(3,'scan','',IMPORT,'',[]),job(4,'preview','',IMPORT,A,[A]),
    job(5,'commit','',IMPORT,B,[A,B]),job(6,'select',A,'',A,[A,B]),job(7,'remove',B,'',A,[A]),
  ];
  const baseline=snapshot([A],A,pathA,1,1), reselected=snapshot([A],A,pathA,1,2);
  const immediate={...clone(reselected),busy:true,jobStarted:1,jobCompleted:1};
  const switched=snapshot([A,B],A,pathA,4,6), archive={revision:6,sha256:hash('unchanged-archive'),messageIds:['existing-message']};
  const common=index=>({schema:'reverie.native.avatar-manage.gui-evidence.v1',passed:true,error:'',
    mode:index===0?'manage-and-readback':'restart-readback',step:index===0?18:20,deadlineMs:index===0?120000:15000,
    elapsedMs:index===0?1200:300,pollIntervalMs:40,checks:CHECKS[index].map(name=>({name,passed:true})),
    systemFolderDialogCovered:false,modelRequestsAdded:false,contentCollected:false});
  const first={...common(0),observed:{scopeKey:SCOPE,generation:1,roles:{aId:A,bId:B},baseline,
    reselect:{before:clone(baseline),immediate,after:reselected},initialGate:gate(A,false,CURRENT),
    preview:snapshot([A],A,preview,2,4,false),previewGate:gate(A,false,CURRENT),
    committed:snapshot([A,B],B,pathB,3,5),switchBack:switched,
    switchGates:{A:gate(A,false,CURRENT),B:gate(B,true,'')},
    consent:{rightsBefore:false,rightsAfter:true,warningsRequired:true,warningsBefore:false,warningsAfter:true,rightsClicks:1,warningClicks:1},
    cancel:{before:clone(switched),after:clone(switched),dialog:dialog()},
    remove:{before:clone(switched),after:snapshot([A],A,pathA,4,7),dialog:dialog(),
      feedback:{status:'success',text:`已删除「${NAME}」。`,id:B,name:NAME,listReloaded:true}},
    importTiming:{pathHandoffAtMs:200,previewReadyAtMs:300,confirmAtMs:400,committedReadyAtMs:500,elapsedMs:300},
    jobBaseline:trace([startup]),jobFinal:trace([startup,...jobs]),jobs:clone(jobs),archiveBefore:clone(archive),archiveAfter:clone(archive)},
    inputs:[[1,'nav-character','button'],[2,`avatarRecord-${A}`,'button'],[4,'importModel','path-handoff'],
      [6,'modelRights','checkbox'],[7,'modelWarnings','checkbox'],[8,'confirmModel','button'],[10,`avatarRecord-${A}`,'button'],
      [12,`avatarRemove-${B}`,'button'],[13,'avatarRemoveCancel','button'],[15,`avatarRemove-${B}`,'button'],[16,'avatarRemoveConfirm','button']]
      .map(row=>input(...row))};
  const second={...common(1),observed:{scopeKey:SCOPE,generation:1,roles:{aId:A,bId:''},baseline:clone(baseline),restart:clone(baseline),
    initialGate:gate(A,false,CURRENT),jobBaseline:trace([startup]),jobFinal:trace([startup]),jobs:[],
    archiveBefore:clone(archive),archiveAfter:clone(archive)},inputs:[input(1,'nav-character','button')]};
  const manifest=manifestDocument(), bytes=modelBytes();
  const storage={schema:'reverie.native.avatar-manage.storage.v1',recordsPath,recordIds:[A],
    active:{schema:'reverie.avatar-active.v1',activeId:A},
    manifest:{schema:manifest.schema,id:A,name:NAME,kind:'glb',entryRelative:'avatar.glb',rightsConfirmed:true,
      sha256:hash(JSON.stringify(manifest)),fileCount:1,entryBytes:bytes.length,entrySha256:hash(bytes)},
    entry:{path:pathA,relativePath:`records/${A}/payload/avatar.glb`,bytes:bytes.length,sha256:hash(bytes)}};
  const modelCalls=['probe','chat','reading-fixture','reading-fixture','stop-fixture','combined-fixture','settings-fixture','settings-fixture','probe']
    .map(kind=>({kind,worldbookMarkerPresent:false,delayMs:0,flaggedAuthorTextPresent:false,
      ...(kind==='settings-fixture'?{cycle:1}: {})}));
  return {first,second,storage,http:{requests:9,modelCalls,firstStorage:clone(storage)}};
}
const verify=value=>verifyAvatarManage(value.first,value.second,value.storage,value.http);
function rejects(rows) { for(const row of rows)assertRejectedMutation({makeFixture:fixture,verify,...row}); }
function changeJob(value,index,mutate) {
  mutate(value.first.observed.jobs[index]);
  value.first.observed.jobFinal.records[index+1]=clone(value.first.observed.jobs[index]);
}
function appendJob(observed,newJob) {
  observed.jobFinal.records.push(newJob);
  observed.jobFinal.dispatched++;observed.jobFinal.started++;observed.jobFinal.completed++;
  observed.jobs=clone(observed.jobFinal.records.slice(observed.jobBaseline.dispatched));
}

test('avatar management accepts correlated real actions, preserved A4 loads and unchanged restart metadata',()=>{
  const proof=verify(fixture());
  assert.deepEqual(proof.checks,[8,3]);assert.equal(proof.removals,1);assert.equal(proof.cancelDispatches,0);
  assert.deepEqual(proof.loads,{initial:1,afterReselect:1,afterImport:3,afterSwitch:4,afterRemove:4,restart:1});
  assert.equal(proof.secondImportMs,300);assert.equal(proof.modelContentCopied,false);
});

test('avatar management rejects already granted consent instead of reusing checkbox inputs',()=>rejects([
  {id:'avatar.reused-consent',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:value=>{
    Object.assign(value.first.observed.consent,{rightsBefore:true,rightsClicks:0,warningsBefore:true,warningClicks:0});
    value.first.inputs=value.first.inputs.filter(row=>row.kind!=='checkbox');
  }},
]));

test('avatar management accepts an import without performance warnings and retains the rights click',()=>{
  const value=fixture();
  Object.assign(value.first.observed.consent,{warningsRequired:false,warningsBefore:false,warningsAfter:false,warningClicks:0});
  value.first.inputs=value.first.inputs.filter(row=>row.step!==7);
  assert.equal(verify(value).passed,true);
});

test('avatar management rejects missing repeated reordered or failed checks and stale context',()=>rejects([
  {id:'avatar.check-missing',expectedReason:'AVATAR_MANAGE_CHECKS',mutate:v=>v.first.checks.pop()},
  {id:'avatar.check-duplicate',expectedReason:'AVATAR_MANAGE_CHECKS',mutate:v=>v.second.checks.push(clone(v.second.checks[0]))},
  {id:'avatar.check-order',expectedReason:'AVATAR_MANAGE_CHECKS',mutate:v=>v.first.checks.reverse()},
  {id:'avatar.check-false',expectedReason:'AVATAR_MANAGE_CHECKS',mutate:v=>{v.first.checks[0].passed=false;}},
  {id:'avatar.scope-stale',expectedReason:'AVATAR_MANAGE_CONTEXT',mutate:v=>{v.first.observed.scopeKey='default';}},
  {id:'avatar.tail-deadline',expectedReason:'AVATAR_MANAGE_DEADLINE',mutate:v=>{v.first.elapsedMs=120000;}},
  {id:'avatar.payload-in-report',expectedReason:'AVATAR_MANAGE_EVIDENCE_FIELDS',mutate:v=>{v.first.modelPayload=CANARY;}},
]));

test('avatar management rejects failed missing duplicated or misbound actual host traces',()=>rejects([
  {id:'avatar.trace-failed',expectedReason:'AVATAR_MANAGE_TRACE',mutate:v=>{v.first.observed.jobFinal.records[6].ok=false;}},
  {id:'avatar.trace-truncated',expectedReason:'AVATAR_MANAGE_TRACE',mutate:v=>{v.first.observed.jobFinal.truncated=true;}},
  {id:'avatar.trace-delta-missing',expectedReason:'AVATAR_MANAGE_TRACE_DELTA',mutate:v=>v.first.observed.jobs.pop()},
  {id:'avatar.extra-remove',expectedReason:'AVATAR_MANAGE_ACTION_SEQUENCE',mutate:v=>appendJob(v.first.observed,job(8,'remove',B,'',A,[A]))},
  {id:'avatar.wrong-remove-id',expectedReason:'AVATAR_MANAGE_ACTION_IDS',mutate:v=>changeJob(v,5,j=>{j.id=A;})},
  {id:'avatar.wrong-import-id',expectedReason:'AVATAR_MANAGE_ACTION_IDS',mutate:v=>changeJob(v,2,j=>{j.importId='J'.repeat(32);})},
  {id:'avatar.scan-spoofed-result',expectedReason:'AVATAR_MANAGE_ACTION_IDS',mutate:v=>changeJob(v,1,j=>{j.recordIds=[A];})},
]));

test('avatar management rejects A4 reloads lost readiness wrong active IDs and cancel dispatches',()=>rejects([
  {id:'avatar.reselect-reloaded',expectedReason:'AVATAR_MANAGE_RESELECT',mutate:v=>{v.first.observed.reselect.immediate.loads++;}},
  {id:'avatar.reselect-not-ready',expectedReason:'AVATAR_MANAGE_READY',mutate:v=>{v.first.observed.reselect.immediate.ready=false;}},
  {id:'avatar.ready-flag-with-failure-text',expectedReason:'AVATAR_MANAGE_READY',mutate:v=>{v.first.observed.reselect.immediate.state='未就绪';}},
  {id:'avatar.switch-wrong-id',expectedReason:'AVATAR_MANAGE_ACTIVE_ID',mutate:v=>{v.first.observed.switchBack.activeId=B;}},
  {id:'avatar.cancel-dispatched',expectedReason:'AVATAR_MANAGE_CANCEL',mutate:v=>{v.first.observed.cancel.after.jobDispatched++;}},
  {id:'avatar.remove-reloaded',expectedReason:'AVATAR_MANAGE_REMOVE',mutate:v=>{v.first.observed.remove.after.loads++;}},
  {id:'avatar.remove-ack-only',expectedReason:'AVATAR_MANAGE_RECORDS',mutate:v=>{v.first.observed.remove.after.recordIds.push(B);}},
  {id:'avatar.feedback-not-read',expectedReason:'AVATAR_MANAGE_REMOVE_FEEDBACK',mutate:v=>{v.first.observed.remove.feedback.listReloaded=false;}},
]));

test('avatar management rejects disabled gate bypasses rich dialog text and false consent',()=>rejects([
  {id:'avatar.current-delete-enabled',expectedReason:'AVATAR_MANAGE_DELETE_GATE',mutate:v=>{v.first.observed.initialGate.enabled=true;}},
  {id:'avatar.preview-delete-enabled',expectedReason:'AVATAR_MANAGE_DELETE_GATE',mutate:v=>{v.first.observed.previewGate.enabled=true;}},
  {id:'avatar.inactive-delete-disabled',expectedReason:'AVATAR_MANAGE_DELETE_GATE',mutate:v=>{v.first.observed.switchGates.B.enabled=false;}},
  {id:'avatar.dialog-rich-name',expectedReason:'AVATAR_MANAGE_DIALOG',mutate:v=>{v.first.observed.cancel.dialog.namePlainText=false;}},
  {id:'avatar.dialog-wrong-target',expectedReason:'AVATAR_MANAGE_DIALOG',mutate:v=>{v.first.observed.remove.dialog.targetId=A;}},
  {id:'avatar.rights-not-clicked',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.rightsClicks=0;}},
]));

test('avatar management rejects missing input real readiness geometry signals and duplicated dispatches',()=>rejects([
  {id:'avatar.input-missing',expectedReason:'AVATAR_MANAGE_INPUT_SEQUENCE',mutate:v=>v.first.inputs.pop()},
  {id:'avatar.input-not-ready',expectedReason:'AVATAR_MANAGE_INPUT_READY',mutate:v=>{v.first.inputs[1].layout.ready=false;}},
  {id:'avatar.input-center-outside',expectedReason:'AVATAR_MANAGE_INPUT_GEOMETRY',mutate:v=>{v.first.inputs[1].layout.pointX=101;}},
  {id:'avatar.input-no-stable-frame',expectedReason:'AVATAR_MANAGE_INPUT_STABILITY',mutate:v=>{v.first.inputs[1].layout.stableFrameSerial=v.first.inputs[1].layout.frameSerial;}},
  {id:'avatar.input-old-frame',expectedReason:'AVATAR_MANAGE_INPUT_ORDER',mutate:v=>{v.first.inputs[1].frame=v.first.inputs[0].frame;}},
  {id:'avatar.input-empty-gate',expectedReason:'AVATAR_MANAGE_INPUT_GATE',mutate:v=>{v.first.inputs[1].gate.samples=[];}},
  {id:'avatar.input-intercepted',expectedReason:'AVATAR_MANAGE_INPUT_HIT',mutate:v=>{v.first.inputs[1].hit.hitResult='ancestor';}},
  {id:'avatar.input-double-confirm',expectedReason:'AVATAR_MANAGE_INPUT_COUNTS',mutate:v=>{v.first.inputs.at(-1).clickedSignals=2;}},
  {id:'avatar.input-handoff-double',expectedReason:'AVATAR_MANAGE_INPUT_COUNTS',mutate:v=>{v.first.inputs[2].pathHandoffCount=2;}},
]));

test('avatar management rejects incorrect import timing new model calls and changed unrelated state',()=>rejects([
  {id:'avatar.import-duration',expectedReason:'AVATAR_MANAGE_IMPORT_TIMING',mutate:v=>{v.first.observed.importTiming.elapsedMs++;}},
  {id:'avatar.import-too-late',expectedReason:'AVATAR_MANAGE_IMPORT_TIMING',mutate:v=>{v.first.observed.importTiming.committedReadyAtMs=120001;}},
  {id:'avatar.extra-model-request',expectedReason:'AVATAR_MANAGE_MODEL_REQUESTS',mutate:v=>{v.http.requests=10;}},
  {id:'avatar.wrong-model-kind',expectedReason:'AVATAR_MANAGE_MODEL_REQUESTS',mutate:v=>{v.http.modelCalls[0].kind='avatar-fixture';}},
  {id:'avatar.archive-written',expectedReason:'AVATAR_MANAGE_UNRELATED_STATE',mutate:v=>{v.first.observed.archiveAfter.revision++;}},
  {id:'avatar.messages-changed',expectedReason:'AVATAR_MANAGE_UNRELATED_STATE',mutate:v=>{v.second.observed.archiveAfter.messageIds.push('unexpected-message');}},
]));

test('avatar management rejects restart actions changed survivor paths and unbound disk manifests',()=>rejects([
  {id:'avatar.restart-select',expectedReason:'AVATAR_MANAGE_RESTART_ACTIONS',mutate:v=>appendJob(v.second.observed,job(2,'select',A,'',A,[A]))},
  {id:'avatar.restart-path-changed',expectedReason:'AVATAR_MANAGE_RESTART',mutate:v=>{v.second.observed.restart.loads++;}},
  {id:'avatar.disk-extra-record',expectedReason:'AVATAR_MANAGE_STORAGE',mutate:v=>{v.storage.recordIds.push(B);}},
  {id:'avatar.disk-active-wrong',expectedReason:'AVATAR_MANAGE_STORAGE',mutate:v=>{v.storage.active.activeId=B;}},
  {id:'avatar.disk-manifest-wrong-id',expectedReason:'AVATAR_MANAGE_STORAGE_MANIFEST',mutate:v=>{v.storage.manifest.id=B;}},
  {id:'avatar.disk-hash-mismatch',expectedReason:'AVATAR_MANAGE_STORAGE_MANIFEST',mutate:v=>{v.storage.entry.sha256=hash('wrong');}},
  {id:'avatar.disk-path-mismatch',expectedReason:'AVATAR_MANAGE_STORAGE_PATH',mutate:v=>{v.storage.entry.path+='.wrong';}},
  {id:'avatar.first-disk-missing',expectedReason:'AVATAR_MANAGE_FIRST_STORAGE',mutate:v=>{delete v.http.firstStorage;}},
  {id:'avatar.first-disk-tombstone',expectedReason:'AVATAR_MANAGE_FIRST_STORAGE',mutate:v=>{v.http.firstStorage.recordIds.push(`${B}.removing`);}},
  {id:'avatar.first-disk-wrong',expectedReason:'AVATAR_MANAGE_FIRST_STORAGE',mutate:v=>{v.http.firstStorage.manifest.sha256=hash('different');}},
]));

function fileFixture() {
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'avatar-manage-verdict-')));
  const data=path.join(directory,'data'), report=path.join(directory,'report');
  fs.mkdirSync(report);fs.mkdirSync(path.join(data,'avatars','records',A,'payload'),{recursive:true});
  const value=fixture(data), manifest=manifestDocument();
  fs.writeFileSync(path.join(data,'avatars','active.json'),JSON.stringify({schema:'reverie.avatar-active.v1',activeId:A,changedAtUtc:'2026-11-07T00:00:00.000Z'}),{mode:0o600});
  fs.writeFileSync(path.join(data,'avatars','records',A,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  fs.writeFileSync(path.join(data,'avatars','records',A,'payload','avatar.glb'),modelBytes(),{mode:0o600});
  return {...value,directory,data,report};
}
const dispose=value=>fs.rmSync(value.directory,{recursive:true,force:true});
function verifyFiles(value) { return verifyAvatarManage(value.first,value.second,readAvatarStorage(value.data),value.http); }
test('avatar management captures actual survivor metadata without copying any model payload',()=>{
  const value=fileFixture();
  try {
    const firstStorage=readAvatarStorage(value.data);
    const proof=captureAvatarManage([{avatarManage:value.first},{avatarManage:value.second}],value.data,value.report,
      {...value.http,firstStorage});
    assert.equal(proof.passed,true);assert.equal(proof.modelContentCopied,false);
    assert.deepEqual(fs.readdirSync(value.report).sort(),['avatar-manage-proof.json','avatar-manage-storage.json']);
    for(const filename of fs.readdirSync(value.report))assert.equal(fs.readFileSync(path.join(value.report,filename),'utf8').includes(CANARY),false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(value.report,'avatar-manage-proof.json'),'utf8')),proof);
  } finally {dispose(value);}
});

test('avatar management rejects leftover tombstones extra records changed active identity and unsafe metadata files',()=>{
  for(const row of [
    {id:'avatar.files-tombstone',expectedReason:'AVATAR_MANAGE_STORAGE_RECORDS',mutate:v=>fs.mkdirSync(path.join(v.data,'avatars','records',`${B}.removing`))},
    {id:'avatar.files-extra-record',expectedReason:'AVATAR_MANAGE_STORAGE_RECORDS',mutate:v=>fs.mkdirSync(path.join(v.data,'avatars','records',B))},
    {id:'avatar.files-active-id',expectedReason:'AVATAR_MANAGE_ACTIVE_FILE',mutate:v=>fs.writeFileSync(path.join(v.data,'avatars','active.json'),JSON.stringify({schema:'reverie.avatar-active.v1',activeId:B,changedAtUtc:'2026-11-07T00:00:00Z'}))},
    {id:'avatar.files-manifest-id',expectedReason:'AVATAR_MANAGE_MANIFEST_FILE',mutate:v=>{const m=manifestDocument();m.id=B;fs.writeFileSync(path.join(v.data,'avatars','records',A,'manifest.json'),JSON.stringify(m));}},
    {id:'avatar.files-manifest-link',expectedReason:'AVATAR_MANAGE_MANIFEST_FILE',mutate:v=>{const target=path.join(v.data,'avatars','records',A,'manifest.json');fs.renameSync(target,target+'.actual');fs.symlinkSync(target+'.actual',target);}},
    {id:'avatar.files-records-link',expectedReason:'AVATAR_MANAGE_STORAGE_DIRECTORY',mutate:v=>{const target=path.join(v.data,'avatars','records');fs.renameSync(target,target+'.actual');fs.symlinkSync(target+'.actual',target,'dir');}},
  ])assertRejectedMutation({makeFixture:fileFixture,verify:verifyFiles,kind:'files',dispose,...row});
});

test('avatar management rejects altered linked or missing actual entry files without exporting their bytes',()=>{
  const entry=value=>path.join(value.data,'avatars','records',A,'payload','avatar.glb');
  for(const row of [
    {id:'avatar.files-entry-changed',mutate:v=>{const bytes=fs.readFileSync(entry(v));bytes[bytes.length-1]^=1;fs.writeFileSync(entry(v),bytes);}},
    {id:'avatar.files-entry-missing',mutate:v=>fs.unlinkSync(entry(v))},
    {id:'avatar.files-entry-link',mutate:v=>{const target=entry(v);fs.renameSync(target,target+'.actual');fs.symlinkSync(target+'.actual',target);}},
    {id:'avatar.files-entry-hardlink',mutate:v=>fs.linkSync(entry(v),entry(v)+'.hardlink')},
  ])assertRejectedMutation({makeFixture:fileFixture,verify:verifyFiles,kind:'files',dispose,expectedReason:'AVATAR_MANAGE_ENTRY_FILE',...row});
});

test('avatar management accepts the actual ordinary call metadata without invented cycle fields',()=>{
  const value=fixture();
  assert(value.http.modelCalls.filter(call=>call.kind!=='settings-fixture').every(call=>!Object.hasOwn(call,'cycle')));
  assert.equal(verify(value).passed,true);
});
test('avatar management rejects missing or wrong settings cycles on a fresh valid baseline',()=>rejects([
  {id:'avatar.settings-cycle-missing',expectedReason:'AVATAR_MANAGE_MODEL_REQUESTS',mutate:v=>{delete v.http.modelCalls.find(call=>call.kind==='settings-fixture').cycle;}},
  {id:'avatar.settings-cycle-wrong',expectedReason:'AVATAR_MANAGE_MODEL_REQUESTS',mutate:v=>{v.http.modelCalls.find(call=>call.kind==='settings-fixture').cycle=2;}},
]));

test('avatar management requires fresh unchecked consent and exact clicks for each visible checkbox',()=>rejects([
  {id:'avatar.old-rights-only',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.rightsBefore=true;}},
  {id:'avatar.old-warning-only',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.warningsBefore=true;}},
  {id:'avatar.rights-unset-before',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{delete v.first.observed.consent.rightsBefore;}},
  {id:'avatar.warning-unset-before',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{delete v.first.observed.consent.warningsBefore;}},
  {id:'avatar.rights-not-retained',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.rightsAfter=false;}},
  {id:'avatar.rights-extra-click',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.rightsClicks=2;}},
  {id:'avatar.warning-no-click',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.warningClicks=0;}},
  {id:'avatar.warning-extra-click',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.warningClicks=2;}},
  {id:'avatar.warning-not-retained',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{v.first.observed.consent.warningsAfter=false;}},
  {id:'avatar.hidden-old-warning-before',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{
    Object.assign(v.first.observed.consent,{warningsRequired:false,warningsBefore:true,warningsAfter:false,warningClicks:0});
    v.first.inputs=v.first.inputs.filter(row=>row.step!==7);
  }},
  {id:'avatar.hidden-warning-after',expectedReason:'AVATAR_MANAGE_CONSENT',mutate:v=>{
    Object.assign(v.first.observed.consent,{warningsRequired:false,warningsBefore:false,warningsAfter:true,warningClicks:0});
    v.first.inputs=v.first.inputs.filter(row=>row.step!==7);
  }},
]));
