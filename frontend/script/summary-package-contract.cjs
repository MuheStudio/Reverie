'use strict';

// Pure assertions for the optional packaged summary scenario. Application
// control stays in the existing isolated package runner, never in this module.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SUMMARY_REPLY = 'CS_GENERATED_BACKGROUND：较早的合成对话讨论本机验收；内容仅作未核实背景。';
const LEGACY_MARKER = 'CS_LEGACY_MUST_NOT_ENTER_PROMPT';
const CHAT_REPLY = 'CS fixture reply';
const CONVERSATION = 'dream-room';
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(item => typeof item?.text === 'string' ? item.text : '').join('\n') : '';
const isSummaryRequest = body => (body?.messages || []).some(message => message.role === 'system'
  && text(message.content).includes('为同一会话的较早消息'));
const summaryCalls = fake => fake.requests.filter(request => isSummaryRequest(request.body));
function historyTurn(index) {
  assert.ok(Number.isInteger(index) && index >= 1 && index <= 14);
  return `CS fixture: history ${index}: ${'合成资料仅用于本地验收。'.repeat(100)}`;
}
function legacyFixture() {
  return `${JSON.stringify({ summaries: [{ text: LEGACY_MARKER, chat_ids: ['unresolved-summary-package-fixture'],
    is_important: false, tags: ['synthetic-package-test'], created_at: '2026-10-05T00:00:00Z' }] })}\n`;
}
function historyIdentity(history) {
  assert.ok(Array.isArray(history?.items), 'Packaged summary history is missing');
  const records = history.items.map(item => {
    assert.ok(typeof item.id === 'string' && item.id, 'History message ID is missing');
    assert.ok(['user', 'assistant'].includes(item.role), 'Unexpected packaged chat role');
    assert.equal(typeof item.content, 'string');
    return { id: item.id, role: item.role, content: item.content };
  });
  assert.equal(new Set(records.map(item => item.id)).size, records.length, 'Duplicate persisted message IDs');
  return records;
}
function assertNoSummaryWork(status, fake, expectedEnabled) {
  assert.equal(status.ok, true);
  assert.equal(status.enabled, expectedEnabled);
  assert.equal(status.authorized, false);
  assert.equal(status.running, false);
  assert.deepEqual(status.attempts, {});
  assert.equal(status.activeCount, 0);
  assert.equal(summaryCalls(fake).length, 0, 'Unauthorized/default-off summary contacted the model');
}
function olderHistoryBoundary(history) {
  const records = historyIdentity(history);
  assert.ok(records.length > 20, 'Summary scenario has no older messages outside the recent window');
  const olderCharacters = records.slice(0, -20).reduce((count, item) => count + Array.from(item.content).length, 0);
  assert.ok(olderCharacters > 4000, 'Summary default-off check did not reach the genuine history threshold');
  return { messageCount: records.length, olderCharacters, recentMessagesRetained: 20 };
}
function assertEnoughHistory(status, history) {
  const boundary = olderHistoryBoundary(history);
  assert.ok(status.pendingBudget > 2000, 'Runtime did not observe the genuine summary threshold');
  return { ...boundary, pendingBudget: status.pendingBudget };
}
function assertPrompt(request, active) {
  assert.equal(isSummaryRequest(request?.body), false, 'Expected the actual next chat request');
  const system = (request?.body?.messages || []).filter(message => message.role === 'system').map(message => text(message.content)).join('\n');
  assert.ok(system, 'Actual chat request has no system messages');
  assert.equal(system.includes('<conversation_summaries>'), active, 'Summary prompt activation is inconsistent');
  assert.equal(system.includes(SUMMARY_REPLY), active, 'Generated summary prompt content is inconsistent');
  assert.equal(system.includes(LEGACY_MARKER), false, 'Unattributed legacy summary entered a chat prompt');
}
function summaryIdentity(status) {
  assert.equal(status?.ok, true);
  // Cooldown prevents another generation, not use of an already committed
  // summary. Both public states must retain the completed attempt and source.
  assert.ok(['ready', 'cooldown'].includes(status.status), 'No completed summary is available');
  assert.equal(status.running, false);
  assert.equal(status.lastAttempt?.status, 'completed', 'Last summary attempt did not complete');
  assert.ok(typeof status.persona_id === 'string' && status.persona_id);
  assert.equal(status.activeCount, 1, 'Packaged summary scenario expects one committed generated summary');
  assert.equal(status.summaryTotal, 1);
  assert.equal(status.hasMore, false);
  assert.deepEqual(status.attempts, { completed: 1 }, 'Summary attempt was duplicated or failed');
  assert.equal(status.summaries?.length, 1);
  const summaries = status.summaries.map(item => {
    assert.ok(typeof item.summary_id === 'string' && item.summary_id);
    assert.match(item.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.firstSequence) && item.firstSequence > 0);
    assert.ok(Number.isSafeInteger(item.lastSequence) && item.lastSequence >= item.firstSequence);
    assert.equal(item.contractVersion, 'reverie.conversation-summary.v1');
    assert.ok(Array.isArray(item.messageIds) && item.messageIds.length > 0 && item.messageIds.length <= 40);
    assert.ok(item.messageIds.every(id => typeof id === 'string' && id));
    assert.equal(new Set(item.messageIds).size, item.messageIds.length);
    return { summary_id: item.summary_id, sourceDigest: item.sourceDigest, firstSequence: item.firstSequence,
      lastSequence: item.lastSequence, messageIds: [...item.messageIds], contractVersion: item.contractVersion };
  });
  assert.ok(Number.isSafeInteger(status.legacyInactiveCount) && status.legacyInactiveCount >= 0);
  return { personaId: status.persona_id, conversationId: CONVERSATION, summaries,
    attempts: { ...status.attempts }, activeCount: status.activeCount, legacyInactiveCount: status.legacyInactiveCount };
}
function assertGeneratedSource(status, fake, history) {
  const identity = summaryIdentity(status), calls = summaryCalls(fake);
  assert.equal(calls.length, 1, 'Generation must use exactly one local model request');
  const sourceRequest = calls[0].body.messages.filter(message => message.role === 'user');
  assert.equal(sourceRequest.length, 1);
  const source = JSON.parse(text(sourceRequest[0].content)).messages;
  assert.ok(Array.isArray(source) && source.length > 0);
  assert.deepEqual(source.map(item => item.id), identity.summaries[0].messageIds);
  const records = historyIdentity(history), byId = new Map(records.map(item => [item.id, item]));
  const recent = new Set(records.slice(-20).map(item => item.id));
  for (const item of source) {
    const saved = byId.get(item.id);
    assert.ok(saved, 'Summary referenced a message outside the authoritative persisted history');
    assert.equal(recent.has(item.id), false, 'Summary consumed the protected recent-message window');
    assert.equal(item.role, saved.role); assert.equal(item.text, saved.content);
  }
  return identity;
}
function assertLegacyResult(value, source, imported) {
  assert.equal(value?.ok, true);
  assert.equal(value.sha256, crypto.createHash('sha256').update(source).digest('hex'));
  assert.equal(value.total, 1); assert.equal(value.linked, 0); assert.equal(value.unattributed, 1);
  assert.equal(value.active, 0);
  // The public preview is aggregate-only: internal per-entry provenance must
  // not be required or expanded into a potentially oversized bridge frame.
  assert.equal(Object.hasOwn(value, 'entries'), false);
  if (imported) { assert.equal(value.imported, 1); assert.equal(value.reused, false); }
}
function assertBudgetDenied(status, fake, previousCalls) {
  assert.equal(status?.ok, true); assert.equal(status.enabled, true); assert.equal(status.authorized, true);
  assert.equal(status.running, false); assert.equal(status.status, 'failed'); assert.equal(status.errorCode, 'budget_denied');
  assert.deepEqual(status.attempts, { failed: 1 }); assert.equal(status.activeCount, 0);
  assert.deepEqual(status.summaries, []); assert.equal(status.cooldownSeconds, 300);
  assert.equal(summaryCalls(fake).length, previousCalls, 'Budget-denied summary contacted the provider');
}
module.exports = { SUMMARY_REPLY, LEGACY_MARKER, CHAT_REPLY, CONVERSATION, isSummaryRequest, summaryCalls,
  historyTurn, legacyFixture, historyIdentity, assertNoSummaryWork, olderHistoryBoundary, assertEnoughHistory, assertPrompt,
  summaryIdentity, assertGeneratedSource, assertLegacyResult, assertBudgetDenied };
