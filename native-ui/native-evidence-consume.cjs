'use strict';
// This is a read-only consumer of evidence emitted by the registered native
// target. It never launches tests, imports a Qt application or rewrites records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {verifyPersonaRowInputRecord}=require('./worldbook-priority-verdicts.cjs');
const {verifyCandidateHeaderAcquisition}=require('./memory-candidate-batch-verdicts.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const keys=(value,expected,label,context={})=>{
  assert(value && typeof value==='object' && !Array.isArray(value),verdictReason('NATIVE_EVIDENCE_OBJECT',context,label));
  assert.deepEqual(Object.keys(value).sort(),expected.slice().sort(),verdictReason('NATIVE_EVIDENCE_FIELDS',context,label));
};
function readOrdinary(file,limit) {
  const context={file:path.basename(file)};
  const info=fs.lstatSync(file);assert(info.isFile() && !info.isSymbolicLink(),verdictReason('NATIVE_EVIDENCE_FILE_KIND',context,'Evidence must be an ordinary file'));
  assert(info.size>0 && info.size<=limit,verdictReason('NATIVE_EVIDENCE_FILE_BOUND',context,'Evidence size outside registered bound'));
  const raw=fs.readFileSync(file);assert.equal(raw.length,info.size,verdictReason('NATIVE_EVIDENCE_FILE_BYTES',context));return {raw,value:JSON.parse(raw.toString('utf8'))};
}
function verifyNativeEvidenceRecord(wrapper,entry) {
  const context={caseId:String(entry.caseId)};
  keys(wrapper,entry.kind==='candidate-header'?['schema','caseId','record','read']:['schema','caseId','record'],'Evidence wrapper fields',{...context,field:'wrapper'});
  assert.equal(wrapper.schema,'reverie.native-input-evidence.v1',verdictReason('NATIVE_EVIDENCE_WRAPPER_SCHEMA',context));
  assert.equal(wrapper.caseId,entry.caseId,verdictReason('NATIVE_EVIDENCE_CASE_ID',context));
  if(entry.kind==='persona-row')return verifyPersonaRowInputRecord(wrapper.record,entry.expected);
  assert.equal(entry.kind,'candidate-header',verdictReason('NATIVE_EVIDENCE_CASE_KIND',context));
  const expected=entry.expected,read=wrapper.read;
  keys(read,['command','envelope','receipt'],'Actual candidate request/response evidence missing',{...context,field:'read'});
  assert.equal(read.command,expected.readCommand,verdictReason('NATIVE_EVIDENCE_READ_COMMAND',{...context,field:'command'}));
  assert.equal(read.envelope?.command,expected.readCommand,verdictReason('NATIVE_EVIDENCE_REQUEST_COMMAND',{...context,field:'envelope.command'}));
  assert.equal(read.envelope.protocol_version,4,verdictReason('NATIVE_EVIDENCE_REQUEST_PROTOCOL',{...context,field:'protocol_version'}));
  const id=read.envelope.request_id;assert(typeof id==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(id),verdictReason('NATIVE_EVIDENCE_REQUEST_ID',{...context,field:'request_id'}));
  assert.equal(read.receipt?.type,'memory:candidates:result',verdictReason('NATIVE_EVIDENCE_RESPONSE_TYPE',{...context,field:'type'}));
  assert.equal(read.receipt.request_id,id,verdictReason('NATIVE_EVIDENCE_RESPONSE_ID',{...context,field:'request_id'}));
  const persona=read.envelope.persona;assert(persona && Number.isSafeInteger(persona.epoch) && persona.epoch>=0,verdictReason('NATIVE_EVIDENCE_REQUEST_PERSONA',{...context,field:'persona'}));
  assert.equal(`${persona.persona_id}:${persona.epoch}:${persona.fingerprint}`,expected.scope,verdictReason('NATIVE_EVIDENCE_REQUEST_SCOPE',{...context,field:'persona'}));
  const payload=read.receipt.payload;assert(payload && payload.ok===true && payload.status==='pending',verdictReason('NATIVE_EVIDENCE_RESPONSE_STATUS',{...context,field:'payload'}));
  assert.equal(`${payload.persona_id}:${payload.persona_epoch}:${payload.persona_fingerprint}`,expected.scope,verdictReason('NATIVE_EVIDENCE_RESPONSE_SCOPE',{...context,field:'payload'}));
  assert.equal(payload.has_more,false,verdictReason('NATIVE_EVIDENCE_MORE',{...context,field:'has_more'}));
  assert.equal(payload.next_cursor,null,verdictReason('NATIVE_EVIDENCE_CURSOR',{...context,field:'next_cursor'}));
  assert(Array.isArray(payload.candidates),verdictReason('NATIVE_EVIDENCE_CANDIDATES',{...context,field:'candidates'}));
  assert.deepEqual(payload.candidates.map(row=>row.id),expected.rowIds,verdictReason('NATIVE_EVIDENCE_CANDIDATE_IDS',{...context,field:'candidates.id'}));
  assert.equal(payload.candidates.length,expected.count,verdictReason('NATIVE_EVIDENCE_CANDIDATE_COUNT',{...context,field:'candidates'}));
  assert.equal(new Set(expected.rowIds).size,expected.count,verdictReason('NATIVE_EVIDENCE_EXPECTED_IDS',{...context,field:'rowIds'}));
  assert.equal(wrapper.record.rootObjectName,expected.rootObjectName,verdictReason('NATIVE_EVIDENCE_HEADER_ROOT',{...context,field:'rootObjectName'}));
  assert.equal(wrapper.record.page,expected.page,verdictReason('NATIVE_EVIDENCE_HEADER_PAGE',{...context,field:'page'}));
  assert.equal(wrapper.record.tabIndex,expected.tabIndex,verdictReason('NATIVE_EVIDENCE_HEADER_TAB',{...context,field:'tabIndex'}));
  return verifyCandidateHeaderAcquisition(wrapper.record,{pageNumber:expected.pageNumber,count:expected.count,visible:expected.visible,
    readRequestId:id,scope:expected.scope,generation:expected.generation},expected.acquisitionDeadlineMs);
}
function verifyNativeEvidence(directory,contractPath) {
  const directoryInfo=fs.lstatSync(directory);assert(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(),verdictReason('NATIVE_EVIDENCE_DIRECTORY_KIND',{field:'directory'}));
  const contractRead=readOrdinary(contractPath,65536),contract=contractRead.value;
  keys(contract,['schema','maxRecordBytes','cases'],'Fixed evidence contract fields',{field:'contract'});
  assert.equal(contract.schema,'reverie.native-input-evidence.contract.v1',verdictReason('NATIVE_EVIDENCE_CONTRACT_SCHEMA',{field:'schema'}));
  assert.equal(contract.maxRecordBytes,131072,verdictReason('NATIVE_EVIDENCE_CONTRACT_LIMIT',{field:'maxRecordBytes'}));
  assert(Array.isArray(contract.cases) && contract.cases.length===4,verdictReason('NATIVE_EVIDENCE_CONTRACT_CASES',{field:'cases'}));
  const filenames=contract.cases.map(entry=>entry.filename),ids=contract.cases.map(entry=>entry.caseId);
  assert.equal(new Set(filenames).size,4,verdictReason('NATIVE_EVIDENCE_UNIQUE_FILENAMES',{field:'filename'}));
  assert.equal(new Set(ids).size,4,verdictReason('NATIVE_EVIDENCE_UNIQUE_CASE_IDS',{field:'caseId'}));
  for(const filename of filenames)assert(typeof filename==='string' && /^[a-z0-9-]+\.json$/.test(filename) && filename!=='manifest.json',verdictReason('NATIVE_EVIDENCE_FILENAME',{field:'filename'}));
  assert.deepEqual(fs.readdirSync(directory).sort(),[...filenames,'manifest.json'].sort(),verdictReason('NATIVE_EVIDENCE_DIRECTORY_FILES',{field:'files'},'Evidence directory missing or extra files'));
  const manifestRead=readOrdinary(path.join(directory,'manifest.json'),65536),manifest=manifestRead.value;
  keys(manifest,['schema','contractSha256','cases'],'Evidence manifest fields',{field:'manifest'});
  assert.equal(manifest.schema,'reverie.native-input-evidence.manifest.v1',verdictReason('NATIVE_EVIDENCE_MANIFEST_SCHEMA',{field:'schema'}));
  assert.equal(manifest.contractSha256,hash(contractRead.raw),verdictReason('NATIVE_EVIDENCE_CONTRACT_HASH',{field:'contractSha256'}));
  assert(Array.isArray(manifest.cases),verdictReason('NATIVE_EVIDENCE_MANIFEST_CASES',{field:'cases'}));
  assert.deepEqual(manifest.cases.map(entry=>entry.caseId),ids,verdictReason('NATIVE_EVIDENCE_MANIFEST_CASE_IDS',{field:'cases'}));
  const recordsSha256={},cases=[];
  for(const [index,entry] of contract.cases.entries()) {
    const context={caseId:String(entry.caseId),file:String(entry.filename)};
    const ref=manifest.cases[index];keys(ref,['caseId','filename','kind','sha256','bytes'],'Evidence manifest case fields',{...context,field:'manifest.case'});
    for(const key of ['caseId','filename','kind'])assert.equal(ref[key],entry[key],verdictReason('NATIVE_EVIDENCE_MANIFEST_BINDING',{...context,field:key}));
    assert(Number.isSafeInteger(ref.bytes) && ref.bytes>0 && ref.bytes<=contract.maxRecordBytes,verdictReason('NATIVE_EVIDENCE_RECORD_BYTE_BOUND',context));
    assert(typeof ref.sha256==='string' && /^[a-f0-9]{64}$/.test(ref.sha256),verdictReason('NATIVE_EVIDENCE_RECORD_HASH_FORMAT',context));
    const record=readOrdinary(path.join(directory,entry.filename),contract.maxRecordBytes);
    assert.equal(record.raw.length,ref.bytes,verdictReason('NATIVE_EVIDENCE_RECORD_BYTES',context));
    assert.equal(hash(record.raw),ref.sha256,verdictReason('NATIVE_EVIDENCE_RECORD_HASH',context));
    recordsSha256[entry.filename]=ref.sha256;
    cases.push({caseId:entry.caseId,kind:entry.kind,proof:verifyNativeEvidenceRecord(record.value,entry)});
  }
  return {schema:'reverie.native-input-evidence.verdict.v1',passed:true,contractSha256:hash(contractRead.raw),
    manifestSha256:hash(manifestRead.raw),recordsSha256,caseIds:ids,cases};
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,5,verdictReason('NATIVE_EVIDENCE_CLI',{field:'argc'},'Usage: native-evidence-consume.cjs evidenceDir fixedContract newVerdict'));
    const verdict=verifyNativeEvidence(process.argv[2],process.argv[3]);
    fs.writeFileSync(process.argv[4],JSON.stringify(verdict,null,2)+'\n',{flag:'wx'});
    process.stdout.write(JSON.stringify({passed:true,caseIds:verdict.caseIds,contractSha256:verdict.contractSha256})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={verifyNativeEvidence,verifyNativeEvidenceRecord};
