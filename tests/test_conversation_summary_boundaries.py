"""New execution batch: precise commit boundaries and encrypted import rollback."""
from __future__ import annotations
import asyncio
import json
from dataclasses import replace

import pytest
from tests.test_conversation_summary_runtime import harness, finish
from tests.test_conversation_summary_store import TOKEN, fill, exchange
from src.conversation_summary.store import SummaryStore
from src.kernel.storage import KernelStore
from src.persona.persona_card import Persona
from src.storage.encrypted_sqlite import install_storage_key, clear_storage_key_for_testing, SQLITE_HEADER


def change(runtime, policy, registry, persona, settings, action):
    if action == 'revoke': policy.revoke('conversation_summary')
    elif action == 'disable': settings.features.hypa_compression_enabled = False
    else:
        data=persona.to_dict(); data['name']='Replacement'; data['identity']['persona_id']='replacement'
        registry.activate_update(Persona(**data),registry.authorize_update(actor='owner',reason='synthetic boundary test',user_confirmed=True))


@pytest.mark.asyncio
@pytest.mark.parametrize('action',['revoke','disable','persona'])
async def test_guard_changes_before_dispatch_never_claim_or_call_provider(action):
    runtime,store,adapter,policy,registry,persona,settings=harness()
    original=store.select_source
    def paused(conversation):
        value=original(conversation)
        change(runtime,policy,registry,persona,settings,action)
        return value
    store.select_source=paused
    runtime.on_chat_committed('conversation_a','request_one')
    await finish(runtime)
    assert store.attempt is None and adapter.calls == [] and store.summaries == []
    assert runtime.capture_context('conversation_a','background') == ''
    await runtime.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize('action',['revoke','disable','persona'])
async def test_model_return_before_commit_revalidates_current_authority(action):
    runtime,store,adapter,policy,registry,persona,settings=harness()
    commits=0; original=runtime._commit
    def boundary(lease, callback):
        nonlocal commits
        commits+=1
        if commits==2: change(runtime,policy,registry,persona,settings,action)
        return original(lease,callback)
    runtime._commit=boundary
    adapter.release.set();runtime.on_chat_committed('conversation_a','request_one');await finish(runtime)
    assert len(adapter.calls)==1 and store.summaries==[]
    assert runtime.capture_context('conversation_a','background')==''
    assert not runtime.running
    await runtime.aclose()


@pytest.mark.asyncio
async def test_optional_summary_failure_does_not_cancel_unrelated_chat_task():
    runtime,store,adapter,policy,*_=harness()
    chat_started=asyncio.Event(); chat_continue=asyncio.Event()
    async def main_chat():
        chat_started.set();await chat_continue.wait();return 'committed chat result'
    chat=asyncio.create_task(main_chat());await chat_started.wait()
    runtime.on_chat_committed('conversation_a','request_one');await adapter.started.wait()
    policy.revoke('conversation_summary');await finish(runtime)
    assert not chat.cancelled() and not chat.done()
    chat_continue.set();assert await chat=='committed chat result'
    assert not store.summaries
    await runtime.aclose()


@pytest.mark.parametrize('failure',['budget_denied','timeout_unknown','cancelled_unknown'])
def test_failed_source_remains_excluded_after_budget_restore_cooldown_and_restart(tmp_path,failure):
    clear_storage_key_for_testing();install_storage_key(b'F'*32,require_encryption=True)
    kernel=KernelStore(tmp_path/'encrypted.sqlite3')
    try:
        store=SummaryStore(kernel,TOKEN);fill(kernel,count=40)
        source=store.select_source('conversation-a').source;assert source
        attempt=store.claim_attempt(source,now=1000);store.fail_attempt(attempt,failure,now=1001)
        kernel.close();kernel=KernelStore(tmp_path/'encrypted.sqlite3');restarted=SummaryStore(kernel,replace(TOKEN,epoch=2))
        assert restarted.claim_attempt(source,now=10000) is None
        new=restarted.select_source('conversation-a').source;assert new
        assert not set(m.message_id for m in source.messages)&set(m.message_id for m in new.messages)
        next_attempt=restarted.claim_attempt(new,now=1301);assert next_attempt
        restarted.complete_attempt(next_attempt,'new independent source summary',now=1302)
        assert len(restarted.active_summaries('conversation-a'))==1
        assert restarted.status('conversation-a')['attempts']=={'completed':1,'failed':1}
        assert not (tmp_path/'encrypted.sqlite3').read_bytes().startswith(SQLITE_HEADER)
    finally:
        kernel.close();clear_storage_key_for_testing()


