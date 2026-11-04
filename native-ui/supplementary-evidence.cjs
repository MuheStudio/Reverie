'use strict';
// Mock-service behaviour and verdicts for the supplementary function audit.
// The native application records what the user could see and do; the mock
// service records which requests reached it. A case passes only when both
// agree, and a visible-feedback gap keeps it partial rather than passed.

const SAVED_MODEL = 'reverie-qt-supplement';
const FAILING_MODEL = 'reverie-qt-fail';
const SLOW_MODEL = 'reverie-qt-slow';
const LATE_REPLY = '迟到的旧回复，不应出现。';

function markerOf(text) {
  return (String(text || '').match(/补充-[^：:]+/) || [null])[0];
}

// Decides how the mock answers one chat-completion request.
function supplementaryResponse(body) {
  const lastUser = String(body?.messages?.filter(m => m.role === 'user').at(-1)?.content || '');
  const marker = markerOf(lastUser);
  const model = String(body?.model || '');
  if (model === FAILING_MODEL) return { marker, model, status: 500, delayMs: 0, kind: 'probe-failure' };
  const delayed = ['补充-延迟', '补充-受控延迟', '补充-受控停止'].includes(marker);
  const delayMs = model === SLOW_MODEL ? 4000 : delayed ? 8000 : 0;
  return { marker, model, status: 200, delayMs, kind: marker ? 'chat' : 'probe',
    content: delayed ? LATE_REPLY : '一起看看这片星空。' };
}

// `finish` means the server completed its write. It is deliberately not a
// client-receive acknowledgement. `close` can follow a successful write too.
function attachResponseLifecycle(response, call, now) {
  Object.assign(call, { actualResponseWritten: false, connectionClosed: false });
  response.once('finish', () => {
    call.actualResponseWritten = true;
    call.responseWrittenAtMs = now();
  });
  response.once('close', () => {
    call.connectionClosed = true;
    call.connectionClosedAtMs = now();
    call.connectionClosedBeforeResponse = !call.actualResponseWritten;
  });
  response.once('error', () => { call.responseWriteFailed = true; call.responseWriteFailedAtMs = now(); });
}
function writeSupplementaryResponse(response, call, status, body, now) {
  if (response.destroyed || response.writableEnded) {
    call.responseWriteSkipped = 'connection-closed-before-write';
    return false;
  }
  call.responseWriteAttemptedAtMs = now();
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(body);
  return true;
}

// The bootstrap emits only bounded metadata. Keep an explicit allowlist at
// the report boundary as well; backend.log is never copied into a report.
function backendMetadata(rows) {
  const fields = new Set(['schema', 'event', 'cycle', 'unix_ms', 'monotonic_ns', 'request_id',
    'marker', 'gate_state', 'epoch', 'start_delay_seconds', 'reason', 'injected',
    'state', 'provider_state', 'provider_may_have_been_called', 'accepted', 'subject_request_id', 'endpoint_role',
    'complete', 'overflow', 'dropped_events', 'error_type']);
  const events = new Set(['bootstrap', 'gate', 'accept', 'plan', 'generate', 'provider_dispatch', 'terminal', 'cancel_command', 'trace_health']);
  return rows.filter(row => row?.schema === 'reverie.qt.p0.backend.metadata.v1' && events.has(row.event))
    .map(row => Object.fromEntries(Object.entries(row).filter(([key, value]) => fields.has(key)
      && ['string', 'number', 'boolean'].includes(typeof value))));
}

const PASSING = new Set(['passed', 'partial']);

