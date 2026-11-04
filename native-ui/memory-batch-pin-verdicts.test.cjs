'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {MEMORY_BATCH_PIN_CONTRACT: contract, verifyMemoryBatchPin} = require('./memory-batch-pin-verdicts.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(hiddenPins = 0) {
  const baseline = Array.from({length: 127}, (_, n) => `memory-${n}`), targets = baseline.slice(1, 4);
  const messages = Array.from({length: 39}, (_, n) => ({id: `message-${n}`}));
  const before = Object.fromEntries(baseline.map(v => [v, false]));
  const pinned = {...before}; targets.forEach(v => { pinned[v] = true; });
  const final = {...before, [targets[0]]: true};
  const reports = [0, 1].map(cycle => {
    const common = {ok: true, generation: cycle + 1, scope: `persona-${cycle}`};
    const status = (requestId, selected, values, total) => ({...common, requestId, command: 'memory:pin_status',
      memory_ids: selected, states: selected.map((memory_id, i) => ({memory_id, pinned: values[i]})),
      stale_ids: [], pinned_total: total, pin_limit: 20});
    const initial = status(`initial-${cycle}`, targets, [cycle === 1, false, false], hiddenPins + cycle);
    const receipts = [initial], actions = [];
    if (!cycle) {
      for (const index of [0, 1]) {
        const selected = index ? targets.slice(1) : targets, target = index === 0;
        const preview = status(`preview-${index}`, selected, selected.map(() => !target), hiddenPins + (index ? 3 : 0));
        const ack = {...common, requestId: `write-${index}`, command: 'memory:pin_many', memory_ids: selected,
          pinned: target, changed_ids: selected, unchanged_ids: [], pinned_total_before: hiddenPins + (index ? 3 : 0),
          pinned_total_after: hiddenPins + (index ? 1 : 3), pin_limit: 20};
        const fresh = status(`status-${index}`, selected, selected.map(() => target), ack.pinned_total_after);
        const list = {...common, requestId: `list-${index}`, command: 'memory:list',
          pins: Object.fromEntries(baseline.slice(0, 100).map(v => [v, (index ? final : pinned)[v]]))};
        receipts.push(preview, ack, fresh, list);
        actions.push({requestId: ack.requestId, previewRequestId: preview.requestId, statusReadId: fresh.requestId,
          listReadId: list.requestId, ids: selected, pinned: target, changed: selected.length, status: 'success',
          feedbackWholeVisible: true, feedbackContrast: {contrast: 5, pixelCount: 20}});
      }
    }
    const controls = {0: 'nav-memory', 1: 'archive-open-memories', 2: 'memoryTab-memories', 3: 'memoryRefresh',
      5: 'memoryLoadMore', 7: 'memorySelectMode', 11: 'memoryPinSelected', 13: 'memoryBatchPinCancel',
      14: 'memorySelectionCancel', 15: 'memoryPinSelected', 17: 'memoryBatchPinConfirm', 19: 'memoryLoadMore',
      21: 'memorySelectMode', 24: 'memoryUnpinSelected', 26: 'memoryBatchPinConfirm', 28: 'memoryLoadMore', 31: 'memory-close'};
    const inputTargets = {8: targets[0], 9: targets[1], 10: targets[2], 22: targets[1], 23: targets[2]};
    const inputs = contract.inputSteps[cycle].map(step => {
      const id = inputTargets[step] || '', control = id ? 'memorySelect' + baseline.indexOf(id) : controls[step];
      return {step, id, control, signals: {observerValid: true, mouseDispatchCount: 1, clickedSignals: 1,
        toggledSignals: id ? 1 : null, contractReason: '', controlKind: id ? 'switch' : step === 2 ? 'tab' : 'button'},
      layout: {ready: true, minimumStableMs: 40, last: {layoutStable: true, fullyVisible: true}},
      hit: {hitResult: 'target', acceptorFound: true}};
    });
    return {messages: clone(messages), memoryBatchDelete: cycle ? undefined : {observed: {remainingIds: baseline}},
      memoryBatchPin: {passed: true, contentCollected: false, deadlineMs: contract.deadlineMs[cycle], elapsedMs: 1000,
        checks: contract.checks[cycle].map(name => ({name, passed: true})), inputs,
        observed: {scope: common.scope, generation: common.generation, targetIds: targets, baselineIds: baseline,
          remainingIds: baseline, beforePins: cycle ? final : before, finalPins: final,
          ...(cycle ? {} : {afterPinIds: baseline, afterPinStates: pinned}),
          beforeMessageIds: messages.map(v => v.id), finalMessageIds: messages.map(v => v.id),
          selectionEmpty: true, selectionMode: false, surfaceClosed: true, cancelWriteDelta: 0,
          writeDispatchDelta: contract.writeDispatches[cycle], statusReadDispatchDelta: contract.statusReadDispatches[cycle],
          initialPinnedTotal: hiddenPins + cycle, initialPreviewId: initial.requestId, receipts, actions,
          terminalStatus: cycle ? 'idle' : 'success', confirmContrast: [{contrast: 5, pixelCount: 20}, {contrast: 6, pixelCount: 20}],
          'unpin-confirmContrast': [{contrast: 5, pixelCount: 20}, {contrast: 6, pixelCount: 20}]}}};
  });
  return {reports};
}
function rejects(change) { const f = fixture(); change(f.reports[0].memoryBatchPin, f); assert.throws(() => verifyMemoryBatchPin(f)); }
test('accepts correlated two-write two-cycle pin evidence', () => assert.equal(verifyMemoryBatchPin(fixture()).passed, true));
test('keeps backend hidden pin capacity separate from visible page', () => assert.equal(verifyMemoryBatchPin(fixture(5)).passed, true));
test('rejects a missing selected state', () => rejects(s => s.observed.receipts.find(r => r.requestId === 'status-0').states.pop()));
test('rejects an incorrect selected state', () => rejects(s => { s.observed.receipts.find(r => r.requestId === 'status-0').states[0].pinned = false; }));
test('rejects ACK without both new reads', () => rejects(s => { s.observed.receipts = s.observed.receipts.filter(r => r.requestId !== 'list-0'); }));
test('rejects old preview reused as readback', () => rejects(s => { s.observed.actions[0].statusReadId = s.observed.actions[0].previewRequestId; }));
test('rejects a cancelled preview reused for submission', () => rejects(s => { s.observed.actions[0].previewRequestId = s.observed.initialPreviewId; }));
test('rejects duplicate check completion', () => rejects(s => s.checks.push(s.checks[0])));
test('rejects missing final check', () => rejects(s => s.checks.pop()));
test('rejects memory identity reordering', () => rejects(s => { s.observed.remainingIds = [...s.observed.remainingIds].reverse(); }));
test('rejects message identity drift', () => rejects(s => { s.observed.finalMessageIds = s.observed.finalMessageIds.slice(1); }));
test('rejects repeated mouse dispatch', () => rejects(s => { s.inputs[0].signals.mouseDispatchCount = 2; }));
test('rejects incomplete whole-item admission', () => rejects(s => { s.inputs[0].layout.last.fullyVisible = false; }));
test('rejects incorrect capacity arithmetic', () => rejects(s => { s.observed.receipts.find(r => r.requestId === 'write-0').pinned_total_after++; }));
test('rejects extra write during cancel', () => rejects(s => { s.observed.cancelWriteDelta = 1; }));
test('rejects missing actual change count', () => rejects(s => { delete s.observed.actions[0].changed; }));
test('rejects foreign generation response', () => rejects(s => { s.observed.receipts[0].generation++; }));
test('rejects a repeated receipt', () => rejects(s => s.observed.receipts.push(s.observed.receipts[0])));
test('rejects incorrect restart pin state', () => rejects((_s, f) => { f.reports[1].memoryBatchPin.observed.finalPins = {...f.reports[1].memoryBatchPin.observed.finalPins, 'memory-1': false}; }));
test('rejects a write repeated after restart', () => rejects((_s, f) => { f.reports[1].memoryBatchPin.observed.writeDispatchDelta = 1; }));
test('rejects readback that disagrees with visible list', () => rejects(s => { s.observed.receipts.find(r => r.requestId === 'list-0').pins = {...s.observed.receipts.find(r => r.requestId === 'list-0').pins, 'memory-1': false}; }));
test('accepts checkbox toggled once with zero clicked as the original signal contract allows', () => {
  const f = fixture();
  for (const report of f.reports) for (const input of report.memoryBatchPin.inputs) if (input.id) input.signals.clickedSignals = 0;
  assert.equal(verifyMemoryBatchPin(f).passed, true);
});
test('rejects a valid button receipt for the wrong registered control', () => rejects(s => { s.inputs[0].control = 'memoryDeleteSelected'; }));
test('rejects a row identity attached to another input step', () => rejects(s => { s.inputs[8].id = s.observed.targetIds[0]; }));
test('rejects an initial preview with another response command', () => rejects(s => { s.observed.receipts[0].command = 'memory:list'; }));
