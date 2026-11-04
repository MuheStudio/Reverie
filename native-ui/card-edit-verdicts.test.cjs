'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {verifyCardEdit,captureCardEdit,verifySavedCardEdit,readPrivate,fingerprint} = require('./card-edit-verdicts.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])) : v;
const digest = v => sha(Buffer.from(JSON.stringify(sort(v))));
const encoded = v => Buffer.from(JSON.stringify(v)+'\n').toString('base64');
const info = value => {const b=Buffer.from(value,'base64');return {bytes:b.length,sha256:sha(b)};};
const fields = p => ({description:p.identity.description, personality_traits:p.personality_traits,tone:p.speaking_style.tone,
  first_message:p.identity.first_message,alternate_greetings:p.identity.alternate_greetings,message_example:p.identity.message_example});
const whole = () => ({found:true,visible:true,fullyVisible:true,sceneX:10,sceneY:10,sceneWidth:180,sceneHeight:30,
  clipX:0,clipY:0,clipWidth:300,clipHeight:100});
function fixture({legacy=false}={}) {
  const id='st_'+'a'.repeat(20), moon='st_'+'b'.repeat(20), frost='st_'+'c'.repeat(20), moonFp='d'.repeat(64), defaultFp='e'.repeat(64);
  const original={name:'测试人格·晴',age:24,gender:'unspecified',birthday:'',
    identity:{persona_id:id,identity_version:1,description:'合成观景室档案',import_sha256:'f'.repeat(64),import_source:'sillytavern_json',
      first_message:'你好',alternate_greetings:[],message_example:'',imported_system_prompt:'',imported_post_history_instructions:''},
    personality_traits:['安静','认真'],values:[],speaking_style:{tone:'安静，认真',catchphrases:[],never_say:[]},
    daily_life:{writes_diary:true},relationships:{},emotions:{calm:60},backstory:'合成观景室档案'};
  const v2=structuredClone(original);v2.identity.identity_version=2;
  v2.identity.description += '\n角色卡编辑验收：晴在独立观景室记录微风。';v2.backstory=v2.identity.description;
  v2.identity.alternate_greetings=['角色卡编辑验收问候：愿今天的微风陪伴你。'];
  const v3=structuredClone(v2);v3.identity.identity_version=3;v3.speaking_style.tone='温和、清晰，使用简短自然的句子。';
  const registeredPath = version => `imported/${id}/` + (version === 1 ? 'persona.json' :
    legacy ? `persona.v${version}.json` : `persona.v${version}-${fingerprint([original,v2,v3][version-1]).slice(0,16)}.json`);
  const versionPaths={v2:registeredPath(2),v3:registeredPath(3)};
  const cache=structuredClone(original);cache.name='内置人格';cache.identity.persona_id='default';
  const entry={id,name:original.name,persona_id:id,source_format:'sillytavern_json',source_sha256:original.identity.import_sha256,
    identity_version:3,identity_fingerprint:fingerprint(v3),persona_path:registeredPath(3)};
  const registry={active_id:'default',profiles:{[id]:entry,
    default:{id:'default',name:'内置人格',source_format:'builtin',identity_fingerprint:fingerprint(cache)},
    [moon]:{id:moon,name:'测试人格·月',source_format:'sillytavern_png',identity_fingerprint:moonFp},
    [frost]:{id:frost,name:'测试人格·霜',source_format:'sillytavern_png',identity_fingerprint:'0'.repeat(64)}}};
  const otherRegistrySha256=digest({...registry,active_id:moon,
    profiles:Object.fromEntries(Object.entries(registry.profiles).filter(([key])=>key !== id))});
  const files={original:encoded(original),v2:encoded(v2),v3:encoded(v3),importReport:encoded({source_sha256:entry.source_sha256}),
    registry:encoded(registry),cache:encoded(cache)};
  const personas=active=>[{id:'default',name:'内置人格',source_format:'builtin',active:active==='default'},
    {id,name:'测试人格·晴',source_format:'sillytavern_json',active:active===id},
    {id:moon,name:'测试人格·月',source_format:'sillytavern_png',active:active===moon},
    {id:frost,name:'测试人格·霜',source_format:'sillytavern_png',active:active===frost}];
  const row=(profileId,enabled)=>({profileId,enabled,button:whole(),noticeVisible:!enabled,notice:enabled?{}:whole()});
  const input=(step,control,scope,generation)=>({step,control,scope,generation,
    layout:{ready:true,layoutStable:true,enabled:true,visible:true,found:true,fullyVisible:true,integerPointInsideClip:true,
      elapsedMs:80,stableSinceMs:40,frameSerial:3,stableFrameSerial:2},
    gate:{performed:true,sampleLimit:6,pollIntervalMs:40,last:{ready:true,elapsedMs:80}},
    signals:[8,10,14].includes(step)?{kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true}
      :{kind:'button',mouseDispatchCount:1,clickedSignals:1}});
  const groups=[0,1].map(cycle=> {
    const active=cycle?'default':moon, fp=cycle?defaultFp:moonFp, epoch=cycle?6:12, generation=cycle?8:15;
    const scope=`${active}:${epoch}:${fp}`, targetScope=`${id}:${epoch+1}:${fingerprint(v3)}`, returnScope=`${active}:${epoch+2}:${fp}`;
    const before={activeId:active,scope,generation,profiles:personas(active),messageIds:[`message_${cycle}_01`],archiveRevision:cycle?20:5,
      archiveHash:'1'.repeat(64),authorHash:'2'.repeat(64),runtimeWritable:true,recoveryState:'clean'};
    const after={...structuredClone(before),scope:returnScope,generation:generation+2};
    const saves=cycle?[]:[v2,v3].map((p,n)=>({requestId:`card_edit_save_${n+2}`,profileId:id,version:n+2,fingerprint:fingerprint(p),fields:fields(p),
      scopeBefore:scope,scopeAfter:scope,generationBefore:generation,generationAfter:generation,active:false}));
    const steps=cycle?[1,6,18,20,21,23,24]:[1,6,8,9,10,11,12,14,15,16,18,20,21,23,24];
    const controls={1:'nav-character',6:'personaEdit_1',8:'personaProfileDescription',9:'personaProfileAddGreeting',10:'personaProfileGreeting_0',
      11:'personaProfileSave',12:'personaProfileConfirmSave',14:'personaProfileTone',15:'personaProfileSave',16:'personaProfileConfirmSave',
      18:'personaProfileCancel',20:'personaSwitch-'+id,21:'personaSwitchConfirm',23:'personaSwitch-'+active,24:'personaSwitchConfirm'};
    const names=cycle?['restart-third-version-read-back','edited-persona-version-three-mounted-writable',
      'return-preserves-original-persona-archive-history-and-author-switches']:
      ['current-and-builtin-disabled-other-imports-editable','inactive-description-and-greeting-saved-as-version-two',
        'inactive-tone-saved-as-version-three','edited-persona-version-three-mounted-writable',
        'return-preserves-original-persona-archive-history-and-author-switches'];
    return {schema:'reverie.native.card-edit.gui-evidence.v1',passed:true,error:'',mode:cycle?'restart-readback':'edit-and-mount',profileId:id,
      profileName:'测试人格·晴',previouslyMounted:true,deadlineMs:cycle?20000:45000,elapsedMs:1000,checks:names.map(name=>({name,passed:true})),
      before,after,reads:[{profileId:id,version:cycle?3:1,fingerprint:fingerprint(cycle?v3:original),fields:fields(cycle?v3:original),requestId:`read_${cycle}_001`}],
      saves,fields:fields(v3),modelCalls:0,inputs:steps.map(step=>input(step,controls[step],step>=23?targetScope:scope,step>=23?generation+1:generation)),
      switches:[{targetId:id,sourceId:active,scopeBefore:scope,scopeAfter:targetScope,generationBefore:generation,generationAfter:generation+1,
        runtimeWritable:true,recoveryState:'clean'},
      {targetId:active,sourceId:id,scopeBefore:targetScope,scopeAfter:returnScope,generationBefore:generation+1,generationAfter:generation+2,
        runtimeWritable:true,recoveryState:'clean'}],
      observations:{builtin:row('default',false),active:row(moon,false),target:row(id,true),otherImported:row(frost,true),mountedTarget:row(id,false)}};
  });
  const backend=[v2,v3].map((persona,n)=> {
    const make=(version)=>({scope:{persona_id:moon,persona_epoch:12,persona_fingerprint:moonFp},activeId:moon,
      profile:{id,name:original.name,persona_id:id,source_format:entry.source_format,source_sha256:entry.source_sha256,
        identity_version:version,identity_fingerprint:fingerprint([original,v2,v3][version-1]),
        ...(legacy?{}:{persona_path:registeredPath(version)})},otherRegistrySha256,
      original:info(files.original),importReport:info(files.importReport),cache:info(files.cache),
      v2:version>=2?{...info(files.v2),...(legacy?{}:{path:registeredPath(2)})}:null,
      v3:version>=3?{...info(files.v3),...(legacy?{}:{path:registeredPath(3)})}:null});
    return {schema:'reverie.native.card-edit.backend-evidence.v1',event:'update',cycle:1,requestId:`card_edit_save_${n+2}`,profileId:id,
      before:make(n+1),after:make(n+2),result:{ok:true,version:n+2,fingerprint:fingerprint(persona),active:false,fieldsSha256:digest(fields(persona))}};
  });
  const result={cardEditContract:'v1',requests:28,modelCalls:Array.from({length:28},()=>({kind:'preserved-fixture'})),reports:groups.map((cardEdit,index)=>({cardEdit,
    personas:{profiles:cardEdit.after.profiles},messages:cardEdit.after.messageIds.map(id=>({id})),
    ...(index?{}:{archiveInteraction:{cardImport:{moonPersona:moon}},
      worldbookPriority:{observed:{sunnyPersonaId:id,sunnyBefore:{personaId:id},sunnyTerminal:{personaId:id}}}})}))};
  const artifact={schema:'reverie.native.card-edit.saved-artifact.v1',profileId:id,files,backend,
    ...(legacy?{}:{versionPaths})};
  return {result,artifact,id,original,v2,v3,registry};
}
function liveFiles(t,v) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-card-edit-proof-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'isolation'),report=path.join(root,'report'),persona=path.join(data,'data/persona');
  const directory=path.join(persona,'imported',v.id);fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(report);
  const names={original:path.join(directory,'persona.json'),v2:path.join(persona,v.artifact.versionPaths.v2),
    v3:path.join(persona,v.artifact.versionPaths.v3),importReport:path.join(directory,'import-report.json'),
    registry:path.join(persona,'registry.json'),cache:path.join(persona,'active.json')};
  for (const [key,file] of Object.entries(names)) fs.writeFileSync(file,Buffer.from(v.artifact.files[key],'base64'),
    {mode:['v2','v3'].includes(key)?0o600:0o644});
  const metadata=path.join(data,'p1-card-edit-metadata.jsonl');
  fs.writeFileSync(metadata,v.artifact.backend.map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600});
  const orphan=path.join(directory,'persona.v2.json');
  fs.writeFileSync(orphan,'unreferenced legacy orphan\n',{mode:0o600});
  return {data,report,names,metadata,orphan};
}
test('card edit verifies two real-save receipts, immutable versions, independent inputs and four switches',()=> {
  const v=fixture(),proof=verifyCardEdit(v.result,v.artifact);
  assert.deepEqual(proof.cycleChecks,[5,3]);assert.deepEqual(proof.inputCounts,[15,7]);assert.deepEqual(proof.switchCounts,[2,2]);
  assert.equal(proof.modelCalls,0);assert.equal(proof.fingerprint,fingerprint(v.v3));
});
test('card edit rejects changed original or version-two bytes and a forged registry fingerprint',()=> {
  for (const key of ['original','v2']) {
    const v=fixture();v.artifact.files[key]=Buffer.from(Buffer.from(v.artifact.files[key],'base64').toString()+' ').toString('base64');
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_(ORIGINAL_BYTES_CHANGED|VERSION_BYTES_CHANGED)/);
  }
  const v=fixture();v.registry.profiles[v.id].identity_fingerprint='0'.repeat(64);v.artifact.files.registry=encoded(v.registry);
  assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_REGISTRY_FINGERPRINT/);
});
test('card edit rejects an uneditable name, demography, author prompt or import source change',()=> {
  for (const change of [p=>{p.name='别的人格';},p=>{p.age=25;},p=>{p.identity.imported_system_prompt='changed';},p=>{p.identity.import_sha256='0'.repeat(64);}]) {
    const v=fixture();change(v.v3);v.artifact.files.v3=encoded(v.v3);
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_(VERSION_FILE_IDENTITY|UNEDITABLE_FIELD_CHANGED)/);
  }
});
test('card edit rejects save-side cache, scope or other-profile mutation',()=> {
  for (const change of [e=>{e.after.cache.sha256='0'.repeat(64);},e=>{e.after.scope.persona_epoch++;},e=>{e.after.otherRegistrySha256='0'.repeat(64);}]) {
    const v=fixture();change(v.artifact.backend[0]);
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_(SAVE_CHANGED_CACHE|SAVE_CHANGED_SCOPE|OTHER_PROFILE_CHANGED)/);
  }
});
test('card edit rejects missing, duplicate or foreign backend save acknowledgements',()=> {
  const v=fixture();v.artifact.backend.pop();assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_BACKEND_COUNT/);
  const w=fixture();w.artifact.backend[1]=structuredClone(w.artifact.backend[0]);assert.throws(()=>verifyCardEdit(w.result,w.artifact),/CARD_EDIT_BACKEND_IDENTITY/);
  const x=fixture();x.artifact.backend[0].result.active=true;assert.throws(()=>verifyCardEdit(x.result,x.artifact),/CARD_EDIT_BACKEND_RECEIPT/);
});
test('card edit rejects restart writes, missing return, modified old history and a locked mounted runtime',()=> {
  for (const change of [g=>{g.saves=[{}];},g=>{g.after.activeId=g.profileId;},g=>{g.after.messageIds.push('extra_message');},g=>{g.switches[0].recoveryState='recovery_required';}]) {
    const v=fixture();change(v.result.reports[1].cardEdit);
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_(SAVE_COUNT|RETURN_BASELINE|SWITCH_IDENTITY)/);
  }
});
test('card edit rejects stale save binding and wrong version-three restart readback',()=> {
  const v=fixture();v.result.reports[0].cardEdit.saves[0].scopeBefore='wrong';
  assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_(BACKEND_SCOPE_BINDING|SAVE_BINDING)/);
  const w=fixture();w.result.reports[1].cardEdit.reads[0].version=2;
  assert.throws(()=>verifyCardEdit(w.result,w.artifact),/CARD_EDIT_READBACK/);
});
test('card edit rejects input repetition, stale geometry, disabled builtin without notice and model calls',()=> {
  for (const change of [g=>{g.inputs.push(g.inputs[0]);},g=>{g.inputs[0].layout.frameSerial=2;},
    g=>{g.observations.builtin.noticeVisible=false;},g=>{g.modelCalls=1;}]) {
    const v=fixture();change(v.result.reports[0].cardEdit);
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_(INPUT_COUNT|INPUT_STABILITY|DISABLED_NOTICE|GUI_GROUP)/);
  }
});
test('card edit preserves the exact existing model request count',()=> {
  const v=fixture();v.result.requests=29;
  assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_MODEL_REQUEST_COUNT/);
  const w=fixture();w.result.modelCalls.pop();
  assert.throws(()=>verifyCardEdit(w.result,w.artifact),/CARD_EDIT_MODEL_REQUEST_COUNT/);
});
test('card edit accepts legacy 0644 files, requires private new versions and replays after isolation is removed',t=> {
  const v=fixture(),{data,report,names,orphan}=liveFiles(t,v),orphanBefore=fs.readFileSync(orphan);
  v.result.cardEditEvidence=captureCardEdit(v.result,data,report);
  assert.deepEqual(v.result.cardEditEvidence.versionPaths,v.artifact.versionPaths);
  assert.deepEqual(fs.readFileSync(orphan),orphanBefore);
  for (const key of ['v2','v3']) {
    fs.chmodSync(names[key],0o644);
    assert.throws(()=>captureCardEdit(v.result,data,report),/CARD_EDIT_FILE_NOT_PRIVATE_REGULAR/);
    fs.chmodSync(names[key],0o600);
  }
  fs.rmSync(data,{recursive:true});
  assert.deepEqual(verifySavedCardEdit(v.result,report),v.result.cardEditEvidence);
  v.result.cardEditEvidence.fingerprint='0'.repeat(64);
  assert.throws(()=>verifySavedCardEdit(v.result,report),/CARD_EDIT_SAVED_PROOF_CHANGED/);
});
test('card edit binds each observed registry path to its version and fingerprint prefix',()=> {
  for (const wrong of ['persona.v2.json','persona.v3-aaaaaaaaaaaaaaaa.json','persona.v2-0000000000000000.json',
    '../persona.v2.json','/tmp/persona.v2.json']) {
    const v=fixture();v.artifact.versionPaths.v2=wrong.startsWith('persona.')?`imported/${v.id}/${wrong}`:wrong;
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_VERSION_PATH/);
  }
  const v=fixture();v.artifact.backend[1].before.profile.persona_path=`imported/${v.id}/persona.v2-${'0'.repeat(16)}.json`;
  assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_VERSION_PATH/);
});
test('card edit rejects missing unknown or extra versionPaths keys',()=> {
  for (const change of [p=>{delete p.v2;},p=>{p.v4=p.v3;},p=>{p.unknown=p.v2;delete p.v2;}]) {
    const v=fixture();change(v.artifact.versionPaths);
    assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_VERSION_PATH_FIELDS/);
  }
});
test('new live capture refuses missing registry paths and old names without a legacy fallback',t=> {
  for (const where of ['first-missing','first-old-name','final-missing','final-old-name']) {
    const v=fixture(),{data,report,names,metadata}=liveFiles(t,v);
    const selected=where.startsWith('first')?v.artifact.backend[0].after.profile:v.registry.profiles[v.id];
    if (where.endsWith('missing')) delete selected.persona_path;
    else selected.persona_path=`imported/${v.id}/persona.v${where.startsWith('first')?2:3}.json`;
    fs.writeFileSync(names.registry,Buffer.from(JSON.stringify(v.registry)+'\n'));
    fs.writeFileSync(metadata,v.artifact.backend.map(e=>JSON.stringify(e)).join('\n')+'\n');
    assert.throws(()=>captureCardEdit(v.result,data,report),/CARD_EDIT_VERSION_PATH/);
    assert.equal(fs.existsSync(path.join(report,'card-edit-proof.json')),false);
  }
});
test('legacy fixed-name saved artifacts retain the old proof shape and replay without live files',t=> {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-card-edit-legacy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const v=fixture({legacy:true}),proof=verifyCardEdit(v.result,v.artifact),bytes=Buffer.from(JSON.stringify(v.artifact)+'\n');
  assert.equal(Object.hasOwn(proof,'versionPaths'),false);
  const file=path.join(root,'card-edit-proof.json');fs.writeFileSync(file,bytes,{mode:0o600});
  v.result.cardEditEvidence={...proof,artifact:{path:'card-edit-proof.json',bytes:bytes.length,sha256:sha(bytes)}};
  assert.deepEqual(verifySavedCardEdit(v.result,root),v.result.cardEditEvidence);
  assert.deepEqual(fs.readFileSync(file),bytes);
});
test('card edit refuses linked files, public modes and duplicate identity JSON keys',t=> {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-card-edit-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'file.json'),link=path.join(root,'link.json');fs.writeFileSync(file,'{}',{mode:0o600});
  fs.symlinkSync(file,link);assert.throws(()=>readPrivate(link),/CARD_EDIT_FILE_NOT_PRIVATE_REGULAR/);fs.unlinkSync(link);
  fs.linkSync(file,link);assert.throws(()=>readPrivate(file),/CARD_EDIT_FILE_NOT_PRIVATE_REGULAR/);fs.unlinkSync(link);
  fs.chmodSync(file,0o644);assert.throws(()=>readPrivate(file),/CARD_EDIT_FILE_NOT_PRIVATE_REGULAR/);
  const v=fixture();v.artifact.files.v3=Buffer.from(Buffer.from(v.artifact.files.v3,'base64').toString().replace('"age":24','"age":24,"age":24')).toString('base64');
  assert.throws(()=>verifyCardEdit(v.result,v.artifact),/CARD_EDIT_DUPLICATE_JSON_KEY/);
});
