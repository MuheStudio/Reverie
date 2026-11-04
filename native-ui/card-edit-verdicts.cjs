'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const CARD_EDIT_CONTRACT = 'v1';
const ARTIFACT = 'card-edit-proof.json';
const MAX_BYTES = 262144;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
const canonical = value => JSON.stringify(sort(value));
const digest = value => sha(Buffer.from(canonical(value)));
const isSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ident = value => typeof value === 'string' && /^[A-Za-z0-9_-]{4,128}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function exact(value, expected, code) {
  assert(value && typeof value === 'object' && !Array.isArray(value),code);
  assert.deepEqual(Object.keys(value).sort(),expected.slice().sort(),code);
}
const FIRST_CHECKS = ['current-and-builtin-disabled-other-imports-editable',
  'inactive-description-and-greeting-saved-as-version-two', 'inactive-tone-saved-as-version-three',
  'edited-persona-version-three-mounted-writable', 'return-preserves-original-persona-archive-history-and-author-switches'];
const RESTART_CHECKS = ['restart-third-version-read-back', 'edited-persona-version-three-mounted-writable',
  'return-preserves-original-persona-archive-history-and-author-switches'];
const DESCRIPTION_SUFFIX = '\n角色卡编辑验收：晴在独立观景室记录微风。';
const GREETING = '角色卡编辑验收问候：愿今天的微风陪伴你。';
const TONE = '温和、清晰，使用简短自然的句子。';

