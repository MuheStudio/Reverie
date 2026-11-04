'use strict';

// Fixed synthetic checks only. This runner cannot select desktop/package tests,
// start Electron, or consume paths from a report. Raw reports stay local.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  CANDIDATE, TEST_FILES, PRODUCT_FILES, TOOL_FILES, CONTROLS, buildCoverage, caseId, matchingRequirements, hash,
} = require('./evidence-test-map.cjs');
const root = path.resolve(__dirname, '../..');
const node = path.join(root, '.tools/node/bin/node');
const python = path.join(root, '.venv/bin/python');
function checked(relative) {
  const filename = path.join(root, relative);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Source is not a regular file');
  return fs.readFileSync(filename);
}
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Source identity check failed');
  return result.stdout.trim();
}
function sourceRecords(runner, executionCommit) {
  const paths = [...new Set([...TEST_FILES[runner], ...PRODUCT_FILES, ...TOOL_FILES])];
  return paths.map(p => {
    const bytes = checked(p);
    const original = spawnSync('git', ['show', `${CANDIDATE}:${p}`], {cwd: root, maxBuffer: 8 * 1024 * 1024});
    const candidateSha256 = original.status === 0 ? hash(original.stdout) : null;
    const execution = spawnSync('git', ['show', `${executionCommit}:${p}`], {cwd: root, maxBuffer: 8 * 1024 * 1024});
    const executionCommitSha256 = execution.status === 0 ? hash(execution.stdout) : null;
    return {path: p, bytes: bytes.length, sha256: hash(bytes), candidateSha256,
      matchesCandidate: candidateSha256 !== null && candidateSha256 === hash(bytes), executionCommitSha256,
      matchesExecutionCommit: executionCommitSha256 !== null && executionCommitSha256 === hash(bytes)};
  });
}
function batchEnvironment(directory, inherited = process.env) {
  const scratch = path.join(directory, 'scratch'); fs.mkdirSync(scratch, {mode:0o700});
  const temporary = path.join(scratch, 'tmp'); fs.mkdirSync(temporary, {mode:0o700});
  const data = path.join(scratch, 'data'); fs.mkdirSync(data, {mode:0o700});
  const env = {...inherited, PATH:`${path.dirname(node)}:${path.join(root,'.tools/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONNOUSERSITE:'1', PYTHONDONTWRITEBYTECODE:'1', PYTHONPYCACHEPREFIX:path.join(scratch,'bytecode'),
    PYTHONUNBUFFERED:'1', PYTHON_DOTENV_DISABLED:'1', REVERIE_DATA_DIR:data,
    HF_HUB_OFFLINE:'1', TRANSFORMERS_OFFLINE:'1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',
    PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1',
    TMPDIR:fs.realpathSync(temporary), TMP:fs.realpathSync(temporary), TEMP:fs.realpathSync(temporary)};
  for (const key of ['PYTHONPATH','PYTHONHOME','REVERIE_STORAGE_KEY_FD','REVERIE_REQUIRE_ENCRYPTED_STORAGE',
    'NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','REVERIE_TEST_USER_DATA_DIR',
    'PYTEST_ADDOPTS','PYTEST_PLUGINS','PYTEST_CURRENT_TEST','PYTHONINSPECT','PYTHONSTARTUP']) delete env[key];
  const identities = [directory,scratch,temporary,data].map(p=>{
    const s=fs.lstatSync(p); if(s.isSymbolicLink() || !s.isDirectory() || s.uid!==process.getuid()) throw Error('Invalid synthetic scratch identity');
    return {path:p,dev:s.dev,ino:s.ino};
  });
  const assertIdentity = () => { for (const expected of identities) {
    const current=fs.lstatSync(expected.path);
    if(current.isSymbolicLink() || !current.isDirectory() || current.uid!==process.getuid()
      || current.dev!==expected.dev || current.ino!==expected.ino) throw Error('Synthetic scratch identity changed');
  }};
  return {env,assertIdentity,controls:{...CONTROLS}};
}
function run(command, args, cwd, logFile, context) {
  context.assertIdentity();
  const result = spawnSync(command, args, {cwd, env: context.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000});
  fs.writeFileSync(logFile, `${result.stdout || ''}${result.stderr || ''}`, {flag: 'wx', mode: 0o600});
  return result;
}
function parseXml(filename, context) {
  const parser = `import json,sys,xml.etree.ElementTree as E\nr=E.parse(sys.argv[1]).getroot()\nprint(json.dumps([{'name':x.get('name',''),'classname':x.get('classname',''),'file':x.get('file',''),'duration':float(x.get('time','0'))*1000,'result':'failed' if x.find('failure') is not None or x.find('error') is not None else 'skipped' if x.find('skipped') is not None else 'passed'} for x in r.iter('testcase')]))`;
  context.assertIdentity();
  const r = spawnSync(python, ['-I', '-B', '-c', parser, filename], {env:context.env,encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (r.status !== 0) throw new Error('Machine report parsing failed');
  return JSON.parse(r.stdout);
}
function normalizeCases(runner, report, currentTestFile = null) {
  const entries = runner === 'vitest' ? report.testResults.flatMap(file => file.assertionResults.map(test => ({
    testFile: `frontend/${path.relative(path.join(root, 'frontend'), file.name).split(path.sep).join('/')}`,
    name: test.fullName, result: test.status === 'passed' ? 'passed' : ['pending','todo','skipped'].includes(test.status) ? 'skipped' : 'failed',
    duration: test.duration || 0,
  }))) : report.map(test => ({...test, testFile: currentTestFile || `${test.classname.replaceAll('.', '/')}.py`}));
  return entries.map((c,index) => {
    if (!TEST_FILES[runner].includes(c.testFile)) throw new Error('Unregistered test report file');
    const selector = runner === 'python' ? c.name.split('[')[0] : `case-${String(index+1).padStart(4,'0')}`;
    if (runner === 'python' && (!/^test_[a-zA-Z0-9_]{1,180}$/.test(selector)
      || !checked(c.testFile).toString().includes(`def ${selector}(`))) throw new Error('Unregistered Python test function');
    return {id: caseId(runner, c.testFile, c.name), testFile: c.testFile, selector, nameSha256:hash(c.name), result: c.result,
      durationMs: c.duration, requirements: matchingRequirements(runner, c.testFile, selector)};
  });
}
function runBatch(runner, outRoot) {
  const directory = path.join(outRoot, runner); fs.mkdirSync(directory, {mode: 0o700});
  const context = batchEnvironment(directory);
  const executionCommit = git(['rev-parse', 'HEAD']), before = sourceRecords(runner, executionCommit);
  const worktreeClean = git(['status', '--porcelain']) === '';
  const startedAt = new Date().toISOString();
  let cases = [], rawReports = [], allPassed = true;
  if (runner === 'python') {
    const machine = path.join(directory, 'pytest.xml');
    const result = run(python, ['-B', '-m', 'pytest', '-c', path.join(root,'pytest.ini'), '--confcutdir',root,
      '-q', ...TEST_FILES.python, `--junitxml=${machine}`], root, path.join(directory, 'pytest.log'), context);
    if (!fs.existsSync(machine)) throw new Error('No Python machine report was produced');
    cases = normalizeCases(runner, parseXml(machine,context)); rawReports.push(fs.readFileSync(machine)); allPassed = result.status === 0;
  } else if (runner === 'vitest') {
    const machine = path.join(directory, 'vitest.json');
    const result = run(node, [path.join(root, 'frontend/node_modules/vitest/vitest.mjs'), 'run',
      ...TEST_FILES.vitest.map(p => p.slice('frontend/'.length)), '--reporter=json', `--outputFile=${machine}`],
    path.join(root, 'frontend'), path.join(directory, 'vitest.log'), context);
    if (!fs.existsSync(machine)) throw new Error('No Vitest machine report was produced');
    const bytes = fs.readFileSync(machine); cases = normalizeCases(runner, JSON.parse(bytes)); rawReports.push(bytes); allPassed = result.status === 0;
  } else {
    // Separate JUnit files bind every case to its declared source without relying
    // on the Node reporter's environment-dependent classname/location strings.
    for (let i = 0; i < TEST_FILES[runner].length; i++) {
      const file = TEST_FILES[runner][i], machine = path.join(directory, `node-${i}.xml`);
      const result = run(node, ['--test', '--test-reporter=junit', `--test-reporter-destination=${machine}`, path.join(root, file)],
        root, path.join(directory, `node-${i}.log`), context);
      if (!fs.existsSync(machine)) throw new Error('No Node machine report was produced');
      cases.push(...normalizeCases(runner, parseXml(machine,context), file)); rawReports.push(fs.readFileSync(machine)); allPassed &&= result.status === 0;
    }
  }
  const finishedAt = new Date().toISOString();
  const after = sourceRecords(runner, executionCommit);
  if (JSON.stringify(before) !== JSON.stringify(after) || git(['rev-parse', 'HEAD']) !== executionCommit
    || (git(['status','--porcelain']) === '') !== worktreeClean) throw new Error('Test source changed during execution');
  // Multi-file Node reports are length-framed to bind the exact ordered inputs.
  const bytes = Buffer.concat(rawReports.map(b => Buffer.concat([Buffer.from(`${b.length}:`), b])));
  const combined = path.join(directory, 'machine-reports.framed'); fs.writeFileSync(combined, bytes, {flag: 'wx', mode: 0o600});
  const report = {sha256: hash(bytes), bytes: bytes.length, digestKind: 'raw-machine-report-file-sha256'};
  const counts = {passed: 0, failed: 0, skipped: 0}; cases.forEach(c => counts[c.result]++);
  if (!allPassed && !counts.failed) throw new Error('Runner failed outside recorded cases');
  const changedSourceCount = before.filter(s => s.executionCommitSha256 !== null && !s.matchesExecutionCommit).length;
  const uncommittedSourceCount = before.filter(s => s.executionCommitSha256 === null).length;
  const sourceBinding = {scope:'selected-files-against-execution-commit',worktreeClean,
    selectedFilesStatus: changedSourceCount || uncommittedSourceCount ? 'modified':'clean',changedSourceCount,uncommittedSourceCount};
  const result = {id: `${runner}-${hash(`${startedAt}\0${report.sha256}`).slice(0,16)}`, runner, executionCommit,sourceBinding,
    controls:context.controls, startedAt, finishedAt, report, cases, sources: before, counts, granularity: 'case'};
  fs.writeFileSync(path.join(directory, 'batch.json'), `${JSON.stringify(result, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  return result;
}
function main(args) {
  if (args.length !== 1 || !['product', 'tools'].includes(args[0])) throw new Error('Usage: run-evidence-targeted.cjs product|tools');
  if (process.execPath !== fs.realpathSync(node)) throw new Error('Use the fixed project Node interpreter');
  const reportsRoot = path.join(root, '.tools/reports');
  const directory = fs.mkdtempSync(path.join(reportsRoot, 'evidence-targeted-'));
  fs.chmodSync(directory, 0o700);
  const batches = (args[0] === 'product' ? ['python','node','vitest'] : ['tools']).map(r => runBatch(r, directory));
  const coverage = buildCoverage(batches);
  fs.writeFileSync(path.join(directory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`, {flag: 'wx', mode: 0o600});
  process.stdout.write(`${JSON.stringify({directory, batches: batches.map(b => ({id:b.id, counts:b.counts})), passed: batches.every(b => !b.counts.failed && !b.counts.skipped)})}\n`);
  if (batches.some(b => b.counts.failed || b.counts.skipped)) process.exitCode = 1;
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; } }
module.exports = { normalizeCases, runBatch, batchEnvironment };
