'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {MEMORY_CANDIDATE_BATCH_CONTRACT: contract, verifyMemoryCandidateBatch, verifyCandidateHeader, verifyCandidateHeaderAcquisition, verifyCandidateHeaderReadAnchor} = require('./memory-candidate-batch-verdicts.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const cid = n => `mc_${n.toString(16).padStart(32, '0')}`;
const geometry = (y, height = 20) => ({found: true, visible: true, fullyVisible: true,
  sceneX: 100, sceneY: y, sceneWidth: 360, sceneHeight: height,
  clipX: 100, clipY: y, clipWidth: 360, clipHeight: height});
function header(readRequestId = 'candidates-0', pageNumber = 1, count = 100) {
  const text = `待确认 · 第${pageNumber}批 · 本批${count}条`;
  return {schema: 'reverie.candidate-header.v1', objectName: 'memoryCandidatePageInfo', rootObjectName: 'memoryTasks', objectCount: 1,
    outsideScroll: true, page: 'memory', tabIndex: 0, live: true, busy: false, pageNumber, count,
    readRequestId, scope: 'persona-2', generation: 2, frameSerial: 12,
    textLength: text.length, textSha256: createHash('sha256').update(text).digest('hex'), textMatches: true,
    className: 'QQuickText', inheritsQuickText: true, textFormat: 0, textFormatValid: true,
    textFormatProperty: {exists: true, readable: true, enumProperty: true, readSucceeded: true,
      enumType: true, conversionSucceeded: true, memberValid: true},
    childInputObjects: {childrenInspected: 2, childScanComplete: true, mouseAreaChildren: 0, pointerHandlerChildren: 0},
    activeFocus: false, activeFocusOnTab: false, acceptedMouseButtons: 0,
    contentWidth: 250, contentHeight: 18, geometry: geometry(200), windowWidth: 1000, windowHeight: 900,
    scrollFound: true, contentYBefore: 1200, contentYAfter: 1200};
}
function settledHeader(value, companion = null, deadlineMs = 10000) {
  const terminal={...clone(value),elapsedMs:40},anchor={...clone(value),frameSerial:value.frameSerial-1,elapsedMs:0};
  value.settling={minimumStableMs:40,deadlineMs,elapsedMs:40,stableSinceMs:0,frameSerial:terminal.frameSerial,
    stableFrameSerial:anchor.frameSerial,polls:2,sampleLimit:6,samples:[clone(anchor),clone(terminal)],anchor,terminal,
    companionAnchor:companion?clone(companion):{},companionTerminal:companion?clone(companion):{},
    terminalCount:1,ready:true,expired:false,failed:false};
  return value;
}
function fixture() {
  const confirmTargets = [cid(130), cid(129), cid(128)], rejectTargets = [cid(127), cid(126)];
  const baseline = Array.from({length: 130}, (_, n) => 130 - n).filter(n => n !== 30 && n !== 29).map(cid);
  const newMemoryIds = confirmTargets.map(id => `fact_${id.slice(3)}`);
  const memoryPage = [...newMemoryIds].sort().reverse().concat(Array.from({length: 97}, (_, n) => `existing-${n}`));
  const messages = Array.from({length: 39}, (_, n) => ({id: `message-${n}`}));
  const common = {ok: true, generation: 2, scope: 'persona-2'};
  const status = (requestId, ids, state) => ({...common, requestId, command: 'memory:candidates:status', candidate_ids: ids,
    states: Object.fromEntries(ids.map(id => [id, state])), pending_ids: state === 'pending' ? ids : [],
    stale_ids: state === 'pending' ? [] : ids, new_ids: state === 'pending' ? ids : [], replace_ids: [], same_ids: [],
    replaced_pinned_ids: [], conflict_groups: []});
  const receipts = [status('preview-cancelled', confirmTargets, 'pending')], actions = [];
  for (const [index, ids] of [confirmTargets, rejectTargets].entries()) {
    const confirm = index === 0;
    const preview = status(`preview-${index}`, ids, 'pending');
    const ack = {...common, requestId: `write-${index}`, command: 'memory:candidates:decide_many', candidate_ids: ids,
      decision: confirm ? 'confirm' : 'reject'};
    if (confirm) Object.assign(ack, {new_ids: ids, replace_ids: [], same_ids: [], replaced_pinned_ids: [],
      confirmed: ids.map(id => ({candidate_id: id, memory_id: `fact_${id.slice(3)}`, replaced_memory_id: '', idempotent: false}))});
    else ack.rejected_ids = ids;
    const fresh = status(`status-${index}`, ids, confirm ? 'confirmed' : 'rejected');
    const decided = confirm ? confirmTargets : [...confirmTargets, ...rejectTargets];
    const candidatePage = baseline.filter(id => !decided.includes(id)).slice(0, 100);
    const candidates = {...common, requestId: `candidates-${index}`, command: 'memory:candidates:list',
      pageIds: candidatePage.slice(), pageCount: 100, identityValid: true, allPending: true};
    const list = {...common, requestId: `list-${index}`, command: 'memory:list',
      pageIds: memoryPage.slice(), pageCount: 100, identityValid: true};
    receipts.push(preview, ack, fresh, candidates, list);
    actions.push({requestId: ack.requestId, previewRequestId: preview.requestId, statusReadId: fresh.requestId,
      candidateReadId: `candidates-${index}`, listReadId: `list-${index}`, ids, confirm,
      memoryIds: confirm ? ids.map(id => `fact_${id.slice(3)}`) : [], status: 'success',
      candidatePageIds: candidatePage.slice(), memoryPageIds: memoryPage.slice(),
      feedbackWholeVisible: true, feedbackContrast: {contrast: 5, pixelCount: 20},
      feedbackGeometry: geometry(160), header: settledHeader(header(`candidates-${index}`),geometry(160))});
  }
  const controls = {0: 'nav-memory', 1: 'archive-open-memories', 2: 'memoryTab-memories', 3: 'memoryCandidateFirst',
    5: 'memoryCandidateSelectMode', 6: 'memoryCandidateSelect0', 7: 'memoryCandidateSelect1', 8: 'memoryCandidateSelect2',
    9: 'memoryCandidateConfirmSelected', 12: 'memoryCandidateBatchCancel', 14: 'memoryCandidateConfirmSelected',
    16: 'memoryCandidateBatchConfirm', 18: 'memoryCandidateSelectMode', 19: 'memoryCandidateSelect0',
    20: 'memoryCandidateSelect1', 21: 'memoryCandidateRejectSelected', 24: 'memoryCandidateBatchConfirm', 27: 'memory-close'};
  const inputTargets = {6: confirmTargets[0], 7: confirmTargets[1], 8: confirmTargets[2], 19: rejectTargets[0], 20: rejectTargets[1]};
  const inputs = contract.inputSteps.map(step => {
    const id = inputTargets[step] || '';
    return {step, id, control: controls[step],
      signals: {controlKind: id ? 'switch' : step === 2 ? 'tab' : 'button', observerValid: true, mouseDispatchCount: 1,
        clickedSignals: id ? 0 : 1, toggledSignals: id ? 1 : null, contractReason: ''},
      layout: {ready: true, minimumStableMs: 40, last: {layoutStable: true, fullyVisible: true}},
      hit: {hitResult: 'target', acceptorFound: true}};
  });
  const finalCandidateIds = baseline.filter(id => ![...confirmTargets, ...rejectTargets].includes(id)).slice(0, 100);
  const segment = {passed: true, contentCollected: false, deadlineMs: 30000, elapsedMs: 14000, inputs,
    checks: contract.checks.map(name => ({name, passed: true})),
    observed: {scope: 'persona-2', generation: 2, baselineCandidateIds: baseline.slice(),
      initialCandidateIds: baseline.slice(0, 100), confirmTargets, rejectTargets, initialPendingCount: 100,
      finalCandidateIds, finalCandidateCount: 100, finalPageMatches: true,
      beforeMessageIds: messages.map(m => m.id), finalMessageIds: messages.map(m => m.id),
      writeDispatchDelta: 2, statusReadDispatchDelta: 5, cancelWriteDelta: 0, initialPreviewId: 'preview-cancelled',
      receipts, actions, candidateReads: [{step: 3, oldId: 'candidates-old', newId: 'candidates-own'}],
      selectionEmpty: true, selectionMode: false, terminalStatus: 'success', surfaceClosed: true,
      confirmContrast: [{contrast: 8, pixelCount: 10}, {contrast: 8, pixelCount: 10}],
      'reject-confirmContrast': [{contrast: 8, pixelCount: 10}, {contrast: 8, pixelCount: 10}]}};
  const original = {passed: true, contentCollected: false, observed: {finalCandidateCount: 128, finalCandidateIds: baseline}};
  return {reports: [{messages, memoryCandidatePage: clone(original)},
    {messages, memoryCandidatePage: clone(original), memoryCandidateBatch: segment}]};
}
const fixedRejectionContexts = {
  "CB_HEADER_01": {
    "field": "schema"
  },
  "CB_HEADER_02": {
    "field": "objectIdentity"
  },
  "CB_HEADER_03": {
    "field": "rootObjectName"
  },
  "CB_HEADER_04": {
    "field": "expectedPageNumber"
  },
  "CB_HEADER_05": {
    "field": "expectedCount"
  },
  "CB_HEADER_06": {
    "field": "pageNumberAndCount"
  },
  "CB_HEADER_07": {
    "field": "generation"
  },
  "CB_HEADER_08": {
    "field": "readRequestId"
  },
  "CB_HEADER_09": {
    "field": "scope"
  },
  "CB_HEADER_10": {
    "field": "generation"
  },
  "CB_HEADER_11": {
    "field": "frameSerial"
  },
  "CB_HEADER_12": {
    "field": "textLength"
  },
  "CB_HEADER_13": {
    "field": "textLengthLimit"
  },
  "CB_HEADER_14": {
    "field": "textSha256"
  },
  "CB_HEADER_15": {
    "field": "textMatches"
  },
  "CB_HEADER_16": {
    "field": "passiveInput"
  },
  "CB_HEADER_17": {
    "field": "inheritsQuickText"
  },
  "CB_HEADER_18": {
    "field": "className"
  },
  "CB_HEADER_19": {
    "field": "textFormatValid"
  },
  "CB_HEADER_21": {
    "field": "textFormat"
  },
  "CB_HEADER_22": {
    "field": "childInputObjects"
  },
  "CB_HEADER_23": {
    "field": "childInputHandlers"
  },
  "CB_HEADER_24": {
    "field": "scrollFound"
  },
  "CB_HEADER_25": {
    "field": "contentYBefore"
  },
  "CB_HEADER_26": {
    "field": "contentYAfter"
  },
  "CB_HEADER_27": {
    "field": "live"
  },
  "CB_HEADER_28": {
    "field": "busy"
  },
  "CB_HEADER_29": {
    "field": "visibilityContract"
  },
  "CB_HEADER_30": {
    "field": "geometry.visible"
  },
  "CB_HEADER_31": {
    "field": "contentWidth"
  },
  "CB_HEADER_32": {
    "field": "contentHeight"
  },
  "CB_ACQUISITION_01": {
    "field": "deadlineMs"
  },
  "CB_ACQUISITION_02": {
    "field": "settling"
  },
  "CB_ACQUISITION_03": {
    "field": "minimumStableMs"
  },
  "CB_ACQUISITION_04": {
    "field": "deadlineMs"
  },
  "CB_ACQUISITION_05": {
    "field": "sampleLimit"
  },
  "CB_ACQUISITION_06": {
    "field": "terminalCount"
  },
  "CB_ACQUISITION_08": {
    "field": "stabilityWindow"
  },
  "CB_ACQUISITION_09": {
    "field": "presentedFrame"
  },
  "CB_ACQUISITION_10": {
    "field": "samples"
  },
  "CB_ACQUISITION_13": {
    "field": "snapshot"
  },
  "CB_ACQUISITION_15": {
    "field": "anchor.elapsedMs"
  },
  "CB_ACQUISITION_16": {
    "field": "anchor.frameSerial"
  },
  "CB_ACQUISITION_17": {
    "field": "terminal.elapsedMs"
  },
  "CB_ACQUISITION_18": {
    "field": "terminal.frameSerial"
  },
  "CB_ACQUISITION_19": {
    "field": "sample"
  },
  "CB_ACQUISITION_20": {
    "field": "sample.elapsedMs"
  },
  "CB_ACQUISITION_21": {
    "field": "sample.frameSerial"
  },
  "CB_ACQUISITION_23": {
    "field": "companionAnchor"
  },
  "CB_ACQUISITION_24": {
    "field": "companionTerminal"
  },
  "CB_READ_ANCHOR_01": {
    "field": "responseSet"
  },
  "CB_READ_ANCHOR_02": {
    "field": "requestIds"
  },
  "CB_READ_ANCHOR_03": {
    "field": "actualResponse"
  },
  "CB_READ_ANCHOR_04": {
    "field": "command"
  },
  "CB_READ_ANCHOR_05": {
    "field": "ok"
  },
  "CB_READ_ANCHOR_06": {
    "field": "scope"
  },
  "CB_READ_ANCHOR_07": {
    "field": "generation"
  },
  "CB_READ_ANCHOR_08": {
    "field": "readAnchor"
  },
  "CB_READ_ANCHOR_09": {
    "field": "header.readRequestId"
  },
  "CB_READ_ANCHOR_10": {
    "field": "previousReadId"
  },
  "CB_READ_ANCHOR_11": {
    "field": "distinctRequestId"
  },
  "CB_READ_ANCHOR_12": {
    "field": "rowCount"
  },
  "CB_READ_ANCHOR_13": {
    "field": "rowCountRange"
  },
  "CB_READ_ANCHOR_14": {
    "field": "elapsedMs"
  },
  "CB_READ_ANCHOR_15": {
    "field": "readKind"
  },
  "CB_READ_ANCHOR_16": {
    "field": "phase"
  },
  "CB_READ_ANCHOR_17": {
    "field": "observedStep"
  },
  "CB_GEOMETRY_01": {
    "field": "visibility"
  },
  "CB_GEOMETRY_03": {
    "field": "dimensions"
  },
  "CB_GEOMETRY_04": {
    "field": "window"
  },
  "CB_GEOMETRY_05": {
    "field": "rectangle"
  },
  "CB_GEOMETRY_06": {
    "field": "fullyVisible"
  },
  "CB_CANDIDATE_ID": {
    "field": "candidateId"
  },
  "CB_MEMORY_ID": {
    "field": "memoryId"
  },
  "CB_REQUEST_ID": {
    "field": "requestId"
  },
  "CB_CONTRAST": {
    "field": "contrast"
  }
};
// Each negative has an accepted pristine baseline, its own clone and a
// declared first rejection. The declaration never comes from a caught error.
const rejects = (id, mutate, expectedReason, expectedContext = {}) => assertRejectedMutation({
  id, makeFixture:fixture, verify:verifyMemoryCandidateBatch, mutate, expectedReason,
  expectedContext:{...fixedRejectionContexts[expectedReason],cycle:2,...(/^(CB_HEADER|CB_ACQUISITION|CB_GEOMETRY)_/.test(expectedReason)?{action:0}:{}),...expectedContext},kind:'value'});
