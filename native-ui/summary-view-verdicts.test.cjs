'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { SUMMARY_ID, SUMMARY_MARKER, SUMMARY_BODY_SHA256, SUMMARY_BODY_CHARACTERS,
  SUMMARY_VIEW_CONTRACT, SUMMARY_VIEW_CHECKS, SUMMARY_VIEW_INPUTS,
  summaryModelMessageMetadata, summaryViewVerdicts, verifySummaryView } = require('./summary-view-verdicts.cjs');

const body = 'SUMMARY_VIEW_R3_MARKER：窗边的合成回忆。<b>这是纯文本</b>\n本段仅用于隔离查看。';
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const copy = value => structuredClone(value);
const schema = 'reverie.qt.p1-memory-metadata.v1';
const consent = { enabled: false, grantEnabled: false, grantAcknowledged: false,
  policyAllowed: false, statusDisabled: true, scopeMatches: true };
const bodyMeta = { bodySha256: hash(body), bodyCharacters: Array.from(body).length };
const event = (name, cycle, at, fields) => ({ schema, event: name, cycle, monotonic_ns: at, ...fields });

function fixture() {
  const messages = Array.from({ length: 39 }, (_, index) => `message-isolated-${String(index + 1).padStart(3, '0')}`);
  const memories = Array.from({ length: 127 }, (_, index) => `memory-isolated-${String(index + 1).padStart(3, '0')}`);
  const idHashes = { messageIdsSha256: hash(JSON.stringify(messages)), memoryIdsSha256: hash(JSON.stringify(memories)) };
  const source = { summaryId: SUMMARY_ID, sourceDigest: hash('canonical first committed exchange'),
    sourceIdsSha256: hash(JSON.stringify(messages.slice(0, 3))), sourceMessageCount: 3, firstSequence: 1, lastSequence: 3 };
  const sourceRow = { summary_id: SUMMARY_ID, sourceDigest: source.sourceDigest, messageIds: messages.slice(0, 3),
    firstSequence: 1, lastSequence: 3, contractVersion: 'reverie.conversation-summary.v1' };
  const snapshot = { kernelTables: { messages: { count: 39, sha256: hash('original canonical messages') },
    conversations: { count: 1, sha256: hash('original conversation') },
    conversation_summary_attempts: { count: 0, sha256: hash('empty attempts') },
    conversation_summary_items: { count: 0, sha256: hash('empty items') },
    conversation_summary_imports: { count: 0, sha256: hash('unchanged summary imports') } },
    memoryTables: { memory_records: { count: 128, sha256: hash('original surviving memories and superseded revision') },
      memory_candidates: { count: 0, sha256: hash('original rejected candidate') } },
    ...idHashes, messageCount: 39, memoryCount: 127 };
  const after = copy(snapshot);
  after.kernelTables.conversation_summary_attempts = { count: 1, sha256: hash('one synthetic completed attempt') };
  after.kernelTables.conversation_summary_items = { count: 1, sha256: hash('one synthetic active summary') };
  const batchId = 'batch-isolated-request-1';
  const seed = event('summary_view_seeded', 1, 100, { ...source, ...bodyMeta, ...consent,
    syntheticFixture: true, naturalGeneration: false, causeRequestId: batchId, requestedCount: 3, deletedCount: 3,
    messageCount: 39, memoryCount: 127, summaryAttemptCount: 1, summaryItemCount: 1,
    messageIdsUnchanged: true, memoryIdsUnchanged: true, kernelNonSummaryUnchanged: true,
    memoryTablesUnchanged: true, otherSummaryTablesUnchanged: true, beforeAfterMatches: true,
    snapshots: { before: snapshot, after } });
  const events = [seed];
  const reports = [1, 2].map(cycle => {
    const generation = cycle + 3, personaEpoch = cycle + 6, personaId = 'isolated-persona', personaFingerprint = 'isolated-fingerprint';
    const scope = `${personaId}:${personaEpoch}:${personaFingerprint}`;
    const openingId = `opening-directory-request-${cycle}`, directoryId = `explicit-directory-request-${cycle}`;
    const detailId = `explicit-summary-body-request-${cycle}`, recallId = `original-recall-request-${cycle}`;
    const common = { generation, scope, ok: true, conversationId: 'dream-room', personaId, personaEpoch, personaFingerprint,
      ...source, contractVersion: 'reverie.conversation-summary.v1' };
    const rawDirectory = { ...common, conversationId: null, requestId: directoryId, command: 'summary:status', operation: 'status',
      status: 'disabled', enabled: false, authorized: false, summaryTotal: 1, hasMore: false, bodyFieldPresent: false };
    const rawDetail = { ...common, requestId: detailId, command: 'summary:get', operation: 'detail', ...bodyMeta,
      bodyUtf16Length: body.length, bodyMatchesFixture: true };
    const directory = { ok: true, directoryReady: true, conversationId: 'dream-room', enabled: false, authorized: false,
      status: 'disabled', summaryTotal: 1, hasMore: false, summaries: [copy(sourceRow)] };
    const preserved = { messageCount: 39, messageIdsMatch: true, chatDraftMatches: true, archiveDraftMatches: true,
      profileAndFormDraftsMatch: true, archiveDirty: false, archiveRevision: 16, profileDirty: false,
      recallMatches: true, settingsAndPermissionsMatch: true };
    const presentation = (prefix, width, wrapperWidth, windowWidth, windowHeight) => ({
      [prefix + 'Visible']: true, [prefix + 'WidthFits']: true, [prefix + 'Width']: width,
      [prefix + 'WrapperWidth']: wrapperWidth, [prefix + 'PlainText']: true, [prefix + 'ReadOnly']: true,
      [prefix + 'MatchesFixture']: true, [prefix + 'WindowWidth']: windowWidth, [prefix + 'WindowHeight']: windowHeight });
    const observed = { scope, generation, initialDetailIdle: true, initialDetailEmpty: true, initialBodyCharacters: 0,
      initialArchiveDirty: false, initialArchiveRevision: 16, initialProfileDirty: false,
      enabled: false, authorized: false, readAllowed: true, fixtureSummaryId: SUMMARY_ID,
      directoryCount: 1, directoryTotal: 1, directoryHasMore: false, directoryValidated: true,
      afterOpeningDetailIdle: true, afterOpeningDetailEmpty: true, directoryBeforeRequestId: openingId,
      directoryRequestId: directoryId, detailRequestId: detailId, directoryCommandDelta: 1, detailCommandDelta: 1,
      directoryResponseCount: 1, detailResponseCount: 1, otherResponseCount: 0, segmentCommandDelta: 2,
      openingCommandDelta: 4, clearCommandDelta: 0, clearIdle: true, clearEmpty: true, noAiOrSettingsWrites: true,
      sourceMemoryIds: copy(memories), beforeOpeningMemoryIds: cycle === 1 ? copy(memories) : memories.slice(0, 100),
      afterOpeningMemoryIds: memories.slice(0, 100), finalMemoryIds: memories.slice(0, 100),
      beforeOpeningMessageIds: copy(messages), afterOpeningMessageIds: copy(messages), finalMessageIds: copy(messages),
      afterOpeningPreservation: copy(preserved), finalPreservation: copy(preserved),
      managementStateMatches: true, managementFeedbackMatches: true, managementCandidatesMatch: true,
      managementPagingMatches: true, directoryBefore: copy(directory), directoryAfter: copy(directory), rawDirectory, rawDetail,
      ...presentation('body', 800, 820, 1380, 900),
      ...(cycle === 1 ? presentation('narrowBody', 480, 500, 760, 650) : {}),
      surfaceClosed: true, finalTabIndex: 0, finalWindowWidth: 1380, finalWindowHeight: 900,
      finalDetailIdle: true, finalDetailEmpty: true, finalPendingCount: 0,
      openingReads: [{ requestId: openingId, command: 'summary:status', generation }] };
    const status = { ...consent, ...source, ok: true, operationMatches: true, status: 'disabled', resultEnabled: false,
      resultAuthorized: false, resultStatusDisabled: true, activeCount: 1, summaryTotal: 1, fixturePresent: true };
    const at = cycle * 1000;
    events.push(event('recall_query_dispatched', cycle, at - 10, { requestId: recallId }),
      event('summary_view_status_dispatched', cycle, at, { requestId: openingId, ...consent }),
      event('summary_view_status_result', cycle, at + 1, { requestId: openingId, ...status }),
      event('summary_view_status_dispatched', cycle, at + 2, { requestId: directoryId, ...consent }),
      event('summary_view_status_result', cycle, at + 3, { requestId: directoryId, ...status }));
    if (cycle === 2) events.push(event('summary_view_restart_validated', cycle, at + 4, {
      ...source, ...bodyMeta, ...consent, seeded: false, syntheticFixture: true, naturalGeneration: false,
      messageCount: 39, memoryCount: 127, summaryAttemptCount: 1, summaryItemCount: 1, ...idHashes }));
    events.push(event('summary_view_dispatched', cycle, at + 5, { requestId: detailId, readCount: 1,
      summaryId: SUMMARY_ID, idMatches: true, ...consent }),
    event('summary_view_result', cycle, at + 6, { requestId: detailId, readCount: 1, ...source, ...bodyMeta, ...consent,
      ok: true, idMatches: true, operationMatches: true, fixtureMatches: true, sourceMatches: true, statusMatches: true }));
    return { cycle, messages: messages.map(id => ({ id })),
      memoryRecall: { observed: { requestId: recallId } },
      ...(cycle === 1 ? { memoryBatchDelete: { observed: { requestId: batchId, remainingIds: copy(memories) } } }
        : { memoryPage: { observed: { restartIds: copy(memories) } } }),
      summaryView: { schema: 'reverie.qt.summary-view.v1', passed: true, error: '', cycle, step: 17, elapsedMs: 1500,
        deadlineMs: 20000, inputDeadlineMs: 4000, readDeadlineMs: 10000, closeDeadlineMs: 4000,
        checks: SUMMARY_VIEW_CHECKS[cycle - 1].map(name => ({ name, passed: true })),
        inputs: SUMMARY_VIEW_INPUTS.map((control, index) => ({ step: [1, 2, 3, 5, 7, 12, 14, 16][index], control,
          summaryId: control === `summaryDirectoryEntry-${SUMMARY_ID}` ? SUMMARY_ID : '', source: 'QSignalSpy',
          signals: { controlKind: control.startsWith('memoryTab-') ? 'tab' : 'button', observerValid: true,
            clickedObserverValid: true, mouseDispatchCount: 1, clickedSignals: 1, toggledSignals: null, contractReason: '' },
          layout: { ready: true, minimumStableMs: 40, last: { layoutStable: true } },
          hit: { hitResult: 'target', acceptorFound: true } })), observed, contentCollected: false } };
  });
  const modelCalls = ['probe', 'chat', 'reading-fixture', 'stop-fixture', 'combined-fixture', 'reading-fixture', 'probe']
    .map((kind, index) => ({ kind, cycle: index === 6 ? 2 : 1,
      ...summaryModelMessageMetadata([{ role: 'user', content: 'original isolated request' }]) }));
  return { reports, memoryFixture: { events }, modelCalls, requests: 7 };
}
const observed = (value, index = 0) => value.reports[index].summaryView.observed;
const findEvent = (value, name, cycle = 1) => value.memoryFixture.events.find(item => item.event === name && item.cycle === cycle);
function rejects(change, pattern) {
  const value = fixture(); change(value);
  assert.throws(() => verifySummaryView(value), pattern);
}

