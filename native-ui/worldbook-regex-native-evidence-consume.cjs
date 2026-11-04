'use strict';
// Read-only consumption of the two registered real-Qt regex records. Geometry,
// focus and numeric PlainText semantics are the production host's own checks.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {patternGeometry}=require('./worldbook-regex-verdicts.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
const REGEX_NATIVE_EVIDENCE_CONTRACT=Object.freeze({
  schema:'reverie.regex-native-evidence-contract.v1',
  recordSchema:'reverie.regex-native-evidence.v1',
  manifestSchema:'reverie.regex-native-evidence-manifest.v1',
  maximumRecordBytes:131072,
  cases:Object.freeze([
    Object.freeze({caseId:'regex-primary-selected',filename:'regex-primary-selected.json',control:'worldbookRegexKeywords',
      viewport:'worldbook-regex-keywords-scroll',selectionRequired:true}),
    Object.freeze({caseId:'regex-secondary-plain',filename:'regex-secondary-plain.json',control:'worldbookRegexSecondaryKeywords',
      viewport:'worldbook-regex-secondary-scroll',selectionRequired:false}),
  ]),
});
const C=REGEX_NATIVE_EVIDENCE_CONTRACT;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const guard=(condition,reason,context)=>assert(condition,verdictReason(reason,context));
const equal=(actual,expected,reason,context)=>assert.deepEqual(actual,expected,verdictReason(reason,context));
function exactKeys(value,expected,reason,context) {
  guard(object(value),reason,context);
  equal(Object.keys(value).sort(),expected.slice().sort(),reason,context);
}
function readEvidenceFile(file,limit,context) {
  guard(fs.existsSync(file),'REGEX_NATIVE_FILE_MISSING',context);
  const info=fs.lstatSync(file);
  guard(info.isFile() && !info.isSymbolicLink(),'REGEX_NATIVE_FILE_KIND',context);
  guard(info.size>0 && info.size<=limit,'REGEX_NATIVE_FILE_BOUND',context);
  const bytes=fs.readFileSync(file);
  guard(bytes.length===info.size,'REGEX_NATIVE_FILE_BYTES',context);
  let value;
  try {value=JSON.parse(bytes.toString('utf8'));} catch {
    guard(false,'REGEX_NATIVE_FILE_JSON',context);
  }
  return {bytes,value};
}
function verifyNativeWorldbookRegexEvidenceRecord(record,spec) {
  guard(object(spec),'REGEX_NATIVE_CASE_SPEC',{kind:'native-regex'});
  equal(spec,C.cases.find(entry=>entry.caseId===spec.caseId),'REGEX_NATIVE_CASE_SPEC',{kind:'native-regex'});
  const context={kind:'native-regex',caseId:spec.caseId};
  exactKeys(record,['schema','caseId','control','windowWidth','windowHeight','textFormat','geometry'],
    'REGEX_NATIVE_RECORD_FIELDS',context);
  equal([record.schema,record.caseId,record.control],[C.recordSchema,spec.caseId,spec.control],
    'REGEX_NATIVE_RECORD_BINDING',context);
  exactKeys(record.geometry,['controlRect','visibleRect','viewportRect','selectionRect','selectionStart','selectionEnd',
    'cursorPosition','hasSelection','selectionFullyVisible','fullyVisible','focusInTarget','textFormat'],
    'REGEX_NATIVE_GEOMETRY_FIELDS',context);
  // No enum-name translation or coercion: both serialized observations must be
  // identical before the production check requires the JSON number 0.
  guard(record.textFormat===record.geometry.textFormat,'REGEX_NATIVE_FORMAT_BINDING',context);
  patternGeometry(record.geometry,record.windowWidth,record.windowHeight,spec.selectionRequired,context);
  if(!spec.selectionRequired) {
    const g=record.geometry;
    guard(g.hasSelection===false && g.selectionFullyVisible===false && g.selectionStart===g.selectionEnd &&
      object(g.selectionRect) && ['x','y','width','height'].every(key=>g.selectionRect[key]===0),
      'REGEX_NATIVE_SECONDARY_SELECTION',context);
  }
  return {passed:true,control:spec.control,textFormat:record.textFormat,selectionRequired:spec.selectionRequired};
}
function verifyNativeWorldbookRegexEvidence(directory,contractPath) {
  const context={kind:'native-regex'};
  const contract=readEvidenceFile(contractPath,65536,{...context,file:'contract'});
  equal(contract.value,C,'REGEX_NATIVE_CONTRACT',context);
  guard(fs.existsSync(directory),'REGEX_NATIVE_DIRECTORY',context);
  const info=fs.lstatSync(directory);
  guard(info.isDirectory() && !info.isSymbolicLink(),'REGEX_NATIVE_DIRECTORY',context);
  equal(fs.readdirSync(directory).sort(),['manifest.json',...C.cases.map(spec=>spec.filename)].sort(),
    'REGEX_NATIVE_FILE_SET',context);
  const manifest=readEvidenceFile(path.join(directory,'manifest.json'),65536,{...context,file:'manifest.json'});
  exactKeys(manifest.value,['schema','contractSha256','cases'],'REGEX_NATIVE_MANIFEST_FIELDS',context);
  equal([manifest.value.schema,manifest.value.contractSha256],[C.manifestSchema,hash(contract.bytes)],
    'REGEX_NATIVE_MANIFEST_BINDING',context);
  guard(Array.isArray(manifest.value.cases),'REGEX_NATIVE_MANIFEST_CASES',context);
  equal(manifest.value.cases.map(ref=>ref?.caseId),C.cases.map(spec=>spec.caseId),'REGEX_NATIVE_MANIFEST_CASES',context);
  const cases=[],recordsSha256={};
  for(const [index,spec] of C.cases.entries()) {
    const nested={...context,caseId:spec.caseId},ref=manifest.value.cases[index];
    exactKeys(ref,['caseId','filename','sha256','bytes'],'REGEX_NATIVE_MANIFEST_ENTRY',nested);
    equal([ref.caseId,ref.filename],[spec.caseId,spec.filename],'REGEX_NATIVE_MANIFEST_ENTRY',nested);
    guard(Number.isSafeInteger(ref.bytes) && ref.bytes>0 && ref.bytes<=C.maximumRecordBytes &&
      typeof ref.sha256==='string' && /^[a-f0-9]{64}$/.test(ref.sha256),'REGEX_NATIVE_MANIFEST_ENTRY',nested);
    const record=readEvidenceFile(path.join(directory,spec.filename),C.maximumRecordBytes,nested);
    equal(record.bytes.length,ref.bytes,'REGEX_NATIVE_RECORD_BYTES',nested);
    equal(hash(record.bytes),ref.sha256,'REGEX_NATIVE_RECORD_HASH',nested);
    recordsSha256[spec.filename]=ref.sha256;
    cases.push({caseId:spec.caseId,proof:verifyNativeWorldbookRegexEvidenceRecord(record.value,spec)});
  }
  return {schema:'reverie.regex-native-evidence-verdict.v1',passed:true,contractSha256:hash(contract.bytes),
    manifestSha256:hash(manifest.bytes),recordsSha256,caseIds:C.cases.map(spec=>spec.caseId),cases,contentCollected:false};
}
function writeNativeWorldbookRegexEvidence(directory,contractPath,outputPath) {
  let exists=false;
  try {fs.lstatSync(outputPath);exists=true;} catch(error) {if(error.code!=='ENOENT')throw error;}
  guard(!exists,'REGEX_NATIVE_OUTPUT_NOT_FRESH',{field:'output'});
  const proof=verifyNativeWorldbookRegexEvidence(directory,contractPath);
  const destination=path.join(fs.realpathSync(path.dirname(path.resolve(outputPath))),path.basename(outputPath));
  const relative=path.relative(fs.realpathSync(directory),destination);
  guard(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative),
    'REGEX_NATIVE_OUTPUT_IN_EVIDENCE',{field:'output'});
  fs.writeFileSync(outputPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,5,verdictReason('REGEX_NATIVE_CLI',{field:'argc'},
      'Usage: worldbook-regex-native-evidence-consume.cjs evidenceDir fixedContract newVerdict'));
    const proof=writeNativeWorldbookRegexEvidence(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,caseIds:proof.caseIds,contractSha256:proof.contractSha256})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={REGEX_NATIVE_EVIDENCE_CONTRACT,verifyNativeWorldbookRegexEvidence,verifyNativeWorldbookRegexEvidenceRecord,
  writeNativeWorldbookRegexEvidence};
