'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { parseArguments, validateBuildMode, validateRecording, protocolDeadlines, validateProviderReady,
  validateWorkloadProtocol, workloadsComparable, workloadInputHashes, WORKLOAD_INPUT_PATHS,
  requestOwnedNormalExit, flushProfilerRecording, waitForProfilerFlush, startProfilerRecording, profilerAckReader, profilerStdoutReader,
  diagnosticControl, runDiagnosticTarget, profilerRecordingAckVariant, cleanupOrder, closeDiagnosticDependencies,
  sampleCloseTracker, settleSampleChildren, cpuStackSession, validateDiagnosticCollection, validateCaseModelRequests, validateProfilerWindow, fixtureConfig, childCompletion } = require('./check-performance.cjs');
const { classify, createModelServer, modelServerArguments, modelPolicyRecord,
  SHORT_TEXT, LONG_TEXT, COMPANION_SHORT_TEXT, COMPANION_LONG_TEXT } = require('./perf-model-server.cjs');
const { summarizeResources } = require('./perf-sampling.cjs');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs'), os = require('node:os');
const { sameIdentity } = require('../frontend/script/acceptance-isolation.cjs');
test('performance launch requires an explicit build and closed option vocabulary', () => {
  assert.throws(() => parseArguments([]), /Explicit --build-dir/);
  for (const args of [ ['--build-dir', 'relative'], ['--build-dir', '/candidate', '--rows', '301'],
    ['--build-dir', '/candidate', '--mode', 'record'], ['--build-dir', '/candidate', '--interactive'],
    ['--build-dir', '/candidate', '--build-dir', '/other'], ['--build-dir', '/candidate', '--rows', '9', '--full-suite'],
    ['--build-dir', '/candidate', '--profiler-port', '12345'], ['--build-dir', '/candidate', '--mode', 'diagnostic', '--profiler-port', '80'] ])
    assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(['--build-dir', '/candidate', '--rows', '9']).rows, 9);
  assert.equal(parseArguments(['--build-dir', '/candidate', '--mode', 'diagnostic', '--profiler-port', '12345']).profilerPort, 12345);
  assert.equal(parseArguments(['--build-dir', '/candidate', '--full-suite']).fullSuite, true);
});
test('supplemental protocol is explicit, closed and has its own bounded history deadline', () => {
  assert.equal(parseArguments(['--build-dir', '/candidate']).protocol, 'stress-v1');
  assert.equal(parseArguments(['--build-dir', '/candidate', '--protocol', 'stress-v1']).protocol, 'stress-v1');
  const supplemental = parseArguments(['--build-dir', '/candidate', '--protocol', 'companion-transactions-v1', '--full-suite']);
  assert.equal(supplemental.protocol, 'companion-transactions-v1'); assert.equal(supplemental.fullSuite, true);
  for (const args of [ ['--build-dir', '/candidate', '--protocol', 'unknown'], ['--build-dir', '/candidate', '--protocol'],
    ['--build-dir', '/candidate', '--protocol', 'stress-v1', '--protocol', 'companion-transactions-v1'] ])
    assert.throws(() => parseArguments(args));
  assert.deepEqual(protocolDeadlines('stress-v1'), { nativeHistoryMs: 420000, nodeChildMs: 600000 });
  assert.deepEqual(protocolDeadlines('companion-transactions-v1'), { nativeHistoryMs: 1800000, nodeChildMs: 1860000 });
  assert.throws(() => protocolDeadlines('unknown'));
});
test('diagnostic cases are bounded closed selections, never perf/full-suite/recording', () => {
  const base = ['--build-dir', '/candidate', '--mode', 'diagnostic'];
  for (const rows of ['100', '300']) assert.equal(parseArguments([...base, '--diagnostic-case', 'reading-close', '--rows', rows]).diagnosticCase, 'reading-close');
  for (const name of ['scroll-tail', 'scroll-tail-with-prefix']) assert.equal(parseArguments([...base, '--protocol', 'companion-transactions-v1', '--diagnostic-case', name]).diagnosticCase, name);
  for (const extra of [['--diagnostic-case', 'unknown'], ['--diagnostic-case', 'reading-close', '--rows', '9'],
    ['--diagnostic-case', 'scroll-tail'], ['--diagnostic-case', 'reading-close', '--full-suite'],
    ['--diagnostic-case', 'reading-close', '--profiler-port', '12345'],
    ['--diagnostic-case', 'reading-close', '--record'], ['--cpu-stacks'],
    ['--diagnostic-case', 'reading-close', '--protocol', 'companion-transactions-v1']]) assert.throws(() => parseArguments([...base, ...extra]));
  assert.throws(() => parseArguments(['--build-dir', '/candidate', '--mode', 'perf', '--diagnostic-case', 'reading-close']));
  assert.equal(parseArguments([...base, '--diagnostic-case', 'reading-close', '--cpu-stacks']).cpuStacks, true);
  assert.deepEqual(protocolDeadlines('stress-v1', 'reading-close'), { nativeHistoryMs: 120000, nodeChildMs: 120000, cleanupIncluded: false });
  assert.equal(protocolDeadlines('companion-transactions-v1', 'scroll-tail-with-prefix').nodeChildMs, 900000);
});
test('timing candidates stay diagnostic-only and cases require the timing build identity', () => {
  const timing = { diagnostics: { qmlProfilerEnabled: false, timingProbesEnabled: true, ordinaryLauncherAllowed: false } };
  assert.equal(validateBuildMode({ mode: 'diagnostic', diagnosticCase: 'reading-close' }, timing), false);
  assert.throws(() => validateBuildMode({ mode: 'perf' }, timing), /timing build/);
  assert.throws(() => validateBuildMode({ mode: 'visual' }, timing), /timing build/);
  assert.throws(() => validateBuildMode({ mode: 'diagnostic', diagnosticCase: 'reading-close' }, { diagnostics: { qmlProfilerEnabled: false } }), /timing diagnostic build/);
  assert.equal(validateBuildMode({ mode: 'diagnostic', diagnosticCase: 'reading-close', qmlProfiler: true },
    { diagnostics: { timingProbesEnabled: true, qmlProfilerEnabled: true, ordinaryLauncherAllowed: false } }), true);
});
test('MetaCall context is opt-in only for diagnostic reading-close with unchanged run caps', () => {
  const base = ['--build-dir', '/candidate', '--mode', 'diagnostic', '--diagnostic-case', 'reading-close'];
  assert.equal(parseArguments([...base, '--metacall-context']).metaCallContext, true);
  assert.equal(parseArguments(base).metaCallContext, undefined);
  for (const args of [ ['--build-dir', '/candidate', '--metacall-context'],
    ['--build-dir', '/candidate', '--mode', 'visual', '--metacall-context'],
    ['--build-dir', '/candidate', '--mode', 'diagnostic', '--metacall-context'],
    ['--build-dir', '/candidate', '--mode', 'diagnostic', '--protocol', 'companion-transactions-v1', '--diagnostic-case', 'scroll-tail', '--metacall-context'],
    [...base, '--metacall-context', '--metacall-context'] ]) assert.throws(() => parseArguments(args));
  assert.deepEqual(protocolDeadlines('stress-v1', 'reading-close'), { nativeHistoryMs: 120000, nodeChildMs: 120000, cleanupIncluded: false });
});
test('single tail sample requires reading-close stacks and a separate profiler-free process', () => {
  const base = ['--build-dir', '/candidate', '--mode', 'diagnostic', '--diagnostic-case', 'reading-close'];
  assert.equal(parseArguments([...base, '--cpu-stacks', '--cpu-stack-tail-once']).cpuStackTailOnce, true);
  assert.equal(parseArguments([...base, '--cpu-stacks']).cpuStackTailOnce, undefined);
  for (const args of [[...base, '--cpu-stack-tail-once'], [...base, '--cpu-stacks', '--cpu-stack-tail-once', '--qml-profiler'],
    [...base, '--cpu-stacks', '--cpu-stack-tail-once', '--profiler-port', '12345'],
    ['--build-dir', '/candidate', '--mode', 'diagnostic', '--protocol', 'companion-transactions-v1', '--diagnostic-case', 'scroll-tail', '--cpu-stacks', '--cpu-stack-tail-once'],
    [...base, '--cpu-stacks', '--cpu-stack-tail-once', '--cpu-stack-tail-once']]) assert.throws(() => parseArguments(args));
});
test('case collection success preserves a failed selected deadline and never accepts performance', () => {
  const options = { mode: 'diagnostic', diagnosticCase: 'scroll-tail', protocol: 'companion-transactions-v1' };
  const scene = { schema: 'reverie.qt.diagnostic-case.v1', ...options, performanceComparable: false, collectionComplete: true,
    diagnosticBootstrapProviderProbesExpected: 1, diagnosticSelectedWorkloadModelRequestsExpected: 0,
    selectedConstraintOutcome: { passed: false, violations: ['completion crossed30s'], scope: 'selected phases only' },
    timingTrace: { schema: 'reverie.qt.timing-trace.v1', compiled: true, essentialFailure: false,
      observedWindowConfigured: true, guiThreadId: 1, kindNames: ['NotifyEvent'], eventTypeNames: { 31: 'Wheel' },
      notifyEventFields: { a: 'QEvent enum', b: 'Observed window receiver flag' }, records: [{ kind: 0, isGui: true, b: 1, threadId: 1, a: 31 }], recordCount: 1, recordCapacity: 10,
      droppedRecords: 0, stackOverflows: 0, spanOrderErrors: 0, incompleteSpans: 1, errorSpans: 1, cutoffOmittedSpanEnds: 1 } };
  validateDiagnosticCollection(options, scene);
  for (const change of [s => s.collectionComplete = false, s => s.performanceComparable = true,
    s => s.timingTrace.essentialFailure = true, s => s.timingTrace.droppedRecords = 1, s => s.schema = 'reverie.qt.performance-scenarios.v1']) {
    const bad = structuredClone(scene); change(bad); assert.throws(() => validateDiagnosticCollection(options, bad));
  }
  const missingMapping = structuredClone(scene); delete missingMapping.timingTrace.eventTypeNames[31];
  assert.throws(() => validateDiagnosticCollection(options, missingMapping), /readable mapping/);
  const readingOptions = { mode: 'diagnostic', diagnosticCase: 'reading-close', protocol: 'stress-v1', metaCallContext: true };
  const reading = structuredClone(scene);
  Object.assign(reading, { diagnosticCase: 'reading-close', protocol: 'stress-v1', metaCallContextRequested: true });
  assert.throws(() => validateDiagnosticCollection(readingOptions, reading));
  reading.timingTrace.metaCallContext = { schema: 'reverie.qt.metacall-context.v1', requested: true, complete: false,
    capacity: 0, recordCount: 0, records: [], droppedContexts: 1, parentNodeLimit: 4, classNameByteLimit: 79 };
  assert.throws(() => validateDiagnosticCollection(readingOptions, reading), /buffer incomplete/);
  Object.assign(reading.timingTrace.metaCallContext, { complete: true, droppedContexts: 0 });
  validateDiagnosticCollection(readingOptions, reading);
  const absent = structuredClone(reading); delete absent.metaCallContextRequested;
  assert.throws(() => validateDiagnosticCollection(readingOptions, absent), /not enabled/);
});
test('diagnostic case admits only the one unchanged probe strictly before scenario start and target-ready', () => {
  const workload = { calls: [{ kind: 'probe', sequence: 1, startedUnixMs: 10 }],
    completed: [{ sequence: 1, aborted: false, completedUnixMs: 20 }], scene: { runStartUnixMs: 30 },
    controlEvents: [{ type: 'phase-ready', unixMs: 40 }] };
  const probe = validateCaseModelRequests(workload); assert.equal(probe.completion.completedUnixMs, 20); assert.equal(workload.calls.length, 1);
  for (const change of [w => w.calls = [], w => w.calls.push({ kind: 'short' }), w => w.calls[0].kind = 'long',
    w => w.completed[0].aborted = true, w => w.completed[0].sequence = 2,
    w => w.completed[0].completedUnixMs = 30, w => w.calls[0].startedUnixMs = 35,
    w => w.controlEvents[0].unixMs = 20]) {
    const bad = structuredClone(workload); change(bad); assert.throws(() => validateCaseModelRequests(bad));
  }
});
test('QML-enabled diagnostic builds and launch options cannot contaminate perf mode', () => {
  const normal = { diagnostics: { qmlProfilerEnabled: false } }, diagnostic = { diagnostics: { qmlProfilerEnabled: true } };
  assert.equal(validateBuildMode({ mode: 'perf' }, normal), false);
  assert.equal(validateBuildMode({ mode: 'diagnostic' }, normal), false);
  assert.equal(validateBuildMode({ mode: 'diagnostic', qmlProfiler: true }, diagnostic), true);
  assert.throws(() => validateBuildMode({ mode: 'perf' }, diagnostic), /only run in diagnostic/);
  assert.throws(() => validateBuildMode({ mode: 'diagnostic', qmlProfiler: true }, normal), /separately recorded/);
  assert.throws(() => validateBuildMode({ mode: 'diagnostic', profilerPort: 12345 }, normal), /separately recorded/);
});
test('recording is explicitly visual-only and duplicate flags are rejected', () => {
  assert.equal(parseArguments(['--build-dir', '/candidate', '--mode', 'visual', '--record']).record, true);
  for (const args of [ ['--build-dir', '/candidate', '--record'],
    ['--build-dir', '/candidate', '--mode', 'diagnostic', '--record'],
    ['--build-dir', '/candidate', '--mode', 'visual', '--record', '--record'] ])
    assert.throws(() => parseArguments(args));
});
test('requested recording requires an actual successful scene recording report', () => {
  validateRecording({ record: true }, { recording: { ok: true } });
  validateRecording({}, {});
  assert.throws(() => validateRecording({ record: true }, {}), /did not finish successfully/);
  assert.throws(() => validateRecording({ record: true }, { recording: { ok: false } }), /did not finish successfully/);
});
test('workload source hashes cover the complete shared native scenario, probes, isolation and toolchain contract', () => {
  const hashes = workloadInputHashes();
  const expected = [
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
  ];
  assert.deepEqual(Object.keys(hashes).sort(), expected.sort());
  for (const value of Object.values(hashes)) assert.match(value, /^[a-f0-9]{64}$/);
});
test('workload equality detects a native scenario edit while permitting renderer asset edits', () => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-workload-hash-'));
  try {
    for (const name of WORKLOAD_INPUT_PATHS) {
      const target = path.join(fixture, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, name);
    }
    const baseline = workloadInputHashes(fixture);
    for (const name of ['native-ui/src/NativeAvatar.cpp', 'native-ui/qml/Main.qml', 'native-ui/shaders/blur.frag']) {
      const target = path.join(fixture, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'renderer optimization');
    }
    assert.deepEqual(workloadInputHashes(fixture), baseline);
    fs.appendFileSync(path.join(fixture, 'native-ui/tests/PerfScenarioCheck.cpp'), '\nscenario changed');
    const changed = workloadInputHashes(fixture);
    assert.notEqual(changed['native-ui/tests/PerfScenarioCheck.cpp'], baseline['native-ui/tests/PerfScenarioCheck.cpp']);
    assert.equal(changed['native-ui/perf-fixtures.py'], baseline['native-ui/perf-fixtures.py']);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
function normalExitFixture() {
  const expected = { pid: 123, uid: 501, birth: '1:2', name: '/owned/qmlprofiler' }, calls = [];
  const running = { runRoot: '/registered/run', userData: '/registered/run/data', cycle: 'history-300-qml-profiler',
    identity: { executable: expected.name, profilerAttachmentMode: 'attach-only' }, rootIdentity: expected,
    owned: new Map([[expected.pid, expected]]), child: { pid: expected.pid, connected: true,
      stdin: { writable: true, destroyed: false, writableEnded: false, write: (command, done) => { calls.push(['stdin', command]); done(); } },
      send: (message, done) => { calls.push(['ipc', message]); done(); } } };
  const api = { assertIsolation: () => calls.push(['isolation']), inspectProcesses: () => [expected], sameIdentity,
    waitForProfilerFlush: async () => { calls.push(['flush-ack']); return { flushAcknowledgedUnixMs: 123 }; },
    guardedAction: (_running, operation) => { calls.push(['gui', operation]); return { actionSucceeded: true }; } };
  return { running, calls, api };
}
function diagnosticControlFixture(reading = false) {
  const { Duplex } = require('node:stream'), fixture = normalExitFixture(), writes = [];
  const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { writes.push(JSON.parse(chunk)); done(); } });
  fixture.running.child.stdio = [null, null, null, null, stream];
  const options = reading ? { diagnosticCase: 'reading-close', protocol: 'stress-v1', rows: 100 }
    : { diagnosticCase: 'scroll-tail', protocol: 'companion-transactions-v1', rows: 300 };
  fixture.running.diagnosticControl = diagnosticControl(fixture.running, options, fixture.api);
  let sequence = 0;
  const emit = (type, extra = {}) => stream.push(JSON.stringify({ type, case: options.diagnosticCase,
    protocol: options.protocol, rows: options.rows, phase: reading ? 0 : 2, absoluteNs: String(++sequence), unixMs: sequence,
    ...(type === 'target-phase-done' ? { postrollLimitMs: 2000, passed: false } : {}), ...(type === 'phase-ended' ? { passed: false } : {}), ...extra }) + '\n');
  return { ...fixture, options, stream, writes, emit };
}
test('private fd4 gate preserves phase identity/order and requires both go and flush acknowledgements', async () => {
  const f = diagnosticControlFixture(), control = f.running.diagnosticControl;
  f.emit('phase-ready'); await control.ready; await control.go();
  assert.deepEqual(f.writes[0], { type: 'phase-go', case: 'scroll-tail', phase: 2 });
  f.emit('phase-started'); f.emit('target-phase-done'); await control.targetDone; await control.flushed();
  f.emit('phase-ended'); await control.ended;
  assert.equal(f.writes[1].type, 'phase-flushed'); assert.equal(control.events.length, 4);
  f.stream.destroy();
});
test('private diagnostic control refuses wrong rows, replay and changed process identity before commands', async () => {
  let f = diagnosticControlFixture(); f.emit('phase-ready', { rows: 100 });
  await assert.rejects(f.running.diagnosticControl.ready); f.stream.destroy();
  f = diagnosticControlFixture(); f.emit('phase-ready'); await f.running.diagnosticControl.ready;
  f.api.inspectProcesses = () => [{ ...f.running.rootIdentity, birth: 'changed' }];
  await assert.rejects(f.running.diagnosticControl.go(), /identity changed/); assert.equal(f.writes.length, 0); f.stream.destroy();
  f = diagnosticControlFixture(); f.emit('phase-ready'); await f.running.diagnosticControl.ready; f.emit('phase-ready');
  await assert.rejects(f.running.diagnosticControl.targetDone); f.stream.destroy();
  f = diagnosticControlFixture(true); f.emit('phase-ready'); await f.running.diagnosticControl.ready; await f.running.diagnosticControl.go();
  assert.equal(f.writes[0].phase, 0); f.emit('phase-started', { phase: 2 });
  await assert.rejects(f.running.diagnosticControl.targetDone, /phase/); f.stream.destroy();
  f = diagnosticControlFixture(true); f.emit('phase-ready', { phase: '0' });
  await assert.rejects(f.running.diagnosticControl.ready); f.stream.destroy();
});
test('actual QtCore JSON and Node fd4 interoperates through numeric phase0 and phase2 acknowledgements', { skip: process.platform !== 'darwin' }, async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-fd4-qtcore-'));
  let live;
  try {
    const qt = path.resolve(__dirname, '../.tools/qt-sdk/lib'), source = path.join(directory, 'fd4-peer.cpp'), binary = path.join(directory, 'fd4-peer');
    // Only a disposable QtCore console peer. No Reverie build, model, QML or
    // QGuiApplication. Match Control::send/receive's actual QJson number type.
    fs.writeFileSync(source, `#include <QtCore/QCoreApplication>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QDateTime>
#include <unistd.h>
#include <cstdlib>
static QByteArray line(){QByteArray b;char c;while(::read(4,&c,1)==1){if(c=='\\n')return b;b+=c;if(b.size()>8192)std::exit(9);}std::exit(8);}
int main(int argc,char**argv){QCoreApplication app(argc,argv);int phase=QString::fromUtf8(argv[1]).toInt();
QString name=phase==0?"reading-close":"scroll-tail",protocol=phase==0?"stress-v1":"companion-transactions-v1";int rows=phase==0?100:300;
auto send=[&](const char*type){QJsonObject value{{"type",type},{"case",name},{"protocol",protocol},{"rows",rows},{"phase",phase},{"absoluteNs","123456"},{"unixMs",double(QDateTime::currentMSecsSinceEpoch())}};
if(QByteArray(type)=="target-phase-done"){value["passed"]=false;value["postrollLimitMs"]=2000;}if(QByteArray(type)=="phase-ended")value["passed"]=false;
auto bytes=QJsonDocument(value).toJson(QJsonDocument::Compact)+'\\n';return ::write(4,bytes.constData(),bytes.size())==bytes.size();};
auto ack=[&](const char*type){auto doc=QJsonDocument::fromJson(line());auto value=doc.object();return doc.isObject()&&value.size()==3&&value.value("type").toString()==type&&value.value("case").toString()==name&&value.value("phase").isDouble()&&value.value("phase").toDouble()==phase;};
if(!send("phase-ready")||!ack("phase-go"))return 2;
if(!send("phase-started")||!send("target-phase-done")||!ack("phase-flushed"))return 3;
return send("phase-ended")?0:4;}
`);
    const compilation = spawnSync('/usr/bin/clang++', ['-std=c++20', '-F', qt, '-framework', 'QtCore', '-Wl,-rpath,' + qt, source, '-o', binary],
      { encoding: 'utf8', timeout: 30000 }); assert.equal(compilation.status, 0, compilation.stderr);
    for (const phase of [0, 2]) {
      const child = spawn(binary, [String(phase)], { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'pipe'] }); live = child;
      const identity = { pid: child.pid, birth: 'owned-test-peer', uid: process.getuid(), name: binary };
      const app = { runRoot: directory, userData: directory, child, rootIdentity: identity, owned: new Map([[child.pid, identity]]) };
      const options = { diagnosticCase: phase === 0 ? 'reading-close' : 'scroll-tail', protocol: phase === 0 ? 'stress-v1' : 'companion-transactions-v1', rows: phase === 0 ? 100 : 300 };
      // Process-birth safeguards have separate tests; this test isolates the
      // actual Qt serialization and Unix duplex fd4 wire contract.
      const api = { assertIsolation: () => {}, inspectProcesses: () => [identity], sameIdentity };
      app.diagnosticControl = diagnosticControl(app, options, api);
      await Promise.all([runDiagnosticTarget(app, options, { wait: async ms => assert.equal(ms, 2000) }), childCompletion(child, 5000, 'QtCore fd4 peer')]);
      assert.equal(child.exitCode, 0); assert.deepEqual(app.diagnosticControl.events.map(m => m.phase), [phase, phase, phase, phase]);
      assert.deepEqual(app.diagnosticControl.events.map(m => m.type), ['phase-ready', 'phase-started', 'target-phase-done', 'phase-ended']); live = undefined;
    }
  } finally {
    if (live?.exitCode === null) { live.kill('SIGTERM'); await childCompletion(live, 2000, 'failed QtCore test peer'); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('diagnostic target waits postroll then sends flush acknowledgement without expanding the active target', async () => {
  const f = diagnosticControlFixture(), delays = [], control = f.running.diagnosticControl;
  const pending = runDiagnosticTarget(f.running, f.options, { wait: async ms => { delays.push(ms); } });
  f.emit('phase-ready'); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.writes[0].type, 'phase-go');
  f.emit('phase-started'); f.emit('target-phase-done'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delays, [2000]); assert.equal(f.writes[1].type, 'phase-flushed');
  f.emit('phase-ended'); await pending; assert.equal(control.events[2].passed, false); f.stream.destroy();
});
test('single tail scheduling starts after phase-started receipt, not phase-ready or phase-go', async () => {
  const f = diagnosticControlFixture(true), started = [];
  f.options.cpuStackTailOnce = true;
  const pending = runDiagnosticTarget(f.running, f.options, { wait: async () => {}, startStacks: plan => {
    started.push(plan); return { report: {}, stop: async () => {} };
  } });
  try {
    f.emit('phase-ready'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.length, 0); assert.equal(f.writes[0].type, 'phase-go');
    f.emit('phase-started'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(started.length, 1); assert.equal(started[0].mode, 'tail-once');
    assert.equal(started[0].startedReceipt.clock, 'node-hrtime'); assert.match(started[0].startedReceipt.receivedNodeNs, /^\d+$/);
    f.emit('target-phase-done'); await new Promise(resolve => setImmediate(resolve)); f.emit('phase-ended'); await pending;
  } finally { f.stream.destroy(); }
});
test('profiler starts only after a future owned stderr ACK, never cached output or stdout timing', async () => {
  const { PassThrough } = require('node:stream'), f = normalExitFixture(), stderr = new PassThrough();
  f.running.child.stderr = stderr; f.running.profilerAckStream = stderr;
  f.running.profilerOutput = profilerAckReader(stderr, () => {}, 'stderr');
  stderr.write('Application started recording\n');
  const pending = startProfilerRecording(f.running, f.api); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.filter(c => c[0] === 'stdin'), [['stdin', 'r\n']]);
  let settled = false; pending.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  stderr.write('> Application started '); stderr.write('recording\n'); const acknowledgement = await pending;
  assert.equal(acknowledgement.sequence, 2); assert(acknowledgement.source.includes('stderr')); assert.equal(acknowledgement.channel, 'stderr'); stderr.end();
});
test('interactive and application traceStarted ACK variants are exact and recorded, never arbitrary started output', async () => {
  assert.equal(profilerRecordingAckVariant('> Recording started'), 'interactive-toggle-traceStarted');
  assert.equal(profilerRecordingAckVariant('Application started recording'), 'application-traceStarted');
  for (const line of ['Started', 'Recording Status: on', 'Data recording started', 'Recording started successfully', 'Application stopped recording.'])
    assert.equal(profilerRecordingAckVariant(line), null);
  for (const [line, variant] of [['> Recording started', 'interactive-toggle-traceStarted'], ['> Application started recording', 'application-traceStarted']]) {
    const { PassThrough } = require('node:stream'), f = normalExitFixture(), stderr = new PassThrough();
    f.running.child.stderr = stderr; f.running.profilerAckStream = stderr; f.running.profilerOutput = profilerAckReader(stderr, () => {}, 'stderr');
    const pending = startProfilerRecording(f.running, f.api); await new Promise(resolve => setImmediate(resolve));
    stderr.write('Recording started successfully\n'); let settled = false; pending.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    stderr.write(line + '\n'); assert.equal((await pending).variant, variant); stderr.end();
  }
});
test('real separate profiler child pipes use stderr alone for interactive start and flush ACKs', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-profiler-pipes-'));
  let child;
  try {
    const trace = path.join(directory, 'capture.qmltrace'), stdoutFile = path.join(directory, 'stdout.log'), stderrFile = path.join(directory, 'stderr.log');
    fs.writeFileSync(stdoutFile, ''); fs.writeFileSync(stderrFile, '');
    const program = `let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let edge;while((edge=buffer.indexOf('\\n'))>=0){const command=buffer.slice(0,edge);buffer=buffer.slice(edge+1);if(command==='r'){process.stdout.write('Recording started\\n');setTimeout(()=>process.stderr.write('> Recording started\\n'),40);}else if(command==='f'){const ack='Data written to '+process.argv[1]+'.\\n';process.stdout.write(ack);setTimeout(()=>process.stderr.write('> '+ack),40);}else if(command==='q'){process.exit(0);}}});`;
    child = spawn(process.execPath, ['-e', program, trace], { stdio: ['pipe', 'pipe', 'pipe'] });
    const identity = { pid: child.pid, uid: process.getuid(), birth: 'owned-synthetic-child', name: process.execPath };
    const running = { runRoot: directory, userData: directory, cycle: 'history-300-qml-profiler', child,
      rootIdentity: identity, owned: new Map([[child.pid, identity]]), identity: { profilerAttachmentMode: 'attach-only' },
      profilerLogPath: stderrFile, profilerTracePath: trace, profilerAckChannel: 'stderr', profilerAckStream: child.stderr };
    const api = { assertIsolation: () => {}, inspectProcesses: () => [identity], sameIdentity };
    running.profilerOutput = profilerAckReader(child.stderr, bytes => fs.appendFileSync(stderrFile, bytes), 'stderr');
    child.stdout.on('data', bytes => fs.appendFileSync(stdoutFile, bytes));
    const firstStdout = new Promise(resolve => child.stdout.once('data', resolve));
    const started = startProfilerRecording(running, api); let startSettled = false; started.then(() => { startSettled = true; });
    await firstStdout; await new Promise(resolve => setImmediate(resolve)); assert.equal(startSettled, false);
    assert.equal((await started).channel, 'stderr');
    const flushStdout = new Promise(resolve => child.stdout.once('data', resolve));
    const flushing = flushProfilerRecording(running, api); let flushSettled = false; flushing.then(() => { flushSettled = true; });
    await flushStdout; await new Promise(resolve => setImmediate(resolve)); assert.equal(flushSettled, false);
    assert.equal((await flushing).channel, 'stderr');
    await requestOwnedNormalExit(running, api); await childCompletion(child, 3000, 'synthetic profiler shutdown'); assert.equal(child.exitCode, 0);
    assert(fs.readFileSync(stdoutFile, 'utf8').includes('Data written')); assert(fs.readFileSync(stderrFile, 'utf8').includes('> Data written'));
    const { PassThrough } = require('node:stream'), wrong = normalExitFixture(), stdout = new PassThrough();
    wrong.running.child.stderr = new PassThrough(); wrong.running.profilerAckStream = stdout;
    wrong.running.profilerOutput = profilerStdoutReader(stdout, () => {});
    await assert.rejects(startProfilerRecording(wrong.running, wrong.api), /Owned stderr/); stdout.destroy(); wrong.running.child.stderr.destroy();
  } finally {
    if (child?.exitCode === null) { child.kill('SIGTERM'); await childCompletion(child, 2000, 'failed synthetic profiler peer'); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('case rejection drains profiler then current sample before app quit and final scene read', async () => {
  const profiler = { cycle: 'history-300-qml-profiler' }, sample = { cycle: 'history-300-cpu-stack-sampler' }, app = { cycle: 'history-300-app' }, order = [];
  let finishProfiler, finishSample;
  const stackDone = new Promise(resolve => { finishSample = resolve; });
  const pending = closeDiagnosticDependencies({ profiler, app, stackProcesses: [sample], stacks: {
    stop: () => { order.push('stop-stack-scheduling'); return stackDone; } } }, async running => {
    if (running === profiler) { order.push('profiler-flush'); await new Promise(resolve => { finishProfiler = resolve; }); order.push('profiler-q-and-exit'); }
    if (running === sample) order.push('sample-final-exit-check');
    if (running === app) order.push('app-quit-and-exit');
  });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['stop-stack-scheduling', 'profiler-flush']);
  finishProfiler(); await new Promise(resolve => setImmediate(resolve)); assert.equal(order.includes('app-quit-and-exit'), false);
  finishSample(); await pending; order.push('read-final-scene');
  assert.deepEqual(order, ['stop-stack-scheduling', 'profiler-flush', 'profiler-q-and-exit', 'sample-final-exit-check', 'app-quit-and-exit', 'read-final-scene']);
  assert.deepEqual(cleanupOrder([app, { cycle: 'history-300-model-server' }, sample, profiler]).map(x => x.cycle),
    [profiler.cycle, sample.cycle, app.cycle, 'history-300-model-server']);
});
test('observer cleanup failure remains failure and does not prevent bounded app cleanup', async () => {
  const order = [];
  await assert.rejects(closeDiagnosticDependencies({ profiler: { cycle: 'qml-profiler' }, app: { cycle: 'case-app' } }, async running => {
    order.push(running.cycle); if (running.cycle === 'qml-profiler') throw Error('flush failed');
  }), /cleanup failed/);
  assert.deepEqual(order, ['qml-profiler', 'case-app']);
});
test('actual profiler trace bounds enforce60s without treating a timer request as completed capture', () => {
  const report = { capture: {}, traceAttributes: { traceStart: '100', traceEnd: '60000000100' } };
  validateProfilerWindow(report); assert.equal(report.capture.actualTraceDurationNs, '60000000000');
  assert.throws(() => validateProfilerWindow({ capture: {}, traceAttributes: { traceStart: '100', traceEnd: '60000000101' } }), /60-second/);
  assert.throws(() => validateProfilerWindow({ capture: {}, traceAttributes: {} }), /Unknown/);
});
function tailStackFixture() {
  const { EventEmitter } = require('node:events'), f = normalExitFixture();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-tail-stack-unit-'));
  const receiptNs = 100000000000n; let clock = receiptNs, due, cancelled = 0, child, output;
  const commands = [], identities = new Map([[f.running.child.pid, f.running.rootIdentity]]);
  const api = { ...f.api, inspectProcesses: (_root, pids) => pids.map(pid => identities.get(pid)),
    remainingProcesses: running => running.child?.exitCode === null ? [running.rootIdentity] : [] };
  const services = { nowNs: () => clock,
    cpuStackPlan: { mode: 'tail-once', phaseStarted: { type: 'phase-started', absoluteNs: '90000000000' },
      startedReceipt: { receivedNodeNs: String(receiptNs), receivedUnixMs: 100, clock: 'node-hrtime' } },
    stackDelay: ms => { assert.equal(ms, 28000); let resolve; const completion = new Promise(done => { resolve = done; });
      due = () => { clock = receiptNs + 28000000000n; resolve(true); };
      return { completion, cancel: () => { ++cancelled; resolve(false); } }; },
    spawn: (executable, argv) => {
      commands.push({ executable, argv }); output = argv.at(-1);
      child = new EventEmitter(); child.pid = 500 + commands.length; child.exitCode = null; child.signalCode = null;
      identities.set(child.pid, { ...f.running.rootIdentity, pid: child.pid, name: '/usr/bin/sample' }); return child;
    },
    track: sample => ({ ...f.running, child: sample, rootIdentity: identities.get(sample.pid), owned: new Map([[sample.pid, identities.get(sample.pid)]]) }),
    register: async () => assert(child.listenerCount('close') >= 2),
    waitChunkExit: async () => { clock += 5000000000n; fs.writeFileSync(output, 'synthetic bounded sample');
      child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); } };
  return { f, services, api, directory, commands, due: () => due(), cancelled: () => cancelled,
    get child() { return child; }, get output() { return output; },
    advance: ns => { clock += ns; }, cleanup: () => { child?.emit('close'); fs.rmSync(directory, { recursive: true, force: true }); } };
}
test('tail-once cancels the pending plan without launching an early fallback sample', async () => {
  const fixture = tailStackFixture();
  try {
    const session = cpuStackSession(fixture.f.running, '/registered/history-300', fixture.directory, fixture.services, fixture.api);
    assert.equal(fixture.commands.length, 0);
    const report = await session.stop();
    assert.equal(fixture.cancelled(), 1); assert.equal(fixture.commands.length, 0);
    assert.equal(report.status, 'not-executed'); assert.equal(report.requestedSampleSeconds, 0);
    assert.equal(report.sampleProcessesExitedAndClosed, true); assert.match(report.notExecutedReason, /before the scheduled launch/);
  } finally { fixture.cleanup(); }
});
test('tail-once launches exactly one fixed five-second sample and records host receipt, launch and real exit', async () => {
  const fixture = tailStackFixture();
  const complete = fixture.services.waitChunkExit;
  fixture.services.waitChunkExit = async (...args) => { await complete(...args); fixture.advance(1000000000n); };
  try {
    const session = cpuStackSession(fixture.f.running, '/registered/history-300', fixture.directory, fixture.services, fixture.api);
    fixture.due(); const report = await session.completion; await session.stop();
    assert.equal(fixture.commands.length, 1); assert.equal(fixture.commands[0].executable, '/usr/bin/sample');
    assert.deepEqual(fixture.commands[0].argv.slice(0, 5), ['123', '5', '5', '-mayDie', '-file']);
    assert.equal(report.requestedSampleSeconds, 5); assert.equal(report.maximumLaunches, 1);
    assert.deepEqual(report.plan.plannedIntervalAfterReceiptMs, [28000, 33000]);
    assert.equal(report.windows[0].actualDelaySincePhaseStartedReceiptMs, 28000);
    assert.equal(report.windows[0].exitObservedNodeNs, '133000000000');
    assert.equal(report.windows[0].waitCompletedNodeNs, '134000000000');
    assert.equal(report.windows[0].stdioClosedNodeNs, '133000000000'); assert.equal(report.windows[0].observedExitCode, 0);
    assert.equal(report.status, 'completed'); assert.equal(report.coverage, 'unknown');
    assert.equal(report.windows[0].targetIdentityVerifiedBefore, true); assert.equal(report.windows[0].targetIdentityVerifiedAfter, true);
  } finally { fixture.cleanup(); }
});
test('tail-once timeout stays unavailable and retains the exit plus stdio-close barrier without retry', async () => {
  const fixture = tailStackFixture();
  fixture.services.waitChunkExit = async () => { throw Error('synthetic tail sample timeout'); };
  try {
    const session = cpuStackSession(fixture.f.running, '/registered/history-300', fixture.directory, fixture.services, fixture.api);
    fixture.due(); assert.equal((await session.completion).status, 'unavailable');
    fs.writeFileSync(fixture.output, 'late output cannot repair the failed observation');
    let settled = false; const stopped = session.stop().then(report => { settled = true; return report; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    fixture.advance(5000000000n); fixture.child.exitCode = 0; fixture.child.emit('exit', 0, null);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    fixture.child.emit('close', 0, null); const report = await stopped;
    assert.equal(report.status, 'unavailable'); assert.equal(report.windows[0].status, 'unavailable');
    assert.equal(report.windows[0].sha256, undefined); assert.equal(report.sampleProcessesExitedAndClosed, true);
    assert.equal(fixture.commands.length, 1); assert.equal(report.windows[0].exitObservedNodeNs, '133000000000');
  } finally { fixture.cleanup(); }
});
test('legacy stack mode still launches successive chunks without the tail delay', async () => {
  const fixture = tailStackFixture(); delete fixture.services.cpuStackPlan;
  fixture.services.stackDelay = () => { throw Error('Legacy mode must not delay'); };
  const complete = fixture.services.waitChunkExit;
  fixture.services.waitChunkExit = async (...args) => { await complete(...args); if (fixture.commands.length === 2) fixture.advance(60000000000n); };
  try {
    const session = cpuStackSession(fixture.f.running, '/registered/history-300', fixture.directory, fixture.services, fixture.api);
    const report = await session.completion; await session.stop();
    assert.equal(fixture.commands.length, 2); assert.equal(report.requestedSampleSeconds, 10);
    assert.equal(report.maximumLaunches, undefined); assert.equal(report.plan, undefined); assert.equal(report.status, 'completed');
  } finally { fixture.cleanup(); }
});
test('optional stack permission failure stops one session without retry or a privileged fallback', async () => {
  const { EventEmitter } = require('node:events'), f = normalExitFixture();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-stack-unit-')); let spawned = 0;
  try {
    const services = { spawn: (executable, argv, options) => {
      ++spawned; assert.equal(executable, '/usr/bin/sample'); assert.equal(argv[0], String(f.running.child.pid)); assert.equal(argv[1], '5');
      assert.equal(argv.includes('-e'), false); assert.equal(argv.includes('-wait'), false);
      fs.writeSync(options.stdio[2], 'Operation not permitted\n');
      const child = new EventEmitter(); child.exitCode = 1; child.signalCode = null; setImmediate(() => child.emit('close')); return child;
    }, track: child => ({ child }), register: async () => {} };
    const api = { ...f.api, remainingProcesses: () => [] };
    const session = cpuStackSession(f.running, '/registered/history-300', directory, services, api);
    const report = await session.completion; assert.equal(report.status, 'permission-unavailable'); assert.equal(spawned, 1);
    assert.equal(report.coverage, 'unknown'); assert.equal(report.windows[0].targetIdentityVerifiedAfter, true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('timed-out sample report cannot release phase-flushed before real exit and stdio close', async () => {
  const { EventEmitter } = require('node:events'), f = diagnosticControlFixture();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-stack-close-unit-'));
  const child = new EventEmitter(); child.pid = 555; child.exitCode = null; child.signalCode = null;
  const sampleIdentity = { ...f.running.rootIdentity, pid: 555, name: '/usr/bin/sample' }; let running, output;
  const api = { ...f.api, inspectProcesses: (_root, pids) => pids[0] === 555 ? [sampleIdentity] : [f.running.rootIdentity],
    remainingProcesses: () => child.exitCode === null ? [sampleIdentity] : [] };
  const services = { spawn: (_exe, argv) => { output = argv.at(-1); return child; },
    track: () => (running = { ...f.running, child, rootIdentity: sampleIdentity, owned: new Map([[555, sampleIdentity]]) }),
    register: async () => assert(child.listenerCount('close') >= 2, 'Close tracking must precede registration'),
    waitChunkExit: async () => { throw Error('synthetic chunk timeout'); } };
  try {
    const session = cpuStackSession(f.running, '/registered/history-300', directory, services, api);
    assert.equal((await session.completion).status, 'unavailable');
    fs.writeFileSync(output, 'late output must not convert unavailable to captured');
    const target = runDiagnosticTarget(f.running, f.options, { startStacks: () => session, wait: async () => {} });
    f.emit('phase-ready'); await new Promise(resolve => setImmediate(resolve)); f.emit('phase-started'); f.emit('target-phase-done');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.writes.length, 1);
    child.exitCode = 0; child.emit('exit', 0, null); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.writes.length, 1, 'Exit alone must not acknowledge closed observer');
    child.emit('close', 0, null); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.writes[1].type, 'phase-flushed');
    f.emit('phase-ended'); await target;
    assert.equal(session.report.sampleProcessesExitedAndClosed, true); assert.equal(session.report.status, 'unavailable');
    assert.equal(session.report.windows[0].status, 'unavailable'); assert.equal(session.report.windows[0].sha256, undefined);
  } finally { child.emit('close'); f.stream.destroy(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('sample barrier rejects natural-exit timeout, identity mismatch and remaining owned children', async () => {
  const { EventEmitter } = require('node:events'), f = normalExitFixture();
  const make = () => {
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.pid = f.running.child.pid;
    const running = { ...f.running, child }, lifecycle = sampleCloseTracker(child); return { child, item: { running, lifecycle } };
  };
  let fixture = make(); const good = { ...f.api, remainingProcesses: () => [] };
  await assert.rejects(settleSampleChildren([fixture.item], good, { waitExit: async () => { throw Error('bounded natural timeout'); } }), /natural timeout/);
  fixture = make(); const changed = { ...good, inspectProcesses: () => [{ ...f.running.rootIdentity, birth: 'changed' }] };
  const finish = async child => { child.exitCode = 0; child.emit('close'); };
  await assert.rejects(settleSampleChildren([fixture.item], changed, { waitExit: finish }), /identity changed/);
  fixture = make(); await assert.rejects(settleSampleChildren([fixture.item], { ...good, remainingProcesses: () => [{ pid: 999 }] }, { waitExit: finish }), /children remain/);
  fixture = make(); let clock = 0n, closeAllowance;
  await settleSampleChildren([fixture.item], good, { nowNs: () => clock,
    waitExit: async child => { clock = 14000000000n; child.exitCode = 0; },
    waitClose: async (_lifecycle, allowance) => { closeAllowance = allowance; fixture.child.emit('close'); } });
  assert.equal(closeAllowance, 1000, 'Exit and stdio close share one15s allowance, not15s each');
  await settleSampleChildren([], good); // No observer children is already closed.
});
test('attach-only console profiler flushes and quits through its owned stdin without a GUI action', async () => {
  const { running, calls, api } = normalExitFixture();
  assert.equal((await requestOwnedNormalExit(running, api)).actionSucceeded, true);
  await requestOwnedNormalExit(running, api);
  assert.deepEqual(calls.filter(call => call[0] === 'stdin'), [['stdin', 'f\n'], ['stdin', 'q\n']]);
  assert.equal(calls.filter(call => call[0] === 'gui').length, 0);
  assert.equal(calls.filter(call => call[0] === 'ipc').length, 0);
});
test('quit is withheld until the previous flush command is acknowledged', async () => {
  const { running, calls, api } = normalExitFixture();
  let acknowledge;
  api.waitForProfilerFlush = () => new Promise(resolve => { acknowledge = resolve; });
  const stopping = requestOwnedNormalExit(running, api);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call[0] === 'stdin'), [['stdin', 'f\n']]);
  acknowledge({ flushAcknowledgedUnixMs: 123 });
  await stopping;
  assert.deepEqual(calls.filter(call => call[0] === 'stdin'), [['stdin', 'f\n'], ['stdin', 'q\n']]);
});
test('a prior bounded trace flush is reused at exit without rewriting its file', async () => {
  const { running, calls, api } = normalExitFixture();
  await flushProfilerRecording(running, api);
  await requestOwnedNormalExit(running, api);
  assert.deepEqual(calls.filter(call => call[0] === 'stdin'), [['stdin', 'f\n'], ['stdin', 'q\n']]);
  assert.equal(calls.filter(call => call[0] === 'flush-ack').length, 1);
});
test('flush acknowledgement must name this exact trace and reject a failed save', async () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-profiler-ack-'));
  try {
    const running = { profilerLogPath: path.join(directory, 'profiler.log'), profilerTracePath: path.join(directory, 'capture.qmltrace'),
      child: { exitCode: null, signalCode: null } };
    fs.writeFileSync(running.profilerLogPath, `Data written to ${running.profilerTracePath}.\n> `);
    assert((await waitForProfilerFlush(running)).acknowledgement.includes(running.profilerTracePath));
    fs.writeFileSync(running.profilerLogPath, 'Saving failed.\n> ');
    await assert.rejects(waitForProfilerFlush(running), /did not acknowledge/);
    fs.writeFileSync(running.profilerLogPath, 'Data written to /another/trace.qmltrace.\n> '); running.child.exitCode = 0;
    await assert.rejects(waitForProfilerFlush(running), /exited before/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('identity is checked again after flush acknowledgement before the separate quit command', async () => {
  const { running, calls, api } = normalExitFixture();
  api.waitForProfilerFlush = async () => {
    api.inspectProcesses = () => [{ ...running.rootIdentity, birth: 'changed-after-flush' }];
    return { flushAcknowledgedUnixMs: 123 };
  };
  await assert.rejects(requestOwnedNormalExit(running, api), /identity changed/);
  assert.deepEqual(calls.filter(call => call[0] === 'stdin'), [['stdin', 'f\n']]);
});
test('model and Qt app normal exits select their own IPC and GUI branches', async () => {
  const { running, calls, api } = normalExitFixture();
  running.cycle = 'history-300-model-server';
  await requestOwnedNormalExit(running, api);
  running.cycle = 'history-300-app';
  running.identity = { appRoot: '/owned/Scene.app', appId: 'com.muhe.reverie.qt.local' };
  await requestOwnedNormalExit(running, api);
  assert.deepEqual(calls.filter(call => call[0] === 'ipc'), [['ipc', { type: 'shutdown' }]]);
  assert.deepEqual(calls.filter(call => call[0] === 'gui'), [['gui', 'quit']]);
  assert.equal(calls.filter(call => call[0] === 'stdin').length, 0);
});
test('changed or unowned profiler identity is refused before any stdin or GUI action', async () => {
  const { running, calls, api } = normalExitFixture();
  api.inspectProcesses = () => [{ ...running.rootIdentity, birth: 'recycled' }];
  await assert.rejects(requestOwnedNormalExit(running, api), /identity changed/);
  running.owned.clear();
  await assert.rejects(requestOwnedNormalExit(running, api), /Unowned console process/);
  assert.equal(calls.filter(call => ['stdin', 'gui', 'ipc'].includes(call[0])).length, 0);
});
test('profiler flush/quit is refused without attach-only mode or an owned writable stdin', async () => {
  const { running, calls, api } = normalExitFixture();
  running.identity.profilerAttachmentMode = 'launch';
  await assert.rejects(requestOwnedNormalExit(running, api), /attach-only launch contract/);
  running.identity.profilerAttachmentMode = 'attach-only'; running.child.stdin.destroyed = true;
  await assert.rejects(requestOwnedNormalExit(running, api), /stdin is unavailable/);
  assert.equal(calls.filter(call => ['stdin', 'gui', 'ipc'].includes(call[0])).length, 0);
});
test('failed profiler stdin write is retained as failure and never retried as a successful exit request', async () => {
  const { running, calls, api } = normalExitFixture();
  running.child.stdin.write = (command, done) => { calls.push(['stdin', command]); done(Error('broken owned pipe')); };
  await assert.rejects(requestOwnedNormalExit(running, api), /broken owned pipe/);
  await assert.rejects(requestOwnedNormalExit(running, api), /broken owned pipe/);
  assert.equal(calls.filter(call => call[0] === 'stdin').length, 1);
});
test('synthetic provider uses only the latest user marker and deterministic responses', () => {
  assert.equal(classify({ messages: [{ role: 'user', content: '性能长回复' }, { role: 'user', content: '性能短回复' }] }).content, SHORT_TEXT);
  assert.equal(classify({ messages: [{ role: 'user', content: '性能延迟回复' }] }).delayMs, 2500);
  assert.equal(classify({ messages: [{ role: 'assistant', content: '性能延迟回复' }] }).kind, 'probe');
  assert.equal(LONG_TEXT.split('\n\n').length, 12); assert(LONG_TEXT.length >= 1500);
  assert.equal(classify({ messages: [{ role: 'user', content: '性能延迟回复' }] }).content, LONG_TEXT);
});
test('supplemental mock keeps an eight-second delay and fixed tiny/full texts without changing stress defaults', () => {
  const protocol = 'companion-transactions-v1';
  assert.equal(classify({ messages: [{ role: 'user', content: '性能短回复' }] }, protocol).content, COMPANION_SHORT_TEXT);
  assert(COMPANION_SHORT_TEXT.includes('嗯嗯')); assert(Array.from(COMPANION_SHORT_TEXT).length <= 20);
  assert(COMPANION_LONG_TEXT.includes('嗯嗯')); assert(COMPANION_LONG_TEXT.length >= 1500);
  assert.equal(classify({ messages: [{ role: 'user', content: '性能长回复，请认真给我完整说明' }] }, protocol).content, COMPANION_LONG_TEXT);
  const delayed = classify({ messages: [{ role: 'user', content: '性能延迟回复，请认真给我完整说明' }] }, protocol);
  assert.equal(delayed.delayMs, 8000); assert.equal(delayed.content, COMPANION_LONG_TEXT);
  assert.equal(classify({ messages: [{ role: 'user', content: '性能延迟回复' }] }).delayMs, 2500);
  assert.equal(classify({ messages: [{ role: 'assistant', content: '性能延迟回复' }] }, protocol).kind, 'probe');
  assert.throws(() => classify({ messages: [] }, 'unknown'));
  assert.throws(() => createModelServer({ protocol: 'unknown' }));
  assert.throws(() => createModelServer({ delayOverride: -1 }));
});
test('owned mock CLI refuses delay/content overrides and policies have reproducible response identities', () => {
  assert.deepEqual(modelServerArguments([]), { protocol: 'stress-v1' });
  assert.deepEqual(modelServerArguments(['--protocol', 'companion-transactions-v1']), { protocol: 'companion-transactions-v1' });
  for (const args of [ ['--protocol'], ['--protocol', 'unknown'], ['--delay', '0'],
    ['--protocol', 'stress-v1', '--protocol', 'stress-v1'] ]) assert.throws(() => modelServerArguments(args));
  const crypto = require('node:crypto'), hash = content => crypto.createHash('sha256').update(content).digest('hex');
  const stress = modelPolicyRecord(), supplemental = modelPolicyRecord('companion-transactions-v1');
  assert.equal(stress.sha256, hash(JSON.stringify(stress.policy)));
  assert.equal(supplemental.sha256, hash(JSON.stringify(supplemental.policy)));
  assert.deepEqual(modelPolicyRecord('companion-transactions-v1'), supplemental); assert.notEqual(stress.sha256, supplemental.sha256);
  assert.equal(stress.policy.responses.long.contentSha256, hash(LONG_TEXT));
  assert.equal(supplemental.policy.responses.long.contentSha256, hash(COMPANION_LONG_TEXT));
  assert.equal(supplemental.policy.responses.delayed.delayMs, 8000);
  assert.equal(stress.policy.responses.delayed.delayMs, 2500);
});
function protocolWorkload(protocol) {
  const policy = modelPolicyRecord(protocol), spec = policy.policy.responses.long;
  return { protocol, mockPolicySha256: policy.sha256,
    scene: { protocol, schema: protocol === 'stress-v1' ? 'reverie.qt.performance-scenarios.v1' : 'reverie.qt.companion-transactions.v1', performanceComparable: true },
    calls: [{ kind: 'long', protocol, mockPolicySha256: policy.sha256, delayMs: spec.delayMs, effectiveDelayMs: spec.delayMs, contentSha256: spec.contentSha256 }],
    completed: [{ protocol, mockPolicySha256: policy.sha256 }] };
}
test('provider, native scene and top comparability cannot mix protocols or mock policies', () => {
  const options = { protocol: 'companion-transactions-v1', mode: 'perf' }, policy = modelPolicyRecord(options.protocol);
  validateProviderReady(options, { protocol: options.protocol, mockPolicySha256: policy.sha256 });
  assert.throws(() => validateProviderReady(options, { protocol: 'stress-v1', mockPolicySha256: policy.sha256 }));
  assert.throws(() => validateProviderReady(options, { protocol: options.protocol, mockPolicySha256: 'changed' }));
  validateWorkloadProtocol(options, protocolWorkload(options.protocol));
  for (const change of [w => w.protocol = 'stress-v1', w => w.scene.protocol = 'stress-v1',
    w => w.scene.schema = 'reverie.qt.performance-scenarios.v1', w => w.mockPolicySha256 = 'changed',
    w => w.calls[0].protocol = 'stress-v1', w => w.calls[0].mockPolicySha256 = 'changed',
    w => w.calls[0].contentSha256 = 'changed', w => w.calls[0].effectiveDelayMs = 1,
    w => w.completed[0].protocol = 'stress-v1']) {
    const workload = protocolWorkload(options.protocol); change(workload); assert.throws(() => validateWorkloadProtocol(options, workload));
  }
  assert.equal(workloadsComparable(options, [protocolWorkload(options.protocol)]), true);
  assert.equal(workloadsComparable(options, [protocolWorkload(options.protocol), protocolWorkload('stress-v1')]), false);
  assert.equal(workloadsComparable(options, []), false);
  assert.equal(workloadsComparable({ ...options, mode: 'diagnostic' }, [protocolWorkload(options.protocol)]), false);
  assert.equal(workloadsComparable({ protocol: 'stress-v1', mode: 'perf' }, [protocolWorkload('stress-v1')]), true);
});
function request(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url }, res => {
      const buffers = []; res.on('data', b => buffers.push(b)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(buffers).toString() }));
    }); req.once('error', reject); req.end(body);
  });
}
test('model server validates route/body and emits bounded metadata without message content', async () => {
  const calls = [], completed = [];
  const server = createModelServer({ onCall: call => calls.push(call), onComplete: call => completed.push(call), delayOverride: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await request(port, 'GET', '/v1/chat/completions')).status, 404);
    assert.equal((await request(port, 'POST', '/v1/chat/completions', '{')).status, 400);
    assert.equal((await request(port, 'POST', '/v1/chat/completions', JSON.stringify({}))).status, 400);
    const response = await request(port, 'POST', '/v1/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: '性能短回复' }] }));
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).choices[0].message.content, SHORT_TEXT);
    assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'short');
    assert.equal(Object.hasOwn(calls[0], 'content'), false); assert.equal(completed[0].aborted, false);
  } finally { server.dispose(); await new Promise(resolve => server.close(resolve)); }
});
test('supplemental server returns its registered text and reports declared/overridden test delay separately', async () => {
  const protocol = 'companion-transactions-v1', calls = [], completed = [], policy = modelPolicyRecord(protocol);
  const server = createModelServer({ protocol, onCall: call => calls.push(call), onComplete: call => completed.push(call), delayOverride: 1 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await request(server.address().port, 'POST', '/v1/chat/completions', JSON.stringify({ messages:
      [{ role: 'user', content: '性能延迟回复，请认真给我完整说明' }] }));
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).choices[0].message.content, COMPANION_LONG_TEXT);
    assert.equal(calls[0].delayMs, 8000); assert.equal(calls[0].effectiveDelayMs, 1);
    assert.equal(calls[0].protocol, protocol); assert.equal(calls[0].mockPolicySha256, policy.sha256);
    assert.equal(calls[0].contentSha256, policy.policy.responses.long.contentSha256);
    assert.equal(Object.hasOwn(calls[0], 'content'), false); assert.equal(completed[0].protocol, protocol);
    assert.equal(completed[0].aborted, false);
  } finally { server.dispose(); await new Promise(resolve => server.close(resolve)); }
});
test('owned IPC model child binds only loopback and exits normally on shutdown', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'perf-model-server.cjs')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('model child readiness timeout')), 3000);
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timeout); resolve(message); } });
    child.once('error', reject);
  });
  assert.equal(ready.pid, child.pid); assert.equal(ready.address, '127.0.0.1'); assert(ready.pid !== process.pid);
  assert.equal(ready.protocol, 'stress-v1'); assert.equal(ready.mockPolicySha256, modelPolicyRecord().sha256);
  const response = await request(ready.port, 'POST', '/v1/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: '性能短回复' }] }));
  assert.equal(response.status, 200);
  await new Promise((resolve, reject) => child.send({ type: 'shutdown' }, error => error ? reject(error) : resolve()));
  await childCompletion(child, 3000, 'owned model shutdown');
  assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
});
test('resource summaries separate births and roles and derive one-core CPU percent', () => {
  const identity = { pid: 123, ppid: 1, uid: 501, birth: 'a', name: '/owned' };
  const sample = (unixMs, cpuNs, birth = 'a', role = 'qt-app') => ({ role, identity: { ...identity, birth }, unixMs,
    userCpuNs: cpuNs, systemCpuNs: 0, residentBytes: 1000 + unixMs, physicalFootprintBytes: 2000, threads: 4 });
  const result = summarizeResources([sample(1000, 0), sample(2000, 500000000), sample(3000, 1000000000),
    sample(4000, 200, 'b'), sample(5000, 400, 'c', 'mock-model')], [{ name: 'read', startUnixMs: 1000, endUnixMs: 2000 }]);
  assert.equal(result.length, 3); assert.equal(result[0].cpuPercent, 50); assert.equal(result[0].cpuMs, 1000);
  assert.equal(result[0].phases[0].cpuPercent, 50); assert.equal(result[0].maximumResidentBytes, 4000);
  assert.equal(result[1].cpuPercent, null); assert.equal(result[2].role, 'mock-model');
});
test('isolated config suppresses unrelated autonomous and audio work', () => {
  const config = fixtureConfig('http://127.0.0.1:12345/v1');
  assert.equal(config.tts.enabled, false); assert.equal(config.features.proactive_chat_enabled, false);
  assert.equal(config.ui.onboarding_state, 'complete'); assert.equal(config.cloud_mode, 'local');
  assert.equal(config.chat.reply_delay_min, 1); assert.equal(config.chat.reply_delay_max, 1);
  assert.equal(config.chat.split_messages, false); assert.equal(config.llm.model, 'reverie-perf-test');
});
test('child completion observes an already exited owned child without PID rediscovery', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await childCompletion(child, 1000, 'unit helper');
  await childCompletion(child, 1000, 'completed unit helper'); assert.equal(child.exitCode, 0);
});