test('model-message observer inspects content without collecting body or unrelated metadata', () => {
  const metadata = summaryModelMessageMetadata([{ role: 'system', content: 'ordinary system', metadata: SUMMARY_MARKER },
    { role: 'user', content: 'ordinary request' }]);
  assert.deepEqual(metadata, { summaryMessageContentsKnown: true, summaryMarkerPresent: false,
    conversationSummariesSectionPresent: false });
  assert(!JSON.stringify(metadata).includes('ordinary'));
});

test('actual summary marker is detected in every model-message role', () => {
  for (const role of ['system', 'user', 'assistant'])
    assert.equal(summaryModelMessageMetadata([{ role, content: `prefix ${SUMMARY_MARKER} suffix` }]).summaryMarkerPresent, true);
});

test('actual summary section tags are detected while an untagged word remains ordinary text', () => {
  for (const content of ['<conversation_summaries>entry</conversation_summaries>', '<conversation_summaries scope="x">',
    '</conversation_summaries>', '<CONVERSATION_SUMMARIES>'])
    assert.equal(summaryModelMessageMetadata([{ role: 'system', content }]).conversationSummariesSectionPresent, true);
  assert.equal(summaryModelMessageMetadata([{ content: 'The word conversation_summaries is ordinary text.' }])
    .conversationSummariesSectionPresent, false);
});

