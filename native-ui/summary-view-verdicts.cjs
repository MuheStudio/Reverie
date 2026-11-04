'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// This contract extends the ordinary P1-memory run only. None of the helpers
// imports the application, starts a process, reads a file or changes evidence.
const SUMMARY_VIEW_SCHEMA = 'reverie.qt.summary-view.v1';
const SUMMARY_ID = 'summary_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SUMMARY_MARKER = 'SUMMARY_VIEW_R3_MARKER';
const SUMMARY_BODY = 'SUMMARY_VIEW_R3_MARKER：窗边的合成回忆。<b>这是纯文本</b>\n本段仅用于隔离查看。';
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const SUMMARY_BODY_SHA256 = sha256(SUMMARY_BODY);
const SUMMARY_BODY_CHARACTERS = Array.from(SUMMARY_BODY).length;
const SOURCE_CONTRACT = 'reverie.conversation-summary.v1';
const COMMON_CHECKS = Object.freeze(['initial-detail-idle-empty', 'opened-current-directory-read-access',
  'fresh-directory-refresh-metadata-only', 'one-correlated-summary-detail-read', 'plain-readonly-visible-body',
  'local-clear-zero-commands', 'management-tab-returned', 'closed-preserves-snapshots']);
const SUMMARY_VIEW_CHECKS = Object.freeze([
  Object.freeze([...COMMON_CHECKS.slice(0, 5), 'narrow-plain-readonly-body', ...COMMON_CHECKS.slice(5)]),
  COMMON_CHECKS
]);
const SUMMARY_VIEW_INPUTS = Object.freeze(['nav-memory', 'archive-open-memories', 'memoryTab-summary',
  'summaryDirectoryRefresh', `summaryDirectoryEntry-${SUMMARY_ID}`, 'summaryDetailClear',
  'memoryTab-memories', 'memory-close']);
const SUMMARY_VIEW_CONTRACT = Object.freeze({ schema: SUMMARY_VIEW_SCHEMA, summaryId: SUMMARY_ID,
  marker: SUMMARY_MARKER, bodySha256: SUMMARY_BODY_SHA256, bodyCharacters: SUMMARY_BODY_CHARACTERS,
  bodyUtf16Length: SUMMARY_BODY.length, context: Object.freeze({ summaryView: true }),
  deadlineMs: 20000, inputDeadlineMs: 4000, readDeadlineMs: 10000, closeDeadlineMs: 4000,
  checks: SUMMARY_VIEW_CHECKS, inputs: SUMMARY_VIEW_INPUTS,
  directoryRefreshesPerCycle: Object.freeze([1, 1]), bodyReadsPerCycle: Object.freeze([1, 1]),
  seedsPerCycle: Object.freeze([1, 0]), addedHttpRequests: 0, addedRecallQueries: 0 });

