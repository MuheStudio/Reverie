'use strict';
// All six independent consumers finish before any proof file is created.
// The earlier five proof schemas and consumers remain unchanged.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {verifyWorldbookInjectionNavigationNativeEvidencePair}=require('./worldbook-injection-navigation-native-evidence-pair-consume.cjs');
const {verifyNativeWorldbookInjectionHitEvidence}=require('./worldbook-injection-hit-native-evidence-consume.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
function verifyWorldbookInjectionHitNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
  regexDirectory,regexContract,depthDirectory,depthContract,navigationDirectory,navigationContract,hitDirectory,hitContract) {
  const proof=verifyWorldbookInjectionNavigationNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
    regexDirectory,regexContract,depthDirectory,depthContract,navigationDirectory,navigationContract);
  const hit=verifyNativeWorldbookInjectionHitEvidence(hitDirectory,hitContract);
  return {...proof,hit};
}
function outputExists(file) {
  try {fs.lstatSync(file);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;}
}
function writeWorldbookInjectionHitNativeEvidencePair(nativeDirectory,nativeContract,nativeOutput,
  focusDirectory,focusContract,focusOutput,regexDirectory,regexContract,regexOutput,depthDirectory,depthContract,depthOutput,
  navigationDirectory,navigationContract,navigationOutput,hitDirectory,hitContract,hitOutput) {
  const outputs=[nativeOutput,focusOutput,regexOutput,depthOutput,navigationOutput,hitOutput];
  assert(outputs.every(file=>typeof file==='string'&&file.length>0)&&new Set(outputs.map(file=>path.resolve(file))).size===6&&
    outputs.every(file=>!outputExists(file)),verdictReason('INJECTION_HIT_NATIVE_PAIR_OUTPUT_NOT_FRESH',{field:'outputs'}));
  const proof=verifyWorldbookInjectionHitNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
    regexDirectory,regexContract,depthDirectory,depthContract,navigationDirectory,navigationContract,hitDirectory,hitContract);
  const directories=[nativeDirectory,focusDirectory,regexDirectory,depthDirectory,navigationDirectory,hitDirectory]
    .map(directory=>fs.realpathSync(directory));
  const destinations=outputs.map(file=>path.join(fs.realpathSync(path.dirname(path.resolve(file))),path.basename(file)));
  assert(new Set(destinations).size===6&&destinations.every(file=>directories.every(directory=>{
    const relative=path.relative(directory,file);
    return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);
  })),verdictReason('INJECTION_HIT_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',{field:'outputs'}));
  for(const [index,key] of ['native','focus','regex','depth','navigation','hit'].entries())
    fs.writeFileSync(outputs[index],JSON.stringify(proof[key],null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,20,verdictReason('INJECTION_HIT_NATIVE_PAIR_CLI',{field:'argc'},
      'Usage: worldbook-injection-hit-native-evidence-pair-consume.cjs nativeDir nativeContract nativeProof focusDir focusContract focusProof regexDir regexContract regexProof depthDir depthContract depthProof navigationDir navigationContract navigationProof hitDir hitContract hitProof'));
    const proof=writeWorldbookInjectionHitNativeEvidencePair(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,nativeCaseIds:proof.native.caseIds,focusCaseIds:proof.focus.caseIds,
      regexCaseIds:proof.regex.caseIds,depthCaseIds:proof.depth.caseIds,navigationCaseIds:proof.navigation.caseIds,hitCaseIds:proof.hit.caseIds})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={verifyWorldbookInjectionHitNativeEvidencePair,writeWorldbookInjectionHitNativeEvidencePair};
