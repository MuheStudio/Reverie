'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {assertRejectedMutation} = require('./verdict-test-support.cjs');
const {ARCHIVE_CONTROL_READINESS_CONTRACT:C,verifyArchiveControlReadiness,verifyNativeArchiveFocusEvidence} = require('./archive-control-readiness-verdicts.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const ctx = {cycle:1,group:'interaction',id:'scene-body-selection'};
function snapshot(spec) {
  const whole = spec.region === 0, height = whole ? 32 : 900;
  const out = {frame:1,elapsedMs:0,windowWidth:300,windowHeight:240,visible:true,enabled:true,wholeViewport:true,pointsInsideClip:true,hitTarget:true,
    identityMatched:true,contextMatched:true,contextBound:true,uniqueTarget:true,ready:true,
    inner:whole ? {found:false} : {found:true,valid:true,y:0,minimumY:0,maximumY:780,height:120,contentHeight:900},
    outer:{found:true,valid:true,y:600,minimumY:0,maximumY:960,height:240,contentHeight:1200}};
  for (const [prefix,width,rectHeight] of [['target',260,height],['viewport',260,whole?32:120],['clip',260,whole?32:120],['targetClip',260,whole?32:120]])
    Object.assign(out,{[prefix+'X']:10,[prefix+'Y']:100,[prefix+'Width']:width,[prefix+'Height']:rectHeight});
  Object.assign(out,spec.region===2 ? {startX:28,startY:122,endX:240,endY:122} : {startX:140,startY:whole?116:160,endX:140,endY:whole?116:160});
  return out;
}
function record(spec) {
  const baseline=snapshot(spec), last={...copy(baseline),frame:2,elapsedMs:60,stableFrame:1,stableAtMs:0,stableMs:60,stable:true,targetToken:1,windowToken:1};
  const context={scope:'scope-fixture',generation:1,revision:2,bookId:'book-fixture',entryId:'entry-fixture'};
  const gate={schema:C.evidenceSchema,control:spec.control,region:spec.region,deadlineMs:spec.deadlineMs,sampleLimit:6,
    performed:true,failed:false,expired:false,attemptCount:1,polls:2,samples:[copy(baseline),copy(last)],
    context:copy(context),stableContext:copy(context),actionContext:copy(context),stableBaseline:copy(baseline),last,
    actionElapsedMs:60,performedAtMs:60,afterElapsedMs:61,actionFrame:2,afterFrame:2};
  const result=spec.shape==='flat'?gate:{gate};
  Object.assign(result,{id:spec.id,step:spec.step,control:spec.control});
  if(spec.observationMs!==undefined) Object.assign(result,{observedAtMs:60+spec.observationMs,observedFrame:3});
  if(spec.id==='scene-body-wheel') Object.assign(result,{scrollBefore:copy(last.inner),scrollAfter:{...copy(last.inner),y:50},wheelAngleY:-120,businessDraftUnchanged:true});
  return result;
}
function focusSnapshotFixture(index) {
  const names=['worldbookName','worldbookKeywords','','worldbookContent'];
  const rect={x:20,y:70+index*32,width:120,height:28}, windowRect={x:0,y:0,width:300,height:240};
  const node=(instanceToken,objectName,className,nodeRect,clip=false)=>({instanceToken,objectName,className,
    visible:true,enabled:true,opacity:1,clip,isFlickable:className==='QQuickFlickable',rect:copy(nodeRect)});
  const leaf=node('focus-'+(index+1),names[index],index===2?'QQuickTextInput':'QQuickTextField',rect);
  const parent=node('focus-20','worldbookEntryScanDepth','QQuickSpinBox',rect);
  const area=node('focus-90','worldbook-form-scroll','QQuickFlickable',{x:10,y:50,width:280,height:180},true);
  const root=node('focus-91','root','QQuickRootItem',windowRect);
  const ancestry=index===2?[leaf,parent,area,root]:[leaf,area,root], owner=index===2?parent:leaf;
  return {instanceToken:leaf.instanceToken,objectName:leaf.objectName,className:leaf.className,windowToken:'window-1',
    owner:{instanceToken:owner.instanceToken,objectName:owner.objectName,className:owner.className},
    visible:true,enabled:true,opacity:1,rect:copy(rect),windowRect,ancestry,ancestryComplete:true,
    clipChain:[{instanceToken:area.instanceToken,objectName:area.objectName,rect:copy(area.rect)}],intersection:copy(rect),
    cursorRect:null,focusReason:1,focusReasonStatus:'known',clipChainComplete:true,scrollsComplete:true,
    scrolls:[{instanceToken:area.instanceToken,objectName:area.objectName,y:100,minimumY:0,maximumY:720,height:180,contentHeight:900}]};
}
function focusTraceFixture() {
  const records=[];
  for(let index=0;index<24;++index) {
    const before=focusSnapshotFixture(index%4), after=focusSnapshotFixture((index+1)%4),bodyFocused=index%4===3;
    records.push({index,step:28,scope:'scope-fixture',generation:1,direction:bodyFocused||index>=12?'Backtab':'Tab',bodyFocused,
      inputCount:1,immediate:true,before,after,causal:{schema:C.focusTraversal.causalSchema,overflow:false,events:[{sequence:0,kind:'observation-start'}]},positioningBefore:3,positioningAfter:3,frameBefore:2,frameAfter:2,
      elapsedBeforeMs:62+index*2,elapsedAfterMs:63+index*2});
  }
  return {schema:C.focusTraversal.schema,phase:'tab-visible-controls',step:28,scope:'scope-fixture',generation:1,
    windowToken:'window-1',deadlineMs:4000,startElapsedMs:61,endElapsedMs:109,initialPositioningCount:3,records};
}
function fixture(mode='entry') {
  const report={};
  for(const group of ['interaction','moonroom','archiveInteraction']) {
    const specs=[...C.firstCycle[group],...(mode==='persona'&&group==='archiveInteraction'?C.firstCycle.personaArchiveExtension:[])];
    report[group]={archiveControlReadiness:specs.map(record)};
  }
  // The existing title gate wraps the click plus all immediate key checks.
  report.moonroom.archiveControlReadiness.find(item=>item.id==='tab-visible-controls').gate.afterElapsedMs=110;
  report.moonroom.archiveFocusTraversal=focusTraceFixture();
  const result={reports:[report,{}]};
  if(mode==='entry') result.worldbookEntryFixture={};
  if(mode==='persona') {result.personaFixture={};result.reports[1].personaRestart={archiveControlReadiness:[]};}
  return result;
}
const first = value => value.reports[0].interaction.archiveControlReadiness[0];
function rejection(id,expectedReason,mutate,expectedContext=ctx) {
  assertRejectedMutation({id,makeFixture:fixture,verify:verifyArchiveControlReadiness,mutate,expectedReason,expectedContext});
}
test('archive readiness accepts the complete entry first-cycle contract',()=>{
  const proof=verifyArchiveControlReadiness(fixture()); assert.deepEqual(proof.cycleActionCounts,[8,0]); assert.equal(proof.passed,true);
});
test('archive readiness accepts the complete persona extension without restart writes',()=>{
  const proof=verifyArchiveControlReadiness(fixture('persona')); assert.deepEqual(proof.cycleActionCounts,[14,0]);
});
test('archive readiness keeps ordinary mode action identities',()=>{
  assert.deepEqual(verifyArchiveControlReadiness(fixture('ordinary')).cycleActionCounts,[8,0]);
});
test('archive readiness permits boundary wheel without invented movement',()=>{
  const value=fixture();const wheel=value.reports[0].interaction.archiveControlReadiness[1]; wheel.scrollAfter=copy(wheel.scrollBefore);
  assert.equal(verifyArchiveControlReadiness(value).passed,true);
});
test('archive readiness rejects missing first-cycle group',()=>rejection('missing-group','ARCHIVE_ACTIONS',v=>delete v.reports[0].interaction,{cycle:1,group:'interaction'}));
test('archive readiness rejects duplicate registered action',()=>rejection('duplicate-action','ARCHIVE_ACTION_SET',v=>v.reports[0].interaction.archiveControlReadiness.push(copy(first(v))),{cycle:1,group:'interaction'}));
test('archive readiness rejects a missing registered action',()=>rejection('missing-action','ARCHIVE_ACTION_SET',v=>v.reports[0].interaction.archiveControlReadiness.pop(),{cycle:1,group:'interaction'}));
test('archive readiness rejects restart action replay',()=>rejection('restart-replay','ARCHIVE_ACTION_SET',v=>v.reports[1].interaction={archiveControlReadiness:[copy(first(v))]},{cycle:2,group:'interaction'}));
test('archive readiness rejects wrong step identity',()=>rejection('wrong-step','ARCHIVE_ACTION_IDENTITY',v=>first(v).step='old-step'));
test('archive readiness rejects wrong target control',()=>rejection('wrong-control','ARCHIVE_ACTION_IDENTITY',v=>first(v).control='worldbookName'));
test('archive readiness rejects deadline extension',()=>rejection('deadline-extension','ARCHIVE_GATE_CONTRACT',v=>first(v).deadlineMs=4000));
test('archive readiness rejects repeat dispatch',()=>rejection('repeat-dispatch','ARCHIVE_DISPATCH',v=>first(v).attemptCount=2));
test('archive readiness rejects failure labelled successful',()=>rejection('failed-success','ARCHIVE_DISPATCH',v=>first(v).failed=true));
test('archive readiness rejects absent stable baseline',()=>rejection('no-baseline','ARCHIVE_STABLE_BASELINE',v=>delete first(v).stableBaseline));
test('archive readiness rejects missing scope',()=>rejection('missing-scope','ARCHIVE_CONTEXT',v=>delete first(v).context.scope,{...ctx,field:'scope'}));
test('archive readiness rejects changed revision binding',()=>rejection('revision-change','ARCHIVE_CONTEXT_BINDING',v=>first(v).actionContext.revision++,{...ctx,field:'actionContext'}));
test('archive readiness rejects changed stable scope',()=>rejection('stable-scope','ARCHIVE_CONTEXT_BINDING',v=>first(v).stableContext.scope='other',{...ctx,field:'stableContext'}));
test('archive readiness rejects missing ready rather than treating it true',()=>rejection('missing-ready','ARCHIVE_READINESS',v=>delete first(v).last.ready,{...ctx,field:'ready'}));
test('archive readiness rejects non-boolean hit target',()=>rejection('hit-type','ARCHIVE_READINESS',v=>first(v).last.hitTarget=1,{...ctx,field:'hitTarget'}));
test('archive readiness rejects different target identity token',()=>rejection('target-token','ARCHIVE_OBJECT_BINDING',v=>first(v).last.targetToken=2));
test('archive readiness rejects reused presentation frame',()=>rejection('same-frame','ARCHIVE_STABILITY',v=>first(v).last.frame=1));
test('archive readiness rejects insufficient stable time',()=>rejection('short-stability','ARCHIVE_STABILITY',v=>{first(v).last.elapsedMs=20;first(v).last.stableMs=20;}));
test('archive readiness rejects fabricated stable time',()=>rejection('fake-stability','ARCHIVE_STABILITY',v=>first(v).last.stableMs=100));
test('archive readiness rejects geometry changed since baseline',()=>rejection('changed-geometry','ARCHIVE_STABLE_GEOMETRY',v=>first(v).last.viewportY++));
test('archive readiness rejects dispatch at the deadline',()=>rejection('late-dispatch','ARCHIVE_DISPATCH_CLOCK',v=>{const r=first(v);r.actionElapsedMs=r.performedAtMs=r.afterElapsedMs=2500;}));
test('archive readiness rejects action completion after deadline',()=>rejection('late-completion','ARCHIVE_DISPATCH_CLOCK',v=>first(v).afterElapsedMs=2500));
test('archive readiness rejects unordered diagnostic frames',()=>rejection('sample-order','ARCHIVE_SAMPLE_ORDER',v=>first(v).samples[0].frame=3,{...ctx,sample:0}));
test('archive readiness rejects whole viewport clipped despite success flags',()=>rejection('clipped-viewport','ARCHIVE_CLIP_BOUNDS',v=>{first(v).last.clipHeight=90;first(v).stableBaseline.clipHeight=90;}));
test('archive readiness rejects point outside target clip',()=>rejection('outside-point','ARCHIVE_INPUT_POINT',v=>{first(v).last.startX=0;first(v).stableBaseline.startX=0;}));
test('archive readiness rejects full-text center replacing first-line gesture',()=>rejection('wrong-first-line','ARCHIVE_FIRST_LINE',v=>{first(v).last.startY=160;first(v).stableBaseline.startY=160;}));
test('archive readiness rejects invalid scroll bounds',()=>rejection('scroll-bounds','ARCHIVE_SCROLL',v=>{first(v).last.inner.y=999;first(v).stableBaseline.inner.y=999;},{...ctx,field:'inner'}));
test('archive readiness rejects reset clock for post-input observation',()=>rejection('reset-observation','ARCHIVE_OBSERVATION_CLOCK',v=>first(v).observedAtMs=20));
test('archive readiness rejects wheel baseline preceding reveal',()=>rejection('old-wheel-baseline','ARCHIVE_WHEEL_BASELINE',v=>v.reports[0].interaction.archiveControlReadiness[1].scrollBefore.y=20,{...ctx,id:'scene-body-wheel'}));
test('archive readiness rejects wrong wheel amount',()=>rejection('wheel-amount','ARCHIVE_WHEEL_EVENT',v=>v.reports[0].interaction.archiveControlReadiness[1].wheelAngleY=-240,{...ctx,id:'scene-body-wheel'}));
test('archive readiness rejects changed draft during wheel',()=>rejection('wheel-draft','ARCHIVE_WHEEL_DRAFT',v=>v.reports[0].interaction.archiveControlReadiness[1].businessDraftUnchanged=false,{...ctx,id:'scene-body-wheel'}));
test('archive readiness rejects self-consistent geometry outside the window',()=>rejection('outside-window','ARCHIVE_WINDOW_BOUNDS',v=>{
  for(const sample of [first(v).last,first(v).stableBaseline]) {
    for(const prefix of ['target','viewport','clip','targetClip']) sample[prefix+'X']+=2000;
    sample.startX+=2000;sample.endX+=2000;
  }
}));


const focusContext={cycle:1,group:'moonroom',phase:'tab-visible-controls'};
const traversal=value=>value.reports[0].moonroom.archiveFocusTraversal;
const key=value=>traversal(value).records[0];
const after=value=>key(value).after;
const keyContext={...focusContext,index:0};
const afterContext={...keyContext,edge:'after'};
function focusRejection(id,expectedReason,mutate,expectedContext=focusContext) {
  assertRejectedMutation({id,makeFixture:fixture,verify:verifyArchiveControlReadiness,mutate,expectedReason,expectedContext});
}
function moveLeaf(snapshot,x,y) {
  snapshot.rect.x=x; snapshot.rect.y=y; snapshot.ancestry[0].rect=copy(snapshot.rect);
}

test('archive focus accepts all 24 immediate keys including anonymous SpinBox leaf',()=>{
  const proof=verifyArchiveControlReadiness(fixture());
  assert.deepEqual(proof.focusTraversal,{cycle:1,phase:'tab-visible-controls',keyCount:24,distinctFocusItems:4,deadlineMs:4000,immediate:true,testPositioningDelta:0});
});
test('archive focus accepts synchronous key captures sharing a presentation frame',()=>{
  const value=fixture();assert(traversal(value).records.every(record=>record.frameBefore===record.frameAfter));
  assert.equal(verifyArchiveControlReadiness(value).focusTraversal.keyCount,24);
});
test('archive focus preserves nonempty leaf intersection without substituting owner bounds',()=>{
  const value=fixture(); const snapshot=after(value); moveLeaf(snapshot,20,40); snapshot.intersection={x:20,y:50,width:120,height:18};
  assert.equal(verifyArchiveControlReadiness(value).passed,true);
});
test('archive focus accepts Backtab from multiline content before reverse half',()=>{
  const value=fixture();assert.equal(traversal(value).records[3].bodyFocused,true);assert.equal(traversal(value).records[3].direction,'Backtab');
  assert.equal(verifyArchiveControlReadiness(value).passed,true);
});
test('archive focus rejects missing traversal after valid title preparation',()=>focusRejection('focus-missing','ARCHIVE_FOCUS_TRACE',v=>delete v.reports[0].moonroom.archiveFocusTraversal));
test('archive focus rejects changed phase or deadline contract',()=>focusRejection('focus-contract','ARCHIVE_FOCUS_CONTRACT',v=>traversal(v).deadlineMs=4500));
test('archive focus rejects a foreign scope despite valid pointer gate',()=>focusRejection('focus-scope','ARCHIVE_FOCUS_CONTEXT',v=>traversal(v).scope='foreign'));
test('archive focus rejects an old connection generation',()=>focusRejection('focus-generation','ARCHIVE_FOCUS_CONTEXT',v=>traversal(v).generation=0));
test('archive focus rejects missing window identity',()=>focusRejection('focus-window-missing','ARCHIVE_FOCUS_BINDING',v=>delete traversal(v).windowToken));
test('archive focus rejects fewer than 24 keys',()=>focusRejection('focus-short','ARCHIVE_FOCUS_RECORDS',v=>traversal(v).records.pop()));
test('archive focus rejects an extra key',()=>focusRejection('focus-extra','ARCHIVE_FOCUS_RECORDS',v=>traversal(v).records.push(copy(key(v)))));
test('archive focus rejects reset phase clock after title preparation',()=>focusRejection('focus-clock-reset','ARCHIVE_FOCUS_CLOCK',v=>traversal(v).startElapsedMs=0));
test('archive focus rejects traversal completion at deadline',()=>focusRejection('focus-end-late','ARCHIVE_FOCUS_CLOCK',v=>traversal(v).endElapsedMs=4000));
test('archive focus rejects duplicated key index',()=>focusRejection('focus-index','ARCHIVE_FOCUS_INDEX',v=>key(v).index=1,keyContext));
test('archive focus rejects per-key scope mismatch',()=>focusRejection('focus-key-scope','ARCHIVE_FOCUS_RECORD_CONTEXT',v=>key(v).scope='foreign',keyContext));
test('archive focus rejects per-key phase mismatch',()=>focusRejection('focus-key-step','ARCHIVE_FOCUS_RECORD_CONTEXT',v=>key(v).step=29,keyContext));
test('archive focus rejects duplicate key dispatch',()=>focusRejection('focus-dispatch','ARCHIVE_FOCUS_DISPATCH',v=>key(v).inputCount=2,keyContext));
test('archive focus rejects delayed success replacing immediate capture',()=>focusRejection('focus-delayed','ARCHIVE_FOCUS_DISPATCH',v=>key(v).immediate=false,keyContext));
test('archive focus rejects test scrolling during a key',()=>focusRejection('focus-test-scroll','ARCHIVE_FOCUS_TEST_SCROLL',v=>key(v).positioningAfter++,keyContext));
test('archive focus rejects test scrolling between keys',()=>focusRejection('focus-between-scroll','ARCHIVE_FOCUS_TEST_SCROLL',v=>{key(v).positioningBefore++;key(v).positioningAfter++;},keyContext));
test('archive focus rejects per-key clock reset',()=>focusRejection('focus-key-clock-reset','ARCHIVE_FOCUS_KEY_CLOCK',v=>key(v).elapsedBeforeMs=0,keyContext));
test('archive focus rejects late immediate key observation',()=>focusRejection('focus-key-late','ARCHIVE_FOCUS_KEY_CLOCK',v=>key(v).elapsedAfterMs=4000,keyContext));
test('archive focus rejects a frame preceding title preparation',()=>focusRejection('focus-frame-old','ARCHIVE_FOCUS_FRAME',v=>key(v).frameBefore=1,keyContext));
test('archive focus rejects a frame moving backwards across key dispatch',()=>focusRejection('focus-frame-reverse','ARCHIVE_FOCUS_FRAME',v=>key(v).frameAfter=1,keyContext));
test('archive focus rejects absent actual focus leaf',()=>focusRejection('focus-leaf-missing','ARCHIVE_FOCUS_SNAPSHOT',v=>delete key(v).after,afterContext));
test('archive focus rejects unbounded or content-bearing identity',()=>focusRejection('focus-identity-bounds','ARCHIVE_FOCUS_IDENTITY',v=>after(v).objectName='x'.repeat(257),afterContext));
test('archive focus rejects a foreign window snapshot',()=>focusRejection('focus-window-foreign','ARCHIVE_FOCUS_WINDOW',v=>after(v).windowToken='window-2',afterContext));
test('archive focus rejects zero-sized leaf even when owner is visible',()=>focusRejection('focus-zero-leaf','ARCHIVE_FOCUS_RECT',v=>after(v).rect.width=0,{...afterContext,field:'rect'}));
test('archive focus rejects incomplete ancestor capture',()=>focusRejection('focus-ancestry-incomplete','ARCHIVE_FOCUS_ANCESTRY',v=>after(v).ancestryComplete=false,afterContext));
test('archive focus rejects duplicate ancestry tokens',()=>focusRejection('focus-ancestry-duplicate','ARCHIVE_FOCUS_ANCESTRY_DUPLICATE',v=>after(v).ancestry.push(copy(after(v).ancestry[2])),{...afterContext,ancestor:3}));
test('archive focus rejects invalid ancestor opacity',()=>focusRejection('focus-ancestor-opacity','ARCHIVE_FOCUS_ANCESTRY_STATE',v=>after(v).ancestry[0].opacity=2,{...afterContext,ancestor:0}));
test('archive focus rejects replacing the leaf rectangle with owner geometry',()=>focusRejection('focus-leaf-binding','ARCHIVE_FOCUS_LEAF_BINDING',v=>after(v).ancestry[0].rect.width++,afterContext));
test('archive focus rejects owner identity outside actual ancestry',()=>focusRejection('focus-owner-foreign','ARCHIVE_FOCUS_OWNER_BINDING',v=>after(v).owner={instanceToken:'focus-99',objectName:'foreign',className:'QQuickItem'},afterContext));
test('archive focus rejects fabricated effective opacity',()=>focusRejection('focus-opacity-lie','ARCHIVE_FOCUS_EFFECTIVE_STATE',v=>after(v).opacity=.5,afterContext));
test('archive focus rejects an invisible focus leaf',()=>focusRejection('focus-hidden','ARCHIVE_FOCUS_VISIBILITY',v=>{after(v).visible=false;after(v).ancestry[0].visible=false;},afterContext));
test('archive focus rejects a disabled focus leaf',()=>focusRejection('focus-disabled','ARCHIVE_FOCUS_VISIBILITY',v=>{after(v).enabled=false;after(v).ancestry[0].enabled=false;},afterContext));
test('archive focus rejects transparent focus despite geometry',()=>focusRejection('focus-transparent','ARCHIVE_FOCUS_VISIBILITY',v=>{after(v).opacity=.01;after(v).ancestry[0].opacity=.01;},afterContext));
test('archive focus rejects omission of a clipping ancestor',()=>focusRejection('focus-clip-omitted','ARCHIVE_FOCUS_CLIP_CHAIN',v=>after(v).clipChain=[],afterContext));
test('archive focus rejects invented visible intersection',()=>focusRejection('focus-intersection-fake','ARCHIVE_FOCUS_INTERSECTION',v=>after(v).intersection.width++,afterContext));
test('archive focus rejects wholly clipped leaf despite successful flags',()=>focusRejection('focus-wholly-clipped','ARCHIVE_FOCUS_CLIPPED',v=>{moveLeaf(after(v),20,300);after(v).intersection={x:0,y:0,width:0,height:0};},afterContext));
test('archive focus rejects fabricated focus reason type',()=>focusRejection('focus-reason-type','ARCHIVE_FOCUS_REASON',v=>after(v).focusReason='Tab',afterContext));
test('archive focus rejects a scroll from outside the leaf ancestry',()=>focusRejection('focus-scroll-foreign','ARCHIVE_FOCUS_SCROLL_BINDING',v=>after(v).scrolls[0].instanceToken='focus-99',{...afterContext,scroll:0}));
test('archive focus rejects impossible scroll bounds',()=>focusRejection('focus-scroll-bounds','ARCHIVE_FOCUS_SCROLL_BOUNDS',v=>after(v).scrolls[0].y=999,{...afterContext,scroll:0}));
test('archive focus rejects focus in an inactive body',()=>focusRejection('focus-inactive','ARCHIVE_FOCUS_INACTIVE_BODY',v=>{
  const snapshot=after(v),node={instanceToken:'focus-99',objectName:'terminalTasks',className:'QQuickItem',visible:true,enabled:true,opacity:1,clip:false,isFlickable:false,rect:copy(snapshot.windowRect)};
  snapshot.ancestry.splice(snapshot.ancestry.length-1,0,node);
},afterContext));
test('archive focus rejects body-focused claims unrelated to leaf ancestry',()=>focusRejection('focus-body-lie','ARCHIVE_FOCUS_BODY_BINDING',v=>key(v).bodyFocused=true,keyContext));
test('archive focus rejects wrong Tab direction in the forward half',()=>focusRejection('focus-direction-forward','ARCHIVE_FOCUS_DIRECTION',v=>key(v).direction='Backtab',keyContext));
test('archive focus rejects forward Tab from a multiline editor',()=>focusRejection('focus-direction-body','ARCHIVE_FOCUS_DIRECTION',v=>traversal(v).records[3].direction='Tab',{...focusContext,index:3}));
test('archive focus rejects forward Tab in the reverse half',()=>focusRejection('focus-direction-reverse','ARCHIVE_FOCUS_DIRECTION',v=>traversal(v).records[12].direction='Tab',{...focusContext,index:12}));
test('archive focus rejects a changed leaf between adjacent captures',()=>focusRejection('focus-continuity','ARCHIVE_FOCUS_CONTINUITY',v=>traversal(v).records[1].before=focusSnapshotFixture(0),{...focusContext,index:1}));
test('archive focus rejects token reuse for another control',()=>focusRejection('focus-token-reuse','ARCHIVE_FOCUS_IDENTITY_REUSE',v=>traversal(v).records[1].before.objectName='different',{...focusContext,index:1,edge:'before'}));
test('archive focus rejects terminal time not bound to final immediate sample',()=>focusRejection('focus-end-unbound','ARCHIVE_FOCUS_END_CLOCK',v=>traversal(v).endElapsedMs++));
test('archive focus rejects 24 keys that visit fewer than three real leaves',()=>focusRejection('focus-short-chain','ARCHIVE_FOCUS_DISTINCT_ITEMS',v=>{
  for(const record of traversal(v).records) {record.before=focusSnapshotFixture(0);record.after=focusSnapshotFixture(0);record.bodyFocused=false;record.direction=record.index>=12?'Backtab':'Tab';}
}));
test('archive focus rejects restart replay of first-cycle keyboard evidence',()=>focusRejection('focus-restart-replay','ARCHIVE_FOCUS_RESTART_REPLAY',v=>v.reports[1].moonroom={archiveFocusTraversal:copy(traversal(v))},{cycle:2,group:'moonroom'}));


test('archive focus accepts every explicit Qt focus reason number',()=>{
  for(const reason of C.focusTraversal.focusReasons) {const value=fixture();after(value).focusReason=reason;assert.equal(verifyArchiveControlReadiness(value).passed,true);}
});
test('archive focus accepts absent reason only with explicit absent status',()=>{
  const value=fixture();Object.assign(after(value),{focusReason:null,focusReasonStatus:'absent'});assert.equal(verifyArchiveControlReadiness(value).passed,true);
});
test('archive focus rejects actual Qt enum string serialization',()=>focusRejection('enum-string','ARCHIVE_FOCUS_REASON',v=>after(v).focusReason='TabFocusReason',afterContext));
test('archive focus rejects missing reason status',()=>focusRejection('reason-status-missing','ARCHIVE_FOCUS_REASON',v=>delete after(v).focusReasonStatus,afterContext));
test('archive focus rejects absent reason mislabeled known',()=>focusRejection('reason-known-null','ARCHIVE_FOCUS_REASON',v=>after(v).focusReason=null,afterContext));
test('archive focus rejects reason value mislabeled absent',()=>focusRejection('reason-absent-value','ARCHIVE_FOCUS_REASON',v=>after(v).focusReasonStatus='absent',afterContext));
test('archive focus rejects invalid reason state',()=>focusRejection('reason-invalid','ARCHIVE_FOCUS_REASON',v=>Object.assign(after(v),{focusReason:null,focusReasonStatus:'invalid'}),afterContext));
test('archive focus rejects boolean reason coercion',()=>focusRejection('reason-boolean','ARCHIVE_FOCUS_REASON',v=>after(v).focusReason=true,afterContext));
test('archive focus rejects numeric string reason coercion',()=>focusRejection('reason-numeric-string','ARCHIVE_FOCUS_REASON',v=>after(v).focusReason='1',afterContext));
test('archive focus rejects unregistered integer reason',()=>focusRejection('reason-range','ARCHIVE_FOCUS_REASON',v=>after(v).focusReason=9,afterContext));
test('archive focus rejects missing reason property as unknown',()=>focusRejection('reason-missing','ARCHIVE_FOCUS_REASON',v=>delete after(v).focusReason,afterContext));
test('archive focus rejects clipped chain truncation',()=>focusRejection('clip-truncated','ARCHIVE_FOCUS_CLIP_COMPLETE',v=>after(v).clipChainComplete=false,afterContext));
test('archive focus rejects missing scroll completeness',()=>focusRejection('scroll-complete-missing','ARCHIVE_FOCUS_SCROLL_COMPLETE',v=>delete after(v).scrollsComplete,afterContext));
test('archive focus rejects silently truncated scroll chain',()=>focusRejection('scroll-truncated','ARCHIVE_FOCUS_SCROLL_COMPLETE',v=>after(v).scrollsComplete=false,afterContext));
test('archive focus rejects empty scrolls hiding a Flickable ancestor',()=>focusRejection('scroll-omitted','ARCHIVE_FOCUS_SCROLL_SET',v=>after(v).scrolls=[],afterContext));
test('archive focus rejects duplicate scroll ancestor',()=>focusRejection('scroll-duplicate','ARCHIVE_FOCUS_SCROLL_BINDING',v=>after(v).scrolls.push(copy(after(v).scrolls[0])),{...afterContext,scroll:1}));
test('archive focus rejects missing Flickable type discriminator',()=>focusRejection('flickable-type-missing','ARCHIVE_FOCUS_ANCESTRY_STATE',v=>delete after(v).ancestry[0].isFlickable,{...afterContext,ancestor:0}));
test('archive focus rejects scroll record for a non-Flickable ancestor',()=>focusRejection('flickable-type-lie','ARCHIVE_FOCUS_SCROLL_SET',v=>after(v).ancestry[1].isFlickable=false,afterContext));
test('archive focus rejects missing causal record',()=>focusRejection('causal-missing','ARCHIVE_FOCUS_CAUSAL',v=>delete key(v).causal,keyContext));
test('archive focus rejects causal overflow',()=>focusRejection('causal-overflow','ARCHIVE_FOCUS_CAUSAL',v=>key(v).causal.overflow=true,keyContext));
test('archive focus rejects empty causal observations',()=>focusRejection('causal-empty','ARCHIVE_FOCUS_CAUSAL',v=>key(v).causal.events=[],keyContext));
test('archive focus rejects causal record beyond 32 events',()=>focusRejection('causal-limit','ARCHIVE_FOCUS_CAUSAL',v=>key(v).causal.events=Array.from({length:33},(_,sequence)=>({sequence,kind:'observed'})),keyContext));
test('archive focus rejects unordered causal sequence',()=>focusRejection('causal-order','ARCHIVE_FOCUS_CAUSAL_EVENT',v=>key(v).causal.events.push(copy(key(v).causal.events[0])),{...keyContext,event:1}));
test('archive focus rejects text-bearing causal fields',()=>focusRejection('causal-text','ARCHIVE_FOCUS_CAUSAL_FIELDS',v=>key(v).causal.events[0].body='forbidden',{...keyContext,event:0}));

const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const bytesHash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const focusContractPath=path.join(__dirname,'tests/archive-control-readiness-contract.json');
function nativeFilesFixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-focus-consumer-'));
  const directory=path.join(root,'focus');fs.mkdirSync(directory);
  const contractPath=path.join(root,'contract.json');fs.copyFileSync(focusContractPath,contractPath);
  const manifest={schema:C.nativeFocusEvidence.manifestSchema,contractSha256:bytesHash(fs.readFileSync(contractPath)),cases:[]};
  for(const spec of C.nativeFocusEvidence.cases) {
    const trace=focusTraceFixture();
    for(const row of trace.records) for(const edge of ['before','after']) {
      const snap=row[edge];snap.windowRect={x:0,y:0,width:spec.width,height:spec.height};snap.ancestry.at(-1).rect=copy(snap.windowRect);
    }
    const boundary={source:'native',caseId:spec.caseId,dataTag:spec.dataTag,scope:trace.scope,generation:trace.generation,
      windowToken:trace.windowToken,windowWidth:spec.width,windowHeight:spec.height,deadlineMs:4000,
      actionElapsedMs:60,afterElapsedMs:110,actionFrame:2,afterFrame:2};
    const value={schema:C.nativeFocusEvidence.schema,caseId:spec.caseId,trace,boundary};
    const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(directory,spec.filename),bytes);
    manifest.cases.push({caseId:spec.caseId,filename:spec.filename,sha256:bytesHash(bytes),bytes:bytes.length});
  }
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  return {root,directory,contractPath};
}
function nativeVerify(v) {return verifyNativeArchiveFocusEvidence(v.directory,v.contractPath);}
function disposeNative(v) {fs.rmSync(v.root,{recursive:true,force:true});}
const fileContext={kind:'native-focus'},firstCase=C.nativeFocusEvidence.cases[0],firstFileContext={...fileContext,caseId:firstCase.caseId};
function nativeReject(id,expectedReason,mutate,expectedContext=fileContext) {
  assertRejectedMutation({id,makeFixture:nativeFilesFixture,verify:nativeVerify,mutate,expectedReason,expectedContext,kind:'files',dispose:disposeNative});
}
function mutateRecord(v,mutate) {
  const file=path.join(v.directory,firstCase.filename),record=JSON.parse(fs.readFileSync(file,'utf8'));
  mutate(record);const bytes=Buffer.from(JSON.stringify(record));fs.writeFileSync(file,bytes);
  const fileManifest=path.join(v.directory,'manifest.json'),manifest=JSON.parse(fs.readFileSync(fileManifest,'utf8'));
  Object.assign(manifest.cases[0],{bytes:bytes.length,sha256:bytesHash(bytes)});fs.writeFileSync(fileManifest,JSON.stringify(manifest));
}
test('archive native focus consumer accepts three complete independently bound files',()=>{
  const v=nativeFilesFixture();try {const proof=nativeVerify(v);assert.deepEqual(proof.caseIds,C.nativeFocusEvidence.cases.map(c=>c.caseId));assert.deepEqual(JSON.parse(JSON.stringify(proof)),proof);} finally {disposeNative(v);}
});
test('archive native focus consumer rejects missing case file',()=>nativeReject('file-missing','ARCHIVE_FOCUS_FILE_SET',v=>fs.unlinkSync(path.join(v.directory,firstCase.filename))));
test('archive native focus consumer rejects extra file',()=>nativeReject('file-extra','ARCHIVE_FOCUS_FILE_SET',v=>fs.writeFileSync(path.join(v.directory,'extra.json'),'{}')));
test('archive native focus consumer rejects symlink record',()=>nativeReject('file-symlink','ARCHIVE_FOCUS_FILE_KIND',v=>{
  const file=path.join(v.directory,firstCase.filename),moved=path.join(v.root,'moved.json');fs.renameSync(file,moved);fs.symlinkSync(moved,file);
},firstFileContext));
test('archive native focus consumer rejects record bytes changed after manifest',()=>nativeReject('file-bytes','ARCHIVE_FOCUS_RECORD_HASH',v=>fs.appendFileSync(path.join(v.directory,firstCase.filename),' '),firstFileContext));
test('archive native focus consumer rejects malformed JSON as the specified reason',()=>nativeReject('file-json','ARCHIVE_FOCUS_FILE_JSON',v=>fs.writeFileSync(path.join(v.directory,firstCase.filename),'{'),firstFileContext));
test('archive native focus consumer rejects record above independent one MiB limit',()=>nativeReject('file-size','ARCHIVE_FOCUS_FILE_BOUND',v=>fs.writeFileSync(path.join(v.directory,firstCase.filename),' '.repeat(1048577)),firstFileContext));
test('archive native focus consumer rejects swapped case identities despite updated bytes',()=>nativeReject('case-swap','ARCHIVE_FOCUS_RECORD_BINDING',v=>mutateRecord(v,r=>r.caseId=C.nativeFocusEvidence.cases[1].caseId),firstFileContext));
test('archive native focus consumer rejects a synthetic GUI boundary',()=>nativeReject('gui-boundary','ARCHIVE_FOCUS_NATIVE_BOUNDARY',v=>mutateRecord(v,r=>r.boundary.source='gui'),firstFileContext));
test('archive native focus consumer rejects wrong registered window size',()=>nativeReject('window-size','ARCHIVE_FOCUS_NATIVE_BOUNDARY',v=>mutateRecord(v,r=>r.boundary.windowWidth=760),firstFileContext));
test('archive native focus consumer rejects an unbound trace window',()=>nativeReject('window-token','ARCHIVE_FOCUS_WINDOW',v=>mutateRecord(v,r=>r.trace.windowToken='other'),{...firstFileContext,phase:'tab-visible-controls',index:0,edge:'before'}));
test('archive native focus consumer rejects foreign record scope',()=>nativeReject('native-scope','ARCHIVE_FOCUS_CONTEXT',v=>mutateRecord(v,r=>r.trace.scope='foreign'),{...firstFileContext,phase:'tab-visible-controls'}));
test('archive native focus consumer rejects wrong data row identity',()=>nativeReject('data-row','ARCHIVE_FOCUS_NATIVE_BOUNDARY',v=>mutateRecord(v,r=>r.boundary.dataTag='other'),firstFileContext));
test('archive native focus consumer rejects late native terminal boundary',()=>nativeReject('native-late','ARCHIVE_FOCUS_NATIVE_BOUNDARY',v=>mutateRecord(v,r=>r.boundary.afterElapsedMs=4000),firstFileContext));
test('archive native focus consumer rejects manifest contract substitution',()=>nativeReject('contract-substitution','ARCHIVE_FOCUS_FILE_CONTRACT',v=>fs.writeFileSync(v.contractPath,'{}')));
test('archive native focus consumer rejects duplicate manifest case',()=>nativeReject('manifest-duplicate','ARCHIVE_FOCUS_MANIFEST_CASES',v=>{
  const f=path.join(v.directory,'manifest.json'),m=JSON.parse(fs.readFileSync(f));m.cases[1]=copy(m.cases[0]);fs.writeFileSync(f,JSON.stringify(m));
}));

