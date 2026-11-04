'use strict';
const crypto = require('node:crypto');
const registration = require('../docs/evidence/moonroom-supplementary-protocol.json');
const PROTOCOL = 'companion-transactions-v1';
const PHASE_NAMES = ['reading-open-reverse-task-sequence', 'handle-drag-with-native-avatar-action',
  'sustained-history-scroll', 'composer-one-to-six-lines-grow-delete', 'resize-950-760-1180', 'short-long-delayed-reply-behind-task'];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const contractHash = value => hash(canonical(value));
function expectedContract() {
  const phases = PHASE_NAMES.map((name, phaseIndex) => ({ phaseIndex, name, transactionCount: 0, inputCount: 0, transactions: [] }));
  const tx = (phase, name, inputs, minimumMs = 0, backendGate = false) => {
    const p = phases[phase]; p.transactions.push({ index: p.transactions.length, name, minimumMs, backendGate,
      inputs: inputs.map(([dueMs, inputName]) => ({ dueMs, name: inputName })) });
  };
  const nav = (phase, name) => tx(phase, name, [[0, name]]);
  for (let i = 0; i < 26; ++i) {
    tx(0, 'reading-open-reverse', [[0, i ? 'warm-reading-open' : 'cold-first-reading-open'], [150, 'reading-reverse']], 150);
    for (const name of ['reading-open-full', 'task-memory', 'task-settings', 'task-return-reading', 'reading-close']) nav(0, name);
  }
  for (let i = 0; i < 12; ++i) {
    tx(1, 'native-avatar-action', [[0, 'native-avatar-return']]);
    for (const open of [true, false]) tx(1, open ? 'handle-open' : 'handle-close',
      [[0, open ? 'handle-open-press' : 'handle-close-press'], [100, 'handle-move'], [200, 'handle-move'], [300, 'handle-move'], [500, 'handle-release']]);
  }
  tx(2, 'continuous-history-wheel-30s', Array.from({ length: 300 }, (_, i) =>
    [i * 100, i >= 285 || Math.floor(i / 15) % 2 === 0 ? 'history-wheel-older' : 'history-wheel-latest']), 30000);
  for (let i = 0; i < 180; ++i) nav(3, 'composer-grow-delete');
  for (let i = 0; i < 160; ++i) nav(4, 'window-resize');
  for (let i = 0; i < 3; ++i) {
    nav(5, 'reply-compose'); nav(5, 'reply-send');
    if (i < 2) tx(5, 'reply-completion', [[0, 'reply-observe-canonical-completion']], 0, true);
  }
  nav(5, 'preserved-reply-draft');
  tx(5, 'held-reading-selection', [[0, 'held-selection-press'], [200, 'held-selection-move'],
    [400, 'held-selection-move'], [600, 'held-selection-move'], [800, 'held-selection-release']]);
  nav(5, 'reply-task-memory');
  for (let i = 0; i < 8; ++i) nav(5, i % 2 === 0 ? 'reply-task-settings' : 'reply-task-memory-active');
  tx(5, 'delayed-reply-completion-behind-task', [[0, 'reply-observe-canonical-completion']], 0, true);
  nav(5, 'reply-return-reading'); nav(5, 'validate-preserved-reading');
  phases[5].transactions.at(-1).inputs[0].name = 'validate-preserved-reading-then-restore-draft';
  for (let i = 0; i < 12; ++i) for (const name of ['post-reply-memory', 'post-reply-settings', 'post-reply-return-reading']) nav(5, name);
  for (const p of phases) { p.transactionCount = p.transactions.length; p.inputCount = p.transactions.reduce((n, t) => n + t.inputs.length, 0); }
  const w = registration.fixedWork;
  return { version: PROTOCOL,
    scenario: 'A user completes each navigation, drag, edit or resize before beginning the next operation; continuous scrolling and chat task handoff are separately fixed workloads',
    navigationCycles: w.navigationCycles, dragCycles: w.dragCycles, composerChanges: w.composerChanges, resizeSteps: w.resizeSteps,
    driverTransactions: phases.reduce((n, p) => n + p.transactionCount, 0),
    driverActions: phases.reduce((n, p) => n + p.inputCount, 0),
    controlRelatedDispatches: phases.reduce((n, p) => n + p.inputCount, 0) - 3, driverOnlyCompletionObservations: 3,
    scrollWheelEvents: w.scrollWheelEvents, scrollEventPeriodMs: w.scrollEventPeriodMs, scrollGestureMs: w.scrollGestureMs,
    scrollStopObservationToleranceMs: w.scrollStopObservationToleranceMs, scrollInputDeadlineMs: w.scrollInputDeadlineMs,
    replyRequests: w.replyRequests, delayedReplyMockMs: w.delayedReplyMockMs,
    delayedTaskHandoffEarliestAfterSendMs: w.delayedTaskHandoffEarliestAfterSendMs,
    whileWaitingTaskTransitions: w.whileWaitingTaskTransitions, postReplyMemorySettingsReadingCycles: w.postReplyMemorySettingsReadingCycles,
    humanPauseMs: w.humanPauseMs, actualFramesAfterSemanticReady: w.actualFramesAfterSemanticReady,
    minimumActiveIntervalsPerPhase: w.minimumActiveIntervalsPerPhase, transactionTimeoutMs: w.transactionTimeoutMs,
    preDispatchGateTimeoutMs: w.transactionTimeoutMs, activeTransactionTimeoutMs: w.transactionTimeoutMs,
    scrollActiveAndTailTimeoutMs: w.scrollTransactionTimeoutMs,
    continuousScrollTransactionTimeoutMs: w.scrollTransactionTimeoutMs, phaseTimeoutMs: w.phaseTimeoutMs,
    historyTimeoutMs: w.historyTimeoutMs, resizeViewports: registration.fixture.resizeViewports,
    deadlineScope: 'Pre-dispatch gate and active transaction have separate 15s deadlines; transactionTimeoutMs is the compatible active deadline. Continuous scroll active gesture plus presentation tail has a 45s deadline. Total phase 600s includes all gates, active work and human pauses; history 1800s includes preparation and idle phases',
    fixedBeforeGui: true, appendRepetitionsToPass: false, phasePlan: phases };
}
module.exports = { expectedContract, contractHash, canonical, hash, PROTOCOL, PHASE_NAMES, registration };
