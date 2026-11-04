'use strict';
// W4 owns only a new local run, its disposable fixture and its child processes.
// This module deliberately does not call the performance harness main/validators.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { spawn } = require('node:child_process');
const guard = require('../frontend/script/acceptance-isolation.cjs');
const { verifyBuild, digest, directoryInventory, fileHash } = require('./build-record.cjs');
const { cleanupExitedSuccessfully } = require('./cleanup-exit.cjs');
const { processTreeSnapshot } = require('./perf-sampling.cjs');
const { fixtureConfig, safeEnvironment, childCompletion, requestOwnedNormalExit } = require('./check-performance.cjs');
const { modelPolicyRecord } = require('./perf-model-server.cjs');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE = 'preview-header-frame-20261102';
const VARIANTS = Object.freeze(['baseline', 'reduced-transparency', 'half-resolution', 'drawer-background-off',
  'blur-half-resolution', 'gpu-positive-control']);
const SCREENSHOT_VARIANTS = Object.freeze(['baseline', 'half-resolution', 'blur-half-resolution']);
const ENV_PREFIX = 'REVERIE_HEADER_FRAME_';
const SCENE_SCHEMA = 'reverie.qt.header-frame-local.v2';
const CONTROL_SCHEMA = 'reverie.qt.header-frame-positive-control.v1';
const SUMMARY_SCHEMA = 'reverie.qt.header-frame-local-run.v2';
const CONTEXT_SCHEMA = 'reverie.qt.header-frame-local-context.v2';
const USAGE = 'Local diagnostic only: --package preview-header-frame-20261102 --variant baseline|reduced-transparency|half-resolution|drawer-background-off|blur-half-resolution|gpu-positive-control --size wide --screenshot none|memory-open --output-dir ABS_CURRENT_LOCAL_RUN';

function parseArguments(args) {
  const values = {}, allowed = new Map([['--package', 'package'], ['--variant', 'variant'],
    ['--size', 'windowSize'], ['--screenshot', 'screenshot'], ['--output-dir', 'outputDirectory']]);
  for (let index = 0; index < args.length; index += 2) {
    const key = allowed.get(args[index]), value = args[index + 1];
    assert(key && !Object.hasOwn(values, key) && typeof value === 'string' && value && !value.startsWith('--'), USAGE);
    values[key] = value;
  }
  assert.equal(values.package, PACKAGE, 'W4 local package required');
  assert(VARIANTS.includes(values.variant), 'W4 variant is not authorized');
  assert.equal(values.windowSize, 'wide', 'Only the wide W4 scene is implemented');
  assert(['none', 'memory-open'].includes(values.screenshot), 'Explicit W4 screenshot selection required');
  assert(values.screenshot === 'none' || SCREENSHOT_VARIANTS.includes(values.variant), 'W4 screenshot variant is not authorized');
  assert(typeof values.outputDirectory === 'string' && path.isAbsolute(values.outputDirectory)
    && path.resolve(values.outputDirectory) === values.outputDirectory, 'Current absolute local output directory required');
  return values;
}

function readOwnedBytes(filename, maximumBytes) {
  const before = fs.lstatSync(filename);
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.uid === process.getuid() && before.size <= maximumBytes,
    'Unsafe or oversized W4 control file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    assert(opened.dev === before.dev && opened.ino === before.ino, 'W4 control file identity changed');
    const payload = fs.readFileSync(fd);
    assert(payload.length <= maximumBytes, 'W4 control file grew past limit');
    return payload;
  } finally { fs.closeSync(fd); }
}

function readControlJson(filename, maximumBytes = 256 * 1024) {
  return JSON.parse(readOwnedBytes(filename, maximumBytes).toString('utf8'));
}

function localPaths(root, options) {
  const outputParent = path.join(root, '.tools/local', PACKAGE, 'runs');
  assert.equal(path.dirname(options.outputDirectory), outputParent, 'W4 output must belong to this local package');
  assert(/^\d{6}-[a-f0-9]{32}$/.test(path.basename(options.outputDirectory)), 'W4 output must be a current local run');
  return { buildDirectory: path.join(root, '.tools/qt-builds', `local-${PACKAGE}`),
    activeLocalPath: path.join(root, '.tools/registered-run/active-local.json') };
}

function validateLocalMetadata(root, options, marker, record, ownerPid = process.ppid) {
  assert(VARIANTS.includes(options.variant) && ['none', 'memory-open'].includes(options.screenshot)
    && (options.screenshot === 'none' || SCREENSHOT_VARIANTS.includes(options.variant)), 'W4 local scenario options invalid');
  const paths = localPaths(root, options);
  assert(marker && marker.schema === 'reverie.active-local-run.v1' && typeof marker.runId === 'string'
    && /^[a-f0-9]{32}$/.test(marker.runId) && marker.ownerPid === ownerPid
    && marker.metadata?.package === PACKAGE && marker.metadata?.outputDirectory === options.outputDirectory,
  'W4 requires the current parent-owned local run');
  assert(record && record.schema === 'reverie.qt.local-build.v2' && record.candidate === null && record.localIteration?.package === PACKAGE
    && record.localIteration.acceptanceEligible === false
    && record.diagnostics?.ordinaryLauncherAllowed === true && record.diagnostics.qmlProfilerEnabled === false
    && record.diagnostics.timingProbesEnabled === false
    && record.compilation?.cmakeDirectory === paths.buildDirectory, 'W4 requires this package local build');
  return { schema: CONTEXT_SCHEMA, kind: 'local', diagnostic: true, package: PACKAGE,
    variant: options.variant, screenshot: options.screenshot, windowSize: options.windowSize, outputDirectory: options.outputDirectory,
    ...paths, activeRunId: marker.runId };
}

