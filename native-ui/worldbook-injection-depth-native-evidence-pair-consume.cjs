'use strict';
// Four independent consumers complete before any proof file is written. The
// existing three-group consumer and its CLI are left intact.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {verifyWorldbookRegexNativeEvidencePair}=require('./worldbook-regex-native-evidence-pair-consume.cjs');
const {verifyNativeWorldbookInjectionDepthEvidence}=require('./worldbook-injection-depth-native-evidence-consume.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
function verifyWorldbookInjectionDepthNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
  regexDirectory,regexContract,depthDirectory,depthContract) {
  const proof=verifyWorldbookRegexNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,regexDirectory,regexContract);
  const depth=verifyNativeWorldbookInjectionDepthEvidence(depthDirectory,depthContract);
  return {...proof,depth};
}
function outputExists(file) {
  try {fs.lstatSync(file);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;}
}
function writeWorldbookInjectionDepthNativeEvidencePair(nativeDirectory,nativeContract,nativeOutput,
  focusDirectory,focusContract,focusOutput,regexDirectory,regexContract,regexOutput,depthDirectory,depthContract,depthOutput) {
  const outputs=[nativeOutput,focusOutput,regexOutput,depthOutput];
  assert(outputs.every(file=>typeof file==='string'&&file.length>0)&&
    new Set(outputs.map(file=>path.resolve(file))).size===4&&outputs.every(file=>!outputExists(file)),
    verdictReason('INJECTION_DEPTH_NATIVE_PAIR_OUTPUT_NOT_FRESH',{field:'outputs'}));
  const proof=verifyWorldbookInjectionDepthNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
    regexDirectory,regexContract,depthDirectory,depthContract);
  const directories=[nativeDirectory,focusDirectory,regexDirectory,depthDirectory].map(directory=>fs.realpathSync(directory));
  const destinations=outputs.map(file=>path.join(fs.realpathSync(path.dirname(path.resolve(file))),path.basename(file)));
  assert(new Set(destinations).size===4&&destinations.every(file=>directories.every(directory=>{
    const relative=path.relative(directory,file);
    return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);
  })),verdictReason('INJECTION_DEPTH_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',{field:'outputs'}));
  for(const [index,key] of ['native','focus','regex','depth'].entries())
    fs.writeFileSync(outputs[index],JSON.stringify(proof[key],null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,14,verdictReason('INJECTION_DEPTH_NATIVE_PAIR_CLI',{field:'argc'},
      'Usage: worldbook-injection-depth-native-evidence-pair-consume.cjs nativeDir nativeContract nativeProof focusDir focusContract focusProof regexDir regexContract regexProof depthDir depthContract depthProof'));
    const proof=writeWorldbookInjectionDepthNativeEvidencePair(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,nativeCaseIds:proof.native.caseIds,focusCaseIds:proof.focus.caseIds,
      regexCaseIds:proof.regex.caseIds,depthCaseIds:proof.depth.caseIds})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={verifyWorldbookInjectionDepthNativeEvidencePair,writeWorldbookInjectionDepthNativeEvidencePair};
