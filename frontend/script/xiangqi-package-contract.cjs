'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
function stateIdentity(record) {
  assert.equal(record.ok,true);assert.equal(record.exists,true);assert(Number.isSafeInteger(record.revision)&&record.revision>=1);
  assert(Array.isArray(record.state)&&record.state.length<=1000);
  for(const m of record.state)assert(Number.isInteger(m.from)&&Number.isInteger(m.to)&&m.from>=0&&m.from<90&&m.to>=0&&m.to<90);
  return {revision:record.revision,moves:record.state,stateSha256:crypto.createHash('sha256').update(JSON.stringify(record.state)).digest('hex'),digestKind:'ordered-move-array-json-sha256'};
}
function assertRetirementGraph(graph) {
  assert.equal(graph.schema,'reverie.renderer-module-retirement.v1');assert.equal(graph.passed,true);assert.equal(graph.count,graph.modules.length);
  assert.equal(graph.sha256,crypto.createHash('sha256').update(JSON.stringify(graph.modules)).digest('hex'));
  assert(!graph.modules.some(s=>/(?:^|\/)elephantops(?:@|\/|$)/.test(s)));
  for(const n of ['xiangqiEngine.ts','xiangqiState.ts','MiniGamePanel.tsx'])assert(graph.modules.includes(`src/components/DreamRoom/${n}`));
}
module.exports={stateIdentity,assertRetirementGraph};