test('unknown model content cannot be converted into claimed summary absence', () => {
  assert.equal(summaryModelMessageMetadata([{ content: [{ type: 'text', text: SUMMARY_MARKER }] }]).summaryMarkerPresent, true);
  for (const messages of [undefined, null, {}, [null], [{}], [{ content: null }], [{ content: [{ type: 'image_url' }] }]])
    assert.deepEqual(summaryModelMessageMetadata(messages), { summaryMessageContentsKnown: false,
      summaryMarkerPresent: null, conversationSummariesSectionPresent: null });
});

test('frozen registration declares separate summary counts and immutable original totals', () => {
  assert(Object.isFrozen(SUMMARY_VIEW_CONTRACT) && Object.isFrozen(SUMMARY_VIEW_CHECKS[0]));
  assert.deepEqual(SUMMARY_VIEW_CHECKS.map(checks => checks.length), [9, 8]);
  assert.deepEqual(SUMMARY_VIEW_CONTRACT.context, { summaryView: true });
  assert.deepEqual(SUMMARY_VIEW_CONTRACT.bodyReadsPerCycle, [1, 1]);
  assert.deepEqual(SUMMARY_VIEW_CONTRACT.seedsPerCycle, [1, 0]);
  assert.equal(SUMMARY_VIEW_CONTRACT.addedHttpRequests, 0);
  assert.equal(SUMMARY_VIEW_CONTRACT.addedRecallQueries, 0);
  assert.equal(SUMMARY_BODY_SHA256, hash(body));
  assert.equal(SUMMARY_BODY_CHARACTERS, Array.from(body).length);
  assert.equal('body' in SUMMARY_VIEW_CONTRACT, false);
});

