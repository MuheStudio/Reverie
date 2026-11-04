"""Existing encrypted game rows remain the only Xiangqi fact source."""
import asyncio
import json
import pytest
from src.games.state_store import GameStateStore, GameStateConflict
from src.storage.encrypted_sqlite import install_storage_key, clear_storage_key_for_testing, SQLITE_HEADER
from src.bridge import ws_bridge


def test_synthetic_legacy_move_array_and_revision_survive_encrypted_reopen(tmp_path):
    clear_storage_key_for_testing();install_storage_key(b'G'*32,require_encryption=True)
    path=tmp_path/'existing-games.sqlite3'; moves=[{'from':27,'to':36},{'from':54,'to':45}]
    try:
        store=GameStateStore(path);receipt=store.put('persona-a','xiangqi',moves,expected_revision=0)
        assert receipt['revision']==1
        with pytest.raises(GameStateConflict):store.put('persona-a','xiangqi',[],expected_revision=0)
        assert store.get('persona-a','xiangqi')['state']==moves
        assert store.get('persona-b','xiangqi')['exists'] is False
        store.close();store=GameStateStore(path)
        assert store.get('persona-a','xiangqi')['revision']==1
        assert store.get('persona-a','xiangqi')['state']==moves
        assert not path.read_bytes().startswith(SQLITE_HEADER)
        assert not (tmp_path/'xiangqi.json').exists()
        store.close()
    finally:clear_storage_key_for_testing()


@pytest.mark.asyncio
async def test_queued_game_write_does_not_apply_to_a_replacement_persona(tmp_path,monkeypatch):
    state=ws_bridge.BridgeState();store=GameStateStore(tmp_path/'games.sqlite3');state.game_state_store=store
    scope={'persona_id':'a','persona_epoch':1,'persona_fingerprint':'a'*64}
    lock=asyncio.Lock();checked=asyncio.Event();endpoint=object()
    monkeypatch.setattr(ws_bridge,'bridge_state',state);monkeypatch.setattr(ws_bridge,'_persona_effect_lock',lock)
    monkeypatch.setattr(ws_bridge,'_active_persona_scope',lambda:dict(scope));monkeypatch.setattr(ws_bridge,'_active_persona_id',lambda:scope['persona_id'])
    monkeypatch.setattr(ws_bridge,'_client_contexts',{endpoint:ws_bridge.BridgeClientContext('test',4,True)})
    original=ws_bridge._matches_expected_persona
    def matches(payload):
        answer=original(payload);checked.set();return answer
    monkeypatch.setattr(ws_bridge,'_matches_expected_persona',matches)
    await lock.acquire()
    task=asyncio.create_task(ws_bridge.dispatch_authenticated_message({'type':'game_state:put','request_id':'queued-xiangqi','payload':{
        'game_id':'xiangqi','state':[{'from':27,'to':36}],'expected_revision':0,'expected_persona_id':'a','expected_persona_epoch':1,'expected_persona_fingerprint':'a'*64,
    }},endpoint,emit_result=False))
    try:
        await checked.wait();scope.update(persona_id='b',persona_epoch=2,persona_fingerprint='b'*64);lock.release()
        assert (await task)['code']=='stale_persona'
        assert not store.get('a','xiangqi')['exists'] and not store.get('b','xiangqi')['exists']
    finally:
        if lock.locked():lock.release()
        if not task.done():task.cancel();await asyncio.gather(task,return_exceptions=True)
        store.close()


def test_v4_accepts_existing_move_arrays_and_keeps_payload_authority_strict():
    from src.kernel.contracts import CommandEnvelopeV4, PersonaScopeV4
    from pydantic import ValidationError
    scope=PersonaScopeV4(persona_id='a',epoch=1,fingerprint='a'*64)
    base={'request_id':'xiangqi-contract','idempotency_key':'xiangqi-contract','command':'game_state:put','persona':scope}
    moves=[{'from':27,'to':36},{'from':54,'to':45}]
    command=CommandEnvelopeV4(**base,payload={'game_id':'xiangqi','state':moves,'expected_revision':4})
    assert command.payload['state']==moves and command.persona==scope
    for invalid in [False,'plaintext state',4,None]:
        with pytest.raises(ValidationError):CommandEnvelopeV4(**base,payload={'game_id':'xiangqi','state':invalid,'expected_revision':4})
    with pytest.raises(ValidationError):CommandEnvelopeV4(**base,payload={'game_id':'xiangqi','state':moves,'expected_revision':4,'persona_id':'other'})
