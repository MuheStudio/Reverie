'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { supplementaryResponse, supplementaryVerdicts, SAVED_MODEL, FAILING_MODEL, SLOW_MODEL, LATE_REPLY,
  attachResponseLifecycle, writeSupplementaryResponse, backendMetadata, p0TailResponse, p0TailVerdicts, P0_TAIL_MODEL, P0_TAIL_CASES } =
  require('./supplementary-evidence.cjs');

const chat = (text, model = SAVED_MODEL) => ({ model, messages: [{ role: 'user', content: text }] });

test('mock answers by model and marker', () => {
  assert.equal(supplementaryResponse(chat('hi', FAILING_MODEL)).status, 500);
  assert.equal(supplementaryResponse(chat('hi', SLOW_MODEL)).delayMs, 4000);
  const late = supplementaryResponse(chat('补充-延迟：请慢慢回答'));
  assert.equal(late.marker, '补充-延迟');
  assert.equal(late.delayMs, 8000);
  assert.equal(late.content, LATE_REPLY);
  assert.equal(supplementaryResponse(chat('ping')).kind, 'probe');
  for (const marker of ['补充-受控延迟', '补充-受控停止'])
    assert.equal(supplementaryResponse(chat(marker + '：fixture')).delayMs, 8000);
  assert.equal(supplementaryResponse(chat('补充-受控恢复：fixture')).delayMs, 0);
});

test('server write, early close and client receive remain separate facts', () => {
  class Response extends EventEmitter {
    writeHead(status) { this.status = status; }
    end(body) { this.body = body; this.writableEnded = true; this.emit('finish'); }
  }
  let time = 4;
  const response = new Response(), call = {};
  attachResponseLifecycle(response, call, () => time);
  time = 8;
  assert.equal(writeSupplementaryResponse(response, call, 200, '{}', () => time), true);
  time = 9; response.emit('close');
  assert.deepEqual(call, { actualResponseWritten: true, connectionClosed: true,
    responseWriteAttemptedAtMs: 8, responseWrittenAtMs: 8, connectionClosedAtMs: 9,
    connectionClosedBeforeResponse: false });
  assert.equal('clientReceiveAcknowledged' in call, false);
  const closed = new Response(), cancelled = {};
  attachResponseLifecycle(closed, cancelled, () => time);
  closed.destroyed = true; closed.emit('close');
  assert.equal(writeSupplementaryResponse(closed, cancelled, 200, '{}', () => time), false);
  assert.equal(cancelled.actualResponseWritten, false);
  assert.equal(cancelled.connectionClosedBeforeResponse, true);
  assert.equal(cancelled.responseWrittenAtMs, undefined);
});

const schema = 'reverie.qt.p0.backend.metadata.v1';
const health = cycle => ({ schema, event: 'trace_health', cycle, complete: true, overflow: false, dropped_events: 0 });
const plan = (cycle, marker, injected) => ({ schema, event: 'plan', cycle, marker, injected,
  start_delay_seconds: injected ? 0.2 : 31, request_id: 'synthetic-request' });

test('bounded backend report discards payloads and unrelated events', () => {
  const safe = backendMetadata([{ ...plan(1, 'controlled_recovery', true), text: 'private', messages: ['private'],
    identity: 'private', headers: { Authorization: 'private' } }, health(1),
    { schema, event: 'raw-log', text: 'private' }, { event: 'plan', text: 'private' }]);
  assert.equal(safe.length, 2);
  for (const value of safe) for (const key of ['text', 'messages', 'identity', 'headers']) assert.equal(key in value, false);
});

