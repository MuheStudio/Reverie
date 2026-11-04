'use strict';
// Outer controller only. Keep this file outside the native build runtimeInputs:
// every child still uses its exact fixed source, verifier and isolation context.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { WORKLOAD_INPUT_PATHS } = require('../native-ui/check-performance.cjs');
const root = path.resolve(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const median = values => {
  assert(values.length && values.every(Number.isFinite), 'Median requires finite observations');
  const sorted = values.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ROWS = Object.freeze([9, 100, 300]);
const ORDER = Object.freeze(['A', 'B', 'B', 'A', 'A', 'B']);
const AA_NOISE_METHOD = 'maximum-unordered-pair-absolute-relative-to-smaller-v1';
const ACCEPTANCE_SCOPE = 'each-history-has-primary-gain';
const DEFAULT_GATES = Object.freeze({ maxPhaseObservationOverrunMs: 100 });
const NOISE_NAMES = Object.freeze(['aaNoise', 'aaOver50Noise', 'aaCpuNoise', 'aaInputP95NoiseMs']);

// This is the unchanged moonroom-fixed-controls-v1 schedule, including every
// declared action. It validates saved reports; it does not dispatch new inputs.
function phaseContracts() {
  const phases = [];
  const add = (name, active = true) => {
    const phase = { name, active, plannedDurationMs: active ? 30000 : 10000, inputs: [] };
    phases.push(phase); return phase;
  };
  const input = (phase, plannedDueMs, name) => phase.inputs.push({ plannedDueMs, name });
  const reading = add('reading-open-reverse-task-sequence');
  for (let cycle = 0; cycle < 5; ++cycle) {
    const due = cycle * 6000;
    for (const [offset, name] of [[0, cycle ? 'warm-reading-open' : 'cold-first-reading-open'],
      [150, 'reading-reverse'], [1000, 'reading-open-full'], [2000, 'task-memory'],
      [3000, 'task-settings'], [4000, 'task-character'], [5000, 'task-return-reading'], [5800, 'reading-close']])
      input(reading, due + offset, name);
  }
  const drag = add('handle-drag-with-native-avatar-action');
  for (let cycle = 0; cycle < 6; ++cycle) {
    const due = cycle * 5000;
    input(drag, due, 'native-avatar-return');
    for (const open of [true, false]) {
      const start = due + (open ? 200 : 2200);
      input(drag, start, open ? 'handle-open-press' : 'handle-close-press');
      for (let move = 1; move <= 3; ++move) input(drag, start + move * 100, 'handle-move');
      input(drag, start + 500, 'handle-release');
    }
  }
  const scroll = add('sustained-history-scroll');
  for (let due = 0; due < 30000; due += 90) {
    const older = due >= 28500 || Math.floor(due / 1500) % 2 === 0;
    input(scroll, due, older ? 'history-wheel-older' : 'history-wheel-latest');
  }
  const composer = add('composer-one-to-six-lines-grow-delete');
  for (let index = 0; index < 60; ++index) input(composer, index * 500, 'composer-grow-delete');
  const resize = add('resize-950-760-1180');
  for (let index = 0; index < 30; ++index) input(resize, index * 1000, 'window-resize');
  const replies = add('short-long-delayed-reply-behind-task');
  for (const due of [0, 4000, 10000]) {
    input(replies, due, 'reply-compose'); input(replies, due + 100, 'reply-send');
  }
  for (const [due, name] of [[10500, 'preserved-reply-draft'], [11000, 'held-selection-press'],
    [11200, 'held-selection-move'], [11400, 'held-selection-move'], [11600, 'held-selection-move'],
    [11800, 'held-selection-release'], [12000, 'reply-task-memory'], [14000, 'reply-task-settings'],
    [16000, 'reply-return-reading'], [18000, 'validate-preserved-reading-then-restore-draft']]) input(replies, due, name);
  replies.inputs.sort((a, b) => a.plannedDueMs - b.plannedDueMs);
  for (const state of ['companion', 'reading', 'memory', 'settings', 'character']) add(`idle-${state}-wide`, false);
  for (const state of ['memory', 'settings', 'character']) add(`idle-${state}-compact`, false);
  return Object.freeze(phases.map(p => Object.freeze({ ...p, inputs: Object.freeze(p.inputs.map(Object.freeze)) })));
}
const PHASE_CONTRACTS = phaseContracts();
const ACTIVE_PHASES = PHASE_CONTRACTS.filter(p => p.active).map(p => p.name);
const expectedNoiseKeys = () => ROWS.flatMap(rows => ACTIVE_PHASES.map(name => `${rows}:${name}`));
function clean() { assert.equal(git('status', '--porcelain'), '', 'Unknown working-tree changes; no stash, reset or cleanup will be performed'); }
function sourceHashes(ref) {
  return Object.fromEntries(WORKLOAD_INPUT_PATHS.map(name => [name,
    hash(execFileSync('git', ['show', `${ref}:${name}`], { cwd: root }))]));
}
function powerState(environment, edge) {
  const supply = environment[`power${edge}`]?.match(/Now drawing from '(AC Power|Battery Power)'/)?.[1];
  assert(supply, 'Unknown power supply');
  const lowPower = environment[`powerSettings${edge}`]?.match(/\blowpowermode\s+(\d+)/)?.[1];
  assert(lowPower !== undefined, 'Low power mode was not observed');
  return { supply, lowPower: Number(lowPower) };
}
function finite(value, label, minimum = 0) {
  assert(Number.isFinite(value) && value >= minimum, `Invalid ${label}`); return value;
}
function validateCriteria(criteria) {
  assert.equal(criteria.schema, 'reverie.qt.performance-criteria.v1');
  assert.deepEqual(criteria.order, ORDER);
  for (const [name, fixed] of [['minimumImprovement', .10], ['maximumRegression', .05],
    ['maximumOver50Increase', .02], ['maximumInputP95IncreaseMs', 16.7], ['maxPhaseObservationOverrunMs', 100]]) {
    finite(criteria[name], `threshold ${name}`); assert.equal(criteria[name], fixed, `Registered threshold changed: ${name}`);
  }
  assert.equal(criteria.acceptanceScope, ACCEPTANCE_SCOPE);
  assert.equal(criteria.aaNoiseMethod, AA_NOISE_METHOD);
  assert(Array.isArray(criteria.primaryPhases) && criteria.primaryPhases.length > 0, 'Primary phases are required');
  assert.equal(new Set(criteria.primaryPhases).size, criteria.primaryPhases.length, 'Duplicate primary phase');
  assert(criteria.primaryPhases.every(name => ACTIVE_PHASES.includes(name)), 'Unknown primary phase');
}
function validateRun(report, { expectedSourceHead, expectedWorkloadInputs, maxPhaseObservationOverrunMs = 100 } = {}) {
  assert.equal(maxPhaseObservationOverrunMs, 100, 'Observation overrun allowance must be preregistered at 100ms');
  assert.equal(report.schema, 'reverie.qt.performance-run.v1'); assert.equal(report.mode, 'perf');
  assert(report.passed === true && report.performanceComparable === true && report.sourceDirty === false, 'Failed or non-comparable run');
  assert(report.noResidualProcesses === true && report.testDataRemoved === true && !report.forcedCleanup, 'Cleanup did not pass');
  assert(report.modelInputUnchanged === true && report.applicationUnchanged === true, 'Run inputs changed');
  assert(/^[a-f0-9]{40}$/.test(report.sourceHead), 'Invalid run source identity');
  if (expectedSourceHead) assert.equal(report.sourceHead, expectedSourceHead, 'Run must use its exact registered source');
  assert.equal(report.build?.schema, 'reverie.qt.local-build.v2');
  assert.equal(report.build.source?.head, report.sourceHead, 'Build and measured source differ');
  assert.equal(report.build.source?.dirty, false, 'Dirty build source');
  assert(report.build.core && report.build.diagnostics?.qmlProfilerEnabled === false, 'Ordinary licensed build required');
  assert(/^[a-f0-9]{64}$/.test(report.buildManifestSha256), 'Missing build manifest identity');
  if (expectedWorkloadInputs) assert.deepEqual(report.workloadInputs, expectedWorkloadInputs, 'Measurement inputs differ from the fixed source');
  assert.deepEqual(report.rows, ROWS, 'Full [9,100,300] suite required');
  assert(Array.isArray(report.workloads) && report.workloads.length === ROWS.length, 'Incomplete workload suite');
  const observations = [];
  for (const [workloadIndex, rows] of ROWS.entries()) {
    const workload = report.workloads[workloadIndex]; assert.equal(workload.rows, rows, 'Workload order or history size differs');
    assert.equal(workload.fixture?.schema, 'reverie.qt.performance-fixture.v1'); assert.equal(workload.fixture.rows, rows);
    assert(workload.fixture.encrypted === true && workload.fixture.committed === true, 'Incomplete encrypted fixture');
    const scene = workload.scene;
    assert.equal(scene?.schema, 'reverie.qt.performance-scenarios.v1'); assert.equal(scene.mode, 'perf');
    assert.equal(scene.fixtureRows, rows); assert.equal(scene.scheduleVersion, 'moonroom-fixed-controls-v1');
    assert(scene.passed === true && scene.performanceComparable === true && scene.environmentFlags?.comparable === true, 'Native scene is not comparable');
    assert.equal(scene.cadenceDropped, 0, 'Dropped cadence records'); assert.equal(scene.inputDropped, 0, 'Dropped input records');
    assert(Array.isArray(scene.phases) && scene.phases.length === PHASE_CONTRACTS.length, 'All 14 registered phases are required');
    assert(Array.isArray(scene.inputs), 'Actual input records are required');
    const expectedInputCount = PHASE_CONTRACTS.reduce((total, p) => total + p.inputs.length, 0);
    assert.equal(scene.inputs.length, expectedInputCount, 'Incomplete or extra actual inputs');
    let inputIndex = 0, previousPhaseEnd = 0;
    for (const [phaseIndex, contract] of PHASE_CONTRACTS.entries()) {
      const phase = scene.phases[phaseIndex], label = `${rows}/${contract.name}`;
      assert.equal(phase.index, phaseIndex, `Phase index differs: ${label}`); assert.equal(phase.name, contract.name, `Phase differs: ${label}`);
      assert.equal(phase.active, contract.active, `Phase activity differs: ${label}`);
      assert.equal(phase.plannedDurationMs, contract.plannedDurationMs, `Phase duration plan differs: ${label}`);
      assert.equal(phase.minimumIntervals, contract.active ? 300 : 0, `Minimum intervals differ: ${label}`);
      assert.equal(phase.plannedInputs, contract.inputs.length, `Planned input count differs: ${label}`);
      assert(phase.complete === true && phase.dispatchedInputs === contract.inputs.length, `Incomplete phase: ${label}`);
      finite(phase.startElapsedMs, `phase start ${label}`); finite(phase.endElapsedMs, `phase end ${label}`);
      assert(phase.startElapsedMs >= previousPhaseEnd, `Overlapping phases: ${label}`); previousPhaseEnd = phase.endElapsedMs;
      finite(phase.durationMs, `observed phase duration ${label}`, contract.plannedDurationMs);
      assert.equal(phase.endElapsedMs - phase.startElapsedMs, phase.durationMs, `Inconsistent phase duration: ${label}`);
      const overrun = phase.durationMs - contract.plannedDurationMs;
      assert(overrun <= maxPhaseObservationOverrunMs, `Phase observation overrun exceeds 100ms: ${label}/${overrun}`);
      if (contract.active) {
        assert.equal(phase.cadence?.measured, true, `Unknown cadence: ${label}`);
        assert.deepEqual(phase.cadence, phase.mainCadence, `Cadence alias differs: ${label}`);
        finite(phase.cadence.p95Ms, `cadence P95 ${label}`, Number.MIN_VALUE);
        assert(Number.isInteger(phase.cadence.sampleCount) && phase.cadence.sampleCount >= 300, `Insufficient active samples: ${label}`);
        assert(Number.isInteger(phase.cadence.over50Ms) && phase.cadence.over50Ms >= 0 && phase.cadence.over50Ms <= phase.cadence.sampleCount, `Invalid long-frame count: ${label}`);
        finite(phase.processCpuMs, `process CPU ${label}`, Number.MIN_VALUE);
        assert.equal(phase.inputDispatchLateness?.measured, true, `Unknown input scheduling: ${label}`);
        assert.equal(phase.inputDispatchLateness.sampleCount, contract.inputs.length, `Input timing count differs: ${label}`);
        finite(phase.inputDispatchLateness.p95Ms, `input P95 ${label}`);
      }
      let latestActualDispatchMs = null, latestCompletedMs = null;
      for (const [actionIndex, planned] of contract.inputs.entries()) {
        const actual = scene.inputs[inputIndex++];
        assert.equal(actual.phaseIndex, phaseIndex, `Input phase differs: ${label}/${actionIndex}`);
        assert.equal(actual.actionIndex, actionIndex, `Input action order differs: ${label}/${actionIndex}`);
        assert.equal(actual.name, planned.name, `Input name differs: ${label}/${actionIndex}`);
        assert.equal(actual.plannedDueMs, planned.plannedDueMs, `Input due time differs: ${label}/${actionIndex}`);
        finite(actual.actualDispatchMs, `actual dispatch ${label}/${actionIndex}`, planned.plannedDueMs);
        finite(actual.completedMs, `input completion ${label}/${actionIndex}`, actual.actualDispatchMs);
        assert(latestCompletedMs === null || actual.actualDispatchMs >= latestCompletedMs, `Input clock moved backwards: ${label}/${actionIndex}`);
        assert(actual.actualDispatchMs <= contract.plannedDurationMs && actual.completedMs <= contract.plannedDurationMs,
          `Input outside fixed window: ${label}/${actionIndex}`);
        assert.equal(actual.latenessMs, actual.actualDispatchMs - planned.plannedDueMs, `Input lateness differs: ${label}/${actionIndex}`);
        latestActualDispatchMs = actual.actualDispatchMs; latestCompletedMs = actual.completedMs;
      }
      observations.push({ rows, phase: contract.name, plannedDurationMs: contract.plannedDurationMs,
        durationMs: phase.durationMs, observationOverrunMs: overrun, latestActualDispatchMs, latestCompletedMs });
    }
  }
  return observations;
}
function validatePair(a, b, gates = DEFAULT_GATES) {
  for (const report of [a, b]) validateRun(report, gates);
  assert.deepEqual(a.workloadInputs, b.workloadInputs, 'Measurement or workload code differs');
  assert.deepEqual(a.modelInput, b.modelInput, 'Model input differs');
  for (const key of ['qt', 'python', 'node', 'externalFiles', 'externalTrees', 'compilation']) assert.deepEqual(a.build[key], b.build[key], `Toolchain/build setting differs: ${key}`);
  for (const key of ['macOS', 'hardware', 'architecture', 'node']) assert.equal(a.environment[key], b.environment[key], `Host differs: ${key}`);
  const supply = powerState(a.environment, 'Before');
  for (const report of [a, b]) for (const edge of ['Before', 'After']) assert.deepEqual(powerState(report.environment, edge), supply, 'Power condition changed');
  for (let i = 0; i < ROWS.length; ++i) {
    const x = a.workloads[i], y = b.workloads[i]; assert.deepEqual(x.fixture, y.fixture, 'Seeded encrypted history semantics differ');
    for (let j = 0; j < PHASE_CONTRACTS.length; ++j) {
      const p = x.scene.phases[j], q = y.scene.phases[j];
      for (const edge of ['windowStateStart', 'windowStateEnd']) for (const key of ['width', 'height', 'devicePixelRatio', 'screenName', 'screenRefreshRateHz']) {
        assert(p[edge]?.[key] !== undefined && p[edge]?.[key] !== null && q[edge]?.[key] !== undefined && q[edge]?.[key] !== null, `Missing window condition: ${key}`);
        assert.deepEqual(p[edge][key], q[edge][key], `Window condition differs: ${p.name}/${edge}/${key}`);
      }
    }
  }
}
function deriveAaNoise(reports, gates = DEFAULT_GATES) {
  assert(Array.isArray(reports) && reports.length >= 2, 'Two independent A/A reports are required');
  for (const report of reports) {
    validateRun(report, gates);
    assert.equal(report.sourceHead, reports[0].sourceHead, 'A/A source differs');
  }
  for (let i = 0; i < reports.length; ++i) for (let j = i + 1; j < reports.length; ++j) validatePair(reports[i], reports[j], gates);
  const noise = Object.fromEntries(NOISE_NAMES.map(name => [name, {}]));
  for (const rows of ROWS) for (const phase of ACTIVE_PHASES) {
    const key = `${rows}:${phase}`;
    for (const name of NOISE_NAMES) noise[name][key] = 0;
    for (let i = 0; i < reports.length; ++i) for (let j = i + 1; j < reports.length; ++j) {
      const select = report => report.workloads.find(w => w.rows === rows).scene.phases.find(p => p.name === phase);
      const a = select(reports[i]), b = select(reports[j]);
      const relative = (x, y) => Math.abs(x - y) / Math.min(x, y);
      const values = { aaNoise: relative(a.cadence.p95Ms, b.cadence.p95Ms),
        aaOver50Noise: Math.abs(a.cadence.over50Ms / a.cadence.sampleCount - b.cadence.over50Ms / b.cadence.sampleCount),
        aaCpuNoise: relative(a.processCpuMs, b.processCpuMs),
        aaInputP95NoiseMs: Math.abs(a.inputDispatchLateness.p95Ms - b.inputDispatchLateness.p95Ms) };
      for (const name of NOISE_NAMES) noise[name][key] = Math.max(noise[name][key], values[name]);
    }
  }
  return noise;
}
function validateNoise(criteria, measured) {
  const keys = expectedNoiseKeys().sort();
  for (const name of NOISE_NAMES) {
    assert(criteria[name] && typeof criteria[name] === 'object' && !Array.isArray(criteria[name]), `Missing measured A/A noise: ${name}`);
    assert.deepEqual(Object.keys(criteria[name]).sort(), keys, `Incomplete or extra A/A noise keys: ${name}`);
    for (const key of keys) {
      finite(criteria[name][key], `A/A noise ${name}/${key}`);
      if (measured) assert.equal(criteria[name][key], measured[name][key], `A/A noise differs from registered reports: ${name}/${key}`);
    }
  }
}
function loadCalibrations(criteria, expected = {}) {
  validateCriteria(criteria);
  assert(Array.isArray(criteria.calibrationReports) && criteria.calibrationReports.length >= 2, 'Two registered A/A calibration reports are required');
  const paths = new Set(), digests = new Set(), reports = [], identities = [];
  for (const registered of criteria.calibrationReports) {
    assert(path.isAbsolute(registered.path) && /^[a-f0-9]{64}$/.test(registered.sha256), 'Invalid calibration identity');
    const canonical = fs.realpathSync(registered.path);
    assert(!paths.has(canonical) && !digests.has(registered.sha256), 'Calibration reports must be distinct');
    paths.add(canonical); digests.add(registered.sha256);
    const bytes = fs.readFileSync(canonical); assert.equal(hash(bytes), registered.sha256, 'Calibration report changed');
    const report = JSON.parse(bytes);
    const observations = validateRun(report, { ...expected, maxPhaseObservationOverrunMs: criteria.maxPhaseObservationOverrunMs });
    reports.push(report); identities.push({ path: canonical, sha256: registered.sha256, sourceHead: report.sourceHead, phaseObservations: observations });
  }
  const measuredNoise = deriveAaNoise(reports, criteria); validateNoise(criteria, measuredNoise);
  return { reports, registration: { identities, noiseMethod: AA_NOISE_METHOD, measuredNoise } };
}
function analyze(pairs, criteria) {
  validateCriteria(criteria); validateNoise(criteria);
  assert(Array.isArray(pairs) && pairs.length === 3, 'Exactly three independent A/B pairs are required');
  for (const { A, B } of pairs) validatePair(A, B, criteria);
  const groups = [];
  for (const rows of ROWS) for (const phase of ACTIVE_PHASES) {
    const values = pairs.map(({ A, B }) => {
      const select = report => report.workloads.find(w => w.rows === rows).scene.phases.find(p => p.name === phase);
      const a = select(A), b = select(B);
      return { baselineP95: a.cadence.p95Ms, optimizedP95: b.cadence.p95Ms,
        relativeImprovement: (a.cadence.p95Ms - b.cadence.p95Ms) / a.cadence.p95Ms,
        baselineOver50Rate: a.cadence.over50Ms / a.cadence.sampleCount, optimizedOver50Rate: b.cadence.over50Ms / b.cadence.sampleCount,
        baselineCpuMs: a.processCpuMs, optimizedCpuMs: b.processCpuMs,
        cpuRelativeImprovement: (a.processCpuMs - b.processCpuMs) / a.processCpuMs,
        baselineInputP95Ms: a.inputDispatchLateness.p95Ms, optimizedInputP95Ms: b.inputDispatchLateness.p95Ms };
    });
    const key = `${rows}:${phase}`, noise = criteria.aaNoise[key], improvement = median(values.map(v => v.relativeImprovement));
    const positivePairs = values.filter(v => v.relativeImprovement > 0).length;
    const rateImprovement = median(values.map(v => v.baselineOver50Rate - v.optimizedOver50Rate));
    const rateNoise = criteria.aaOver50Noise[key], cpuNoise = criteria.aaCpuNoise[key];
    const cpuImprovement = median(values.map(v => v.cpuRelativeImprovement));
    const inputIncrease = median(values.map(v => v.optimizedInputP95Ms - v.baselineInputP95Ms));
    const inputNoise = criteria.aaInputP95NoiseMs[key];
    groups.push({ rows, phase, values, aaNoise: noise, medianRelativeImprovement: improvement, positivePairs,
      primary: criteria.primaryPhases.includes(phase), meetsImprovement: improvement >= Math.max(criteria.minimumImprovement, noise) && positivePairs >= 2,
      medianOver50RateReduction: rateImprovement, aaOver50Noise: rateNoise,
      over50Regression: rateImprovement < -Math.max(criteria.maximumOver50Increase, rateNoise),
      medianCpuRelativeImprovement: cpuImprovement, aaCpuNoise: cpuNoise,
      meetsEfficiencyImprovement: cpuImprovement >= Math.max(criteria.minimumImprovement, cpuNoise) && values.filter(v => v.cpuRelativeImprovement > 0).length >= 2,
      cpuRegression: cpuImprovement < -Math.max(criteria.maximumRegression, cpuNoise),
      inputP95IncreaseMs: inputIncrease, aaInputP95NoiseMs: inputNoise,
      inputRegression: inputIncrease > Math.max(criteria.maximumInputP95IncreaseMs, inputNoise),
      regression: improvement < -Math.max(criteria.maximumRegression, noise) });
  }
  const noRegression = groups.every(g => !g.regression && !g.over50Regression && !g.inputRegression);
  const histories = ROWS.map(rows => ({ rows,
    hasPrimaryCadenceGain: groups.some(g => g.rows === rows && g.primary && g.meetsImprovement),
    hasPrimaryEfficiencyGain: groups.some(g => g.rows === rows && g.primary && g.meetsEfficiencyImprovement) }));
  // Faster presentation can increase total CPU by rendering more frames. Keep
  // that cost visible; cadence improvement never establishes CPU savings.
  return { groups, histories, acceptanceScope: ACCEPTANCE_SCOPE,
    performanceGainAccepted: histories.every(h => h.hasPrimaryCadenceGain) && noRegression,
    computationEfficiencyAccepted: histories.every(h => h.hasPrimaryEfficiencyGain) && noRegression && groups.every(g => !g.cpuRegression),
    cpuCostIncreaseObserved: groups.some(g => g.cpuRegression), qualityAccepted: false,
    cadenceScope: 'Unchanged native mainCadence/cadence distributions, including every recorded interval; no trimming or recomputation.',
    scope: 'Each of 9/100/300 histories needs a registered primary gain; all active scenes retain regression gates. Functional and visual acceptance remain mandatory separate evidence.' };
}
async function main(args = process.argv.slice(2)) {
  const options = { run: false };
  for (let i = 0; i < args.length; ++i) {
    if (args[i] === '--run') { assert(!options.run, 'Duplicate --run'); options.run = true; }
    else if (['--baseline-ref', '--optimized-ref', '--baseline-dir', '--optimized-dir', '--criteria'].includes(args[i])) {
      const key = args[i].slice(2); assert(args[i + 1] && !args[i + 1].startsWith('--') && !options[key]); options[key] = args[++i];
    } else throw Error('Unknown comparator option');
  }
  for (const key of ['baseline-ref', 'optimized-ref', 'baseline-dir', 'optimized-dir', 'criteria']) assert(options[key], `Missing ${key}`);
  for (const key of ['baseline-dir', 'optimized-dir', 'criteria']) assert(path.isAbsolute(options[key]), `Absolute ${key} required`);
  clean(); const branch = git('symbolic-ref', '--short', 'HEAD'), head = git('rev-parse', 'HEAD');
  const refs = { A: git('rev-parse', '--verify', `${options['baseline-ref']}^{commit}`), B: git('rev-parse', '--verify', `${options['optimized-ref']}^{commit}`) };
  assert.notEqual(refs.A, refs.B, 'Distinct fixed A/B sources are required');
  const workloadInputs = sourceHashes(refs.A); assert.deepEqual(workloadInputs, sourceHashes(refs.B), 'Common measurement sources differ');
  const criteriaBytes = fs.readFileSync(options.criteria), criteria = JSON.parse(criteriaBytes); validateCriteria(criteria);
  if (!options.run) { console.log(JSON.stringify({ branch, head, refs, order: criteria.order, criteriaSha256: hash(criteriaBytes), calibrationValidated: false })); return; }
  const calibration = loadCalibrations(criteria, { expectedSourceHead: refs.A, expectedWorkloadInputs: workloadInputs });
  const out = fs.mkdtempSync(path.join(root, '.tools/reports/qt-perf-ab-'));
  const result = { schema: 'reverie.qt.performance-comparison.v1', originalBranch: branch, originalHead: head,
    verifierSha256: hash(fs.readFileSync(__filename)), refs, criteria, criteriaSha256: hash(criteriaBytes),
    calibrationValidation: calibration.registration, runs: [], restored: false, passed: false };
  let activeChild, aborted = false;
  const stop = () => { aborted = true; if (activeChild?.connected) activeChild.send({ type: 'abort-performance' }, () => {}); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    for (const [index, variant] of criteria.order.entries()) {
      assert(!aborted, 'Comparison interrupted'); clean(); git('switch', '--detach', refs[variant]); assert.equal(git('rev-parse', 'HEAD'), refs[variant]);
      const logfile = path.join(out, `${index + 1}-${variant}.log`), fd = fs.openSync(logfile, 'wx');
      const child = spawn(process.execPath, [path.join(root, 'native-ui/check-performance.cjs'), '--mode', 'perf', '--full-suite',
        '--build-dir', options[variant === 'A' ? 'baseline-dir' : 'optimized-dir']], { cwd: root, stdio: ['ignore', fd, fd, 'ipc'] }); activeChild = child;
      const exit = await new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
      activeChild = null; fs.closeSync(fd);
      const lines = fs.readFileSync(logfile, 'utf8').trim().split('\n'); let last; try { last = JSON.parse(lines.at(-1)); } catch {}
      const entry = { variant, source: refs[variant], exit, logfile: path.relative(root, logfile), reportRoot: last?.reportRoot }; result.runs.push(entry);
      fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify(result, null, 2));
      assert.equal(exit.code, 0, `Run failed: ${logfile}`); assert(last?.passed && last.performanceComparable, `Run not comparable: ${logfile}`);
      const data = JSON.parse(fs.readFileSync(path.join(last.reportRoot, 'summary.json')));
      entry.phaseObservations = validateRun(data, { expectedSourceHead: refs[variant], expectedWorkloadInputs: workloadInputs,
        maxPhaseObservationOverrunMs: criteria.maxPhaseObservationOverrunMs });
      validatePair(calibration.reports[0], data, criteria);
      if (index % 2 === 1) {
        const previous = JSON.parse(fs.readFileSync(path.join(result.runs[index - 1].reportRoot, 'summary.json'))); validatePair(previous, data, criteria);
      }
      clean(); console.log(JSON.stringify(entry));
    }
    const loaded = result.runs.map(run => ({ ...run, data: JSON.parse(fs.readFileSync(path.join(run.reportRoot, 'summary.json'))) })), pairs = [];
    for (let i = 0; i < 6; i += 2) {
      const pair = loaded.slice(i, i + 2); const A = pair.find(x => x.variant === 'A').data, B = pair.find(x => x.variant === 'B').data;
      validatePair(A, B, criteria); pairs.push({ A, B });
    }
    result.analysis = analyze(pairs, criteria); result.passed = true;
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { clean(); assert.equal(git('rev-parse', branch), head, 'Development branch moved unexpectedly'); git('switch', branch); assert.equal(git('rev-parse', 'HEAD'), head); result.restored = true; }
    catch (error) { result.restoreError = String(error); process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ reportRoot: out, passed: result.passed, restored: result.restored, gain: result.analysis?.performanceGainAccepted, error: result.error }));
  }
  return result;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { median, validateCriteria, validateRun, validatePair, deriveAaNoise, validateNoise, loadCalibrations,
  analyze, main, PHASE_CONTRACTS, ROWS, ORDER, AA_NOISE_METHOD, ACCEPTANCE_SCOPE };