const observed = value => value.reports[1].memoryCandidateBatch.observed;
const mutationValueTags = ['missing','null','false','true','string-zero','enum-name','object','array','negative','out-of-range'];
function rejectsHeader(id, mutate, expectedReason, expectedContext = {}, hidden = false) {
  return assertRejectedMutation({id,kind:'value',expectedReason,expectedContext:{...fixedRejectionContexts[expectedReason],...expectedContext},
    makeFixture:()=>{const value=header('empty-read',1,0);if(hidden){value.tabIndex=1;value.geometry.visible=false;value.geometry.fullyVisible=false;}
      return {value,expected:{pageNumber:1,count:0,visible:!hidden,readRequestId:'empty-read',scope:'persona-2',generation:2}};},
    verify:v=>verifyCandidateHeader(v.value,v.expected), mutate:v=>mutate(v.value)});
}
const headerExpected=(value,visible=true)=>({pageNumber:1,count:100,visible,readRequestId:value.readRequestId,scope:'persona-2',generation:2});
function acquisitionFixture(deadline=10000, companion=null) {
  const value=settledHeader(header(),companion,deadline);
  return {value,expected:headerExpected(value),deadline,companion};
}
function rejectsAcquisition(id, mutate, expectedReason, expectedContext = {}, makeFixture=acquisitionFixture) {
  return assertRejectedMutation({id,kind:'value',expectedReason,expectedContext:{...fixedRejectionContexts[expectedReason],...expectedContext},makeFixture,
    verify:v=>verifyCandidateHeaderAcquisition(v.value,v.expected,v.deadline,v.companion),mutate:v=>mutate(v.value,v)});
}
function rejectsAnchor(id, mutate, expectedReason, expectedContext = {}) {
  return assertRejectedMutation({id,kind:'value',makeFixture:readAnchorFixture,
    verify:v=>verifyCandidateHeaderReadAnchor(v.row,v.receipts,'persona-2',2),mutate,expectedReason,expectedContext:{...fixedRejectionContexts[expectedReason],...expectedContext}});
}

