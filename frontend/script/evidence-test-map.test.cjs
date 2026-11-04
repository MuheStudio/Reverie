'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {buildCoverage, validateCoverage, TEST_FILES, PRODUCT_FILES, TOOL_FILES, CANDIDATE, CONTROLS, caseId, matchingRequirements,hash} = require('./evidence-test-map.cjs');
const digest = 'a'.repeat(64);
function fixture() {
  const runner = 'node';
  const cases = TEST_FILES.node.map((testFile,i) => ({id: caseId(runner,testFile,`controlled-${i}`), testFile,
    selector:`case-${String(i+1).padStart(4,'0')}`,nameSha256:hash(`controlled-${i}`),
    result: 'passed', durationMs: 1, requirements: matchingRequirements(runner,testFile,`controlled-${i}`)}));
  return buildCoverage([{id:'node-aaaaaaaaaaaaaaaa',runner,executionCommit:CANDIDATE,
    sourceBinding:{scope:'selected-files-against-execution-commit',worktreeClean:true,selectedFilesStatus:'clean',changedSourceCount:0,uncommittedSourceCount:0},
    controls:{...CONTROLS},
    startedAt:'2026-10-05T00:00:00.000Z', finishedAt:'2026-10-05T00:00:01.000Z',
    report:{sha256:digest,bytes:100,digestKind:'raw-machine-report-file-sha256'},cases,
    sources:[...new Set([...TEST_FILES.node,...PRODUCT_FILES,...TOOL_FILES])].map(path => ({path,bytes:10,sha256:digest,candidateSha256:digest,matchesCandidate:true,executionCommitSha256:digest,matchesExecutionCommit:true})),
    counts:{passed:2,failed:0,skipped:0},granularity:'case'}]);
}
test('controlled per-case coverage validates without any filesystem access and returns a detached projection', () => {
  const value=fixture(), result=validateCoverage(value); assert.deepEqual(result,value); assert.notEqual(result,value);
});
test('test labels and parameter values never enter the stable case identifier', () => {
  const id=caseId('node',TEST_FILES.node[0],'/private/path PRIVATE_INPUT pid=123');
  assert.match(id,/^node-[a-f0-9]{24}$/); assert.equal(id,caseId('node',TEST_FILES.node[0],'/private/path PRIVATE_INPUT pid=123'));
});
test('planned snapshot, scan-depth, activation and regex bounds have explicit requirement mappings',()=>{
  const engine='tests/test_worldbook_engine.py', regex='tests/test_worldbook_regex.py';
  for(const name of ['test_snapshot_is_deeply_immutable_preserves_metadata_and_does_not_trim',
    'test_snapshot_rejects_checksum_or_revision_errors_without_raw_data']) {
    assert.ok(matchingRequirements('python',engine,name).includes('worldbook-snapshot-integrity'));
  }
  for(const name of ['test_scan_depth_inherits_book_and_counts_current_message',
    'test_always_active_bypasses_regex_auxiliary_and_zero_scan_depth']) {
    assert.ok(matchingRequirements('python',engine,name).includes('worldbook-budget-and-recursion'));
  }
  for(const name of ['test_startup_timeout_is_bounded_and_leaves_no_process',
    'test_startup_budget_is_shared_by_restarts',
    'test_total_execution_budget_survives_worker_restarts_and_reports_exhaustion',
    'test_input_limits_fail_without_starting_a_worker',
    'test_encoded_request_frame_bound_is_enforced_before_spawning',
    'test_invalid_worker_output_is_bounded_and_machine_sanitized',
    'test_missing_worker_is_isolated_without_raw_exception_text',
    'test_cleanup_timeout_is_explicit_and_retains_unreaped_handle']) {
    assert.ok(matchingRequirements('python',regex,name).includes('regex-bounds-and-protocol'));
  }
  assert.deepEqual(matchingRequirements('python',engine,'test_constructor_allocates_no_subprocess'),[]);
});
for (const [name,change] of [
  ['unknown top-level facts',v=>{v.rawLog='private';}],
  ['unknown case labels',v=>{v.batches[0].cases[0].name='private';}],
  ['unknown paths',v=>{v.batches[0].cases[0].testFile='/private/file';}],
  ['unregistered source paths',v=>{v.batches[0].sources[0].path='src/arbitrary.py';}],
  ['misleading source match',v=>{v.batches[0].sources[0].matchesCandidate=false;}],
  ['unknown comparison marked equal',v=>{v.batches[0].sources[0].candidateSha256=null;}],
  ['missing product source',v=>{v.batches[0].sources=v.batches[0].sources.filter(s=>s.path!==PRODUCT_FILES[0]);}],
  ['missing tool source',v=>{v.batches[0].sources=v.batches[0].sources.filter(s=>s.path!==TOOL_FILES[0]);}],
  ['empty selected test file',v=>{v.batches[0].cases.pop();v.batches[0].counts.passed--;}],
  ['invented clean execution binding',v=>{v.batches[0].sources[0].executionCommitSha256=null;v.batches[0].sources[0].matchesExecutionCommit=false;}],
  ['misleading execution source match',v=>{v.batches[0].sources[0].matchesExecutionCommit=false;}],
  ['case name hash mismatch',v=>{v.batches[0].cases[0].nameSha256='b'.repeat(64);} ],
  ['private data in selector',v=>{v.batches[0].cases[0].selector='/private/input';}],
  ['weakened execution controls',v=>{v.batches[0].controls.dotenvDisabled=false;}],
  ['invented passing totals',v=>{v.batches[0].counts.passed++;}],
  ['duplicate cases',v=>{v.batches[0].cases.push(v.batches[0].cases[0]);}],
  ['missing requirement',v=>{v.requirements.pop();}],
  ['requirement with missing evidence',v=>{v.requirements[0].evidence=[];}],
  ['cross-file requirement',v=>{v.batches[0].cases[0].requirements=['native-synthetic-controller'];}],
  ['contradictory requirement status',v=>{v.requirements[0].result='failed';}],
  ['private identifier in reference',v=>{v.requirements[0].evidence=['/Users/private'];}],
  ['execution end before start',v=>{v.batches[0].finishedAt='2025-10-05T00:00:00.000Z';}],
  ['new run claimed as original full regression',v=>{v.nonClaims=v.nonClaims.slice(1);}],
]) test(`rejects ${name} with a safe fixed error`,()=>{
  const v=fixture(); change(v); assert.throws(()=>validateCoverage(v),e=>e.code==='ERR_EVIDENCE_COVERAGE' && !e.message.includes('private'));
});
test('failed and skipped cases remain visibly failed or with-skips rather than invented pass',()=>{
  const v=fixture(), b=v.batches[0]; b.cases[0].result='failed'; b.cases[1].result='skipped';
  b.counts={passed:0,failed:1,skipped:1};
  const result=buildCoverage(v.batches); assert.deepEqual(result.requirements.map(r=>r.result),['failed','with-skips']);
});
test('historical source evidence cannot be promoted from file/batch to per-case evidence or a new run',()=>{
  const v=fixture(); v.historical=[{id:'candidate-python-file-results',sourceCommit:CANDIDATE,
    reportSha256:digest,logSha256:digest,locator:'source.steps.pytest',granularity:'file',result:'passed',rerun:false}];
  assert.deepEqual(validateCoverage(v).historical,v.historical);
  v.historical[0].granularity='case'; assert.throws(()=>validateCoverage(v),{code:'ERR_EVIDENCE_COVERAGE'});
  v.historical[0].granularity='file'; v.historical[0].rerun=true; assert.throws(()=>validateCoverage(v),{code:'ERR_EVIDENCE_COVERAGE'});
});
test('package scenarios retain their old-report identity and never claim rerun',()=>{
  const v=fixture(); v.historical=[{id:'package-worldbook-seven-scenarios',sourceCommit:CANDIDATE,
    reportSha256:digest,logSha256:null,locator:'application.worldbookContract.steps.0-6',granularity:'scenario',result:'passed',rerun:false}];
  assert.equal(validateCoverage(v).historical[0].rerun,false);
  v.historical[0].locator='application.arbitrary'; assert.throws(()=>validateCoverage(v),{code:'ERR_EVIDENCE_COVERAGE'});
});
test('synthetic environment overrides inherited data, dotenv and offline policy without changing HOME',t=>{
  const {batchEnvironment}=require('./run-evidence-targeted.cjs');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'reverie-evidence-env-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const inherited={HOME:'/unchanged-home',REVERIE_DATA_DIR:'/must-not-use',PYTHON_DOTENV_DISABLED:'0',
    PYTHONHOME:'/must-not-use',PYTHONPATH:'/must-not-use',REVERIE_STORAGE_KEY_FD:'12',
    REVERIE_REQUIRE_ENCRYPTED_STORAGE:'1',NODE_OPTIONS:'--must-not-use',ELECTRON_RUN_AS_NODE:'1',
    PYTEST_ADDOPTS:'outside_tests',PYTEST_PLUGINS:'outside_plugin'};
  const context=batchEnvironment(directory,inherited); context.assertIdentity();
  assert.equal(context.env.HOME,inherited.HOME);
  assert.equal(context.env.REVERIE_DATA_DIR,path.join(directory,'scratch','data'));
  for(const name of ['PYTHON_DOTENV_DISABLED','PYTHONNOUSERSITE','HF_HUB_OFFLINE','TRANSFORMERS_OFFLINE','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD','PYTEST_DISABLE_PLUGIN_AUTOLOAD']) assert.equal(context.env[name],'1');
  for(const name of ['PYTHONHOME','PYTHONPATH','REVERIE_STORAGE_KEY_FD','REVERIE_REQUIRE_ENCRYPTED_STORAGE','NODE_OPTIONS','ELECTRON_RUN_AS_NODE','PYTEST_ADDOPTS','PYTEST_PLUGINS']) assert.equal(context.env[name],undefined);
  assert.deepEqual(context.controls,CONTROLS);
  const tmp=context.env.TMPDIR;
  fs.renameSync(tmp,`${tmp}.saved`);fs.mkdirSync(tmp);
  assert.throws(()=>context.assertIdentity(),/identity changed/);
});