function supplementaryVerdicts(reports, calls, { endpoint, backend = [] } = {}) {
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  const cases = {};
  const observations = {};
  for (const report of reports) {
    const data = report?.supplementary || {};
    observations[report.cycle] = data.observations || {};
    for (const id of data.order || Object.keys(data.cases || {}))
      cases[`${report.cycle}:${id}`] = { ...(data.cases?.[id] || { status: 'not-executed' }) };
  }
  const by = (marker, cycle) => calls.filter(c => c.marker === marker && (cycle == null || c.cycle === cycle));
  const scheduling = (marker, cycle, injected) => {
    const plans = backend.filter(row => row.event === 'plan' && row.marker === marker && row.cycle === cycle);
    const health = backend.find(row => row.event === 'trace_health' && row.cycle === cycle);
    const complete = health?.complete === true && health?.overflow === false && health?.dropped_events === 0;
    return { backendEvidenceComplete: complete, plannerObserved: plans.length > 0, plannerInjected: plans.map(row => row.injected),
      plannerDelays: plans.map(row => row.start_delay_seconds),
      ok: !complete || (plans.length === 1 && plans[0].injected === injected),
      gap: !complete ? 'backend scheduling metadata is incomplete; no product failure is inferred from that evidence gap' : null };
  };
  const delayedEvidence = (marker, cycle) => {
    const c = by(marker, cycle);
    return { ok: c.length === 1, reachedService: c.length,
      actualResponseWritten: c[0]?.actualResponseWritten === true,
      connectionClosed: c[0]?.connectionClosed === true,
      connectionClosedBeforeResponse: c[0]?.connectionClosedBeforeResponse === true,
      receivedAtMs: c[0]?.receivedAtMs, responseWrittenAtMs: c[0]?.responseWrittenAtMs,
      connectionClosedAtMs: c[0]?.connectionClosedAtMs,
      clientReceiveAcknowledged: false,
      scope: 'Server lifecycle and absence of an application reply; server writes do not acknowledge client receipt' };
  };
  const evidence = {
    '1:service.test-and-save': () => {
      const saved = observations[1]?.['service.savedProvider'] || {};
      const probes = calls.filter(c => c.model === SAVED_MODEL && !c.marker);
      return { ok: saved.model === SAVED_MODEL && same(saved.base_url, endpoint) && probes.length >= 1,
        savedModel: saved.model, savedEndpoint: saved.base_url, expectedEndpoint: endpoint, probes: probes.length };
    },
    '1:service.failure-keeps-config': () => {
      const failed = calls.filter(c => c.model === FAILING_MODEL);
      return { ok: failed.length >= 1, failingProbes: failed.length };
    },
    '1:service.chat-uses-saved-config': () => {
      const c = by('补充-配置');
      return { ok: c.length === 1 && c[0].model === SAVED_MODEL, calls: c.length, models: c.map(x => x.model) };
    },
    '1:network.pause-during-reply': () => {
      const c = by('补充-延迟');
      return { ...delayedEvidence('补充-延迟', 1), ok: c.length <= 1, reachedService: c.length,
        gap: c.length === 0 ? 'the delayed request had not reached the service when paused, so late-reply rejection was not exercised' : null };
    },
    '1:network.no-calls-while-paused': () => ({ ok: by('补充-暂停中').length === 0, calls: by('补充-暂停中').length }),
    '1:network.resume': () => {
      const c = by('补充-恢复', 1), plan = scheduling('original_recovery', 1, false);
      return { ...plan, ok: c.length === 1 && c[0].model === SAVED_MODEL && plan.ok,
        calls: c.length, originalReplyDeadlineMs: 20000 };
    },
    '1:network.controlled-pause-during-reply': () => {
      const service = delayedEvidence('补充-受控延迟', 1), plan = scheduling('controlled_delay', 1, true);
      return { ...service, ...plan, ok: service.ok && plan.ok };
    },
    '1:network.stop-during-reply': () => {
      const service = delayedEvidence('补充-受控停止', 1), plan = scheduling('controlled_stop', 1, true);
      return { ...service, ...plan, ok: service.ok && plan.ok };
    },
    '1:network.controlled-resume': () => {
      const c = by('补充-受控恢复', 1), plan = scheduling('controlled_recovery', 1, true);
      return { ...plan, ok: c.length === 1 && c[0].model === SAVED_MODEL && plan.ok,
        calls: c.length, replyDeadlineMs: 20000 };
    },
    '2:restart.no-calls-while-paused': () => ({ ok: by('补充-重启暂停').length === 0, calls: by('补充-重启暂停').length }),
    '2:restart.resume-uses-saved-config': () => {
      const c = by('补充-重启恢复', 2), plan = scheduling('original_restart_recovery', 2, false);
      return { ...plan, ok: c.length === 1 && c[0].model === SAVED_MODEL && plan.ok,
        calls: c.length, models: c.map(x => x.model), originalReplyDeadlineMs: 20000 };
    },
    '2:restart.controlled-resume-uses-saved-config': () => {
      const c = by('补充-受控恢复', 2), plan = scheduling('controlled_recovery', 2, true);
      return { ...plan, ok: c.length === 1 && c[0].model === SAVED_MODEL && plan.ok,
        calls: c.length, models: c.map(x => x.model), replyDeadlineMs: 20000 };
    },
    '2:restart.model-selection-restored': () => {
      const before = { path: observations[1]?.['restart.preparedAvatarPath'], ...(observations[1]?.['restart.preparedActive'] || {}) };
      const after = { path: observations[2]?.['restart.avatarPath'], ...(observations[2]?.['restart.active'] || {}) };
      const keys = ['path', 'id', 'name', 'modelPath', 'motions', 'expressions'];
      return { ok: Boolean(before.path && before.id) && keys.every(k => JSON.stringify(before[k]) === JSON.stringify(after[k])),
        before, after };
    },
    '2:restart.service-persisted': () => {
      const restored = observations[2]?.['restart.provider'] || {};
      return { ok: restored.model === SAVED_MODEL && same(restored.base_url, endpoint),
        restoredModel: restored.model, restoredEndpoint: restored.base_url };
    }
  };
  for (const [id, check] of Object.entries(evidence)) {
    const item = cases[id];
    if (!item) continue;
    const result = check();
    item.serviceEvidence = result;
    if (!PASSING.has(item.status)) continue;
    if (!result.ok) {
      item.status = 'failed';
      item.error = (item.error ? item.error + '; ' : '') + 'SERVICE_EVIDENCE_MISMATCH';
    } else if (result.gap) {
      item.status = 'partial';
      item.gaps = [...(item.gaps || []), result.gap];
    }
  }
  const counts = {};
  for (const item of Object.values(cases)) counts[item.status] = (counts[item.status] || 0) + 1;
  return { cases, counts, allPassed: Object.keys(cases).length > 0 && Object.values(cases).every(c => c.status === 'passed'),
    limitations: ['Native input is synthetic; the OS folder picker is supplied through its existing import method',
      'One authorized model verifies reselect and restart, without establishing switching between different models',
      'Actual server response writes and closed connections do not prove client receipt'] };
}

