'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateContract, validateRegistration, validateRun, validatePair, deriveAaNoise, loadCalibrations, analyze,
  expectedContract, distribution, contractHash, hash, PROTOCOL, ROWS, PHASE_NAMES } = require('./companion-performance-comparison.cjs');
const { registration: fixed } = require('./companion-performance-contract.cjs');
const { modelPolicyRecord } = require('../native-ui/perf-model-server.cjs');
const patch = ['native-ui/check-performance.cjs', 'native-ui/perf-harness.test.cjs', 'native-ui/perf-model-server.cjs',
  'native-ui/src/main.cpp', 'native-ui/tests/PerfScenarioCheck.cpp', 'native-ui/tests/PerfScenarioCheck.h'];
function registration() {
  const files = patch.map(p => ({ path: p, type: 'file', bytes: 0, sha256: 'c'.repeat(64) }));
  return { schema: 'reverie.qt.companion-pre-run-registration.v1', sourceRegistration: { contents: structuredClone(fixed) },
    mockPolicy: modelPolicyRecord(PROTOCOL), workloadInputs: Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`file-${i}`, 'c'.repeat(64)])),
    measurementFiles: files, measurementInventory: { digestKind: 'ordered-file-link-inventory-sha256', sha256: hash(JSON.stringify(files)), count: 6 },
    candidates: Object.fromEntries(['A', 'B'].map(v => [v, { source: v.toLowerCase().repeat(40), directory: `/candidate/${v}`,
      productSource: fixed.productReferences[v], buildManifestSha256: v.toLowerCase().repeat(64) }])) };
}
function fixture(r, variant = 'A', cadenceMs = 40, cpu = 20, boundaryMs = 200, runId = 1) {
  const c = expectedContract(), edge = { width: 1380, height: 900, devicePixelRatio: 2, screenName: 'test', screenRefreshRateHz: 60 };
  return { schema: 'reverie.qt.performance-run.v1', protocol: PROTOCOL, mode: 'perf', passed: true, performanceComparable: true,
    sourceDirty: false, sourceHead: r.candidates[variant].source, buildManifestSha256: r.candidates[variant].buildManifestSha256,
    build: { schema: 'reverie.qt.local-build.v2', source: { head: r.candidates[variant].source, dirty: false }, core: {}, diagnostics: { qmlProfilerEnabled: false },
      qt: 'same', python: 'same', node: 'same', externalFiles: [], externalTrees: [], compilation: {} },
    applicationUnchanged: true, modelInputUnchanged: true, noResidualProcesses: true, testDataRemoved: true,
    workloadInputs: structuredClone(r.workloadInputs), mockPolicy: structuredClone(r.mockPolicy), modelInput: 'same', rows: ROWS,
    environment: { macOS: 'same', hardware: 'same', architecture: 'arm64', node: 'same', powerBefore: "Now drawing from 'AC Power'",
      powerAfter: "Now drawing from 'AC Power'", powerSettingsBefore: 'lowpowermode 0', powerSettingsAfter: 'lowpowermode 0',
      thermalBefore: 'No thermal warning recorded', thermalAfter: 'No thermal warning recorded' }, runId,
    workloads: ROWS.map(rows => {
      const scene = { schema: 'reverie.qt.companion-transactions.v1', protocol: PROTOCOL, mode: 'perf', fixtureRows: rows,
        scheduleVersion: 'moonroom-companion-transactions-v1', passed: true, performanceComparable: true, environmentFlags: { comparable: true },
        plannedTransactionContract: expectedContract(), cadenceDropped: 0, inputDropped: 0, driverBoundaryDropped: 0,
        diagnostics: { renderLoop: { observed: 'basic' }, actualGlContext: { graphicsApi: 'opengl', isOpenGLES: false,
          vendor: 'same', renderer: 'same', versionString: 'same', shadingLanguageVersion: 'same', majorVersion: 2, minorVersion: 1,
          profile: 'same', samples: 0, swapInterval: 1, depthBufferSize: 32, stencilBufferSize: 8, extensions: ['same'] },
          viewport: { logicalWidth: 1380, logicalHeight: 900, effectiveDevicePixelRatio: 2, windowDevicePixelRatio: 2,
            physicalWidthRounded: 2760, physicalHeightRounded: 1800, screen: 'test', screenRefreshRateHz: 60 } },
        phases: [], inputs: [], activeSegments: [], cadenceSamples: [], boundaryCrossingSamples: [], driverBoundaries: [{ kind: 0, elapsedNs: 0 }],
        committedReplies: ['性能短回复', '性能长回复，请认真给我完整说明', '性能延迟回复，请认真给我完整说明'].map((prompt, i) =>
          ({ prompt, complete: true, requestAssistantRows: 1, requestId: `reply-${runId}-${i}`, assistantTextSha256: String(i + 1).repeat(64),
            assistantUtf8Bytes: 100 + i, assistantCharacters: i === 0 ? 12 : 2000 })) };
      let total = 0;
      for (const plan of c.phasePlan) {
        const start = total; let elapsed = 0, action = 0;
        for (const tx of plan.transactions) {
          if (tx.index) {
            scene.driverBoundaries.push({ phaseIndex: plan.phaseIndex, kind: 1, detail: 5, elapsedNs: (start + elapsed) * 1e6 });
            elapsed += 150;
            scene.driverBoundaries.push({ phaseIndex: plan.phaseIndex, kind: 2, detail: 5, elapsedNs: (start + elapsed) * 1e6 });
          }
          const seg = { index: scene.activeSegments.length, phaseIndex: plan.phaseIndex, transactionIndex: tx.index, name: tx.name,
            startMs: elapsed, endMs: elapsed + (plan.phaseIndex === 2 ? 30000 : 1200), durationMs: plan.phaseIndex === 2 ? 30000 : 1200,
            processCpuMs: cpu, framesAfterReady: 3, complete: true };
          scene.activeSegments.push(seg);
          for (const input of tx.inputs) scene.inputs.push({ phaseIndex: plan.phaseIndex, transactionIndex: tx.index, actionIndex: action++,
            name: input.name, plannedDueMs: seg.startMs + input.dueMs, actualDispatchMs: seg.startMs + input.dueMs + 1,
            completedMs: seg.startMs + input.dueMs + 2, latenessMs: 1 });
          const count = plan.phaseIndex === 2 ? 300 : 10;
          for (let i = 0; i < count; ++i) scene.cadenceSamples.push({ phaseIndex: plan.phaseIndex, activeSegmentIndex: seg.index,
            phaseElapsedEndMs: seg.startMs + 10 + (i + 1) * (plan.phaseIndex === 2 ? Math.min(cadenceMs, 90) : cadenceMs), intervalMs: cadenceMs });
          scene.boundaryCrossingSamples.push({ phaseIndex: plan.phaseIndex, activeSegmentIndex: seg.index, phaseElapsedEndMs: seg.startMs + 10, intervalMs: boundaryMs, boundaryKind: 'enter-active' },
            { phaseIndex: plan.phaseIndex, activeSegmentIndex: seg.index, phaseElapsedEndMs: seg.endMs + 10, intervalMs: 10, boundaryKind: 'leave-active' });
          elapsed = seg.endMs;
        }
        total += elapsed + 50;
        const own = scene.activeSegments.filter(s => s.phaseIndex === plan.phaseIndex), activeDurationMs = own.reduce((n, s) => n + s.durationMs, 0), activeCpu = own.reduce((n, s) => n + s.processCpuMs, 0);
        const cadence = distribution(scene.cadenceSamples.filter(s => s.phaseIndex === plan.phaseIndex).map(s => s.intervalMs));
        scene.phases.push({ index: plan.phaseIndex, name: plan.name, active: true, complete: true, plannedDurationMs: 0, minimumIntervals: 300,
          plannedInputs: plan.inputCount, dispatchedInputs: plan.inputCount, plannedTransactions: plan.transactionCount, completedTransactions: plan.transactionCount,
          startElapsedMs: start, endElapsedMs: total, durationMs: elapsed + 50, activeDurationMs, activeProcessCpuMs: activeCpu, processCpuMs: activeCpu,
          processCpuPercentOneCore: activeCpu * 100 / activeDurationMs, phaseWallProcessCpuMs: activeCpu + 100,
          phaseWallProcessCpuPercentOneCore: (activeCpu + 100) * 100 / (elapsed + 50), pauseMs: (plan.transactionCount - 1) * 150,
          backendWaitMs: 0, gateWaitMs: 0, tailSettleMs: 0, cadence, mainCadence: cadence,
          inputDispatchLateness: distribution(scene.inputs.filter(i => i.phaseIndex === plan.phaseIndex).map(i => i.latenessMs)), windowStateStart: edge, windowStateEnd: edge });
      }
      const idleNames = ['companion', 'reading', 'memory', 'settings', 'character'].map(n => `idle-${n}-wide`)
        .concat(['memory', 'settings', 'character'].map(n => `idle-${n}-compact`));
      for (let i = 6; i < 14; ++i) {
        scene.phases.push({ index: i, name: idleNames[i - 6], active: false, complete: true, plannedDurationMs: 10000, durationMs: 10000,
          startElapsedMs: total, endElapsedMs: total + 10000, processCpuMs: 5, plannedInputs: 0, dispatchedInputs: 0, windowStateStart: edge, windowStateEnd: edge }); total += 10000;
      }
      scene.elapsedMs = total; scene.boundaryCrossingCadence = distribution(scene.boundaryCrossingSamples.map(c => c.intervalMs));
      return { rows, protocol: PROTOCOL, mockPolicySha256: r.mockPolicy.sha256,
        fixture: { schema: 'reverie.qt.performance-fixture.v1', rows, committed: true, encrypted: true }, scene };
    }) };
}
function pairSet(r, cadence = 32, cpu = 20, boundary = 200) {
  return Array.from({ length: 3 }, (_, i) => ({ A: fixture(r, 'A', 40, 20, 200, 2 * i), B: fixture(r, 'B', cadence, cpu, boundary, 2 * i + 1) }));
}
test('pure fixed plan matches numeric declarations before GUI and rejects inconsistent counts', () => {
  const c = expectedContract(); validateContract(c);
  assert.equal(c.driverTransactions, 591); assert.equal(c.driverActions, 1016); assert.equal(c.controlRelatedDispatches, 1013);
  assert.deepEqual(c.phasePlan.map(p => p.inputCount), [182, 132, 300, 180, 160, 62]);
  assert.equal(contractHash(c), '393428cf13be4fb31655bdb2a2b72a68446c00934ebd7e1d3fc8dddbf9246971');
  c.driverActions = 1042; assert.throws(() => validateContract(c));
  const r = registration(); validateRegistration(r); r.sourceRegistration.contents.fixedWork.totalDriverActions = 1042;
  assert.throws(() => validateRegistration(r));
});
test('complete supplementary suite accepts exact counts and rejects stress/failed/partial/short records', () => {
  const r = registration(), base = fixture(r); assert.equal(validateRun(base, r, 'A').length, 18);
  for (const change of [x => x.protocol = 'stress-v1', x => x.passed = false, x => x.rows = [9, 100], x => x.workloads.pop(),
    x => x.workloads[0].scene.schema = 'reverie.qt.performance-scenarios.v1', x => x.workloads[0].scene.activeSegments.pop(),
    x => x.workloads[0].scene.activeSegments[0].framesAfterReady = 2, x => x.workloads[0].scene.inputs.pop(),
    x => x.workloads[0].scene.cadenceSamples = x.workloads[0].scene.cadenceSamples.filter(c => c.phaseIndex !== 2),
    x => x.workloads[0].scene.inputDropped = 1, x => x.sourceHead = 'f'.repeat(40)]) {
    const x = structuredClone(base); change(x); assert.throws(() => validateRun(x, r, 'A'));
  }
});
test('active cadence/CPU cannot use whole wall, paused intervals or drop long entry/exit frames', () => {
  const r = registration(), base = fixture(r);
  for (const change of [x => x.workloads[0].scene.phases[0].activeDurationMs = x.workloads[0].scene.phases[0].durationMs,
    x => x.workloads[0].scene.phases[0].processCpuPercentOneCore = x.workloads[0].scene.phases[0].phaseWallProcessCpuPercentOneCore,
    x => x.workloads[0].scene.cadenceSamples[0].intervalMs = 5000,
    x => x.workloads[0].scene.boundaryCrossingSamples.pop(),
    x => x.workloads[0].scene.boundaryCrossingCadence.maxMs = 1]) {
    const x = structuredClone(base); change(x); assert.throws(() => validateRun(x, r, 'A'));
  }
  const x = structuredClone(base), seg = x.workloads[0].scene.activeSegments[0];
  x.workloads[0].scene.driverBoundaries.push({ phaseIndex: 0, kind: 1, detail: 2, elapsedNs: (seg.startMs + 100) * 1e6 },
    { phaseIndex: 0, kind: 2, detail: 2, elapsedNs: (seg.endMs - 100) * 1e6 });
  assert.throws(() => validateRun(x, r, 'A'), /Outside wait overlaps/);
});
test('history, phase, transaction and exact scroll-input deadlines retain independent rejection', () => {
  const r = registration(), base = fixture(r);
  for (const change of [x => x.workloads[0].scene.elapsedMs = 1800000,
    x => x.workloads[0].scene.phases[0].durationMs = 600000,
    x => { const s = x.workloads[0].scene.activeSegments[0]; s.endMs = s.startMs + 15000; s.durationMs = 15000; },
    x => { const s = x.workloads[0].scene.activeSegments.find(s => s.phaseIndex === 2); s.durationMs = 30101; s.endMs = s.startMs + 30101; },
    x => { const i = x.workloads[0].scene.inputs.filter(i => i.phaseIndex === 2).at(-1); i.actualDispatchMs = 30001; i.completedMs = 30001; i.latenessMs = i.actualDispatchMs - i.plannedDueMs; }]) {
    const x = structuredClone(base); change(x); assert.throws(() => validateRun(x, r, 'A'));
  }
});
test('actual canonical delivered text, display, model and power must match, independently of provider hashes', () => {
  const r = registration(), A = fixture(r), B = fixture(r, 'B'); validatePair(A, B, r);
  for (const change of [x => x.workloads[0].scene.committedReplies[0].assistantTextSha256 = 'f'.repeat(64),
    x => x.workloads[0].scene.committedReplies[0].assistantUtf8Bytes += 1,
    x => x.workloads[0].scene.committedReplies[0].assistantCharacters = 21,
    x => x.workloads[0].scene.committedReplies[1].assistantCharacters = 80,
    x => x.workloads[0].scene.committedReplies[0].assistantTextSha256 = null,
    x => x.workloads[0].scene.diagnostics.renderLoop.observed = 'threaded',
    x => x.workloads[0].scene.diagnostics.actualGlContext.renderer = 'different',
    x => x.workloads[0].scene.diagnostics.viewport.effectiveDevicePixelRatio = 1,
    x => x.workloads[0].scene.phases[0].windowStateEnd = { ...x.workloads[0].scene.phases[0].windowStateEnd, devicePixelRatio: 1 },
    x => x.modelInput = 'other', x => x.environment.powerAfter = "Now drawing from 'Battery Power'"]) {
    const x = structuredClone(B); change(x); assert.throws(() => validatePair(A, x, r));
  }
});
test('known OS CPU/scheduler limiting rejects a whole run; unknown thermal text stays unknown', () => {
  const r = registration(), A = fixture(r); validateRun(A, r, 'A');
  for (const text of ['CPU_Speed_Limit = 80', 'Scheduler_Limit: 50', 'CPU_Scheduler_Limit = 99']) {
    const bad = structuredClone(A); bad.environment.thermalAfter = text;
    assert.throws(() => validateRun(bad, r, 'A'), /Environment anomaly/);
  }
  A.environment.thermalAfter = 'CPU_Speed_Limit = 100\nNote: No chip temperature measured'; validateRun(A, r, 'A');
});
test('independent whole A/A report identities bind exact real noise and reject repeated or failed suites', () => {
  const r = registration(), A = fixture(r), B = fixture(r, 'A', 42, 22, 210, 2), noise = deriveAaNoise([A, B], r);
  assert.equal(noise.aaNoise[`9:${PHASE_NAMES[0]}`], .05); assert.equal(noise.aaBoundaryP95Noise[`9:${PHASE_NAMES[0]}`], .05);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-calibration-test-'));
  try {
    const identities = [A, B].map((report, i) => { const file = path.join(dir, `${i}.json`), bytes = JSON.stringify(report); fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) }; });
    const record = { schema: 'reverie.qt.companion-calibration.v1', registrationSha256: 'c'.repeat(64), contractSha256: contractHash(expectedContract()), calibrationReports: identities, noise };
    assert.equal(loadCalibrations(record, r, record.registrationSha256).length, 2);
    assert.throws(() => loadCalibrations({ ...record, calibrationReports: [identities[0], identities[0]] }, r, record.registrationSha256));
    const wrong = structuredClone(record); wrong.noise.aaNoise[`9:${PHASE_NAMES[0]}`] = 0;
    assert.throws(() => loadCalibrations(wrong, r, record.registrationSha256), /noise/);
    assert.throws(() => deriveAaNoise([A, { ...B, passed: false }], r));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('each history needs a registered primary gain; boundary regression vetoes otherwise improved cadence', () => {
  const r = registration(), noise = deriveAaNoise([fixture(r), fixture(r, 'A', 40, 20, 200, 2)], r);
  assert.equal(analyze(pairSet(r), r, noise).performanceGainAccepted, true);
  const pairs = pairSet(r);
  for (const { B } of pairs) {
    const w = B.workloads[2]; for (const sample of w.scene.cadenceSamples) sample.intervalMs = 40;
    for (let i = 0; i < 6; ++i) { const d = distribution(w.scene.cadenceSamples.filter(s => s.phaseIndex === i).map(s => s.intervalMs)); w.scene.phases[i].cadence = d; w.scene.phases[i].mainCadence = d; }
  }
  assert.equal(analyze(pairs, r, noise).performanceGainAccepted, false);
  const badBoundary = analyze(pairSet(r, 32, 20, 250), r, noise);
  assert.equal(badBoundary.performanceGainAccepted, false); assert(badBoundary.groups.every(g => g.boundaryRegression));
});
test('whole cost is kept separate and active CPU savings cannot be described as cadence/FPS gains', () => {
  const r = registration(), noise = deriveAaNoise([fixture(r), fixture(r, 'A', 40, 20, 200, 2)], r);
  const cpu = analyze(pairSet(r, 40, 15), r, noise); assert.equal(cpu.performanceGainAccepted, false); assert.equal(cpu.computationEfficiencyAccepted, true);
  const faster = analyze(pairSet(r, 32, 30), r, noise); assert.equal(faster.performanceGainAccepted, true); assert.equal(faster.computationEfficiencyAccepted, false);
  assert(faster.groups[0].values[0].A.wholeCpuMs > faster.groups[0].values[0].A.activeCpuMs);
  assert(faster.wholeCosts[0].A[0].measuredPhaseCpuMs > faster.groups[0].values[0].A.wholeCpuMs);
  assert.equal(faster.originalStressAccepted, false); assert.equal(faster.qualityAccepted, false);
});