test('controlled recovery cannot upgrade an original 20s failure and cycles correlate independently', () => {
  const r = reports({ 'network.resume': { status: 'failed', error: 'TIMEOUT:settle',
    steps: [{ step: 'settle', timeoutMs: 20000 }] }, 'network.controlled-resume': { status: 'passed' } },
    { 'restart.controlled-resume-uses-saved-config': { status: 'passed' } });
  const calls = [{ marker: '补充-受控恢复', cycle: 1, model: SAVED_MODEL },
    { marker: '补充-受控恢复', cycle: 2, model: SAVED_MODEL }];
  const verdict = supplementaryVerdicts(r, calls, { backend: [health(1), health(2),
    plan(1, 'original_recovery', false), plan(1, 'controlled_recovery', true), plan(2, 'controlled_recovery', true)] });
  assert.equal(verdict.cases['1:network.resume'].status, 'failed');
  assert.equal(verdict.cases['1:network.resume'].steps[0].timeoutMs, 20000);
  assert.equal(verdict.cases['1:network.controlled-resume'].status, 'passed');
  assert.equal(verdict.cases['2:restart.controlled-resume-uses-saved-config'].status, 'passed');
  assert.equal(verdict.allPassed, false);
});

test('original recoveries reject injected planners and missing trace becomes evidence gap', () => {
  const r = reports({ 'network.resume': { status: 'passed' } }, {});
  const calls = [{ marker: '补充-恢复', cycle: 1, model: SAVED_MODEL }];
  const injected = supplementaryVerdicts(r, calls, { backend: [health(1), plan(1, 'original_recovery', true)] });
  assert.equal(injected.cases['1:network.resume'].status, 'failed');
  const missing = supplementaryVerdicts(r, calls);
  assert.equal(missing.cases['1:network.resume'].status, 'partial');
  assert.match(missing.cases['1:network.resume'].gaps[0], /incomplete/);
  assert.equal(missing.cases['1:network.resume'].serviceEvidence.backendEvidenceComplete, false);
});

test('a delayed server response does not establish receipt by the native client', () => {
  const r = reports({ 'network.controlled-pause-during-reply': { status: 'passed' } }, {});
  const verdict = supplementaryVerdicts(r, [{ marker: '补充-受控延迟', cycle: 1, model: SAVED_MODEL,
    actualResponseWritten: true, connectionClosed: true, responseWrittenAtMs: 8000, connectionClosedAtMs: 8001 }],
  { backend: [health(1), plan(1, 'controlled_delay', true)] });
  const evidence = verdict.cases['1:network.controlled-pause-during-reply'].serviceEvidence;
  assert.equal(evidence.actualResponseWritten, true);
  assert.equal(evidence.clientReceiveAcknowledged, false);
  assert.equal(verdict.cases['1:network.controlled-pause-during-reply'].status, 'passed');
  assert.equal(supplementaryVerdicts([], []).allPassed, false);
});

function reports(cases1, cases2, obs1 = {}, obs2 = {}) {
  return [{ cycle: 1, supplementary: { cases: cases1, order: Object.keys(cases1), observations: obs1 } },
    { cycle: 2, supplementary: { cases: cases2, order: Object.keys(cases2), observations: obs2 } }];
}

test('service evidence can fail an app-passed case and never upgrades a partial one', () => {
  const r = reports({ 'service.chat-uses-saved-config': { status: 'passed' },
    'network.no-calls-while-paused': { status: 'partial', gaps: ['no visible notice'] } }, {});
  const verdict = supplementaryVerdicts(r, [{ marker: '补充-配置', model: 'reverie-qt-test' },
    { marker: '补充-暂停中', model: SAVED_MODEL }]);
  assert.equal(verdict.cases['1:service.chat-uses-saved-config'].status, 'failed');
  assert.equal(verdict.cases['1:network.no-calls-while-paused'].status, 'failed');
  assert.equal(verdict.allPassed, false);
  const ok = supplementaryVerdicts(reports({ 'network.no-calls-while-paused': { status: 'partial', gaps: ['x'] } }, {}), []);
  assert.equal(ok.cases['1:network.no-calls-while-paused'].status, 'partial');
});

