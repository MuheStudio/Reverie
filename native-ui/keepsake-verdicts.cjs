'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { verdictReason } = require('./verdict-test-support.cjs');

const KEEPSAKE_CONTRACT = 'reverie.native.keepsake.verdict.v1';
const DEADLINE_MS = 20000;
const COLLECT = 'keepsake:collect';
const PAGE = 'keepsake:page';
const REMOVE = 'keepsake:remove';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

function guard(valid, reason, context) {
  assert(valid, verdictReason(`KEEPSAKE_${reason}`, context));
}

function ordered(times) {
  return times.every((time, index) => whole(time) && (index === 0 || time >= times[index - 1]));
}

function metadataMatches(value, selected) {
  return exact(value, ['id', 'messageId', 'role', 'originalTime', 'contentSha256', 'characters',
    'contentOffset', 'contentNextOffset', 'contentTotalChars']) && identity(value.id) &&
    value.messageId === selected.messageId && value.role === selected.role &&
    value.originalTime === selected.originalTime && value.contentSha256 === selected.contentSha256 &&
    value.characters === selected.characters && value.contentOffset === 0 && value.contentNextOffset === null &&
    value.contentTotalChars === selected.characters;
}

function checkHistory(report, tail, context) {
  const {historyBefore, historyAfter, selected} = tail;
  guard(Array.isArray(historyBefore) && historyBefore.length > 0 && historyBefore.every(row =>
    exact(row, ['id', 'role', 'contentSha256', 'originalTime']) && identity(row.id) &&
    ['user', 'assistant'].includes(row.role) && hash(row.contentSha256) && identity(row.originalTime)) &&
    new Set(historyBefore.map(row => row.id)).size === historyBefore.length &&
    isDeepStrictEqual(historyBefore, historyAfter), 'HISTORY', context);
  guard(Array.isArray(report.messages) && report.messages.every(row => object(row) && typeof row.content === 'string') &&
    isDeepStrictEqual(historyBefore, report.messages.map(row => ({id: row.id, role: row.role,
      contentSha256: digest(row.content), originalTime: row.created_at_utc}))), 'REPORT_HISTORY', context);
  guard(exact(selected, ['messageId', 'role', 'originalTime', 'contentSha256', 'characters']) &&
    identity(selected.messageId) && selected.role === 'user' && identity(selected.originalTime) &&
    hash(selected.contentSha256) && whole(selected.characters) && selected.characters > 0, 'SELECTED_MESSAGE', context);
  const original = report.messages.find(message => message.id === selected.messageId);
  guard(original && original.role === selected.role && original.created_at_utc === selected.originalTime &&
    digest(original.content) === selected.contentSha256 && [...original.content].length === selected.characters,
  'SELECTED_HISTORY_BINDING', context);
}

function checkGeometry(tail, context) {
  const first = tail.cycle === 1;
  const before = tail.rowBefore, after = tail.rowAfter;
  for (const view of [before, after]) {
    guard(exact(view, ['atMs', 'label', 'enabled', 'contentSha256', 'row', 'box', 'text']) &&
      whole(view.atMs) && view.atMs <= tail.elapsedMs && view.contentSha256 === tail.selected.contentSha256 &&
      [view.row, view.box, view.text].every(rect => exact(rect, ['x', 'y', 'width', 'height', 'sceneX', 'sceneY']) &&
        Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0), 'ROW_FIELDS', context);
  }
  guard(before.label === (first ? '收藏' : '已收藏') && before.enabled === first &&
    after.label === (first ? '已收藏' : '收藏') && after.enabled === !first, 'BUTTON_STATE', context);
  guard(['row', 'box', 'text'].every(key => isDeepStrictEqual(before[key], after[key])), 'ROW_GEOMETRY_CHANGED', context);
}

