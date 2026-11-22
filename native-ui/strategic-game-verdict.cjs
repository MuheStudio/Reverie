'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { verdictReason } = require('./verdict-test-support.cjs');

const READ = 'game_state:get', SAVE = 'game_state:put';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

const ruleCache = new Map();
function loadRules(file) {
  if (!ruleCache.has(file)) {
    const ts = require('../frontend/node_modules/typescript');
    const engine = path.join(__dirname, 'rules', file);
    const source = ts.transpileModule(fs.readFileSync(engine, 'utf8'), {
      compilerOptions: {target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS},
    }).outputText;
    const rules = {};
    new Function('exports', source)(rules);
    ruleCache.set(file, rules);
  }
  return ruleCache.get(file);
}

function verifyStrategicGame(spec, reports, modelCallTiming, requests) {
  const {id, after, contract, moveControls, empty, userMove, turn, boardSize, replay} = spec;
  const navigation = ['scene-navigation-search', 'search-result-activities-' + id];
  const inputOrder = [
    [...navigation, ...moveControls, id + 'Undo', ...moveControls, id + 'Reset', id + 'ResetCancel'],
    [...navigation, id + 'Reset', id + 'ResetConfirm'],
  ];

  function guard(condition, reason, context) {
    assert(condition, verdictReason(`${id.toUpperCase()}_${reason}`, context));
  }

  function persona(scope, context) {
    guard(typeof scope === 'string', 'SCOPE', context);
    const [id, epoch, fingerprint, ...extra] = scope.split(':');
    guard(extra.length === 0 && /^[A-Za-z0-9_-]{4,128}$/.test(id) && /^[0-9]+$/.test(epoch) &&
      whole(Number(epoch)) && sha256(fingerprint), 'SCOPE', context);
    return {id, fingerprint};
  }

  function inOrder(times, context) {
    guard(times.every((time, i) => whole(time) && (i === 0 || times[i - 1] <= time)), 'EVENT_ORDER', context);
  }

  function checkCycle(report, cycle, seenIds) {
    const context = {cycle};
    const tail = report?.[id];
    guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle &&
      tail.passed === true && tail.error === '', 'CYCLE', context);
    const {elapsedMs, deadlineMs, tailStartEpochMs, tailEndEpochMs, scopeBefore, scopeAfter,
      generationBefore, generationAfter, inputs, commands, receipts, archiveBefore, archiveAfter} = tail;
    const deadline = cycle === 1 ? 60000 : 15000;
    guard(deadlineMs === deadline && whole(elapsedMs) && elapsedMs < deadline, 'DEADLINE', context);
    guard(whole(tailStartEpochMs) && tailStartEpochMs > 0 && whole(tailEndEpochMs), 'TAIL_CLOCK', context);
    const wallElapsed = tailEndEpochMs - tailStartEpochMs;
    guard(whole(wallElapsed) && wallElapsed < deadline && Math.abs(wallElapsed - elapsedMs) <= 100, 'TAIL_CLOCK', context);

    const previous = report[after];
    guard(previous?.passed === true && whole(previous.tailEndEpochMs) && previous.tailEndEpochMs <= tailStartEpochMs &&
      previous.scopeAfter === scopeBefore && previous.generationAfter === generationBefore, 'TAIL_SEQUENCE', context);
    const activePersona = persona(scopeBefore, context);
    guard(scopeBefore === scopeAfter && whole(generationBefore) && generationBefore > 0 && generationAfter === generationBefore,
      'SCOPE', context);
    guard(exact(archiveBefore, ['revision', 'sha256']) && exact(archiveAfter, ['revision', 'sha256']) &&
      sha256(archiveBefore.sha256) && (archiveBefore.revision === null || whole(archiveBefore.revision)) &&
      isDeepStrictEqual(archiveBefore, archiveAfter), 'ARCHIVE', context);
    guard(tail.observed?.mode === '本地练习', 'MODE', context);

    const controls = inputOrder[cycle - 1];
    guard(Array.isArray(inputs) && inputs.length === controls.length && inputs.every((event, index) =>
      exact(event, ['control', 'atMs', 'mouseDispatchCount', 'clickedSignals', 'hitAccepted']) &&
      event.control === controls[index] && event.mouseDispatchCount === 1 && event.clickedSignals === 1 &&
      event.hitAccepted === true), 'INPUTS', context);
    const commandOrder = [READ, ...Array(cycle === 1 ? 6 : 1).fill(SAVE)];
    guard(Array.isArray(commands) && commands.length === commandOrder.length &&
      commands.every((row, index) => row?.command === commandOrder[index]), 'COMMANDS', context);
    guard(Array.isArray(receipts) && receipts.length === commandOrder.length &&
      receipts.every((row, index) => row?.command === commandOrder[index]), 'RECEIPTS', context);

    for (const [index, command] of commands.entries()) {
      const receipt = receipts[index];
      const eventContext = {cycle, exchange: index};
      guard(typeof command.id === 'string' && /^qt_[a-f0-9]{32}$/.test(command.id) && !seenIds.has(command.id) &&
        receipt.id === command.id && command.scope === scopeBefore && receipt.scope === scopeBefore &&
        command.generation === generationBefore && receipt.generation === generationBefore, 'REQUEST_BINDING', eventContext);
      seenIds.add(command.id);
      guard(receipt.ok === true && receipt.code === '' && typeof receipt.exists === 'boolean' && whole(receipt.revision),
        index === 0 ? 'READ_FAILED' : 'WRITE_FAILED', eventContext);
      guard(exact(command.fields, index === 0 ? ['game_id'] : ['game_id', 'state', 'expected_revision']) &&
        command.fields.game_id === id, 'COMMAND_FIELDS', eventContext);
      if (index > 0) {
        guard(command.fields.expected_revision === receipts[index - 1].revision, 'EXPECTED_REVISION', eventContext);
        guard(receipt.exists === true && isDeepStrictEqual(command.fields.state, receipt.state), 'WRITE_READBACK', eventContext);
      }
      if (receipt.exists) guard(replay(receipt.state) !== null, 'REPLAY', eventContext);
      inOrder([command.atMs, receipt.atMs, elapsedMs], eventContext);
    }
    inOrder(commands.map(event => event.atMs), context);
    inOrder(receipts.map(event => event.atMs), context);
    return {tail, activePersona};
  }

  function snapshot(tail, name, receiptIndex) {
    const context = {cycle: tail.cycle, snapshot: name};
    const saved = tail.receipts[receiptIndex];
    const view = tail.observed[name];
    const state = replay(saved.state);
    guard(state !== null, 'REPLAY', context);
    guard(exact(view, ['atMs', 'revision', 'moves', 'boardSize', 'stones', 'last', 'status', 'ready']) &&
      view.revision === saved.revision && isDeepStrictEqual(view.moves, state.moves) &&
      view.ready === true && view.status === turn && view.boardSize === boardSize, 'SNAPSHOT', context);
    guard(state.playerTurn && isDeepStrictEqual(state.stones, view.stones) &&
      isDeepStrictEqual(state.last, view.last), 'BOARD', context);
    inOrder([saved.atMs, view.atMs, tail.elapsedMs], context);
    return view;
  }

  function firstCycle(tail) {
    const {commands, receipts, inputs, searchAtMs, elapsedMs} = tail;
    const context = {cycle: 1};
    guard(receipts[0].exists === false && receipts[0].revision === 0 && receipts[0].state === null &&
      receipts.slice(1).every((row, index) => row.revision === index + 1), 'FIRST_REVISIONS', context);
    guard(isDeepStrictEqual(receipts[1].state, empty), 'NEW_GAME', context);
    guard(isDeepStrictEqual(receipts[4].state, empty), 'UNDO', context);
    for (const index of [2, 5]) {
      const played = replay(receipts[index].state);
      guard(played?.moves.length === 1 && played.moves[0] === userMove, 'PLAYER_MOVE', {cycle: 1, exchange: index});
      const reply = replay(receipts[index + 1].state);
      guard(reply?.moves.length === 2 && reply.moves[0] === userMove, 'OPPONENT_REPLY', {cycle: 1, exchange: index + 1});
    }
    const loaded = snapshot(tail, 'loaded', 1);
    const first = snapshot(tail, 'first', 3);
    const undo = snapshot(tail, 'undo', 4);
    const second = snapshot(tail, 'second', 6);
    const final = snapshot(tail, 'final', 6);
    const [palette, entry, ...actions] = inputs.map(input => input.atMs);
    const stepCount = moveControls.length;
    const firstMove = actions.slice(0, stepCount);
    const undoClick = actions[stepCount];
    const secondMove = actions.slice(stepCount + 1, stepCount * 2 + 1);
    const [reset, cancel] = actions.slice(stepCount * 2 + 1);
    inOrder([palette, searchAtMs, entry, commands[0].atMs, loaded.atMs, ...firstMove,
      commands[2].atMs, receipts[2].atMs, commands[3].atMs, first.atMs,
      undoClick, commands[4].atMs, undo.atMs, ...secondMove, commands[5].atMs, receipts[5].atMs,
      commands[6].atMs, second.atMs, reset, cancel, final.atMs, elapsedMs], context);
    return {final, record: receipts[6].state, opponentMoves: [first.moves[1], second.moves[1]]};
  }

  function restartCycle(tail, previous, record) {
    const {commands, receipts, inputs, searchAtMs, elapsedMs} = tail;
    const context = {cycle: 2};
    guard(receipts[0].exists === true && receipts[0].revision === previous.revision &&
      isDeepStrictEqual(receipts[0].state, record), 'RESTART_READBACK', context);
    guard(receipts[1].revision === previous.revision + 1 && isDeepStrictEqual(receipts[1].state, empty), 'RESET', context);
    const loaded = snapshot(tail, 'loaded', 0);
    const final = snapshot(tail, 'final', 1);
    inOrder([inputs[0].atMs, searchAtMs, inputs[1].atMs, commands[0].atMs, loaded.atMs,
      inputs[2].atMs, inputs[3].atMs, commands[1].atMs, final.atMs, elapsedMs], context);
    return final;
  }

  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const ids = new Set();
  const first = checkCycle(reports[0], 1, ids);
  const restart = checkCycle(reports[1], 2, ids);
  guard(first.tail.tailEndEpochMs < restart.tail.tailStartEpochMs, 'TAIL_ORDER');
  guard(isDeepStrictEqual(first.activePersona, restart.activePersona), 'RESTART_PERSONA', {cycle: 2});
  const {final, record, opponentMoves} = firstCycle(first.tail);
  const reset = restartCycle(restart.tail, final, record);

  guard(Array.isArray(modelCallTiming) && modelCallTiming.every(call => object(call) &&
    [1, 2].includes(call.cycle) && whole(call.receivedEpochMs) && call.receivedEpochMs > 0), 'MODEL_TRACE');
  for (const {cycle, tailStartEpochMs, tailEndEpochMs} of [first.tail, restart.tail]) {
    guard(!modelCallTiming.some(call => call.receivedEpochMs >= tailStartEpochMs && call.receivedEpochMs <= tailEndEpochMs),
      'MODEL_REQUEST', {cycle});
    guard(modelCallTiming.some(call => call.cycle === cycle && call.receivedEpochMs < tailStartEpochMs), 'MODEL_TRACE', {cycle});
  }
  guard(requests === 9 && modelCallTiming.length === 9, 'MODEL_COUNT');

  return {passed: true, contract, elapsedMs: [first.tail.elapsedMs, restart.tail.elapsedMs],
    firstWrites: 6, restartWrites: 1, modelMoves: 0, modelRequestsAdded: 0, opponentMoves,
    finalRevisions: [final.revision, reset.revision]};
}

module.exports = {loadRules, verifyStrategicGame};