function summaryModelMessageMetadata(messages) {
  // Inspect actual model-message contents in memory, returning booleans only.
  // Unknown input never becomes a claimed absence in the acceptance report.
  const texts = [];
  let known = Array.isArray(messages);
  if (known) for (const message of messages) {
    if (!message || typeof message !== 'object' || !Object.hasOwn(message, 'content')) { known = false; break; }
    if (typeof message.content === 'string') texts.push(message.content);
    else if (Array.isArray(message.content) && message.content.every(part => part &&
      part.type === 'text' && typeof part.text === 'string')) texts.push(...message.content.map(part => part.text));
    else { known = false; break; }
  }
  return { summaryMessageContentsKnown: known,
    summaryMarkerPresent: known ? texts.some(text => text.includes(SUMMARY_MARKER)) : null,
    conversationSummariesSectionPresent: known ? texts.some(text => /<\/?conversation_summaries(?:\s[^<>]*)?>/i.test(text)) : null };
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
function record(value, name) { assert(isRecord(value), `${name} metadata missing`); return value; }
function exactKeys(value, keys, name) {
  record(value, name);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${name} fields changed`);
}
function requestId(value, name) { assert(typeof value === 'string' && ID.test(value), `${name} request identity missing or invalid`); }
function hash(value, name) { assert(typeof value === 'string' && HASH.test(value), `${name} digest missing or invalid`); }
function integer(value, minimum, name) { assert(Number.isSafeInteger(value) && value >= minimum, `${name} integer missing or invalid`); }
function trueFields(value, fields, name) {
  for (const field of fields) assert.equal(value[field], true, `${name}.${field} is not verified`);
}
const TABLE_SNAPSHOT_PATHS = new Set(['before', 'after'].flatMap(phase => ['kernelTables', 'memoryTables']
  .map(kind => `summary_view_seeded.snapshots.${phase}.${kind}`)));
function tableSnapshots(value, name) {
  const tables = record(value, name);
  assert(Object.keys(tables).length > 0, `${name} snapshot is empty`);
  for (const [table, entry] of Object.entries(tables)) {
    assert(/^[a-z][a-z0-9_]*$/.test(table), 'Seed snapshot table identity invalid');
    exactKeys(entry, ['count', 'sha256'], `${name}.${table}`);
    integer(entry.count, 0, `${name}.${table}.count`);
    hash(entry.sha256, `${name}.${table}.sha256`);
  }
}
function metadataOnly(value, name = 'summaryView') {
  if (!value || typeof value !== 'object') return;
  // A table literally named "messages" is legitimate only at these four
  // paths, and only as its strict {count, sha256} digest. Never allow rows.
  if (TABLE_SNAPSHOT_PATHS.has(name)) { tableSnapshots(value, name); return; }
  for (const [key, child] of Object.entries(value)) {
    assert(!['text', 'body', 'content', 'messages', 'prompt', 'rawResponse', 'rawReply'].includes(key),
      `${name} contains unregistered content`);
    metadataOnly(child, `${name}.${key}`);
  }
}
function disabledConsent(value, name) {
  for (const field of ['enabled', 'grantEnabled', 'grantAcknowledged', 'policyAllowed'])
    assert.equal(value[field], false, `${name}.${field} is not explicitly disabled`);
  trueFields(value, ['statusDisabled', 'scopeMatches'], name);
}
function sourceMetadata(value, name) {
  assert.equal(value.summaryId, SUMMARY_ID, `${name} summary identity changed`);
  hash(value.sourceDigest, `${name}.sourceDigest`);
  hash(value.sourceIdsSha256, `${name}.sourceIdsSha256`);
  integer(value.sourceMessageCount, 1, `${name}.sourceMessageCount`);
  assert(value.sourceMessageCount <= 40, `${name} source exceeds the production bound`);
  integer(value.firstSequence, 1, `${name}.firstSequence`);
  integer(value.lastSequence, value.firstSequence, `${name}.lastSequence`);
  assert(value.lastSequence - value.firstSequence + 1 >= value.sourceMessageCount, `${name} source sequence bound invalid`);
}
const SOURCE_FIELDS = Object.freeze(['summaryId', 'sourceDigest', 'sourceIdsSha256',
  'sourceMessageCount', 'firstSequence', 'lastSequence']);
function sameSource(actual, expected, name) {
  sourceMetadata(actual, name);
  for (const field of SOURCE_FIELDS) assert.equal(actual[field], expected[field], `${name}.${field} differs from authenticated source`);
}
function bodyMetadata(value, name) {
  assert.equal(value.bodySha256, SUMMARY_BODY_SHA256, `${name} body digest changed`);
  assert.equal(value.bodyCharacters, SUMMARY_BODY_CHARACTERS, `${name} body character count changed`);
}
function scopeMetadata(value, observed, name) {
  assert.equal(value.scope, observed.scope, `${name} scope changed`);
  assert.equal(value.generation, observed.generation, `${name} generation changed`);
  // Status has no conversation_id in its actual response; the normalized
  // current directory below supplies that context. Preserve the omission.
  assert.equal(value.conversationId, name === 'directory' ? null : 'dream-room', `${name} conversation changed`);
  assert(typeof value.personaId === 'string' && value.personaId.length > 0, `${name} persona missing`);
  integer(value.personaEpoch, 1, `${name}.personaEpoch`);
  assert(typeof value.personaFingerprint === 'string' && value.personaFingerprint.length > 0, `${name} persona fingerprint missing`);
  assert.equal(`${value.personaId}:${value.personaEpoch}:${value.personaFingerprint}`, observed.scope,
    `${name} returned persona does not match the current bridge scope`);
}
const RAW_COMMON = Object.freeze(['requestId', 'command', 'generation', 'scope', 'ok', 'operation',
  'conversationId', 'personaId', 'personaEpoch', 'personaFingerprint', ...SOURCE_FIELDS, 'contractVersion']);
const RAW_DIRECTORY = Object.freeze([...RAW_COMMON, 'status', 'enabled', 'authorized', 'summaryTotal', 'hasMore', 'bodyFieldPresent']);
const RAW_DETAIL = Object.freeze([...RAW_COMMON, 'bodySha256', 'bodyCharacters', 'bodyUtf16Length', 'bodyMatchesFixture']);
const DIRECTORY_KEYS = Object.freeze(['ok', 'directoryReady', 'conversationId', 'enabled', 'authorized', 'status', 'summaryTotal', 'hasMore', 'summaries']);
const ENTRY_KEYS = Object.freeze(['summary_id', 'sourceDigest', 'messageIds', 'firstSequence', 'lastSequence', 'contractVersion']);

function directorySnapshot(value, source, messageIds, name) {
  exactKeys(value, DIRECTORY_KEYS, name);
  trueFields(value, ['ok', 'directoryReady'], name);
  assert.equal(value.conversationId, 'dream-room', `${name} conversation changed`);
  assert.equal(value.enabled, false, `${name} generation is enabled`);
  assert.equal(value.authorized, false, `${name} has fee authorization`);
  assert.equal(value.status, 'disabled', `${name} generation status changed`);
  assert.equal(value.summaryTotal, 1, `${name} total changed`);
  assert.equal(value.hasMore, false, `${name} unexpectedly has more entries`);
  assert(Array.isArray(value.summaries) && value.summaries.length === 1, `${name} directory count changed`);
  const entry = value.summaries[0];
  exactKeys(entry, ENTRY_KEYS, `${name}.entry`);
  assert.equal(entry.summary_id, SUMMARY_ID, `${name} entry identity changed`);
  assert.equal(entry.contractVersion, SOURCE_CONTRACT, `${name} source contract changed`);
  assert(Array.isArray(entry.messageIds) && entry.messageIds.length === source.sourceMessageCount &&
    entry.messageIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512) &&
    new Set(entry.messageIds).size === entry.messageIds.length, `${name} source identities missing or duplicated`);
  const sourceOrder = messageIds.filter(id => entry.messageIds.includes(id));
  assert.deepEqual(entry.messageIds, sourceOrder, `${name} source identities differ from original message order`);
  assert.deepEqual(entry.messageIds, messageIds.slice(0, entry.messageIds.length), `${name} source is not the original first exchange`);
  sameSource({ summaryId: entry.summary_id, sourceDigest: entry.sourceDigest,
    sourceIdsSha256: sha256(JSON.stringify(entry.messageIds)), sourceMessageCount: entry.messageIds.length,
    firstSequence: entry.firstSequence, lastSequence: entry.lastSequence }, source, name);
  return entry;
}
function immutableSnapshots(snapshots) {
  exactKeys(snapshots, ['before', 'after'], 'seed.snapshots');
  for (const phase of ['before', 'after']) {
    exactKeys(snapshots[phase], ['kernelTables', 'memoryTables', 'messageIdsSha256', 'memoryIdsSha256',
      'messageCount', 'memoryCount'], `seed.snapshots.${phase}`);
    assert.deepEqual([snapshots[phase].messageCount, snapshots[phase].memoryCount], [39, 127], 'Seed snapshot original counts changed');
    hash(snapshots[phase].messageIdsSha256, `seed.snapshots.${phase}.messageIdsSha256`);
    hash(snapshots[phase].memoryIdsSha256, `seed.snapshots.${phase}.memoryIdsSha256`);
    for (const kind of ['kernelTables', 'memoryTables'])
      tableSnapshots(snapshots[phase][kind], `seed.snapshots.${phase}.${kind}`);
    const fullMemoryRows = snapshots[phase].memoryTables.memory_records?.count;
    // The ordinary edit retains a superseded revision. Active IDs are counted
    // separately above; all physical rows must still survive byte-for-byte.
    assert(snapshots[phase].kernelTables.messages?.count === 39 && Number.isSafeInteger(fullMemoryRows) && fullMemoryRows >= 127,
      'Seed critical table row counts changed or were omitted');
  }
  assert.deepEqual(Object.keys(snapshots.after.kernelTables).sort(), Object.keys(snapshots.before.kernelTables).sort(),
    'Synthetic seeding added or removed a table');
  for (const [table, before] of Object.entries(snapshots.before.kernelTables)) {
    const after = snapshots.after.kernelTables[table];
    if (['conversation_summary_attempts', 'conversation_summary_items'].includes(table)) {
      assert.deepEqual([before.count, after.count], [0, 1], 'Synthetic summary table did not receive exactly one row');
      assert.notEqual(before.sha256, after.sha256, 'Synthetic summary table content did not change');
    } else assert.deepEqual(after, before, 'Synthetic seeding changed non-summary kernel tables');
  }
  assert(['conversation_summary_attempts', 'conversation_summary_items']
    .every(table => Object.hasOwn(snapshots.before.kernelTables, table)), 'Seed snapshots omitted summary tables');
  assert.deepEqual(snapshots.after.memoryTables, snapshots.before.memoryTables, 'Synthetic seeding changed memory tables');
  for (const field of ['messageIdsSha256', 'memoryIdsSha256'])
    assert.equal(snapshots.after[field], snapshots.before[field], 'Synthetic seeding changed original ID order');
}

const EVENT_COMMON = Object.freeze(['schema', 'event', 'cycle', 'monotonic_ns']);
const CONSENT_FIELDS = Object.freeze(['enabled', 'grantEnabled', 'grantAcknowledged', 'policyAllowed', 'statusDisabled', 'scopeMatches']);
const EVENT_SOURCE = Object.freeze([...SOURCE_FIELDS, 'bodySha256', 'bodyCharacters']);
const SUMMARY_EVENT_FIELDS = Object.freeze({
  summary_view_seeded: Object.freeze([...EVENT_SOURCE, ...CONSENT_FIELDS, 'syntheticFixture', 'naturalGeneration', 'causeRequestId',
    'requestedCount', 'deletedCount', 'messageCount', 'memoryCount', 'summaryAttemptCount', 'summaryItemCount',
    'messageIdsUnchanged', 'memoryIdsUnchanged', 'kernelNonSummaryUnchanged', 'memoryTablesUnchanged',
    'otherSummaryTablesUnchanged', 'beforeAfterMatches', 'snapshots']),
  summary_view_restart_validated: Object.freeze([...EVENT_SOURCE, ...CONSENT_FIELDS, 'seeded', 'syntheticFixture', 'naturalGeneration',
    'messageCount', 'memoryCount', 'summaryAttemptCount', 'summaryItemCount', 'messageIdsSha256', 'memoryIdsSha256']),
  summary_view_dispatched: Object.freeze(['requestId', 'readCount', 'summaryId', 'idMatches', ...CONSENT_FIELDS]),
  summary_view_result: Object.freeze(['requestId', 'readCount', ...EVENT_SOURCE, ...CONSENT_FIELDS,
    'ok', 'idMatches', 'operationMatches', 'fixtureMatches', 'sourceMatches', 'statusMatches']),
  summary_view_status_dispatched: Object.freeze(['requestId', ...CONSENT_FIELDS]),
  summary_view_status_result: Object.freeze(['requestId', ...CONSENT_FIELDS, 'ok', 'operationMatches', 'status',
    'resultEnabled', 'resultAuthorized', 'resultStatusDisabled', 'activeCount', 'summaryTotal', 'fixturePresent', ...SOURCE_FIELDS])
});

function summaryViewVerdicts({ reports, events, modelCalls, requests }) {
  assert(Array.isArray(reports) && reports.length === 2, 'Summary viewing requires both original cycles');
  assert(Array.isArray(events) && Array.isArray(modelCalls), 'Authenticated summary/model evidence missing');
  const selectedEvents = events.filter(event => typeof event?.event === 'string' && event.event.startsWith('summary_view_'));
  for (const event of selectedEvents) {
    assert(Object.hasOwn(SUMMARY_EVENT_FIELDS, event.event), 'Unregistered summary observer event');
    exactKeys(event, [...EVENT_COMMON, ...SUMMARY_EVENT_FIELDS[event.event]], event.event);
    assert.equal(event.schema, 'reverie.qt.p1-memory-metadata.v1', 'Summary observer schema changed');
    assert([1, 2].includes(event.cycle), 'Summary observer cycle changed');
    assert(Number.isFinite(event.monotonic_ns) && event.monotonic_ns >= 0, 'Summary observer time missing');
    metadataOnly(event, event.event);
  }
  const matches = name => selectedEvents.filter(event => event.event === name);
  const onePerCycle = name => {
    const values = matches(name);
    assert.deepEqual(values.map(event => event.cycle), [1, 2], `${name} must occur once per cycle`);
    return values;
  };
  const seeds = matches('summary_view_seeded'), restarts = matches('summary_view_restart_validated');
  assert.deepEqual(seeds.map(event => event.cycle), [1], 'Summary fixture must seed exactly once after first-cycle deletion');
  assert.deepEqual(restarts.map(event => event.cycle), [2], 'Restart must validate the existing summary without seeding');
  const seed = seeds[0], restart = restarts[0];
  disabledConsent(seed, 'seed'); disabledConsent(restart, 'restart');
  sourceMetadata(seed, 'seed'); sameSource(restart, seed, 'restart');
  bodyMetadata(seed, 'seed'); bodyMetadata(restart, 'restart');
  for (const value of [seed, restart]) {
    assert.equal(value.syntheticFixture, true, 'Summary must be the declared isolated synthetic fixture');
    assert.equal(value.naturalGeneration, false, 'Synthetic summary cannot claim natural generation');
    assert.deepEqual([value.messageCount, value.memoryCount, value.summaryAttemptCount, value.summaryItemCount],
      [39, 127, 1, 1], 'Summary fixture changed the original counts');
  }
  assert.equal(restart.seeded, false, 'Restart reseeded the summary');
  requestId(seed.causeRequestId, 'seed.causeRequestId');
  assert.equal(seed.causeRequestId, reports[0].memoryBatchDelete?.observed?.requestId,
    'Summary fixture was not caused by the successful registered batch delete');
  assert.deepEqual([seed.requestedCount, seed.deletedCount], [3, 3], 'Summary fixture followed another deletion');
  trueFields(seed, ['messageIdsUnchanged', 'memoryIdsUnchanged', 'kernelNonSummaryUnchanged',
    'memoryTablesUnchanged', 'otherSummaryTablesUnchanged', 'beforeAfterMatches'], 'seed');
  immutableSnapshots(seed.snapshots);
  const originalIds = seed.snapshots.after;
  assert.equal(restart.messageIdsSha256, originalIds.messageIdsSha256, 'Restart changed original message identities');
  assert.equal(restart.memoryIdsSha256, originalIds.memoryIdsSha256, 'Restart changed surviving memory identities');
  const dispatches = onePerCycle('summary_view_dispatched'), results = onePerCycle('summary_view_result');
  const statusDispatches = matches('summary_view_status_dispatched'), statusResults = matches('summary_view_status_result');
  const allIds = [];
  for (const [index, report] of reports.entries()) {
    const cycle = index + 1, segment = record(report.summaryView, `cycle ${cycle}.summaryView`);
    assert.equal(segment.schema, SUMMARY_VIEW_SCHEMA, 'Summary GUI schema changed');
    assert.equal(segment.passed, true, 'Summary GUI segment failed');
    assert.equal(segment.contentCollected, false, 'Summary GUI segment collected content');
    assert.equal(segment.cycle, cycle, 'Summary GUI cycle changed');
    assert.deepEqual([segment.deadlineMs, segment.inputDeadlineMs, segment.readDeadlineMs, segment.closeDeadlineMs],
      [20000, 4000, 10000, 4000], 'Summary GUI deadlines changed');
    assert(Number.isFinite(segment.elapsedMs) && segment.elapsedMs >= 0 && segment.elapsedMs < 20000,
      'Summary viewing exceeded its separate deadline');
    assert(Array.isArray(segment.checks), 'Summary GUI checks missing');
    assert.deepEqual(segment.checks.map(check => check.name), SUMMARY_VIEW_CHECKS[index], 'Frozen summary checks changed');
    assert(segment.checks.every(check => check.passed === true), 'A summary GUI check failed');
    metadataOnly(segment);
    const observed = record(segment.observed, 'summaryView.observed');
    assert(typeof observed.scope === 'string' && observed.scope.length > 0, 'Summary GUI scope unknown');
    integer(observed.generation, 0, 'summaryView.generation');
    trueFields(observed, ['initialDetailIdle', 'initialDetailEmpty', 'afterOpeningDetailIdle', 'afterOpeningDetailEmpty',
      'readAllowed', 'directoryValidated', 'bodyMatchesFixture', 'bodyReadOnly', 'bodyPlainText', 'bodyVisible',
      'bodyWidthFits', 'clearIdle', 'clearEmpty', 'noAiOrSettingsWrites', 'surfaceClosed',
      'finalDetailIdle', 'finalDetailEmpty'], 'summaryView.observed');
    assert.equal(observed.initialBodyCharacters, 0, 'Initial summary detail retained a body');
    assert.equal(observed.enabled, false, 'Summary generation was enabled');
    assert.equal(observed.authorized, false, 'Summary generation received fee authorization');
    assert.equal(observed.fixtureSummaryId, SUMMARY_ID, 'GUI selected another summary');
    assert.deepEqual([observed.directoryCount, observed.directoryTotal, observed.directoryHasMore], [1, 1, false], 'Summary directory count changed');
    assert.deepEqual([observed.directoryCommandDelta, observed.detailCommandDelta, observed.segmentCommandDelta,
      observed.directoryResponseCount, observed.detailResponseCount, observed.clearCommandDelta,
      observed.otherResponseCount, observed.finalPendingCount],
    [1, 1, 2, 1, 1, 0, 0, 0], 'Summary refresh/read/clear dispatch counts changed');
    for (const kind of ['directory', 'detail']) {
      requestId(observed[`${kind}RequestId`], `${kind}RequestId`);
      allIds.push(observed[`${kind}RequestId`]);
    }
    requestId(observed.directoryBeforeRequestId, 'directoryBeforeRequestId');
    assert.notEqual(observed.directoryRequestId, observed.directoryBeforeRequestId, 'Directory refresh reused the opening request');
    assert.notEqual(observed.detailRequestId, observed.directoryBeforeRequestId, 'Body read reused the opening request');
    const rawDirectory = record(observed.rawDirectory, 'rawDirectory'), rawDetail = record(observed.rawDetail, 'rawDetail');
    exactKeys(rawDirectory, RAW_DIRECTORY, 'rawDirectory'); exactKeys(rawDetail, RAW_DETAIL, 'rawDetail');
    for (const [kind, raw] of [['directory', rawDirectory], ['detail', rawDetail]]) {
      assert.equal(raw.requestId, observed[`${kind}RequestId`], `${kind} raw reply identity differs from current GUI request`);
      assert.equal(raw.command, kind === 'directory' ? 'summary:status' : 'summary:get', `${kind} raw reply command changed`);
      assert.equal(raw.ok, true, `${kind} raw reply failed`);
      assert.equal(raw.operation, kind === 'directory' ? 'status' : 'detail', `${kind} raw reply operation changed`);
      scopeMetadata(raw, observed, kind); sameSource(raw, seed, kind);
      assert.equal(raw.contractVersion, SOURCE_CONTRACT, `${kind} raw source contract changed`);
    }
    for (const field of ['personaId', 'personaEpoch', 'personaFingerprint'])
      assert.equal(rawDetail[field], rawDirectory[field], `Detail ${field} differs from current directory scope`);
    assert.deepEqual([rawDirectory.status, rawDirectory.enabled, rawDirectory.authorized, rawDirectory.summaryTotal,
      rawDirectory.hasMore, rawDirectory.bodyFieldPresent], ['disabled', false, false, 1, false, false],
    'Raw directory contained content or generation consent changed');
    bodyMetadata(rawDetail, 'rawDetail');
    assert.equal(rawDetail.bodyUtf16Length, SUMMARY_BODY.length, 'Raw detail UTF-16 length changed');
    assert.equal(rawDetail.bodyMatchesFixture, true, 'Raw detail body differs from isolated fixture');
    validateBodyPresentation(observed, 'body', [1380, 900]);
    const messageIds = report.messages?.map(message => message.id);
    assert(Array.isArray(messageIds) && messageIds.length === 39 && new Set(messageIds).size === 39,
      'Original 39 message identities missing');
    assert.equal(sha256(JSON.stringify(messageIds)), originalIds.messageIdsSha256, 'Summary segment changed original message identities/order');
    directorySnapshot(observed.directoryBefore, seed, messageIds, 'directoryBefore');
    directorySnapshot(observed.directoryAfter, seed, messageIds, 'directoryAfter');
    assert.deepEqual(observed.directoryAfter, observed.directoryBefore, 'Explicit refresh changed directory metadata');
    validatePreservation(observed, report, originalIds, cycle);
    validateInputs(segment.inputs);
    if (index === 0) validateBodyPresentation(observed, 'narrowBody', [760, 650]);
    const dispatch = dispatches[index], response = results[index];
    for (const value of [dispatch, response]) {
      disabledConsent(value, `cycle ${cycle} body observer`);
      assert.equal(value.requestId, observed.detailRequestId, 'Authenticated summary body request differs from GUI request');
      assert.equal(value.readCount, 1, 'Authenticated body read repeated');
      assert.equal(value.summaryId, SUMMARY_ID, 'Authenticated body read selected another summary');
    }
    assert.equal(dispatch.idMatches, true, 'Authenticated body read identity invalid');
    trueFields(response, ['ok', 'idMatches', 'operationMatches', 'fixtureMatches', 'sourceMatches', 'statusMatches'], 'summary body result');
    sameSource(response, rawDetail, 'authenticated body result'); bodyMetadata(response, 'authenticated body result');
    const ownDispatch = statusDispatches.filter(event => event.cycle === cycle && event.requestId === observed.directoryRequestId);
    const ownResult = statusResults.filter(event => event.cycle === cycle && event.requestId === observed.directoryRequestId);
    assert.equal(ownDispatch.length, 1, 'Explicit directory refresh lacks one authenticated dispatch');
    assert.equal(ownResult.length, 1, 'Explicit directory refresh lacks one authenticated result');
    const status = ownResult[0];
    disabledConsent(ownDispatch[0], 'directory dispatch'); disabledConsent(status, 'directory result');
    trueFields(status, ['ok', 'operationMatches', 'fixturePresent', 'resultStatusDisabled'], 'directory result');
    assert.deepEqual([status.status, status.resultEnabled, status.resultAuthorized, status.activeCount, status.summaryTotal],
      ['disabled', false, false, 1, 1], 'Authenticated directory result changed generation consent or counts');
    sameSource(status, rawDirectory, 'authenticated directory result');
    validateOpeningReads(observed, cycle, statusResults, seed);
    assert(ownDispatch[0].monotonic_ns <= status.monotonic_ns && status.monotonic_ns <= dispatch.monotonic_ns &&
      dispatch.monotonic_ns <= response.monotonic_ns, 'Summary directory/body evidence order changed');
    assert((cycle === 1 ? seed : restart).monotonic_ns <= dispatch.monotonic_ns, 'Body read preceded fixture validation');
  }
  assert.equal(new Set(allIds).size, 4, 'Summary reads reused a request identity across commands or cycles');
  const recallIds = reports.map(report => report.memoryRecall?.observed?.requestId);
  assert(recallIds.every(id => typeof id === 'string' && ID.test(id)) && new Set([...recallIds, ...allIds]).size === 6,
    'Summary reads reused a recall request identity');
  assert.equal(events.filter(event => event.event === 'recall_query_dispatched').length, 2, 'Summary viewing added a recall query');
  assert.equal(requests, 7, 'Summary viewing changed the original HTTP total');
  assert.equal(modelCalls.length, 7, 'Summary viewing changed the original model calls');
  for (const [cycle, expected] of [[1, [1, 1, 2, 1, 1]], [2, [1, 0, 0, 0, 0]]])
    assert.deepEqual(['probe', 'chat', 'reading-fixture', 'stop-fixture', 'combined-fixture']
      .map(kind => modelCalls.filter(call => call.cycle === cycle && call.kind === kind).length), expected,
    'Summary viewing changed original HTTP requests in a cycle');
  for (const call of modelCalls) {
    assert.equal(call.summaryMessageContentsKnown, true, 'Actual model-message contents were not observed');
    assert.equal(call.summaryMarkerPresent, false, 'Summary marker reached an actual model request');
    assert.equal(call.conversationSummariesSectionPresent, false, 'Conversation-summary section reached an actual model request');
  }
  return { schema: 'reverie.qt.summary-view-verdict.v1', passed: true, contentCollected: false,
    checkCounts: reports.map(report => report.summaryView.checks.length), summaryId: SUMMARY_ID,
    bodySha256: SUMMARY_BODY_SHA256, bodyCharacters: SUMMARY_BODY_CHARACTERS,
    sourceDigest: seed.sourceDigest, sourceIdsSha256: seed.sourceIdsSha256, sourceMessageCount: seed.sourceMessageCount,
    firstSequence: seed.firstSequence, lastSequence: seed.lastSequence,
    originalMessageIdsSha256: originalIds.messageIdsSha256, survivingMemoryIdsSha256: originalIds.memoryIdsSha256,
    readIdentities: reports.map((report, index) => ({ cycle: index + 1, scope: report.summaryView.observed.scope,
      generation: report.summaryView.observed.generation, directoryRequestId: report.summaryView.observed.directoryRequestId,
      detailRequestId: report.summaryView.observed.detailRequestId })),
    seedsPerCycle: [1, 0], bodyReadsPerCycle: [1, 1], explicitDirectoryRefreshesPerCycle: [1, 1],
    addedHttpRequests: 0, addedRecallQueries: 0, originalMessageCount: 39, survivingMemoryCount: 127,
    actualModelMessagesExcludeSummary: true };
}

function validatePreservation(value, report, originalIds, cycle) {
  // Full local comparisons are accompanied by the original run's ID arrays;
  // opening may authoritatively reload its first 100 of the 127 survivors.
  trueFields(value, ['managementStateMatches', 'managementFeedbackMatches', 'managementCandidatesMatch',
    'managementPagingMatches'], 'summary preservation');
  assert.equal(value.finalTabIndex, 0, 'Summary viewing did not return to memory management');
  assert.deepEqual([value.finalWindowWidth, value.finalWindowHeight], [1380, 900],
    'Summary viewing did not restore the ordinary viewport');
  const expected = cycle === 1 ? report.memoryBatchDelete?.observed?.remainingIds : report.memoryPage?.observed?.restartIds;
  assert(Array.isArray(expected) && expected.length === 127, 'Original surviving memory IDs missing');
  assert.equal(sha256(JSON.stringify(expected)), originalIds.memoryIdsSha256, 'Fixture surviving memory IDs differ from original reads');
  assert.deepEqual(value.sourceMemoryIds, expected, 'Summary segment changed the original 127 surviving IDs/order');
  assert.deepEqual(value.beforeOpeningMemoryIds, cycle === 1 ? expected : expected.slice(0, 100),
    'Summary baseline differs from the original memory completion state');
  assert.deepEqual(value.afterOpeningMemoryIds, expected.slice(0, 100), 'Summary opening read changed the first surviving page');
  assert.deepEqual(value.finalMemoryIds, value.afterOpeningMemoryIds, 'Summary reading changed the memory page');
  const messages = report.messages.map(message => message.id);
  for (const field of ['beforeOpeningMessageIds', 'afterOpeningMessageIds', 'finalMessageIds'])
    assert.deepEqual(value[field], messages, 'Summary viewing changed original message identities/order');
  for (const phase of ['afterOpeningPreservation', 'finalPreservation']) {
    const snapshot = record(value[phase], phase);
    trueFields(snapshot, ['messageIdsMatch', 'chatDraftMatches', 'archiveDraftMatches', 'profileAndFormDraftsMatch',
      'recallMatches', 'settingsAndPermissionsMatch'], phase);
    assert.equal(snapshot.messageCount, 39, 'Summary reading changed message count');
    assert.equal(snapshot.archiveDirty, value.initialArchiveDirty, 'Summary reading changed archive dirty state');
    assert.equal(snapshot.archiveRevision, value.initialArchiveRevision, 'Summary reading changed archive revision');
    assert.equal(snapshot.profileDirty, value.initialProfileDirty, 'Summary reading changed profile dirty state');
  }
}
function validateBodyPresentation(value, prefix, viewport) {
  trueFields(value, ['Visible', 'WidthFits', 'PlainText', 'ReadOnly', 'MatchesFixture'].map(suffix => prefix + suffix), prefix);
  for (const suffix of ['Width', 'WrapperWidth'])
    assert(Number.isFinite(value[prefix + suffix]) && value[prefix + suffix] > 1, `${prefix} visible width missing or invalid`);
  assert(value[prefix + 'Width'] <= value[prefix + 'WrapperWidth'] + 1, `${prefix} extends outside its wrapper`);
  assert.deepEqual([value[prefix + 'WindowWidth'], value[prefix + 'WindowHeight']], viewport, `${prefix} viewport changed`);
}
function validateOpeningReads(value, cycle, statusResults, seed) {
  integer(value.openingCommandDelta, 0, 'summary opening command delta');
  assert(Array.isArray(value.openingReads), 'Summary opening response metadata missing');
  for (const read of value.openingReads) {
    exactKeys(read, ['requestId', 'command', 'generation'], 'summary opening response');
    requestId(read.requestId, 'summary opening response');
    assert(['archive:get', 'memory:list', 'memory:candidates:list', 'summary:status', 'user:profile:get'].includes(read.command),
      'Opening dispatched an unregistered command');
    assert.equal(read.generation, value.generation, 'Opening response belongs to another generation');
  }
  const opening = value.openingReads.filter(read => read.command === 'summary:status' && read.requestId === value.directoryBeforeRequestId);
  assert.equal(opening.length, 1, 'Opening directory request identity was not observed');
  const evidence = statusResults.filter(event => event.cycle === cycle && event.requestId === value.directoryBeforeRequestId);
  assert.equal(evidence.length, 1, 'Opening directory lacks one authenticated result');
  disabledConsent(evidence[0], 'opening directory');
  trueFields(evidence[0], ['ok', 'operationMatches', 'fixturePresent', 'resultStatusDisabled'], 'opening directory');
  assert.deepEqual([evidence[0].status, evidence[0].resultEnabled, evidence[0].resultAuthorized, evidence[0].activeCount,
    evidence[0].summaryTotal], ['disabled', false, false, 1, 1], 'Opening directory result changed');
  sameSource(evidence[0], seed, 'opening directory');
}
function validateInputs(inputs) {
  assert(Array.isArray(inputs) && inputs.length === SUMMARY_VIEW_INPUTS.length, 'Summary GUI input count changed');
  assert.deepEqual(inputs.map(input => input.control), SUMMARY_VIEW_INPUTS, 'Summary GUI input sequence changed');
  for (const input of inputs) {
    const signals = record(input.signals, 'summary input signals');
    exactKeys(signals, ['controlKind', 'observerValid', 'clickedObserverValid', 'mouseDispatchCount',
      'clickedSignals', 'toggledSignals', 'contractReason'], 'summary input signals');
    assert.equal(input.source, 'QSignalSpy', 'Summary input signal source unknown');
    trueFields(signals, ['observerValid', 'clickedObserverValid'], 'summary input signals');
    assert.deepEqual([signals.mouseDispatchCount, signals.clickedSignals], [1, 1], 'Summary input was missing or repeated');
    assert.equal(signals.controlKind, input.control.startsWith('memoryTab-') ? 'tab' : 'button', 'Summary input control kind changed');
    assert(signals.toggledSignals === null || (Number.isSafeInteger(signals.toggledSignals) && signals.toggledSignals >= 0),
      'Summary optional toggle signal metadata was fabricated or invalid');
    assert.equal(signals.contractReason, '', 'Summary input source contract failed');
    assert(input.layout?.ready === true && input.layout.minimumStableMs === 40 && input.layout.last?.layoutStable === true,
      'Summary input lacked current qualified layout across frames');
    assert(['target', 'descendant'].includes(input.hit?.hitResult), 'Summary input hit another control');
    assert.equal(input.hit.acceptorFound, true, 'Summary input target was unavailable');
    assert.equal(input.summaryId, input.control === `summaryDirectoryEntry-${SUMMARY_ID}` ? SUMMARY_ID : '',
      'Summary input identity changed');
  }
}

function verifySummaryView(result) {
  record(result, 'native acceptance result');
  return summaryViewVerdicts({ reports: result.reports, events: result.memoryFixture?.events,
    modelCalls: result.modelCalls, requests: result.requests });
}

module.exports = { SUMMARY_VIEW_SCHEMA, SUMMARY_ID, SUMMARY_MARKER, SUMMARY_BODY_SHA256, SUMMARY_BODY_CHARACTERS,
  SUMMARY_VIEW_CHECKS, SUMMARY_VIEW_INPUTS, SUMMARY_VIEW_CONTRACT, summaryModelMessageMetadata, summaryViewVerdicts, verifySummaryView };
