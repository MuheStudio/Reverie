"""Synthetic authorization/import boundaries; no application or real data."""
import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from src.bridge import ws_bridge
from src.config.settings import _Settings, FeatureSettings
from src.config.usage_policy import UsagePolicy, UsagePolicyDenied
from src.kernel.contracts import SummaryLegacyImportPayload, SummaryLegacyPreviewPayload, SettingsUpdatePayload


def test_summary_does_not_inherit_autonomous_memory_consent():
    settings = _Settings(features=FeatureSettings(hypa_compression_enabled=True, autonomous_memory_llm_enabled=True))
    policy = UsagePolicy(lambda: settings)
    policy.grant('memory_enrichment')
    with pytest.raises(UsagePolicyDenied):
        policy.begin_for_purpose('memory_summary', background=True)
    policy.grant('conversation_summary')
    lease = policy.begin_for_purpose('memory_summary', background=True)
    assert lease.feature == 'conversation_summary'
    policy.finish(lease)
    policy.revoke('conversation_summary')
    assert policy.allowed('memory_enrichment') is True
    settings.features.autonomous_memory_llm_enabled = False
    policy.grant('conversation_summary')
    assert policy.allowed('conversation_summary') is True
    assert policy.allowed('memory_enrichment') is False


def test_wire_requires_explicit_confirmation_digest_and_content_only():
    payload = {'content': '{"summaries":[]}', 'expected_sha256': 'a' * 64, 'confirmed': True}
    assert SummaryLegacyImportPayload.model_validate(payload).confirmed
    for mutation in ({'confirmed': False}, {'confirmed': 1}, {'expected_sha256': 'x'}, {'path': '/not-readable'}):
        with pytest.raises(ValidationError):
            SummaryLegacyImportPayload.model_validate({**payload, **mutation})
    with pytest.raises(ValidationError):
        SummaryLegacyPreviewPayload(content='界' * 45000)
    assert SettingsUpdatePayload(section='features', hypa_compression_enabled=True).hypa_compression_enabled
    with pytest.raises(ValidationError):
        SettingsUpdatePayload(section='memory', hypa_compression_enabled=True)


@pytest.mark.asyncio
@pytest.mark.parametrize('command', ['summary:status', 'summary:get', 'summary:legacy:preview', 'summary:legacy:import'])
async def test_summary_request_queued_before_persona_switch_cannot_touch_new_scope(monkeypatch, command):
    state = ws_bridge.BridgeState()
    calls = []
    state.session = SimpleNamespace(conversation_summary=SimpleNamespace(require_current=lambda: calls.append('touch')))
    scope = {'persona_id': 'a', 'persona_epoch': 1, 'persona_fingerprint': 'a' * 64}
    checked, lock = asyncio.Event(), asyncio.Lock()
    endpoint = object()
    monkeypatch.setattr(ws_bridge, 'bridge_state', state)
    monkeypatch.setattr(ws_bridge, '_persona_effect_lock', lock)
    monkeypatch.setattr(ws_bridge, '_active_persona_scope', lambda: dict(scope))
    monkeypatch.setattr(ws_bridge, '_client_contexts', {endpoint: ws_bridge.BridgeClientContext('test', 4, True)})
    original = ws_bridge._matches_expected_persona
    def matches(payload):
        result = original(payload)
        checked.set()
        return result
    monkeypatch.setattr(ws_bridge, '_matches_expected_persona', matches)
    await lock.acquire()
    task = asyncio.create_task(ws_bridge.dispatch_authenticated_message({
        'type': command, 'request_id': 'summary-queued-synthetic', 'payload': {
            'content': '{"summaries":[]}', 'expected_sha256': 'a' * 64, 'confirmed': True,
            'expected_persona_id': 'a', 'expected_persona_epoch': 1, 'expected_persona_fingerprint': 'a' * 64,
        }}, endpoint, emit_result=False))
    try:
        await checked.wait()
        assert not task.done()
        scope.update(persona_id='b', persona_epoch=2, persona_fingerprint='b' * 64)
        lock.release()
        assert (await task)['code'] == 'stale_persona'
        assert calls == []
    finally:
        if lock.locked(): lock.release()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

