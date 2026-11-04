'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {verdictReason} = require('./verdict-test-support.cjs');
const CHECKS = Object.freeze(['candidate-batch-preview-reads-authoritative-counts',
  'candidate-batch-cancel-keeps-selection-with-zero-writes', 'candidate-batch-confirm-ack-and-three-reads',
  'candidate-batch-confirm-page-and-first-feedback-whole-visible', 'candidate-batch-reject-ack-and-three-reads',
  'candidate-batch-reject-page-and-first-feedback-whole-visible', 'candidate-batch-final-pages-and-selection-finished']);
const INPUT_STEPS = Object.freeze([0, 1, 2, 3, 5, 6, 7, 8, 9, 12, 14, 16, 18, 19, 20, 21, 24, 27]);
const CONTROLS = Object.freeze({0: 'nav-memory', 1: 'archive-open-memories', 2: 'memoryTab-memories',
  3: 'memoryCandidateFirst', 5: 'memoryCandidateSelectMode', 6: 'memoryCandidateSelect0', 7: 'memoryCandidateSelect1',
  8: 'memoryCandidateSelect2', 9: 'memoryCandidateConfirmSelected', 12: 'memoryCandidateBatchCancel',
  14: 'memoryCandidateConfirmSelected', 16: 'memoryCandidateBatchConfirm', 18: 'memoryCandidateSelectMode',
  19: 'memoryCandidateSelect0', 20: 'memoryCandidateSelect1', 21: 'memoryCandidateRejectSelected',
  24: 'memoryCandidateBatchConfirm', 27: 'memory-close'});
const MEMORY_CANDIDATE_BATCH_CONTRACT = Object.freeze({schema: 'reverie.p1.memory-candidate-batch.r1.gui-contract.v1',
  cycle: 2, checks: CHECKS, inputSteps: INPUT_STEPS, confirmNumbers: [130, 129, 128], rejectNumbers: [127, 126],
  deadlineMs: 30000, writeDispatches: 2, statusReadDispatches: 5, pendingBefore: 128, firstPage: 100,
  modelHttpRequests: 7, messages: 39});