test('blocked and failed app cases keep their status; pause gap is recorded', () => {
  const r = reports({ 'network.pause-during-reply': { status: 'passed' }, 'network.resume': { status: 'blocked' } },
    { 'restart.model-selection-restored': { status: 'passed' } },
    { 'restart.preparedAvatarPath': '/a/model.json', 'restart.preparedActive': { id: 'm1', name: 'yumi', modelPath: '/a/model.json', motions: 2, expressions: 17 } },
    { 'restart.avatarPath': '/a/model.json', 'restart.active': { id: 'm1', name: 'yumi', modelPath: '/a/model.json', motions: 2, expressions: 17 } });
  const verdict = supplementaryVerdicts(r, []);
  assert.equal(verdict.cases['1:network.pause-during-reply'].status, 'partial');
  assert.equal(verdict.cases['1:network.resume'].status, 'blocked');
  assert.equal(verdict.cases['2:restart.model-selection-restored'].status, 'passed');
  assert.deepEqual(verdict.counts, { partial: 1, blocked: 1, passed: 1 });
});

test('saved endpoint and restored model identity are compared by the host', () => {
  const endpoint = 'http://127.0.0.1:5000/v1';
  const good = supplementaryVerdicts(reports({ 'service.test-and-save': { status: 'partial', gaps: ['x'] } },
    { 'restart.service-persisted': { status: 'passed' }, 'restart.model-selection-restored': { status: 'passed' } },
    { 'service.savedProvider': { model: SAVED_MODEL, base_url: endpoint }, 'restart.preparedAvatarPath': '/p', 'restart.preparedActive': { id: 'a', name: 'n', modelPath: '/p', motions: 2, expressions: 3 } },
    { 'restart.provider': { model: SAVED_MODEL, base_url: endpoint }, 'restart.avatarPath': '/p', 'restart.active': { id: 'b', name: 'n', modelPath: '/p', motions: 2, expressions: 3 } }),
    [{ marker: null, model: SAVED_MODEL }], { endpoint });
  assert.equal(good.cases['1:service.test-and-save'].status, 'partial');
  assert.equal(good.cases['2:restart.service-persisted'].status, 'passed');
  assert.equal(good.cases['2:restart.model-selection-restored'].status, 'failed');
  const wrong = supplementaryVerdicts(reports({ 'service.test-and-save': { status: 'passed' } }, {},
    { 'service.savedProvider': { model: SAVED_MODEL, base_url: 'http://127.0.0.1:1/v1' } }), [{ marker: null, model: SAVED_MODEL }], { endpoint });
  assert.equal(wrong.cases['1:service.test-and-save'].status, 'failed');
});

test('P0-tail service markers are exact and preserve independent delays', () => {
  assert.equal(p0TailResponse(chat('补充-取消拒绝：fixture', P0_TAIL_MODEL)).delayMs, 8000);
  assert.equal(p0TailResponse(chat('补充-取消超时：fixture', P0_TAIL_MODEL)).delayMs, 0);
  assert.equal(p0TailResponse(chat('补充-尾部受控停止：fixture', P0_TAIL_MODEL)).delayMs, 8000);
  assert.equal(p0TailResponse(chat('补充-尾部服务B：fixture', P0_TAIL_MODEL)).delayMs, 0);
  assert.equal(p0TailResponse(chat('text 补充-取消拒绝：fixture', P0_TAIL_MODEL)).marker, null);
});

