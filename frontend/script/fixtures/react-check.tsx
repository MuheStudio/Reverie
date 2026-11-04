import React from 'react';
import { createRoot } from 'react-dom/client';
import MiniGamePanel from '../../src/components/DreamRoom/MiniGamePanel';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, message: string) {
  const end = Date.now() + 2200;
  while (Date.now() < end) { if (test()) return; await pause(15); }
  throw new Error(message);
}
function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
async function scenario(kind: 'before' | 'inflight' | 'reverse' | 'reset' | 'unmount' | 'persona' | 'refresh-invalid') {
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  let moves = kind === 'refresh-invalid' ? [] : [{ from: 27, to: 36 }], revision = 1, calls = 0;
  let complete: ((value: unknown) => void) | undefined;
  let mounted = true;
  const client = {
    personaScope: { persona_id: 'synthetic', persona_epoch: 1, persona_fingerprint: 'a'.repeat(64) },
    request: async (type: string, payload: any) => {
      if (type === 'game_state:get') return { ok: true, exists: true, state: moves, revision };
      if (type === 'game_state:put') {
        assert(payload.expected_revision === revision, 'unexpected duplicate/stale save');
        moves = payload.state; revision++;
        return { ok: true, state: moves, revision };
      }
      if (type === 'game:move') {
        assert(payload.state.board_text.includes('黑车') && payload.state.board_text.includes('红马') && payload.state.board_text.includes('y=0'), 'model input lost piece or coordinate identity');
        calls++; return new Promise(resolve => { complete = resolve; });
      }
      throw new Error(type);
    },
  };
  try {
    root.render(<MiniGamePanel game="xiangqi" connected gameStateClient={client as any} onInviteAI={() => {}} />);
    await until(() => document.querySelector('[data-testid="xiangqi-game"]')?.getAttribute('data-state') === 'ready', 'component did not load synthetic history');
    if (kind === 'refresh-invalid') {
      root.render(<MiniGamePanel game="xiangqi" connected active={false} gameStateClient={client as any} onInviteAI={() => {}} />);
      await pause(50); moves = [{from:0,to:89}]; revision = 7;
      root.render(<MiniGamePanel game="xiangqi" connected active gameStateClient={client as any} onInviteAI={() => {}} />);
      await until(()=>document.querySelector('[data-testid="xiangqi-game"]')?.getAttribute('data-state')==='invalid','re-entered game kept a stale valid board');
      assert(revision===7 && moves[0].to===89,'invalid original record was modified');
      assert(document.querySelectorAll('[data-testid="xiangqi-game"] [role="gridcell"]:disabled').length===90,'invalid game remained playable');
      assert(calls===0,'re-entry unexpectedly dispatched a model request'); return;
    }
    if (['inflight','reset','unmount','persona'].includes(kind)) await until(() => calls === 1, 'companion not dispatched');
    if (kind === 'unmount') {
      root.unmount(); mounted = false;
      complete?.({ok:true,move:'0,6,0,5'}); await pause(500);
      assert(moves.length === 1, 'unmounted game accepted a response');
      return;
    }
    if (kind === 'reset') {
      (document.querySelector('button[title="重新开始"]') as HTMLButtonElement).click();
      await until(() => moves.length === 0, 'reset not committed');
      complete?.({ok:true,move:'0,6,0,5'}); await pause(500);
      assert(moves.length === 0, 'late result overwrote reset');
      return;
    }
    if (kind === 'persona') {
      const switched = { ...client, personaScope: {...client.personaScope,persona_id:'other',persona_epoch:2},
        request: async (type: string) => { if(type==='game_state:get')return {ok:true,exists:true,state:[],revision:9}; throw Error('unexpected new persona mutation'); } };
      root.render(<MiniGamePanel game="xiangqi" connected gameStateClient={switched as any} onInviteAI={() => {}} />);
      await until(()=>document.querySelector('[data-testid="xiangqi-game"]')?.getAttribute('data-revision')==='9','new persona board');
      complete?.({ok:true,move:'0,6,0,5'});await pause(500);
      assert(moves.length===1,'old persona mutated after switch');
      assert(document.querySelector('[data-testid="xiangqi-game"]')?.getAttribute('data-moves')==='0','late response crossed persona');
      return;
    }
    (document.querySelector('button[data-mode="companion"]') as HTMLButtonElement).click();
    if (kind === 'reverse') {
      await until(()=>Boolean(document.querySelector('button[data-mode="practice"]')),'practice mode');
      (document.querySelector('button[data-mode="practice"]') as HTMLButtonElement).click();
      await until(()=>calls===1,'new companion mode did not dispatch');
      complete?.({ok:true,move:'0,6,0,5'});
    }
    await until(() => moves.length === 2, 'new mode did not continue black turn');
    complete?.({ ok: true, move: '0,6,0,5' });
    await pause(500);
    assert(moves.length === 2, 'late response played an extra move');
    assert(calls === (kind === 'before' ? 0 : 1), 'old mode was dispatched after switch');
  } finally { if(mounted)root.unmount(); complete?.({ ok: false }); await pause(30); }
}
(window as any).runComponentChecks = async () => {
  const cases = [];
  for (const kind of ['before','inflight','reverse','reset','unmount','persona','refresh-invalid'] as const) {
    const name = `xiangqi-react-${kind}`;
    try { await scenario(kind); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error) }); }
  }
  return { cases, passed: cases.every(value => value.passed) };
};
