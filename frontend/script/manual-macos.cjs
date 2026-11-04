'use strict';
// Human walkthrough support only. Starts an isolated test app + local mock;
// it never certifies the human's observations or exports chat/data/key content.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),readline=require('node:readline');
const smoke=require('./smoke-packaged-macos.cjs'),isolation=require('./acceptance-isolation.cjs');
async function main(args){
 if(args.includes('--help')){console.log('Usage: script/manual-macos.sh [--app ABS_TEST_APP --manifest ABS_BUILD_JSON] [--fresh-onboarding]\nRun in Terminal. Creates a new isolated profile and local mock. --fresh-onboarding retains the initial wizard for manual inspection. Quit the app with Command-Q; Enter restarts the same profile (up to three cycles), q ends. Human acceptance remains pending until explicitly recorded.');return;}
 if(!process.stdin.isTTY)throw Error('Run the manual walkthrough in an interactive Terminal');
 const inputs=smoke.resolvePackageInputs(args),identity=smoke.readBundleIdentity(inputs.appPath);
 smoke.verifySuccessfulBuild(identity,inputs.manifestPath,smoke.treeManifest(inputs.appPath));
 if(smoke.processSnapshot().some(p=>p.name===identity.executable))throw Error('An existing test application is running; it will not be touched');
 const parent=fs.realpathSync(os.tmpdir()),{runRoot}=isolation.createIsolationContext(parent);
 for(const name of ['tmp','cache','crashpad'])isolation.createIsolatedDirectory(runRoot,name);
 const userData=isolation.createIsolatedDirectory(runRoot,'human-data'),logs=isolation.createIsolatedDirectory(runRoot,'local-logs');
 const session=await smoke.createAcceptanceSession(runRoot,userData),active=[];
 const rl=readline.createInterface({input:process.stdin,output:process.stdout});
 const question=text=>new Promise(resolve=>rl.question(text,resolve));
 let running;
 const quit=async()=>{if(running&&running.child.exitCode===null&&running.child.signalCode===null)await smoke.normalPackagedQuit(running,logs);};
 const signal=()=>{void quit();};process.on('SIGINT',signal);
 try {
  if(args.includes('--fresh-onboarding')){
   isolation.assertIsolation(runRoot,userData);
   const configPath=path.join(userData,'data','config.json');
   if(fs.realpathSync(configPath)!==configPath||!fs.lstatSync(configPath).isFile()||fs.existsSync(path.join(userData,'data','runtime')))throw Error('Fresh isolated configuration required');
   const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
   config.ui={...config.ui,onboarding_completed:false,onboarding_version:0,onboarding_state:'not_started',onboarding_last_step:'welcome'};
   fs.writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
  }
  console.log(`隔离目录：${runRoot}\n只连接本机模拟模型，不访问默认数据。不要输入真实个人资料。`);
  for(let cycle=1;cycle<=3;cycle++){
   running=await smoke.launchApplication(identity,runRoot,userData,`human-${cycle}`,0,active,logs);
   console.log(`人工走查第 ${cycle} 轮。请自行操作后在应用内退出或按 Command-Q。`);
   const observer=setInterval(()=>{if(running.rootIdentity&&running.child.exitCode===null&&running.child.signalCode===null)isolation.collectProcesses(running,smoke.processSnapshot());},500);
   try { await new Promise((resolve,reject)=>{running.child.once('close',resolve);running.child.once('error',reject);}); } finally {clearInterval(observer);}
   if(cycle===3)break;
   if((await question('Enter 复用隔离目录重启，q 结束：')).trim().toLowerCase()==='q')break;
  }
 } finally {
  process.off('SIGINT',signal);await quit();rl.close();await smoke.closeAcceptanceSession(session);
  const residual=active.flatMap(r=>isolation.remainingProcesses(r));
  fs.writeFileSync(path.join(runRoot,'human-walkthrough-status.json'),JSON.stringify({schema:'reverie.manual-walkthrough-support.v1',humanAcceptance:'pending-user-confirmation',defaultUserDataUsed:false,localMockOnly:true,residualProcessCount:residual.length,profileRetained:true},null,2)+'\n',{flag:'wx'});
  if(residual.length)throw Error('Owned processes remain; isolated profile retained for diagnosis');
  isolation.disposeIsolationContext(runRoot);
  console.log(`人工结果未自动判定。隔离资料保留于 ${runRoot}，不要将原始日志、数据库或密钥作为共享证据。`);
 }
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