module.exports = { SAVED_MODEL, FAILING_MODEL, SLOW_MODEL, LATE_REPLY, markerOf,
  supplementaryResponse, supplementaryVerdicts, attachResponseLifecycle, writeSupplementaryResponse, backendMetadata };

const P0_TAIL_MODEL = 'reverie-qt-p0-tail';
const P0_TAIL_CASES = {
  1: ['setup.connected', 'permissions.grant-a', 'provider.switch-b-revokes-a', 'permissions.grant-b-revoke-b',
    'provider.chat-only-b', 'network.controlled-pause', 'network.restore-once', 'restart.prepare-b-paused'],
  2: ['setup.connected', 'restart.b-paused-permission', 'restart.paused-draft-no-calls', 'restart.resume-controlled-b',
    'provider.return-a-no-resurrection', 'cancel.rejected-original-done', 'cancel.timeout-original-done',
    'cancel.normal-stop-after-injections']
};
function p0TailResponse(body) {
  const text = String(body?.messages?.filter(m => m.role === 'user').at(-1)?.content || '');
  const marker = (text.match(/^(补充-[^：:]+)[：:]/) || [null, null])[1];
  const delayed = ['补充-尾部受控延迟', '补充-尾部受控停止', '补充-取消拒绝'].includes(marker);
  return { kind: marker ? 'chat' : 'probe', marker, model: String(body?.model || ''), status: 200,
    delayMs: delayed ? 8000 : 0, content: delayed ? LATE_REPLY : '一起看看这片星空。' };
}
function p0TailVerdicts(reports, calls, { endpoints = {}, backend = [] } = {}) {
  const cases = {}, observations = {}, nativeCases = {};
  const validReports = reports.length === 2 && [1, 2].every(cycle => reports.filter(r => r.cycle === cycle).length === 1);
  for (const cycle of [1, 2]) {
    const data = reports.find(r => r.cycle === cycle)?.p0Tail || {};
    observations[cycle] = data.observations || {};
    nativeCases[cycle] = data.cases || {};
    for (const id of P0_TAIL_CASES[cycle]) cases[`${cycle}:${id}`] = {
      ...(data.cases?.[id] || { status: 'not-executed', error: 'P0_TAIL_CASE_MISSING' }) };
  }
  const obs = (cycle, key) => observations[cycle][key] || {};
  const exactProvider = (value, role) => value.model === P0_TAIL_MODEL && value.base_url === endpoints[role];
  const origin = role => { try { return new URL(endpoints[role]).origin; } catch { return null; } };
  const permission = (value, role, enabled) => value.known === true && value.enabled === enabled &&
    value.current_provider === 'ollama' && value.current_origin === origin(role) &&
    (!enabled || (value.provider === 'ollama' && value.origin === origin(role)));
  const refreshed = (cycle, label) => {
    const value = obs(cycle, 'permission.auto-refresh-' + label);
    return typeof value.requestId === 'string' && value.requestId.length >= 8 &&
      Number.isInteger(value.contextEpochBefore) && value.contextEpochBefore >= 0 && value.contextEpochAfter > value.contextEpochBefore;
  };
  const complete = cycle => {
    const health = backend.filter(row => row.event === 'trace_health' && row.cycle === cycle);
    return health.length === 1 && health[0].complete === true && health[0].overflow === false && health[0].dropped_events === 0;
  };
  const chat = (cycle, marker, plannerMarker, role, terminal) => {
    const requestId = obs(cycle, 'chat.' + marker).requestId;
    const service = calls.filter(c => c.marker === marker && c.cycle === cycle);
    const scoped = backend.filter(row => row.cycle === cycle && row.request_id === requestId && row.marker === plannerMarker);
    const accepted = scoped.filter(row => row.event === 'accept' && row.accepted === true);
    const allAccepted = backend.filter(row => row.cycle === cycle && row.marker === plannerMarker && row.event === 'accept' && row.accepted === true);
    const plans = scoped.filter(row => row.event === 'plan');
    const dispatch = scoped.filter(row => row.event === 'provider_dispatch');
    const terminals = scoped.filter(row => row.event === 'terminal');
    const expectedStart = plannerMarker === 'cancel_timeout' ? 40 : 0.2;
    const backendEvidenceComplete = complete(cycle);
    const traceOK = accepted.length === 1 && allAccepted.length === 1 && plans.length === 1 &&
      plans[0].injected === true && plans[0].start_delay_seconds === expectedStart && dispatch.length === 1 &&
      dispatch[0].endpoint_role === role && terminals.length >= 1 && terminals.every(row => row.state === terminal);
    const serviceOK = typeof requestId === 'string' && requestId.length >= 8 && service.length === 1 &&
      service[0].endpoint === role && service[0].endpointUrl === endpoints[role] && service[0].model === P0_TAIL_MODEL &&
      service[0].status === 200 && (terminal !== 'done' || service[0].actualResponseWritten === true);
    return { ok: serviceOK && (!backendEvidenceComplete || traceOK), requestId, serviceCalls: service.length,
      serviceEndpoints: service.map(c => c.endpoint), serviceModels: service.map(c => c.model),
      actualResponseWritten: service[0]?.actualResponseWritten === true, acceptedRequests: accepted.length,
      startDelaySeconds: plans.map(row => row.start_delay_seconds), plannerInjected: plans.map(row => row.injected),
      terminalStates: terminals.map(row => row.state), providerEndpointRoles: dispatch.map(row => row.endpoint_role),
      backendEvidenceComplete, clientReceiveAcknowledged: false,
      gap: backendEvidenceComplete ? null : 'backend metadata is incomplete; exact request acceptance and terminal state remain unverified' };
  };
  const cancel = (cycle, marker, plannerMarker, injected, reason) => {
    const original = obs(cycle, 'chat.' + marker).requestId;
    const native = obs(cycle, 'cancel.' + marker).requestId ? obs(cycle, 'cancel.' + marker) : obs(cycle, 'chat.stop.' + marker);
    const rows = backend.filter(row => row.cycle === cycle && row.event === 'cancel_command' &&
      row.request_id === native.requestId && row.subject_request_id === original && row.marker === plannerMarker);
    const allForSubject = backend.filter(row => row.cycle === cycle && row.event === 'cancel_command' && row.subject_request_id === original);
    const backendEvidenceComplete = complete(cycle);
    return { ok: typeof native.requestId === 'string' && native.requestId.length >= 8 && native.subjectRequestId === original &&
      (!backendEvidenceComplete || (rows.length === 1 && allForSubject.length === 1 && rows[0].accepted === true &&
        rows[0].injected === injected && rows[0].reason === reason)),
      cancelRequestId: native.requestId, subjectRequestId: original, cancelCommands: rows.length,
      cancelAccepted: rows[0]?.accepted, cancelInjected: rows[0]?.injected, cancelReason: rows[0]?.reason, backendEvidenceComplete,
      gap: backendEvidenceComplete ? null : 'backend cancel-command metadata is incomplete' };
  };
  const combine = (...values) => ({ ...Object.assign({}, ...values), ok: values.every(value => value.ok),
    gaps: values.map(value => value.gap).filter(Boolean) });
  const checks = {
    '1:setup.connected': () => ({ ok: validReports && exactProvider(obs(1, 'setup.provider'), 'A') }),
    '1:permissions.grant-a': () => ({ ok: permission(obs(1, 'permission.grant-a'), 'A', true) }),
    '1:provider.switch-b-revokes-a': () => ({ ok: exactProvider(obs(1, 'provider.saved-b'), 'B') &&
      permission(obs(1, 'permission.after-b'), 'B', false) && refreshed(1, 'b') &&
      calls.some(c => c.kind === 'probe' && c.endpoint === 'B' && c.cycle === 1 && c.model === P0_TAIL_MODEL) }),
    '1:permissions.grant-b-revoke-b': () => ({ ok: permission(obs(1, 'permission.grant-b'), 'B', true) &&
      permission(obs(1, 'permission.revoked-b'), 'B', false) }),
    '1:provider.chat-only-b': () => chat(1, '补充-尾部服务B', 'tail_service_b', 'B', 'done'),
    '1:network.controlled-pause': () => chat(1, '补充-尾部受控延迟', 'tail_controlled_delay', 'B', 'cancelled'),
    '1:network.restore-once': () => chat(1, '补充-尾部受控恢复', 'tail_controlled_recovery', 'B', 'done'),
    '1:restart.prepare-b-paused': () => ({ ok: exactProvider(obs(1, 'restart.preparedProvider'), 'B') &&
      permission(obs(1, 'restart.preparedPermission'), 'B', false) && observations[1]['restart.preparedPaused'] === true }),
    '2:setup.connected': () => ({ ok: validReports && exactProvider(obs(2, 'setup.provider'), 'B') }),
    '2:restart.b-paused-permission': () => ({ ok: exactProvider(obs(2, 'restart.provider'), 'B') &&
      permission(obs(2, 'restart.permission'), 'B', false) && observations[2]['restart.paused'] === true &&
      ['enabled', 'effective', 'provider', 'origin', 'current_provider', 'current_origin'].every(key =>
        obs(1, 'restart.preparedPermission')[key] === obs(2, 'restart.permission')[key]) }),
    '2:restart.paused-draft-no-calls': () => ({ ok: observations[2]['restart.pausedDraftPreserved'] === true &&
      calls.filter(c => c.marker === '补充-尾部重启暂停').length === 0, calls: calls.filter(c => c.marker === '补充-尾部重启暂停').length }),
    '2:restart.resume-controlled-b': () => chat(2, '补充-尾部受控恢复', 'tail_controlled_recovery', 'B', 'done'),
    '2:provider.return-a-no-resurrection': () => combine({ ok: exactProvider(obs(2, 'provider.saved-a-returned'), 'A') &&
      permission(obs(2, 'permission.after-a-returned'), 'A', false) && refreshed(2, 'a-returned') &&
      calls.some(c => c.kind === 'probe' && c.endpoint === 'A' && c.cycle === 2 && c.model === P0_TAIL_MODEL) },
      chat(2, '补充-尾部服务A', 'tail_service_a', 'A', 'done')),
    '2:cancel.rejected-original-done': () => combine(chat(2, '补充-取消拒绝', 'cancel_reject', 'A', 'done'),
      cancel(2, '补充-取消拒绝', 'cancel_reject', true, 'fixture_rejected')),
    '2:cancel.timeout-original-done': () => combine(chat(2, '补充-取消超时', 'cancel_timeout', 'A', 'done'),
      cancel(2, '补充-取消超时', 'cancel_timeout', true, 'fixture_ack_timeout'),
      { ok: nativeCases[2]['cancel.timeout-original-done']?.caseDeadlineMs === 55000 &&
        obs(2, 'cancel.补充-取消超时').stepElapsedMs >= 29000 && obs(2, 'cancel.补充-取消超时').caseElapsedMs < 40000,
        cancelAcknowledgementDeadlineMs: 30000, testcaseDeadlineMs: 55000 }),
    '2:cancel.normal-stop-after-injections': () => combine(chat(2, '补充-尾部受控停止', 'tail_controlled_stop', 'A', 'cancelled'),
      cancel(2, '补充-尾部受控停止', 'tail_controlled_stop', false, 'passthrough'))
  };
  for (const [id, check] of Object.entries(checks)) {
    const item = cases[id], evidence = check();
    item.serviceEvidence = evidence;
    if (!PASSING.has(item.status)) continue;
    if (!evidence.ok) { item.status = 'failed'; item.error = 'P0_TAIL_EVIDENCE_MISMATCH'; }
    else if (evidence.gap || evidence.gaps?.length) {
      item.status = 'partial'; item.gaps = [...(item.gaps || []), ...(evidence.gaps || [evidence.gap])];
    }
  }
  const unexpectedCases = reports.flatMap(report => Object.keys(report.p0Tail?.cases || {})
    .filter(id => !P0_TAIL_CASES[report.cycle]?.includes(id)).map(id => `${report.cycle}:${id}`));
  const counts = {};
  for (const item of Object.values(cases)) counts[item.status] = (counts[item.status] || 0) + 1;
  return { cases, counts, unexpectedCases, allPassed: validReports && unexpectedCases.length === 0 &&
    Object.values(cases).every(item => item.status === 'passed'),
    applicationDeadlineMs: 240000, cycleDeadlineMs: 205000,
    limitations: ['Synthetic native input and test positioning do not establish physical keyboard or scroll interaction',
      'Server response writes do not acknowledge client receipt; native terminal feedback is checked separately'] };
}
Object.assign(module.exports, { P0_TAIL_MODEL, P0_TAIL_CASES, p0TailResponse, p0TailVerdicts });