function tailFixture() {
  const endpoints = { A: 'http://127.0.0.1:5010/v1', B: 'http://127.0.0.1:5011/v1' };
  const provider = role => ({ model: P0_TAIL_MODEL, base_url: endpoints[role] });
  const permission = (role, enabled) => ({ known: true, enabled, effective: enabled,
    provider: 'ollama', origin: new URL(endpoints[role]).origin, current_provider: 'ollama',
    current_origin: new URL(endpoints[role]).origin, contextEpoch: 2 });
  const reports = [1, 2].map(cycle => ({ cycle, p0Tail: { order: P0_TAIL_CASES[cycle],
    cases: Object.fromEntries(P0_TAIL_CASES[cycle].map(id => [id, { status: 'passed',
      ...(id === 'cancel.timeout-original-done' ? { caseDeadlineMs: 55000 } : {}) }])), observations: {} } }));
  const one = reports[0].p0Tail.observations, two = reports[1].p0Tail.observations;
  Object.assign(one, { 'setup.provider': provider('A'), 'permission.grant-a': permission('A', true),
    'provider.saved-b': provider('B'), 'permission.after-b': permission('B', false),
    'permission.auto-refresh-b': { requestId: 'refresh-b-request', contextEpochBefore: 0, contextEpochAfter: 1 },
    'permission.grant-b': permission('B', true), 'permission.revoked-b': permission('B', false),
    'restart.preparedProvider': provider('B'), 'restart.preparedPermission': permission('B', false), 'restart.preparedPaused': true });
  Object.assign(two, { 'setup.provider': provider('B'), 'restart.provider': provider('B'),
    'restart.permission': permission('B', false), 'restart.paused': true, 'restart.pausedDraftPreserved': true,
    'provider.saved-a-returned': provider('A'), 'permission.after-a-returned': permission('A', false) });
  two['permission.auto-refresh-a-returned'] = { requestId: 'refresh-a-request', contextEpochBefore: 0, contextEpochAfter: 1 };
  const backend = [health(1), health(2)], calls = [
    { cycle: 1, kind: 'probe', endpoint: 'B', model: P0_TAIL_MODEL },
    { cycle: 2, kind: 'probe', endpoint: 'A', model: P0_TAIL_MODEL }];
  const specifications = [
    [1, '补充-尾部服务B', 'tail_service_b', 'B', 'done'],
    [1, '补充-尾部受控延迟', 'tail_controlled_delay', 'B', 'cancelled'],
    [1, '补充-尾部受控恢复', 'tail_controlled_recovery', 'B', 'done'],
    [2, '补充-尾部受控恢复', 'tail_controlled_recovery', 'B', 'done'],
    [2, '补充-尾部服务A', 'tail_service_a', 'A', 'done'],
    [2, '补充-取消拒绝', 'cancel_reject', 'A', 'done'],
    [2, '补充-取消超时', 'cancel_timeout', 'A', 'done'],
    [2, '补充-尾部受控停止', 'tail_controlled_stop', 'A', 'cancelled']];
  for (const [index, [cycle, marker, logical, role, state]] of specifications.entries()) {
    const requestId = `tail-request-${cycle}-${index}`;
    reports[cycle - 1].p0Tail.observations['chat.' + marker] = { requestId };
    calls.push({ cycle, kind: 'chat', marker, model: P0_TAIL_MODEL, endpoint: role, endpointUrl: endpoints[role],
      status: 200, actualResponseWritten: state === 'done' });
    backend.push({ schema, cycle, event: 'accept', request_id: requestId, marker: logical, accepted: true },
      { schema, cycle, event: 'plan', request_id: requestId, marker: logical, injected: true,
        start_delay_seconds: logical === 'cancel_timeout' ? 40 : 0.2 },
      { schema, cycle, event: 'provider_dispatch', request_id: requestId, marker: logical, endpoint_role: role },
      { schema, cycle, event: 'terminal', request_id: requestId, marker: logical, state });
    if (['cancel_reject', 'cancel_timeout', 'tail_controlled_stop'].includes(logical)) {
      const injected = logical !== 'tail_controlled_stop', cancelId = 'cancel-' + requestId;
      const record = { requestId: cancelId, subjectRequestId: requestId,
        ...(logical === 'cancel_timeout' ? { caseElapsedMs: 31000, stepElapsedMs: 30000 } : {}) };
      reports[cycle - 1].p0Tail.observations[(injected ? 'cancel.' : 'chat.stop.') + marker] = record;
      backend.push({ schema, cycle, event: 'cancel_command', request_id: cancelId, subject_request_id: requestId,
        marker: logical, accepted: true, injected,
        reason: logical === 'cancel_reject' ? 'fixture_rejected' : logical === 'cancel_timeout' ? 'fixture_ack_timeout' : 'passthrough' });
    }
  }
  return { reports, calls, endpoints, backend };
}
const tailVerdict = f => p0TailVerdicts(f.reports, f.calls, { endpoints: f.endpoints, backend: f.backend });