function checkTraffic(tail, context) {
  const base = ['id', 'command', 'scope', 'generation', 'atMs'];
  const {commands, receipts, selected, listView} = tail;
  guard(Array.isArray(commands) && commands.length >= 2 && commands.length <= 16 &&
    commands.every(row => exact(row, [...base, 'fields']) && typeof row.id === 'string' &&
      /^qt_[a-f0-9]{32}$/.test(row.id) && [COLLECT, PAGE, REMOVE].includes(row.command) &&
      row.scope === tail.scopeBefore && row.generation === tail.generationBefore && whole(row.atMs) &&
      row.atMs <= tail.elapsedMs) && new Set(commands.map(row => row.id)).size === commands.length,
  'COMMANDS', context);
  guard(ordered(commands.map(row => row.atMs)), 'COMMAND_ORDER', context);
  guard(Array.isArray(receipts) && receipts.length === commands.length &&
    new Set(receipts.map(row => row?.id)).size === receipts.length, 'RECEIPTS', context);
  const collect = commands.filter(row => row.command === COLLECT);
  const remove = commands.filter(row => row.command === REMOVE);
  guard(collect.length === (tail.cycle === 1 ? 1 : 0) && remove.length === (tail.cycle === 1 ? 0 : 1) &&
    commands.filter(row => row.command === PAGE).length >= 1, 'WRITE_COUNTS', context);
  for (const command of commands) {
    const receipt = receipts.find(row => row?.id === command.id);
    guard(object(receipt) && receipt.command === command.command && receipt.scope === command.scope &&
      receipt.generation === command.generation && whole(receipt.atMs) && receipt.atMs >= command.atMs &&
      receipt.atMs <= tail.elapsedMs && receipt.ok === true, 'RECEIPT_BINDING', context);
    if (command.command === COLLECT) {
      guard(isDeepStrictEqual(command.fields, {message_id: selected.messageId}) &&
        exact(receipt, [...base, 'ok', 'operation', 'item', 'created']) && receipt.operation === 'collect' &&
        receipt.created === true && metadataMatches(receipt.item, selected) && receipt.item.id === listView.item.id,
      'COLLECT_RECEIPT', context);
    } else if (command.command === REMOVE) {
      guard(isDeepStrictEqual(command.fields, {keepsake_id: listView.item.id}) &&
        exact(receipt, [...base, 'ok', 'operation', 'keepsakeId', 'messageId', 'removed']) &&
        receipt.operation === 'remove' && receipt.removed === true && receipt.keepsakeId === listView.item.id &&
        receipt.messageId === selected.messageId, 'REMOVE_RECEIPT', context);
    } else {
      guard(isDeepStrictEqual(command.fields, {offset: 0}) &&
        exact(receipt, [...base, 'ok', 'operation', 'mode', 'items', 'total', 'hasMore']) &&
        receipt.operation === 'page' && receipt.mode === 'list' && receipt.hasMore === false &&
        Array.isArray(receipt.items) && receipt.items.length === receipt.total &&
        (receipt.total === 0 || receipt.total === 1 && metadataMatches(receipt.items[0], selected) &&
          receipt.items[0].id === listView.item.id), 'PAGE_RECEIPT', context);
    }
  }
  guard(receipts.some(row => row.command === PAGE && row.total === 1 && row.atMs <= listView.atMs),
    'LIST_READ_BINDING', context);
  return {collect: collect[0], remove: remove[0]};
}

