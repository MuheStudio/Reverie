'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { verdictReason } = require('./verdict-test-support.cjs');
const ARCHIVE_CONTROL_READINESS_CONTRACT = require('./tests/archive-control-readiness-contract.json');
const C = ARCHIVE_CONTROL_READINESS_CONTRACT;
const groups = ['interaction', 'moonroom', 'archiveInteraction'];
const rectKeys = ['X', 'Y', 'Width', 'Height'];
function guard(value, reason, context) { assert(value, verdictReason(reason, context)); }
function equal(actual, expected, reason, context) { assert.deepEqual(actual, expected, verdictReason(reason, context)); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function rectangle(sample, prefix, context) {
  const values = rectKeys.map(key => sample[prefix + key]);
  guard(values.every(finite) && values[2] > 1 && values[3] > 1, 'ARCHIVE_GEOMETRY', {...context, field: prefix});
  return values;
}
function contains(outer, inner, inset = 0) {
  return inner[0] + inset >= outer[0] - 0.001 && inner[1] + inset >= outer[1] - 0.001 &&
    inner[0] + inner[2] - inset <= outer[0] + outer[2] + 0.001 &&
    inner[1] + inner[3] - inset <= outer[1] + outer[3] + 0.001;
}
function pointInside(rect, x, y) { return x >= rect[0] && y >= rect[1] && x <= rect[0]+rect[2] && y <= rect[1]+rect[3]; }
function scroll(value, required, context) {
  guard(object(value) && typeof value.found === 'boolean', 'ARCHIVE_SCROLL', context);
  if (!required && !value.found) return;
  guard(value.found === true && value.valid === true &&
    ['y','minimumY','maximumY','height','contentHeight'].every(key => finite(value[key])) &&
    value.height > 0 && value.contentHeight >= 0 && value.maximumY >= value.minimumY &&
    value.y >= value.minimumY - 0.5 && value.y <= value.maximumY + 0.5,
  'ARCHIVE_SCROLL', context);
}
function contextIdentity(value, context) {
  guard(object(value), 'ARCHIVE_CONTEXT', context);
  for (const key of ['scope','bookId','entryId'])
    guard(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 1024,
      'ARCHIVE_CONTEXT', {...context, field:key});
  for (const key of ['generation','revision']) guard(integer(value[key]), 'ARCHIVE_CONTEXT', {...context, field:key});
}
function stableSignature(value) {
  const result = {};
  for (const prefix of ['target','viewport','clip','targetClip']) for (const key of rectKeys) result[prefix+key] = value[prefix+key];
  for (const key of ['windowWidth','windowHeight','startX','startY','endX','endY','inner','outer','visible','enabled','wholeViewport','pointsInsideClip','hitTarget',
    'identityMatched','contextMatched','contextBound','uniqueTarget']) result[key] = value[key];
  return result;
}
function action(record, spec, context) {
  guard(object(record), 'ARCHIVE_ACTION', context);
  equal([record.id,record.step,record.control], [spec.id,spec.step,spec.control], 'ARCHIVE_ACTION_IDENTITY', context);
  const gate = spec.shape === 'flat' ? record : record.gate;
  guard(object(gate), 'ARCHIVE_GATE', context);
  equal([gate.schema,gate.control,gate.region,gate.deadlineMs,gate.sampleLimit],
    [C.evidenceSchema,spec.control,spec.region,spec.deadlineMs,C.sampleLimit], 'ARCHIVE_GATE_CONTRACT', context);
  guard(gate.performed === true && gate.failed === false && gate.expired === false && gate.attemptCount === 1,
    'ARCHIVE_DISPATCH', context);
  guard(integer(gate.polls) && gate.polls >= 2 && Array.isArray(gate.samples) && gate.samples.length >= 2 && gate.samples.length <= C.sampleLimit,
    'ARCHIVE_SAMPLES', context);
  const last = gate.last, baseline = gate.stableBaseline;
  guard(object(last) && object(baseline), 'ARCHIVE_STABLE_BASELINE', context);
  contextIdentity(gate.context, context);
  equal(gate.stableContext, gate.context, 'ARCHIVE_CONTEXT_BINDING', {...context, field:'stableContext'});
  equal(gate.actionContext, gate.context, 'ARCHIVE_CONTEXT_BINDING', {...context, field:'actionContext'});
  for (const key of ['identityMatched','contextMatched','contextBound','uniqueTarget','visible','enabled','hitTarget','wholeViewport','pointsInsideClip','stable','ready'])
    guard(last[key] === true, 'ARCHIVE_READINESS', {...context, field:key});
  equal([last.targetToken,last.windowToken], [1,1], 'ARCHIVE_OBJECT_BINDING', context);
  for (const key of ['frame','stableFrame','elapsedMs','stableMs','stableAtMs']) guard(integer(last[key]), 'ARCHIVE_CLOCK', {...context,field:key});
  guard(integer(baseline.frame) && integer(baseline.elapsedMs) && baseline.frame === last.stableFrame &&
    baseline.elapsedMs === last.stableAtMs && last.frame > baseline.frame &&
    last.elapsedMs - baseline.elapsedMs >= C.stabilityMs && last.stableMs === last.elapsedMs - baseline.elapsedMs,
    'ARCHIVE_STABILITY', context);
  equal(stableSignature(last), stableSignature(baseline), 'ARCHIVE_STABLE_GEOMETRY', context);
  guard(integer(gate.actionElapsedMs) && gate.actionElapsedMs >= last.elapsedMs && gate.actionElapsedMs < spec.deadlineMs &&
    gate.performedAtMs === gate.actionElapsedMs && integer(gate.afterElapsedMs) && gate.afterElapsedMs >= gate.actionElapsedMs && gate.afterElapsedMs < spec.deadlineMs &&
    integer(gate.actionFrame) && gate.actionFrame === last.frame && integer(gate.afterFrame) && gate.afterFrame >= gate.actionFrame,
    'ARCHIVE_DISPATCH_CLOCK', context);
  let previousFrame = -1, previousTime = -1;
  for (const [index, sample] of gate.samples.entries()) {
    guard(object(sample) && integer(sample.frame) && integer(sample.elapsedMs) && sample.frame >= previousFrame && sample.elapsedMs >= previousTime &&
      sample.frame <= last.frame && sample.elapsedMs <= last.elapsedMs,
      'ARCHIVE_SAMPLE_ORDER', {...context,sample:index});
    previousFrame = sample.frame; previousTime = sample.elapsedMs;
  }
  const target = rectangle(last,'target',context), viewport = rectangle(last,'viewport',context),
    clip = rectangle(last,'clip',context), targetClip = rectangle(last,'targetClip',context);
  guard(finite(last.windowWidth) && finite(last.windowHeight) && last.windowWidth > 1 && last.windowHeight > 1 &&
    contains([0,0,last.windowWidth,last.windowHeight],clip), 'ARCHIVE_WINDOW_BOUNDS', context);
  guard(contains(clip,viewport,0.5) && contains(viewport,clip) && contains(target,targetClip) && contains(clip,targetClip),
    'ARCHIVE_CLIP_BOUNDS', context);
  guard(['startX','startY','endX','endY'].every(key => Number.isSafeInteger(last[key])) &&
    pointInside(targetClip,last.startX,last.startY) && pointInside(targetClip,last.endX,last.endY),
    'ARCHIVE_INPUT_POINT', context);
  if (spec.region === 2) {
    // Recompute the original first-line gesture, never the TextArea center.
    equal([last.startX,last.startY,last.endX,last.endY],
      [Math.round(target[0]+18),Math.round(target[1]+22),Math.round(target[0]+Math.min(target[2]-18,230)),Math.round(target[1]+22)],
      'ARCHIVE_FIRST_LINE', context);
  } else {
    const area = spec.region === 0 ? target : targetClip;
    equal([last.startX,last.startY,last.endX,last.endY],
      [Math.round(area[0]+area[2]/2),Math.round(area[1]+area[3]/2),Math.round(area[0]+area[2]/2),Math.round(area[1]+area[3]/2)],
      'ARCHIVE_CENTER_POINT', context);
  }
  scroll(last.inner, spec.region !== 0, {...context,field:'inner'});
  scroll(last.outer, true, {...context,field:'outer'});
  if (spec.observationMs !== undefined) {
    guard(integer(record.observedAtMs) && record.observedAtMs >= gate.afterElapsedMs &&
      record.observedAtMs - gate.actionElapsedMs >= spec.observationMs && record.observedAtMs < spec.deadlineMs &&
      integer(record.observedFrame) && record.observedFrame >= gate.afterFrame,
      'ARCHIVE_OBSERVATION_CLOCK', context);
  }
  if (record.id === 'scene-body-wheel') {
    scroll(record.scrollBefore,true,{...context,field:'scrollBefore'});
    scroll(record.scrollAfter,true,{...context,field:'scrollAfter'});
    equal(record.scrollBefore,last.inner,'ARCHIVE_WHEEL_BASELINE',context);
    equal(record.wheelAngleY,-120,'ARCHIVE_WHEEL_EVENT',context);
    guard(record.businessDraftUnchanged === true,'ARCHIVE_WHEEL_DRAFT',context);
    // Boundary wheels may legitimately leave contentY unchanged. Directional
    // movement is an old business assertion, never replaced by program reveal.
  }
  return {id:spec.id,step:spec.step,control:spec.control,region:spec.region,deadlineMs:spec.deadlineMs};
}
// This is a separate chain after the original pointer-readiness proof. The
// old action guards keep their order and the focus leaf is never substituted
// with an owner rectangle. Visibility retains the original nonempty-intersection
// rule, including synchronous Tab/Backtab observations on the same Qt frame.
function focusRect(value, positive, context) {
  guard(object(value) && ['x','y','width','height'].every(key => finite(value[key])) &&
    (positive ? value.width > 0 && value.height > 0 : value.width >= 0 && value.height >= 0),
    'ARCHIVE_FOCUS_RECT', context);
  return [value.x,value.y,value.width,value.height];
}
function intersection(a,b) {
  const x=Math.max(a[0],b[0]),y=Math.max(a[1],b[1]);
  const width=Math.min(a[0]+a[2],b[0]+b[2])-x,height=Math.min(a[1]+a[3],b[1]+b[3])-y;
  // QRectF::intersected returns a null rectangle for an empty intersection.
  return width>0 && height>0 ? [x,y,width,height] : [0,0,0,0];
}
function nearRect(a,b) { return a.every((value,index) => Math.abs(value-b[index]) <= 0.001); }
function boundedText(value, empty=false) {
  return typeof value==='string' && value.length <= 256 && (empty || value.length>0) && !/[\x00-\x1f\x7f]/.test(value);
}
function focusIdentity(value, identities, context) {
  guard(object(value) && /^focus-[1-9][0-9]*$/.test(value.instanceToken) &&
    boundedText(value.objectName,true) && boundedText(value.className), 'ARCHIVE_FOCUS_IDENTITY', context);
  const descriptor=[value.objectName,value.className],known=identities.get(value.instanceToken);
  if(known) equal(descriptor,known,'ARCHIVE_FOCUS_IDENTITY_REUSE',context);
  else identities.set(value.instanceToken,descriptor);
}
function focusSnapshot(value, identities, windowToken, context) {
  guard(object(value), 'ARCHIVE_FOCUS_SNAPSHOT',context);
  focusIdentity(value,identities,context);
  equal(value.windowToken,windowToken,'ARCHIVE_FOCUS_WINDOW',context);
  const leaf=focusRect(value.rect,true,{...context,field:'rect'}),
    window=focusRect(value.windowRect,true,{...context,field:'windowRect'});
  guard(window[0]===0 && window[1]===0,'ARCHIVE_FOCUS_WINDOW',context);
  guard(Array.isArray(value.ancestry) && value.ancestry.length>=1 && value.ancestry.length<=C.focusTraversal.maximumAncestry &&
    value.ancestryComplete===true,'ARCHIVE_FOCUS_ANCESTRY',context);
  const tokens=new Set();let opacity=1;
  for(const [index,node] of value.ancestry.entries()) {
    const nested={...context,ancestor:index};
    focusIdentity(node,identities,nested);
    guard(!tokens.has(node.instanceToken),'ARCHIVE_FOCUS_ANCESTRY_DUPLICATE',nested); tokens.add(node.instanceToken);
    guard(typeof node.visible==='boolean' && typeof node.enabled==='boolean' && typeof node.clip==='boolean' && typeof node.isFlickable==='boolean' &&
      finite(node.opacity) && node.opacity>=0 && node.opacity<=1,'ARCHIVE_FOCUS_ANCESTRY_STATE',nested);
    focusRect(node.rect,false,{...nested,field:'rect'}); opacity*=node.opacity;
  }
  equal([value.instanceToken,value.objectName,value.className,value.rect],
    [value.ancestry[0].instanceToken,value.ancestry[0].objectName,value.ancestry[0].className,value.ancestry[0].rect],
    'ARCHIVE_FOCUS_LEAF_BINDING',context);
  focusIdentity(value.owner,identities,{...context,field:'owner'});
  const owner=value.ancestry.find(node=>node.instanceToken===value.owner.instanceToken);
  guard(owner && value.owner.objectName===owner.objectName && value.owner.className===owner.className,
    'ARCHIVE_FOCUS_OWNER_BINDING',context);
  guard(typeof value.visible==='boolean' && typeof value.enabled==='boolean' && finite(value.opacity) &&
    value.visible===value.ancestry.every(node=>node.visible) && value.enabled===value.ancestry.every(node=>node.enabled) &&
    Math.abs(value.opacity-opacity)<=0.000001,'ARCHIVE_FOCUS_EFFECTIVE_STATE',context);
  guard(value.visible===true && value.enabled===true && value.opacity>.01,'ARCHIVE_FOCUS_VISIBILITY',context);
  const clips=value.ancestry.slice(1).filter(node=>node.clip).map(node=>
    ({instanceToken:node.instanceToken,objectName:node.objectName,rect:node.rect}));
  equal(value.clipChain,clips,'ARCHIVE_FOCUS_CLIP_CHAIN',context);
  guard(value.clipChainComplete===true && clips.length<=C.focusTraversal.maximumClips,'ARCHIVE_FOCUS_CLIP_COMPLETE',context);
  let visible=intersection(leaf,window);
  for(const clip of clips) visible=intersection(visible,focusRect(clip.rect,false,{...context,field:'clip'}));
  const reported=focusRect(value.intersection,false,{...context,field:'intersection'});
  guard(nearRect(visible,reported),'ARCHIVE_FOCUS_INTERSECTION',context);
  guard(visible[2]>0 && visible[3]>0,'ARCHIVE_FOCUS_CLIPPED',context);
  guard((value.focusReasonStatus==='known' && Number.isSafeInteger(value.focusReason) && C.focusTraversal.focusReasons.includes(value.focusReason)) ||
    (value.focusReasonStatus==='absent' && value.focusReason===null),'ARCHIVE_FOCUS_REASON',context);
  if(value.cursorRect!==null) focusRect(value.cursorRect,false,{...context,field:'cursorRect'});
  guard(Array.isArray(value.scrolls) && value.scrolls.length<=C.focusTraversal.maximumScrolls,'ARCHIVE_FOCUS_SCROLLS',context);
  const scrollTokens=new Set();
  for(const [index,entry] of value.scrolls.entries()) {
    const nested={...context,scroll:index};
    guard(object(entry) && tokens.has(entry.instanceToken) && !scrollTokens.has(entry.instanceToken) &&
      entry.objectName===value.ancestry.find(node=>node.instanceToken===entry.instanceToken)?.objectName,
      'ARCHIVE_FOCUS_SCROLL_BINDING',nested); scrollTokens.add(entry.instanceToken);
    guard(['y','minimumY','maximumY','height','contentHeight'].every(key=>finite(entry[key])) &&
      entry.height>0 && entry.contentHeight>=0 && entry.maximumY>=entry.minimumY &&
      entry.y>=entry.minimumY-.5 && entry.y<=entry.maximumY+.5,'ARCHIVE_FOCUS_SCROLL_BOUNDS',nested);
  }
  guard(value.scrollsComplete===true,'ARCHIVE_FOCUS_SCROLL_COMPLETE',context);
  equal(value.scrolls.map(entry=>entry.instanceToken),value.ancestry.filter(node=>node.isFlickable).map(node=>node.instanceToken),
    'ARCHIVE_FOCUS_SCROLL_SET',context);
  guard(!value.ancestry.some(node=>C.focusTraversal.inactiveBodies.includes(node.objectName)),
    'ARCHIVE_FOCUS_INACTIVE_BODY',context);
  return {token:value.instanceToken,bodyFocused:value.ancestry.some(node=>node.objectName==='worldbookContent')};
}
function verifyArchiveFocusTraversal(trace,boundary,context) {
  const F=C.focusTraversal;
  guard(object(trace),'ARCHIVE_FOCUS_TRACE',context);
  equal([trace.schema,trace.phase,trace.step,trace.deadlineMs],
    [F.schema,F.phase,F.step,F.deadlineMs],'ARCHIVE_FOCUS_CONTRACT',context);
  equal([trace.scope,trace.generation],[boundary.scope,boundary.generation],
    'ARCHIVE_FOCUS_CONTEXT',context);
  guard(boundedText(trace.windowToken) && integer(trace.initialPositioningCount),'ARCHIVE_FOCUS_BINDING',context);
  guard(Array.isArray(trace.records) && trace.records.length===F.keyCount,'ARCHIVE_FOCUS_RECORDS',context);
  guard(integer(trace.startElapsedMs) && trace.startElapsedMs>=boundary.actionElapsedMs &&
    integer(trace.endElapsedMs) && trace.endElapsedMs>=trace.startElapsedMs && trace.endElapsedMs<=boundary.afterElapsedMs && trace.endElapsedMs<F.deadlineMs,
    'ARCHIVE_FOCUS_CLOCK',context);
  let previousTime=trace.startElapsedMs,previousFrame=boundary.actionFrame,previousToken=null;
  const identities=new Map(),visited=new Set();
  for(const [index,record] of trace.records.entries()) {
    const keyContext={...context,index};
    guard(object(record),'ARCHIVE_FOCUS_RECORD',keyContext);
    equal(record.index,index,'ARCHIVE_FOCUS_INDEX',keyContext);
    equal([record.scope,record.generation,record.step],[trace.scope,trace.generation,F.step],
      'ARCHIVE_FOCUS_RECORD_CONTEXT',keyContext);
    guard(record.inputCount===1 && record.immediate===true,'ARCHIVE_FOCUS_DISPATCH',keyContext);
    guard(integer(record.positioningBefore) && record.positioningBefore===trace.initialPositioningCount &&
      record.positioningAfter===record.positioningBefore,'ARCHIVE_FOCUS_TEST_SCROLL',keyContext);
    guard(integer(record.elapsedBeforeMs) && integer(record.elapsedAfterMs) && record.elapsedBeforeMs>=previousTime &&
      record.elapsedAfterMs>=record.elapsedBeforeMs && record.elapsedAfterMs<F.deadlineMs,
      'ARCHIVE_FOCUS_KEY_CLOCK',keyContext);
    guard(integer(record.frameBefore) && integer(record.frameAfter) && record.frameBefore>=previousFrame &&
      record.frameAfter>=record.frameBefore && record.frameAfter<=boundary.afterFrame,'ARCHIVE_FOCUS_FRAME',keyContext);
    const before=focusSnapshot(record.before,identities,trace.windowToken,{...keyContext,edge:'before'});
    if(previousToken!==null) equal(before.token,previousToken,'ARCHIVE_FOCUS_CONTINUITY',keyContext);
    equal(record.bodyFocused,before.bodyFocused,'ARCHIVE_FOCUS_BODY_BINDING',keyContext);
    equal(record.direction,before.bodyFocused || index>=F.reverseFromIndex ? 'Backtab':'Tab',
      'ARCHIVE_FOCUS_DIRECTION',keyContext);
    const after=focusSnapshot(record.after,identities,trace.windowToken,{...keyContext,edge:'after'});
    verifyCausal(record.causal,keyContext);
    visited.add(after.token); previousToken=after.token; previousTime=record.elapsedAfterMs; previousFrame=record.frameAfter;
  }
  equal(trace.endElapsedMs,previousTime,'ARCHIVE_FOCUS_END_CLOCK',context);
  guard(visited.size>=F.minimumDistinctFocusItems,'ARCHIVE_FOCUS_DISTINCT_ITEMS',context);
  return {...(context.cycle===undefined?{}:{cycle:context.cycle}),phase:F.phase,keyCount:trace.records.length,distinctFocusItems:visited.size,
    deadlineMs:F.deadlineMs,immediate:true,testPositioningDelta:0};
}
function verifyArchiveControlReadiness(result) {
  guard(object(result) && Array.isArray(result.reports) && result.reports.length === 2, 'ARCHIVE_REPORTS', {cycle:0});
  guard(!result.worldbookRegexFixture || (!result.personaFixture && !result.worldbookEntryFixture), 'ARCHIVE_MODE_CONFLICT', {cycle:0,mode:'regex'});
  guard(!result.worldbookInjectionFixture || (!result.personaFixture && !result.worldbookEntryFixture && !result.worldbookRegexFixture), 'ARCHIVE_MODE_CONFLICT', {cycle:0,mode:'injection'});
  const mode = result.worldbookInjectionFixture ? 'injection' : result.personaFixture ? 'persona' : result.worldbookRegexFixture ? 'regex' : result.worldbookEntryFixture ? 'entry' : 'ordinary';
  const actionCounts = C.cycleActionCounts[mode==='regex'||mode==='injection'?'entry':mode];
  const checked = [];
  for (const [cycleIndex, report] of result.reports.entries()) {
    const cycle = cycleIndex+1;
    guard(object(report), 'ARCHIVE_REPORT', {cycle});
    for (const group of groups) {
      const expected = cycle === 1 ? [...C.firstCycle[group], ...(group === 'archiveInteraction' && mode === 'persona' ? C.firstCycle.personaArchiveExtension : [])] : [];
      const actual = report[group]?.archiveControlReadiness;
      if (!expected.length && actual === undefined) continue;
      guard(Array.isArray(actual), 'ARCHIVE_ACTIONS', {cycle,group});
      equal(actual.map(item => item?.id),expected.map(item => item.id),'ARCHIVE_ACTION_SET',{cycle,group});
      for (let index=0;index<expected.length;++index) checked.push({cycle,group,...action(actual[index],expected[index],{cycle,group,id:expected[index].id})});
    }
    if (report.personaRestart?.archiveControlReadiness !== undefined)
      equal(report.personaRestart.archiveControlReadiness,[],'ARCHIVE_RESTART_ACTIONS',{cycle,group:'personaRestart'});
  }
  equal([1,2].map(cycle => checked.filter(item => item.cycle === cycle).length),actionCounts, 'ARCHIVE_ACTION_TOTAL',{cycle:0,mode});
  // The title gate above retains its original checks before this new chain.
  const titleGate=result.reports[0].moonroom.archiveControlReadiness.find(item=>item.id==='tab-visible-controls').gate;
  const focusProof=verifyArchiveFocusTraversal(result.reports[0].moonroom.archiveFocusTraversal,
    {scope:titleGate.actionContext.scope,generation:titleGate.actionContext.generation,actionElapsedMs:titleGate.actionElapsedMs,
     afterElapsedMs:titleGate.afterElapsedMs,actionFrame:titleGate.actionFrame,afterFrame:titleGate.afterFrame},
    {cycle:1,group:'moonroom',phase:C.focusTraversal.phase});
  guard(result.reports[1].moonroom?.archiveFocusTraversal===undefined,'ARCHIVE_FOCUS_RESTART_REPLAY',{cycle:2,group:'moonroom'});
  return {schema:'reverie.archive-control-readiness-proof.v1',passed:true,mode,cycleActionCounts:actionCounts,actions:checked,focusTraversal:focusProof,contentCollected:false};
}


function verifyCausal(value,context) {
  guard(object(value) && value.schema===C.focusTraversal.causalSchema && value.overflow===false &&
    Array.isArray(value.events) && value.events.length>0 && value.events.length<=C.focusTraversal.maximumCausalEvents,
    'ARCHIVE_FOCUS_CAUSAL',context);
  let sequence=-1;
  for (const [index,event] of value.events.entries()) {
    const nested={...context,event:index};
    guard(object(event) && integer(event.sequence) && event.sequence>sequence &&
      typeof event.kind==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(event.kind), 'ARCHIVE_FOCUS_CAUSAL_EVENT',nested);
    sequence=event.sequence;
    guard(Object.keys(event).every(key=>/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) &&
      (key==='kind' || event[key]===null || typeof event[key]==='boolean' || finite(event[key]))),
      'ARCHIVE_FOCUS_CAUSAL_FIELDS',nested);
  }
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function evidenceFile(file,limit,context) {
  guard(fs.existsSync(file),'ARCHIVE_FOCUS_FILE_MISSING',context);
  const info=fs.lstatSync(file);
  guard(info.isFile() && !info.isSymbolicLink(),'ARCHIVE_FOCUS_FILE_KIND',context);
  guard(info.size>0 && info.size<=limit,'ARCHIVE_FOCUS_FILE_BOUND',context);
  const bytes=fs.readFileSync(file);
  guard(bytes.length===info.size,'ARCHIVE_FOCUS_FILE_BYTES',context);
  let value;
  try {value=JSON.parse(bytes.toString('utf8'));} catch(error) {
    guard(false,'ARCHIVE_FOCUS_FILE_JSON',context);
  }
  return {bytes,value};
}
function exactKeys(value,keys,reason,context) {
  guard(object(value),reason,context);
  equal(Object.keys(value).sort(),keys.slice().sort(),reason,context);
}
function verifyNativeArchiveFocusEvidence(directory,contractPath) {
  const F=C.nativeFocusEvidence,context={kind:'native-focus'};
  const contract=evidenceFile(contractPath,65536,{...context,file:'contract'});
  equal(contract.value,C,'ARCHIVE_FOCUS_FILE_CONTRACT',context);
  guard(fs.existsSync(directory),'ARCHIVE_FOCUS_DIRECTORY',context);
  const info=fs.lstatSync(directory);
  guard(info.isDirectory() && !info.isSymbolicLink(),'ARCHIVE_FOCUS_DIRECTORY',context);
  equal(fs.readdirSync(directory).sort(),['manifest.json',...F.cases.map(c=>c.filename)].sort(),
    'ARCHIVE_FOCUS_FILE_SET',context);
  const manifest=evidenceFile(path.join(directory,'manifest.json'),65536,{...context,file:'manifest.json'});
  exactKeys(manifest.value,['schema','contractSha256','cases'],'ARCHIVE_FOCUS_MANIFEST_FIELDS',context);
  equal([manifest.value.schema,manifest.value.contractSha256],[F.manifestSchema,hash(contract.bytes)],'ARCHIVE_FOCUS_MANIFEST_BINDING',context);
  guard(Array.isArray(manifest.value.cases),'ARCHIVE_FOCUS_MANIFEST_CASES',context);
  equal(manifest.value.cases.map(c=>c?.caseId),F.cases.map(c=>c.caseId),'ARCHIVE_FOCUS_MANIFEST_CASES',context);
  const cases=[],recordsSha256={};
  for(const [index,spec] of F.cases.entries()) {
    const ctx={...context,caseId:spec.caseId},ref=manifest.value.cases[index];
    exactKeys(ref,['caseId','filename','sha256','bytes'],'ARCHIVE_FOCUS_MANIFEST_ENTRY',ctx);
    equal([ref.caseId,ref.filename],[spec.caseId,spec.filename],'ARCHIVE_FOCUS_MANIFEST_ENTRY',ctx);
    guard(integer(ref.bytes) && ref.bytes>0 && ref.bytes<=F.maximumRecordBytes && /^[a-f0-9]{64}$/.test(ref.sha256),
      'ARCHIVE_FOCUS_MANIFEST_ENTRY',ctx);
    const record=evidenceFile(path.join(directory,spec.filename),F.maximumRecordBytes,ctx);
    equal([record.bytes.length,hash(record.bytes)],[ref.bytes,ref.sha256],'ARCHIVE_FOCUS_RECORD_HASH',ctx);
    exactKeys(record.value,['schema','caseId','trace','boundary'],'ARCHIVE_FOCUS_RECORD_FIELDS',ctx);
    equal([record.value.schema,record.value.caseId],[F.schema,spec.caseId],'ARCHIVE_FOCUS_RECORD_BINDING',ctx);
    const b=record.value.boundary;
    exactKeys(b,['source','caseId','dataTag','scope','generation','windowToken','windowWidth','windowHeight','deadlineMs',
      'actionElapsedMs','afterElapsedMs','actionFrame','afterFrame'],'ARCHIVE_FOCUS_NATIVE_BOUNDARY',ctx);
    equal([b.source,b.caseId,b.dataTag,b.windowWidth,b.windowHeight,b.deadlineMs],
      ['native',spec.caseId,spec.dataTag,spec.width,spec.height,C.focusTraversal.deadlineMs],'ARCHIVE_FOCUS_NATIVE_BOUNDARY',ctx);
    guard(boundedText(b.scope) && integer(b.generation) && boundedText(b.windowToken) &&
      [b.actionElapsedMs,b.afterElapsedMs,b.actionFrame,b.afterFrame].every(integer) &&
      b.actionElapsedMs<=b.afterElapsedMs && b.afterElapsedMs<C.focusTraversal.deadlineMs && b.actionFrame<=b.afterFrame,
      'ARCHIVE_FOCUS_NATIVE_BOUNDARY',ctx);
    const proof=verifyArchiveFocusTraversal(record.value.trace,b,{...ctx,phase:C.focusTraversal.phase});
    equal(record.value.trace.windowToken,b.windowToken,'ARCHIVE_FOCUS_NATIVE_BOUNDARY',ctx);
    for(const row of record.value.trace.records) for(const edge of ['before','after'])
      equal(row[edge].windowRect,{x:0,y:0,width:spec.width,height:spec.height},'ARCHIVE_FOCUS_NATIVE_WINDOW',ctx);
    recordsSha256[spec.filename]=ref.sha256;cases.push({caseId:spec.caseId,proof});
  }
  return {schema:F.proofSchema,passed:true,contractSha256:hash(contract.bytes),manifestSha256:hash(manifest.bytes),
    recordsSha256,caseIds:F.cases.map(c=>c.caseId),cases,contentCollected:false};
}
module.exports = {ARCHIVE_CONTROL_READINESS_CONTRACT,verifyArchiveControlReadiness,verifyArchiveFocusTraversal,verifyNativeArchiveFocusEvidence};