const candidateId = (value, diagnosticContext = {}) => assert(typeof value === 'string' && /^mc_[a-f0-9]{32}$/.test(value), verdictReason('CB_CANDIDATE_ID', {field:'candidateId', ...diagnosticContext}, 'Missing candidate ID'));
const memoryId = (value, diagnosticContext = {}) => assert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value), verdictReason('CB_MEMORY_ID', {field:'memoryId', ...diagnosticContext}, 'Missing memory ID'));
const requestId = (value, diagnosticContext = {}) => assert(typeof value === 'string' && value.length > 0 && value.length <= 160, verdictReason('CB_REQUEST_ID', {field:'requestId', ...diagnosticContext}, 'Missing request ID'));
const contrast = (value, diagnosticContext = {}) => assert(Number.isFinite(value?.contrast) && value.contrast >= 4.5 && value.pixelCount > 0, verdictReason('CB_CONTRAST', {field:'contrast', ...diagnosticContext}, 'Text contrast below 4.5 or not measured'));
function unique(values, count, check, diagnosticContext = {}) {
  assert(Array.isArray(values), verdictReason('CB_UNIQUE_01', {...diagnosticContext,count}, '')); assert.equal(values.length, count, verdictReason('CB_UNIQUE_02', {...diagnosticContext,count}, '')); values.forEach((value,index) => check(value, {...diagnosticContext,index}));
  assert.equal(new Set(values).size, values.length, verdictReason('CB_UNIQUE_03', {...diagnosticContext,count}, 'Duplicate identity'));
}
function preview(receipt, ids, diagnosticContext = {}) {
  assert.equal(receipt.command, 'memory:candidates:status', verdictReason('CB_PREVIEW_01', {...diagnosticContext,requestId:receipt.requestId}, '')); assert.equal(receipt.ok, true, verdictReason('CB_PREVIEW_02', {...diagnosticContext,requestId:receipt.requestId}, ''));
  assert.deepEqual(receipt.candidate_ids, ids, verdictReason('CB_PREVIEW_03', {...diagnosticContext,requestId:receipt.requestId}, '')); assert.deepEqual(receipt.pending_ids, ids, verdictReason('CB_PREVIEW_04', {...diagnosticContext,requestId:receipt.requestId}, ''));
  assert.deepEqual(receipt.stale_ids, [], verdictReason('CB_PREVIEW_05', {...diagnosticContext,requestId:receipt.requestId}, '')); assert.deepEqual(receipt.new_ids, ids, verdictReason('CB_PREVIEW_06', {...diagnosticContext,requestId:receipt.requestId}, ''));
  assert.deepEqual([receipt.replace_ids, receipt.same_ids, receipt.replaced_pinned_ids, receipt.conflict_groups], [[], [], [], []], verdictReason('CB_PREVIEW_07', {...diagnosticContext,requestId:receipt.requestId}, ''));
  assert.deepEqual(receipt.states, Object.fromEntries(ids.map(id => [id, 'pending'])), verdictReason('CB_PREVIEW_08', {...diagnosticContext,requestId:receipt.requestId}, ''));
}
function identityPage(receipt, candidates, diagnosticContext = {}) {
  assert.deepEqual(Object.keys(receipt).sort(), ['requestId', 'command', 'generation', 'scope', 'ok',
    'pageIds', 'pageCount', 'identityValid', ...(candidates ? ['allPending'] : [])].sort(), verdictReason('CB_LIST_01', {...diagnosticContext,requestId:receipt.requestId}, 'List receipt contains unregistered fields'));
  assert.equal(receipt.identityValid, true, verdictReason('CB_LIST_02', {...diagnosticContext,requestId:receipt.requestId}, 'List response identities were invalid or exceeded the bound'));
  assert.equal(receipt.pageCount, MEMORY_CANDIDATE_BATCH_CONTRACT.firstPage, verdictReason('CB_LIST_03', {...diagnosticContext,requestId:receipt.requestId}, ''));
  unique(receipt.pageIds, MEMORY_CANDIDATE_BATCH_CONTRACT.firstPage, candidates ? candidateId : memoryId, {...diagnosticContext,requestId:receipt.requestId,field:'pageIds'});
  if (candidates) assert.equal(receipt.allPending, true, verdictReason('CB_LIST_04', {...diagnosticContext,requestId:receipt.requestId}, 'Candidate list includes a decided row'));
}
function verifyWholeGeometry(geometry, windowWidth, windowHeight, diagnosticContext = {}) {
  assert(geometry && geometry.found === true && geometry.visible === true, verdictReason('CB_GEOMETRY_01', {...diagnosticContext, field:'visibility'}, 'Visible geometry missing'));
  for (const key of ['sceneX', 'sceneY', 'sceneWidth', 'sceneHeight', 'clipX', 'clipY', 'clipWidth', 'clipHeight'])
    assert(Number.isFinite(geometry[key]) && Math.abs(geometry[key]) <= 100000, verdictReason('CB_GEOMETRY_02', {...diagnosticContext, field:key}, `Invalid geometry ${key}`));
  assert(geometry.sceneWidth > 1 && geometry.sceneHeight > 1 && geometry.clipWidth > 0 && geometry.clipHeight > 0, verdictReason('CB_GEOMETRY_03', {...diagnosticContext, field:'dimensions'}, ''));
  assert(Number.isFinite(windowWidth) && windowWidth > 0 && Number.isFinite(windowHeight) && windowHeight > 0, verdictReason('CB_GEOMETRY_04', {...diagnosticContext, field:'window'}, ''));
  const right = geometry.sceneX + geometry.sceneWidth, bottom = geometry.sceneY + geometry.sceneHeight;
  // Recompute all four edges; a recorded success flag cannot hide clipping.
  assert(geometry.sceneX + .5 >= Math.max(0, geometry.clipX) && geometry.sceneY + .5 >= Math.max(0, geometry.clipY) &&
    right - .5 <= Math.min(windowWidth, geometry.clipX + geometry.clipWidth) &&
    bottom - .5 <= Math.min(windowHeight, geometry.clipY + geometry.clipHeight), verdictReason('CB_GEOMETRY_05', {...diagnosticContext, field:'rectangle'}, 'Text rectangle clipped'));
  assert.equal(geometry.fullyVisible, true, verdictReason('CB_GEOMETRY_06', {...diagnosticContext, field:'fullyVisible'}, ''));
}
function verifyCandidateHeader(header, {pageNumber, count, visible = true, readRequestId, scope, generation}, diagnosticContext = {}) {
  assert(header && header.schema === 'reverie.candidate-header.v1', verdictReason('CB_HEADER_01', {...diagnosticContext, field:'schema'}, 'Candidate header evidence missing'));
  assert.deepEqual([header.objectName, header.objectCount, header.outsideScroll], ['memoryCandidatePageInfo', 1, true], verdictReason('CB_HEADER_02', {...diagnosticContext, field:'objectIdentity'}, ''));
  assert.equal(header.rootObjectName, 'memoryTasks', verdictReason('CB_HEADER_03', {...diagnosticContext, field:'rootObjectName'}, 'Header was measured in another drawer'));
  assert(Number.isSafeInteger(pageNumber) && pageNumber > 0 && pageNumber <= 100000, verdictReason('CB_HEADER_04', {...diagnosticContext, field:'expectedPageNumber'}, ''));
  assert(Number.isSafeInteger(count) && count >= 0 && count <= 100, verdictReason('CB_HEADER_05', {...diagnosticContext, field:'expectedCount'}, ''));
  assert.deepEqual([header.pageNumber, header.count], [pageNumber, count], verdictReason('CB_HEADER_06', {...diagnosticContext, field:'pageNumberAndCount'}, 'Wrong page number or row count'));
  requestId(header.readRequestId, {...diagnosticContext,field:'readRequestId'}); requestId(header.scope, {...diagnosticContext,field:'scope'});
  assert(Number.isSafeInteger(header.generation) && header.generation >= 0, verdictReason('CB_HEADER_07', {...diagnosticContext, field:'generation'}, ''));
  assert.equal(header.readRequestId, readRequestId, verdictReason('CB_HEADER_08', {...diagnosticContext, field:'readRequestId'}, 'Header belongs to an old candidate read'));
  assert.equal(header.scope, scope, verdictReason('CB_HEADER_09', {...diagnosticContext, field:'scope'}, '')); assert.equal(header.generation, generation, verdictReason('CB_HEADER_10', {...diagnosticContext, field:'generation'}, ''));
  assert(Number.isSafeInteger(header.frameSerial) && header.frameSerial > 0, verdictReason('CB_HEADER_11', {...diagnosticContext, field:'frameSerial'}, 'Header frame missing'));
  const expected = `待确认 · 第${pageNumber}批 · 本批${count}条`;
  assert.equal(header.textLength, expected.length, verdictReason('CB_HEADER_12', {...diagnosticContext, field:'textLength'}, '')); assert(header.textLength <= 96, verdictReason('CB_HEADER_13', {...diagnosticContext, field:'textLengthLimit'}, ''));
  assert.equal(header.textSha256, createHash('sha256').update(expected).digest('hex'), verdictReason('CB_HEADER_14', {...diagnosticContext, field:'textSha256'}, 'Header text differs from the current page'));
  assert.equal(header.textMatches, true, verdictReason('CB_HEADER_15', {...diagnosticContext, field:'textMatches'}, ''));
  assert.deepEqual([header.activeFocus, header.activeFocusOnTab, header.acceptedMouseButtons], [false, false, 0], verdictReason('CB_HEADER_16', {...diagnosticContext, field:'passiveInput'}, ''));
  assert.equal(header.inheritsQuickText, true, verdictReason('CB_HEADER_17', {...diagnosticContext, field:'inheritsQuickText'}, ''));
  assert(typeof header.className === 'string' && /^QQuickText(?:_QML(?:TYPE)?_\d+)?$/.test(header.className), verdictReason('CB_HEADER_18', {...diagnosticContext, field:'className'}, ''));
  assert.equal(header.textFormatValid, true, verdictReason('CB_HEADER_19', {...diagnosticContext, field:'textFormatValid'}, 'Page text format was not validated from its enum property'));
  const formatProperty = header.textFormatProperty;
  for (const key of ['exists', 'readable', 'enumProperty', 'readSucceeded', 'enumType', 'conversionSucceeded', 'memberValid'])
    assert.equal(formatProperty?.[key], true, verdictReason('CB_HEADER_20', {...diagnosticContext, field:key}, `Page text enum property failed ${key}`));
  assert.equal(header.textFormat, 0, verdictReason('CB_HEADER_21', {...diagnosticContext, field:'textFormat'}, 'Page line must remain PlainText'));
  const children = header.childInputObjects;
  assert(children?.childScanComplete === true && Number.isInteger(children.childrenInspected) &&
    children.childrenInspected >= 0 && children.childrenInspected <= 64, verdictReason('CB_HEADER_22', {...diagnosticContext, field:'childInputObjects'}, ''));
  assert.deepEqual([children.mouseAreaChildren, children.pointerHandlerChildren], [0, 0], verdictReason('CB_HEADER_23', {...diagnosticContext, field:'childInputHandlers'}, 'Page text has input handlers'));
  assert.equal(header.scrollFound, true, verdictReason('CB_HEADER_24', {...diagnosticContext, field:'scrollFound'}, ''));
  assert(Number.isFinite(header.contentYBefore) && Math.abs(header.contentYBefore) <= 1000000, verdictReason('CB_HEADER_25', {...diagnosticContext, field:'contentYBefore'}, ''));
  assert.equal(header.contentYBefore, header.contentYAfter, verdictReason('CB_HEADER_26', {...diagnosticContext, field:'contentYAfter'}, 'Header observation moved the scroll'));
  assert.equal(typeof header.live, 'boolean', verdictReason('CB_HEADER_27', {...diagnosticContext, field:'live'}, '')); assert.equal(typeof header.busy, 'boolean', verdictReason('CB_HEADER_28', {...diagnosticContext, field:'busy'}, ''));
  const expectedVisible = header.page === 'memory' && header.tabIndex === 0 && (header.live || count > 0 || header.busy);
  assert.equal(expectedVisible, visible, verdictReason('CB_HEADER_29', {...diagnosticContext, field:'visibilityContract'}, 'Header visibility contract differs from the checkpoint'));
  assert.equal(header.geometry?.visible, visible, verdictReason('CB_HEADER_30', {...diagnosticContext, field:'geometry.visible'}, ''));
  if (visible) {
    verifyWholeGeometry(header.geometry, header.windowWidth, header.windowHeight, {...diagnosticContext,snapshot:'header'});
    assert(Number.isFinite(header.contentWidth) && header.contentWidth >= 0 &&
      header.contentWidth <= header.geometry.sceneWidth + .5, verdictReason('CB_HEADER_31', {...diagnosticContext, field:'contentWidth'}, 'Header text width is clipped'));
    assert(Number.isFinite(header.contentHeight) && header.contentHeight > 0 &&
      header.contentHeight <= header.geometry.sceneHeight + .5, verdictReason('CB_HEADER_32', {...diagnosticContext, field:'contentHeight'}, 'Header text height is clipped'));
  }
  return {pageNumber, count, visible, readRequestId};
}
function verifyCandidateHeaderAcquisition(header, expected, deadlineMs, companion = null, diagnosticContext = {}) {
  const proof=verifyCandidateHeader(header,expected,diagnosticContext), settling=header.settling;
  assert([4000,10000].includes(deadlineMs), verdictReason('CB_ACQUISITION_01', {...diagnosticContext, field:'deadlineMs'}, 'Unregistered header acquisition deadline'));
  assert(settling && settling.ready===true && settling.expired===false && settling.failed===false, verdictReason('CB_ACQUISITION_02', {...diagnosticContext, field:'settling'}, ''));
  assert.equal(settling.minimumStableMs, 40, verdictReason('CB_ACQUISITION_03', {...diagnosticContext, field:'minimumStableMs'}, '')); assert.equal(settling.deadlineMs, deadlineMs, verdictReason('CB_ACQUISITION_04', {...diagnosticContext, field:'deadlineMs'}, ''));
  assert.equal(settling.sampleLimit, 6, verdictReason('CB_ACQUISITION_05', {...diagnosticContext, field:'sampleLimit'}, '')); assert.equal(settling.terminalCount, 1, verdictReason('CB_ACQUISITION_06', {...diagnosticContext, field:'terminalCount'}, ''));
  for(const key of ['elapsedMs','stableSinceMs','frameSerial','stableFrameSerial','polls'])
    assert(Number.isSafeInteger(settling[key]) && settling[key]>=0, verdictReason('CB_ACQUISITION_07', {...diagnosticContext, field:key}, 'Missing numeric header acquisition '+key));
  assert(settling.polls>=2 && settling.elapsedMs<deadlineMs && settling.elapsedMs-settling.stableSinceMs>=40, verdictReason('CB_ACQUISITION_08', {...diagnosticContext, field:'stabilityWindow'}, ''));
  assert(settling.frameSerial>settling.stableFrameSerial && header.frameSerial>=settling.frameSerial, verdictReason('CB_ACQUISITION_09', {...diagnosticContext, field:'presentedFrame'}, ''));
  assert(Array.isArray(settling.samples) && settling.samples.length>0 && settling.samples.length<=6 && settling.samples.length<=settling.polls, verdictReason('CB_ACQUISITION_10', {...diagnosticContext, field:'samples'}, ''));
  const semantic=['schema','rootObjectName','objectName','page','tabIndex','pageNumber','count','readRequestId','scope','generation',
    'textLength','textSha256','live','busy','objectCount','outsideScroll','activeFocus','activeFocusOnTab','acceptedMouseButtons',
    'inheritsQuickText','textFormat','textFormatValid'];
  const close=(a,b,keys,snapshot)=>{for(const key of keys)assert(Number.isFinite(a?.[key]) && Number.isFinite(b?.[key]) && Math.abs(a[key]-b[key])<=.5, verdictReason('CB_ACQUISITION_11', {...diagnosticContext, field:key, snapshot}, 'Header acquisition geometry changed: '+key));};
  const geometryKeys=['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'];
  const sameGeometry=(a,b,snapshot)=>{for(const key of ['found','visible','fullyVisible'])assert.equal(a?.[key], b?.[key], verdictReason('CB_ACQUISITION_12', {...diagnosticContext, field:key, snapshot}, ''));close(a,b,geometryKeys,snapshot);};
  const near=(value,snapshot)=>{
    assert(value && typeof value==='object' && !Array.isArray(value) && !('settling' in value), verdictReason('CB_ACQUISITION_13', {...diagnosticContext, field:'snapshot', snapshot}, 'Header acquisition snapshot missing or recursive'));
    for(const key of semantic)assert.deepEqual(value[key], header[key], verdictReason('CB_ACQUISITION_14', {...diagnosticContext, field:key, snapshot}, 'Header acquisition identity changed: '+key));
    sameGeometry(value.geometry,header.geometry,snapshot);
    close(value,header,['contentWidth','contentHeight','contentYBefore','contentYAfter','windowWidth','windowHeight'],snapshot);
  };
  near(settling.anchor,'anchor');near(settling.terminal,'terminal');
  assert.equal(settling.anchor.elapsedMs, settling.stableSinceMs, verdictReason('CB_ACQUISITION_15', {...diagnosticContext, field:'anchor.elapsedMs'}, ''));assert.equal(settling.anchor.frameSerial, settling.stableFrameSerial, verdictReason('CB_ACQUISITION_16', {...diagnosticContext, field:'anchor.frameSerial'}, ''));
  assert.equal(settling.terminal.elapsedMs, settling.elapsedMs, verdictReason('CB_ACQUISITION_17', {...diagnosticContext, field:'terminal.elapsedMs'}, ''));assert.equal(settling.terminal.frameSerial, settling.frameSerial, verdictReason('CB_ACQUISITION_18', {...diagnosticContext, field:'terminal.frameSerial'}, ''));
  let lastElapsed=-1,lastFrame=-1;
  for(const [sampleIndex,sample] of settling.samples.entries()) {
    assert(sample && !('settling' in sample), verdictReason('CB_ACQUISITION_19', {...diagnosticContext, field:'sample', index:sampleIndex}, ''));
    assert(Number.isSafeInteger(sample.elapsedMs) && sample.elapsedMs>=lastElapsed && sample.elapsedMs<=settling.elapsedMs, verdictReason('CB_ACQUISITION_20', {...diagnosticContext, field:'sample.elapsedMs', index:sampleIndex}, ''));
    assert(Number.isSafeInteger(sample.frameSerial) && sample.frameSerial>=lastFrame && sample.frameSerial<=settling.frameSerial, verdictReason('CB_ACQUISITION_21', {...diagnosticContext, field:'sample.frameSerial', index:sampleIndex}, ''));
    for(const key of ['rootObjectName','objectName','page','tabIndex','pageNumber','count','readRequestId','scope','generation'])
      assert.deepEqual(sample[key], header[key], verdictReason('CB_ACQUISITION_22', {...diagnosticContext, field:key, index:sampleIndex}, 'Header acquisition sample binding changed: '+key));
    lastElapsed=sample.elapsedMs;lastFrame=sample.frameSerial;
  }
  if(companion) {
    verifyWholeGeometry(companion,header.windowWidth,header.windowHeight,{...diagnosticContext,snapshot:'companion'});
    verifyWholeGeometry(settling.companionAnchor,header.windowWidth,header.windowHeight,{...diagnosticContext,snapshot:'companionAnchor'});
    verifyWholeGeometry(settling.companionTerminal,header.windowWidth,header.windowHeight,{...diagnosticContext,snapshot:'companionTerminal'});
    sameGeometry(settling.companionAnchor,companion,'companionAnchor');sameGeometry(settling.companionTerminal,companion,'companionTerminal');
  } else {
    assert.deepEqual(settling.companionAnchor, {}, verdictReason('CB_ACQUISITION_23', {...diagnosticContext, field:'companionAnchor'}, ''));assert.deepEqual(settling.companionTerminal, {}, verdictReason('CB_ACQUISITION_24', {...diagnosticContext, field:'companionTerminal'}, ''));
  }
  return {...proof,acquisitionPassed:true,deadlineMs,minimumStableMs:40};
}
function verifyCandidateHeaderReadAnchor(row, receipts, expectedScope, expectedGeneration) {
  assert(row && Array.isArray(receipts) && receipts.length>0 && receipts.length<=24, verdictReason('CB_READ_ANCHOR_01', {field:'responseSet'}, 'Candidate header response anchors missing'));
  const ids=receipts.map(r=>r.requestId);ids.forEach((id,index)=>requestId(id,{field:'receipts.requestId',index}));assert.equal(new Set(ids).size, ids.length, verdictReason('CB_READ_ANCHOR_02', {field:'requestIds'}, 'Repeated candidate read anchor'));
  const anchor=receipts.find(r=>r.requestId===row.readRequestId);
  assert(anchor, verdictReason('CB_READ_ANCHOR_03', {field:'actualResponse'}, 'Candidate header has no actual read response'));
  assert.equal(anchor.command, 'memory:candidates:list', verdictReason('CB_READ_ANCHOR_04', {field:'command'}, ''));assert.equal(anchor.ok, true, verdictReason('CB_READ_ANCHOR_05', {field:'ok'}, ''));
  assert.equal(anchor.scope, expectedScope, verdictReason('CB_READ_ANCHOR_06', {field:'scope'}, ''));assert.equal(anchor.generation, expectedGeneration, verdictReason('CB_READ_ANCHOR_07', {field:'generation'}, ''));
  assert.deepEqual(row.readAnchor, anchor, verdictReason('CB_READ_ANCHOR_08', {field:'readAnchor'}, 'Header anchor differs from independently captured response'));
  assert.equal(row.header.readRequestId, anchor.requestId, verdictReason('CB_READ_ANCHOR_09', {field:'header.readRequestId'}, ''));
  assert(typeof row.previousReadId==='string' && row.previousReadId.length<=160, verdictReason('CB_READ_ANCHOR_10', {field:'previousReadId'}, '')); assert.notEqual(anchor.requestId, row.previousReadId, verdictReason('CB_READ_ANCHOR_11', {field:'distinctRequestId'}, 'Candidate header reused the previous read'));
  assert.equal(anchor.rowCount, row.count, verdictReason('CB_READ_ANCHOR_12', {field:'rowCount'}, ''));assert(Number.isInteger(anchor.rowCount) && anchor.rowCount>=0 && anchor.rowCount<=100, verdictReason('CB_READ_ANCHOR_13', {field:'rowCountRange'}, ''));
  assert(Number.isSafeInteger(anchor.elapsedMs) && anchor.elapsedMs>=0, verdictReason('CB_READ_ANCHOR_14', {field:'elapsedMs'}, ''));
  assert(['first','next','reread'].includes(row.readKind), verdictReason('CB_READ_ANCHOR_15', {field:'readKind'}, ''));
  assert(['first-page','after-reject'].includes(row.phase), verdictReason('CB_READ_ANCHOR_16', {field:'phase'}, ''));
  assert((row.phase==='first-page'?[2,3]:[13,14]).includes(anchor.observedStep), verdictReason('CB_READ_ANCHOR_17', {field:'observedStep'}, 'Candidate header response belongs to another input phase'));
  return {requestId:anchor.requestId,scope:anchor.scope,generation:anchor.generation};
}
function verifyMemoryCandidateBatch({reports}) {
  assert(Array.isArray(reports) && reports.length === 2, verdictReason('CB_BATCH_01', {cycle:2}, ''));
  assert(!reports[0].memoryCandidateBatch, verdictReason('CB_BATCH_02', {cycle:1}, 'The first cycle must not decide candidates'));
  const segment = reports[1].memoryCandidateBatch, o = segment?.observed;
  assert(segment && o, verdictReason('CB_BATCH_03', {cycle:2}, 'Candidate batch segment missing'));
  const original = reports[1].memoryCandidatePage;
  assert(original?.passed === true && original.contentCollected === false, verdictReason('CB_BATCH_04', {cycle:2}, 'Original restart candidate check missing'));
  const baseline = original.observed?.finalCandidateIds;
  unique(baseline, MEMORY_CANDIDATE_BATCH_CONTRACT.pendingBefore, candidateId, {cycle:2,field:'baseline'});
  assert.equal(original.observed.finalCandidateCount, MEMORY_CANDIDATE_BATCH_CONTRACT.pendingBefore, verdictReason('CB_BATCH_05', {cycle:2}, ''));
  assert.deepEqual(baseline, reports[0].memoryCandidatePage?.observed?.finalCandidateIds, verdictReason('CB_BATCH_06', {cycle:2}, 'Original candidate identities differ across restart'));
  assert.equal(segment.passed, true, verdictReason('CB_BATCH_07', {cycle:2}, '')); assert.equal(segment.contentCollected, false, verdictReason('CB_BATCH_08', {cycle:2}, ''));
  assert.equal(segment.deadlineMs, MEMORY_CANDIDATE_BATCH_CONTRACT.deadlineMs, verdictReason('CB_BATCH_09', {cycle:2}, ''));
  assert(Number.isSafeInteger(segment.elapsedMs) && segment.elapsedMs >= 0 && segment.elapsedMs < segment.deadlineMs, verdictReason('CB_BATCH_10', {cycle:2}, ''));
  assert.deepEqual(segment.checks.map(c => c.name), CHECKS, verdictReason('CB_BATCH_11', {cycle:2}, '')); assert(segment.checks.every(c => c.passed === true), verdictReason('CB_BATCH_12', {cycle:2}, ''));
  unique(o.confirmTargets, 3, candidateId, {cycle:2,field:'confirmTargets'}); unique(o.rejectTargets, 2, candidateId, {cycle:2,field:'rejectTargets'});
  unique([...o.confirmTargets, ...o.rejectTargets], 5, candidateId, {cycle:2,field:'combinedTargets'});
  assert.deepEqual(o.baselineCandidateIds, baseline, verdictReason('CB_BATCH_13', {cycle:2}, 'Batch did not use the original 128-candidate baseline'));
  unique(o.initialCandidateIds, 100, candidateId, {cycle:2,field:'initialCandidateIds'});
  assert.deepEqual(o.initialCandidateIds, baseline.slice(0, 100), verdictReason('CB_BATCH_14', {cycle:2}, 'Batch initial page changed candidate identities or order'));
  assert.deepEqual(o.confirmTargets, baseline.slice(0, 3), verdictReason('CB_BATCH_15', {cycle:2}, 'Confirmation targets are not the registered first three candidates'));
  assert.deepEqual(o.rejectTargets, baseline.slice(3, 5), verdictReason('CB_BATCH_16', {cycle:2}, 'Rejection targets are not the registered next two candidates'));
  const expectedPage = ids => baseline.filter(id => !ids.includes(id)).slice(0, 100);
  assert.equal(o.initialPendingCount, 100, verdictReason('CB_BATCH_17', {cycle:2}, '')); assert.equal(o.finalCandidateCount, 100, verdictReason('CB_BATCH_18', {cycle:2}, '')); assert.equal(o.finalPageMatches, true, verdictReason('CB_BATCH_19', {cycle:2}, ''));
  unique(o.finalCandidateIds, 100, candidateId, {cycle:2,field:'finalCandidateIds'});
  assert(![...o.confirmTargets, ...o.rejectTargets].some(id => o.finalCandidateIds.includes(id)), verdictReason('CB_BATCH_20', {cycle:2}, 'A decided candidate is still pending'));
  assert.deepEqual(o.finalCandidateIds, expectedPage([...o.confirmTargets, ...o.rejectTargets]), verdictReason('CB_BATCH_21', {cycle:2}, 'Final candidate identities or order differ from the original baseline minus five decisions'));
  const messages = reports[1].messages.map(v => v.id); unique(messages, 39, requestId, {cycle:2,field:'messages'});
  assert.deepEqual(o.beforeMessageIds, messages, verdictReason('CB_BATCH_22', {cycle:2}, '')); assert.deepEqual(o.finalMessageIds, messages, verdictReason('CB_BATCH_23', {cycle:2}, ''));
  assert.deepEqual([o.writeDispatchDelta, o.statusReadDispatchDelta, o.cancelWriteDelta], [2, 5, 0], verdictReason('CB_BATCH_24', {cycle:2}, ''));
  assert.deepEqual([o.selectionEmpty, o.selectionMode, o.terminalStatus, o.surfaceClosed], [true, false, 'success', true], verdictReason('CB_BATCH_25', {cycle:2}, ''));
  requestId(o.scope); assert(Number.isSafeInteger(o.generation) && o.generation >= 0, verdictReason('CB_BATCH_26', {cycle:2}, ''));
  assert(Array.isArray(o.candidateReads) && o.candidateReads.length === 1, verdictReason('CB_BATCH_27', {cycle:2}, ''));
  for (const read of o.candidateReads) {
    requestId(read.newId); assert.notEqual(read.newId, read.oldId, verdictReason('CB_BATCH_28', {cycle:2}, 'Refresh reused a candidate read ID'));
  }
  assert(Array.isArray(segment.inputs), verdictReason('CB_BATCH_29', {cycle:2}, ''));
  assert.deepEqual(segment.inputs.map(v => v.step), INPUT_STEPS, verdictReason('CB_BATCH_30', {cycle:2}, ''));
  for (const input of segment.inputs) {
    const target = [6, 7, 8].includes(input.step) ? o.confirmTargets[input.step - 6]
      : [19, 20].includes(input.step) ? o.rejectTargets[input.step - 19] : '';
    assert.equal(input.id, target, verdictReason('CB_BATCH_31', {cycle:2,step:input.step}, 'Input target is not the registered step target'));
    assert.equal(input.control, CONTROLS[input.step], verdictReason('CB_BATCH_32', {cycle:2,step:input.step}, 'Input control is not the registered step control'));
    assert.equal(input.signals?.observerValid, true, verdictReason('CB_BATCH_33', {cycle:2,step:input.step}, ''));
    assert.deepEqual([input.signals.mouseDispatchCount, input.signals.contractReason], [1, ''], verdictReason('CB_BATCH_34', {cycle:2,step:input.step}, ''));
    assert(input.layout?.ready === true && input.layout.minimumStableMs === 40 && input.layout.last?.layoutStable === true, verdictReason('CB_BATCH_35', {cycle:2,step:input.step}, ''));
    assert.equal(input.layout.last?.fullyVisible, true, verdictReason('CB_BATCH_36', {cycle:2,step:input.step}, ''));
    assert(['target', 'descendant'].includes(input.hit?.hitResult) && input.hit.acceptorFound === true, verdictReason('CB_BATCH_37', {cycle:2,step:input.step}, ''));
    if (input.id) {
      assert.equal(input.signals.controlKind, 'switch', verdictReason('CB_BATCH_38', {cycle:2,step:input.step}, '')); assert.equal(input.signals.toggledSignals, 1, verdictReason('CB_BATCH_39', {cycle:2,step:input.step}, ''));
      assert([0, 1].includes(input.signals.clickedSignals), verdictReason('CB_BATCH_40', {cycle:2,step:input.step}, ''));
    } else {
      assert.equal(input.signals.controlKind, input.control === 'memoryTab-memories' ? 'tab' : 'button', verdictReason('CB_BATCH_41', {cycle:2,step:input.step}, ''));
      assert.equal(input.signals.clickedSignals, 1, verdictReason('CB_BATCH_42', {cycle:2,step:input.step}, ''));
    }
  }
  assert(Array.isArray(o.receipts) && o.receipts.length <= 16, verdictReason('CB_BATCH_43', {cycle:2}, ''));
  const byId = new Map();
  for (const r of o.receipts) {
    requestId(r.requestId); assert(!byId.has(r.requestId), verdictReason('CB_BATCH_44', {cycle:2,requestId:r.requestId}, 'Repeated receipt')); byId.set(r.requestId, r);
    assert.equal(r.generation, o.generation, verdictReason('CB_BATCH_45', {cycle:2,requestId:r.requestId}, '')); assert.equal(r.scope, o.scope, verdictReason('CB_BATCH_46', {cycle:2,requestId:r.requestId}, '')); assert.equal(r.ok, true, verdictReason('CB_BATCH_47', {cycle:2,requestId:r.requestId}, ''));
    assert(['memory:candidates:status', 'memory:candidates:decide_many', 'memory:candidates:list', 'memory:list'].includes(r.command), verdictReason('CB_BATCH_48', {cycle:2,requestId:r.requestId}, ''));
    if (r.command === 'memory:candidates:list' || r.command === 'memory:list')
      identityPage(r, r.command === 'memory:candidates:list', {cycle:2});
  }
  assert.equal(o.receipts.filter(r => r.command === 'memory:candidates:status').length, 5, verdictReason('CB_BATCH_49', {cycle:2,command:'memory:candidates:status'}, ''));
  assert.equal(o.receipts.filter(r => r.command === 'memory:candidates:decide_many').length, 2, verdictReason('CB_BATCH_50', {cycle:2,command:'memory:candidates:decide_many'}, ''));
  assert.equal(o.receipts.filter(r => r.command === 'memory:candidates:list').length, 2, verdictReason('CB_BATCH_51', {cycle:2,command:'memory:candidates:list'}, ''));
  assert.equal(o.receipts.filter(r => r.command === 'memory:list').length, 2, verdictReason('CB_BATCH_52', {cycle:2,command:'memory:list'}, ''));
  assert.equal(o.receipts.length, 11, verdictReason('CB_BATCH_53', {cycle:2}, 'Actual batch response count changed'));
  const initial = byId.get(o.initialPreviewId); assert(initial, verdictReason('CB_BATCH_54', {cycle:2}, 'Cancelled preview missing')); preview(initial, o.confirmTargets, {cycle:2,phase:'cancelled-preview'});
  assert(Array.isArray(o.actions) && o.actions.length === 2, verdictReason('CB_BATCH_55', {cycle:2}, ''));
  const allIds = [o.initialPreviewId, o.candidateReads[0].newId];
  let confirmedPage;
  for (const [index, action] of o.actions.entries()) {
    const confirm = index === 0, ids = confirm ? o.confirmTargets : o.rejectTargets;
    assert.deepEqual(action.ids, ids, verdictReason('CB_BATCH_56', {cycle:2,action:index}, '')); assert.equal(action.confirm, confirm, verdictReason('CB_BATCH_57', {cycle:2,action:index}, '')); assert.equal(action.status, 'success', verdictReason('CB_BATCH_58', {cycle:2,action:index}, ''));
    assert.equal(action.feedbackWholeVisible, true, verdictReason('CB_BATCH_59', {cycle:2,action:index}, '')); contrast(action.feedbackContrast, {cycle:2,action:index});
    const keys = [action.previewRequestId, action.requestId, action.statusReadId, action.candidateReadId, action.listReadId];
    unique(keys, 5, requestId, {cycle:2,action:index,field:'actionRequestIds'}); allIds.push(...keys);
    const [previewReceipt, ack, state, candidates, list] = keys.map(v => byId.get(v));
    assert(previewReceipt && ack && state && candidates && list, verdictReason('CB_BATCH_60', {cycle:2,action:index}, 'ACK/three-read proof incomplete'));
    preview(previewReceipt, ids, {cycle:2,action:index,phase:'preview'});
    assert.equal(ack.command, 'memory:candidates:decide_many', verdictReason('CB_BATCH_61', {cycle:2,action:index}, '')); assert.deepEqual(ack.candidate_ids, ids, verdictReason('CB_BATCH_62', {cycle:2,action:index}, ''));
    assert.equal(ack.decision, confirm ? 'confirm' : 'reject', verdictReason('CB_BATCH_63', {cycle:2,action:index}, ''));
    assert.equal(state.command, 'memory:candidates:status', verdictReason('CB_BATCH_64', {cycle:2,action:index}, '')); assert.deepEqual(state.candidate_ids, ids, verdictReason('CB_BATCH_65', {cycle:2,action:index}, ''));
    assert.deepEqual([state.pending_ids, state.stale_ids], [[], ids], verdictReason('CB_BATCH_66', {cycle:2,action:index}, ''));
    assert.deepEqual(state.states, Object.fromEntries(ids.map(id => [id, confirm ? 'confirmed' : 'rejected'])), verdictReason('CB_BATCH_67', {cycle:2,action:index}, ''));
    assert.equal(candidates.command, 'memory:candidates:list', verdictReason('CB_BATCH_68', {cycle:2,action:index}, '')); assert.equal(list.command, 'memory:list', verdictReason('CB_BATCH_69', {cycle:2,action:index}, ''));
    verifyCandidateHeaderAcquisition(action.header, {pageNumber: 1, count: 100, visible: true,
      readRequestId: action.candidateReadId, scope: o.scope, generation: o.generation},10000,action.feedbackGeometry,{cycle:2,action:index});
    verifyWholeGeometry(action.feedbackGeometry, action.header.windowWidth, action.header.windowHeight, {cycle:2,action:index,snapshot:'feedback'});
    assert(action.feedbackGeometry.sceneY + action.feedbackGeometry.sceneHeight <= action.header.geometry.sceneY + .5, verdictReason('CB_BATCH_70', {cycle:2,action:index}, 'Page line overlaps the first feedback'));
    const decided = confirm ? o.confirmTargets : [...o.confirmTargets, ...o.rejectTargets];
    assert.deepEqual(candidates.pageIds, expectedPage(decided), verdictReason('CB_BATCH_71', {cycle:2,action:index}, 'Actual candidate response changed the remaining identities or order'));
    assert.deepEqual(action.candidatePageIds, candidates.pageIds, verdictReason('CB_BATCH_72', {cycle:2,action:index}, 'Shown candidates differ from the actual response'));
    assert.deepEqual(action.memoryPageIds, list.pageIds, verdictReason('CB_BATCH_73', {cycle:2,action:index}, 'Shown memories differ from the actual response'));
    if (confirm) {
      assert.deepEqual(ack.new_ids, ids, verdictReason('CB_BATCH_74', {cycle:2,action:index}, '')); assert.deepEqual([ack.replace_ids, ack.same_ids], [[], []], verdictReason('CB_BATCH_75', {cycle:2,action:index}, ''));
      assert(Array.isArray(ack.confirmed) && ack.confirmed.length === 3, verdictReason('CB_BATCH_76', {cycle:2,action:index}, ''));
      assert.deepEqual(ack.confirmed.map(entry => entry.candidate_id), ids, verdictReason('CB_BATCH_77', {cycle:2,action:index}, ''));
      assert(ack.confirmed.every(entry => entry.idempotent === false && entry.replaced_memory_id === ''), verdictReason('CB_BATCH_78', {cycle:2,action:index}, ''));
      unique(action.memoryIds, 3, memoryId, {cycle:2,action:index,field:'memoryIds'});
      assert.deepEqual(ack.confirmed.map(entry => entry.memory_id), action.memoryIds, verdictReason('CB_BATCH_79', {cycle:2,action:index}, ''));
      assert.deepEqual([...list.pageIds.slice(0, 3)].sort(), [...action.memoryIds].sort(), verdictReason('CB_BATCH_80', {cycle:2,action:index}, 'Actual memory list did not read back the three ACK identities'));
      confirmedPage = list.pageIds;
      assert(!('rejected_ids' in ack), verdictReason('CB_BATCH_81', {cycle:2,action:index}, ''));
    } else {
      assert.deepEqual(ack.rejected_ids, ids, verdictReason('CB_BATCH_82', {cycle:2,action:index}, '')); assert(!('confirmed' in ack), verdictReason('CB_BATCH_83', {cycle:2,action:index}, '')); assert.deepEqual(action.memoryIds, [], verdictReason('CB_BATCH_84', {cycle:2,action:index}, ''));
      assert.deepEqual(list.pageIds, confirmedPage, verdictReason('CB_BATCH_85', {cycle:2,action:index}, 'Rejecting candidates changed memory identities or order'));
    }
  }
  assert.equal(new Set(allIds).size, allIds.length, verdictReason('CB_BATCH_86', {cycle:2}, 'A preview, write or read reused a request ID'));
  for (const key of ['confirmContrast', 'reject-confirmContrast']) {
    assert.equal(o[key]?.length, 2, verdictReason('CB_BATCH_87', {cycle:2,field:key}, '')); o[key].forEach((value,index) => contrast(value, {cycle:2,field:key,index}));
  }
  return {passed: true, checks: 7, cycle: 2, confirmTargets: o.confirmTargets, rejectTargets: o.rejectTargets,
    memoryIds: o.actions[0].memoryIds, writeDispatches: 2, statusReadDispatches: 5, preservedMessageIds: 39};
}
module.exports = {MEMORY_CANDIDATE_BATCH_CONTRACT, verifyMemoryCandidateBatch, verifyCandidateHeader, verifyCandidateHeaderAcquisition, verifyCandidateHeaderReadAnchor};