function appEnvironment(options, w4, base = process.env) {
  assert(!Object.keys(base).some(key => key.startsWith(ENV_PREFIX)), 'Ambient W4 variables are forbidden');
  assert(w4.kind === 'local' && w4.diagnostic === true && w4.package === PACKAGE
    && w4.variant === options.variant && w4.windowSize === 'wide'
    && w4.screenshot === options.screenshot
    && w4.outputDirectory === options.outputDirectory, 'W4 environment context differs');
  const inherited = Object.fromEntries(['XDG_CACHE_HOME', 'HF_HOME', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE',
    'PYTHON_DOTENV_DISABLED', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE'].filter(key => base[key] != null)
    .map(key => [key, base[key]]));
  return { ...safeEnvironment(), ...inherited, REVERIE_HEADER_FRAME_LOCAL: '1',
    QSG_RHI_PROFILE: '1', REVERIE_HEADER_FRAME_VARIANT: options.variant, REVERIE_HEADER_FRAME_SIZE: 'wide',
    REVERIE_HEADER_FRAME_SCREENSHOT: options.screenshot,
    REVERIE_HEADER_FRAME_OUTPUT: options.outputDirectory, REVERIE_HEADER_FRAME_PACKAGE: PACKAGE };
}

function nativeArguments(root, data, contextPath, scenePath, endpoint, model) {
  const url = new URL(endpoint);
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024
    && url.pathname === '/v1' && !url.username && !url.password && !url.search && !url.hash,
  'Owned loopback endpoint required');
  return ['--project-root', root, '--data-dir', data, '--python', path.join(root, '.venv/bin/python'),
    '--context', contextPath, '--perf-report', scenePath, '--perf-rows', '9', '--perf-mode', 'perf',
    '--perf-protocol', 'stress-v1', '--test-model', model, '--test-endpoint', endpoint];
}

function validateScene(scene, options) {
  assert(scene && scene.schema === SCENE_SCHEMA && scene.scenario === 'drawer-cycles' && scene.acceptanceEligible === false
    && scene.performanceComparable === false && scene.completed === true,
  'W4 scene collection did not complete');
  assert.equal(scene.package, PACKAGE, 'W4 scene package changed');
  assert.equal(scene.variant, options.variant, 'W4 scene variant changed');
  assert.equal(scene.windowSize, 'wide', 'W4 scene size changed');
  assert(scene.windowWidth === 1380 && scene.windowHeight === 900, 'W4 actual viewport changed');
  assert(Array.isArray(scene.windows) && scene.windows.length === 40, 'Exactly forty W4 drawer windows required');
  for (const feature of ['memory', 'settings']) {
    const windows = scene.windows.filter(window => window.feature === feature);
    assert.equal(windows.length, 20, `Twenty ${feature} windows required`);
    const cycles = windows.map(window => window.cycle).sort((a, b) => a - b);
    assert(cycles.every((cycle, index) => cycle === index + 1), 'W4 cycles duplicated or missing');
    for (const window of windows) {
      const times = ['openClickNs', 'openCompleteNs', 'closeClickNs', 'closeCompleteNs'].map(key => window[key]);
      assert(times.every(value => Number.isSafeInteger(value) && value >= 0)
        && times.every((value, index) => index === 0 || value >= times[index - 1]), 'W4 window bounds are incomplete');
    }
  }
  return 40;
}

