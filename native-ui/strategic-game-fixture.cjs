'use strict';

const epoch = 1794297600000;
const fingerprint = 'a'.repeat(64);

function makeStrategicGameFixture(spec, opponentMoves) {
  const {id, after, moveControls, userMove, record, board, status, boardSize} = spec;
  const navigation = ['scene-navigation-search', 'search-result-activities-' + id];
  const firstControls = [...navigation, ...moveControls, id + 'Undo', ...moveControls, id + 'Reset', id + 'ResetCancel'];
  const restartControls = [...navigation, id + 'Reset', id + 'ResetConfirm'];

  function report(cycle) {
    const first = cycle === 1;
    const scope = `builtin_hoshino_yumetsuki:${cycle}:${fingerprint}`;
    const generation = cycle + 1;
    const start = epoch + (first ? 1000 : 4000);
    const elapsedMs = first ? 1600 : 540;
    const archive = {revision: 6, sha256: 'b'.repeat(64)};
    const finalMoves = [userMove, opponentMoves[1]];
    const moves = first ? [null, [], [userMove], [userMove, opponentMoves[0]], [], [userMove], finalMoves] : [finalMoves, []];
    const revisions = first ? [0, 1, 2, 3, 4, 5, 6] : [6, 7];
    const sendAt = first ? [130, 138, 300, 650, 810, 980, 1300] : [130, 455];
    const receivedAt = first ? [140, 170, 310, 660, 820, 990, 1310] : [141, 460];
    const clickAt = first ? [40, 120, ...moveControls.map((_, i) => 260 + i * 20), 790,
      ...moveControls.map((_, i) => 930 + i * 20), 1400, 1500] : [40, 120, 280, 440];
    const controls = first ? firstControls : restartControls;
    const inputs = controls.map((control, index) => ({control, atMs: clickAt[index], mouseDispatchCount: 1,
      clickedSignals: 1, hitAccepted: true}));
    const events = moves.map((_, index) => ({id: `qt_${(cycle * 10 + index).toString(16).padStart(32, '0')}`,
      command: index === 0 ? 'game_state:get' : 'game_state:put', scope, generation}));
    const commands = events.map((event, index) => ({...event, atMs: sendAt[index], fields: index === 0 ?
      {game_id: id} : {game_id: id, expected_revision: revisions[index - 1], state: record(moves[index])}}));
    const receipts = events.map((event, index) => ({...event, atMs: receivedAt[index], ok: true, code: '',
      exists: moves[index] !== null, revision: revisions[index], state: moves[index] === null ? null : record(moves[index])}));

    function snapshot(index, atMs) {
      const played = [...moves[index]];
      return {atMs, revision: revisions[index], moves: played, boardSize, ...board(played), status, ready: true};
    }

    const observed = first ? {loaded: snapshot(1, 190), first: snapshot(3, 700), undo: snapshot(4, 860),
      second: snapshot(6, 1350), final: snapshot(6, 1530)} : {loaded: snapshot(0, 180), final: snapshot(1, 510)};
    return {cycle: String(cycle), [after]: {passed: true, tailEndEpochMs: start - 40, scopeAfter: scope,
      generationAfter: generation}, [id]: {
      passed: true, error: '', cycle, deadlineMs: first ? 60000 : 15000, elapsedMs,
      tailStartEpochMs: start, tailEndEpochMs: start + elapsedMs,
      scopeBefore: scope, scopeAfter: scope, generationBefore: generation, generationAfter: generation,
      inputs, searchAtMs: 80, commands, receipts, observed: {...observed, mode: '本地练习'},
      archiveBefore: {...archive}, archiveAfter: {...archive},
    }};
  }

  return {reports: [report(1), report(2)], requests: 9, modelCallTiming: [
    ...Array.from({length: 8}, (_, index) => ({cycle: 1, receivedEpochMs: epoch + index * 100})),
    {cycle: 2, receivedEpochMs: epoch + 3200},
  ]};
}

module.exports = {makeStrategicGameFixture};