function readPrivate(filename, maximum = MAX_BYTES, requirePrivate = true) {
  const before = fs.lstatSync(filename);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 &&
    (!process.getuid || before.uid === process.getuid()) && (!requirePrivate || !(before.mode & 0o077)) &&
    before.size > 0 && before.size <= maximum, 'CARD_EDIT_FILE_NOT_PRIVATE_REGULAR');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    assert(opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1, 'CARD_EDIT_FILE_IDENTITY_CHANGED');
    const bounded = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < bounded.length) {
      const count = fs.readSync(fd, bounded, length, bounded.length - length, null);
      if (!count) break; length += count;
    }
    const after = fs.fstatSync(fd), named = fs.lstatSync(filename);
    assert(length === opened.size && after.size === opened.size && after.mtimeMs === opened.mtimeMs &&
      after.ctimeMs === opened.ctimeMs && named.dev === opened.dev && named.ino === opened.ino && named.nlink === 1,
      'CARD_EDIT_FILE_CHANGED_DURING_READ');
    return bounded.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function decode(encoded) {
  assert(typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_BYTES / 3) * 4, 'CARD_EDIT_ARTIFACT_FILE_SIZE');
  const bytes = Buffer.from(encoded, 'base64');
  assert(bytes.length > 0 && bytes.length <= MAX_BYTES && bytes.toString('base64') === encoded, 'CARD_EDIT_ARTIFACT_BASE64');
  return bytes;
}
function json(bytes) {
  const text = bytes.toString('utf8'); assert(Buffer.from(text).equals(bytes), 'CARD_EDIT_FILE_UTF8');
  // Detect duplicates before JSON.parse can discard an earlier identity field.
  let at = 0;
  const space = () => { while (at < text.length && /\s/.test(text[at])) ++at; };
  const string = () => {
    const start = at++;
    while (at < text.length) { const ch = text[at++]; if (ch === '\\') { ++at; continue; }
      if (ch === '"') return JSON.parse(text.slice(start, at)); }
    assert.fail('CARD_EDIT_INVALID_JSON');
  };
  const value = depth => {
    assert(depth < 32, 'CARD_EDIT_JSON_DEPTH'); space();
    if (text[at] === '{') {
      ++at; space(); const keys = new Set(); if (text[at] === '}') { ++at; return; }
      while (true) { space(); assert.equal(text[at], '"', 'CARD_EDIT_INVALID_JSON'); const key = string();
        assert(!keys.has(key), 'CARD_EDIT_DUPLICATE_JSON_KEY'); keys.add(key); space();
        assert.equal(text[at++], ':', 'CARD_EDIT_INVALID_JSON'); value(depth + 1); space();
        const end = text[at++]; if (end === '}') return; assert.equal(end, ',', 'CARD_EDIT_INVALID_JSON'); }
    }
    if (text[at] === '[') {
      ++at; space(); if (text[at] === ']') { ++at; return; }
      while (true) { value(depth + 1); space(); const end = text[at++]; if (end === ']') return;
        assert.equal(end, ',', 'CARD_EDIT_INVALID_JSON'); }
    }
    if (text[at] === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    assert(token, 'CARD_EDIT_INVALID_JSON'); at += token[0].length;
    assert(typeof JSON.parse(token[0]) !== 'number' || Number.isFinite(JSON.parse(token[0])), 'CARD_EDIT_NONFINITE_JSON');
  };
  value(0); space(); assert.equal(at, text.length, 'CARD_EDIT_TRAILING_JSON'); return JSON.parse(text);
}
function fields(persona) {
  return {description:persona.identity.description, personality_traits:persona.personality_traits,
    tone:persona.speaking_style.tone, first_message:persona.identity.first_message,
    alternate_greetings:persona.identity.alternate_greetings, message_example:persona.identity.message_example};
}
function fingerprint(persona) {
  const core = {name:persona.name, gender:persona.gender, birthday:persona.birthday, age_at_version:persona.age,
    identity:persona.identity, personality_traits:persona.personality_traits, values:persona.values,
    speaking_style:persona.speaking_style, daily_life:persona.daily_life, relationships:persona.relationships,
    backstory:persona.backstory, version:persona.identity.identity_version};
  return digest(core);
}
function registeredVersionPath(id, version, fingerprint, relative) {
  assert(typeof id === 'string' && /^st_[a-f0-9]{20}$/.test(id) && integer(version) && version >= 1 &&
    isSha(fingerprint) && typeof relative === 'string', 'CARD_EDIT_VERSION_PATH');
  const name = version === 1 ? 'persona.json' : `persona.v${version}-${fingerprint.slice(0,16)}.json`;
  assert.equal(relative,`imported/${id}/${name}`,'CARD_EDIT_VERSION_PATH');
  return relative; // The registry supplies the path. The name above only validates it.
}
function unedited(persona) {
  const copy = structuredClone(persona);
  delete copy.identity.identity_version; delete copy.identity.description; delete copy.identity.alternate_greetings;
  delete copy.speaking_style.tone; delete copy.backstory; return copy;
}
function scope(value) {
  assert(typeof value === 'string', 'CARD_EDIT_SCOPE'); const parts = value.split(':');
  assert(parts.length === 3 && ident(parts[0]) && /^\d+$/.test(parts[1]) && isSha(parts[2]), 'CARD_EDIT_SCOPE');
  const epoch = Number(parts[1]); assert(integer(epoch), 'CARD_EDIT_SCOPE');
  return {id:parts[0],epoch,fingerprint:parts[2]};
}
function whole(value) {
  assert(value?.found === true && value.visible === true && value.fullyVisible === true, 'CARD_EDIT_CLIPPED_CONTROL');
  for (const key of ['sceneX','sceneY','sceneWidth','sceneHeight','clipX','clipY','clipWidth','clipHeight'])
    assert(Number.isFinite(value[key]), 'CARD_EDIT_INVALID_GEOMETRY');
  assert(value.sceneWidth > 1 && value.sceneHeight > 1 && value.clipWidth > 0 && value.clipHeight > 0 &&
    value.sceneX + .5 >= value.clipX && value.sceneY + .5 >= value.clipY &&
    value.sceneX + value.sceneWidth - .5 <= value.clipX + value.clipWidth &&
    value.sceneY + value.sceneHeight - .5 <= value.clipY + value.clipHeight, 'CARD_EDIT_CLIPPED_CONTROL');
}
function input(record, step, control) {
  assert(record?.step === step && record.control === control && integer(record.generation), 'CARD_EDIT_INPUT_ORDER');
  scope(record.scope); const l = record.layout, g = record.gate;
  assert(l?.ready === true && l.layoutStable === true && l.enabled === true && l.visible === true &&
    l.found === true && l.fullyVisible === true && l.integerPointInsideClip === true, 'CARD_EDIT_INPUT_NOT_READY');
  assert(integer(l.elapsedMs) && l.elapsedMs < 4000 && integer(l.stableSinceMs) && l.elapsedMs - l.stableSinceMs >= 40 &&
    integer(l.frameSerial) && integer(l.stableFrameSerial) && l.frameSerial > l.stableFrameSerial, 'CARD_EDIT_INPUT_STABILITY');
  assert(g?.performed === true && g.sampleLimit === 6 && g.pollIntervalMs === 40 && g.last?.ready === true &&
    integer(g.last.elapsedMs) && g.last.elapsedMs < 4000, 'CARD_EDIT_INPUT_GATE');
  const signals = record.signals;
  if ([8,10,14].includes(step)) assert.deepEqual(signals,
    {kind:'text',mouseDispatchCount:1,commitCount:1,focusInTarget:true}, 'CARD_EDIT_TEXT_INPUT');
  else assert.deepEqual(signals, {kind:'button',mouseDispatchCount:1,clickedSignals:1}, 'CARD_EDIT_BUTTON_INPUT');
}

function verifyCardEdit(result, artifact) {
  assert.equal(result.cardEditContract, CARD_EDIT_CONTRACT, 'CARD_EDIT_RESULT_CONTRACT');
  assert(result.requests === 28 && Array.isArray(result.modelCalls) && result.modelCalls.length === 28,
    'CARD_EDIT_MODEL_REQUEST_COUNT');
  assert(artifact?.schema === 'reverie.native.card-edit.saved-artifact.v1', 'CARD_EDIT_ARTIFACT_SCHEMA');
  // New captures retain the registered paths. Absence is solely the saved
  // pre-fix artifact format; live capture below never selects that branch.
  const hasVersionPaths = Object.hasOwn(artifact,'versionPaths');
  exact(artifact,['schema','profileId','files','backend',...(hasVersionPaths?['versionPaths']:[])],'CARD_EDIT_ARTIFACT_FIELDS');
  if (hasVersionPaths) exact(artifact.versionPaths,['v2','v3'],'CARD_EDIT_VERSION_PATH_FIELDS');
  assert(Array.isArray(result.reports) && result.reports.length === 2, 'CARD_EDIT_TWO_CYCLES');
  const groups = result.reports.map(report => report.cardEdit), [first,restart] = groups;
  const id = first?.profileId;
  assert(typeof id === 'string' && /^st_[a-f0-9]{20}$/.test(id) && artifact.profileId === id, 'CARD_EDIT_PROFILE_ID');
  const oldPriority = result.reports[0].worldbookPriority?.observed;
  assert(oldPriority?.sunnyPersonaId === id && oldPriority.sunnyBefore?.personaId === id &&
    oldPriority.sunnyTerminal?.personaId === id, 'CARD_EDIT_PREVIOUS_MOUNT_EVIDENCE');
  const raw = Object.fromEntries(Object.entries(artifact.files || {}).map(([key,value]) => [key,decode(value)]));
  assert.deepEqual(Object.keys(raw).sort(), ['cache','importReport','original','registry','v2','v3'].sort(), 'CARD_EDIT_FILE_SET');
  const original = json(raw.original), v2 = json(raw.v2), v3 = json(raw.v3), registry = json(raw.registry);
  const profile = registry.profiles?.[id], versions = [original,v2,v3];
  assert.deepEqual(Object.keys(registry.profiles || {}).sort(),first.before.profiles.map(p=>p.id).sort(),'CARD_EDIT_REGISTRY_PROFILE_SET');
  for (const row of first.before.profiles) {
    const stored = registry.profiles[row.id];
    assert(stored?.id === row.id && stored.name === row.name && stored.source_format === row.source_format,
      'CARD_EDIT_REGISTRY_LIST_MISMATCH');
  }
  assert(profile?.id === id && profile.persona_id === id && profile.name === '测试人格·晴' && profile.identity_version === 3,
    'CARD_EDIT_REGISTRY_PROFILE');
  versions.forEach((persona,index) => {
    assert(persona?.name === '测试人格·晴' && persona.age === 24 && persona.identity?.persona_id === id &&
      persona.identity.identity_version === index + 1 && persona.identity.description === persona.backstory,
      'CARD_EDIT_VERSION_FILE_IDENTITY');
    assert.deepEqual(unedited(persona), unedited(original), 'CARD_EDIT_UNEDITABLE_FIELD_CHANGED');
  });
  assert.equal(profile.identity_fingerprint, fingerprint(v3), 'CARD_EDIT_REGISTRY_FINGERPRINT');
  if (hasVersionPaths) {
    assert.equal(registeredVersionPath(id,3,profile.identity_fingerprint,profile.persona_path),artifact.versionPaths.v3,
      'CARD_EDIT_FINAL_VERSION_PATH');
    registeredVersionPath(id,2,fingerprint(v2),artifact.versionPaths.v2);
  } else {
    assert.equal(profile.persona_path,`imported/${id}/persona.v3.json`,'CARD_EDIT_LEGACY_REGISTRY_PATH');
  }
  assert.equal(profile.source_sha256, original.identity.import_sha256, 'CARD_EDIT_IMPORT_SOURCE_CHANGED');
  assert.equal(profile.source_format, original.identity.import_source, 'CARD_EDIT_IMPORT_SOURCE_CHANGED');
  assert.equal(v2.identity.description, original.identity.description + DESCRIPTION_SUFFIX, 'CARD_EDIT_DESCRIPTION');
  assert.deepEqual(v2.identity.alternate_greetings, [GREETING], 'CARD_EDIT_GREETING');
  assert.equal(v2.speaking_style.tone, original.speaking_style.tone, 'CARD_EDIT_FIRST_TONE_CHANGED');
  assert.equal(v3.speaking_style.tone, TONE, 'CARD_EDIT_TONE');
  assert.equal(v3.identity.description, v2.identity.description, 'CARD_EDIT_SECOND_DESCRIPTION_CHANGED');
  assert.deepEqual(v3.identity.alternate_greetings, v2.identity.alternate_greetings, 'CARD_EDIT_SECOND_GREETING_CHANGED');
  const metadata = artifact.backend;
  assert(Array.isArray(metadata) && metadata.length === 2, 'CARD_EDIT_BACKEND_COUNT');
  const hashes = Object.fromEntries(Object.entries(raw).map(([key,bytes]) => [key,{bytes:bytes.length,sha256:sha(bytes)}]));
  const versionInfo = key => hasVersionPaths ? {...hashes[key],path:artifact.versionPaths[key]} : hashes[key];
  metadata.forEach((event,index) => {
    const version = index + 2, before = event.before, after = event.after, receipt = first.saves?.[index];
    exact(event,['schema','event','cycle','requestId','profileId','before','after','result'],'CARD_EDIT_BACKEND_FIELDS');
    exact(event.result,['ok','version','fingerprint','active','fieldsSha256'],'CARD_EDIT_BACKEND_RESULT_FIELDS');
    for (const snapshot of [before,after]) {
      exact(snapshot,['scope','activeId','profile','otherRegistrySha256','original','importReport','v2','v3','cache'],'CARD_EDIT_BACKEND_SNAPSHOT_FIELDS');
      exact(snapshot.scope,['persona_id','persona_epoch','persona_fingerprint'],'CARD_EDIT_BACKEND_SCOPE_FIELDS');
      exact(snapshot.profile,['id','name','persona_id','source_format','source_sha256','identity_version','identity_fingerprint',
        ...(hasVersionPaths?['persona_path']:[])],'CARD_EDIT_BACKEND_PROFILE_FIELDS');
      if (hasVersionPaths) registeredVersionPath(id,snapshot.profile.identity_version,
        snapshot.profile.identity_fingerprint,snapshot.profile.persona_path);
      for (const key of ['original','importReport','v2','v3','cache']) if (snapshot[key] !== null) {
        const versionFile = hasVersionPaths && ['v2','v3'].includes(key);
        exact(snapshot[key],['bytes','sha256',...(versionFile?['path']:[])],'CARD_EDIT_FILE_METADATA_FIELDS');
        assert(integer(snapshot[key].bytes) && snapshot[key].bytes > 0 && snapshot[key].bytes <= MAX_BYTES &&
          isSha(snapshot[key].sha256),'CARD_EDIT_FILE_METADATA');
        if (versionFile) assert.equal(snapshot[key].path,artifact.versionPaths[key],'CARD_EDIT_OBSERVED_VERSION_PATH');
      }
    }
    assert(event.schema === 'reverie.native.card-edit.backend-evidence.v1' && event.event === 'update' && event.cycle === 1 &&
      event.profileId === id && ident(event.requestId) && receipt?.requestId === event.requestId, 'CARD_EDIT_BACKEND_IDENTITY');
    assert(event.result?.ok === true && event.result.active === false && event.result.version === version &&
      event.result.fingerprint === fingerprint(versions[version-1]) && event.result.fieldsSha256 === digest(fields(versions[version-1])),
      'CARD_EDIT_BACKEND_RECEIPT');
    assert.deepEqual(after.scope,before.scope,'CARD_EDIT_SAVE_CHANGED_SCOPE');
    assert(`${before.scope?.persona_id}:${before.scope?.persona_epoch}:${before.scope?.persona_fingerprint}` === receipt.scopeBefore,
      'CARD_EDIT_BACKEND_SCOPE_BINDING');
    assert(before.activeId === first.before.activeId && after.activeId === before.activeId && before.activeId !== id,
      'CARD_EDIT_SAVE_CHANGED_ACTIVE');
    assert.equal(after.otherRegistrySha256,before.otherRegistrySha256,'CARD_EDIT_OTHER_PROFILE_CHANGED');
    assert(isSha(before.otherRegistrySha256), 'CARD_EDIT_OTHER_REGISTRY_HASH');
    for (const key of ['original','importReport','cache']) assert.deepEqual(after[key],before[key], 'CARD_EDIT_SAVE_CHANGED_' + key.toUpperCase());
    assert(integer(before.cache?.bytes) && before.cache.bytes > 0 && isSha(before.cache.sha256),'CARD_EDIT_CACHE_METADATA');
    assert.deepEqual(after.original, hashes.original, 'CARD_EDIT_ORIGINAL_BYTES_CHANGED');
    assert.deepEqual(after.importReport,hashes.importReport,'CARD_EDIT_IMPORT_REPORT_CHANGED');
    assert(before.profile.identity_version === version-1 && after.profile.identity_version === version &&
      before.profile.identity_fingerprint === fingerprint(versions[version-2]) &&
      after.profile.identity_fingerprint === fingerprint(versions[version-1]), 'CARD_EDIT_SAVE_REGISTRY_VERSION');
    assert.deepEqual(after['v'+version],versionInfo('v'+version), 'CARD_EDIT_VERSION_BYTES_CHANGED');
    if (index) {
      assert.deepEqual(before.v2,after.v2,'CARD_EDIT_VERSION_TWO_OVERWRITTEN');
      assert.deepEqual(after.v2,versionInfo('v2'),'CARD_EDIT_VERSION_TWO_OVERWRITTEN');
    }
    else assert(before.v2 === null && before.v3 === null && after.v3 === null, 'CARD_EDIT_PREEXISTING_VERSION');
    assert.deepEqual(after.profile, {...before.profile,identity_version:version,identity_fingerprint:fingerprint(versions[version-1]),
      ...(hasVersionPaths?{persona_path:artifact.versionPaths['v'+version]}:{})},
      'CARD_EDIT_REGISTRY_UNEDITABLE_CHANGED');
  });
  assert.equal(metadata[0].after.profile.identity_fingerprint,metadata[1].before.profile.identity_fingerprint,'CARD_EDIT_SAVE_CHAIN');
  assert.deepEqual(metadata[0].after.cache,metadata[1].before.cache,'CARD_EDIT_CACHE_BETWEEN_SAVES');
  const otherRegistry = {...registry,active_id:first.before.activeId,
    profiles:Object.fromEntries(Object.entries(registry.profiles).filter(([key])=>key !== id))};
  assert.equal(digest(otherRegistry),metadata[0].before.otherRegistrySha256,'CARD_EDIT_OTHER_REGISTRY_PERSISTENCE');
  const moon = result.reports[0].archiveInteraction?.cardImport?.moonPersona;
  for (const [index,group] of groups.entries()) {
    assert(group?.schema === 'reverie.native.card-edit.gui-evidence.v1' && group.passed === true && group.error === '' &&
      group.profileId === id && group.profileName === '测试人格·晴' && group.previouslyMounted === true && group.modelCalls === 0,
      'CARD_EDIT_GUI_GROUP');
    assert(group.mode === (index ? 'restart-readback' : 'edit-and-mount') && group.deadlineMs === (index ? 20000 : 45000) &&
      integer(group.elapsedMs) && group.elapsedMs < group.deadlineMs, 'CARD_EDIT_GUI_DEADLINE');
    assert.deepEqual(group.checks?.map(c=>c.name), index ? RESTART_CHECKS : FIRST_CHECKS, 'CARD_EDIT_CHECK_ORDER');
    assert(group.checks.every(c=>c.passed === true), 'CARD_EDIT_CHECK_FAILED');
    assert(group.before.activeId === (index ? 'default' : moon), 'CARD_EDIT_START_PERSONA');
    for (const key of ['activeId','profiles','messageIds','archiveRevision','archiveHash','authorHash','runtimeWritable','recoveryState'])
      assert.deepEqual(group.after[key],group.before[key], 'CARD_EDIT_RETURN_BASELINE:' + key);
    assert(group.before.runtimeWritable === true && group.before.recoveryState === 'clean' &&
      isSha(group.before.archiveHash) && isSha(group.before.authorHash), 'CARD_EDIT_WRITABLE_BASELINE');
    assert.deepEqual(result.reports[index].personas.profiles,group.after.profiles,'CARD_EDIT_FINAL_PROFILES');
    assert.deepEqual(result.reports[index].messages.map(m=>String(m.id)),group.after.messageIds,'CARD_EDIT_FINAL_HISTORY');
    const profileIndex = group.before.profiles.findIndex(p=>p.id === id);
    assert(profileIndex >= 0 && group.before.profiles[profileIndex].name === '测试人格·晴', 'CARD_EDIT_TARGET_ROW');
    const steps = index ? [1,6,18,20,21,23,24] : [1,6,8,9,10,11,12,14,15,16,18,20,21,23,24];
    const controls = {1:'nav-character',6:'personaEdit_'+profileIndex,8:'personaProfileDescription',9:'personaProfileAddGreeting',
      10:'personaProfileGreeting_0',11:'personaProfileSave',12:'personaProfileConfirmSave',14:'personaProfileTone',
      15:'personaProfileSave',16:'personaProfileConfirmSave',18:'personaProfileCancel',20:'personaSwitch-'+id,
      21:'personaSwitchConfirm',23:'personaSwitch-'+group.before.activeId,24:'personaSwitchConfirm'};
    assert(Array.isArray(group.inputs) && group.inputs.length === steps.length,'CARD_EDIT_INPUT_COUNT');
    group.inputs.forEach((record,n)=>input(record,steps[n],controls[steps[n]]));
    group.inputs.forEach(record=> {
      assert(record.scope === (record.step >= 23 ? group.switches?.[0]?.scopeAfter : group.before.scope) &&
        record.generation === group.before.generation + (record.step >= 23 ? 1 : 0), 'CARD_EDIT_INPUT_SCOPE_BINDING');
    });
    assert(Array.isArray(group.reads) && group.reads.length === 1 && group.reads[0].profileId === id &&
      ident(group.reads[0].requestId) && group.reads[0].version === (index ? 3 : 1) &&
      group.reads[0].fingerprint === fingerprint(index ? v3 : original), 'CARD_EDIT_READBACK');
    assert.deepEqual(group.reads[0].fields,fields(index ? v3 : original),'CARD_EDIT_READBACK_FIELDS');
    assert.deepEqual(group.fields,fields(v3),'CARD_EDIT_CANONICAL_FIELDS');
    assert(Array.isArray(group.saves) && group.saves.length === (index ? 0 : 2),'CARD_EDIT_SAVE_COUNT');
    group.saves.forEach((receipt,n)=> {
      assert(receipt.version === n+2 && receipt.profileId === id && receipt.active === false &&
        receipt.fingerprint === fingerprint(versions[n+1]) && receipt.scopeBefore === group.before.scope &&
        receipt.scopeAfter === receipt.scopeBefore && receipt.generationBefore === group.before.generation &&
        receipt.generationAfter === receipt.generationBefore, 'CARD_EDIT_SAVE_BINDING');
      assert.deepEqual(receipt.fields,fields(versions[n+1]), 'CARD_EDIT_SAVE_FIELDS');
    });
    assert(Array.isArray(group.switches) && group.switches.length === 2,'CARD_EDIT_SWITCH_COUNT');
    let previousScope = group.before.scope, previousGeneration = group.before.generation;
    group.switches.forEach((record,n)=> {
      const from = scope(record.scopeBefore), to = scope(record.scopeAfter), originalScope = scope(group.before.scope);
      assert(record.scopeBefore === previousScope && record.generationBefore === previousGeneration &&
        record.sourceId === (n ? id : group.before.activeId) && record.targetId === (n ? group.before.activeId : id) &&
        to.id === (n ? originalScope.id : id) && to.epoch === from.epoch + 1 &&
        to.fingerprint === (n ? originalScope.fingerprint : fingerprint(v3)) &&
        record.generationAfter === record.generationBefore + 1 && record.runtimeWritable === true && record.recoveryState === 'clean',
        'CARD_EDIT_SWITCH_IDENTITY');
      previousScope = record.scopeAfter; previousGeneration = record.generationAfter;
    });
    assert(group.after.scope === previousScope && group.after.generation === previousGeneration, 'CARD_EDIT_RETURN_SCOPE');
    const mounted = group.observations?.mountedTarget;
    assert(mounted?.profileId === id && mounted.enabled === false && mounted.noticeVisible === true,'CARD_EDIT_MOUNTED_ROW');
    whole(mounted.button); whole(mounted.notice);
    if (!index) {
      for (const [key,enabled] of [['builtin',false],['active',false],['target',true],['otherImported',true]]) {
        const observation = group.observations[key]; assert(observation?.enabled === enabled,'CARD_EDIT_ENTRY_AVAILABILITY'); whole(observation.button);
        if (!enabled) { assert(observation.noticeVisible === true,'CARD_EDIT_DISABLED_NOTICE'); whole(observation.notice); }
      }
      assert(group.observations.builtin.profileId === 'default' && group.observations.active.profileId === moon &&
        group.observations.target.profileId === id && group.before.profiles.some(p=>p.id === group.observations.otherImported.profileId &&
          ![id,moon,'default'].includes(p.id)),'CARD_EDIT_ENTRY_IDENTITY');
    }
  }
  assert.deepEqual(restart.reads[0].fields,first.fields,'CARD_EDIT_RESTART_PERSISTENCE');
  assert.equal(registry.active_id,'default','CARD_EDIT_FINAL_REGISTRY_ACTIVE');
  const cache = json(raw.cache), defaultProfile = registry.profiles.default;
  assert(defaultProfile && fingerprint(cache) === defaultProfile.identity_fingerprint,'CARD_EDIT_FINAL_CACHE');
  return {schema:'reverie.native.card-edit.host-proof.v1',passed:true,contract:CARD_EDIT_CONTRACT,profileId:id,
    profileName:'测试人格·晴',versions:[2,3],checks:8,cycleChecks:[5,3],inputCounts:[15,7],switchCounts:[2,2],
    modelCalls:0,originalUnchanged:true,versionTwoUnchanged:true,importReportUnchanged:true,cacheUnchangedDuringSaves:true,
    fingerprint:fingerprint(v3),files:hashes,...(hasVersionPaths?{versionPaths:{...artifact.versionPaths}}:{})};
}

function captureCardEdit(result,dataDirectory,reportDirectory) {
  const id = result.reports?.[0]?.cardEdit?.profileId;
  assert(typeof id === 'string' && /^st_[a-f0-9]{20}$/.test(id),'CARD_EDIT_PROFILE_ID');
  const root = path.join(dataDirectory,'data/persona'), directory = path.join(root,'imported',id);
  assert(path.isAbsolute(dataDirectory),'CARD_EDIT_ABSOLUTE_ISOLATION');
  for (const name of [dataDirectory,path.join(dataDirectory,'data'),root,path.join(root,'imported'),directory]) {
    const info = fs.lstatSync(name);
    assert(info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid()),
      'CARD_EDIT_ISOLATED_DIRECTORY');
  }
  const registryBytes = readPrivate(path.join(root,'registry.json'),MAX_BYTES,false), registry = json(registryBytes);
  const backend = readPrivate(path.join(dataDirectory,'p1-card-edit-metadata.jsonl'),65536).toString('utf8').trim().split('\n')
    .map(line=>json(Buffer.from(line)));
  assert(backend.length === 2,'CARD_EDIT_BACKEND_COUNT');
  const firstRegistered = backend[0]?.after?.profile, finalRegistered = registry.profiles?.[id];
  assert(firstRegistered?.identity_version === 2 && finalRegistered?.identity_version === 3,'CARD_EDIT_REGISTERED_VERSION_PATH');
  const versionPaths = {
    v2:registeredVersionPath(id,2,firstRegistered.identity_fingerprint,firstRegistered.persona_path),
    v3:registeredVersionPath(id,3,finalRegistered.identity_fingerprint,finalRegistered.persona_path),
  };
  const filenames = {registry:path.join(root,'registry.json'),cache:path.join(root,'active.json'),
    original:path.join(directory,'persona.json'),v2:path.join(root,versionPaths.v2),v3:path.join(root,versionPaths.v3),
    importReport:path.join(directory,'import-report.json')};
  // Legacy import/switch files retain their existing umask-derived modes.
  // Only this feature's new immutable versions and evidence require 0600.
  const files = Object.fromEntries(Object.entries(filenames).map(([key,file])=>
    [key,(key === 'registry' ? registryBytes : readPrivate(file,MAX_BYTES,['v2','v3'].includes(key))).toString('base64')]));
  const artifact = {schema:'reverie.native.card-edit.saved-artifact.v1',profileId:id,files,backend,versionPaths};
  const proof = verifyCardEdit(result,artifact), bytes = Buffer.from(JSON.stringify(artifact)+'\n');
  assert(bytes.length <= 2*1024*1024,'CARD_EDIT_ARTIFACT_SIZE');
  fs.writeFileSync(path.join(reportDirectory,ARTIFACT),bytes,{flag:'wx',mode:0o600});
  return {...proof,artifact:{path:ARTIFACT,bytes:bytes.length,sha256:sha(bytes)}};
}
function verifySavedCardEdit(result,reportDirectory) {
  const bytes = readPrivate(path.join(reportDirectory,ARTIFACT),2*1024*1024);
  const proof = {...verifyCardEdit(result,json(bytes)),artifact:{path:ARTIFACT,bytes:bytes.length,sha256:sha(bytes)}};
  assert.deepEqual(result.cardEditEvidence,proof,'CARD_EDIT_SAVED_PROOF_CHANGED');
  return proof;
}
module.exports = {CARD_EDIT_CONTRACT,captureCardEdit,verifySavedCardEdit,verifyCardEdit,readPrivate,fingerprint};