@pytest.mark.asyncio
async def test_disable_persists_even_when_provider_cleanup_cannot_be_confirmed(monkeypatch):
    import src.config.settings as configuration
    settings = _Settings(features=FeatureSettings(hypa_compression_enabled=True))
    saved = []
    async def cannot_clean():
        assert saved == [False]
        raise RuntimeError('synthetic uncooperative task')
    state = ws_bridge.BridgeState()
    state.settings = settings
    state.session = SimpleNamespace(conversation_summary=SimpleNamespace(cancel_pending=cannot_clean))
    monkeypatch.setattr(ws_bridge, 'bridge_state', state)
    monkeypatch.setattr(configuration, 'save_settings', lambda value: saved.append(value.features.hypa_compression_enabled))
    result = await ws_bridge.handle_settings_update({'section': 'features', 'hypa_compression_enabled': False}, object())
    assert result['ok'] is False
    assert result['code'] == 'summary_cleanup_unconfirmed'
    assert result['features']['hypa_compression_enabled'] is False
    assert saved == [False]

@pytest.mark.asyncio
async def test_import_preview_public_response_is_bounded_and_contains_no_record_identifiers(monkeypatch):
    import json
    entries = [{'persona_id': 'private-other-scope', 'position': i} for i in range(10000)]
    runtime = SimpleNamespace(
        require_current=lambda: None,
        commit_local=lambda callback: callback(),
        store=SimpleNamespace(preview_legacy=lambda document: {
            'sha256': document.sha256, 'total': 10000, 'linked': 0,
            'unattributed': 10000, 'active': 0, 'entries': entries,
        }),
    )
    state = ws_bridge.BridgeState()
    state.session = SimpleNamespace(conversation_summary=runtime)
    monkeypatch.setattr(ws_bridge, 'bridge_state', state)
    monkeypatch.setattr(ws_bridge, '_active_persona_scope', lambda: {'persona_id': 'a'})
    result = await ws_bridge.handle_summary_legacy_preview({'content': '{"summaries":[]}'}, object())
    assert result['total'] == 10000
    assert len(json.dumps(result)) < 512
    assert 'entries' not in result
    assert 'private-other-scope' not in json.dumps(result)


def test_import_ledger_binds_exact_bytes_without_storing_a_second_copy(tmp_path):
    import hashlib
    import json
    from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
    from src.kernel.storage import KernelStore, IdempotencyConflict
    store = KernelStore(tmp_path / 'synthetic-ledger.db')
    content = '{"summaries":[{"text":"synthetic-private-original"}]}'
    command = CommandEnvelopeV4(command='summary:legacy:import', request_id='summary-import-id',
        idempotency_key='summary-import-id', persona=PersonaScopeV4(persona_id='a', epoch=1, fingerprint='a'*64),
        payload={'content': content, 'expected_sha256': hashlib.sha256(content.encode()).hexdigest(), 'confirmed': True})
    try:
        store.begin_command(command)
        with store.transaction() as connection:
            row = connection.execute('SELECT request_json FROM command_ledger WHERE request_id=?', (command.request_id,)).fetchone()[0]
        assert 'synthetic-private-original' not in row
        assert json.loads(row)['payload']['content_identity']['sha256'] == hashlib.sha256(content.encode()).hexdigest()
        store.commit_command_result(command, {'ok': True})
        assert store.begin_command(command).state == 'committed'
        changed = command.model_copy(update={'payload': {**command.payload, 'content': content + ' '}})
        with pytest.raises(IdempotencyConflict): store.begin_command(changed)
        assert command.payload['content'] == content
    finally:
        store.close()
