'use strict';
// One registered host process, three independent proof files. The older
// consumers, CLI layouts and proof JSON remain unchanged.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {verifyNativeEvidence}=require('./native-evidence-consume.cjs');
const {verifyNativeArchiveFocusEvidence}=require('./archive-control-readiness-verdicts.cjs');
const {verifyNativeWorldbookRegexEvidence}=require('./worldbook-regex-native-evidence-consume.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
function verifyWorldbookRegexNativeEvidencePair(legacyDirectory,legacyContract,focusDirectory,focusContract,regexDirectory,regexContract) {
  const native=verifyNativeEvidence(legacyDirectory,legacyContract);
  const focus=verifyNativeArchiveFocusEvidence(focusDirectory,focusContract);
  const regex=verifyNativeWorldbookRegexEvidence(regexDirectory,regexContract);
  return {native,focus,regex};
}
function outputExists(file) {
  try {fs.lstatSync(file);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;}
}
function writeWorldbookRegexNativeEvidencePair(legacyDirectory,legacyContract,legacyOutput,
  focusDirectory,focusContract,focusOutput,regexDirectory,regexContract,regexOutput) {
  const outputs=[legacyOutput,focusOutput,regexOutput];
  const resolved=outputs.map(file=>path.resolve(file));
  assert(new Set(resolved).size===3 && outputs.every(file=>!outputExists(file)),
    verdictReason('REGEX_NATIVE_PAIR_OUTPUT_NOT_FRESH',{field:'outputs'}));
  const proof=verifyWorldbookRegexNativeEvidencePair(legacyDirectory,legacyContract,focusDirectory,focusContract,regexDirectory,regexContract);
  const directories=[legacyDirectory,focusDirectory,regexDirectory].map(directory=>fs.realpathSync(directory));
  const destinations=outputs.map(file=>path.join(fs.realpathSync(path.dirname(path.resolve(file))),path.basename(file)));
  assert(new Set(destinations).size===3 && destinations.every(file=>directories.every(directory=>{
    const relative=path.relative(directory,file);
    return relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative);
  })),verdictReason('REGEX_NATIVE_PAIR_OUTPUT_IN_EVIDENCE',{field:'outputs'}));
  for(const [index,key] of ['native','focus','regex'].entries())
    fs.writeFileSync(outputs[index],JSON.stringify(proof[key],null,2)+'\n',{flag:'wx'});
  return proof;
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,11,verdictReason('REGEX_NATIVE_PAIR_CLI',{field:'argc'},
      'Usage: worldbook-regex-native-evidence-pair-consume.cjs nativeDir nativeContract nativeProof focusDir focusContract focusProof regexDir regexContract regexProof'));
    const proof=writeWorldbookRegexNativeEvidencePair(...process.argv.slice(2));
    process.stdout.write(JSON.stringify({passed:true,nativeCaseIds:proof.native.caseIds,focusCaseIds:proof.focus.caseIds,regexCaseIds:proof.regex.caseIds})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={verifyWorldbookRegexNativeEvidencePair,writeWorldbookRegexNativeEvidencePair};
