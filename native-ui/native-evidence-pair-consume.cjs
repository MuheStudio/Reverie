'use strict';
// One in-stage Node invocation. Legacy consumer CLI and its proof remain unchanged.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {verifyNativeEvidence}=require('./native-evidence-consume.cjs');
const {verifyNativeArchiveFocusEvidence}=require('./archive-control-readiness-verdicts.cjs');
const {verdictReason}=require('./verdict-test-support.cjs');
function verifyNativeEvidencePair(legacyDirectory,legacyContract,focusDirectory,focusContract) {
  const native=verifyNativeEvidence(legacyDirectory,legacyContract);
  const focus=verifyNativeArchiveFocusEvidence(focusDirectory,focusContract);
  return {native,focus};
}
if(require.main===module) {
  try {
    assert.equal(process.argv.length,8,verdictReason('NATIVE_PAIR_CLI',{field:'argc'}));
    const [legacyDirectory,legacyContract,legacyOutput,focusDirectory,focusContract,focusOutput]=process.argv.slice(2);
    assert(path.resolve(legacyOutput)!==path.resolve(focusOutput) && !fs.existsSync(legacyOutput) && !fs.existsSync(focusOutput),
      verdictReason('NATIVE_PAIR_OUTPUT_NOT_FRESH',{field:'outputs'}));
    const proof=verifyNativeEvidencePair(legacyDirectory,legacyContract,focusDirectory,focusContract);
    fs.writeFileSync(legacyOutput,JSON.stringify(proof.native,null,2)+'\n',{flag:'wx'});
    fs.writeFileSync(focusOutput,JSON.stringify(proof.focus,null,2)+'\n',{flag:'wx'});
    process.stdout.write(JSON.stringify({passed:true,nativeCaseIds:proof.native.caseIds,focusCaseIds:proof.focus.caseIds})+'\n');
  } catch(error) {process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;}
}
module.exports={verifyNativeEvidencePair};