test('complete two-cycle evidence produces a compact proof without mutating its inputs', () => {
  const value = fixture(), before = JSON.stringify(value), verdict = verifySummaryView(value);
  assert.equal(verdict.passed, true);
  assert.deepEqual(verdict.checkCounts, [9, 8]);
  assert.deepEqual(verdict.bodyReadsPerCycle, [1, 1]);
  assert.equal(verdict.originalMessageCount, 39);
  assert.equal(verdict.survivingMemoryCount, 127);
  assert.equal(findEvent(value, 'summary_view_seeded').snapshots.before.memoryTables.memory_records.count, 128);
  assert.equal(findEvent(value, 'summary_view_seeded').snapshots.before.memoryCount, 127);
  assert.equal(verdict.actualModelMessagesExcludeSummary, true);
  assert(!JSON.stringify(verdict).includes(body));
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(summaryViewVerdicts({ reports: value.reports, events: value.memoryFixture.events,
    modelCalls: value.modelCalls, requests: value.requests }), verdict);
});

test('unrelated opening status reads do not impose a global summary-status total', () => {
  const value = fixture();
  const empty = { ...findEvent(value, 'summary_view_status_result'), requestId: 'earlier-opening-status-request', monotonic_ns: 50,
    activeCount: 0, summaryTotal: 0, fixturePresent: false, summaryId: '', sourceDigest: '', sourceIdsSha256: '',
    sourceMessageCount: 0, firstSequence: null, lastSequence: null };
  value.memoryFixture.events.unshift({ ...findEvent(value, 'summary_view_status_dispatched'),
    requestId: empty.requestId, monotonic_ns: 49 }, empty);
  assert.equal(verifySummaryView(value).passed, true);
});