def test_import_failure_on_second_entry_rolls_back_batch_and_first_entry(tmp_path):
    clear_storage_key_for_testing();install_storage_key(b'R'*32,require_encryption=True)
    kernel=KernelStore(tmp_path/'encrypted.sqlite3')
    try:
        store=SummaryStore(kernel,TOKEN);exchange(kernel,1)
        ids=[m['message_id'] for m in kernel.message_page('conversation-a')['items']]
        raw=json.dumps({'summaries':[{'text':'linked inactive','chat_ids':ids},{'text':'unattributed inactive','chat_ids':[]}]})
        original=raw.encode()
        with kernel.transaction() as connection:
            connection.execute("""CREATE TEMP TRIGGER fail_second_legacy BEFORE INSERT ON conversation_summary_items
                WHEN NEW.origin='legacy' AND NEW.legacy_position=1
                BEGIN SELECT RAISE(ABORT,'synthetic interrupted import'); END""")
        with pytest.raises(Exception,match='synthetic interrupted import'):
            store.import_legacy(raw,now=10)
        with kernel.transaction() as connection:
            assert connection.execute('SELECT COUNT(*) FROM conversation_summary_imports').fetchone()[0]==0
            assert connection.execute('SELECT COUNT(*) FROM conversation_summary_items').fetchone()[0]==0
            connection.execute('DROP TRIGGER fail_second_legacy')
        result=store.import_legacy(raw,now=11);assert result['imported']==2 and result['active']==0
        assert store.import_legacy(raw,now=12)['reused'] is True
        assert raw.encode()==original and not store.active_summaries('conversation-a')
        assert not (tmp_path/'encrypted.sqlite3').read_bytes().startswith(SQLITE_HEADER)
    finally:
        kernel.close();clear_storage_key_for_testing()

@pytest.mark.parametrize('source_file',['src/main.py','src/mvp_runtime.py'])
def test_both_production_constructor_expressions_bind_existing_encrypted_kernel(source_file,tmp_path,monkeypatch):
    # Executes the production composition expression, not a copied constructor.
    # This does not claim to start every optional module in full-mode main().
    import ast
    from pathlib import Path
    from types import SimpleNamespace
    from src.bridge.ws_bridge import bridge_state
    from src.config.settings import _Settings
    from src.config.usage_policy import UsagePolicy
    from src.persona.identity import PersonaEpochRegistry
    from src.persona.persona_card import default_persona
    from src.conversation_summary.runtime import ConversationSummaryRuntime,current_runtime_settings
    root=Path(__file__).resolve().parents[1]
    tree=ast.parse((root/source_file).read_text())
    constructors=[node for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='ConversationSummaryRuntime']
    assert len(constructors)==1
    sessions=[node for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='ChatSession']
    assert any(any(k.arg=='conversation_summary' and isinstance(k.value,ast.Name) and k.value.id=='conversation_summary' for k in node.keywords) for node in sessions)
    registry=PersonaEpochRegistry();token=registry.activate_initial(default_persona());settings=_Settings()
    monkeypatch.setattr(bridge_state,'settings',None)
    clear_storage_key_for_testing();install_storage_key(b'W'*32,require_encryption=True)
    kernel=KernelStore(tmp_path/'existing-kernel.sqlite3')
    try:
        adapter=SimpleNamespace(settings=settings.llm,usage_policy=UsagePolicy(lambda:current_runtime_settings(settings),save_callback=lambda _:None))
        context={'ConversationSummaryRuntime':ConversationSummaryRuntime,'SummaryStore':SummaryStore,'kernel_store':kernel,'summary_token':token,'adapter':adapter,'GLOBAL_PERSONA_EPOCH':registry,'persona_state':SimpleNamespace(registry=registry),'settings':settings,'current_runtime_settings':current_runtime_settings}
        runtime=eval(compile(ast.Expression(constructors[0]),'production-composition-expression','eval'),context)
        assert runtime.store.kernel_store is kernel and runtime.token==token and runtime.registry is registry
        assert runtime.enabled() is False and not runtime.policy.allowed('conversation_summary')
        replacement=_Settings();replacement.features.hypa_compression_enabled=True
        monkeypatch.setattr(bridge_state,'settings',replacement)
        assert runtime.enabled() is True and runtime.llm_settings_provider() is replacement.llm
        assert not runtime.running and not runtime.store.status('synthetic')['activeCount']
        assert not (tmp_path/'existing-kernel.sqlite3').read_bytes().startswith(SQLITE_HEADER)
    finally:
        kernel.close();clear_storage_key_for_testing()
