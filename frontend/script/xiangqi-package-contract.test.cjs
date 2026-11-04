'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),crypto=require('node:crypto');const {stateIdentity,assertRetirementGraph}=require('./xiangqi-package-contract.cjs');
test('stored move identities preserve zero and revision, refusing invalid ranges',()=>{
 const x=stateIdentity({ok:true,exists:true,revision:5,state:[{from:0,to:9}]});assert.equal(x.revision,5);assert.deepEqual(x.moves,[{from:0,to:9}]);
 assert.throws(()=>stateIdentity({ok:true,exists:true,revision:5,state:[{from:90,to:9}]}));assert.throws(()=>stateIdentity({ok:true,exists:true,revision:0,state:[]}));
});
test('renderer retirement binds the module list and independent sources',()=>{
 const modules=['xiangqiEngine.ts','xiangqiState.ts','MiniGamePanel.tsx'].map(n=>'src/components/DreamRoom/'+n);
 const make=values=>({schema:'reverie.renderer-module-retirement.v1',passed:true,modules:values,count:values.length,sha256:crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')});
 assertRetirementGraph(make(modules));assert.throws(()=>assertRetirementGraph(make([...modules,'node_modules/.pnpm/elephantops@0.1.1/node_modules/elephantops/dist/esm/xiangqi.js'])));
 assert.throws(()=>assertRetirementGraph({...make(modules),sha256:'0'.repeat(64)}));assert.throws(()=>assertRetirementGraph(make(modules.slice(1))));
});
