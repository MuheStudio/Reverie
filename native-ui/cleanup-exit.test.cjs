'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const {once}=require('node:events');
const {cleanupExitedSuccessfully}=require('./cleanup-exit.cjs');
const evidence={cycle:'cleanup',processAbsent:true,spawnConfirmed:true,registrationError:{code:'ERR_ASSERTION',message:'Spawned process identity is absent or changed'}};
function child(code){return spawn(process.execPath,['-e',code],{stdio:['ignore','ignore','ignore','ipc']});}
test('cleanup completion requires the owned ChildProcess zero exit',async()=>{
  const p=child('process.exit(0)');await once(p,'exit');assert.equal(await cleanupExitedSuccessfully(p,evidence),true);
});
test('cleanup nonzero completion is never accepted',async()=>{
  const p=child('process.exit(3)');await once(p,'exit');assert.equal(await cleanupExitedSuccessfully(p,evidence),false);
});
test('live identity rejection cannot be turned into success by the wait',async()=>{
  const p=child('setInterval(()=>{},1000)');try{assert.equal(await cleanupExitedSuccessfully(p,evidence,10),false);assert.equal(p.exitCode,null);}finally{p.kill('SIGTERM');await once(p,'exit');}
});
test('exit racing inspection is observed without another PID lookup or action',async()=>{
  const p=child('process.on("message",()=>process.exit(0));process.send("ready")');await once(p,'message');const done=cleanupExitedSuccessfully(p,evidence,1000);p.send('finish');assert.equal(await done,true);assert.equal(p.listenerCount('exit'),0);
});
test('signal termination is not successful cleanup',async()=>{
  const p=child('process.send("ready");setInterval(()=>{},1000)');await once(p,'message');p.kill('SIGTERM');await once(p,'exit');assert.equal(await cleanupExitedSuccessfully(p,evidence),false);
});
for(const [name,change] of Object.entries({presentMismatch:{processAbsent:false},normalCycle:{cycle:1},notSpawned:{spawnConfirmed:false},spawnError:{spawnError:new Error('spawn failed')},isolationError:{registrationError:new Error('Directory replaced')}}))
  test('successful exit never hides '+name,async()=>{const p=child('process.exit(0)');await once(p,'exit');assert.equal(await cleanupExitedSuccessfully(p,{...evidence,...change}),false);});
