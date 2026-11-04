'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { median, validateCriteria, validateRun, validatePair, deriveAaNoise, validateNoise,
  loadCalibrations, analyze, PHASE_CONTRACTS, ROWS, ORDER, AA_NOISE_METHOD, ACCEPTANCE_SCOPE } = require('./performance-comparison.cjs');
const A_SOURCE = 'a'.repeat(40), B_SOURCE = 'b'.repeat(40);
const INPUTS = { scenario: 'same' };
const activePhases = PHASE_CONTRACTS.filter(p => p.active).map(p => p.name);
const PRIMARY = activePhases[0];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture({ p95 = 40, cpu = 100, inputP95 = 5, over50 = 3, runNumber = 1, source = A_SOURCE } = {}) {
  const edge = { width: 1380, height: 900, devicePixelRatio: 2, screenName: 'test', screenRefreshRateHz: 60 };
  return { schema: 'reverie.qt.performance-run.v1', mode: 'perf', passed: true, performanceComparable: true,
    sourceHead: source, sourceDirty: false, noResidualProcesses: true, testDataRemoved: true, forcedCleanup: false,
    modelInputUnchanged: true, applicationUnchanged: true, workloadInputs: INPUTS, modelInput: { sha256: 'same' },
    rows: [...ROWS], buildManifestSha256: 'd'.repeat(64), runNumber,
    build: { schema: 'reverie.qt.local-build.v2', source: { head: source, dirty: false }, core: { version: 'fixed' },
      diagnostics: { qmlProfilerEnabled: false }, qt: { version: 'fixed' }, python: { version: 'fixed' }, node: 'fixed',
      externalFiles: [], externalTrees: [], compilation: { flags: 'same' } },
    environment: { macOS: 'fixed', hardware: 'test', architecture: 'arm64', node: 'fixed',
      powerBefore: "Now drawing from 'AC Power'", powerAfter: "Now drawing from 'AC Power'",
      powerSettingsBefore: 'lowpowermode 0', powerSettingsAfter: 'lowpowermode 0' },
    workloads: ROWS.map(rows => {
      let elapsed = 0; const inputs = [];
      const phases = PHASE_CONTRACTS.map((contract, index) => {
        const startElapsedMs = elapsed; elapsed += contract.plannedDurationMs;
        for (const [actionIndex, planned] of contract.inputs.entries()) inputs.push({ ...planned, phaseIndex: index, actionIndex,
          actualDispatchMs: planned.plannedDueMs + 5, completedMs: planned.plannedDueMs + 6, latenessMs: 5 });
        const cadence = { measured: true, sampleCount: 600, p95Ms: p95, over50Ms: over50 };
        return { index, name: contract.name, active: contract.active, plannedDurationMs: contract.plannedDurationMs,
          minimumIntervals: contract.active ? 300 : 0, complete: true, plannedInputs: contract.inputs.length,
          dispatchedInputs: contract.inputs.length, startElapsedMs, endElapsedMs: elapsed, durationMs: contract.plannedDurationMs,
          windowStateStart: { ...edge }, windowStateEnd: { ...edge }, cadence, mainCadence: cadence,
          processCpuMs: cpu, inputDispatchLateness: { measured: contract.active, sampleCount: contract.inputs.length, p95Ms: inputP95 } };
      });
      return { rows, fixture: { schema: 'reverie.qt.performance-fixture.v1', rows, encrypted: true, committed: true, historySha256: 'same' },
        scene: { schema: 'reverie.qt.performance-scenarios.v1', mode: 'perf', fixtureRows: rows, runStartUnixMs: runNumber * 1000000,
          scheduleVersion: 'moonroom-fixed-controls-v1', passed: true, performanceComparable: true,
          environmentFlags: { comparable: true }, cadenceDropped: 0, inputDropped: 0, inputs, phases } };
    }) };
}
function criteria(noise = undefined) {
  const tables = noise || Object.fromEntries(['aaNoise', 'aaOver50Noise', 'aaCpuNoise', 'aaInputP95NoiseMs'].map(name => [name,
    Object.fromEntries(ROWS.flatMap(rows => activePhases.map(phase => [`${rows}:${phase}`, 0])))]));
  return { schema: 'reverie.qt.performance-criteria.v1', order: [...ORDER], minimumImprovement: .10,
    maximumRegression: .05, maximumOver50Increase: .02, maximumInputP95IncreaseMs: 16.7,
    maxPhaseObservationOverrunMs: 100, acceptanceScope: ACCEPTANCE_SCOPE, aaNoiseMethod: AA_NOISE_METHOD,
    primaryPhases: [PRIMARY], ...tables };
}
function pairs(a = {}, b = {}) {
  return Array.from({ length: 3 }, (_, index) => ({ A: fixture({ ...a, runNumber: index * 2 + 1 }),
    B: fixture({ ...b, runNumber: index * 2 + 2, source: B_SOURCE }) }));
}
function phase(report, rows = 9, name = PRIMARY) { return report.workloads.find(w => w.rows === rows).scene.phases.find(p => p.name === name); }
function changeCadence(report, rows, name, key, value) {
  const p = phase(report, rows, name); p.cadence[key] = value; p.mainCadence[key] = value;
}
function withRegisteredReports(reports, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reverie-perf-comparison-test-'));
  try {
    const registered = reports.map((report, i) => {
      const file = path.join(directory, `${i + 1}.json`), bytes = Buffer.from(JSON.stringify(report));
      fs.writeFileSync(file, bytes); return { path: file, sha256: sha256(bytes) };
    });
    return callback(registered, directory);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('fixed criteria refuse missing, nonfinite, mistyped or changed thresholds and targets', () => {
  validateCriteria(criteria());
  for (const key of ['minimumImprovement', 'maximumRegression', 'maximumOver50Increase', 'maximumInputP95IncreaseMs', 'maxPhaseObservationOverrunMs'])
    for (const value of [undefined, null, NaN, Infinity, '0.1', -1]) assert.throws(() => validateCriteria({ ...criteria(), [key]: value }));
  for (const change of [c => c.maximumRegression = .10, c => c.minimumImprovement = .09,
    c => c.maxPhaseObservationOverrunMs = 101, c => c.acceptanceScope = 'any-history', c => c.aaNoiseMethod = 'manual',
    c => c.primaryPhases = ['missing'], c => c.primaryPhases = [PRIMARY, PRIMARY]]) {
    const c = criteria(); change(c); assert.throws(() => validateCriteria(c));
  }
});

test('report gate requires exact full schema/source, all 14 phase plans and every actual input', () => {
  assert.equal(PHASE_CONTRACTS.length, 14);
  assert.equal(PHASE_CONTRACTS.reduce((total, p) => total + p.inputs.length, 0), 546);
  assert.equal(validateRun(fixture(), { expectedSourceHead: A_SOURCE, expectedWorkloadInputs: INPUTS }).length, 42);
  for (const change of [r => r.schema = 'old', r => r.sourceHead = B_SOURCE, r => r.build.source.head = B_SOURCE,
    r => r.sourceDirty = true, r => r.build.source.dirty = true, r => r.applicationUnchanged = false,
    r => r.rows = [9, 100], r => r.workloads.pop(), r => r.workloads[0].rows = 100,
    r => r.workloads[0].scene.phases.pop(), r => phase(r).active = false, r => phase(r).plannedDurationMs = 35000,
    r => phase(r).plannedInputs = 39, r => phase(r).complete = false,
    r => phase(r).dispatchedInputs = 35, r => r.workloads[0].scene.inputs.pop(),
    r => r.workloads[0].scene.inputs[0].actionIndex = 1, r => r.workloads[0].scene.inputs[0].plannedDueMs = 1,
    r => r.workloads[0].scene.inputs[0].name = 'other', r => r.workloads[0].scene.cadenceDropped = 1,
    r => r.workloads[0].scene.environmentFlags.comparable = false, r => phase(r).cadence.sampleCount = 299,
    r => phase(r).mainCadence = { ...phase(r).cadence, p95Ms: 1 }]) {
    const report = fixture(); change(report);
    assert.throws(() => validateRun(report, { expectedSourceHead: A_SOURCE, expectedWorkloadInputs: INPUTS }));
  }
});

test('fixed input deadline is exact; only phase observation can overrun by at most 100ms', () => {
  const report = fixture(); const last = report.workloads[0].scene.inputs.filter(i => i.phaseIndex === 0).at(-1);
  last.actualDispatchMs = 29999; last.completedMs = 30000; last.latenessMs = last.actualDispatchMs - last.plannedDueMs;
  const finalIdle = report.workloads[0].scene.phases.at(-1); finalIdle.durationMs += 100; finalIdle.endElapsedMs += 100;
  const observations = validateRun(report);
  assert.equal(observations[0].latestCompletedMs, 30000); assert.equal(observations[13].observationOverrunMs, 100);
  const originalCadence = structuredClone(phase(report).cadence); assert.deepEqual(phase(report).cadence, originalCadence);
  last.completedMs = 30000.001; assert.throws(() => validateRun(report), /outside fixed window/);
  last.completedMs = 30000; last.actualDispatchMs = 30000.001; last.completedMs = 30000.001;
  last.latenessMs = last.actualDispatchMs - last.plannedDueMs; assert.throws(() => validateRun(report), /outside fixed window/);
  last.actualDispatchMs = 29999; last.completedMs = 30000; last.latenessMs = last.actualDispatchMs - last.plannedDueMs;
  finalIdle.durationMs += 1; finalIdle.endElapsedMs += 1;
  assert.throws(() => validateRun(report), /overrun exceeds 100ms/);
});

test('pair gate retains model, toolchain, power and per-phase display matching', () => {
  validatePair(fixture(), fixture({ source: B_SOURCE }));
  for (const change of [r => r.workloadInputs = { scenario: 'other' }, r => r.modelInput.sha256 = 'other',
    r => r.build.compilation.flags = 'different', r => phase(r).windowStateEnd.screenRefreshRateHz = 120,
    r => delete phase(r).windowStateEnd.devicePixelRatio, r => r.workloads[0].fixture.historySha256 = 'other',
    r => r.forcedCleanup = true, r => r.environment.powerAfter = "Now drawing from 'Battery Power'",
    r => r.environment.powerSettingsAfter = 'lowpowermode 1']) {
    const report = fixture({ source: B_SOURCE }); change(report); assert.throws(() => validatePair(fixture(), report));
  }
});

test('four A/A noises derive from worst unordered real pair and are order-independent', () => {
  const reports = [fixture({ p95: 40, cpu: 100, inputP95: 5, over50: 3 }),
    fixture({ p95: 42, cpu: 110, inputP95: 7, over50: 9, runNumber: 2 }),
    fixture({ p95: 44, cpu: 90, inputP95: 4, over50: 0, runNumber: 3 })];
  const measured = deriveAaNoise(reports), key = `9:${PRIMARY}`;
  assert.equal(measured.aaNoise[key], .10); assert.equal(measured.aaOver50Noise[key], .015);
  assert.equal(measured.aaCpuNoise[key], 20 / 90); assert.equal(measured.aaInputP95NoiseMs[key], 3);
  assert.deepEqual(deriveAaNoise(reports.toReversed()), measured);
  validateNoise(criteria(measured), measured);
  const wrong = criteria(measured); wrong.aaNoise[key] = 0; assert.throws(() => validateNoise(wrong, deriveAaNoise(reports)));
  const missing = criteria(); delete missing.aaCpuNoise[key]; assert.throws(() => validateNoise(missing));
  const extra = criteria(); extra.aaCpuNoise.extra = 0; assert.throws(() => validateNoise(extra));
  assert.throws(() => deriveAaNoise([reports[0], fixture({ source: B_SOURCE })]), /A\/A source differs/);
});

test('A/A registration rejects repeated paths, aliases, copied digests, changed bytes and partial suites before any run', () => {
  const reports = [fixture(), fixture({ p95: 42, runNumber: 2 })];
  const c = criteria(deriveAaNoise(reports));
  withRegisteredReports(reports, (registered, directory) => {
    c.calibrationReports = registered;
    assert.equal(loadCalibrations(c, { expectedSourceHead: A_SOURCE, expectedWorkloadInputs: INPUTS }).reports.length, 2);
    assert.throws(() => loadCalibrations({ ...c, calibrationReports: [registered[0], registered[0]] }), /distinct/);
    const alias = path.join(directory, 'alias.json'); fs.symlinkSync(registered[0].path, alias);
    assert.throws(() => loadCalibrations({ ...c, calibrationReports: [registered[0], { ...registered[0], path: alias }] }), /distinct/);
    const copy = path.join(directory, 'copy.json'); fs.copyFileSync(registered[0].path, copy);
    assert.throws(() => loadCalibrations({ ...c, calibrationReports: [registered[0], { ...registered[0], path: copy }] }), /distinct/);
    assert.throws(() => loadCalibrations(c, { expectedSourceHead: B_SOURCE }), /exact registered source/);
    const wrongNoise = structuredClone(c); wrongNoise.aaNoise[`9:${PRIMARY}`] = 0;
    assert.throws(() => loadCalibrations(wrongNoise), /noise differs/);
    fs.appendFileSync(registered[1].path, '\n'); assert.throws(() => loadCalibrations(c), /report changed/);
  });
  const partial = reports.map(report => ({ ...report, rows: [9, 100], workloads: report.workloads.slice(0, 2) }));
  withRegisteredReports(partial, registered => assert.throws(() => loadCalibrations({ ...c, calibrationReports: registered }), /Full/));
});

test('whole failed A/A suite cannot be accepted by retaining its completed histories', () => {
  const first = fixture(), failed = fixture({ runNumber: 2 }); failed.passed = false;
  phase(failed, 300).complete = false; phase(failed, 300).dispatchedInputs = 35;
  withRegisteredReports([first, failed], registered => {
    assert.throws(() => loadCalibrations({ ...criteria(), calibrationReports: registered }), /Failed or non-comparable/);
  });
});

test('cadence acceptance requires a primary gain for every history and retains two-pair agreement', () => {
  let runs = pairs({}, { p95: 32 }); let result = analyze(runs, criteria());
  assert.equal(result.performanceGainAccepted, true); assert.equal(result.qualityAccepted, false);
  assert.deepEqual(result.histories.map(h => h.hasPrimaryCadenceGain), [true, true, true]);
  for (const { B } of runs) changeCadence(B, 300, PRIMARY, 'p95Ms', 40);
  result = analyze(runs, criteria()); assert.equal(result.performanceGainAccepted, false);
  assert.deepEqual(result.histories.map(h => h.hasPrimaryCadenceGain), [true, true, false]);
  runs = pairs({}, { p95: 32 });
  for (const { B } of runs.slice(0, 2)) for (const rows of ROWS) changeCadence(B, rows, PRIMARY, 'p95Ms', 42);
  assert.equal(analyze(runs, criteria()).performanceGainAccepted, false);
  assert.throws(() => analyze(runs.slice(0, 2), criteria()), /Exactly three/);
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('all active scenes retain cadence, long-frame and input regression vetoes', () => {
  for (const change of [r => changeCadence(r, 300, activePhases[1], 'p95Ms', 45),
    r => changeCadence(r, 300, activePhases[1], 'over50Ms', 40),
    r => phase(r, 300, activePhases[1]).inputDispatchLateness.p95Ms = 50]) {
    const runs = pairs({}, { p95: 32 }); for (const { B } of runs) change(B);
    assert.equal(analyze(runs, criteria()).performanceGainAccepted, false);
  }
});

test('CPU savings remain separate; faster cadence with greater CPU is an explicit cost', () => {
  let runs = pairs({}, { cpu: 75 }); let result = analyze(runs, criteria());
  assert.equal(result.performanceGainAccepted, false); assert.equal(result.computationEfficiencyAccepted, true);
  runs = pairs({}, { p95: 25, cpu: 160 }); result = analyze(runs, criteria());
  assert.equal(result.performanceGainAccepted, true); assert.equal(result.computationEfficiencyAccepted, false);
  assert.equal(result.cpuCostIncreaseObserved, true);
  runs = pairs({}, { cpu: 75 }); for (const { B } of runs) phase(B, 300).processCpuMs = 100;
  assert.equal(analyze(runs, criteria()).computationEfficiencyAccepted, false);
});
