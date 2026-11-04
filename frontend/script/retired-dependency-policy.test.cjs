'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {assertNoRetiredPackages}=require('./retired-dependency-policy.cjs');
test('retired dependency is rejected even when it is only transitive',()=>{
 assert.throws(()=>assertNoRetiredPackages([{name:'react'},{name:'elephantops',version:'0.1.1'}]),/production dependency graph/);
 assertNoRetiredPackages([{name:'react',version:'18.3.1'}]);
});