function checkCycle(report, cycle) {
  const context = {cycle};
  const tail = report?.keepsake;
  guard(report?.cycle === String(cycle) && object(tail) && tail.cycle === cycle && tail.passed === true &&
    tail.error === '', 'CYCLE', context);
  guard(exact(tail, ['passed', 'error', 'cycle', 'deadlineMs', 'elapsedMs', 'tailStartEpochMs', 'tailEndEpochMs',
    'scopeBefore', 'scopeAfter', 'generationBefore', 'generationAfter', 'inputs', 'searchAtMs', 'commands', 'receipts',
    'chatSendDispatches', 'historyBefore', 'historyAfter', 'keepsakeFilesBefore', 'keepsakeFilesAfter', 'selected',
    'rowBefore', 'rowAfter', 'listView', 'emptyView', 'removalDialog', 'lastObservation']), 'REPORT_FIELDS', context);
  guard(tail.deadlineMs === DEADLINE_MS && whole(tail.elapsedMs) && tail.elapsedMs < DEADLINE_MS &&
    whole(tail.tailStartEpochMs) && tail.tailStartEpochMs > 0 && whole(tail.tailEndEpochMs) &&
    tail.tailEndEpochMs >= tail.tailStartEpochMs &&
    Math.abs(tail.tailEndEpochMs - tail.tailStartEpochMs - tail.elapsedMs) <= 100, 'DEADLINE', context);
  guard(typeof tail.scopeBefore === 'string' && /^[A-Za-z0-9_-]{4,128}:\d+:[a-f0-9]{64}$/.test(tail.scopeBefore) &&
    tail.scopeBefore === tail.scopeAfter && whole(tail.generationBefore) && tail.generationBefore > 0 &&
    tail.generationAfter === tail.generationBefore, 'SCOPE', context);
  guard(report.chatImage?.passed === true && whole(report.chatImage.tailEndEpochMs) &&
    report.chatImage.tailEndEpochMs <= tail.tailStartEpochMs && report.chatImage.scopeAfter === tail.scopeBefore &&
    report.chatImage.generationAfter === tail.generationBefore, 'AFTER_W18', context);
  guard(tail.chatSendDispatches === 0, 'SEND_DISPATCH', context);
  guard(tail.keepsakeFilesBefore === 0 && tail.keepsakeFilesAfter === 0, 'PLAINTEXT_FILE', context);
  checkHistory(report, tail, context);
  checkGeometry(tail, context);
  guard(exact(tail.listView, ['atMs', 'count', 'item', 'displayedContentSha256', 'removeEnabled']) &&
    whole(tail.listView.atMs) && tail.listView.count === 1 && metadataMatches(tail.listView.item, tail.selected) &&
    tail.listView.displayedContentSha256 === tail.selected.contentSha256 && tail.listView.removeEnabled === true,
  'LIST_VIEW', context);
  const first = cycle === 1;
  const controls = first ? ['nav-reading', `keepsakeMessage-${tail.selected.messageId}`,
    'scene-navigation-search', 'search-result-keepsake-list'] : ['nav-reading', 'scene-navigation-search',
    'search-result-keepsake-list', `keepsakeRemove-${tail.listView.item.id}`, 'keepsakeRemoveConfirm', 'nav-reading'];
  guard(Array.isArray(tail.inputs) && tail.inputs.length === controls.length && tail.inputs.every((row, index) =>
    exact(row, ['control', 'atMs', 'mouseDispatchCount', 'clickedSignals', 'hitAccepted']) && row.control === controls[index] &&
    row.mouseDispatchCount === 1 && row.clickedSignals === 1 && row.hitAccepted === true && whole(row.atMs)),
  'INPUTS', context);
  const {collect, remove} = checkTraffic(tail, context);
  const times = tail.inputs.map(row => row.atMs);
  if (first) {
    guard(exact(tail.emptyView, []) && exact(tail.removalDialog, []) &&
      ordered([times[0], tail.rowBefore.atMs, times[1], collect.atMs, tail.rowAfter.atMs, times[2], tail.searchAtMs,
        times[3], tail.listView.atMs, tail.elapsedMs]), 'EVENT_ORDER', context);
  } else {
    guard(exact(tail.emptyView, ['atMs', 'count', 'visible']) && tail.emptyView.count === 0 &&
      tail.emptyView.visible === true && exact(tail.removalDialog, ['atMs', 'cancelLabel', 'confirmLabel', 'warning', 'visible']) &&
      tail.removalDialog.cancelLabel === '取消' && tail.removalDialog.confirmLabel === '移除' &&
      tail.removalDialog.warning === '移除后不能恢复' &&
      tail.removalDialog.visible === true, 'REMOVAL_DISPLAY', context);
    guard(ordered([times[0], tail.rowBefore.atMs, times[1], tail.searchAtMs, times[2], tail.listView.atMs,
      times[3], tail.removalDialog.atMs, times[4], remove.atMs, tail.emptyView.atMs, times[5], tail.rowAfter.atMs,
      tail.elapsedMs]), 'EVENT_ORDER', context);
  }
  guard(object(tail.lastObservation) && whole(tail.lastObservation.phase) &&
    whole(tail.lastObservation.phaseElapsedMs) && whole(tail.lastObservation.frame) &&
    Number.isFinite(tail.lastObservation.viewportWidth) && tail.lastObservation.viewportWidth > 0 &&
    Number.isFinite(tail.lastObservation.viewportHeight) && tail.lastObservation.viewportHeight > 0,
  'LAST_OBSERVATION', context);
  return tail;
}

function verifyKeepsake(reports, modelCallTiming, requests) {
  guard(Array.isArray(reports) && reports.length === 2, 'CYCLES');
  const first = checkCycle(reports[0], 1);
  const restart = checkCycle(reports[1], 2);
  guard(first.tailEndEpochMs < restart.tailStartEpochMs && first.scopeBefore === restart.scopeBefore &&
    isDeepStrictEqual(first.selected, restart.selected) && isDeepStrictEqual(first.listView.item, restart.listView.item) &&
    isDeepStrictEqual(first.historyAfter, restart.historyBefore), 'RESTART_PERSISTENCE');
  guard(Array.isArray(modelCallTiming) && modelCallTiming.every(call => object(call) &&
    (call.cycle === 1 || call.cycle === 2) && whole(call.receivedEpochMs)), 'MODEL_TRACE');
  for (const tail of [first, restart]) {
    guard(!modelCallTiming.some(call => call.receivedEpochMs >= tail.tailStartEpochMs &&
      call.receivedEpochMs <= tail.tailEndEpochMs), 'MODEL_DURING_TAIL', {cycle: tail.cycle});
  }
  guard(requests === 9 && modelCallTiming.length === 9, 'MODEL_COUNT');
  return {passed: true, contract: KEEPSAKE_CONTRACT, modelRequestsAdded: 0, contentCollected: false,
    cycles: [first, restart].map(tail => ({cycle: tail.cycle, elapsedMs: tail.elapsedMs, userInputs: tail.inputs.length,
      commandCount: tail.commands.length, receiptCount: tail.receipts.length, messageId: tail.selected.messageId,
      keepsakeId: tail.listView.item.id, contentSha256: tail.selected.contentSha256,
      historyCount: tail.historyAfter.length, sendDispatches: tail.chatSendDispatches,
      keepsakeFiles: tail.keepsakeFilesAfter, rowBefore: tail.rowBefore, rowAfter: tail.rowAfter,
      listCount: tail.listView.count, finalListCount: tail.cycle === 1 ? tail.listView.count : tail.emptyView.count}))};
}

module.exports = {KEEPSAKE_CONTRACT, verifyKeepsake};