test('accepts the restart-end confirm, cancel and reject evidence', () => {
  const proof = verifyMemoryCandidateBatch(fixture());
  assert.deepEqual([proof.passed, proof.checks, proof.cycle, proof.writeDispatches, proof.statusReadDispatches], [true, 7, 2, 2, 5]);
  assert.equal(proof.memoryIds.length, 3);
});
test('rejects a first-cycle decision that would change the original restart read-back', () => rejects('batch.first-cycle-decision',value => {
  value.reports[0].memoryCandidateBatch = clone(value.reports[1].memoryCandidateBatch);
},'CB_BATCH_02',{cycle:1}));
test('rejects a failed or content-collecting segment', () => {
  rejects('batch.segment-failed',value => { value.reports[1].memoryCandidateBatch.passed = false; },'CB_BATCH_07');
  rejects('batch.segment-content',value => { value.reports[1].memoryCandidateBatch.contentCollected = true; },'CB_BATCH_08');
});
test('rejects a segment at or over its deadline', () => rejects('batch.deadline',value => {
  value.reports[1].memoryCandidateBatch.elapsedMs = 30000;
},'CB_BATCH_10'));
test('rejects missing or reordered completion checks', () => rejects('batch.check-order',value => {
  value.reports[1].memoryCandidateBatch.checks.reverse();
},'CB_BATCH_11'));
test('rejects overlapping confirm and reject targets', () => rejects('batch.overlapping-targets',value => {
  observed(value).rejectTargets[0] = observed(value).confirmTargets[0];
},'CB_UNIQUE_03',{count:5,field:'combinedTargets'}));
test('rejects a decided candidate that is still on the first page', () => rejects('batch.decided-still-pending',value => {
  observed(value).finalCandidateIds[0] = observed(value).rejectTargets[1];
},'CB_BATCH_20'));
test('rejects changed message identities', () => rejects('batch.changed-message-identities',value => {
  observed(value).finalMessageIds = observed(value).finalMessageIds.slice(1).concat('message-new');
},'CB_BATCH_23'));
test('rejects an extra write or status read', () => {
  rejects('batch.extra-write',value => { observed(value).writeDispatchDelta = 3; },'CB_BATCH_24');
  rejects('batch.extra-status-read',value => { observed(value).statusReadDispatchDelta = 6; },'CB_BATCH_24');
  rejects('batch.cancel-write',value => { observed(value).cancelWriteDelta = 1; },'CB_BATCH_24');
});
test('rejects a refresh that reused its candidate read ID', () => rejects('batch.refresh-reused-read',value => {
  observed(value).candidateReads[0].newId = observed(value).candidateReads[0].oldId;
},'CB_BATCH_28'));
test('rejects an input on another control or target', () => {
  rejects('batch.wrong-input-control',value => { value.reports[1].memoryCandidateBatch.inputs[9].control = 'memoryCandidateConfirmSelected'; },'CB_BATCH_32',{step:12});
  rejects('batch.wrong-input-target',value => { value.reports[1].memoryCandidateBatch.inputs[5].id = observed(value).rejectTargets[0]; },'CB_BATCH_31',{step:6});
});
test('rejects a checkbox that did not toggle once', () => rejects('batch.checkbox-no-toggle',value => {
  value.reports[1].memoryCandidateBatch.inputs[5].signals.toggledSignals = 0;
},'CB_BATCH_39',{step:6}));
test('rejects a preview that predicted replacements or conflicts', () => {
  rejects('batch.preview-replacement',value => { observed(value).receipts[1].replace_ids = [observed(value).confirmTargets[0]]; },'CB_PREVIEW_07',{requestId:'preview-0',action:0,phase:'preview'});
  rejects('batch.preview-conflict',value => { observed(value).receipts[1].conflict_groups = [observed(value).confirmTargets.slice(0, 2)]; },'CB_PREVIEW_07',{requestId:'preview-0',action:0,phase:'preview'});
});
test('rejects a cancelled preview reused as the confirmation preview', () => rejects('batch.cancelled-preview-reused',value => {
  observed(value).actions[0].previewRequestId = 'preview-cancelled';
},'CB_BATCH_86'));
test('rejects a status read-back that still shows pending candidates', () => rejects('batch.status-still-pending',value => {
  const fresh = observed(value).receipts.find(r => r.requestId === 'status-0');
  fresh.states[observed(value).confirmTargets[0]] = 'pending';
},'CB_BATCH_67',{action:0}));
test('rejects a confirmation receipt whose memory IDs differ from the read-back', () => rejects('batch.confirmed-memory-id-mismatch',value => {
  observed(value).actions[0].memoryIds[0] = 'fact_other';
},'CB_BATCH_79',{action:0}));
test('rejects a rejection receipt that created memories', () => rejects('batch.rejection-created-memory',value => {
  observed(value).actions[1].memoryIds = ['fact_unexpected'];
},'CB_BATCH_84',{action:1}));
test('rejects a missing receipt for a recorded action', () => {
  // Removing a response first violates the unchanged command-count guard.
  rejects('batch.missing-write-receipt-count',value => {
    observed(value).receipts = observed(value).receipts.filter(r => r.requestId !== 'write-1');
  },'CB_BATCH_50',{command:'memory:candidates:decide_many'});
  // Keep all response prerequisites to target the action/ACK association itself.
  rejects('batch.missing-write-receipt-association',value => {
    observed(value).actions[1].requestId = 'write-with-no-response';
  },'CB_BATCH_60',{action:1});
});
test('rejects unclosed selection or surface', () => {
  rejects('batch.selection-left-open',value => { observed(value).selectionMode = true; },'CB_BATCH_25');
  rejects('batch.surface-left-open',value => { observed(value).surfaceClosed = false; },'CB_BATCH_25');
});
test('rejects feedback or dialog text below the contrast floor', () => {
  rejects('batch.feedback-contrast',value => { observed(value).actions[1].feedbackContrast.contrast = 3; },'CB_CONTRAST',{action:1});
  rejects('batch.dialog-contrast',value => { observed(value)['reject-confirmContrast'][1].contrast = 4.4; },'CB_CONTRAST',{field:'reject-confirmContrast',index:1});
});
test('keeps the registered contract frozen', () => {
  assert(Object.isFrozen(contract));
  assert.deepEqual([contract.cycle, contract.writeDispatches, contract.statusReadDispatches, contract.pendingBefore],
    [2, 2, 5, 128]);
});
test('rejects a missing, duplicated, malformed or incomplete original candidate baseline', () => {
  rejects('baseline.missing',value => { delete value.reports[1].memoryCandidatePage; },'CB_BATCH_04');
  rejects('baseline.duplicate',value => { value.reports[1].memoryCandidatePage.observed.finalCandidateIds[1] = cid(130); },'CB_UNIQUE_03',{count:128,field:'baseline'});
  rejects('baseline.malformed',value => { value.reports[1].memoryCandidatePage.observed.finalCandidateIds[0] = 'invalid-candidate'; },'CB_CANDIDATE_ID',{field:'baseline',index:0});
  rejects('baseline.incomplete',value => { value.reports[1].memoryCandidatePage.observed.finalCandidateIds.pop(); },'CB_UNIQUE_02',{count:128,field:'baseline'});
  rejects('baseline.restart-reordered',value => { value.reports[0].memoryCandidatePage.observed.finalCandidateIds.reverse(); },'CB_BATCH_06');
});
test('rejects a substituted batch baseline or changed initial page', () => {
  rejects('baseline.batch-substituted',value => { observed(value).baselineCandidateIds[0] = cid(999); },'CB_BATCH_13');
  rejects('baseline.initial-reordered',value => { observed(value).initialCandidateIds.reverse(); },'CB_BATCH_14');
});
test('rejects decision targets outside the original identities or their registered order', () => {
  rejects('targets.foreign-confirm',value => { observed(value).confirmTargets[0] = cid(999); },'CB_BATCH_15');
  rejects('targets.reordered-confirm',value => { observed(value).confirmTargets.reverse(); },'CB_BATCH_15');
  rejects('targets.reordered-reject',value => { observed(value).rejectTargets.reverse(); },'CB_BATCH_16');
});
test('rejects substituted, duplicated, malformed or reordered final candidate identities', () => {
  rejects('final.foreign',value => { observed(value).finalCandidateIds[0] = cid(999); },'CB_BATCH_21');
  rejects('final.duplicate',value => { observed(value).finalCandidateIds[1] = observed(value).finalCandidateIds[0]; },'CB_UNIQUE_03',{count:100,field:'finalCandidateIds'});
  rejects('final.malformed',value => { observed(value).finalCandidateIds[0] = 'invalid-candidate'; },'CB_CANDIDATE_ID',{field:'finalCandidateIds',index:0});
  rejects('final.reordered',value => { observed(value).finalCandidateIds.reverse(); },'CB_BATCH_21');
});
test('rejects the former success fixture that restored decided candidates 30 and 29', () => rejects('final.restored-prior-decisions',value => {
  observed(value).finalCandidateIds = Array.from({length: 100}, (_, n) => cid(125 - n));
},'CB_BATCH_21'));
test('rejects a missing actual candidate-list or memory-list response for either action', () => {
  for (const [id,reason,command,action] of [['candidates-0','CB_BATCH_51','memory:candidates:list',0],['candidates-1','CB_BATCH_51','memory:candidates:list',1],
    ['list-0','CB_BATCH_52','memory:list',0],['list-1','CB_BATCH_52','memory:list',1]]) {
    rejects('response.removed.'+id,value => {
      observed(value).receipts = observed(value).receipts.filter(receipt => receipt.requestId !== id);
    },reason,{command});
    rejects('response.unassociated.'+id,value => {
      observed(value).receipts.find(receipt => receipt.requestId === id).requestId = id+'-unrelated';
    },'CB_BATCH_60',{action});
  }
});
test('rejects candidate-list or memory-list read IDs with no actual response', () => {
  for (const key of ['candidateReadId', 'listReadId']) rejects('action.no-response.'+key,value => {
    observed(value).actions[0][key] = 'read-with-no-response';
  },'CB_BATCH_60',{action:0});
});
test('rejects actual list responses with another command, scope, generation or failed status', () => {
  for (const id of ['candidates-0', 'list-0']) {
    for (const [key, offered, reason] of [['command','memory:candidates:status','CB_BATCH_49'],['scope','another-persona','CB_BATCH_46'],
      ['generation',3,'CB_BATCH_45'],['ok',false,'CB_BATCH_47']]) rejects('response.invalid.'+id+'.'+key,value => {
      observed(value).receipts.find(receipt => receipt.requestId === id)[key] = offered;
    },reason,key==='command'?{command:'memory:candidates:status'}:{requestId:id});
  }
  rejects('response.swapped-command-bindings',value=>{
    [observed(value).actions[0].candidateReadId,observed(value).actions[0].listReadId]=
      [observed(value).actions[0].listReadId,observed(value).actions[0].candidateReadId];
  },'CB_BATCH_68',{action:0});
});
test('rejects unbounded, invalid or content-bearing actual list identity summaries', () => {
  for (const id of ['candidates-0', 'list-0']) {
    rejects('list.count.'+id,value => { observed(value).receipts.find(receipt => receipt.requestId === id).pageCount = 101; },'CB_LIST_03',{requestId:id});
    rejects('list.too-many.'+id,value => { observed(value).receipts.find(receipt => receipt.requestId === id).pageIds.push(cid(999)); },'CB_UNIQUE_02',{count:100,field:'pageIds',requestId:id});
    rejects('list.invalid-summary.'+id,value => { observed(value).receipts.find(receipt => receipt.requestId === id).identityValid = false; },'CB_LIST_02',{requestId:id});
    rejects('list.content-field.'+id,value => { observed(value).receipts.find(receipt => receipt.requestId === id).text = 'unregistered content'; },'CB_LIST_01',{requestId:id});
    rejects('list.duplicate.'+id,value => {
      const receipt = observed(value).receipts.find(receipt => receipt.requestId === id);
      receipt.pageIds[1] = receipt.pageIds[0];
    },'CB_UNIQUE_03',{count:100,field:'pageIds',requestId:id});
    rejects('list.malformed.'+id,value => { observed(value).receipts.find(receipt => receipt.requestId === id).pageIds[0] = 'invalid identity!'; },
      id==='candidates-0'?'CB_CANDIDATE_ID':'CB_MEMORY_ID',{field:'pageIds',requestId:id,index:0});
  }
  rejects('list.decided-row',value => { observed(value).receipts.find(receipt => receipt.requestId === 'candidates-0').allPending = false; },'CB_LIST_04',{requestId:'candidates-0'});
});
test('rejects an actual candidate response with another remaining identity sequence', () => rejects('response.candidate-order',value => {
  observed(value).receipts.find(receipt => receipt.requestId === 'candidates-0').pageIds.reverse();
},'CB_BATCH_71',{action:0}));
test('rejects actual memory responses missing ACK identities or changed by rejection', () => {
  rejects('response.memory-unacknowledged',value => {
    observed(value).receipts.find(receipt => receipt.requestId === 'list-0').pageIds[0] = 'fact_unacknowledged';
    observed(value).actions[0].memoryPageIds[0] = 'fact_unacknowledged';
  },'CB_BATCH_80',{action:0});
  rejects('response.reject-memory-order',value => {
    const ids = observed(value).receipts.find(receipt => receipt.requestId === 'list-1').pageIds;
    [ids[98], ids[99]] = [ids[99], ids[98]];
    observed(value).actions[1].memoryPageIds = ids.slice();
  },'CB_BATCH_85',{action:1});
});
test('rejects shown candidate or memory identities that differ from their actual responses', () => {
  rejects('display.candidate-order',value => { observed(value).actions[0].candidatePageIds.reverse(); },'CB_BATCH_72',{action:0});
  rejects('display.memory-order',value => { observed(value).actions[0].memoryPageIds.reverse(); },'CB_BATCH_73',{action:0});
});
test('rejects missing header evidence or a duplicated result-layout check', () => {
  rejects('header.missing',value => { delete observed(value).actions[0].header; },'CB_HEADER_01');
  rejects('header.duplicate-layout-check',value => { value.reports[1].memoryCandidateBatch.checks[3] = value.reports[1].memoryCandidateBatch.checks[2]; },'CB_BATCH_11');
});
test('rejects an incorrect page number, count or text despite textMatches', () => {
  for (const [key,offered,reason] of [['pageNumber',2,'CB_HEADER_06'],['count',99,'CB_HEADER_06'],['textLength',1,'CB_HEADER_12'],['textSha256','0'.repeat(64),'CB_HEADER_14']])
    rejects('header.wrong-text.'+key,value => { observed(value).actions[0].header[key] = offered; },reason);
});
test('rejects a header from an old read, persona or generation', () => {
  for (const [key,offered,reason] of [['readRequestId','candidates-old','CB_HEADER_08'],['scope','other-persona','CB_HEADER_09'],['generation',3,'CB_HEADER_10']])
    rejects('header.old-identity.'+key,value => { observed(value).actions[0].header[key] = offered; },reason);
});
test('rejects clipping at each edge even when fullyVisible is true', () => {
  for (const [key,offered] of [['clipX',101],['clipY',201],['clipWidth',359],['clipHeight',19]])
    rejects('header.clipped-edge.'+key,value => { observed(value).actions[0].header.geometry[key] = offered; },'CB_GEOMETRY_05',{snapshot:'header'});
});
test('rejects text clipped inside an otherwise visible header item', () => {
  rejects('header.text-width',value => { observed(value).actions[0].header.contentWidth = 361; },'CB_HEADER_31');
  rejects('header.text-height',value => { observed(value).actions[0].header.contentHeight = 21; },'CB_HEADER_32');
});
test('rejects missing, duplicate, scrolled, focusable or mouse-handling page text', () => {
  for (const [key,offered,reason] of [['rootObjectName','anotherTasks','CB_HEADER_03'],['objectCount',2,'CB_HEADER_02'],['outsideScroll',false,'CB_HEADER_02'],['activeFocus',true,'CB_HEADER_16'],
    ['activeFocusOnTab',true,'CB_HEADER_16'],['acceptedMouseButtons',1,'CB_HEADER_16'],['frameSerial',0,'CB_HEADER_11'],['scrollFound',false,'CB_HEADER_24'],
    ['inheritsQuickText',false,'CB_HEADER_17'],['className','QQuickTextEdit','CB_HEADER_18'],['textFormat',1,'CB_HEADER_21']])
    rejects('header.passivity.'+key,value => { observed(value).actions[0].header[key] = offered; },reason);
  for (const [key,offered,reason] of [['mouseAreaChildren',1,'CB_HEADER_23'],['pointerHandlerChildren',1,'CB_HEADER_23'],
    ['childScanComplete',false,'CB_HEADER_22'],['childrenInspected',65,'CB_HEADER_22']])
    rejects('header.child-input.'+key,value => { observed(value).actions[0].header.childInputObjects[key] = offered; },reason);
  rejects('header.observation-scrolled',value => { observed(value).actions[0].header.contentYAfter += 1; },'CB_HEADER_26');
});
test('rejects clipped or overlapping first feedback even when its pass flag is true', () => {
  rejects('feedback.clipped',value => { observed(value).actions[0].feedbackGeometry.clipHeight = 1; },'CB_GEOMETRY_05',{snapshot:'companion'});
  // The original composite mutation first disagrees with its stable companion.
  rejects('feedback.overlap-inconsistent-companion',value => { observed(value).actions[0].feedbackGeometry = geometry(195); },'CB_ACQUISITION_11',{field:'sceneY',snapshot:'companionAnchor'});
  rejects('feedback.overlap-complete-companion',value=>{
    const action=observed(value).actions[0];action.feedbackGeometry=geometry(195);
    action.header.settling.companionAnchor=geometry(195);action.header.settling.companionTerminal=geometry(195);
  },'CB_BATCH_70',{action:0});
});
test('accepts exact hidden summary-page and shown empty-live header observations', () => {
  const value = header('empty-read', 1, 0);
  const expected = {pageNumber: 1, count: 0, readRequestId: 'empty-read', scope: 'persona-2', generation: 2};
  verifyCandidateHeader(value, expected);
  value.tabIndex = 1; value.geometry.visible = false; value.geometry.fullyVisible = false;
  verifyCandidateHeader(value, {...expected, visible: false});
});
test('rejects header visibility incompatible with the management page or segment', () => {
  for (const [key,offered] of [['page','settings'],['tabIndex',1],['live',false]])
    rejectsHeader('header.visibility.'+key,value=>{value[key]=offered;},'CB_HEADER_29');
});
test('rejects missing or nonnumeric serialized text-format values', () => {
  for (const [index,offered] of [undefined,null,false,true,'0','PlainText',{},[],-1,17].entries())
    rejects('header.text-format.'+mutationValueTags[index],value => { observed(value).actions[0].header.textFormat = offered; },'CB_HEADER_21');
});
test('rejects missing or invalid enum-property validation despite numeric PlainText', () => {
  for (const [tag,offered] of [['missing',undefined],['null',null],['false',false],['zero',0],['one',1],['string','true']])
    rejects('header.enum-valid.'+tag,value => { observed(value).actions[0].header.textFormatValid = offered; },'CB_HEADER_19');
  rejects('header.enum-property-missing',value => { delete observed(value).actions[0].header.textFormatProperty; },'CB_HEADER_20',{field:'exists'});
  for (const key of ['exists','readable','enumProperty','readSucceeded','enumType','conversionSucceeded','memberValid']) {
    for (const [tag,offered] of [['missing',undefined],['null',null],['false',false],['zero',0],['one',1],['string','true']])
      rejects('header.enum-property.'+key+'.'+tag,value => { observed(value).actions[0].header.textFormatProperty[key] = offered; },'CB_HEADER_20',{field:key});
  }
});
test('rejects mouse-button metadata coercion and every nonzero tested mask', () => {
  for (const [tag,offered] of [['missing',undefined],['null',null],['false',false],['true',true],['string-zero','0'],['one',1],['two',2],['three',3],['negative',-1]])
    rejects('header.mouse-mask.'+tag,value => { observed(value).actions[0].header.acceptedMouseButtons = offered; },'CB_HEADER_16');
});
test('rejects enum or input contract failures even while the header is hidden', () => {
  for (const [key,offered,reason] of [['textFormat','PlainText','CB_HEADER_21'],['textFormatValid',false,'CB_HEADER_19'],['acceptedMouseButtons',1,'CB_HEADER_16']])
    rejectsHeader('header.hidden-contract.'+key,value=>{value[key]=offered;},reason,{},true);
});