test('missing GUI cycle or summary segment cannot pass', () => {
  rejects(value => value.reports.pop(), /both original cycles/);
  rejects(value => delete value.reports[1].summaryView, /summaryView/);
});

test('frozen GUI case names, pass values and separate deadlines are required', () => {
  rejects(value => value.reports[0].summaryView.checks[0].name = 'replacement', /Frozen summary checks/);
  rejects(value => value.reports[1].summaryView.checks[0].passed = false, /GUI check failed/);
  rejects(value => value.reports[0].summaryView.elapsedMs = 20000, /separate deadline/);
  rejects(value => value.reports[0].summaryView.readDeadlineMs = 30000, /deadlines changed/);
});

test('late fixture must seed once and bind its cause to the registered successful batch', () => {
  rejects(value => value.memoryFixture.events.push({ ...findEvent(value, 'summary_view_seeded'), cycle: 2 }), /seed exactly once/);
  rejects(value => findEvent(value, 'summary_view_seeded').causeRequestId = 'another-delete-request', /successful registered batch/);
  rejects(value => findEvent(value, 'summary_view_seeded').naturalGeneration = true, /natural generation/);
  rejects(value => findEvent(value, 'summary_view_restart_validated', 2).seeded = true, /Restart reseeded/);
});

test('seed table snapshots independently prove only the two summary rows changed', () => {
  rejects(value => findEvent(value, 'summary_view_seeded').snapshots.before.kernelTables.messages.rows = ['private payload'], /fields changed/);
  rejects(value => findEvent(value, 'summary_view_seeded').snapshots.after.kernelTables.messages.sha256 = hash('changed'), /non-summary kernel/);
  rejects(value => findEvent(value, 'summary_view_seeded').snapshots.after.memoryTables.memory_records.count = 126, /critical table row counts/);
  rejects(value => findEvent(value, 'summary_view_seeded').snapshots.after.memoryTables.memory_records.count = 129, /memory tables/);
  rejects(value => findEvent(value, 'summary_view_seeded').snapshots.after.memoryTables.memory_records.sha256 = hash('changed full revisions'), /memory tables/);
  rejects(value => findEvent(value, 'summary_view_seeded').snapshots.after.kernelTables.conversation_summary_attempts.count = 2, /exactly one row/);
  rejects(value => delete findEvent(value, 'summary_view_seeded').snapshots.after.kernelTables.conversation_summary_items, /added or removed/);
});

test('restart must preserve body, source and the original ordered ID digests', () => {
  rejects(value => findEvent(value, 'summary_view_restart_validated', 2).bodySha256 = hash('different body'), /body digest/);
  rejects(value => findEvent(value, 'summary_view_restart_validated', 2).sourceDigest = hash('different source'), /authenticated source/);
  rejects(value => findEvent(value, 'summary_view_restart_validated', 2).messageIdsSha256 = hash('different order'), /message identities/);
  rejects(value => findEvent(value, 'summary_view_restart_validated', 2).memoryIdsSha256 = hash('different order'), /memory identities/);
});

test('explicit directory refresh must have its own current request and raw reply identity', () => {
  rejects(value => observed(value).directoryRequestId = observed(value).directoryBeforeRequestId, /reused the opening/);
  rejects(value => observed(value).detailRequestId = observed(value).directoryBeforeRequestId, /reused the opening/);
  rejects(value => observed(value).rawDirectory.requestId = 'stale-directory-request', /raw reply identity/);
  rejects(value => observed(value).directoryResponseCount = 2, /dispatch counts/);
});