test('P0-tail requires both rounds and all 16 new cases while preserving the old suite', () => {
  const fixture = tailFixture(), verdict = tailVerdict(fixture);
  assert.equal(verdict.allPassed, true);
  assert.deepEqual(verdict.counts, { passed: 16 });
  assert.equal(verdict.cases['2:cancel.timeout-original-done'].serviceEvidence.testcaseDeadlineMs, 55000);
  assert.equal(verdict.cases['1:network.controlled-pause'].serviceEvidence.clientReceiveAcknowledged, false);
  fixture.reports[1].p0Tail.cases['prior-case'] = { status: 'passed' };
  assert.equal(tailVerdict(fixture).allPassed, false);
  assert.equal(p0TailVerdicts([], []).allPassed, false);
});

test('P0-tail rejects neighboring endpoints and revived permissions despite UI passes', () => {
  const fixture = tailFixture();
  fixture.calls.find(c => c.marker === '补充-尾部服务B').endpointUrl += '/';
  fixture.reports[1].p0Tail.observations['permission.after-a-returned'].enabled = true;
  const verdict = tailVerdict(fixture);
  assert.equal(verdict.cases['1:provider.chat-only-b'].status, 'failed');
  assert.equal(verdict.cases['2:provider.return-a-no-resurrection'].status, 'failed');
});

test('P0-tail metadata keeps accepted=true and exact cancel subject identifiers', () => {
  const fixture = tailFixture();
  const rows = backendMetadata(fixture.backend.map(row => ({ ...row, body: 'private', error: 'private' })));
  assert.equal(rows.find(row => row.event === 'accept').accepted, true);
  assert.ok(rows.find(row => row.event === 'cancel_command').subject_request_id);
  assert.ok(rows.every(row => !('body' in row) && !('error' in row)));
  const accepted = fixture.backend.find(row => row.marker === 'cancel_reject' && row.event === 'accept');
  accepted.request_id = 'another-real-request';
  assert.equal(tailVerdict(fixture).cases['2:cancel.rejected-original-done'].status, 'failed');
  const next = tailFixture();
  next.backend.find(row => row.marker === 'cancel_timeout' && row.event === 'cancel_command').subject_request_id = 'other-subject';
  assert.equal(tailVerdict(next).cases['2:cancel.timeout-original-done'].status, 'failed');
  const notAccepted = tailFixture();
  notAccepted.backend.find(row => row.marker === 'cancel_reject' && row.event === 'accept').accepted = false;
  assert.equal(tailVerdict(notAccepted).cases['2:cancel.rejected-original-done'].status, 'failed');
});

test('cancel errors retain real done evidence and normal stop proves injections exhausted', () => {
  const fixture = tailFixture();
  fixture.backend.find(row => row.marker === 'cancel_timeout' && row.event === 'terminal').state = 'cancelled';
  fixture.backend.find(row => row.marker === 'tail_controlled_stop' && row.event === 'cancel_command').injected = true;
  const verdict = tailVerdict(fixture);
  assert.equal(verdict.cases['2:cancel.timeout-original-done'].status, 'failed');
  assert.equal(verdict.cases['2:cancel.normal-stop-after-injections'].status, 'failed');
  const partial = tailFixture(); partial.backend = partial.backend.filter(row => row.cycle !== 2 || row.event !== 'trace_health');
  assert.equal(tailVerdict(partial).cases['2:cancel.rejected-original-done'].status, 'partial');
});
