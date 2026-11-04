'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const guard = require('../frontend/script/acceptance-isolation.cjs');
const { verifyBuild, digest, fileHash, directoryInventory } = require('./build-record.cjs');
const { cleanupExitedSuccessfully } = require('./cleanup-exit.cjs');
const { compileSampler, processTreeSnapshot, sampleOwned, summarizeResources } = require('./perf-sampling.cjs');
const { modelPolicyRecord, validateProtocol } = require('./perf-model-server.cjs');
const root = path.resolve(__dirname, '..');
// Shared workload contract for A/B runs. Product QML, shaders and NativeAvatar
// implementation files remain in the build's full source inventory; they are
// deliberately not part of the harness equality check used by the comparator.
const WORKLOAD_INPUT_PATHS = Object.freeze([
  'native-ui/check-performance.cjs', 'native-ui/perf-fixtures.py', 'native-ui/perf-model-server.cjs',
  'native-ui/perf-resource.swift', 'native-ui/perf-sampling.cjs', 'native-ui/perf-trace.py',
  'native-ui/cleanup-exit.cjs', 'native-ui/build-record.cjs', 'native-ui/avatar-host.cjs',
  'native-ui/src/main.cpp', 'native-ui/src/PerfDiagnostics.cpp', 'native-ui/src/PerfDiagnostics.h',
  'native-ui/src/Keychain.mm', 'native-ui/src/Keychain.h', 'native-ui/src/WindowRecorder.mm', 'native-ui/src/WindowRecorder.h',
  'native-ui/tests/PerfScenarioCheck.cpp', 'native-ui/tests/PerfScenarioCheck.h',
  'native-ui/tests/PerfBootstrap.cpp', 'native-ui/tests/PerfBootstrap.h',
  'frontend/script/acceptance-isolation.cjs', 'frontend/script/macos-confirm-error.swift',
  'script/check-qt-performance.sh', 'script/macos-common.sh',
  'config/macos-toolchain.json', 'config/qt-macos-toolchain.json', 'requirements-runtime.lock',
  'frontend/package.json', 'frontend/pnpm-lock.yaml'
]);
const DIAGNOSTIC_CASES = Object.freeze(['reading-close', 'scroll-tail', 'scroll-tail-with-prefix']);
const USAGE = 'Usage: check-qt-performance.sh --build-dir ABS_DIRECTORY [--mode perf|diagnostic|visual] [--protocol stress-v1|companion-transactions-v1] [--rows 9|100|300|--full-suite] [--model ABS_AUTHORIZED_TEST_COPY] [--record] [--diagnostic-case reading-close|scroll-tail|scroll-tail-with-prefix] [--metacall-context] [--cpu-stacks] [--cpu-stack-tail-once] [--qml-profiler] [--profiler-port 1024..65535]';
function parseArguments(args) {
  const options = { mode: 'perf', protocol: 'stress-v1', rows: 300, fullSuite: false,
    model: path.join(root, '.tools/live2d/yumi-local-validation/原模型测试 副本') };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' && args.length === 1) return { help: true };
    assert(!seen.has(flag), `Duplicate option ${flag}; ${USAGE}`); seen.add(flag);
    if (flag === '--full-suite') options.fullSuite = true;
    else if (flag === '--record') options.record = true;
    else if (flag === '--qml-profiler') options.qmlProfiler = true;
    else if (flag === '--cpu-stacks') options.cpuStacks = true;
    else if (flag === '--cpu-stack-tail-once') options.cpuStackTailOnce = true;
    else if (flag === '--metacall-context') options.metaCallContext = true;
    else if (['--build-dir', '--model', '--mode', '--protocol', '--rows', '--profiler-port', '--diagnostic-case'].includes(flag)) {
      const value = args[++i]; assert(value && !value.startsWith('--'), `Missing ${flag} value; ${USAGE}`);
      if (flag === '--build-dir' || flag === '--model') {
        assert(path.isAbsolute(value), `${flag} requires an absolute path; ${USAGE}`);
        options[flag === '--build-dir' ? 'buildDir' : 'model'] = path.resolve(value);
      } else if (flag === '--mode') { assert(['perf', 'diagnostic', 'visual'].includes(value), USAGE); options.mode = value; }
      else if (flag === '--protocol') options.protocol = validateProtocol(value);
      else if (flag === '--diagnostic-case') { assert(DIAGNOSTIC_CASES.includes(value), 'Unknown diagnostic case'); options.diagnosticCase = value; }
      else if (flag === '--rows') { assert(['9', '100', '300'].includes(value), USAGE); options.rows = Number(value); }
      else { assert(/^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535, USAGE); options.profilerPort = Number(value); }
    } else throw Error(USAGE);
  }
  assert(options.buildDir, `Explicit --build-dir is required; ${USAGE}`);
  assert(!(options.fullSuite && seen.has('--rows')), '--full-suite and --rows cannot be combined');
  assert(!options.profilerPort || options.mode === 'diagnostic', '--profiler-port requires diagnostic mode');
  assert(!options.qmlProfiler || options.mode === 'diagnostic', '--qml-profiler requires diagnostic mode');
  assert(!options.record || options.mode === 'visual', '--record requires visual mode');
  if (options.diagnosticCase) {
    assert.equal(options.mode, 'diagnostic', '--diagnostic-case requires diagnostic mode');
    assert(!options.fullSuite && !options.record, 'Diagnostic cases cannot use --full-suite or --record');
    assert(!options.profilerPort || options.qmlProfiler, 'Diagnostic case --profiler-port requires --qml-profiler');
    assert(options.diagnosticCase === 'reading-close' ? options.protocol === 'stress-v1' && [100, 300].includes(options.rows)
      : options.protocol === 'companion-transactions-v1' && options.rows === 300, 'Diagnostic case protocol/history mismatch');
  }
  assert(!options.cpuStacks || options.diagnosticCase, '--cpu-stacks requires a diagnostic case');
  assert(!options.metaCallContext || options.mode === 'diagnostic' && options.diagnosticCase === 'reading-close',
    '--metacall-context requires diagnostic reading-close');
  assert(!options.cpuStackTailOnce || options.cpuStacks && options.mode === 'diagnostic' && options.diagnosticCase === 'reading-close',
    '--cpu-stack-tail-once requires --cpu-stacks and diagnostic reading-close');
  assert(!options.cpuStackTailOnce || !options.qmlProfiler && !options.profilerPort,
    '--cpu-stack-tail-once must be collected separately from QML Profiler');
  return options;
}
function validateRecording(options, scene) {
  if (options.record) assert.equal(scene.recording?.ok, true, 'Requested visual recording did not finish successfully');
}
function protocolDeadlines(protocol, diagnosticCase) {
  validateProtocol(protocol);
  if (diagnosticCase) {
    assert(DIAGNOSTIC_CASES.includes(diagnosticCase));
    const cap = diagnosticCase === 'scroll-tail-with-prefix' ? 900000 : 120000;
    return { nativeHistoryMs: cap, nodeChildMs: cap, cleanupIncluded: false };
  }
  return protocol === 'companion-transactions-v1' ? { nativeHistoryMs: 1800000, nodeChildMs: 1860000 }
    : { nativeHistoryMs: 420000, nodeChildMs: 600000 };
}
function validateProviderReady(options, address, mockPolicy = modelPolicyRecord(options.protocol)) {
  validateProtocol(options.protocol);
  assert.equal(address.protocol, options.protocol, 'Owned mock provider protocol differs');
  assert.equal(address.mockPolicySha256, mockPolicy.sha256, 'Owned mock provider policy differs');
}
function validateWorkloadProtocol(options, workload, mockPolicy = modelPolicyRecord(options.protocol)) {
  validateProtocol(options.protocol);
  assert.equal(workload.protocol, options.protocol, 'Workload protocol differs');
  assert.equal(workload.mockPolicySha256, mockPolicy.sha256, 'Workload mock policy differs');
  assert.equal(workload.scene.protocol, options.protocol, 'Native scene protocol differs');
  assert.equal(workload.scene.schema, options.diagnosticCase ? 'reverie.qt.diagnostic-case.v1' : options.protocol === 'companion-transactions-v1'
    ? 'reverie.qt.companion-transactions.v1' : 'reverie.qt.performance-scenarios.v1', 'Native scene schema differs');
  for (const call of workload.calls) {
    assert.equal(call.protocol, options.protocol, 'Mock call protocol differs');
    assert.equal(call.mockPolicySha256, mockPolicy.sha256, 'Mock call policy differs');
    const registered = mockPolicy.policy.responses[call.kind];
    assert(registered, 'Unknown mock response kind');
    assert.equal(call.delayMs, registered.delayMs, 'Mock declared delay differs');
    assert.equal(call.effectiveDelayMs, registered.delayMs, 'Mock actual delay policy differs');
    assert.equal(call.contentSha256, registered.contentSha256, 'Mock response text differs');
  }
  for (const completion of workload.completed) {
    assert.equal(completion.protocol, options.protocol, 'Mock completion protocol differs');
    assert.equal(completion.mockPolicySha256, mockPolicy.sha256, 'Mock completion policy differs');
  }
}
function workloadsComparable(options, workloads) {
  validateProtocol(options.protocol);
  const mockPolicySha256 = modelPolicyRecord(options.protocol).sha256;
  const schema = options.protocol === 'companion-transactions-v1'
    ? 'reverie.qt.companion-transactions.v1' : 'reverie.qt.performance-scenarios.v1';
  return options.mode === 'perf' && workloads.length > 0 && workloads.every(workload => workload.protocol === options.protocol
    && workload.scene.protocol === options.protocol && workload.scene.schema === schema && workload.scene.performanceComparable === true
    && workload.mockPolicySha256 === mockPolicySha256);
}
function workloadInputHashes(projectRoot = root) {
  return Object.fromEntries(WORKLOAD_INPUT_PATHS.map(name => [name, fileHash(path.join(projectRoot, name))]));
}
function verifyOwnedConsole(running, api) {
  api.assertIsolation(running.runRoot, running.userData);
  assert(running.rootIdentity && running.owned.get(running.child.pid) === running.rootIdentity,
    'Unowned console process; no normal exit action');
  assert(api.sameIdentity(api.inspectProcesses(running.runRoot, [running.child.pid])[0], running.rootIdentity),
    'Console process identity changed before normal exit');
}
async function writeProfilerCommand(running, command, api) {
  verifyOwnedConsole(running, api);
  assert.equal(running.identity.profilerAttachmentMode, 'attach-only', 'Profiler shutdown requires the attach-only launch contract');
  const input = running.child.stdin;
  assert(input && input.writable && !input.destroyed && !input.writableEnded, 'Owned profiler stdin is unavailable');
  await new Promise((resolve, reject) => input.write(command, error => error ? reject(error) : resolve()));
}
function profilerAckReader(stream, append, channel = 'stderr') {
  let buffered = '', sequence = 0, failure;
  const waiters = new Set();
  stream.on('data', chunk => {
    append(chunk); buffered += chunk.toString('utf8');
    if (buffered.length > 65536) { failure = Error('Owned profiler acknowledgement line exceeds limit'); for (const w of waiters) w.reject(failure); return; }
    let edge;
    while ((edge = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, edge).trim(); buffered = buffered.slice(edge + 1); ++sequence;
      for (const w of [...waiters]) if (sequence > w.after && w.matches(line)) { waiters.delete(w); w.resolve({ line, sequence }); }
    }
  });
  stream.on('error', error => { failure = error; for (const w of waiters) w.reject(error); });
  stream.on('end', () => { failure ||= Error('Owned profiler acknowledgement stream closed'); for (const w of waiters) w.reject(failure); });
  return { channel, sequence: () => sequence, wait(matches, after = sequence, timeoutMs = 15000) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const w = { matches, after, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); waiters.delete(w); reject(error); } };
      const timer = setTimeout(() => w.reject(Error('Owned profiler start acknowledgement deadline exceeded')), timeoutMs); waiters.add(w);
    });
  } };
}
// Preserve the old exported name for readers, but stdout is not an authority
// for QmlProfilerApplication::prompt(), which writes interactive ACKs to cerr.
function profilerStdoutReader(stream, append) { return profilerAckReader(stream, append, 'stdout'); }
async function startProfilerRecording(running, api = guard) {
  verifyOwnedConsole(running, api);
  assert(running.profilerOutput?.channel === 'stderr' && running.profilerAckStream === running.child.stderr,
    'Owned stderr acknowledgement reader is required');
  const acknowledgement = running.profilerOutput.wait(line => profilerRecordingAckVariant(line) !== null);
  acknowledgement.catch(() => {});
  await writeProfilerCommand(running, 'r\n', api);
  const result = await acknowledgement; verifyOwnedConsole(running, api);
  return { ...result, variant: profilerRecordingAckVariant(result.line), channel: 'stderr',
    source: 'Owned qmlprofiler interactive stderr traceStarted acknowledgement; exact variants, not inferred from timer timing', acknowledgedUnixMs: Date.now() };
}
function profilerRecordingAckVariant(line) {
  const normalized = line.replace(/^(?:>\s*)+/, '').trim();
  if (normalized === 'Recording started') return 'interactive-toggle-traceStarted';
  if (normalized === 'Application started recording') return 'application-traceStarted';
  return null;
}
function cleanupOrder(active) {
  const priority = running => running.cycle.endsWith('qml-profiler') ? 0 : running.cycle.endsWith('cpu-stack-sampler') ? 1
    : running.cycle.endsWith('-app') ? 2 : running.cycle.endsWith('model-server') ? 3 : 4;
  return [...active].sort((a, b) => priority(a) - priority(b));
}
async function closeDiagnosticDependencies({ profiler, stacks, stackProcesses = [], app }, close) {
  // Stop scheduling immediately; the currently owned sample chunk still ends
  // naturally. Keep the GUI target alive until every observer has finished.
  const stackCompletion = stacks?.stop(); const errors = [];
  const attempt = async running => { if (!running) return; try { await close(running); } catch (error) { errors.push(error); } };
  await attempt(profiler);
  if (stackCompletion) try { await stackCompletion; } catch (error) { errors.push(error); }
  for (const running of stackProcesses) await attempt(running);
  await attempt(app);
  if (errors.length) throw new AggregateError(errors, 'Diagnostic observer/app cleanup failed');
}
function diagnosticControl(running, options, api = guard) {
  const stream = running.child.stdio?.[4]; assert(stream?.readable && stream?.writable, 'Private diagnostic fd4 is unavailable');
  let buffer = '', bytes = 0, state = 'waiting-ready', phase, failure, startedReceipt;
  const events = [], promises = {};
  for (const name of ['ready', 'started', 'targetDone', 'ended']) {
    let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {});
    promises[name] = { promise, resolve, reject };
  }
  function fail(error) { failure ||= error; state = 'failed'; for (const pending of Object.values(promises)) pending.reject(error); }
  stream.on('data', chunk => {
    try {
      bytes += chunk.length; assert(bytes <= 65536, 'Diagnostic control byte limit exceeded'); buffer += chunk.toString('utf8');
      assert(buffer.length <= 8192, 'Diagnostic control line limit exceeded'); let edge;
      while ((edge = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, edge); buffer = buffer.slice(edge + 1); const m = JSON.parse(line);
        assert.equal(m.case, options.diagnosticCase); assert.equal(m.protocol, options.protocol); assert.equal(m.rows, options.rows);
        assert(Number.isInteger(m.phase));
        assert.equal(m.phase, options.diagnosticCase === 'reading-close' ? 0 : 2, 'Diagnostic target phase differs');
        assert(/^[0-9]+$/.test(m.absoluteNs)); assert(Number.isFinite(m.unixMs));
        if (phase !== undefined) assert.equal(m.phase, phase, 'Diagnostic phase identity changed');
        if (m.type === 'phase-ready') { assert.equal(state, 'waiting-ready'); phase = m.phase; state = 'ready'; promises.ready.resolve(m); }
        else if (m.type === 'phase-started') {
          assert.equal(state, 'go-sent'); state = 'started';
          startedReceipt = { receivedNodeNs: String(process.hrtime.bigint()), receivedUnixMs: Date.now(), clock: 'node-hrtime' };
          promises.started.resolve(m);
        }
        else if (m.type === 'target-phase-done') {
          assert.equal(state, 'started'); assert.equal(m.postrollLimitMs, 2000); assert.equal(typeof m.passed, 'boolean');
          state = 'target-done'; promises.targetDone.resolve(m);
        } else if (m.type === 'phase-ended') { assert.equal(state, 'flushed'); assert.equal(typeof m.passed, 'boolean'); state = 'ended'; promises.ended.resolve(m); }
        else throw Error('Unknown diagnostic control message');
        events.push(m);
      }
    } catch (error) { fail(error); }
  });
  stream.on('error', fail); stream.on('end', () => { if (state !== 'ended') fail(Error('Diagnostic control closed before collection end')); });
  stream.on('close', () => { if (state !== 'ended' && state !== 'failed') fail(Error('Diagnostic control stream closed early')); });
  async function send(type, expected, next) {
    if (failure) throw failure; assert.equal(state, expected); verifyOwnedConsole(running, api);
    state = next; await new Promise((resolve, reject) => stream.write(JSON.stringify({ type, case: options.diagnosticCase, phase }) + '\n', error => error ? reject(error) : resolve()));
  }
  return { events, ready: promises.ready.promise, started: promises.started.promise,
    get startedReceipt() { return startedReceipt; }, targetDone: promises.targetDone.promise, ended: promises.ended.promise,
    abort: error => fail(error),
    go: () => send('phase-go', 'ready', 'go-sent'), flushed: () => send('phase-flushed', 'target-done', 'flushed') };
}
function sampleCloseTracker(child) {
  let closed = false;
  const completion = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  return { completion, closed: () => closed };
}
async function boundedSampleClose(lifecycle, timeoutMs, message = 'Owned CPU sample stdio close deadline exceeded') {
  let timer;
  try { await Promise.race([lifecycle.completion, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function settleSampleChildren(samples, api = guard, { waitExit = childCompletion, waitClose = boundedSampleClose,
  nowNs = () => process.hrtime.bigint(), deadlineNs = nowNs() + 15000000000n } = {}) {
  const remaining = () => {
    const value = Number(deadlineNs - nowNs()) / 1e6;
    assert(value > 0, 'Owned CPU sample shutdown deadline exceeded'); return value;
  };
  for (const { running, lifecycle } of samples) {
    let identityError;
    if (running.child.exitCode === null && running.child.signalCode === null) {
      try { verifyOwnedConsole(running, api); } catch (error) { identityError = error; }
    }
    // Cleanup time is separate from the60s collection budget. A timer/report
    // outcome alone never authorizes the target app to exit.
    await waitExit(running.child, remaining(), 'Owned CPU sample natural-exit barrier');
    await waitClose(lifecycle, remaining());
    assert(lifecycle.closed(), 'Owned CPU sample stdio is not closed');
    assert(running.child.exitCode !== null || running.child.signalCode !== null, 'Owned CPU sample remains alive');
    assert.equal(api.remainingProcesses(running).length, 0, 'Owned CPU sample children remain');
    if (identityError) throw identityError;
  }
}
function cancellableStackDelay(ms) {
  let resolve, timer, settled = false;
  const completion = new Promise(done => { resolve = done; timer = setTimeout(() => { settled = true; done(true); }, Math.ceil(ms)); });
  return { completion, cancel() { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } } };
}
function cpuStackSession(app, data, reportRoot, services, api = guard) {
  const plan = services.cpuStackPlan, tailOnce = plan?.mode === 'tail-once';
  assert(!plan || tailOnce, 'Unknown CPU stack plan');
  if (tailOnce) {
    assert.equal(plan.startedReceipt?.clock, 'node-hrtime');
    assert(/^[0-9]+$/.test(plan.startedReceipt.receivedNodeNs), 'Unknown phase-started receipt clock');
    assert.equal(plan.phaseStarted?.type, 'phase-started');
  }
  const report = { requested: true, maximumWallMs: 60000, maximumSampleSeconds: 60, chunkSeconds: 5,
    samplingIntervalMs: 5, windows: [], status: 'running', coverage: 'unknown',
    scope: 'One bounded diagnostic session; owned five-second sample chunks, possible launch/symbolication gaps. No millisecond-continuous or complete target coverage claim.' };
  const nowNs = services.nowNs || (() => process.hrtime.bigint());
  let stopped = false, stoppedBarrier, pendingDelay; const samples = []; const started = nowNs(); let cumulativeSeconds = 0;
  const elapsedMs = () => Number(nowNs() - started) / 1e6;
  if (tailOnce) {
    report.maximumSampleSeconds = 5; report.maximumLaunches = 1;
    report.plan = { mode: 'tail-once', delayAfterPhaseStartedReceiptMs: 28000, plannedSampleSeconds: 5,
      plannedIntervalAfterReceiptMs: [28000, 33000], startedReceipt: plan.startedReceipt,
      plannedLaunchNodeNs: String(BigInt(plan.startedReceipt.receivedNodeNs) + 28000000000n) };
    report.phaseStarted = plan.phaseStarted;
    report.scope = 'Exactly one five-second /usr/bin/sample invocation scheduled 28000ms after Node receives phase-started. Host receipt/scheduler and sample launch/symbolication can lag native phase timing; planned intervals do not prove actual tail coverage. Pending launch is cancelled when target-done is observed; no early fallback or retry. Original input/end deadlines and natural-exit/stdio cleanup barriers remain separate.';
  }
  const completion = (async () => {
    if (tailOnce) {
      const remainingMs = Math.max(0, Number(BigInt(report.plan.plannedLaunchNodeNs) - nowNs()) / 1e6);
      report.plan.delayRemainingAtScheduleMs = remainingMs;
      pendingDelay = (services.stackDelay || cancellableStackDelay)(remainingMs);
      const due = await pendingDelay.completion; pendingDelay = undefined;
      if (!due || stopped) {
        report.status = 'not-executed'; report.notExecutedReason = 'Target ended or session stopped before the scheduled launch';
      }
    }
    while (!stopped && elapsedMs() < 60000 && cumulativeSeconds < 60) {
      if (tailOnce && (report.status !== 'running' || samples.length || elapsedMs() > 45000)) break;
      // Reserve the whole bounded child-completion allowance so a final chunk
      // never starts when it cannot naturally finish inside this session.
      const seconds = tailOnce ? 5 : Math.min(5, 60 - cumulativeSeconds, Math.floor((60000 - elapsedMs() - 15000) / 1000));
      if (seconds < 1) break;
      const window = { requestedSeconds: seconds, targetIdentity: app.rootIdentity, launchUnixMs: Date.now(), launchElapsedMs: elapsedMs(),
        gapBeforeWindowMs: report.windows.length ? elapsedMs() - report.windows.at(-1).completedElapsedMs : null }; report.windows.push(window);
      if (tailOnce) {
        window.launchAttemptUnixMs = window.launchUnixMs; window.launchUnixMs = null;
      }
      cumulativeSeconds += seconds;
      try {
        verifyOwnedConsole(app, api); window.targetIdentityVerifiedBefore = true;
        const stem = `history-${path.basename(data).split('-').at(-1)}-cpu-stack-${report.windows.length}`;
        const output = path.join(reportRoot, `${stem}.txt`), logPath = path.join(reportRoot, `${stem}.log`);
        assert(!fs.existsSync(output)); const log = fs.openSync(logPath, 'wx', 0o600);
        if (tailOnce) {
          window.launchUnixMs = Date.now(); window.launchNodeNs = String(nowNs());
          window.actualDelaySincePhaseStartedReceiptMs = Number(BigInt(window.launchNodeNs) - BigInt(plan.startedReceipt.receivedNodeNs)) / 1e6;
          window.launchObservationScope = 'Host clocks sampled immediately before spawn; actual exec and target sampling begin can occur later.';
        }
        const child = (services.spawn || spawn)('/usr/bin/sample', [String(app.child.pid), String(seconds), '5', '-mayDie', '-file', output],
          { cwd: root, env: safeEnvironment(), stdio: ['ignore', log, log] });
        if (tailOnce) {
          window.spawnReturned = true;
          child.once('exit', (code, signal) => {
            window.exitObservedNodeNs = String(nowNs()); window.exitObservedUnixMs = Date.now();
            window.observedExitCode = code; window.observedExitSignal = signal;
          });
          child.once('close', () => { window.stdioClosedNodeNs = String(nowNs()); window.stdioClosedUnixMs = Date.now(); });
        }
        const lifecycle = sampleCloseTracker(child); // Attach before identity registration, including fast exits.
        const running = services.track(child, data, { executable: '/usr/bin/sample' }, `${stem}-cpu-stack-sampler`);
        samples.push({ running, lifecycle });
        child.once('close', () => fs.closeSync(log)); await services.register(running);
        await (services.waitChunkExit || childCompletion)(child, Math.max(1, Math.min(15000, 60000 - elapsedMs())), 'Owned CPU stack chunk');
        window.exitCode = child.exitCode; window.signal = child.signalCode; window.completedUnixMs = Date.now(); window.completedElapsedMs = elapsedMs();
        if (tailOnce) window.waitCompletedNodeNs = String(nowNs());
        const remaining = api.remainingProcesses(running); assert.equal(remaining.length, 0, 'CPU sample child remains');
        verifyOwnedConsole(app, api); window.targetIdentityVerifiedAfter = true;
        const logText = fs.readFileSync(logPath, 'utf8'); window.log = path.basename(logPath);
        if (child.exitCode !== 0 || child.signalCode !== null || !fs.existsSync(output)) {
          window.status = /permission|not permitted|not authorized|access denied/i.test(logText) ? 'permission-unavailable' : 'unavailable';
          report.status = window.status; break; // No retry or permission workaround.
        }
        window.status = 'captured'; window.path = path.basename(output); window.bytes = fs.statSync(output).size; window.sha256 = fileHash(output);
        if (tailOnce) break;
      } catch (error) { window.status = 'unavailable'; window.error = String(error); report.status = 'unavailable'; break; }
    }
    report.elapsedWallMs = elapsedMs(); report.requestedSampleSeconds = cumulativeSeconds;
    if (report.status === 'running') report.status = report.windows.length ? 'completed' : 'not-executed';
    if (tailOnce && !report.windows.length && !report.notExecutedReason)
      report.notExecutedReason = 'Scheduled launch did not fit the fixed observer wall-time cap; no early fallback or retry';
    return report;
  })(); completion.catch(() => {});
  return { report, completion, stop: () => {
    stopped = true;
    pendingDelay?.cancel();
    stoppedBarrier ||= (async () => {
      const nowNs = services.barrierWaits?.nowNs || (() => process.hrtime.bigint());
      const deadlineNs = nowNs() + 15000000000n;
      await boundedSampleClose({ completion }, 15000, 'Owned CPU sample collection shutdown deadline exceeded');
      await settleSampleChildren(samples, api, { ...services.barrierWaits, nowNs, deadlineNs });
      report.sampleProcessesExitedAndClosed = true;
      return report; // Unavailable remains unavailable even if a late output file appeared.
    })();
    stoppedBarrier.catch(() => {}); // Caller still observes rejection when awaiting the barrier.
    return stoppedBarrier;
  } };
}
async function runDiagnosticTarget(app, options, { profiler, profilerReport, startStacks, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const control = app.diagnosticControl; const ready = await control.ready;
  let stacks = options.cpuStackTailOnce ? undefined : startStacks?.();
  if (stacks) stacks.report.phaseReady = ready;
  if (profiler) {
    profilerReport.capture.phaseReady = ready;
    profilerReport.capture.startAcknowledgement = await startProfilerRecording(profiler);
    profiler.captureTimer = setTimeout(() => flushProfilerRecording(profiler).catch(error => { profiler.captureError = error; }), 60000);
  }
  await control.go();
  if (options.cpuStackTailOnce) {
    const phaseStarted = await control.started;
    stacks = startStacks?.({ mode: 'tail-once', phaseStarted, startedReceipt: control.startedReceipt });
    if (stacks) stacks.report.phaseReady = ready;
  }
  const done = await control.targetDone;
  if (stacks) { stacks.report.targetPhaseDone = done; stacks.report.phaseStarted = control.events.find(m => m.type === 'phase-started'); }
  const stoppedStacks = stacks?.stop(); // No new sample chunk after target-done.
  await wait(done.postrollLimitMs);
  if (profiler) clearTimeout(profiler.captureTimer);
  await Promise.all([profiler ? flushProfilerRecording(profiler) : undefined, stoppedStacks]);
  if (profiler?.captureError) throw profiler.captureError;
  await control.flushed(); await control.ended;
  if (profilerReport) profilerReport.capture.controlEvents = control.events;
  return control.events;
}
async function waitForProfilerFlush(running) {
  const deadline = Date.now() + 15000;
  const acknowledgement = `Data written to ${running.profilerTracePath}.`;
  while (Date.now() < deadline) {
    const log = fs.readFileSync(running.profilerLogPath, 'utf8');
    if (log.includes(acknowledgement)) return { flushAcknowledgedUnixMs: Date.now(), acknowledgement, channel: running.profilerAckChannel || 'legacy-log' };
    if (/Saving failed|Cannot overwrite|Overwrite \(y\/n\)/.test(log)) throw Error('Profiler did not acknowledge a fresh trace write');
    if (running.child.exitCode !== null || running.child.signalCode !== null) throw Error('Profiler exited before trace flush acknowledgement');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Profiler trace flush acknowledgement deadline exceeded');
}
async function flushProfilerRecording(running, api = guard) {
  if (running.profilerFlushPromise) return running.profilerFlushPromise;
  running.profilerFlushPromise = (async () => {
    if (running.profilerCapture) running.profilerCapture.stopRequestedUnixMs = Date.now();
    // Qt 6.11.2 CommandListener creates a temporary QTextStream for one line.
    // A second line in the same write can be read ahead and discarded. Wait
    // for the actual flush acknowledgement before issuing another command.
    await writeProfilerCommand(running, 'f\n', api);
    const acknowledgement = await (api.waitForProfilerFlush || waitForProfilerFlush)(running);
    if (running.profilerCapture) Object.assign(running.profilerCapture, acknowledgement);
    return acknowledgement;
  })();
  return running.profilerFlushPromise;
}
async function requestOwnedNormalExit(running, api = guard) {
  if (running.cycle.endsWith('cpu-stack-sampler')) {
    verifyOwnedConsole(running, api);
    await childCompletion(running.child, 15000, 'Owned bounded CPU stack sampler natural completion');
    return { method: 'Owned bounded sample child natural completion', actionSucceeded: true };
  }
  if (running.cycle.endsWith('model-server') || running.cycle.endsWith('qml-profiler')) {
    verifyOwnedConsole(running, api);
    if (running.cycle.endsWith('model-server')) {
      assert.equal(running.child.connected, true, 'Owned model IPC is disconnected');
      await new Promise((resolve, reject) => running.child.send({ type: 'shutdown' }, error => error ? reject(error) : resolve()));
      return { method: 'owned model ChildProcess IPC shutdown', actionSucceeded: true };
    }
    assert.equal(running.identity.profilerAttachmentMode, 'attach-only', 'Profiler shutdown requires the attach-only launch contract');
    if (running.consoleStopRequested) {
      if (running.consoleStopError) throw running.consoleStopError;
      return { method: 'owned profiler stdin flush/quit already requested', actionSucceeded: true };
    }
    running.consoleStopRequested = true;
    try {
      await flushProfilerRecording(running, api);
      await writeProfilerCommand(running, 'q\n', api);
    }
    catch (error) { running.consoleStopError = error; throw error; }
    return { method: 'owned attach-only profiler stdin flush/quit', actionSucceeded: true };
  }
  assert(running.identity.appRoot && running.identity.appId === 'com.muhe.reverie.qt.local',
    'No GUI normal exit contract for this owned process');
  return api.guardedAction(running, 'quit');
}
function validateBuildMode(options, record) {
  const enabled = record.diagnostics?.qmlProfilerEnabled === true;
  const timing = record.diagnostics?.timingProbesEnabled === true;
  assert(!timing || options.mode === 'diagnostic', 'A timing build can only run in diagnostic mode');
  assert(!options.diagnosticCase || timing && record.diagnostics?.ordinaryLauncherAllowed === false,
    'Diagnostic cases require a separately recorded timing diagnostic build');
  assert(!enabled || options.mode === 'diagnostic', 'A QML profiler build can only run in diagnostic mode');
  assert(!(options.profilerPort || options.qmlProfiler) || enabled,
    'QML profiler options require a separately recorded QML diagnostic build');
  return enabled;
}
function validateDiagnosticCollection(options, scene) {
  assert.equal(scene.schema, 'reverie.qt.diagnostic-case.v1'); assert.equal(scene.diagnosticCase, options.diagnosticCase);
  assert.equal(scene.mode, 'diagnostic'); assert.equal(scene.protocol, options.protocol);
  assert.equal(scene.performanceComparable, false, 'Diagnostic case cannot be performance comparable');
  assert.equal(scene.collectionComplete, true, scene.error || 'Diagnostic collection incomplete');
  assert.equal(scene.diagnosticBootstrapProviderProbesExpected, 1); assert.equal(scene.diagnosticSelectedWorkloadModelRequestsExpected, 0);
  assert.equal(typeof scene.selectedConstraintOutcome?.passed, 'boolean');
  assert(Array.isArray(scene.selectedConstraintOutcome.violations));
  const trace = scene.timingTrace; assert.equal(trace?.schema, 'reverie.qt.timing-trace.v1');
  if (options.metaCallContext) {
    assert.equal(scene.metaCallContextRequested, true, 'Requested MetaCall receiver observation was not enabled');
    const context = trace.metaCallContext;
    assert.equal(context?.schema, 'reverie.qt.metacall-context.v1'); assert.equal(context.requested, true);
    assert.equal(context.complete, true, 'Requested MetaCall context buffer incomplete');
    assert(Number.isInteger(context.capacity) && context.capacity >= 0 && context.capacity <= 32768);
    assert(Array.isArray(context.records) && context.records.length === context.recordCount && context.recordCount <= context.capacity);
    assert(Number.isInteger(context.droppedContexts) && context.droppedContexts >= 0);
    assert.equal(context.droppedContexts, 0, 'Requested MetaCall context records dropped');
    assert.equal(context.parentNodeLimit, 4); assert.equal(context.classNameByteLimit, 79);
  }
  assert.equal(trace.compiled, true); assert.equal(trace.essentialFailure, false, 'Essential timing trace records incomplete');
  assert(Array.isArray(trace.records) && trace.records.length === trace.recordCount);
  assert(trace.recordCount > 0 && trace.recordCount <= trace.recordCapacity);
  assert.equal(trace.observedWindowConfigured, true, 'Observed GUI window was not configured');
  assert(Number.isInteger(trace.guiThreadId) && trace.guiThreadId > 0);
  assert(Array.isArray(trace.kindNames) && trace.kindNames.includes('NotifyEvent'));
  assert(trace.eventTypeNames && typeof trace.eventTypeNames === 'object');
  assert(typeof trace.notifyEventFields?.a === 'string' && typeof trace.notifyEventFields?.b === 'string');
  const notifications = trace.records.filter(r => trace.kindNames[r.kind] === 'NotifyEvent');
  assert(notifications.some(r => r.isGui === true && r.b === 1), 'No observed-window GUI notification records');
  for (const r of notifications) {
    assert(Number.isInteger(r.a) && typeof trace.eventTypeNames[String(r.a)] === 'string', 'NotifyEvent enum has no readable mapping');
    assert.equal(r.isGui, true); assert.equal(r.threadId, trace.guiThreadId);
  }
  for (const counter of ['droppedRecords', 'stackOverflows', 'spanOrderErrors']) assert.equal(trace[counter], 0);
}
function validateCaseModelRequests(workload) {
  assert.equal(workload.calls.length, 1, 'Expected exactly one ordinary bootstrap probe and no scenario requests');
  assert.equal(workload.completed.length, 1, 'Expected exactly one completed bootstrap probe');
  const call = workload.calls[0], completion = workload.completed[0];
  assert.equal(call.kind, 'probe', 'Unexpected selected-workload model request');
  assert.equal(completion.sequence, call.sequence); assert.equal(completion.aborted, false);
  const ready = workload.controlEvents.find(m => m.type === 'phase-ready'); assert(ready, 'Missing diagnostic phase-ready boundary');
  for (const time of [call.startedUnixMs, completion.completedUnixMs]) {
    assert(Number.isFinite(time) && Number.isFinite(workload.scene.runStartUnixMs) && time < workload.scene.runStartUnixMs && time < ready.unixMs,
      'Bootstrap probe overlaps prefix/target scenario');
  }
  return { call, completion, sceneRunStartUnixMs: workload.scene.runStartUnixMs, phaseReadyUnixMs: ready.unixMs,
    scope: 'One unchanged ordinary-bootstrap probe completed before the scenario and target-ready gate. All raw calls/completions remain in the workload; no selected/prefix chat requests allowed.' };
}
function validateProfilerWindow(report) {
  const start = report.traceAttributes?.traceStart, end = report.traceAttributes?.traceEnd;
  assert(/^[0-9]+$/.test(start) && /^[0-9]+$/.test(end), 'Unknown actual profiler trace window');
  const duration = BigInt(end) - BigInt(start); assert(duration >= 0n, 'Invalid profiler trace clock bounds');
  report.capture.actualTraceDurationNs = String(duration);
  assert(duration <= 60000000000n, 'Profiler trace exceeded the fixed 60-second window');
}
function safeEnvironment(extra = {}) {
  return { ...Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'PATH']
    .filter(k => process.env[k] != null).map(k => [k, process.env[k]])), ...extra };
}
function fixtureConfig(endpoint) {
  return { llm: { provider: 'ollama', model: 'reverie-perf-test', base_url: endpoint },
    ui: { mode: 'mvp', experience_mode: 'core', onboarding_completed: true, onboarding_version: 3,
      onboarding_state: 'complete', onboarding_last_step: 'finish' },
    chat: { reply_delay_min: 1, reply_delay_max: 1, split_messages: false, typing_indicator: false, status: 'online' },
    features: { proactive_chat_enabled: false, proactive_notifications_enabled: false,
      autonomous_memory_llm_enabled: false }, tts: { enabled: false }, cloud_mode: 'local' };
}
async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function childCompletion(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed); error ? reject(error) : resolve(); };
    const exited = () => done(); const failed = error => done(error);
    const timer = setTimeout(() => done(Error(`${label} deadline exceeded`)), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once('exit', exited); child.once('error', failed);
  });
}
async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { console.log(USAGE); return; }
  assert.equal(process.platform, 'darwin', 'This harness requires the fixed macOS toolchain');
  const build = verifyBuild(root, options.buildDir); // Preserve the existing build/source trust contract.
  const qmlProfilerEnabled = validateBuildMode(options, build.record);
  assert(build.record.core, 'Native performance requires the explicitly licensed local SDK build');
  assert(fs.realpathSync(path.join(root, '.venv/bin/python')).startsWith(path.join(root, '.tools/python/')), 'Project Python identity changed');
  const modelBefore = digest(directoryInventory(options.model));
  const mockPolicy = modelPolicyRecord(options.protocol), deadlines = protocolDeadlines(options.protocol, options.diagnosticCase);
  const reportRoot = path.join(root, '.tools/reports', `qt-performance-${options.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  fs.mkdirSync(reportRoot, { recursive: true, mode: 0o700 });
  const result = { schema: options.diagnosticCase ? 'reverie.qt.diagnostic-case-run.v1' : 'reverie.qt.performance-run.v1', mode: options.mode, protocol: options.protocol,
    ...(options.diagnosticCase ? { diagnosticCase: options.diagnosticCase, collectionComplete: false, selectedConstraintOutcome: null,
      metaCallContextRequested: options.metaCallContext === true,
      diagnosticBootstrapProviderProbesExpected: 1, diagnosticSelectedWorkloadModelRequestsExpected: 0,
      passedScope: 'Collection/input/process integrity and cleanup only; selected original phase constraints are separately recorded.' } : {}),
    mockPolicy, protocolDeadlines: deadlines, rows: options.fullSuite ? [9, 100, 300] : [options.rows],
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    sourceDirty: Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim()),
    buildManifestSha256: build.buildManifestSha256, build: build.record, modelInput: modelBefore,
    workloadInputs: workloadInputHashes(), recordingRequested: options.record === true,
    environment: { macOS: spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(),
      hardware: os.cpus()[0]?.model, architecture: process.arch, node: process.version,
      powerBefore: spawnSync('/usr/bin/pmset', ['-g', 'batt'], {encoding:'utf8'}).stdout.trim(),
      powerSettingsBefore: spawnSync('/usr/bin/pmset', ['-g'], {encoding:'utf8'}).stdout.trim(),
      thermalBefore: spawnSync('/usr/bin/pmset', ['-g', 'therm'], {encoding:'utf8'}).stdout.trim(),
      thermalScope:'Available OS warning/status only; not measured chip temperature or controlled thermal conditions' },
    resourceMethod: 'libproc CPU ns, resident bytes, physical footprint, thread count; exact owned UID/birth/executable checked before and after every sample; 1 second target interval',
    resourceLimitations: 'CPU percentage is cumulative CPU delta divided by wall time (100% = one core). Sampler/host overhead excluded; no GPU or render-thread CPU attribution.',
    ownedInstances: [], workloads: [], passed: false, performanceComparable: options.mode === 'perf' };
  const run = guard.createIsolationContext(fs.realpathSync(os.tmpdir()));
  const active = [];
  let interrupted = false, currentApp;
  const signalHandler = () => {
    interrupted = true;
    result.interrupted = true;
    if (options.diagnosticCase && currentApp?.diagnosticControl) {
      currentApp.diagnosticControl.abort(Error('Diagnostic case interrupted'));
      return; // The case error path drains observers before requesting app quit.
    }
    if (currentApp?.rootIdentity && currentApp.child.exitCode === null) {
      try { result.normalExitRequest = guard.guardedAction(currentApp, 'quit'); }
      catch (error) { result.interruptError = String(error); }
    }
  };
  process.on('SIGINT', signalHandler); process.on('SIGTERM', signalHandler);
  const parentControl = message => { if(message?.type === 'abort-performance') signalHandler(); };
  process.on('message', parentControl);
  function track(child, data, identity, cycle) {
    const running = { runRoot: run.runRoot, userData: data, child, identity, cycle, owned: new Map(), spawnConfirmed: false };
    child.once('spawn', () => { running.spawnConfirmed = true; });
    child.on('error', error => { running.error = error; });
    active.push(running); return running;
  }
  async function register(running) {
    if (!running.spawnConfirmed && !running.error) await new Promise((resolve, reject) => {
      running.child.once('spawn', resolve); running.child.once('error', reject);
    });
    if (running.error) throw running.error;
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      assert.equal(running.cycle, 'cleanup', 'Non-cleanup process exited before identity registration');
      assert.equal(running.child.exitCode, 0); assert.equal(running.child.signalCode, null); return;
    }
    let processAbsent = false;
    try {
      guard.registerRoot(running, (runRoot, pids) => { const rows = guard.inspectProcesses(runRoot, pids); processAbsent = rows.length === 0; return rows; });
    } catch (registrationError) {
      const successfulCleanup = await cleanupExitedSuccessfully(running.child, { cycle: running.cycle, processAbsent,
        spawnConfirmed: running.spawnConfirmed, spawnError: running.error, registrationError });
      if (!successfulCleanup) throw registrationError;
      result.keyCleanupCompletedBeforeIdentityRegistration = true;
    }
    if (running.rootIdentity) {
      result.ownedInstances.push({ cycle: running.cycle, ...running.rootIdentity });
      fs.writeFileSync(path.join(reportRoot, 'process-identities.json'), JSON.stringify(result.ownedInstances, null, 2));
    }
  }
  function recordExit(running) {
    const remaining = running.rootIdentity ? guard.remainingProcesses(running) : [];
    (result.processExits ||= []).push({ cycle: running.cycle, exitCode: running.child.exitCode, signal: running.child.signalCode,
      remaining: remaining.map(p => ({ pid: p.pid, birth: p.birth, name: p.name })) });
    assert.equal(running.child.exitCode, 0, `${running.cycle} exited ${running.child.exitCode}; ${reportRoot}`);
    assert.equal(running.child.signalCode, null, `${running.cycle} terminated by signal`);
    assert.equal(remaining.length, 0, `${running.cycle} owned children remain`);
  }
  async function launch(data, context, cycle, flags, extraEnv = {}) {
    guard.assertIsolation(run.runRoot, data);
    const logName = cycle === 'cleanup' ? `${path.basename(data)}-cleanup-${active.filter(r => r.cycle === 'cleanup' && r.userData === data).length + 1}` : cycle;
    const log = fs.openSync(path.join(reportRoot, `${logName}.log`), 'wx', 0o600);
    const caseApp = options.diagnosticCase && cycle.endsWith('-app');
    const executionStartedNs = process.hrtime.bigint();
    const child = spawn(build.binary, ['--project-root', root, '--data-dir', data, '--python', path.join(root, '.venv/bin/python'),
      '--context', context, ...flags], { cwd: root, env: safeEnvironment(extraEnv), stdio: caseApp ? ['ignore', log, log, 'ignore', 'pipe'] : ['ignore', log, log] });
    const running = track(child, data, { executable: build.binary, appRoot: build.app, appId: 'com.muhe.reverie.qt.local' }, cycle);
    running.executionStartedNs = executionStartedNs;
    running.log = log;
    if (caseApp) running.diagnosticControl = diagnosticControl(running, options);
    child.once('close', () => { if (running.log !== null) { fs.closeSync(running.log); running.log = null; } });
    await register(running); return running;
  }
  async function boundedExit(running, normalRequest) {
    if (!running.rootIdentity) return;
    const present = guard.remainingProcesses(running);
    if (present.length === 0) return;
    if (running.child.exitCode === null) {
      try { await normalRequest(); await childCompletion(running.child, 10000, `${running.cycle} normal exit`); }
      catch (error) { (result.cleanupErrors ||= []).push(String(error)); }
    }
    for (const expected of guard.remainingProcesses(running).sort((a, b) => b.pid - a.pid)) {
      if (guard.signalOwned(running, expected, 'SIGKILL')) result.forcedCleanup = true;
    }
    if (running.child.exitCode === null) await childCompletion(running.child, 5000, `${running.cycle} failure cleanup`);
  }
  try {
    guard.prepareNativeController(run.runRoot);
    const sampler = compileSampler(run.runRoot); result.resourceSamplerSha256 = sampler.sourceSha256;
    for (const rows of result.rows) {
      if (interrupted) throw Error('Performance run interrupted');
      const data = guard.createIsolatedDirectory(run.runRoot, `history-${rows}`);
      const context = path.join(run.runRoot, `history-${rows}.context.json`);
      fs.writeFileSync(context, JSON.stringify({ schema: 'reverie.qt.isolation.v1', root: guard.snapshotDirectory(run.runRoot),
        data: guard.snapshotDirectory(data) }), { flag: 'wx', mode: 0o600 });
      const calls = [], completed = [];
      const serverChild = spawn(process.execPath, [path.join(__dirname, 'perf-model-server.cjs'), '--protocol', options.protocol],
        { cwd: root, env: safeEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const modelServer = track(serverChild, data, { executable: process.execPath }, `history-${rows}-model-server`);
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Owned model server startup deadline exceeded')), 10000);
        serverChild.on('message', message => {
          if (message?.type === 'ready') { clearTimeout(timeout); resolve(message); }
          else if (message?.type === 'call') calls.push(message);
          else if (message?.type === 'complete') completed.push(message);
        });
        serverChild.once('error', error => { clearTimeout(timeout); reject(error); });
        serverChild.once('exit', () => { clearTimeout(timeout); reject(Error('Model server exited before readiness')); });
      });
      await register(modelServer);
      const address = await ready;
      assert.equal(address.address, '127.0.0.1'); assert.equal(address.pid, serverChild.pid);
      assert(Number.isInteger(address.port) && address.port >= 1024 && address.port <= 65535);
      validateProviderReady(options, address, mockPolicy);
      const endpoint = `http://127.0.0.1:${address.port}/v1`;
      fs.mkdirSync(path.join(data, 'data'), { mode: 0o700 });
      fs.writeFileSync(path.join(data, 'data/config.json'), JSON.stringify(fixtureConfig(endpoint)), { flag: 'wx', mode: 0o600 });
      const fixturePath = path.join(reportRoot, `history-${rows}.fixture.json`);
      console.log(`Qt ${options.mode}, ${rows} synthetic rows: ${reportRoot}`);
      const seed = await launch(data, context, `history-${rows}-seed`, ['--perf-seed', '--perf-rows', String(rows), '--perf-fixture-report', fixturePath]);
      await childCompletion(seed.child, 120000, 'Encrypted history seed'); recordExit(seed);
      const fixture = JSON.parse(fs.readFileSync(fixturePath));
      assert.equal(fixture.rows, rows); assert.equal(fixture.encrypted, true); assert.equal(fixture.committed, true);
      assert(fixture.serializedHistoryBytes < 1024 * 1024); assert.equal(fixture.messageIds.length, rows);
      const scenePath = path.join(reportRoot, `history-${rows}.scene.json`);
      const profilerPort = (options.diagnosticCase ? options.qmlProfiler : qmlProfilerEnabled) ? (options.profilerPort || await freeLoopbackPort()) : null;
      const app = await launch(data, context, `history-${rows}-app`, ['--perf-report', scenePath, '--perf-rows', String(rows),
        '--perf-mode', options.mode, '--perf-protocol', options.protocol, '--test-model', options.model, '--test-endpoint', endpoint,
        ...(options.diagnosticCase ? ['--diagnostic-case', options.diagnosticCase, '--diagnostic-control-fd4'] : []),
        ...(options.metaCallContext ? ['--metacall-context'] : []),
        ...(options.record ? ['--record-ui'] : []), ...(profilerPort ? ['--profiler-port', String(profilerPort)] : [])],
      options.mode === 'diagnostic' && !options.diagnosticCase ? { QSG_INFO: '1', QSG_RENDER_TIMING: '1' } : {});
      currentApp = app;
      let profiler, profilerReport, profilerCaptureTimer, profilerFlushTask = Promise.resolve(), profilerFlushError;
      if (options.qmlProfiler) {
        guard.assertIsolation(run.runRoot, data);
        assert(guard.sameIdentity(guard.inspectProcesses(run.runRoot, [app.child.pid])[0], app.rootIdentity), 'App identity changed before local profiler attachment');
        const executable = path.join(root, '.tools/qt-sdk/bin/qmlprofiler');
        assert(fs.existsSync(executable), 'Fixed local qmlprofiler is unavailable');
        const tracePath = path.join(reportRoot, `history-${rows}.qmltrace`);
        const profilerLogPath = path.join(reportRoot, `history-${rows}-qml-profiler.log`);
        const log = fs.openSync(profilerLogPath, 'wx', 0o600);
        const profilerStderrLogPath = path.join(reportRoot, `history-${rows}-qml-profiler.stderr.log`);
        const stderrLog = fs.openSync(profilerStderrLogPath, 'wx', 0o600);
        const child = spawn(executable, ['--interactive', '--attach', '127.0.0.1', '--port', String(profilerPort), '--include',
          'binding,handlingsignal,creating,scenegraph', '--output', tracePath, ...(options.diagnosticCase ? ['--record', 'off'] : [])],
          { cwd: root, env: safeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
        profiler = track(child, data, { executable, profilerAttachmentMode: 'attach-only' }, `history-${rows}-qml-profiler`);
        child.stdin.on('error', error => { profiler.stdinError = error; });
        profiler.profilerLogPath = profilerStderrLogPath; profiler.profilerTracePath = tracePath;
        profiler.profilerStdoutLogPath = profilerLogPath; profiler.profilerAckChannel = 'stderr'; profiler.profilerAckStream = child.stderr;
        child.stdout.on('data', chunk => fs.writeSync(log, chunk));
        profiler.profilerOutput = profilerAckReader(child.stderr, chunk => fs.writeSync(stderrLog, chunk), 'stderr');
        child.once('close', () => { fs.closeSync(log); fs.closeSync(stderrLog); });
        await register(profiler);
        profilerReport = { host: '127.0.0.1', port: profilerPort, attachmentRequested: true, attached: false, traceParsed: false, services: 'QmlProfiler',
          tool: { path: executable, sha256: fileHash(executable) }, trace: path.basename(tracePath),
          capture: { configuredMaximumMs: 60000, registeredUnixMs: Date.now(), recordingStartObservedUnixMs: null,
            acknowledgementChannel: 'stderr', stdoutLog: path.basename(profilerLogPath), stderrLog: path.basename(profilerStderrLogPath),
            startObservationResolution: options.diagnosticCase ? 'Owned interactive stderr traceStarted ACK before target-go; native FD4 clocks locate actual target'
              : 'resource sampling interval; actual trace clock bounds are in traceAttributes',
            features: ['binding', 'handlingsignal', 'creating', 'scenegraph'],
            scope: options.diagnosticCase ? 'Owned FD4 phase-ready gate; record-off attachment, stderr start acknowledgement, target-go, postroll2s then stderr flush ACK. Maximum60s recording request; actual trace bounds retained.'
              : 'partial diagnostic trace: first 60 seconds after owned profiler registration, including bootstrap; full native diagnostic scenario continues unchanged' } };
        profiler.profilerCapture = profilerReport.capture;
        if (!options.diagnosticCase) profilerCaptureTimer = setTimeout(() => {
          profilerFlushTask = flushProfilerRecording(profiler).catch(error => {
            profilerFlushError = error; profilerReport.capture.error = String(error);
          });
        }, 60000);
      }
      const resources = [], sampleErrors = [];
      let sampling = true, timer, inFlight = Promise.resolve();
      const sample = async () => {
        try {
          if (profiler && !options.diagnosticCase && profilerReport.capture.recordingStartObservedUnixMs === null &&
              fs.readFileSync(profiler.profilerLogPath, 'utf8').includes('Application started recording'))
            profilerReport.capture.recordingStartObservedUnixMs = Date.now();
          const captured = await sampleOwned(sampler, app, [modelServer.rootIdentity, ...(profiler?.rootIdentity ? [profiler.rootIdentity] : [])]);
          for (const value of captured.samples) {
            const appIdentity = app.owned.get(value.identity.pid);
            const role = value.identity.pid === serverChild.pid ? 'mock-model' : value.identity.pid === profiler?.child.pid ? 'qml-profiler' : value.identity.pid === app.child.pid ? 'qt-app' :
              value.identity.name === fs.realpathSync(path.join(root, '.venv/bin/python')) && appIdentity?.ppid === app.child.pid ? 'python-backend' : 'app-worker';
            resources.push({ role, ...value });
          }
        } catch (error) { sampleErrors.push(String(error)); }
        if (sampling) timer = setTimeout(() => { inFlight = sample(); }, 1000);
      };
      inFlight = sample();
      let stacks;
      const caseSession = options.diagnosticCase ? runDiagnosticTarget(app, options, { profiler, profilerReport,
        startStacks: options.cpuStacks ? cpuStackPlan => { stacks = cpuStackSession(app, data, reportRoot, { track, register, cpuStackPlan }); return stacks; } : undefined }) : null;
      caseSession?.catch(() => {});
      let completionError;
      try {
        const remaining = options.diagnosticCase ? Math.max(1, deadlines.nodeChildMs - Number(process.hrtime.bigint() - app.executionStartedNs) / 1e6) : deadlines.nodeChildMs;
        const appCompletion = childCompletion(app.child, remaining, 'Native performance scenario');
        if (caseSession) await Promise.all([appCompletion, caseSession]); else await appCompletion;
      }
      catch (error) {
        completionError = error;
        if (options.diagnosticCase) {
          clearTimeout(profiler?.captureTimer);
          try {
            await closeDiagnosticDependencies({ profiler, stacks, app,
              stackProcesses: active.filter(r => r.cycle.endsWith('cpu-stack-sampler') && r.userData === data) },
            async running => {
              await boundedExit(running, () => requestOwnedNormalExit(running));
              if (running.rootIdentity) {
                await childCompletion(running.child, 5000, `${running.cycle} final error-path exit`);
                if (!running.cycle.endsWith('cpu-stack-sampler')) recordExit(running);
              }
            });
          } catch (cleanupError) { (result.cleanupErrors ||= []).push(String(cleanupError)); }
        }
      }
      finally {
        sampling = false; clearTimeout(timer); clearTimeout(profilerCaptureTimer); clearTimeout(profiler?.captureTimer);
        await inFlight; await profilerFlushTask;
        if (stacks) try { await stacks.stop(); } catch (error) { completionError ||= error; }
        currentApp = null;
      }
      let scene;
      try { scene = JSON.parse(fs.readFileSync(scenePath)); }
      catch (error) { scene = { passed: false, error: `Native scene report unavailable: ${error.message}` }; }
      const phases = scene.phases || scene.phaseIntervals || [];
      const resourcePath = path.join(reportRoot, `history-${rows}.resources.json`);
      const resourceSummary = summarizeResources(resources, phases);
      fs.writeFileSync(resourcePath, JSON.stringify({ schema: 'reverie.qt.performance-resources.v1', targetIntervalMs: 1000,
        samples: resources, summary: resourceSummary, errors: sampleErrors }, null, 2), { flag: 'wx', mode: 0o600 });
      const workload = { rows, protocol: options.protocol, mockPolicySha256: mockPolicy.sha256,
        fixture, scene, resources: path.basename(resourcePath), resourceSummary, calls, completed,
        ...(options.diagnosticCase ? { controlEvents: app.diagnosticControl.events, cpuStacks: stacks?.report || { requested: false, status: 'not-requested', coverage: 'unknown' } } : {}),
        profiler: profilerReport || (profilerPort ? { host: '127.0.0.1', port: profilerPort, attached: false, services: 'QmlProfiler' } : null) };
      result.workloads.push(workload);
      if (options.diagnosticCase && scene.selectedConstraintOutcome) result.selectedConstraintOutcome = { rows, ...scene.selectedConstraintOutcome };
      if (completionError) throw completionError;
      recordExit(app);
      if (profiler) {
        if (profilerFlushError) throw profilerFlushError;
        if (profiler.child.exitCode === null && profiler.child.signalCode === null)
          profilerReport.normalExitRequest = await requestOwnedNormalExit(profiler);
        await childCompletion(profiler.child, 30000, 'Attached QML profiler'); recordExit(profiler);
        const tracePath = path.join(reportRoot, profilerReport.trace);
        assert(fs.existsSync(tracePath) && fs.statSync(tracePath).size > 0, 'QML profiler did not write a trace');
        profilerReport.bytes = fs.statSync(tracePath).size; profilerReport.sha256 = fileHash(tracePath);
        const parsed = spawnSync(path.join(root, '.venv/bin/python'), [path.join(__dirname, 'perf-trace.py'), '--trace', tracePath],
          { cwd: root, env: safeEnvironment({ PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
        assert.equal(parsed.status, 0, `QML profiler trace is unreadable: ${parsed.error?.message || parsed.stderr}`);
        Object.assign(profilerReport, JSON.parse(parsed.stdout));
        assert.equal(profilerReport.traceParsed, true);
        assert.equal(profilerReport.traceHasEvents, true, 'QML profiler trace has no recorded events');
        if (options.diagnosticCase) validateProfilerWindow(profilerReport);
        profilerReport.attached = true;
      }
      if (options.diagnosticCase) { validateDiagnosticCollection(options, scene); workload.bootstrapProbe = validateCaseModelRequests(workload); }
      else assert.equal(scene.passed, true, scene.error || 'Native performance controls failed');
      validateWorkloadProtocol(options, workload, mockPolicy);
      validateRecording(options, scene);
      for (const kind of options.diagnosticCase ? [] : ['short', 'long', 'delayed']) {
        const matching = calls.filter(call => call.kind === kind);
        assert.equal(matching.length, 1, `Expected one ${kind} workload request`);
        assert.equal(completed.filter(call => call.sequence === matching[0].sequence && call.aborted === false).length, 1,
          `${kind} workload response did not complete normally`);
      }
      assert.equal(sampleErrors.length, 0, sampleErrors.join('; '));
      assert(resources.some(sample => sample.role === 'qt-app') && resources.some(sample => sample.role === 'python-backend') &&
        resources.some(sample => sample.role === 'mock-model'), 'Required app/backend/mock model resource coverage is absent');
      await boundedExit(modelServer, () => requestOwnedNormalExit(modelServer));
      recordExit(modelServer);
      if (options.diagnosticCase) validateCaseModelRequests(workload); // Include late owned IPC deliveries before service exit.
      const cleanup = await launch(data, context, 'cleanup', ['--remove-test-key']);
      await childCompletion(cleanup.child, 30000, 'Isolated key cleanup'); recordExit(cleanup);
    }
    result.modelInputUnchanged = JSON.stringify(digest(directoryInventory(options.model))) === JSON.stringify(modelBefore);
    assert(result.modelInputUnchanged, 'Authorized input model changed');
    result.applicationUnchanged = JSON.stringify(digest(directoryInventory(build.app))) === JSON.stringify(build.record.application.inventory);
    assert(result.applicationUnchanged, 'Application changed during performance run');
    result.passed = true;
    result.performanceComparable = workloadsComparable(options, result.workloads);
    if (options.diagnosticCase) {
      result.collectionComplete = result.workloads.every(w => w.scene.collectionComplete === true);
    }
  } catch (error) { result.error = String(error.stack || error); }
  finally {
    result.environment.powerAfter = spawnSync('/usr/bin/pmset', ['-g','batt'], {encoding:'utf8'}).stdout.trim();
    result.environment.powerSettingsAfter = spawnSync('/usr/bin/pmset', ['-g'], {encoding:'utf8'}).stdout.trim();
    result.environment.thermalAfter = spawnSync('/usr/bin/pmset', ['-g','therm'], {encoding:'utf8'}).stdout.trim();
    for (const running of cleanupOrder(active)) {
      try {
        await boundedExit(running, () => requestOwnedNormalExit(running));
      } catch (error) { (result.cleanupErrors ||= []).push(String(error)); }
    }
    // Cleanup attempts use only still-registered data/context identities. Never
    // adopt an arbitrary pathname or extend the cleanup completion exception.
    for (const rows of result.rows) {
      const data = path.join(run.runRoot, `history-${rows}`), context = path.join(run.runRoot, `history-${rows}.context.json`);
      if (!fs.existsSync(context) || active.some(r => r.cycle === 'cleanup' && r.userData === data && r.child.exitCode === 0)) continue;
      try { const cleanup = await launch(data, context, 'cleanup', ['--remove-test-key']);
        await childCompletion(cleanup.child, 30000, 'Isolated key cleanup'); recordExit(cleanup); }
      catch (error) { result.keyCleanupError = String(error); }
    }
    try { result.noResidualProcesses = active.every(r => r.rootIdentity ? guard.remainingProcesses(r).length === 0 :
      r.child.exitCode !== null || r.child.signalCode !== null); }
    catch (error) { result.noResidualProcesses = false; (result.cleanupErrors ||= []).push(String(error)); }
    if (result.forcedCleanup || !result.noResidualProcesses || result.keyCleanupError || interrupted || result.cleanupErrors?.length) result.passed = false;
    try {
      if (result.noResidualProcesses && !result.keyCleanupError) {
        guard.removeIsolationContext(run.runRoot); result.testDataRemoved = !fs.existsSync(run.runRoot);
      } else { result.testDataRemoved = false; result.retainedIsolationRoot = run.runRoot; }
    }
    catch (error) { result.testDataRemoved = false; result.passed = false; result.error ||= String(error); }
    result.performanceComparable = result.performanceComparable && result.passed && !result.forcedCleanup;
    if (options.diagnosticCase) { result.collectionComplete = result.collectionComplete && result.passed; result.performanceComparable = false; }
    process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler);
    process.removeListener('message', parentControl);
    fs.writeFileSync(path.join(reportRoot, 'summary.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ reportRoot, passed: result.passed, performanceComparable: result.performanceComparable, error: result.error,
      ...(options.diagnosticCase ? { collectionComplete: result.collectionComplete, selectedConstraintOutcome: result.selectedConstraintOutcome } : {}) }));
    if (!result.passed) process.exitCode = 1;
    if (require.main === module && process.connected) process.disconnect();
  }
  return result;
}
if (require.main === module) main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
module.exports = { parseArguments, validateBuildMode, validateRecording, protocolDeadlines, validateProviderReady,
  validateWorkloadProtocol, workloadsComparable, workloadInputHashes, WORKLOAD_INPUT_PATHS, requestOwnedNormalExit,
  flushProfilerRecording, waitForProfilerFlush, startProfilerRecording, profilerAckReader, profilerStdoutReader, diagnosticControl, runDiagnosticTarget,
  profilerRecordingAckVariant, cleanupOrder, closeDiagnosticDependencies, sampleCloseTracker, settleSampleChildren, cpuStackSession,
  validateDiagnosticCollection, validateCaseModelRequests, validateProfilerWindow, fixtureConfig, safeEnvironment, childCompletion, main, USAGE };
