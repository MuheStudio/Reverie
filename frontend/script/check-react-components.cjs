'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const isolation = require('./acceptance-isolation.cjs');
async function main() {
  const frontend = path.resolve(__dirname, '..');
  const { createServer } = await import('vite');
  const vite = await createServer({ root: frontend, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  const { runRoot } = isolation.createIsolationContext(fs.realpathSync(os.tmpdir()));
  const userData = isolation.createIsolatedDirectory(runRoot, 'data');
  const executable = require('electron');
  let running, poll;
  try {
    isolation.prepareNativeController(runRoot);
    await vite.listen();
    isolation.assertIsolation(runRoot, userData);
    const env = Object.fromEntries(['PATH','HOME','USER','LOGNAME','TMPDIR','LANG'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
    const child = spawn(executable, [path.join(__dirname, 'fixtures/component-electron.cjs')], { env: { ...env,
      REVERIE_COMPONENT_DATA: userData, REVERIE_COMPONENT_URL: `http://127.0.0.1:${vite.httpServer.address().port}/script/fixtures/react-check.html` }, stdio: ['pipe','pipe','pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    running = { child, runRoot, userData, identity: { executable }, owned: new Map() };
    child.on('error', error => { running.error = error; });
    await new Promise(resolve => setTimeout(resolve, 100));
    isolation.registerRoot(running);
    const snapshot = () => spawnSync('/bin/ps', ['-axo','pid='], {encoding:'utf8'}).stdout.trim().split(/\s+/).map(pid => ({pid:Number(pid)}));
    poll = setInterval(() => { if (child.exitCode == null && child.signalCode == null) isolation.collectProcesses(running, snapshot()); }, 300);
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    child.stdin.end('run\n');
    let timer;
    await Promise.race([closed, new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('component deadline')),35000);})]).finally(()=>clearTimeout(timer));
    clearInterval(poll);
    const line = output.split('\n').find(line => line.startsWith('COMPONENT_RESULT '));
    if (!line) throw Error(`No component result: ${errors.slice(-1000)}`);
    const sources = ['src/components/DreamRoom/MiniGamePanel.tsx','src/components/DreamRoom/useCompanionOpponent.ts','src/components/DreamRoom/xiangqiPrompt.ts','script/fixtures/react-check.tsx','script/fixtures/component-electron.cjs','script/check-react-components.cjs'].map(name => ({path:`frontend/${name}`,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(frontend,name))).digest('hex')}));
    const report = { ...JSON.parse(line.slice(17)), sourceHead: spawnSync('git',['rev-parse','HEAD'],{cwd:frontend,encoding:'utf8'}).stdout.trim(), sources, kind:'real-react-synthetic-process', residualProcesses:isolation.remainingProcesses(running).length };
    const directory = path.join(frontend, '..','.tools/reports/react-components');fs.mkdirSync(directory,{recursive:true});
    const outputPath = path.join(directory,`${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({report:outputPath,...report}));process.exitCode=report.passed&&report.residualProcesses===0?0:1;
  } finally {
    clearInterval(poll);
    if (running?.rootIdentity) for(const identity of isolation.remainingProcesses(running).reverse()) isolation.signalOwned(running, identity, 'SIGKILL');
    await vite.close(); isolation.removeIsolationContext(runRoot);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
