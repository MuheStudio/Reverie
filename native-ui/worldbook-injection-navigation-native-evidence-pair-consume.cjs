'use strict';
// Verify every independent group before creating any proof. The previous four
// consumers, their command lines, and the objects they return remain intact.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {verifyWorldbookInjectionDepthNativeEvidencePair}=require('./worldbook-injection-depth-native-evidence-pair-consume.cjs');
const {verifyNativeWorldbookInjectionNavigationEvidence}=require('./worldbook-injection-navigation-native-evidence-consume.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
function verifyWorldbookInjectionNavigationNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
  regexDirectory,regexContract,depthDirectory,depthContract,navigationDirectory,navigationContract) {
  const proof=verifyWorldbookInjectionDepthNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
    regexDirectory,regexContract,depthDirectory,depthContract);
  const navigation=verifyNativeWorldbookInjectionNavigationEvidence(navigationDirectory,navigationContract);
  return {...proof,navigation};
}
function outputExists(file) {
  try {fs.lstatSync(file);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;}
}
function writeWorldbookInjectionNavigationNativeEvidencePair(nativeDirectory,nativeContract,nativeOutput,
  focusDirectory,focusContract,focusOutput,regexDirectory,regexContract,regexOutput,depthDirectory,depthContract,depthOutput,
  navigationDirectory,navigationContract,navigationOutput) {
  const outputs=[nativeOutput,focusOutput,regexOutput,depthOutput,navigationOutput];
  assert(outputs.every(file=>typeof file==='string'&&file.length>0)&&
    new Set(outputs.map(file=>path.resolve(file))).size===5&&outputs.every(file=>!outputExists(file)),
    verdictReason('INJECTION_NAVIGATION_NATIVE_PAIR_OUTPUT_NOT_FRESH',{field:'outputs'}));
  const proof=verifyWorldbookInjectionNavigationNativeEvidencePair(nativeDirectory,nativeContract,focusDirectory,focusContract,
    regexDirectory,regexContract,depthDirectory,depthContract,navigationDirectory,navigationContract);
  const directories=[nativeDirectory,focusDirectory,regexDirectory,depthDirectory,navigationDirectory].map(directory=>fs.realpathSync(directory));
  const destinations=outputs.map(file=>path.join(fs.realpathSync(path.dirname(path.resolve(file))),path.basename(file)));
  assert(new Set(destinations).size===5&&destinations.every(file=>directories.every(directory=>{
    const relative=path.relative(directory,file);
    return relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);
  })),verdictReason('INJECTION_NAVIGATION_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',{field:'outputs'}));
  for(const [index,key] of ['native','focus','regex','depth','navigation'].entries())
    fs.writeFileSync(outputs[index],JSON.stringify(proof[key],null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,17,verdictReason('INJECTION_NAVIGATION_NATIVE_PAIR_CLI',{field:'argc'},
      'Usage: worldbook-injection-navigation-native-evidence-pair-consume.cjs nativeDir nativeContract nativeProof focusDir focusContract focusProof regexDir regexContract regexProof depthDir depthContract depthProof navigationDir navigationContract navigationProof'));
    const proof=writeWorldbookInjectionNavigationNativeEvidencePair(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,nativeCaseIds:proof.native.caseIds,focusCaseIds:proof.focus.caseIds,
      regexCaseIds:proof.regex.caseIds,depthCaseIds:proof.depth.caseIds,navigationCaseIds:proof.navigation.caseIds})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={verifyWorldbookInjectionNavigationNativeEvidencePair,writeWorldbookInjectionNavigationNativeEvidencePair};
