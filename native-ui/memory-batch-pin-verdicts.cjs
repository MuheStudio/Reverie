'use strict';
const assert = require('node:assert/strict');
const CHECKS = Object.freeze([
  ['baseline-and-authoritative-preview', 'cancel-preserves-selection-with-zero-writes',
    'pin-ack-and-two-authoritative-reads', 'unpin-ack-and-two-authoritative-reads', 'remaining-identities-and-selection-finished'],
  ['restart-pins-and-identities-read-back'],
]);
const INPUT_STEPS = Object.freeze([[0, 1, 2, 3, 5, 7, 8, 9, 10, 11, 13, 15, 17, 19, 21, 22, 23, 24, 26, 28, 31],
  [0, 1, 2, 3, 5, 7, 8, 9, 10, 11, 13, 14, 31]]);
const MEMORY_BATCH_PIN_CONTRACT = Object.freeze({schema: 'reverie.p1.memory-batch-pin.r1.gui-contract.v1',
  checks: CHECKS, inputSteps: INPUT_STEPS, targetNumbers: [126, 125, 124],
  deadlineMs: [30000, 10000], writeDispatches: [2, 0], statusReadDispatches: [5, 1],
  modelHttpRequests: 7, recallQueries: 2, summaryReads: 2, remainingMemories: 127, messages: 39});