function inventoryUnchanged(entries, expected) {
  return isDeepStrictEqual(digest(entries), expected);
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * p;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function validatePositiveControl(scene, options) {
  assert(scene && scene.schema === CONTROL_SCHEMA && scene.scenario === 'gpu-positive-control'
    && scene.completed === true && scene.acceptanceEligible === false && scene.performanceComparable === false,
  'W4 positive-control collection is incomplete');
  assert(scene.package === PACKAGE && scene.variant === options.variant && options.variant === 'gpu-positive-control'
    && scene.windowSize === 'wide' && scene.windowWidth === 1380 && scene.windowHeight === 900,
  'W4 positive-control identity changed');
  const timing = scene.headerFrameTiming;
  assert(timing && timing.capabilityResolved === true && timing.queriesAvailable === true
    && timing.droppedFrames === 0 && (timing.glCallOverflow === 0 || timing.glCallOverflow === false),
  'W4 positive-control capability or bounded collection failed');
  assert(Array.isArray(timing.frames) && Array.isArray(timing.glCalls), 'W4 positive-control raw records required');
  const counterBits = timing.context?.counterBits;
  assert(Number.isSafeInteger(counterBits) && counterBits > 0 && counterBits <= 64,
    'W4 positive-control native counter width invalid');
  assert(timing.load?.enabled === true && timing.load.initialized === true && timing.load.fragmentIterations === 64
    && Number.isSafeInteger(timing.load.targetWidth) && timing.load.targetWidth > 0
    && Number.isSafeInteger(timing.load.targetHeight) && timing.load.targetHeight > 0
    && Array.isArray(timing.load.allowedDraws) && timing.load.allowedDraws.length === 4
    && timing.load.allowedDraws.every((value, index) => value === [0, 64, 128, 256][index]),
  'W4 positive-control artificial load capability missing');
  const initialization = timing.load.initialization;
  assert(initialization && initialization.vertexCompileStatus === 1 && initialization.fragmentCompileStatus === 1
    && initialization.programLinkStatus === 1 && initialization.logCapacityBytesEach === 1024
    && ['vertexLog', 'fragmentLog', 'programLog'].every(key => {
      const log = initialization[key];
      return log && log.outputWritten === true && Number.isSafeInteger(log.reportedLength) && log.reportedLength >= 0
        && Number.isSafeInteger(log.writtenLength) && log.writtenLength >= 0 && log.writtenLength < 1024
        && typeof log.text === 'string' && Buffer.byteLength(log.text, 'utf8') <= 1023 && typeof log.truncated === 'boolean';
    }), 'W4 positive-control shader initialization evidence invalid');
  const functions = timing.functions;
  assert(functions && /^glBeginQuery(?:ARB|EXT)?$/.test(functions.queryBegin)
    && /^glEndQuery(?:ARB|EXT)?$/.test(functions.queryEnd)
    && /^glGetQueryObjectuiv(?:ARB|EXT)?$/.test(functions.queryAvailable)
    && functions.queryDuration === 'glGetQueryObjectui64vEXT', 'W4 positive-control GL function mapping invalid');
  const callIds = new Set();
  for (const call of timing.glCalls) {
    assert(!['glFinish', 'glFlush', 'glWaitSync', 'glClientWaitSync'].includes(call.function),
      'W4 positive-control forced GPU synchronization forbidden');
    assert(Number.isSafeInteger(call.callId) && call.callId > 0 && !callIds.has(call.callId)
      && typeof call.function === 'string' && (call.function.startsWith('gl')
        || ['QQuickWindow::beginExternalCommands', 'QQuickWindow::endExternalCommands'].includes(call.function))
      && Number.isSafeInteger(call.atNs) && call.atNs >= 0
      && call.preexisting === false && Array.isArray(call.errors) && call.errors.length === 0
      && (call.errorsOverflow === false || call.errorsOverflow === 0), 'W4 positive-control GL call error or missing evidence');
    callIds.add(call.callId);
  }
  if (timing.auxiliaryRhi?.samples) assert(timing.auxiliaryRhi.samples.every(sample => sample.sourceFrameId === null),
    'W4 Qt GPU observation must not claim a source frame');
  const frames = new Map();
  for (const frame of timing.frames) {
    assert(Number.isSafeInteger(frame.frameId) && frame.frameId > 0 && !frames.has(frame.frameId),
      'W4 positive-control frame identity invalid');
    frames.set(frame.frameId, frame);
  }
  assert(Array.isArray(scene.levels) && scene.levels.length === 4, 'W4 positive-control four levels required');
  const draws = [0, 64, 128, 256], used = new Set(), statistics = [];
  for (let index = 0; index < draws.length; ++index) {
    const level = scene.levels[index], expectedDraws = draws[index];
    assert(level.draws === expectedDraws && Number.isSafeInteger(level.requestNs) && level.requestNs >= 0
      && Number.isSafeInteger(level.endNs) && level.endNs > level.requestNs,
    'W4 positive-control level bounds or load changed');
    assert(Array.isArray(level.warmupFrameIds) && level.warmupFrameIds.length === 8
      && Array.isArray(level.measuredFrameIds) && level.measuredFrameIds.length === 24
      && Array.isArray(level.samples) && level.samples.length === 24,
    'W4 positive-control needs eight warmup and twenty-four measured frames');
    const selected = [...level.warmupFrameIds, ...level.measuredFrameIds];
    for (const frameId of selected) {
      const frame = frames.get(frameId);
      assert(frame && !used.has(frameId) && frame.loadInitializedAtFrameStart === true
        && frame.loadDraws === expectedDraws && frame.actualLoadDraws === expectedDraws
        && frame.frameBeginNs >= level.requestNs && frame.frameBeginNs <= level.endNs,
      'W4 positive-control raw load draws or frame allocation changed');
      assert(timing.glCalls.filter(call => call.frameId === frameId && call.phase === 'load'
        && call.function === 'glDrawArrays').length === frame.actualLoadDraws,
      'W4 positive-control draw calls differ from raw GL records');
      used.add(frameId);
    }
    assert(level.warmupActualDrawCalls === 8 * expectedDraws && level.measuredActualDrawCalls === 24 * expectedDraws,
      'W4 positive-control selected draw totals changed');
    const executed = timing.frames.filter(frame => frame.frameBeginNs >= level.requestNs && frame.frameBeginNs <= level.endNs
      && frame.loadDraws === expectedDraws && frame.loadInitializedAtFrameStart === true);
    assert(executed.every(frame => frame.actualLoadDraws === expectedDraws
      && timing.glCalls.filter(call => call.frameId === frame.frameId && call.phase === 'load'
        && call.function === 'glDrawArrays').length === frame.actualLoadDraws)
      && level.executedFrameCount === executed.length
      && level.actualDrawCalls === executed.reduce((total, frame) => total + frame.actualLoadDraws, 0),
    'W4 positive-control executed draw total differs from raw frames');
    const durations = [];
    for (let sampleIndex = 0; sampleIndex < 24; ++sampleIndex) {
      const frameId = level.measuredFrameIds[sampleIndex], frame = frames.get(frameId), sample = level.samples[sampleIndex];
      assert(frame.status === 'ready' && frame.valid === true && frame.queryStarted === true && frame.queryEnded === true
        && frame.sameContext === true && Number.isSafeInteger(frame.startContextGeneration) && frame.startContextGeneration > 0
        && frame.startContextGeneration === frame.endContextGeneration && Number.isSafeInteger(frame.queryObject) && frame.queryObject > 0
        && ['beforeFrameBegin', 'beforeSynchronizing'].includes(frame.queryStartStage) && frame.queryEndStage === 'afterFrameEnd',
      'W4 positive-control query scope or context invalid');
      assert(frame.availableSentinel === '4294967295' && frame.durationSentinel === '18446744073709551615'
        && frame.availableOutputWritten === true && frame.durationOutputWritten === true && frame.availableValue === 1
        && typeof frame.durationRawValue === 'string' && /^\d+$/.test(frame.durationRawValue)
        && frame.durationRawValue !== frame.durationSentinel && Number.isSafeInteger(frame.gpuDurationNs) && frame.gpuDurationNs >= 0
        && BigInt(frame.durationRawValue) === BigInt(frame.gpuDurationNs), 'W4 positive-control GPU output missing or sentinel retained');
      assert(frame.durationWithinCounterBits === true && BigInt(frame.durationRawValue) < (1n << BigInt(counterBits)),
        'W4 positive-control duration exceeds native counter width');
      assert(Number.isSafeInteger(frame.frameBeginNs) && Number.isSafeInteger(frame.frameEndNs)
        && frame.frameEndNs >= frame.frameBeginNs && Number.isSafeInteger(frame.resultAvailableNs)
        && frame.resultAvailableNs >= frame.frameEndNs, 'W4 positive-control original frame timestamps invalid');
      const calls = timing.glCalls.filter(call => call.frameId === frameId && call.queryObject === frame.queryObject);
      for (const [phase, functionKey] of [['begin', 'queryBegin'], ['end', 'queryEnd'], ['availability', 'queryAvailable'], ['duration', 'queryDuration']]) {
        assert(calls.some(call => call.phase === phase && call.function === functions[functionKey]),
          'W4 positive-control required GL call evidence missing');
      }
      assert(sample.frameId === frameId && sample.gpuDurationNs === frame.gpuDurationNs
        && sample.actualLoadDraws === frame.actualLoadDraws && sample.frameBeginNs === frame.frameBeginNs
        && sample.frameEndNs === frame.frameEndNs && sample.valid === true && sample.status === 'ready',
      'W4 positive-control sample differs from original frame');
      durations.push(frame.gpuDurationNs);
    }
    statistics.push({ draws: expectedDraws, samples: 24, p50Ns: quantile(durations, 0.5), p90Ns: quantile(durations, 0.9) });
  }
  for (const field of ['p50Ns', 'p90Ns']) {
    const baseline = statistics[0][field], minimumIncrease = Math.max(100000, baseline * 0.1);
    for (let index = 1; index < statistics.length; ++index) {
      assert(statistics[index][field] > baseline + minimumIncrease,
        'W4 positive-control load is not clearly above baseline');
      if (index > 1) assert(statistics[index][field] > statistics[index - 1][field]
        && statistics[index][field] - statistics[index - 1][field] >= 100000,
      'W4 positive-control GPU time is not monotonically separated');
    }
  }
  return { measurementValid: true, independentRawValidation: true, warmupFramesPerLevel: 8,
    measuredFramesPerLevel: 24, statistics,
    method: { queryDuration: functions.queryDuration, queryAvailable: functions.queryAvailable, counterBits,
      queryStartStages: [...new Set(scene.levels.flatMap(level => level.measuredFrameIds)
        .map(frameId => frames.get(frameId).queryStartStage))].sort(),
      queryEndStage: 'afterFrameEnd', sourceFrameAssociation: 'original-frameId' },
    criterion: 'For p50 and p90: every loaded level > base+max(100000ns,base*0.1); successive loaded levels strictly increase by >=100000ns',
    qtScope: 'lastCompletedGPUTime is auxiliary; sourceFrameId=null and excluded from sample association' };
}

function validateOrdinaryMethod(scene, method) {
  const timing = scene.headerFrameTiming;
  assert(method && method.queryDuration === 'glGetQueryObjectui64vEXT'
    && method.sourceFrameAssociation === 'original-frameId' && Array.isArray(method.queryStartStages)
    && method.queryStartStages.length > 0 && timing?.functions?.queryDuration === method.queryDuration
    && Number.isSafeInteger(method.counterBits) && method.counterBits > 0 && method.counterBits <= 64
    && timing.context?.counterBits === method.counterBits
    && timing.functions.queryAvailable === method.queryAvailable && timing.capabilityResolved === true
    && timing.queriesAvailable === true, 'W4 ordinary GPU method differs from calibrated positive control');
  assert((timing.glCallOverflow === 0 || timing.glCallOverflow === false) && timing.droppedFrames === 0
    && Array.isArray(timing.frames) && Array.isArray(timing.glCalls) && timing.glCalls.every(call => call.preexisting === false
      && !['glFinish', 'glFlush', 'glWaitSync', 'glClientWaitSync'].includes(call.function)
      && Array.isArray(call.errors) && call.errors.length === 0 && (call.errorsOverflow === false || call.errorsOverflow === 0)),
  'W4 ordinary GPU calls contain errors or overflow');
  const ready = timing.frames.filter(frame => frame.status === 'ready');
  assert(ready.length > 0 && ready.every(frame => frame.valid === true && method.queryStartStages.includes(frame.queryStartStage)
    && frame.queryEndStage === method.queryEndStage && frame.sameContext === true
    && frame.availableOutputWritten === true && frame.durationOutputWritten === true
    && frame.availableValue === 1 && typeof frame.durationRawValue === 'string' && /^\d+$/.test(frame.durationRawValue)
    && frame.durationRawValue !== frame.durationSentinel && frame.durationWithinCounterBits === true
    && BigInt(frame.durationRawValue) < (1n << BigInt(method.counterBits))),
  'W4 ordinary GPU frame is not covered by the calibrated method');
  if (timing.auxiliaryRhi?.samples) assert(timing.auxiliaryRhi.samples.every(sample => sample.sourceFrameId === null),
    'W4 Qt GPU observation must not claim a source frame');
  return method;
}

function validateScreenshot(scene, options, read = filename => readOwnedBytes(filename, 32 * 1024 * 1024)) {
  const record = scene.screenshot;
  assert(record && record.requested === options.screenshot && record.timingStopped === true,
    'W4 screenshot request or stopped measurement evidence missing');
  if (options.screenshot === 'none') {
    assert(record.performed === false && !Object.hasOwn(record, 'path'), 'W4 unrequested screenshot was produced');
    return { requested: 'none', performed: false, timingStopped: true };
  }
  const expected = path.join(options.outputDirectory, 'header-frame.memory-open.png');
  assert(SCREENSHOT_VARIANTS.includes(options.variant) && record.performed === true && record.path === expected
    && record.logicalWidth === 1380 && record.logicalHeight === 900
    && Number.isSafeInteger(record.measurementStoppedNs) && record.measurementStoppedNs >= 0
    && Number.isSafeInteger(record.stableOpenObservedNs) && record.stableOpenObservedNs >= record.measurementStoppedNs
    && Number.isSafeInteger(record.grabBeginNs) && record.grabBeginNs >= record.measurementStoppedNs
    && record.grabBeginNs >= record.stableOpenObservedNs && Number.isSafeInteger(record.naturalFramesAfterStable)
    && record.naturalFramesAfterStable >= 2 && record.naturalAnimations === true
    && record.appearanceOrPoseOverrides === false && record.pixelIdentityGuaranteed === false
    && Number.isSafeInteger(record.grabEndNs) && record.grabEndNs >= record.grabBeginNs,
  'W4 screenshot path, dimensions or measurement boundary invalid');
  const bytes = read(expected);
  assert(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR', 'W4 screenshot is not a PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert(width === record.pixelWidth && height === record.pixelHeight && Number.isFinite(record.devicePixelRatio)
    && record.devicePixelRatio > 0 && width === Math.round(record.logicalWidth * record.devicePixelRatio)
    && height === Math.round(record.logicalHeight * record.devicePixelRatio), 'W4 screenshot PNG dimensions differ');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert(record.bytes === bytes.length && record.sha256 === sha256, 'W4 screenshot bytes changed');
  return { ...record, sha256, bytes: bytes.length };
}

function validateControlAnchor(row, summary, buildManifestSha256) {
  assert(row && row.category === 'gui' && row.diagnostic === true && row.passed === true && row.exitCode === 0
    && Array.isArray(row.selection) && row.selection.length === 1
    && row.selection[0] === 'drawer-frame::gpu-positive-control::wide'
    && summary.schema === SUMMARY_SCHEMA && summary.scenario === 'gpu-positive-control'
    && summary.variant === 'gpu-positive-control' && summary.package === PACKAGE
    && summary.passed === true && summary.executionComplete === true && summary.acceptanceEligible === false
    && summary.performanceComparable === false && summary.noResidualProcesses === true
    && summary.testDataRemoved === true && summary.keyCleanupCompleted === true
    && summary.allOwnedExitedNormally === true && summary.forcedCleanup === false
    && summary.applicationUnchanged === true && summary.modelInputUnchanged === true
    && summary.outputDirectory === row.outputDirectory && summary.buildManifestSha256 === buildManifestSha256,
  'W4 ordinary run requires a completed positive control for this build');
}

function loadPositiveControlEvidence(options, buildManifestSha256, io = {}) {
  const root = io.root || ROOT, read = io.readBytes || readOwnedBytes;
  const snapshot = io.snapshotDirectory || guard.snapshotDirectory;
  const packageRoot = path.join(root, '.tools/local', PACKAGE);
  const rows = read(path.join(packageRoot, 'ledger.jsonl'), 16 * 1024 * 1024).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const row = rows.filter(value => Array.isArray(value.selection)
    && value.selection.includes('drawer-frame::gpu-positive-control::wide')).at(-1);
  assert(row && typeof row.outputDirectory === 'string', 'W4 positive-control evidence is missing');
  assert(Number.isSafeInteger(row.sequence) && row.sequence > 0 && Number.isSafeInteger(options.currentSequence)
    && row.sequence < options.currentSequence && row.outputDirectory !== options.outputDirectory,
  'W4 positive-control must be a prior completed local run');
  const controlOptions = { package: PACKAGE, variant: 'gpu-positive-control', screenshot: 'none',
    windowSize: 'wide', outputDirectory: row.outputDirectory };
  localPaths(root, controlOptions);
  snapshot(row.outputDirectory);
  const summaryPath = path.join(row.outputDirectory, 'header-frame.summary.json');
  const summaryBytes = read(summaryPath, 4 * 1024 * 1024);
  assert(row.measurements?.path === summaryPath && row.measurements.bytes === summaryBytes.length
    && row.measurements.sha256 === crypto.createHash('sha256').update(summaryBytes).digest('hex'),
  'W4 positive-control summary bytes changed');
  const summary = JSON.parse(summaryBytes.toString('utf8'));
  validateControlAnchor(row, summary, buildManifestSha256);
  const scenePath = path.join(row.outputDirectory, 'header-frame.scene.json');
  const sceneBytes = read(scenePath, 32 * 1024 * 1024);
  assert(summary.scene?.path === scenePath && summary.scene.bytes === sceneBytes.length
    && summary.scene.sha256 === crypto.createHash('sha256').update(sceneBytes).digest('hex'),
  'W4 positive-control scene bytes changed');
  const verification = validatePositiveControl(JSON.parse(sceneBytes.toString('utf8')), controlOptions);
  return { measurementValid: true, independentRawValidation: true, sequence: row.sequence, buildManifestSha256,
    method: verification.method,
    summary: { path: summaryPath, bytes: summaryBytes.length, sha256: row.measurements.sha256 }, scene: summary.scene };
}

async function settleOwned(running, api = {}) {
  const remaining = api.remaining || (value => guard.remainingProcesses(value));
  const requestExit = api.requestExit || requestOwnedNormalExit;
  const waitExit = api.waitExit || ((value, ms) => childCompletion(value.child, ms, `${value.cycle} exit`));
  const signal = api.signal || ((value, expected) => guard.signalOwned(value, expected, 'SIGKILL'));
  const result = { forcedCleanup: false, errors: [] };
  if (!running.rootIdentity) {
    if (running.child.exitCode === null && running.child.signalCode === null) result.errors.push('Unconfirmed owned process remains');
    return result;
  }
  if (!remaining(running).length) return result;
  if (running.child.exitCode === null && running.child.signalCode === null) {
    try {
      if (!running.normalExitRequested) { running.normalExitRequested = true; await requestExit(running); }
      await waitExit(running, 10000);
    } catch (error) { result.errors.push(String(error)); }
  }
  for (const expected of remaining(running).sort((a, b) => b.pid - a.pid)) {
    if (signal(running, expected)) result.forcedCleanup = true;
  }
  if (running.child.exitCode === null && running.child.signalCode === null) {
    try { await waitExit(running, 5000); } catch (error) { result.errors.push(String(error)); }
  }
  if (remaining(running).length) result.errors.push('Owned processes remain after bounded cleanup');
  return result;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  assert.equal(process.platform, 'darwin', 'W4 local driver requires macOS');
  assert(!Object.keys(process.env).some(key => key.startsWith(ENV_PREFIX)), 'Ambient W4 variables are forbidden');
  const paths = localPaths(ROOT, options);
  assert.equal(fs.realpathSync(options.outputDirectory), options.outputDirectory, 'W4 output aliases are forbidden');
  guard.snapshotDirectory(options.outputDirectory);
  const build = verifyBuild(ROOT, paths.buildDirectory);
  const marker = readControlJson(paths.activeLocalPath);
  const w4 = validateLocalMetadata(ROOT, options, marker, build.record);
  if (options.variant !== 'gpu-positive-control') {
    w4.positiveControlEvidence = loadPositiveControlEvidence({ ...options, currentSequence: marker.metadata.sequence }, build.buildManifestSha256);
  }
  const checkLocal = () => {
    const current = validateLocalMetadata(ROOT, options, readControlJson(paths.activeLocalPath), build.record);
    assert.equal(current.activeRunId, w4.activeRunId, 'Active W4 local run changed');
  };
  const model = path.join(ROOT, '.tools/live2d/yumi-local-validation/原模型测试 副本');
  const modelBefore = digest(directoryInventory(model));
  const summary = { schema: SUMMARY_SCHEMA, package: PACKAGE, variant: options.variant, windowSize: 'wide',
    scenario: options.variant === 'gpu-positive-control' ? 'gpu-positive-control' : 'drawer-cycles',
    screenshotRequested: options.screenshot,
    outputDirectory: options.outputDirectory, diagnostic: true, acceptanceEligible: false, performanceComparable: false,
    executionComplete: false, passed: false, windowCount: 0, forcedCleanup: false, interrupted: false,
    noResidualProcesses: false, testDataRemoved: false, keyCleanupCompleted: false,
    applicationUnchanged: false, modelInputUnchanged: false, cleanupErrors: [], processExits: [],
    ownedInstances: [], activeRunId: w4.activeRunId, buildManifestSha256: build.buildManifestSha256,
    processTracking: 'Owned PID/birth/executable tracking only, once per second; no resource sampler, recording or profiler' };
  const active = [];
  let run, data, contextPath, seedAttempted = false, currentApp;
  const calls = [], completedCalls = [];
  const normalEnvironment = safeEnvironment(Object.fromEntries(['XDG_CACHE_HOME', 'HF_HOME', 'HF_HUB_OFFLINE',
    'TRANSFORMERS_OFFLINE', 'PYTHON_DOTENV_DISABLED', 'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE']
    .filter(key => process.env[key] != null).map(key => [key, process.env[key]])));

  function track(child, identity, cycle, log = null) {
    const running = { runRoot: run.runRoot, userData: data, child, identity, cycle, owned: new Map(),
      spawnConfirmed: false, log, closed: false };
    running.closeCompletion = new Promise(resolve => child.once('close', () => {
      running.closed = true;
      if (running.log !== null) { fs.closeSync(running.log); running.log = null; }
      resolve();
    }));
    child.once('spawn', () => { running.spawnConfirmed = true; });
    child.on('error', error => { running.error = error; });
    active.push(running);
    return running;
  }
  async function register(running) {
    if (!running.spawnConfirmed && !running.error) await new Promise((resolve, reject) => {
      running.child.once('spawn', resolve); running.child.once('error', reject);
    });
    if (running.error) throw running.error;
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      assert.equal(running.cycle, 'cleanup', 'A non-cleanup W4 process exited before registration');
      assert.equal(running.child.exitCode, 0, 'Fast W4 key cleanup failed');
      assert.equal(running.child.signalCode, null, 'Fast W4 key cleanup was signalled');
      summary.keyCleanupCompletedBeforeIdentityRegistration = true;
      return;
    }
    let absent = false;
    try {
      guard.registerRoot(running, (root, pids) => {
        const rows = guard.inspectProcesses(root, pids); absent = rows.length === 0; return rows;
      });
    } catch (error) {
      if (!await cleanupExitedSuccessfully(running.child, { cycle: running.cycle, processAbsent: absent,
        spawnConfirmed: running.spawnConfirmed, spawnError: running.error, registrationError: error })) throw error;
      summary.keyCleanupCompletedBeforeIdentityRegistration = true;
    }
    if (running.rootIdentity) summary.ownedInstances.push({ cycle: running.cycle, ...running.rootIdentity });
  }
  async function launch(cycle, flags, environment = normalEnvironment) {
    checkLocal(); guard.assertIsolation(run.runRoot, data);
    const log = fs.openSync(path.join(options.outputDirectory, `${cycle}.log`), 'wx', 0o600);
    let child;
    try { child = spawn(build.binary, ['--project-root', ROOT, '--data-dir', data, '--python',
      path.join(ROOT, '.venv/bin/python'), '--context', contextPath, ...flags],
    { cwd: ROOT, env: environment, stdio: ['ignore', log, log] }); }
    catch (error) { fs.closeSync(log); throw error; }
    const running = track(child, { executable: build.binary, appRoot: build.app,
      appId: 'com.muhe.reverie.qt.local' }, cycle, log);
    await register(running); return running;
  }
  async function closeCompleted(running) {
    let timer;
    try { await Promise.race([running.closeCompletion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`${running.cycle} stdio close deadline exceeded`)), 5000);
    })]); } finally { clearTimeout(timer); }
  }
  async function wait(running, milliseconds) {
    await childCompletion(running.child, milliseconds, running.cycle);
    await closeCompleted(running);
    const remaining = running.rootIdentity ? guard.remainingProcesses(running) : [];
    summary.processExits.push({ cycle: running.cycle, exitCode: running.child.exitCode,
      signal: running.child.signalCode, remaining: remaining.map(value => ({ pid: value.pid, birth: value.birth })) });
    assert.equal(running.child.exitCode, 0, `${running.cycle} exited abnormally`);
    assert.equal(running.child.signalCode, null, `${running.cycle} exited by signal`);
    assert.equal(remaining.length, 0, `${running.cycle} children remain`);
  }
  const interrupt = () => {
    summary.interrupted = true;
    if (currentApp?.rootIdentity && currentApp.child.exitCode === null && !currentApp.normalExitRequested) {
      currentApp.normalExitRequested = true;
      requestOwnedNormalExit(currentApp).catch(error => summary.cleanupErrors.push(String(error)));
    }
  };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let tracking;
  try {
    run = guard.createIsolationContext(fs.realpathSync(os.tmpdir()));
    data = guard.createIsolatedDirectory(run.runRoot, 'header-frame-fixture');
    guard.prepareNativeController(run.runRoot);
    contextPath = path.join(run.runRoot, 'header-frame.context.json');
    fs.writeFileSync(contextPath, JSON.stringify({ schema: 'reverie.qt.isolation.v1',
      root: guard.snapshotDirectory(run.runRoot), data: guard.snapshotDirectory(data), w4 }), { flag: 'wx', mode: 0o600 });
    const child = spawn(process.execPath, [path.join(__dirname, 'perf-model-server.cjs'), '--protocol', 'stress-v1'],
      { cwd: ROOT, env: normalEnvironment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const server = track(child, { executable: process.execPath }, 'header-frame-model-server');
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('W4 loopback model startup deadline exceeded')), 10000);
      child.on('message', message => {
        if (message?.type === 'ready') { clearTimeout(timer); resolve(message); }
        else if (message?.type === 'call') calls.push(message);
        else if (message?.type === 'complete') completedCalls.push(message);
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('W4 model exited before readiness')); });
    });
    ready.catch(() => {});
    await register(server);
    const address = await ready;
    assert(address.address === '127.0.0.1' && address.pid === child.pid && Number.isInteger(address.port)
      && address.port >= 1024 && address.port <= 65535 && address.protocol === 'stress-v1'
      && address.mockPolicySha256 === modelPolicyRecord('stress-v1').sha256, 'W4 owned loopback identity changed');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    fs.mkdirSync(path.join(data, 'data'), { mode: 0o700 });
    fs.writeFileSync(path.join(data, 'data/config.json'), JSON.stringify(fixtureConfig(endpoint)), { flag: 'wx', mode: 0o600 });
    const fixturePath = path.join(options.outputDirectory, 'header-frame.fixture.json');
    seedAttempted = true;
    const seed = await launch('header-frame-seed', ['--perf-seed', '--perf-rows', '9', '--perf-fixture-report', fixturePath]);
    await wait(seed, 90000);
    const fixture = readControlJson(fixturePath, 1024 * 1024);
    assert(fixture.rows === 9 && fixture.encrypted === true && fixture.committed === true
      && Array.isArray(fixture.messageIds) && fixture.messageIds.length === 9, 'W4 encrypted seed is incomplete');
    const scenePath = path.join(options.outputDirectory, 'header-frame.scene.json');
    const argv = nativeArguments(ROOT, data, contextPath, scenePath, endpoint, model);
    currentApp = await launch('header-frame-app', argv.slice(8), appEnvironment(options, w4));
    const collect = () => {
      for (const running of active) if (running.rootIdentity && running.child.exitCode === null) {
        guard.collectProcesses(running, processTreeSnapshot());
      }
    };
    collect();
    tracking = setInterval(() => { try { collect(); } catch (error) {
      summary.cleanupErrors.push(String(error)); interrupt();
    } }, 1000);
    // The existing drawer budget stays 360s. Positive control has its own 420s cap.
    await wait(currentApp, options.variant === 'gpu-positive-control' ? 420000 : 360000);
    clearInterval(tracking); tracking = null;
    const scene = readControlJson(scenePath, 32 * 1024 * 1024);
    // Preserve the raw producer artifact binding even when independent validation fails.
    summary.scene = { path: scenePath, schema: scene.schema, sha256: fileHash(scenePath), bytes: fs.statSync(scenePath).size };
    if (options.variant === 'gpu-positive-control') {
      summary.positiveControlVerification = validatePositiveControl(scene, options);
    } else {
      summary.windowCount = validateScene(scene, options);
      summary.measurementMethod = validateOrdinaryMethod(scene, w4.positiveControlEvidence.method);
    }
    summary.screenshot = validateScreenshot(scene, options);
    summary.executionComplete = true;
  } catch (error) { summary.error = String(error.stack || error); }
  finally {
    if (tracking) clearInterval(tracking);
    for (const running of [...active].reverse()) {
      try {
        const cleanup = await settleOwned(running);
        summary.forcedCleanup ||= cleanup.forcedCleanup;
        summary.cleanupErrors.push(...cleanup.errors);
        if (running.child.exitCode !== null || running.child.signalCode !== null) await closeCompleted(running);
      } catch (error) { summary.cleanupErrors.push(String(error)); }
    }
    // One cleanup attempt only, using the exact context/data created above.
    if (seedAttempted && run && data && contextPath) {
      let keyCleanup;
      try {
        assert(active.every(running => running.rootIdentity ? guard.remainingProcesses(running).length === 0
          : running.child.exitCode !== null || running.child.signalCode !== null), 'W4 process cleanup is incomplete');
        keyCleanup = await launch('cleanup', ['--remove-test-key']);
        await wait(keyCleanup, 30000);
        summary.keyCleanupCompleted = true;
      } catch (error) { summary.cleanupErrors.push(String(error)); }
      finally {
        if (keyCleanup) try {
          const cleanup = await settleOwned(keyCleanup);
          summary.forcedCleanup ||= cleanup.forcedCleanup;
          summary.cleanupErrors.push(...cleanup.errors);
          if (keyCleanup.child.exitCode !== null || keyCleanup.child.signalCode !== null) await closeCompleted(keyCleanup);
        } catch (error) { summary.cleanupErrors.push(String(error)); }
      }
    }
    try {
      summary.noResidualProcesses = active.every(running => running.rootIdentity ? guard.remainingProcesses(running).length === 0
        : running.child.exitCode !== null || running.child.signalCode !== null);
      if (run && summary.noResidualProcesses && (!seedAttempted || summary.keyCleanupCompleted)) {
        guard.removeIsolationContext(run.runRoot); summary.testDataRemoved = true;
      } else if (run) summary.retainedIsolationRoot = run.runRoot;
    } catch (error) { summary.cleanupErrors.push(String(error)); }
    try {
      checkLocal();
      summary.applicationUnchanged = inventoryUnchanged(directoryInventory(build.app), build.record.application.inventory);
      summary.modelInputUnchanged = inventoryUnchanged(directoryInventory(model), modelBefore);
    } catch (error) { summary.cleanupErrors.push(String(error)); }
    summary.modelCalls = calls;
    summary.modelCompletions = completedCalls;
    for (const running of active) if (!summary.processExits.some(row => row.cycle === running.cycle)) {
      summary.processExits.push({ cycle: running.cycle, exitCode: running.child.exitCode, signal: running.child.signalCode });
    }
    summary.allOwnedExitedNormally = active.length > 0
      && active.every(running => running.child.exitCode === 0 && running.child.signalCode === null && running.closed);
    summary.bootstrapProbeObservation = { calls: calls.filter(call => call.kind === 'probe').length,
      completedCalls: completedCalls.length,
      scope: 'Observed owned provider IPC records; no exact request-count constraint or workload verdict' };
    summary.passed = summary.executionComplete && !summary.error && !summary.interrupted && !summary.forcedCleanup
      && !summary.cleanupErrors.length && summary.noResidualProcesses && summary.testDataRemoved
      && summary.keyCleanupCompleted && summary.applicationUnchanged && summary.modelInputUnchanged
      && summary.allOwnedExitedNormally;
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    fs.writeFileSync(path.join(options.outputDirectory, 'header-frame.summary.json'), JSON.stringify(summary, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ passed: summary.passed, diagnostic: true, acceptanceEligible: false,
      outputDirectory: options.outputDirectory, windowCount: summary.windowCount, error: summary.error }));
    if (!summary.passed) process.exitCode = 1;
  }
  return summary;
}

if (require.main === module) main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
module.exports = { PACKAGE, VARIANTS, SCENE_SCHEMA, SUMMARY_SCHEMA, CONTEXT_SCHEMA, parseArguments,
  CONTROL_SCHEMA, SCREENSHOT_VARIANTS, localPaths, validateLocalMetadata, appEnvironment, nativeArguments,
  validateScene, validatePositiveControl, validateOrdinaryMethod, validateScreenshot, validateControlAnchor, loadPositiveControlEvidence,
  inventoryUnchanged, settleOwned, main };
