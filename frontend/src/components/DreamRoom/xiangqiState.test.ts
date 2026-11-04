import { describe, expect, it, vi } from 'vitest';
import { XiangqiState, type XiangqiClient } from './xiangqiState';
const a={persona_id:'a',persona_epoch:1,persona_fingerprint:'a'.repeat(64)};
const b={persona_id:'b',persona_epoch:2,persona_fingerprint:'b'.repeat(64)};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const stored=[{from:27,to:36},{from:54,to:45}];
function client(handler:(type:string,payload:Record<string,unknown>,options:unknown)=>unknown):XiangqiClient {
  return {request:vi.fn(async (type,payload,options)=>handler(type,payload as Record<string,unknown>,options))} as XiangqiClient;
}
describe('canonical Xiangqi persistence and scope',()=>{
  it('loads a synthetic existing game without migrating or rewriting it',async()=>{
    const c=client(()=>({ok:true,exists:true,revision:7,state:stored})),state=new XiangqiState(c,a,true);await state.load();
    expect(state.getSnapshot()).toMatchObject({status:'ready',revision:7,moves:stored});expect(c.request).toHaveBeenCalledTimes(1);
    expect((c.request as ReturnType<typeof vi.fn>).mock.calls[0][2].personaScope).toEqual(a);
  });
  it('preserves invalid whole records and resets only with the original revision',async()=>{
    const calls:unknown[]=[];const invalid=[{from:27,to:36},{from:54,to:70}];
    const c=client((type,payload)=>{calls.push(payload);return type==='game_state:get'?{ok:true,exists:true,revision:8,state:invalid}:{ok:true,revision:9,state:[]};});
    const state=new XiangqiState(c,a,true);await state.load();expect(state.getSnapshot().status).toBe('invalid');expect(calls).toHaveLength(1);
    expect(state.submit(stored)).toBe(false);expect(state.submit([],true)).toBe(true);await tick();
    expect(calls[1]).toEqual({game_id:'xiangqi',state:[],expected_revision:8});expect(invalid).toEqual([{from:27,to:36},{from:54,to:70}]);expect(state.getSnapshot().revision).toBe(9);
  });
  it('does not fall back to browser state or a reset after malformed/failed reads',async()=>{
    for(const result of [{ok:false},{ok:true,revision:7,state:stored},{ok:true,exists:true,revision:true,state:stored}]){
      const c=client(()=>result),state=new XiangqiState(c,a,true);await state.load();expect(state.getSnapshot().status).toBe('failed');expect(c.request).toHaveBeenCalledTimes(1);expect(state.submit([],true)).toBe(false);
    }
  });
  it('serializes writes and adopts the authoritative conflict instead of replaying an old move',async()=>{
    let release!:(value:unknown)=>void;
    const c=client((type)=>type==='game_state:get'?{ok:true,exists:true,revision:3,state:[]} : new Promise(resolve=>{release=resolve;}));
    const state=new XiangqiState(c,a,true);await state.load();expect(state.submit([{from:27,to:36}])).toBe(true);
    expect(state.submit([])).toBe(false);release({ok:false,code:'conflict',revision:4,state:stored});await tick();
    expect(state.getSnapshot()).toMatchObject({revision:4,status:'ready',moves:stored});expect(c.request).toHaveBeenCalledTimes(2);
  });
  it('ignores an old persona load and never creates a game in the replacement persona',async()=>{
    let release!:(value:unknown)=>void;const c=client(()=>new Promise(resolve=>{release=resolve;}));
    const old=new XiangqiState(c,a,true),pending=old.load();old.dispose();const next=new XiangqiState(client(()=>({ok:true,exists:true,revision:1,state:[]})),b,true);await next.load();
    release({ok:true,exists:false,revision:0,state:null});await pending;expect(c.request).toHaveBeenCalledTimes(1);expect(next.getSnapshot().moves).toEqual([]);
  });
  it('keeps old async results invalid across React effect cleanup and reactivation',async()=>{
    let release!:(value:unknown)=>void;let calls=0;const c=client(()=>++calls===1?new Promise(resolve=>{release=resolve;}):{ok:true,exists:true,revision:5,state:stored});
    const state=new XiangqiState(c,a,true),old=state.load();state.dispose();state.activate();await state.load();
    release({ok:true,exists:false,revision:0,state:null});await old;expect(state.getSnapshot().revision).toBe(5);expect(c.request).toHaveBeenCalledTimes(2);
  });
  it('does not retry a save with an unknown result, but a fresh read can recover it',async()=>{
    let saved=false;const c=client((type)=>{if(type==='game_state:put'){saved=true;throw Error('synthetic response lost');}return {ok:true,exists:true,revision:saved?2:1,state:saved?stored:[]};});
    const state=new XiangqiState(c,a,true);await state.load();state.submit(stored);await tick();expect(state.getSnapshot().status).toBe('failed');expect(c.request).toHaveBeenCalledTimes(2);
    await state.load();expect(state.getSnapshot()).toMatchObject({status:'ready',revision:2,moves:stored});expect(c.request).toHaveBeenCalledTimes(3);
  });
});
