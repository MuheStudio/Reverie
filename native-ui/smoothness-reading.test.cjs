'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
test('diagnostic adjacency classifier handles continuity, stale y, tolerance, unknown neighbors and bounds',()=>{
  const binary=path.join(require('./smoothness-build.cjs').phase2Plan('/unused-for-plan').cmakeDirectory,'SmoothnessReadingRepro');
  const result=JSON.parse(execFileSync(binary,['--unit'],{encoding:'utf8',env:{...process.env,QT_QPA_PLATFORM:'offscreen'}}));
  assert.deepEqual(result,{passed:true,cases:8});
});
test('reading reproduction is excluded from ordinary CTest and only observes delegate geometry',()=>{
  const cmake=fs.readFileSync(path.join(__dirname,'CMakeLists.txt'),'utf8');
  assert(!/add_test\([^\n]*SmoothnessReading/.test(cmake));
  const source=fs.readFileSync(path.join(__dirname,'tests/SmoothnessReading.h'),'utf8');
  assert(!source.includes('setProperty('));assert(!source.includes('invokeMethod('));
  assert(source.includes('QThread::currentThread()!=QCoreApplication::instance()->thread()'));
});