test('detail scope and generation must match the current directory and bridge', () => {
  rejects(value => observed(value).rawDetail.generation--, /generation changed/);
  rejects(value => observed(value).rawDetail.scope = 'another:7:scope', /scope changed/);
  rejects(value => observed(value).rawDetail.personaId = 'another-persona', /returned persona/);
  rejects(value => delete observed(value).rawDetail.personaEpoch, /fields changed/);
});

test('directory source IDs retain canonical first-exchange membership and order', () => {
  rejects(value => observed(value).directoryBefore.summaries[0].messageIds.reverse(), /original message order/);
  rejects(value => observed(value).directoryBefore.summaries[0].messageIds[0] = 'unrelated-source-id', /original message order/);
  rejects(value => observed(value).directoryBefore.summaries[0].messageIds.push('message-isolated-004'), /source identities/);
});

test('undefined, unknown or malformed source metadata cannot become a verified source', () => {
  rejects(value => observed(value).rawDetail.sourceDigest = undefined, /digest missing/);
  rejects(value => observed(value).rawDirectory.sourceIdsSha256 = 'unknown', /digest missing/);
  rejects(value => observed(value).rawDetail.firstSequence = 0, /integer missing/);
  rejects(value => findEvent(value, 'summary_view_result').sourceMessageCount = null, /integer missing/);
});

test('new reports and authenticated events reject raw reply or prompt content', () => {
  rejects(value => observed(value).rawDetail.text = 'private content', /unregistered content/);
  rejects(value => value.reports[0].summaryView.contentCollected = true, /collected content/);
  rejects(value => findEvent(value, 'summary_view_result').prompt = 'private prompt', /fields changed/);
});

test('directory remains metadata only and cannot contain a body field', () => {
  rejects(value => observed(value).rawDirectory.bodyFieldPresent = true, /contained content/);
  rejects(value => observed(value).directoryAfter.summaries[0].body = 'private content', /unregistered content/);
  rejects(value => observed(value).rawDirectory.summaryTotal = 2, /generation consent changed/);
});

test('actual generation and fee consent are explicitly off in GUI and backend evidence', () => {
  rejects(value => findEvent(value, 'summary_view_seeded').grantAcknowledged = true, /explicitly disabled/);
  rejects(value => findEvent(value, 'summary_view_result').policyAllowed = undefined, /explicitly disabled/);
  rejects(value => observed(value).authorized = null, /fee authorization/);
  rejects(value => findEvent(value, 'summary_view_status_result').resultAuthorized = true, /Opening directory result changed/);
});

test('every actual model call must exclude both summary marker and summary section', () => {
  rejects(value => value.modelCalls[0].summaryMarkerPresent = true, /marker reached/);
  rejects(value => value.modelCalls[6].conversationSummariesSectionPresent = true, /section reached/);
  rejects(value => value.modelCalls[3].summaryMessageContentsKnown = false, /contents were not observed/);
  rejects(value => delete value.modelCalls[3].summaryMarkerPresent, /marker reached/);
});

test('the original seven HTTP calls retain their per-cycle distribution', () => {
  rejects(value => value.requests = 8, /original HTTP total/);
  rejects(value => value.modelCalls.push(copy(value.modelCalls[0])), /original model calls/);
  rejects(value => value.modelCalls[1].cycle = 2, /HTTP requests in a cycle/);
});

test('summary requests remain separate from the two original recall requests', () => {
  rejects(value => value.reports[1].memoryRecall.observed.requestId = observed(value).detailRequestId, /recall request identity/);
  rejects(value => delete value.reports[1].memoryRecall.observed.requestId, /recall request identity/);
  rejects(value => value.memoryFixture.events.push(event('recall_query_dispatched', 2, 5000, { requestId: 'extra-recall-request' })), /added a recall query/);
});

test('one body request and one body result are required for each cycle', () => {
  rejects(value => value.memoryFixture.events.push(copy(findEvent(value, 'summary_view_dispatched'))), /once per cycle/);
  rejects(value => findEvent(value, 'summary_view_result', 2).readCount = 2, /body read repeated/);
  rejects(value => findEvent(value, 'summary_view_result').requestId = 'stale-body-request', /differs from GUI request/);
});

