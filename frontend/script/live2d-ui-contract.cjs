'use strict';
const assert=require('node:assert/strict');
const {evaluate,waitFor,navigate,screenshot}=require('./ui-workspace-contract.cjs');
async function observe(cdp) {
  await evaluate(cdp, `(async()=>{
    const {Live2DRenderer}=await import('/src/components/AvatarView/Live2DAdapter.tsx');
    const p=Live2DRenderer.prototype;
    window.__live2dCheck={instances:[],loads:0,destroys:0,modelReleases:0,successfulLoads:[],loadErrors:[],earlyLoads:0,initializationDelayMs:250};
    const init=p.init,load=p.loadModel,destroy=p.destroy,release=p.destroyModel;
    // Delay only the real init call to deterministically exercise visibility
    // arriving before WebGL exists. No renderer or capability is substituted.
    p.init=async function(...a){window.__live2dCheck.instances.push(this);await new Promise(r=>setTimeout(r,250));if(this.destroyed)throw Error('Observed initialization was cancelled');return init.apply(this,a);};
    p.loadModel=async function(...a){window.__live2dCheck.loads++;if(!this.app)window.__live2dCheck.earlyLoads++;try{const ok=await load.apply(this,a);if(ok)window.__live2dCheck.successfulLoads.push(a[0].url);return ok;}catch(e){window.__live2dCheck.loadErrors.push(String(e.stack||e));throw e;}};
    p.destroyModel=function(...a){if(this.model)window.__live2dCheck.modelReleases++;return release.apply(this,a);};
    p.destroy=function(...a){window.__live2dCheck.destroys++;return destroy.apply(this,a);};
    return true;
  })()`);
}
async function importModel(running, inputs) {
  await navigate(running.cdp,'character');
  await evaluate(running.cdp, `(() => {const b=document.querySelector('[data-testid="model-import-open"]');if(b?.textContent.startsWith('导入'))b.click();return true;})()`);
  await waitFor(running.cdp, `Boolean(Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='选择文件夹'&&!b.disabled))`, 'Live2D importer ready');
  // Only the native picker result is controlled. The real preload, scanner,
  // candidate renderer, confirmation and commit remain in the product path.
  const previous=await evaluate(running.cdp,'window.electronAPI.avatar.list().then(s=>s.records.map(r=>r.id))');
  await evaluate(running.mainCdp, `(() => {const d=process.mainModule.require('electron').dialog;global.__uiOriginalPicker=d.showOpenDialog;d.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(inputs.modelPath)}]});return true;})()`);
  try {
    await evaluate(running.cdp, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='选择文件夹').click();true`);
    // Keep the controlled picker installed until IPC has returned a scanned
    // candidate; restoring it immediately after click races the actual IPC.
    await waitFor(running.cdp, `(() => {const root=document.querySelector('[data-testid="model-manager"]');if(/扫描失败|文件扫描失败|未能成功渲染|预览超时/.test(root.innerText))throw Error(root.innerText);return Boolean(root.querySelector('[aria-label$="Live2D 候选预览"] canvas'));})()`, 'real model preview canvas (bounded scanner wait)', 30000);
  }
  finally { await evaluate(running.mainCdp, `process.mainModule.require('electron').dialog.showOpenDialog=global.__uiOriginalPicker;delete global.__uiOriginalPicker;true`); }
  await evaluate(running.cdp, `(() => {for(const label of document.querySelectorAll('label'))if(label.textContent.includes('本地使用权')||label.textContent.includes('接受上述扫描警告')){const e=label.querySelector('input[type=checkbox]');if(e&&!e.checked)e.click();}return true;})()`);
  await waitFor(running.cdp, `Boolean(Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('安装并设为当前形象')&&!b.disabled))`, 'validated model preview before install');
  await evaluate(running.cdp, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('安装并设为当前形象')&&!b.disabled).click();true`);
  const installed=await waitFor(running.cdp, `(async()=>{const s=await window.electronAPI.avatar.list();const r=s.records.find(r=>r.id===s.activeId);return r&&!${JSON.stringify(previous)}.includes(r.id)?{activeId:s.activeId,record:r}:false;})()`, 'new model committed and selected');
  await navigate(running.cdp,'chat');
  await waitFor(running.cdp, `document.querySelector('[data-character]')?.dataset.avatarStatus==='ready'`, 'actual selected Live2D rendered');
  await waitFor(running.cdp, `window.__live2dCheck.instances.some(r=>r.model&&!r.destroyed&&r.desiredModel?.url===${JSON.stringify(installed.record.entryUrl)})`, 'selected model adapter identity');
  return installed;
}
async function runLive2dContract(running, inputs, directory) {
  const started=Date.now();const stages=[];
  const mark=name=>{stages.push({name,elapsedMs:Date.now()-started});process.stdout.write(`[live2d-ui] ${name}\n`);};
  await observe(running.cdp);
  mark('Import through model page');
  const first=await importModel(running,inputs);
  mark('Original model installed and rendered');
  assert.ok(first.activeId);
  assert.deepEqual(first.record.detected,first.record.stats.detected,'Preview confirmation lost scanned capabilities');
  assert.equal(await evaluate(running.cdp,'window.__live2dCheck.earlyLoads'),0,'Visibility dispatched a load before renderer init');
  const before=await evaluate(running.cdp,'({loads:window.__live2dCheck.loads,destroys:window.__live2dCheck.destroys,modelReleases:window.__live2dCheck.modelReleases})');
  await navigate(running.cdp,'settings');await navigate(running.cdp,'memory');await navigate(running.cdp,'chat');
  await waitFor(running.cdp, `document.querySelector('[data-character]')?.dataset.avatarStatus==='ready'`, 'same model after page return');
  assert.deepEqual(await evaluate(running.cdp,'({loads:window.__live2dCheck.loads,destroys:window.__live2dCheck.destroys,modelReleases:window.__live2dCheck.modelReleases})'),before);
  mark('Navigation retained model instance');
  const capabilities=await evaluate(running.cdp, `(async()=>{
    const r=[...window.__live2dCheck.instances].reverse().find(r=>r.model&&!r.destroyed&&r.desiredModel?.url===${JSON.stringify(first.record.entryUrl)});
    if(!r)throw Error('No real adapter instance');
    const core=r.model.internalModel.coreModel;
    const ids=Array.from(core._model?.parameters?.ids||[]);
    const pixels=r.app.renderer.extract.pixels(r.app.stage);
    let nonTransparentPixels=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)nonTransparentPixels++;
    const mouth=ids.includes('ParamMouthOpenY');
    if(mouth)r.setMouthOpen(.7);
    const model=await window.electronAPI.avatar.list();const active=model.records.find(v=>v.id===model.activeId);
    const motion=active?.detected?.animationClips?.[0],expression=active?.detected?.expressions?.[0];
    if(motion)r.playMotion(motion);if(expression)r.setExpression(expression);
    await new Promise(resolve=>setTimeout(resolve,250));
    const mouthValue=mouth?core.getParameterValueById('ParamMouthOpenY'):null;
    r.setMouthOpen(0);r.setExpression('');
    return {parameterCount:ids.length,nonTransparentPixels,coreVersion:window.Live2DCubismCore.Version.csmGetVersion(),mouth:mouth?{invoked:true,value:mouthValue}: {status:'not-supported-by-model'},motion:motion||null,expression:expression||null};
  })()`);
  assert.ok(capabilities.parameterCount>0,'Real model parameters absent');
  assert.ok(capabilities.nonTransparentPixels>1000,'Actual GPU frame did not contain a visible model');
  await screenshot(running.cdp,directory,'live2d-real');
  mark('GPU frame and supported capabilities verified');
  const second=await importModel(running,inputs);
  assert.notEqual(second.activeId,first.activeId,'Second import must provide a distinct model identity');
  await evaluate(running.cdp, `window.electronAPI.avatar.setActive(${JSON.stringify(first.activeId)})`);
  await waitFor(running.cdp, `document.querySelector('[data-character]')?.dataset.avatarStatus==='ready'`, 'model switch rendered');
  await waitFor(running.cdp, `window.__live2dCheck.instances.some(r=>r.model&&!r.destroyed&&r.desiredModel?.url===${JSON.stringify(first.record.entryUrl)})`, 'switched model adapter identity');
  const cleanup=await evaluate(running.cdp,'({loads:window.__live2dCheck.loads,destroys:window.__live2dCheck.destroys,modelReleases:window.__live2dCheck.modelReleases})');
  assert.ok(cleanup.loads>before.loads&&cleanup.modelReleases>before.modelReleases,'Old model release not observed');
  mark('Model replacement released prior model');
  return {status:'passed',scope:'Isolated source build through real adapter; controlled native picker; one authorized model imported as two identities',evidence:inputs.evidence,activeId:first.activeId,record:{stats:first.record.stats,detected:first.record.detected,capabilities:first.record.capabilities,warnings:first.record.warnings},capabilities,pageReloads:0,initializationRace:{delayMs:250,earlyLoads:0},cleanup,navigation:before,stages,restart:'pending'};
}
async function verifyLive2dRestart(running, report, directory) {
  await waitFor(running.cdp, `document.querySelector('[data-character]')?.dataset.avatarStatus==='ready'`, 'real Live2D restored after restart');
  const state=await evaluate(running.cdp,`(async()=>{const s=await window.electronAPI.avatar.list();const record=s.records.find(r=>r.id===s.activeId);return {activeId:s.activeId,detected:record.detected,coreVersion:window.Live2DCubismCore.Version.csmGetVersion(),runtime:window.__reverieLive2D?.()};})()`);
  assert.equal(state.activeId,report.activeId);assert.deepEqual(state.detected,report.record.detected);assert.equal(state.coreVersion,report.capabilities.coreVersion);assert.ok(state.runtime?.hasModel&&state.runtime?.canvasConnected);
  if(directory)await screenshot(running.cdp,directory,'live2d-restored');
  report.restart='passed';report.restored=state;
}
module.exports={runLive2dContract,verifyLive2dRestart};
