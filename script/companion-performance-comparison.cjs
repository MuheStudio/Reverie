'use strict';
// Separate supplementary protocol. This never accepts a stress-v1 report.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { expectedContract, contractHash, canonical, hash, PROTOCOL, PHASE_NAMES, registration: fixed } = require('./companion-performance-contract.cjs');
const { modelPolicyRecord } = require('../native-ui/perf-model-server.cjs');
const root = path.resolve(__dirname, '..'), ROWS = [9, 100, 300], CONTRACT = expectedContract();
const PATCH_PATHS = ['native-ui/check-performance.cjs', 'native-ui/perf-harness.test.cjs', 'native-ui/perf-model-server.cjs',
  'native-ui/src/main.cpp', 'native-ui/tests/PerfScenarioCheck.cpp', 'native-ui/tests/PerfScenarioCheck.h'];
const NOISE_KEYS = ['aaNoise', 'aaOver50Noise', 'aaCpuNoise', 'aaInputP95NoiseMs', 'aaBoundaryP95Noise', 'aaBoundaryOver50Noise'];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const finite = (x, label, lower = 0) => { assert(Number.isFinite(x) && x >= lower, `Invalid ${label}`); return x; };
const close = (a, b, label) => assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)), `Accounting mismatch: ${label}`);
const median = a => { assert(a.length && a.every(Number.isFinite)); const s = a.toSorted((x, y) => x - y), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function distribution(values) {
  if (!values.length) return { measured: false, sampleCount: 0, p50Ms: null, p95Ms: null, maxMs: null, over33Ms: 0, over50Ms: 0 };
  assert(values.every(v => Number.isFinite(v) && v >= 0), 'Invalid cadence or lateness observation');
  const v = values.toSorted((a, b) => a - b), at = p => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { measured: true, sampleCount: v.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: v.at(-1),
    over33Ms: v.filter(x => x > 33).length, over50Ms: v.filter(x => x > 50).length };
}
function validateContract(c) {
  assert.deepEqual(c, CONTRACT, 'Fixed supplementary contract differs');
  assert.equal(c.driverTransactions, c.phasePlan.reduce((n, p) => n + p.transactions.length, 0), 'Declared transaction total differs');
  const inputs = c.phasePlan.flatMap(p => p.transactions.flatMap(t => t.inputs));
  assert.equal(c.driverActions, inputs.length, 'Declared driver action total differs');
  assert.equal(c.driverOnlyCompletionObservations, inputs.filter(i => i.name === 'reply-observe-canonical-completion').length);
  assert.equal(c.controlRelatedDispatches, inputs.length - c.driverOnlyCompletionObservations);
}
function validateRegistration(r) {
  assert.equal(r.schema, 'reverie.qt.companion-pre-run-registration.v1');
  assert.deepEqual(r.sourceRegistration.contents, fixed, 'Pre-GUI registration contents differ');
  assert.deepEqual(r.sourceRegistration.contents.fixedWork.transactionsByPhase, CONTRACT.phasePlan.map(p => p.transactionCount));
  assert.deepEqual(r.sourceRegistration.contents.fixedWork.driverActionsByPhase, CONTRACT.phasePlan.map(p => p.inputCount));
  assert.equal(r.sourceRegistration.contents.fixedWork.totalDriverActions, CONTRACT.driverActions);
  assert.equal(r.sourceRegistration.contents.fixedWork.totalTransactions, CONTRACT.driverTransactions);
  assert.deepEqual(r.mockPolicy, modelPolicyRecord(PROTOCOL), 'Mock policy differs');
  assert.equal(Object.keys(r.workloadInputs).length, 29, 'Complete common source registration required');
  for (const digest of Object.values(r.workloadInputs)) assert(/^[a-f0-9]{64}$/.test(digest));
  assert.deepEqual(r.measurementFiles.map(f => f.path), PATCH_PATHS, 'Reviewed measurement patch paths differ');
  assert.deepEqual(r.measurementInventory, { digestKind: 'ordered-file-link-inventory-sha256', sha256: hash(JSON.stringify(r.measurementFiles)), count: 6 });
  for (const variant of ['A', 'B']) {
    const c = r.candidates[variant]; assert(/^[a-f0-9]{40}$/.test(c.source)); assert(path.isAbsolute(c.directory));
    assert.equal(c.productSource, fixed.productReferences[variant]); assert(/^[a-f0-9]{64}$/.test(c.buildManifestSha256));
  }
  assert.notEqual(r.candidates.A.source, r.candidates.B.source);
  validateContract(CONTRACT);
  return r;
}
function validateSourceRegistration(r) {
  // These are metadata reads only; native child verification still validates
  // its exact source inventory, app signature and all external dependencies.
  for (const variant of ['A', 'B']) {
    const c = r.candidates[variant]; assert.equal(git('rev-parse', '--verify', `${c.source}^{commit}`), c.source);
    for (const [file, digest] of Object.entries(r.workloadInputs))
      assert.equal(hash(execFileSync('git', ['show', `${c.source}:${file}`], { cwd: root })), digest, `Common source differs: ${variant}/${file}`);
    for (const entry of r.measurementFiles) {
      const bytes = execFileSync('git', ['show', `${c.source}:${entry.path}`], { cwd: root });
      assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    }
    assert.equal(hash(fs.readFileSync(path.join(c.directory, 'build.json'))), c.buildManifestSha256, 'Registered build changed');
    const changed = git('diff', '--name-only', c.productSource, c.source).split('\n').filter(Boolean);
    const isRuntime = name => /^(native-ui\/|src\/|frontend\/(electron|script)\/|config\/.*toolchain|requirements.*lock$|frontend\/(package\.json|pnpm-lock\.yaml)$|frontend\/src\/components\/DreamRoom\/xiangqiEngine\.ts$|script\/(macos-common|.*qt-macos|.*qt-performance)\.)/.test(name);
    assert(changed.filter(isRuntime).every(name => PATCH_PATHS.includes(name)), 'Product runtime differs outside reviewed measurement patch');
  }
}
function replyHashes(scene) {
  assert(Array.isArray(scene.committedReplies) && scene.committedReplies.length === 3, 'Three canonical replies required');
  return scene.committedReplies.map((reply, index) => {
    const prompt = ['性能短回复', '性能长回复，请认真给我完整说明', '性能延迟回复，请认真给我完整说明'][index];
    assert.equal(reply.prompt, prompt); assert.equal(reply.complete, true); assert.equal(reply.requestAssistantRows, 1);
    assert(typeof reply.requestId === 'string' && reply.requestId.length > 0);
    assert(/^[a-f0-9]{64}$/.test(reply.assistantTextSha256), 'Unknown actual delivered text hash');
    assert(Number.isInteger(reply.assistantUtf8Bytes) && reply.assistantUtf8Bytes > 0, 'Unknown delivered text length');
    assert(Number.isInteger(reply.assistantCharacters) && reply.assistantCharacters > 0, 'Unknown delivered text character count');
    assert(index === 0 ? reply.assistantCharacters <= 20 : reply.assistantCharacters > 80, 'Short/full reply workload differs');
    return { prompt, sha256: reply.assistantTextSha256, utf8Bytes: reply.assistantUtf8Bytes, utf16Units: reply.assistantCharacters };
  });
}
function graphics(scene) {
  const d = scene.diagnostics, gl = d?.actualGlContext, v = d?.viewport;
  assert.equal(d?.renderLoop?.observed, 'basic', 'Actual render loop differs from registered basic loop');
  assert.equal(gl?.graphicsApi, 'opengl'); assert.equal(gl.isOpenGLES, false);
  const stable = {};
  for (const key of ['graphicsApi', 'isOpenGLES', 'vendor', 'renderer', 'versionString', 'shadingLanguageVersion',
    'majorVersion', 'minorVersion', 'profile', 'samples', 'swapInterval', 'depthBufferSize', 'stencilBufferSize']) {
    assert(gl[key] !== undefined && gl[key] !== null, `Missing actual GL field: ${key}`); stable[key] = gl[key];
  }
  assert(Array.isArray(gl.extensions)); stable.extensions = [...gl.extensions].sort();
  assert.equal(v?.effectiveDevicePixelRatio, 2); assert.equal(v.windowDevicePixelRatio, 2);
  finite(v.logicalWidth, 'observed logical viewport width', 1); finite(v.logicalHeight, 'observed logical viewport height', 1);
  assert.equal(v.physicalWidthRounded, Math.round(v.logicalWidth * v.effectiveDevicePixelRatio));
  assert.equal(v.physicalHeightRounded, Math.round(v.logicalHeight * v.effectiveDevicePixelRatio));
  return { context: stable, viewport: Object.fromEntries(['logicalWidth', 'logicalHeight', 'effectiveDevicePixelRatio',
    'windowDevicePixelRatio', 'physicalWidthRounded', 'physicalHeightRounded', 'screen', 'screenRefreshRateHz'].map(k => [k, v[k]])) };
}
function thermal(environment) {
  for (const edge of ['Before', 'After']) {
    const text = environment[`thermal${edge}`]; assert.equal(typeof text, 'string', 'Thermal status was not recorded');
    for (const match of text.matchAll(/\b(?:CPU_Speed_Limit|CPU_Scheduler_Limit|Scheduler_Limit|CPU_Scheduling_Limit)\s*[:=]\s*(\d+(?:\.\d+)?)/g))
      assert(Number(match[1]) >= 100, `Environment anomaly: observed CPU/scheduler limit ${match[1]}`);
  }
  // Unknown/no-warning text is retained. It does not prove identical temperature.
}
function validateRun(report, r, variant) {
  assert.equal(report.schema, 'reverie.qt.performance-run.v1'); assert.equal(report.protocol, PROTOCOL); assert.equal(report.mode, 'perf');
  assert(report.passed === true && report.performanceComparable === true && report.sourceDirty === false, 'Failed supplementary run');
  assert(report.noResidualProcesses === true && report.testDataRemoved === true && !report.forcedCleanup, 'Cleanup failed');
  assert(report.modelInputUnchanged === true && report.applicationUnchanged === true, 'Run inputs changed');
  assert.equal(report.sourceHead, r.candidates[variant].source, 'Unregistered supplementary source');
  assert.equal(report.buildManifestSha256, r.candidates[variant].buildManifestSha256);
  assert.equal(report.build?.source?.head, report.sourceHead); assert.equal(report.build.source.dirty, false);
  assert.equal(report.build.schema, 'reverie.qt.local-build.v2'); assert(report.build.core && report.build.diagnostics?.qmlProfilerEnabled === false);
  assert.deepEqual(report.workloadInputs, r.workloadInputs); assert.deepEqual(report.mockPolicy, r.mockPolicy);
  for (const edge of ['Before', 'After']) power(report.environment, edge);
  thermal(report.environment);
  assert.deepEqual(report.rows, ROWS); assert.deepEqual(report.workloads.map(w => w.rows), ROWS, 'Full independent history suite required');
  const observations = [];
  for (const w of report.workloads) {
    const s = w.scene; assert.equal(w.protocol, PROTOCOL); assert.equal(w.mockPolicySha256, r.mockPolicy.sha256);
    assert.equal(s.schema, 'reverie.qt.companion-transactions.v1'); assert.equal(s.protocol, PROTOCOL);
    assert.equal(s.mode, 'perf'); assert.equal(s.fixtureRows, w.rows); assert.equal(s.scheduleVersion, 'moonroom-companion-transactions-v1');
    assert(s.passed === true && s.performanceComparable === true && s.environmentFlags?.comparable === true);
    assert.equal(w.fixture.schema, 'reverie.qt.performance-fixture.v1'); assert.equal(w.fixture.rows, w.rows);
    assert(w.fixture.encrypted === true && w.fixture.committed === true);
    validateContract(s.plannedTransactionContract); replyHashes(s);
    graphics(s);
    assert.equal(s.phases[0]?.windowStateStart?.width, 1380); assert.equal(s.phases[0].windowStateStart.height, 900);
    for (const p of s.phases) for (const edge of ['windowStateStart', 'windowStateEnd']) {
      assert.equal(p[edge]?.devicePixelRatio, 2, 'Phase DPR differs from full-DPR registration');
      finite(p[edge].width, 'phase width', 1); finite(p[edge].height, 'phase height', 1);
      finite(p[edge].screenRefreshRateHz, 'reported screen refresh rate', Number.MIN_VALUE);
      assert(typeof p[edge].screenName === 'string' && p[edge].screenName.length > 0);
    }
    finite(s.elapsedMs, 'whole history duration'); assert(s.elapsedMs < CONTRACT.historyTimeoutMs, 'History deadline crossed');
    for (const counter of ['cadenceDropped', 'inputDropped', 'driverBoundaryDropped']) assert.equal(s[counter], 0, 'Dropped records');
    assert.equal(s.phases.length, 14); assert.equal(s.activeSegments.length, CONTRACT.driverTransactions);
    assert.equal(s.inputs.length, CONTRACT.driverActions, 'Incomplete actual inputs');
    assert(Array.isArray(s.driverBoundaries) && s.driverBoundaries.length > 0, 'Driver boundary records required');
    assert.deepEqual(s.boundaryCrossingCadence, distribution(s.boundaryCrossingSamples.map(c => c.intervalMs)), 'Boundary cadence was trimmed or changed');
    let segmentIndex = 0, inputIndex = 0;
    for (const plan of CONTRACT.phasePlan) {
      const p = s.phases[plan.phaseIndex], label = `${w.rows}/${plan.name}`, segments = [];
      assert.equal(p.index, plan.phaseIndex); assert.equal(p.name, plan.name); assert.equal(p.active, true);
      assert.equal(p.plannedDurationMs, 0); assert.equal(p.complete, true); assert.equal(p.minimumIntervals, 300);
      assert.equal(p.plannedInputs, plan.inputCount); assert.equal(p.dispatchedInputs, plan.inputCount, 'Missing actual inputs');
      assert.equal(p.plannedTransactions, plan.transactionCount); assert.equal(p.completedTransactions, plan.transactionCount, 'Missing completed transactions');
      finite(p.durationMs, `whole phase wall ${label}`, Number.MIN_VALUE); assert(p.durationMs < CONTRACT.phaseTimeoutMs, 'Phase deadline crossed');
      close(p.endElapsedMs - p.startElapsedMs, p.durationMs, label);
      for (const tx of plan.transactions) {
        const seg = s.activeSegments[segmentIndex]; assert.equal(seg.index, segmentIndex++); assert.equal(seg.phaseIndex, plan.phaseIndex);
        assert.equal(seg.transactionIndex, tx.index); assert.equal(seg.name, tx.name); assert.equal(seg.complete, true);
        finite(seg.startMs, 'segment start'); finite(seg.endMs, 'segment end', seg.startMs + 1);
        assert.equal(seg.durationMs, seg.endMs - seg.startMs); finite(seg.processCpuMs, 'segment CPU');
        assert(Number.isInteger(seg.framesAfterReady) && seg.framesAfterReady >= 3, 'Missing actual readiness frames');
        if (segments.length) assert(seg.startMs >= segments.at(-1).endMs + CONTRACT.humanPauseMs, 'Human pause entered active duration');
        if (plan.phaseIndex === 2) assert(seg.durationMs >= 30000 && seg.durationMs <= 30100, 'Scroll stop deadline crossed');
        else assert(seg.durationMs < CONTRACT.activeTransactionTimeoutMs, 'Active transaction deadline crossed');
        assert(seg.endMs <= p.durationMs + 1, 'Segment outside phase'); segments.push(seg);
        for (const declared of tx.inputs) {
          const i = s.inputs[inputIndex++]; assert.equal(i.phaseIndex, plan.phaseIndex); assert.equal(i.transactionIndex, tx.index);
          assert.equal(i.actionIndex, segments.slice(0, -1).reduce((n, x) => n + plan.transactions[x.transactionIndex].inputs.length, 0) + tx.inputs.indexOf(declared));
          assert.equal(i.name, declared.name); assert.equal(i.plannedDueMs, seg.startMs + declared.dueMs);
          finite(i.actualDispatchMs, 'actual dispatch', i.plannedDueMs); finite(i.completedMs, 'actual completion', i.actualDispatchMs);
          assert(i.completedMs <= seg.endMs, 'Input outside active segment'); assert.equal(i.latenessMs, i.actualDispatchMs - i.plannedDueMs);
          const deadline = plan.phaseIndex === 2 ? CONTRACT.scrollInputDeadlineMs : CONTRACT.activeTransactionTimeoutMs;
          assert(i.actualDispatchMs - seg.startMs <= deadline && i.completedMs - seg.startMs <= deadline, 'Input deadline crossed');
        }
      }
      const activeMs = segments.reduce((n, seg) => n + seg.durationMs, 0), activeCpuMs = segments.reduce((n, seg) => n + seg.processCpuMs, 0);
      finite(activeCpuMs, 'active phase CPU', Number.MIN_VALUE);
      close(p.activeDurationMs, activeMs, 'active duration'); close(p.activeProcessCpuMs, activeCpuMs, 'active CPU'); close(p.processCpuMs, activeCpuMs, 'formal CPU');
      close(p.processCpuPercentOneCore, activeCpuMs * 100 / activeMs, 'active CPU denominator');
      finite(p.phaseWallProcessCpuMs, 'whole phase CPU', activeCpuMs - 1e-6); close(p.phaseWallProcessCpuPercentOneCore, p.phaseWallProcessCpuMs * 100 / p.durationMs, 'whole CPU denominator');
      const excludedMs = ['pauseMs', 'backendWaitMs', 'gateWaitMs', 'tailSettleMs'].reduce((n, key) => n + finite(p[key], key), 0);
      assert(activeMs + excludedMs <= p.durationMs + 1, 'Waiting diluted active accounting');
      const raw = s.cadenceSamples.filter(c => c.phaseIndex === plan.phaseIndex);
      assert(raw.length >= 300, 'Insufficient actual active intervals');
      for (const c of raw) {
        const seg = s.activeSegments[c.activeSegmentIndex]; assert(seg && seg.phaseIndex === plan.phaseIndex, 'Cadence from another segment or idle phase');
        finite(c.intervalMs, 'active physical interval', Number.MIN_VALUE); finite(c.phaseElapsedEndMs, 'cadence endpoint');
        // Segment endpoints are integer ms; cadence endpoints are ns-derived.
        assert(c.phaseElapsedEndMs - c.intervalMs >= seg.startMs - 1 && c.phaseElapsedEndMs <= seg.endMs + 1, 'Waiting or boundary interval entered main cadence');
      }
      assert.deepEqual(p.mainCadence, distribution(raw.map(c => c.intervalMs)), 'Main cadence differs from complete raw active intervals');
      assert.deepEqual(p.cadence, p.mainCadence);
      const inputs = s.inputs.filter(i => i.phaseIndex === plan.phaseIndex);
      assert.deepEqual(p.inputDispatchLateness, distribution(inputs.map(i => i.latenessMs)), 'Input scheduling distribution differs');
      const crossings = s.boundaryCrossingSamples.filter(c => c.phaseIndex === plan.phaseIndex);
      for (const seg of segments) for (const kind of ['enter-active', 'leave-active'])
        assert.equal(crossings.filter(c => c.activeSegmentIndex === seg.index && c.boundaryKind === kind).length, 1, 'Missing or duplicate active boundary interval');
      for (const c of crossings) {
        assert(s.activeSegments[c.activeSegmentIndex]?.phaseIndex === plan.phaseIndex); finite(c.phaseElapsedEndMs, 'boundary endpoint');
        finite(c.intervalMs, 'physical boundary interval', Number.MIN_VALUE);
        assert(['enter-active', 'leave-active'].includes(c.boundaryKind));
      }
      observations.push({ rows: w.rows, phase: p.name, activeDurationMs: activeMs, activeCpuMs,
        wholeWallMs: p.durationMs, wholeCpuMs: p.phaseWallProcessCpuMs, pauseMs: p.pauseMs, backendWaitMs: p.backendWaitMs,
        gateWaitMs: p.gateWaitMs, tailSettleMs: p.tailSettleMs, boundaryCadence: distribution(crossings.map(c => c.intervalMs)) });
    }
    // Outside-active wait markers are in the whole-history clock. Quantization
    // uncertainty is at most2ms here, and never applies to input deadlines.
    const waits = new Map();
    for (const b of s.driverBoundaries) {
      finite(b.elapsedNs, 'driver boundary clock'); const p = s.phases[b.phaseIndex];
      if (![1, 2].includes(b.kind) || ![1, 2, 5, 6].includes(b.detail)) continue;
      const key = `${b.phaseIndex}:${b.detail}`;
      if (b.kind === 1) { assert(!waits.has(key), 'Repeated outside wait begin'); waits.set(key, b.elapsedNs / 1e6); }
      else {
        assert(waits.has(key), 'Unmatched outside wait end'); const start = waits.get(key), end = b.elapsedNs / 1e6; waits.delete(key);
        assert(end >= start); if ([1, 2].includes(b.detail)) assert(end - start < CONTRACT.preDispatchGateTimeoutMs, 'Pre-dispatch deadline crossed');
        for (const seg of s.activeSegments.filter(seg => seg.phaseIndex === b.phaseIndex)) {
          const overlap = Math.min(end, p.startElapsedMs + seg.endMs) - Math.max(start, p.startElapsedMs + seg.startMs);
          assert(overlap <= 2, 'Outside wait overlaps active segment');
        }
      }
    }
    assert.equal(waits.size, 0, 'Unfinished excluded wait');
    const idleNames = ['companion', 'reading', 'memory', 'settings', 'character'].map(n => `idle-${n}-wide`)
      .concat(['memory', 'settings', 'character'].map(n => `idle-${n}-compact`));
    for (let idx = 6; idx < 14; ++idx) {
      const p = s.phases[idx]; assert.equal(p.active, false); assert.equal(p.complete, true);
      assert.equal(p.index, idx); assert.equal(p.name, idleNames[idx - 6]);
      assert.equal(p.plannedDurationMs, 10000); assert.equal(p.plannedInputs, 0); assert.equal(p.dispatchedInputs, 0);
      finite(p.durationMs, 'idle whole wall', 10000); finite(p.processCpuMs, 'idle whole CPU');
    }
    let previousEnd = 0;
    for (const p of s.phases) {
      finite(p.startElapsedMs, 'phase start', previousEnd); finite(p.endElapsedMs, 'phase end', p.startElapsedMs);
      close(p.endElapsedMs - p.startElapsedMs, p.durationMs, 'whole phase duration'); previousEnd = p.endElapsedMs;
    }
    assert(s.elapsedMs >= previousEnd, 'Whole history clock ended before phases');
  }
  return observations;
}
function power(e, edge) {
  assert(e[`power${edge}`]?.includes("Now drawing from 'AC Power'"), 'AC power required');
  assert(/\blowpowermode\s+0\b/.test(e[`powerSettings${edge}`]), 'Low power mode must be disabled');
}
function validatePair(A, B, r, aVariant = 'A', bVariant = 'B') {
  const a = validateRun(A, r, aVariant), b = validateRun(B, r, bVariant);
  for (const key of ['qt', 'python', 'node', 'externalFiles', 'externalTrees', 'compilation']) assert.deepEqual(A.build[key], B.build[key]);
  assert.deepEqual(A.modelInput, B.modelInput);
  for (const key of ['macOS', 'hardware', 'architecture', 'node']) assert.equal(A.environment[key], B.environment[key]);
  for (const report of [A, B]) for (const edge of ['Before', 'After']) power(report.environment, edge);
  for (let i = 0; i < 3; ++i) {
    assert.deepEqual(A.workloads[i].fixture, B.workloads[i].fixture);
    assert.deepEqual(graphics(A.workloads[i].scene), graphics(B.workloads[i].scene), 'Actual graphics context/viewport differs');
    assert.deepEqual(replyHashes(A.workloads[i].scene), replyHashes(B.workloads[i].scene), 'Actual delivered reply text differs');
    for (let p = 0; p < 14; ++p) for (const edge of ['windowStateStart', 'windowStateEnd'])
      for (const key of ['width', 'height', 'devicePixelRatio', 'screenName', 'screenRefreshRateHz']) {
        const x = A.workloads[i].scene.phases[p][edge]?.[key], y = B.workloads[i].scene.phases[p][edge]?.[key];
        assert(x !== undefined && x !== null && y !== undefined && y !== null); assert.deepEqual(x, y);
      }
  }
  return { a, b };
}
function deriveAaNoise(reports, r) {
  assert.equal(reports.length, 2, 'Exactly two whole independent A/A suites required');
  const { a, b } = validatePair(reports[0], reports[1], r, 'A', 'A');
  const noise = Object.fromEntries(NOISE_KEYS.map(k => [k, {}]));
  for (let idx = 0; idx < a.length; ++idx) {
    const x = reports[0].workloads[Math.floor(idx / 6)].scene.phases[idx % 6], y = reports[1].workloads[Math.floor(idx / 6)].scene.phases[idx % 6];
    const key = `${a[idx].rows}:${a[idx].phase}`, relative = (x, y) => Math.abs(x - y) / Math.min(x, y), rate = c => c.over50Ms / c.sampleCount;
    noise.aaNoise[key] = relative(x.mainCadence.p95Ms, y.mainCadence.p95Ms);
    noise.aaOver50Noise[key] = Math.abs(rate(x.mainCadence) - rate(y.mainCadence));
    noise.aaCpuNoise[key] = relative(x.activeProcessCpuMs, y.activeProcessCpuMs);
    noise.aaInputP95NoiseMs[key] = Math.abs(x.inputDispatchLateness.p95Ms - y.inputDispatchLateness.p95Ms);
    noise.aaBoundaryP95Noise[key] = relative(a[idx].boundaryCadence.p95Ms, b[idx].boundaryCadence.p95Ms);
    noise.aaBoundaryOver50Noise[key] = Math.abs(rate(a[idx].boundaryCadence) - rate(b[idx].boundaryCadence));
  }
  return noise;
}
function loadCalibrations(record, r, registrationSha256) {
  assert.equal(record.schema, 'reverie.qt.companion-calibration.v1'); assert.equal(record.registrationSha256, registrationSha256);
  assert.equal(record.contractSha256, contractHash(CONTRACT)); assert.equal(record.calibrationReports.length, 2);
  const paths = new Set(), digests = new Set(), reports = record.calibrationReports.map(identity => {
    assert(path.isAbsolute(identity.path)); assert(/^[a-f0-9]{64}$/.test(identity.sha256)); const file = fs.realpathSync(identity.path);
    assert(!paths.has(file) && !digests.has(identity.sha256), 'Repeated A/A calibration'); paths.add(file); digests.add(identity.sha256);
    const bytes = fs.readFileSync(file); assert.equal(hash(bytes), identity.sha256); return JSON.parse(bytes);
  });
  assert.deepEqual(record.noise, deriveAaNoise(reports, r), 'A/A noise does not match whole registered suites'); return reports;
}
function analyze(pairs, r, noise) {
  assert.equal(pairs.length, 3); const rows = [], values = pairs.map(({ A, B }) => ({ A, B, observations: validatePair(A, B, r) }));
  assert.deepEqual(Object.keys(noise).sort(), [...NOISE_KEYS].sort());
  for (const history of ROWS) for (let idx = 0; idx < 6; ++idx) {
    const name = PHASE_NAMES[idx], key = `${history}:${name}`, index = ROWS.indexOf(history) * 6 + idx;
    for (const kind of NOISE_KEYS) finite(noise[kind]?.[key], `measured noise ${kind}/${key}`);
    const stats = values.map(({ A, B, observations }) => {
      const a = A.workloads[ROWS.indexOf(history)].scene.phases[idx], b = B.workloads[ROWS.indexOf(history)].scene.phases[idx];
      const ca = observations.a[index].boundaryCadence, cb = observations.b[index].boundaryCadence;
      const improvement = (a, b) => (a - b) / a, rate = c => c.over50Ms / c.sampleCount;
      return { cadenceGain: improvement(a.mainCadence.p95Ms, b.mainCadence.p95Ms), cpuGain: improvement(a.activeProcessCpuMs, b.activeProcessCpuMs),
        longRateIncrease: rate(b.mainCadence) - rate(a.mainCadence), inputP95IncreaseMs: b.inputDispatchLateness.p95Ms - a.inputDispatchLateness.p95Ms,
        boundaryP95Gain: improvement(ca.p95Ms, cb.p95Ms), boundaryLongRateIncrease: rate(cb) - rate(ca),
        A: observations.a[index], B: observations.b[index] };
    });
    const c = fixed.comparison, cadenceGain = median(stats.map(s => s.cadenceGain)), cpuGain = median(stats.map(s => s.cpuGain));
    rows.push({ history, phase: name, primary: c.primaryPhases.includes(name), values: stats, cadenceGain, cpuGain,
      meetsGain: cadenceGain >= c.minimumImprovement && cadenceGain > noise.aaNoise[key] && stats.filter(s => s.cadenceGain > 0).length >= 2,
      meetsCpuGain: cpuGain >= c.minimumImprovement && cpuGain > noise.aaCpuNoise[key] && stats.filter(s => s.cpuGain > 0).length >= 2,
      regression: cadenceGain < -Math.max(c.relativeRegressionAllowance, noise.aaNoise[key]),
      longRegression: median(stats.map(s => s.longRateIncrease)) > Math.max(c.over50RateRegressionAllowance, noise.aaOver50Noise[key]),
      inputRegression: median(stats.map(s => s.inputP95IncreaseMs)) > Math.max(c.inputP95RegressionAllowanceMs, noise.aaInputP95NoiseMs[key]),
      boundaryRegression: median(stats.map(s => s.boundaryP95Gain)) < -Math.max(c.relativeRegressionAllowance, noise.aaBoundaryP95Noise[key])
        || median(stats.map(s => s.boundaryLongRateIncrease)) > Math.max(c.over50RateRegressionAllowance, noise.aaBoundaryOver50Noise[key]),
      cpuCostIncrease: cpuGain < -Math.max(c.relativeRegressionAllowance, noise.aaCpuNoise[key]) });
  }
  const noRegression = rows.every(s => !s.regression && !s.longRegression && !s.inputRegression && !s.boundaryRegression);
  return { protocol: PROTOCOL, groups: rows, acceptanceScope: fixed.comparison.acceptanceScope,
    performanceGainAccepted: ROWS.every(h => rows.some(s => s.history === h && s.primary && s.meetsGain)) && noRegression,
    computationEfficiencyAccepted: ROWS.every(h => rows.some(s => s.history === h && s.primary && s.meetsCpuGain)) && noRegression && rows.every(s => !s.cpuCostIncrease),
    originalStressAccepted: false, qualityAccepted: false,
    wholeCosts: pairs.map(({ A, B }) => ({ A: wholeCosts(A), B: wholeCosts(B) })),
    thermalStatus: pairs.map(({ A, B }) => ({ A: { before: A.environment.thermalBefore, after: A.environment.thermalAfter },
      B: { before: B.environment.thermalBefore, after: B.environment.thermalAfter }, scope: 'Available OS status only; no temperature equivalence is inferred.' })),
    scope: 'Supplementary active-segment cadence/CPU only; boundary regression vetoes gains. Whole phase wall/CPU and all waits are separately retained in every A/B observation. Original stress and visual/functional acceptance remain separate.' };
}
function wholeCosts(report) {
  return report.workloads.map(w => {
    const phases = w.scene.phases, phaseWallMs = phases.reduce((n, p) => n + p.durationMs, 0);
    return { rows: w.rows, historyElapsedMs: w.scene.elapsedMs, measuredPhaseWallMs: phaseWallMs,
      measuredPhaseCpuMs: phases.reduce((n, p) => n + (p.active ? p.phaseWallProcessCpuMs : p.processCpuMs), 0),
      preparationAndUncoveredWallMs: w.scene.elapsedMs - phaseWallMs, resourceSummary: w.resourceSummary,
      scope: 'Whole phase CPU includes active work and all waits plus idle states. Preparation CPU is not inferred from phase sums; existing per-process resource summaries remain separate sampled evidence.' };
  });
}
async function main(args = process.argv.slice(2)) {
  const o = {}; for (let idx = 0; idx < args.length; ++idx) {
    const flag = args[idx]; assert(!o[flag], 'Duplicate option');
    if (['--run', '--calibrate'].includes(flag)) o[flag] = true;
    else { assert(['--registration', '--registration-sha256', '--calibration'].includes(flag)); const value = args[++idx]; assert(value && !value.startsWith('--')); o[flag] = value; }
  }
  assert(!(o['--run'] && o['--calibrate'])); assert(path.isAbsolute(o['--registration'] || '')); assert(/^[a-f0-9]{64}$/.test(o['--registration-sha256']));
  const bytes = fs.readFileSync(o['--registration']); assert.equal(hash(bytes), o['--registration-sha256']); const r = validateRegistration(JSON.parse(bytes));
  const registrationSha256 = hash(bytes); validateSourceRegistration(r);
  const clean = () => assert.equal(git('status', '--porcelain'), '', 'Unknown source changes; no stash/reset/cleanup'); clean();
  const branch = git('symbolic-ref', '--short', 'HEAD'), head = git('rev-parse', 'HEAD');
  if (!o['--run'] && !o['--calibrate']) return console.log(JSON.stringify({ registered: true, registrationSha256, contractSha256: contractHash(CONTRACT) }));
  let calibrations, calibrationRecord;
  if (o['--run']) { assert(path.isAbsolute(o['--calibration'] || '')); calibrationRecord = JSON.parse(fs.readFileSync(o['--calibration'])); calibrations = loadCalibrations(calibrationRecord, r, registrationSha256); }
  const out = fs.mkdtempSync(path.join(root, '.tools/reports/companion-performance-'));
  const result = { schema: 'reverie.qt.companion-comparison.v1', protocol: PROTOCOL, registrationSha256, contractSha256: contractHash(CONTRACT),
    registrationFile: o['--registration'], candidates: r.candidates,
    calibrationFile: o['--calibration'] || null,
    calibrationSha256: o['--run'] ? hash(fs.readFileSync(o['--calibration'])) : null,
    registeredNoise: calibrationRecord?.noise || null,
    verifierSha256: hash(fs.readFileSync(__filename)), contractGeneratorSha256: hash(fs.readFileSync(path.join(__dirname, 'companion-performance-contract.cjs'))),
    originalBranch: branch, originalHead: head, mode: o['--calibrate'] ? 'calibration' : 'comparison', runs: [], passed: false, restored: false };
  let activeChild, stopped = false;
  const stop = () => { stopped = true; if (activeChild?.connected) activeChild.send({ type: 'abort-performance' }, () => {}); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const order = o['--calibrate'] ? ['A', 'A'] : fixed.comparison.comparisonOrder;
    for (const [index, variant] of order.entries()) {
      assert(!stopped, 'Supplementary controller interrupted'); clean(); git('switch', '--detach', r.candidates[variant].source);
      const logfile = path.join(out, `${index + 1}-${variant}.log`), fd = fs.openSync(logfile, 'wx');
      activeChild = spawn(process.execPath, [path.join(root, 'native-ui/check-performance.cjs'), '--protocol', PROTOCOL, '--mode', 'perf', '--full-suite',
        '--build-dir', r.candidates[variant].directory], { cwd: root, stdio: ['ignore', fd, fd, 'ipc'] });
      const exit = await new Promise((resolve, reject) => { activeChild.once('exit', (code, signal) => resolve({ code, signal })); activeChild.once('error', reject); }); activeChild = null; fs.closeSync(fd);
      const last = JSON.parse(fs.readFileSync(logfile, 'utf8').trim().split('\n').at(-1));
      const entry = { variant, logfile, exit, reportRoot: last.reportRoot }; result.runs.push(entry);
      fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify(result, null, 2)); assert.equal(exit.code, 0); assert(last.passed && last.performanceComparable);
      entry.path = path.join(last.reportRoot, 'summary.json'); const dataBytes = fs.readFileSync(entry.path); entry.sha256 = hash(dataBytes); entry.data = JSON.parse(dataBytes);
      entry.observations = validateRun(entry.data, r, variant);
      if (calibrations) validatePair(calibrations[0], entry.data, r, 'A', variant);
      if (index % 2) validatePair(result.runs[index - 1].data, entry.data, r, result.runs[index - 1].variant, variant);
      clean(); console.log(JSON.stringify({ variant, reportRoot: last.reportRoot, validated: true }));
    }
    if (o['--calibrate']) {
      result.calibration = { schema: 'reverie.qt.companion-calibration.v1', registrationSha256, contractSha256: contractHash(CONTRACT),
        calibrationReports: result.runs.map(({ path, sha256 }) => ({ path, sha256 })), noise: deriveAaNoise(result.runs.map(run => run.data), r) };
      fs.writeFileSync(path.join(out, 'calibration.json'), JSON.stringify(result.calibration, null, 2), { flag: 'wx' });
    } else {
      const pairs = []; for (let idx = 0; idx < 6; idx += 2) { const pair = result.runs.slice(idx, idx + 2); pairs.push({ A: pair.find(p => p.variant === 'A').data, B: pair.find(p => p.variant === 'B').data }); }
      result.analysis = analyze(pairs, r, calibrationRecord.noise);
    }
    result.passed = true;
  } catch (error) { result.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { clean(); assert.equal(git('rev-parse', branch), head); git('switch', branch); assert.equal(git('rev-parse', 'HEAD'), head); result.restored = true; }
    catch (error) { result.restoreError = String(error); process.exitCode = 1; }
    for (const run of result.runs) delete run.data;
    fs.writeFileSync(path.join(out, 'comparison.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ reportRoot: out, passed: result.passed, restored: result.restored, gain: result.analysis?.performanceGainAccepted, error: result.error }));
  }
  return result;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { validateContract, validateRegistration, validateSourceRegistration, validateRun, validatePair, replyHashes,
  deriveAaNoise, loadCalibrations, analyze, graphics, thermal, wholeCosts, distribution, main, expectedContract, contractHash, canonical, hash, PROTOCOL, ROWS, PHASE_NAMES };
