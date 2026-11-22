'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {TextDecoder} = require('node:util');
const {verdictReason} = require('./verdict-test-support.cjs');

const AVATAR_MANAGE_CONTRACT = 'reverie.native.avatar-manage.verdict.v1';
const NOTICE = '这会删除应用保存的副本。原来的模型文件夹不受影响，需要时可以重新导入。';
const CURRENT = '先切换到其他形象，再删除。';
const CHECKS = [
  ['initial-current-avatar-delete-disabled','current-reselect-keeps-ready-path-and-loads',
    'duplicate-preview-disables-delete','duplicate-import-keeps-two-records-and-selects-new',
    'switch-back-restores-original-ready-avatar','delete-cancel-dispatches-nothing',
    'delete-confirm-removes-only-inactive-without-reload','tail-preserves-archive-and-messages'],
  ['restart-loads-only-surviving-original-avatar','restart-sends-no-model-actions','restart-preserves-archive-and-messages'],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function guard(value, reason) { assert(value,verdictReason(reason)); }
function equal(actual, expected, reason) { assert.deepEqual(actual,expected,verdictReason(reason)); }
function keys(value, expected, reason) {
  guard(object(value),reason); equal(Object.keys(value).sort(),expected.slice().sort(),reason);
}
function ids(value, expected, reason) {
  guard(Array.isArray(value) && value.every(id => typeof id === 'string' && UUID.test(id)) &&
    new Set(value).size === value.length,reason);
  equal(value.slice().sort(),expected.slice().sort(),reason);
}

function rect(value,prefix) {
  const result = ['X','Y','Width','Height'].map(key => value[prefix+key]);
  guard(result.every(Number.isFinite) && result[2] > 1 && result[3] > 1,'AVATAR_MANAGE_INPUT_GEOMETRY');
  return result;
}
function visibility(value) {
  guard(object(value) && value.found === true && value.visible === true && value.fullyVisible === true,
    'AVATAR_MANAGE_INPUT_VISIBILITY');
  const scene=rect(value,'scene'), clip=rect(value,'clip');
  guard(scene[0]+.5 >= clip[0] && scene[1]+.5 >= clip[1] && scene[0]+scene[2]-.5 <= clip[0]+clip[2] &&
    scene[1]+scene[3]-.5 <= clip[1]+clip[3],'AVATAR_MANAGE_INPUT_GEOMETRY');
  return {scene,clip};
}
function ready(value) {
  const geometry=visibility(value);
  guard(['ready','enabled','bound','geometryValid','integerPointInsideClip'].every(key => value[key] === true) &&
    typeof value.scope === 'string' && value.scope.length > 0,'AVATAR_MANAGE_INPUT_READY');
  const inside=area => value.pointX >= area[0] && value.pointY >= area[1] &&
    value.pointX <= area[0]+area[2] && value.pointY <= area[1]+area[3];
  guard(Number.isSafeInteger(value.pointX) && Number.isSafeInteger(value.pointY) && inside(geometry.scene) && inside(geometry.clip) &&
    value.pointX === Math.round(geometry.scene[0]+geometry.scene[2]/2) &&
    value.pointY === Math.round(geometry.scene[1]+geometry.scene[3]/2),'AVATAR_MANAGE_INPUT_GEOMETRY');
}
function input(value,spec) {
  equal([value?.step,value?.control,value?.kind],spec,'AVATAR_MANAGE_INPUT_SEQUENCE');
  guard(value.deadlineMs === 4000 && whole(value.elapsedMs) && value.elapsedMs < 4000 && whole(value.frame),
    'AVATAR_MANAGE_INPUT_DEADLINE');
  const layout=value.layout, gate=value.gate;
  ready(layout);
  guard(layout.layoutStable === true && whole(layout.elapsedMs) && layout.elapsedMs <= value.elapsedMs &&
    whole(layout.stableSinceMs) && layout.elapsedMs-layout.stableSinceMs >= 40 &&
    whole(layout.stableFrameSerial) && whole(layout.frameSerial) && layout.frameSerial > layout.stableFrameSerial &&
    value.frame >= layout.frameSerial,'AVATAR_MANAGE_INPUT_STABILITY');
  guard(object(gate) && gate.performed === true && gate.sampleLimit === 6 && gate.pollIntervalMs === 40 &&
    whole(gate.polls) && gate.polls >= 1 && Array.isArray(gate.samples) && gate.samples.length > 0 &&
    gate.samples.length <= 6 && gate.polls >= gate.samples.length && object(gate.last),'AVATAR_MANAGE_INPUT_GATE');
  ready(gate.last);
  guard(whole(gate.last.elapsedMs) && gate.last.elapsedMs >= layout.elapsedMs && gate.last.elapsedMs <= value.elapsedMs,
    'AVATAR_MANAGE_INPUT_GATE');
  for (const key of ['scope','pointX','pointY','sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'])
    equal(gate.last[key],layout[key],'AVATAR_MANAGE_INPUT_GATE');
  let last=-1;
  for (const sample of gate.samples) {
    guard(object(sample) && whole(sample.elapsedMs) && sample.elapsedMs >= last && sample.elapsedMs <= gate.last.elapsedMs,
      'AVATAR_MANAGE_INPUT_GATE'); last=sample.elapsedMs;
  }
  guard(object(value.hit) && value.hit.acceptorFound === true && ['target','descendant'].includes(value.hit.hitResult),
    'AVATAR_MANAGE_INPUT_HIT');
  if (value.kind === 'path-handoff') equal([value.pathHandoffCount,value.mouseDispatchCount],[1,0],'AVATAR_MANAGE_INPUT_COUNTS');
  else if (value.kind === 'checkbox')
    equal([value.mouseDispatchCount,value.clickedSignals,value.toggledSignals,value.checked],[1,1,1,true],'AVATAR_MANAGE_INPUT_COUNTS');
  else equal([value.mouseDispatchCount,value.clickedSignals],[1,1],'AVATAR_MANAGE_INPUT_COUNTS');
}

function trace(value) {
  guard(object(value) && value.truncated === false && whole(value.dispatched) && whole(value.started) && whole(value.completed) &&
    value.dispatched === value.started && value.started === value.completed && Array.isArray(value.records) &&
    value.records.length === value.dispatched && value.records.length <= 64,'AVATAR_MANAGE_TRACE');
  value.records.forEach((job,index) => {
    keys(job,['serial','action','id','importId','status','started','exitCode','ok','activeId','recordIds'],
      'AVATAR_MANAGE_TRACE');
    guard(object(job) && job.serial === index+1 && job.status === 'completed' && job.started === true &&
      job.exitCode === 0 && job.ok === true && ['list','select','scan','preview','commit','remove'].includes(job.action) &&
      typeof job.id === 'string' && (job.id === '' || UUID.test(job.id)) &&
      typeof job.importId === 'string' && (job.importId === '' || /^[A-Za-z0-9_-]{32}$/.test(job.importId)) &&
      typeof job.activeId === 'string' && (job.activeId === '' || UUID.test(job.activeId)) &&
      Array.isArray(job.recordIds) && job.recordIds.every(id => typeof id === 'string' && UUID.test(id)) &&
      new Set(job.recordIds).size === job.recordIds.length,'AVATAR_MANAGE_TRACE');
  });
}
function urlEntry(url,id) {
  try {
    const value=new URL(url), segments=value.pathname.split('/').slice(1).map(decodeURIComponent);
    guard(value.protocol === 'reverie-avatar:' && value.hostname === 'asset' && !value.username && !value.password &&
      !value.port && !value.search && !value.hash && segments.shift() === id && segments.length > 0 &&
      segments.every(part => part && part !== '.' && part !== '..' && !/[\\/\u0000-\u001f\u007f]/u.test(part)),
    'AVATAR_MANAGE_RECORD_URL');
    return segments.join('/');
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.fail(verdictReason('AVATAR_MANAGE_RECORD_URL'));
  }
}
function snapshot(value,recordIds,activeId,{readyState=true}={}) {
  guard(object(value),'AVATAR_MANAGE_SNAPSHOT');
  keys(value,['activeId','recordIds','names','statuses','entryUrlsById','path','modelPath','loads','ready','state',
    'candidateEmpty','busy','jobDispatched','jobStarted','jobCompleted'],'AVATAR_MANAGE_SNAPSHOT');
  ids(value.recordIds,recordIds,'AVATAR_MANAGE_RECORDS');
  equal(value.activeId,activeId,'AVATAR_MANAGE_ACTIVE_ID');
  keys(value.names,recordIds,'AVATAR_MANAGE_RECORDS');
  keys(value.statuses,recordIds,'AVATAR_MANAGE_RECORDS');
  keys(value.entryUrlsById,recordIds,'AVATAR_MANAGE_RECORDS');
  for (const id of recordIds) {
    guard(typeof value.names[id] === 'string' && value.names[id].length > 0 && value.names[id].length <= 80 &&
      value.statuses[id] === 'ready','AVATAR_MANAGE_RECORDS');
    urlEntry(value.entryUrlsById[id],id);
  }
  guard(typeof value.path === 'string' && path.isAbsolute(value.path) && typeof value.modelPath === 'string' &&
    whole(value.loads) && value.loads > 0 && typeof value.ready === 'boolean' && typeof value.busy === 'boolean' &&
    typeof value.candidateEmpty === 'boolean' && typeof value.state === 'string' &&
    ['jobDispatched','jobStarted','jobCompleted'].every(key => whole(value[key])),'AVATAR_MANAGE_SNAPSHOT');
  if (readyState) guard(value.ready === true && value.modelPath === value.path && value.state === '形象已就绪',
    'AVATAR_MANAGE_READY');
}
function settled(value,count) {
  guard(value.busy === false && value.jobDispatched === count && value.jobStarted === count && value.jobCompleted === count,
    'AVATAR_MANAGE_JOB_BINDING');
}
function gate(value,id,enabled,blocker) {
  guard(object(value) && value.id === id && value.enabled === enabled && value.blocker === blocker && value.visible === true,
    'AVATAR_MANAGE_DELETE_GATE');
  visibility(value.wholeVisibility);
}
function dialog(value,id,name) {
  equal(value,{targetId:id,name,title:'删除这个形象？',notice:NOTICE,namePlainText:true,noticePlainText:true,visible:true},
    'AVATAR_MANAGE_DIALOG');
}
function archive(value) {
  keys(value,['revision','sha256','messageIds'],'AVATAR_MANAGE_ARCHIVE');
  guard(whole(value.revision) && sha(value.sha256) && Array.isArray(value.messageIds) &&
    value.messageIds.every(id => typeof id === 'string' && id.length > 0) && new Set(value.messageIds).size === value.messageIds.length,
  'AVATAR_MANAGE_ARCHIVE');
}
function cycle(value,index) {
  guard(object(value) && value.schema === 'reverie.native.avatar-manage.gui-evidence.v1' && value.passed === true && value.error === '' &&
    value.mode === ['manage-and-readback','restart-readback'][index] && value.step === [18,20][index],'AVATAR_MANAGE_CYCLE');
  keys(value,['schema','passed','error','mode','step','deadlineMs','elapsedMs','pollIntervalMs','checks','inputs','observed',
    'systemFolderDialogCovered','modelRequestsAdded','contentCollected'],'AVATAR_MANAGE_EVIDENCE_FIELDS');
  guard(value.deadlineMs === [120000,15000][index] && whole(value.elapsedMs) && value.elapsedMs < value.deadlineMs &&
    value.pollIntervalMs === 40,'AVATAR_MANAGE_DEADLINE');
  guard(value.systemFolderDialogCovered === false && value.modelRequestsAdded === false && value.contentCollected === false,'AVATAR_MANAGE_COVERAGE');
  guard(Array.isArray(value.checks),'AVATAR_MANAGE_CHECKS');
  equal(value.checks.map(check => [check.name,check.passed]),CHECKS[index].map(name => [name,true]),'AVATAR_MANAGE_CHECKS');
  const observed=value.observed;
  guard(object(observed) && object(observed.roles) && UUID.test(observed.roles.aId) &&
    (index === 1 || (UUID.test(observed.roles.bId) && observed.roles.aId !== observed.roles.bId)),'AVATAR_MANAGE_ROLES');
  guard(typeof observed.scopeKey === 'string' && observed.scopeKey.length <= 300 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*:[1-9][0-9]*:[0-9a-f]{64}$/.test(observed.scopeKey) &&
    whole(observed.generation) && observed.generation > 0,'AVATAR_MANAGE_CONTEXT');
  trace(observed.jobBaseline); trace(observed.jobFinal);
  equal(observed.jobFinal.records.slice(0,observed.jobBaseline.dispatched),observed.jobBaseline.records,'AVATAR_MANAGE_TRACE_PREFIX');
  equal(observed.jobs,observed.jobFinal.records.slice(observed.jobBaseline.dispatched),'AVATAR_MANAGE_TRACE_DELTA');
  archive(observed.archiveBefore); archive(observed.archiveAfter);
  equal(observed.archiveAfter,observed.archiveBefore,'AVATAR_MANAGE_UNRELATED_STATE');
  guard(Array.isArray(value.inputs),'AVATAR_MANAGE_INPUT_SEQUENCE');
  guard(value.inputs.every(row => row.layout?.scope === observed.scopeKey),'AVATAR_MANAGE_CONTEXT');
  let previousFrame=-1;
  for (const row of value.inputs) {
    guard(whole(row.frame) && row.frame > previousFrame,'AVATAR_MANAGE_INPUT_ORDER');
    previousFrame=row.frame;
  }
  return observed;
}

function verifyAvatarManage(first,second,storage,{requests,modelCalls,firstStorage}={}) {
  const a=cycle(first,0), b=cycle(second,1), {aId,bId}=a.roles, start=a.jobBaseline.dispatched;
  // Ordinary chat/probe metadata has no cycle. Only settings-fixture calls
  // carry it in the existing producer; do not invent an envelope field.
  guard(requests === 9 && Array.isArray(modelCalls) && modelCalls.length === 9 &&
    modelCalls.every(call => object(call) && typeof call.kind === 'string') &&
    modelCalls.filter(call => call.kind === 'settings-fixture').every(call => call.cycle === 1),
    'AVATAR_MANAGE_MODEL_REQUESTS');
  const kinds={}; for (const call of modelCalls) kinds[call.kind]=(kinds[call.kind]||0)+1;
  equal(kinds,{probe:2,'reading-fixture':2,'settings-fixture':2,chat:1,'stop-fixture':1,'combined-fixture':1},
    'AVATAR_MANAGE_MODEL_REQUESTS');
  const consent=a.consent;
  guard(object(consent) && ['rightsBefore','rightsAfter','warningsRequired','warningsBefore','warningsAfter']
    .every(key => typeof consent[key] === 'boolean') && consent.rightsBefore === false && consent.warningsBefore === false &&
    consent.rightsClicks === 1 && consent.rightsAfter === true &&
    consent.warningClicks === (consent.warningsRequired ? 1 : 0) &&
    consent.warningsAfter === consent.warningsRequired,'AVATAR_MANAGE_CONSENT');
  const specs=[[1,'nav-character','button'],[2,`avatarRecord-${aId}`,'button'],[4,'importModel','path-handoff'],
    ...(consent.rightsClicks ? [[6,'modelRights','checkbox']] : []),
    ...(consent.warningClicks ? [[7,'modelWarnings','checkbox']] : []),[8,'confirmModel','button'],
    [10,`avatarRecord-${aId}`,'button'],[12,`avatarRemove-${bId}`,'button'],[13,'avatarRemoveCancel','button'],
    [15,`avatarRemove-${bId}`,'button'],[16,'avatarRemoveConfirm','button']];
  equal(first.inputs.map(row => [row.step,row.control,row.kind]),specs,'AVATAR_MANAGE_INPUT_SEQUENCE');
  first.inputs.forEach((row,index) => input(row,specs[index]));
  equal(second.inputs.map(row => [row.step,row.control,row.kind]),[[1,'nav-character','button']],'AVATAR_MANAGE_INPUT_SEQUENCE');
  input(second.inputs[0],[1,'nav-character','button']);
  equal(a.jobs.map(job => job.action),['select','scan','preview','commit','select','remove'],'AVATAR_MANAGE_ACTION_SEQUENCE');
  equal(a.jobFinal.dispatched,start+6,'AVATAR_MANAGE_JOB_BINDING');
  const importId=a.jobs[1].importId;
  guard(/^[A-Za-z0-9_-]{32}$/.test(importId),'AVATAR_MANAGE_IMPORT_ID');
  equal(a.jobs.map(job => [job.id,job.importId]),[[aId,''],['',importId],['',importId],['',importId],[aId,''],[bId,'']],
    'AVATAR_MANAGE_ACTION_IDS');
  equal(a.jobs.map(job => job.activeId),[aId,'',aId,bId,aId,aId],'AVATAR_MANAGE_ACTION_IDS');
  [[aId],[],[aId],[aId,bId],[aId,bId],[aId]].forEach((wanted,index) => ids(a.jobs[index].recordIds,wanted,'AVATAR_MANAGE_ACTION_IDS'));
  snapshot(a.baseline,[aId],aId); settled(a.baseline,start);
  guard(a.baseline.candidateEmpty === true,'AVATAR_MANAGE_SNAPSHOT');
  gate(a.initialGate,aId,false,CURRENT);
  equal(a.reselect?.before,a.baseline,'AVATAR_MANAGE_RESELECT');
  snapshot(a.reselect?.immediate,[aId],aId); snapshot(a.reselect?.after,[aId],aId);
  for (const current of [a.reselect.immediate,a.reselect.after]) {
    equal([current.path,current.modelPath,current.loads,current.candidateEmpty],
      [a.baseline.path,a.baseline.path,a.baseline.loads,true],'AVATAR_MANAGE_RESELECT');
    guard(current.jobDispatched === start+1 && current.jobStarted >= start && current.jobStarted <= start+1 &&
      current.jobCompleted >= start && current.jobCompleted <= current.jobStarted,'AVATAR_MANAGE_RESELECT');
  }
  settled(a.reselect.after,start+1);
  snapshot(a.preview,[aId],aId); settled(a.preview,start+3);
  guard(a.preview.candidateEmpty === false && a.preview.path !== a.baseline.path &&
    a.preview.path.includes(`${path.sep}staging${path.sep}${importId}${path.sep}payload${path.sep}`) &&
    a.preview.loads > a.baseline.loads,'AVATAR_MANAGE_PREVIEW');
  gate(a.previewGate,aId,false,CURRENT);
  snapshot(a.committed,[aId,bId],bId); settled(a.committed,start+4);
  guard(a.committed.candidateEmpty === true && a.committed.path !== a.preview.path &&
    a.committed.path !== a.baseline.path && a.committed.loads > a.preview.loads,'AVATAR_MANAGE_COMMIT');
  snapshot(a.switchBack,[aId,bId],aId); settled(a.switchBack,start+5);
  equal([a.switchBack.path,a.switchBack.candidateEmpty],[a.baseline.path,true],'AVATAR_MANAGE_SWITCH');
  guard(a.switchBack.loads > a.committed.loads,'AVATAR_MANAGE_SWITCH');
  gate(a.switchGates?.A,aId,false,CURRENT); gate(a.switchGates?.B,bId,true,'');
  equal(a.cancel?.before,a.switchBack,'AVATAR_MANAGE_CANCEL');
  equal(a.cancel?.after,a.cancel.before,'AVATAR_MANAGE_CANCEL');
  dialog(a.cancel.dialog,bId,a.committed.names[bId]);
  equal(a.remove?.before,a.cancel.after,'AVATAR_MANAGE_REMOVE');
  dialog(a.remove.dialog,bId,a.committed.names[bId]);
  snapshot(a.remove.after,[aId],aId); settled(a.remove.after,start+6);
  equal([a.remove.after.path,a.remove.after.modelPath,a.remove.after.loads,a.remove.after.candidateEmpty],
    [a.baseline.path,a.baseline.path,a.switchBack.loads,true],'AVATAR_MANAGE_REMOVE');
  equal(a.remove.feedback,{status:'success',text:`已删除「${a.committed.names[bId]}」。`,id:bId,name:a.committed.names[bId],listReloaded:true},
    'AVATAR_MANAGE_REMOVE_FEEDBACK');
  for (const current of [a.reselect.after,a.preview,a.committed,a.switchBack,a.remove.after]) {
    equal(current.names[aId],a.baseline.names[aId],'AVATAR_MANAGE_RECORDS');
    equal(current.entryUrlsById[aId],a.baseline.entryUrlsById[aId],'AVATAR_MANAGE_RECORDS');
  }
  equal([a.switchBack.names[bId],a.switchBack.entryUrlsById[bId]],
    [a.committed.names[bId],a.committed.entryUrlsById[bId]],'AVATAR_MANAGE_RECORDS');
  const timing=a.importTiming;
  guard(object(timing) && ['pathHandoffAtMs','previewReadyAtMs','confirmAtMs','committedReadyAtMs','elapsedMs']
    .every(key => whole(timing[key])) && timing.pathHandoffAtMs < timing.previewReadyAtMs &&
    timing.previewReadyAtMs <= timing.confirmAtMs && timing.confirmAtMs < timing.committedReadyAtMs &&
    timing.committedReadyAtMs <= first.elapsedMs && timing.elapsedMs === timing.committedReadyAtMs-timing.pathHandoffAtMs &&
    timing.elapsedMs > 0 && timing.elapsedMs < 120000,'AVATAR_MANAGE_IMPORT_TIMING');
  equal(b.roles.aId,aId,'AVATAR_MANAGE_RESTART');
  equal(b.scopeKey,a.scopeKey,'AVATAR_MANAGE_CONTEXT');
  snapshot(b.baseline,[aId],aId); snapshot(b.restart,[aId],aId);
  gate(b.initialGate,aId,false,CURRENT);
  equal(b.restart,b.baseline,'AVATAR_MANAGE_RESTART');
  equal([b.baseline.path,b.baseline.names[aId],b.baseline.entryUrlsById[aId]],
    [a.baseline.path,a.baseline.names[aId],a.baseline.entryUrlsById[aId]],'AVATAR_MANAGE_RESTART');
  guard(b.baseline.candidateEmpty === true,'AVATAR_MANAGE_RESTART');
  settled(b.baseline,1); settled(b.restart,1);
  equal(b.jobBaseline.records.map(job => job.action),['list'],'AVATAR_MANAGE_RESTART_ACTIONS');
  equal(b.jobFinal,b.jobBaseline,'AVATAR_MANAGE_RESTART_ACTIONS'); equal(b.jobs,[],'AVATAR_MANAGE_RESTART_ACTIONS');
  equal([b.jobFinal.records[0].activeId,b.jobFinal.records[0].id],[aId,''],'AVATAR_MANAGE_RESTART_ACTIONS');
  ids(b.jobFinal.records[0].recordIds,[aId],'AVATAR_MANAGE_RESTART_ACTIONS');
  equal(b.archiveBefore,a.archiveAfter,'AVATAR_MANAGE_UNRELATED_STATE');
  guard(object(storage) && storage.schema === 'reverie.native.avatar-manage.storage.v1','AVATAR_MANAGE_STORAGE');
  guard(typeof storage.recordsPath === 'string' && path.isAbsolute(storage.recordsPath),'AVATAR_MANAGE_STORAGE_PATH');
  ids(storage.recordIds,[aId],'AVATAR_MANAGE_STORAGE');
  equal(storage.active,{schema:'reverie.avatar-active.v1',activeId:aId},'AVATAR_MANAGE_STORAGE');
  const manifest=storage.manifest, entry=storage.entry;
  guard(object(manifest) && manifest.schema === 'reverie.avatar.v1' && manifest.id === aId && manifest.name === a.baseline.names[aId] &&
    ['vrm','glb','live2d'].includes(manifest.kind) && manifest.rightsConfirmed === true && sha(manifest.sha256) &&
    whole(manifest.fileCount) && manifest.fileCount > 0 && object(entry) && whole(entry.bytes) && entry.bytes > 0 &&
    entry.bytes === manifest.entryBytes && sha(entry.sha256) && entry.sha256 === manifest.entrySha256,
  'AVATAR_MANAGE_STORAGE_MANIFEST');
  equal(urlEntry(a.baseline.entryUrlsById[aId],aId),manifest.entryRelative,'AVATAR_MANAGE_STORAGE_PATH');
  equal(entry.path,a.baseline.path,'AVATAR_MANAGE_STORAGE_PATH');
  equal(entry.relativePath,`records/${aId}/payload/${manifest.entryRelative}`,'AVATAR_MANAGE_STORAGE_PATH');
  equal(entry.path,path.join(storage.recordsPath,aId,'payload',...manifest.entryRelative.split('/')),'AVATAR_MANAGE_STORAGE_PATH');
  const committedRelative=urlEntry(a.committed.entryUrlsById[bId],bId);
  equal(a.committed.path,path.join(storage.recordsPath,bId,'payload',...committedRelative.split('/')),'AVATAR_MANAGE_STORAGE_PATH');
  equal(a.preview.path,path.join(path.dirname(storage.recordsPath),'staging',importId,'payload',...committedRelative.split('/')),
    'AVATAR_MANAGE_STORAGE_PATH');
  // Captured before launching cycle two: startup constructor cleanup must not
  // hide a tombstone left by the first-cycle physical removal.
  equal(firstStorage,storage,'AVATAR_MANAGE_FIRST_STORAGE');
  return {passed:true,contract:AVATAR_MANAGE_CONTRACT,checks:[8,3],aId,bId,
    tailActions:a.jobs.map(job => job.action),removals:1,cancelDispatches:0,restartActions:['list'],
    secondImportMs:timing.elapsedMs,loads:{initial:a.baseline.loads,afterReselect:a.reselect.after.loads,
      afterImport:a.committed.loads,afterSwitch:a.switchBack.loads,afterRemove:a.remove.after.loads,restart:b.restart.loads},
    archiveSha256:a.archiveAfter.sha256,archiveRevision:a.archiveAfter.revision,
    manifestSha256:manifest.sha256,entry:{relativePath:entry.relativePath,bytes:entry.bytes,sha256:entry.sha256},
    records:[aId],activeId:aId,modelContentCopied:false,systemFolderDialogCovered:false,modelRequestsAdded:0};
}

function regularDirectory(directory) {
  try { const info=fs.lstatSync(directory); guard(info.isDirectory() && !info.isSymbolicLink(),'AVATAR_MANAGE_STORAGE_DIRECTORY'); }
  catch (error) { if (error instanceof assert.AssertionError) throw error; assert.fail(verdictReason('AVATAR_MANAGE_STORAGE_DIRECTORY')); }
}
function readBounded(filename,maximum,reason) {
  let fd;
  try {
    const before=fs.lstatSync(filename);
    guard(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= maximum,reason);
    fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const opened=fs.fstatSync(fd);
    guard(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.nlink === 1,reason);
    const buffer=Buffer.alloc(maximum+1); let length=0;
    while (length < buffer.length) { const received=fs.readSync(fd,buffer,length,buffer.length-length,null); if (!received) break; length+=received; }
    const after=fs.fstatSync(fd), named=fs.lstatSync(filename);
    guard(length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      named.dev === opened.dev && named.ino === opened.ino && named.nlink === 1,reason);
    return buffer.subarray(0,length);
  } catch (error) { if (error instanceof assert.AssertionError) throw error; assert.fail(verdictReason(reason)); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function json(bytes,reason) {
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    // Tokenize only for duplicate-key/depth validation; JSON.parse remains the
    // grammar authority. No rejected text is included in diagnostic messages.
    let at=0;
    const space=() => { while (at < text.length && /[ \n\r\t]/.test(text[at])) ++at; };
    const string=() => { const start=at++; while (at < text.length) {
      const c=text[at++]; if (c==='\\') {++at;continue;} if (c==='"') return JSON.parse(text.slice(start,at));
    } throw new Error('string'); };
    const value=depth => {
      if (depth > 64) throw new Error('depth'); space();
      if (text[at]==='{') { ++at;space();const seen=new Set();if(text[at]==='}'){++at;return;}
        while(true){space();if(text[at]!=='"')throw new Error('object');const key=string();if(seen.has(key))throw new Error('duplicate');seen.add(key);
          space();if(text[at++]!==':')throw new Error('object');value(depth+1);space();const c=text[at++];if(c==='}')return;if(c!==',')throw new Error('object');}}
      if(text[at]==='['){++at;space();if(text[at]===']'){++at;return;}while(true){value(depth+1);space();const c=text[at++];if(c===']')return;if(c!==',')throw new Error('array');}}
      if(text[at]==='"'){string();return;}
      const token=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
      if(!token)throw new Error('token');at+=token[0].length;const parsed=JSON.parse(token[0]);if(typeof parsed==='number'&&!Number.isFinite(parsed))throw new Error('number');
    };
    value(0);space();if(at!==text.length)throw new Error('trailing');return JSON.parse(text);
  } catch { assert.fail(verdictReason(reason)); }
}
function readAvatarStorage(dataDirectory) {
  const root=path.join(dataDirectory,'avatars'), records=path.join(root,'records');
  regularDirectory(dataDirectory); regularDirectory(root); regularDirectory(records);
  const recordIds=fs.readdirSync(records).sort();
  guard(recordIds.length === 1 && UUID.test(recordIds[0]),'AVATAR_MANAGE_STORAGE_RECORDS');
  const id=recordIds[0], record=path.join(records,id), payload=path.join(record,'payload');
  regularDirectory(record);regularDirectory(payload);
  const active=json(readBounded(path.join(root,'active.json'),65536,'AVATAR_MANAGE_ACTIVE_FILE'),'AVATAR_MANAGE_ACTIVE_FILE');
  keys(active,['schema','activeId','changedAtUtc'],'AVATAR_MANAGE_ACTIVE_FILE');
  guard(active.schema === 'reverie.avatar-active.v1' && active.activeId === id && typeof active.changedAtUtc === 'string' &&
    Number.isFinite(Date.parse(active.changedAtUtc)),'AVATAR_MANAGE_ACTIVE_FILE');
  const manifestBytes=readBounded(path.join(record,'manifest.json'),1024*1024,'AVATAR_MANAGE_MANIFEST_FILE');
  const manifest=json(manifestBytes,'AVATAR_MANAGE_MANIFEST_FILE');
  guard(object(manifest) && manifest.schema === 'reverie.avatar.v1' && manifest.id === id &&
    typeof manifest.name === 'string' && ['vrm','glb','live2d'].includes(manifest.kind) && manifest.rightsConfirmed === true &&
    typeof manifest.entryRelative === 'string' && Array.isArray(manifest.files) &&
    manifest.files.every(file => object(file) && typeof file.path === 'string'),'AVATAR_MANAGE_MANIFEST_FILE');
  const relative=urlEntry(`reverie-avatar://asset/${id}/${manifest.entryRelative.split('/').map(encodeURIComponent).join('/')}`,id);
  const matches=manifest.files.filter(file => file.path === relative);
  guard(matches.length === 1 && whole(matches[0].size) && matches[0].size > 0 && matches[0].size <= 300*1024*1024 && sha(matches[0].sha256),
    'AVATAR_MANAGE_MANIFEST_FILE');
  const parts=relative.split('/'); let directory=payload;
  for (const segment of parts.slice(0,-1)) { directory=path.join(directory,segment);regularDirectory(directory); }
  const filename=path.join(payload,...parts);
  // Hash the entry incrementally; neither a model file nor its bytes are
  // exported to the report. The host has already copied it into owned data.
  let fd, entryHash;
  try {
    const before=fs.lstatSync(filename);
    guard(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size === matches[0].size,'AVATAR_MANAGE_ENTRY_FILE');
    fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const opened=fs.fstatSync(fd);guard(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size,'AVATAR_MANAGE_ENTRY_FILE');
    const digest=crypto.createHash('sha256'), buffer=Buffer.alloc(1024*1024);let count=0;
    while(count < opened.size){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,opened.size-count),null);guard(n>0,'AVATAR_MANAGE_ENTRY_FILE');digest.update(buffer.subarray(0,n));count+=n;}
    const after=fs.fstatSync(fd),named=fs.lstatSync(filename);entryHash=digest.digest('hex');
    guard(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
      named.dev === opened.dev && named.ino === opened.ino && named.nlink === 1 && entryHash === matches[0].sha256,'AVATAR_MANAGE_ENTRY_FILE');
  } catch(error){if(error instanceof assert.AssertionError)throw error;assert.fail(verdictReason('AVATAR_MANAGE_ENTRY_FILE'));}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  return {schema:'reverie.native.avatar-manage.storage.v1',recordsPath:records,recordIds,
    active:{schema:active.schema,activeId:active.activeId},
    manifest:{schema:manifest.schema,id,name:manifest.name,kind:manifest.kind,entryRelative:relative,rightsConfirmed:true,
      sha256:hash(manifestBytes),fileCount:manifest.files.length,entryBytes:matches[0].size,entrySha256:matches[0].sha256},
    entry:{path:filename,relativePath:`records/${id}/payload/${relative}`,bytes:matches[0].size,sha256:entryHash}};
}
function captureAvatarManage(reports,dataDirectory,reportDirectory,requests) {
  guard(Array.isArray(reports) && reports.length === 2,'AVATAR_MANAGE_TWO_CYCLES');
  const storage=readAvatarStorage(dataDirectory);
  fs.writeFileSync(path.join(reportDirectory,'avatar-manage-storage.json'),JSON.stringify(storage,null,2),{flag:'wx',mode:0o600});
  const proof=verifyAvatarManage(reports[0].avatarManage,reports[1].avatarManage,storage,requests);
  fs.writeFileSync(path.join(reportDirectory,'avatar-manage-proof.json'),JSON.stringify(proof,null,2),{flag:'wx',mode:0o600});
  return proof;
}
module.exports={AVATAR_MANAGE_CONTRACT,verifyAvatarManage,readAvatarStorage,captureAvatarManage};