const id = value => assert(typeof value === 'string' && value.length > 0 && value.length <= 160, 'Missing request/target ID');
const integer = value => assert(Number.isSafeInteger(value) && value >= 0, 'Invalid integer');
function unique(values, count) {
  assert(Array.isArray(values)); assert.equal(values.length, count); values.forEach(id);
  assert.equal(new Set(values).size, values.length, 'Duplicate identity');
}
function pins(value, ids) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...ids].sort(), 'Pin state identity set differs');
  assert(Object.values(value).every(v => typeof v === 'boolean'), 'Pin state is not boolean');
}
function snapshot(receipt, ids, target) {
  assert.equal(receipt.command, 'memory:pin_status'); assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.memory_ids, ids); assert.deepEqual(receipt.stale_ids, []);
  assert.deepEqual(receipt.states, ids.map(memory_id => ({memory_id, pinned: target})));
  integer(receipt.pinned_total); assert.equal(receipt.pin_limit, 20);
}
function verifyMemoryBatchPin({reports}) {
  assert(Array.isArray(reports) && reports.length === 2);
  const baseline = reports[0].memoryBatchDelete?.observed?.remainingIds;
  unique(baseline, 127);
  const first = reports[0].memoryBatchPin?.observed, second = reports[1].memoryBatchPin?.observed;
  assert(first && second, 'Batch pin segment missing');
  const targets = first.targetIds; unique(targets, 3); assert(targets.every(v => baseline.includes(v)));
  assert.deepEqual(second.targetIds, targets);
  pins(first.beforePins, baseline);
  targets.forEach(target => assert.equal(first.beforePins[target], false));
  const afterPin = {...first.beforePins}; targets.forEach(target => { afterPin[target] = true; });
  const final = {...first.beforePins, [targets[0]]: true};
  assert.deepEqual(first.afterPinIds, baseline); assert.deepEqual(first.afterPinStates, afterPin);
  assert.deepEqual(first.finalPins, final); assert.deepEqual(second.beforePins, final); assert.deepEqual(second.finalPins, final);
  const allIds = [];
  for (const [cycle, report] of reports.entries()) {
    const segment = report.memoryBatchPin, o = segment.observed;
    assert.equal(segment.passed, true); assert.equal(segment.contentCollected, false);
    assert.equal(segment.deadlineMs, MEMORY_BATCH_PIN_CONTRACT.deadlineMs[cycle]);
    integer(segment.elapsedMs); assert(segment.elapsedMs < segment.deadlineMs);
    assert.deepEqual(segment.checks.map(c => c.name), CHECKS[cycle]);
    assert(segment.checks.every(c => c.passed === true));
    assert.deepEqual(o.baselineIds, baseline); assert.deepEqual(o.remainingIds, baseline);
    const messages = report.messages.map(v => v.id); unique(messages, 39);
    assert.deepEqual(o.beforeMessageIds, messages); assert.deepEqual(o.finalMessageIds, messages);
    assert.equal(o.selectionEmpty, true); assert.equal(o.selectionMode, false); assert.equal(o.surfaceClosed, true);
    assert.equal(o.cancelWriteDelta, 0);
    assert.equal(o.writeDispatchDelta, MEMORY_BATCH_PIN_CONTRACT.writeDispatches[cycle]);
    assert.equal(o.statusReadDispatchDelta, MEMORY_BATCH_PIN_CONTRACT.statusReadDispatches[cycle]);
    id(o.scope); integer(o.generation); integer(o.initialPinnedTotal);
    assert(Array.isArray(o.receipts) && o.receipts.length <= 24);
    const byId = new Map();
    for (const r of o.receipts) {
      id(r.requestId); assert(!byId.has(r.requestId), 'Repeated receipt'); byId.set(r.requestId, r); allIds.push(r.requestId);
      assert.equal(r.generation, o.generation); assert.equal(r.scope, o.scope); assert.equal(r.ok, true);
      assert(['memory:pin_status', 'memory:pin_many', 'memory:list'].includes(r.command));
    }
    assert.equal(o.receipts.filter(r => r.command === 'memory:pin_status').length, MEMORY_BATCH_PIN_CONTRACT.statusReadDispatches[cycle]);
    assert.equal(o.receipts.filter(r => r.command === 'memory:pin_many').length, MEMORY_BATCH_PIN_CONTRACT.writeDispatches[cycle]);
    const initial = byId.get(o.initialPreviewId); assert(initial, 'Initial preview missing');
    assert.equal(initial.command, 'memory:pin_status');
    assert.deepEqual(initial.memory_ids, targets); assert.deepEqual(initial.stale_ids, []);
    assert.deepEqual(initial.states, targets.map((memory_id, i) => ({memory_id, pinned: cycle === 1 && i === 0})));
    assert.equal(initial.pinned_total, o.initialPinnedTotal); assert.equal(initial.pin_limit, 20);
    assert.deepEqual(segment.inputs.map(v => v.step), INPUT_STEPS[cycle]);
    const controls = {0: 'nav-memory', 1: 'archive-open-memories', 2: 'memoryTab-memories', 3: 'memoryRefresh',
      5: 'memoryLoadMore', 7: 'memorySelectMode', 11: 'memoryPinSelected', 13: 'memoryBatchPinCancel',
      14: 'memorySelectionCancel', 15: 'memoryPinSelected', 17: 'memoryBatchPinConfirm', 19: 'memoryLoadMore',
      21: 'memorySelectMode', 24: 'memoryUnpinSelected', 26: 'memoryBatchPinConfirm', 28: 'memoryLoadMore', 31: 'memory-close'};
    const inputTargets = {8: targets[0], 9: targets[1], 10: targets[2], 22: targets[1], 23: targets[2]};
    for (const input of segment.inputs) {
      const expectedTarget = inputTargets[input.step] || '';
      assert.equal(input.id, expectedTarget, 'Input target is not the registered step target');
      assert.equal(input.control, expectedTarget ? 'memorySelect' + baseline.indexOf(expectedTarget) : controls[input.step],
        'Input control is not the registered step control');
      assert.equal(input.signals?.observerValid, true);
      assert.deepEqual([input.signals.mouseDispatchCount, input.signals.contractReason], [1, '']);
      assert(input.id ? [0, 1].includes(input.signals.clickedSignals) : input.signals.clickedSignals === 1);
      assert(input.layout?.ready === true && input.layout.minimumStableMs === 40 && input.layout.last?.layoutStable === true);
      assert.equal(input.layout.last?.fullyVisible, true);
      assert(['target', 'descendant'].includes(input.hit?.hitResult) && input.hit.acceptorFound === true);
      if (input.id) {
        assert(targets.includes(input.id)); assert.equal(input.control, 'memorySelect' + baseline.indexOf(input.id));
        assert.equal(input.signals.controlKind, 'switch'); assert.equal(input.signals.toggledSignals, 1);
      } else assert.equal(input.signals.controlKind, input.control === 'memoryTab-memories' ? 'tab' : 'button');
    }
    assert(Array.isArray(o.actions) && o.actions.length === (cycle ? 0 : 2));
    for (const [index, action] of o.actions.entries()) {
      const selected = index ? targets.slice(1) : targets;
      const target = index === 0;
      assert.deepEqual(action.ids, selected); assert.equal(action.pinned, target); assert.equal(action.changed, selected.length);
      assert.equal(action.status, 'success');
      assert.equal(action.feedbackWholeVisible, true);
      assert(Number.isFinite(action.feedbackContrast?.contrast) && action.feedbackContrast.contrast >= 4.5 && action.feedbackContrast.pixelCount > 0);
      const ids = [action.previewRequestId, action.requestId, action.statusReadId, action.listReadId]; unique(ids, 4);
      assert.notEqual(action.previewRequestId, o.initialPreviewId, 'Cancelled preview reused');
      const [preview, ack, state, list] = ids.map(v => byId.get(v)); assert(preview && ack && state && list, 'ACK/read proof incomplete');
      snapshot(preview, selected, !target); snapshot(state, selected, target);
      assert.equal(ack.command, 'memory:pin_many'); assert.deepEqual(ack.memory_ids, selected);
      assert.equal(ack.pinned, target); assert.deepEqual(ack.changed_ids, selected); assert.deepEqual(ack.unchanged_ids, []);
      integer(ack.pinned_total_before); integer(ack.pinned_total_after); assert.equal(ack.pin_limit, 20);
      assert.equal(ack.pinned_total_before, o.initialPinnedTotal + (index ? 3 : 0));
      assert.equal(ack.pinned_total_after, ack.pinned_total_before + (target ? selected.length : -selected.length));
      if (target) assert(ack.pinned_total_after <= 20);
      assert.equal(preview.pinned_total, ack.pinned_total_before);
      assert.equal(state.pinned_total, ack.pinned_total_after);
      assert.equal(list.command, 'memory:list'); pins(list.pins, baseline.slice(0, 100));
      assert.deepEqual(list.pins, Object.fromEntries(baseline.slice(0, 100).map(v => [v, (index ? final : afterPin)[v]])));
    }
    if (cycle === 0) {
      assert.equal(o.terminalStatus, 'success');
      for (const key of ['confirmContrast', 'unpin-confirmContrast']) {
        assert.equal(o[key]?.length, 2);
        assert(o[key].every(v => Number.isFinite(v.contrast) && v.contrast >= 4.5 && v.pixelCount > 0));
      }
    }
  }
  unique(allIds, allIds.length);
  assert.equal(second.initialPinnedTotal, first.initialPinnedTotal + 1, 'Restart pin capacity differs');
  assert.deepEqual(reports[0].messages.map(v => v.id), reports[1].messages.map(v => v.id));
  return {passed: true, checks: [5, 1], targetIds: targets, writeDispatches: [2, 0], statusReadDispatches: [5, 1],
    preservedMemoryIds: 127, preservedMessageIds: 39};
}
module.exports = {MEMORY_BATCH_PIN_CONTRACT, verifyMemoryBatchPin};