test('archive native focus consumer rejects null trace without a TypeError',()=>nativeReject('null-trace','ARCHIVE_FOCUS_TRACE',v=>mutateRecord(v,r=>r.trace=null),{...firstFileContext,phase:'tab-visible-controls'}));

function regexFixture() { const value=fixture(); delete value.worldbookEntryFixture; value.worldbookRegexFixture={}; return value; }
test('archive readiness regex mode preserves the full ordinary action and focus proof',()=>{
  const previous=verifyArchiveControlReadiness(fixture()), current=verifyArchiveControlReadiness(regexFixture());
  assert.deepEqual(current,{...previous,mode:'regex'});
});
test('archive readiness regex mode rejects a conflicting inherited mode',()=>{
  assertRejectedMutation({id:'regex-mode-conflict',makeFixture:regexFixture,verify:verifyArchiveControlReadiness,
    mutate:v=>{v.worldbookEntryFixture={};},expectedReason:'ARCHIVE_MODE_CONFLICT',expectedContext:{cycle:0,mode:'regex'}});
});
test('archive readiness regex mode rejects additional unregistered baseline actions',()=>{
  assertRejectedMutation({id:'regex-extra-action',makeFixture:regexFixture,verify:verifyArchiveControlReadiness,
    mutate:v=>{v.reports[0].interaction.archiveControlReadiness.push(copy(first(v)));},
    expectedReason:'ARCHIVE_ACTION_SET',expectedContext:{cycle:1,group:'interaction'}});
});

function injectionFixture() {const value=fixture();delete value.worldbookEntryFixture;value.worldbookInjectionFixture={};return value;}
test('archive readiness injection preserves the full ordinary action and focus proof',()=>{
  const previous=verifyArchiveControlReadiness(fixture()),current=verifyArchiveControlReadiness(injectionFixture());
  assert.deepEqual(current,{...previous,mode:'injection'});
});
test('archive readiness injection rejects an inherited conflicting mode',()=>{
  assertRejectedMutation({id:'injection-mode-conflict',makeFixture:injectionFixture,verify:verifyArchiveControlReadiness,
    mutate:v=>{v.worldbookEntryFixture={};},expectedReason:'ARCHIVE_MODE_CONFLICT',expectedContext:{cycle:0,mode:'injection'}});
});
test('archive readiness injection rejects additional unregistered baseline actions',()=>{
  assertRejectedMutation({id:'injection-extra-action',makeFixture:injectionFixture,verify:verifyArchiveControlReadiness,
    mutate:v=>{v.reports[0].interaction.archiveControlReadiness.push(copy(first(v)));},
    expectedReason:'ARCHIVE_ACTION_SET',expectedContext:{cycle:1,group:'interaction'}});
});