test('header acquisition accepts only a stable whole frame in the original read window',()=>{
  const value=settledHeader(header());assert.equal(verifyCandidateHeaderAcquisition(value,headerExpected(value),10000).acquisitionPassed,true);
});
test('header acquisition rejects missing proof expired deadline and no new frame',()=>{
  for(const [id,mutate,reason] of [['missing-proof',h=>{delete h.settling;},'CB_ACQUISITION_02'],['expired',h=>{h.settling.elapsedMs=10000;},'CB_ACQUISITION_08'],
    ['short-stability',h=>{h.settling.stableSinceMs=1;},'CB_ACQUISITION_08'],['no-new-frame',h=>{h.settling.stableFrameSerial=h.settling.frameSerial;},'CB_ACQUISITION_09'],
    ['wrong-deadline',h=>{h.settling.deadlineMs=20000;},'CB_ACQUISITION_04']])
    rejectsAcquisition('acquisition.'+id,mutate,reason);
});
test('header acquisition rejects old identity changed geometry and hidden settling resets',()=>{
  for(const [id,mutate,reason,field,context]of [['old-read',h=>{h.settling.anchor.readRequestId='old-read';},'CB_ACQUISITION_14','readRequestId',{snapshot:'anchor'}],
    ['anchor-moved',h=>{h.settling.anchor.geometry.sceneY++;},'CB_ACQUISITION_11','sceneY',{snapshot:'anchor'}],
    ['terminal-scrolled',h=>{h.settling.terminal.contentYAfter++;},'CB_ACQUISITION_11','contentYAfter',{snapshot:'terminal'}],
    ['sample-tab-changed',h=>{h.settling.samples[0].tabIndex=1;},'CB_ACQUISITION_22','tabIndex',{index:0}]])
    rejectsAcquisition('acquisition.'+id,mutate,reason,{field,...context});
});
test('header acquisition rejects unbounded repeated terminal and recursive snapshots',()=>{
  for(const [id,mutate,reason,context={}]of [['too-many-samples',h=>{h.settling.samples=Array(7).fill(h.settling.anchor);},'CB_ACQUISITION_10'],
    ['repeated-terminal',h=>{h.settling.terminalCount=2;},'CB_ACQUISITION_06'],['recursive-anchor',h=>{h.settling.anchor.settling={ready:true};},'CB_ACQUISITION_13',{snapshot:'anchor'}],
    ['terminal-time-null',h=>{h.settling.terminal.elapsedMs=null;},'CB_ACQUISITION_17']])
    rejectsAcquisition('acquisition.'+id,mutate,reason,context);
});
test('header acquisition keeps the original four second tab return deadline',()=>{
  const value=settledHeader(header(),null,4000);assert.equal(verifyCandidateHeaderAcquisition(value,headerExpected(value),4000).deadlineMs,4000);
  assertRejectedMutation({id:'acquisition.tab-return-deadline',makeFixture:()=>acquisitionFixture(4000),kind:'value',
    verify:v=>verifyCandidateHeaderAcquisition(v.value,v.expected,v.deadline,v.companion),mutate:v=>{v.deadline=10000;},expectedReason:'CB_ACQUISITION_04',expectedContext:{field:'deadlineMs'}});
});
test('header acquisition checks feedback and page together without a scroll workaround',()=>{
  const companion=geometry(160),value=settledHeader(header(),companion);
  assert.equal(verifyCandidateHeaderAcquisition(value,headerExpected(value),10000,companion).acquisitionPassed,true);
  rejectsAcquisition('acquisition.companion-clipped',h=>{h.settling.companionAnchor.sceneY++;},'CB_GEOMETRY_05',{snapshot:'companionAnchor'},()=>acquisitionFixture(10000,geometry(160)));
  rejectsAcquisition('acquisition.companion-moved-intact',h=>{h.settling.companionAnchor.sceneY++;h.settling.companionAnchor.clipY++;},
    'CB_ACQUISITION_11',{field:'sceneY',snapshot:'companionAnchor'},()=>acquisitionFixture(10000,geometry(160)));
});
function readAnchorFixture() {
  const receipt={requestId:'candidate-read-new',command:'memory:candidates:list',scope:'persona-2',generation:2,ok:true,rowCount:100,observedStep:3,elapsedMs:200};
  return {row:{phase:'first-page',pageNumber:1,count:100,readRequestId:receipt.requestId,previousReadId:'candidate-read-old',readKind:'first',
    header:header(receipt.requestId),readAnchor:clone(receipt)},receipts:[receipt]};
}
test('ordinary header binds an independently captured candidate response',()=>{
  const {row,receipts}=readAnchorFixture();assert.equal(verifyCandidateHeaderReadAnchor(row,receipts,'persona-2',2).requestId,'candidate-read-new');
});
test('ordinary header rejects jointly replaced old nested outer and anchor request IDs',()=>{
  rejectsAnchor('read-anchor.joint-stale-id',v=>{v.row.readRequestId=v.row.header.readRequestId=v.row.readAnchor.requestId='candidate-read-stale';},'CB_READ_ANCHOR_03');
});
test('ordinary header rejects missing duplicate or phase foreign response anchors',()=>{
  for(const [id,mutate,reason]of [['missing',v=>{v.receipts=[];},'CB_READ_ANCHOR_01'],['duplicate',v=>{v.receipts.push(clone(v.receipts[0]));},'CB_READ_ANCHOR_02'],
    ['foreign-phase',v=>{v.receipts[0].observedStep=v.row.readAnchor.observedStep=13;},'CB_READ_ANCHOR_17'],['previous-id',v=>{v.row.previousReadId=v.row.readRequestId;},'CB_READ_ANCHOR_11']])
    rejectsAnchor('read-anchor.'+id,mutate,reason);
});
test('ordinary header rejects altered response count scope generation or status',()=>{
  for(const [field,value,reason]of [['rowCount',99,'CB_READ_ANCHOR_12'],['scope','other','CB_READ_ANCHOR_06'],['generation',1,'CB_READ_ANCHOR_07'],['ok',false,'CB_READ_ANCHOR_05'],['command','memory:list','CB_READ_ANCHOR_04']])
    rejectsAnchor('read-anchor.altered.'+field,v=>{v.receipts[0][field]=value;v.row.readAnchor[field]=value;},reason);
});