test('the explicit refresh must select exactly one authenticated status dispatch and reply', () => {
  rejects(value => findEvent(value, 'summary_view_status_result').requestId = 'stale-opening-status', /Opening directory lacks/);
  rejects(value => value.memoryFixture.events.push(copy(value.memoryFixture.events.find(item =>
    item.event === 'summary_view_status_result' && item.requestId === observed(value).directoryRequestId))), /one authenticated result/);
  rejects(value => value.memoryFixture.events = value.memoryFixture.events.filter(item =>
    !(item.event === 'summary_view_status_dispatched' && item.requestId === observed(value).directoryRequestId)), /one authenticated dispatch/);
});

test('QSignalSpy evidence rejects missing sources, unknown counters and repeated clicks', () => {
  rejects(value => delete value.reports[0].summaryView.inputs[0].source, /source unknown/);
  rejects(value => value.reports[0].summaryView.inputs[0].signals.observerValid = undefined, /not verified/);
  rejects(value => value.reports[0].summaryView.inputs[0].signals.clickedSignals = null, /missing or repeated/);
  rejects(value => value.reports[0].summaryView.inputs[0].signals.mouseDispatchCount = 2, /missing or repeated/);
  rejects(value => value.reports[0].summaryView.inputs[2].signals.controlKind = 'button', /control kind changed/);
  rejects(value => delete value.reports[0].summaryView.inputs[0].signals.clickedSignals, /fields changed/);
});

test('message and memory preservation binds all ID arrays to the original snapshots', () => {
  rejects(value => observed(value).sourceMemoryIds.reverse(), /127 surviving IDs/);
  rejects(value => observed(value).finalMessageIds.reverse(), /message identities/);
  rejects(value => observed(value).managementFeedbackMatches = false, /not verified/);
  rejects(value => observed(value).finalPreservation.archiveRevision++, /archive revision/);
});

test('clear is local and terminal state has no body, pending RPC, surface or changed viewport', () => {
  rejects(value => observed(value).clearCommandDelta = 1, /dispatch counts/);
  rejects(value => observed(value).clearIdle = false, /not verified/);
  rejects(value => observed(value).finalPendingCount = 1, /dispatch counts/);
  rejects(value => observed(value).finalDetailEmpty = false, /not verified/);
  rejects(value => observed(value).finalTabIndex = 1, /memory management/);
  rejects(value => observed(value).finalWindowWidth = 760, /ordinary viewport/);
});

test('plain read-only body fits ordinary and first-cycle narrow viewports', () => {
  rejects(value => observed(value).bodyPlainText = false, /not verified/);
  rejects(value => observed(value).narrowBodyReadOnly = undefined, /not verified/);
  rejects(value => observed(value).narrowBodyWidth = 900, /outside its wrapper/);
  rejects(value => observed(value).narrowBodyWindowWidth = 1380, /viewport changed/);
  assert.equal(verifySummaryView(fixture()).passed, true);
});

test('authenticated directory result precedes body dispatch and its matching response', () => {
  rejects(value => findEvent(value, 'summary_view_result').monotonic_ns = 500, /evidence order/);
  rejects(value => findEvent(value, 'summary_view_restart_validated', 2).monotonic_ns = 3000, /preceded fixture validation/);
});

test('unknown observer fields, events and missing actual results cannot pass', () => {
  rejects(value => findEvent(value, 'summary_view_result').privatePayload = {}, /fields changed/);
  rejects(value => value.memoryFixture.events.push(event('summary_view_unregistered', 1, 9, {})), /Unregistered summary observer/);
  rejects(value => findEvent(value, 'summary_view_result').idMatches = null, /not verified/);
  rejects(value => value.memoryFixture.events = value.memoryFixture.events.filter(item => item.event !== 'summary_view_result'), /once per cycle/);
});
