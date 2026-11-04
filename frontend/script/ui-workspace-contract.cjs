'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
async function evaluate(cdp, expression) {
  const value = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
async function waitFor(cdp, expression, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await evaluate(cdp, expression); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw Error(`UI: ${label}`);
}
async function navigate(cdp, section) {
  await evaluate(cdp, `(() => {const b=document.querySelector('[data-nav="${section}"]');const r=b.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!r.width||!b.contains(hit))throw Error('Navigation is obscured');b.click();return true;})()`);
  await waitFor(cdp, `document.querySelector('[data-testid="workspace"]')?.dataset.section === ${JSON.stringify(section)}`, `navigation ${section}`);
}
async function screenshot(cdp, directory, name) {
  const { data } = await cdp.call('Page.captureScreenshot', { format:'png' });
  fs.mkdirSync(directory,{recursive:true});
  const target=path.join(directory,`${name}.png`); fs.writeFileSync(target,Buffer.from(data,'base64'),{flag:'wx'}); return target;
}
async function prepareUiChecks(cdp, directory, {expectUnavailable=true} = {}) {
  const cases=[];
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="workspace"][data-section="chat"]'))`, 'default chat workspace');
  assert.equal(await evaluate(cdp, 'document.querySelectorAll("[data-nav]").length'),5);
  await evaluate(cdp, `window.__uiStage = document.querySelector('[data-stage]');
    window.__uiComposer = document.querySelector('textarea[placeholder^="给 "]');
    window.__uiFrameCounts = {auth:0,history:0};
    window.__uiDispose = window.electronAPI.bridge.onMessage(f => { if(f.type==='bridge:auth_ok')window.__uiFrameCounts.auth++;if(f.type==='chat:history:result')window.__uiFrameCounts.history++; });
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(window.__uiComposer,'页面往返的合成草稿');
    window.__uiComposer.dispatchEvent(new Event('input',{bubbles:true})); true`);
  await navigate(cdp,'settings');
  await waitFor(cdp, `Boolean(document.querySelector('input[placeholder="必须明确填写，不偷偷选择默认模型"]'))`, 'provider settings');
  const originalModel = await evaluate(cdp, `document.querySelector('input[placeholder="必须明确填写，不偷偷选择默认模型"]').value`);
  await evaluate(cdp, `(() => {const e=document.querySelector('input[placeholder="必须明确填写，不偷偷选择默认模型"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'unsaved-ui-fixture');e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await screenshot(cdp,directory,'settings');
  await navigate(cdp,'character');
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="${expectUnavailable ? 'model-unavailable' : 'model-manager'}"]'))`, 'explicit model runtime state');
  await screenshot(cdp,directory,'character');
  await navigate(cdp,'memory');
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="feature-pages"]'))`, 'memory feature entry');
  await navigate(cdp,'activities');
  assert.ok(await evaluate(cdp, `Array.from(document.querySelectorAll('[aria-label="小游戏"] button')).some(e=>e.textContent==='中国象棋')`));
  await navigate(cdp,'settings');
  assert.equal(await evaluate(cdp, `document.querySelector('input[placeholder="必须明确填写，不偷偷选择默认模型"]').value`),'unsaved-ui-fixture');
  await evaluate(cdp, `(() => {const e=document.querySelector('input[placeholder="必须明确填写，不偷偷选择默认模型"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(originalModel)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  cases.push({name:'settings-draft-survives-page-switch',passed:true});
  await navigate(cdp,'chat');
  assert.deepEqual(await evaluate(cdp, `({sameComposer:window.__uiComposer===document.querySelector('textarea[placeholder^="给 "]'),sameStage:window.__uiStage===document.querySelector('[data-stage]'),draft:window.__uiComposer.value})`),
    {sameComposer:true,sameStage:true,draft:'页面往返的合成草稿'});
  cases.push({name:'five-pages-preserve-composer-stage-and-draft',passed:true});
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:1180,height:820,deviceScaleFactor:1,mobile:false});
  await screenshot(cdp,directory,'home-wide');
  await cdp.call('Emulation.setDeviceMetricsOverride',{width:760,height:780,deviceScaleFactor:1,mobile:false});
  await waitFor(cdp, 'document.documentElement.scrollWidth <= innerWidth + 1', 'narrow layout has no horizontal overflow');
  await screenshot(cdp,directory,'home-narrow');
  assert.ok(await evaluate(cdp, `(() => {const r=window.__uiComposer.getBoundingClientRect();return r.height>30&&r.width>50&&r.bottom<=innerHeight+1&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===window.__uiComposer;})()`), 'composer clipped or obscured in narrow layout');
  await cdp.call('Emulation.clearDeviceMetricsOverride',{});
  const counts=await evaluate(cdp,'window.__uiFrameCounts');
  assert.equal(counts.auth,0,'page navigation reauthenticated');
  cases.push({name:'ordinary-navigation-does-not-reauthenticate',passed:true,observedFrameCounts:counts});
  cases.push({name:expectUnavailable?'default-core-unavailable-state-and-responsive-layout':'configured-model-entry-and-responsive-layout',passed:true});
  await evaluate(cdp,'window.__uiDispose(); delete window.__uiDispose; true');
  await evaluate(cdp, `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(window.__uiComposer,'');window.__uiComposer.dispatchEvent(new Event('input',{bubbles:true}));true`);
  await waitFor(cdp,'window.__uiComposer.value === ""','reset synthetic draft before chat');
  return {passed:true,cases,scope:'Actual React navigation and controls; no real Live2D runtime'};
}
async function saveProviderThroughUi(cdp, config) {
  await navigate(cdp,'settings');
  await evaluate(cdp, `(() => {
    const root=document.querySelector('[data-testid="mvp-room"]');
    const inputs=[['https://…',${JSON.stringify(config.baseUrl)}],['必须明确填写，不偷偷选择默认模型',${JSON.stringify(config.model)}]];
    for(const [placeholder,value] of inputs){const e=Array.from(root.querySelectorAll('input')).find(e=>e.placeholder===placeholder);if(!e)throw Error('Provider input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));}
    return true;
  })()`);
  await waitFor(cdp, `Boolean(Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='测试连接'&&!b.disabled))`, 'provider test control');
  await evaluate(cdp, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='测试连接'&&!b.disabled).click();true`);
  await waitFor(cdp, `Boolean(Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='测试通过后保存'&&!b.disabled))`, 'tested provider receipt');
  await evaluate(cdp, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='测试通过后保存'&&!b.disabled).click();true`);
  await waitFor(cdp, `document.body.innerText.includes('已保存并应用到本地服务') || document.body.innerText.includes('配置已安全保存')`, 'provider persisted acknowledgment');
  const current=await evaluate(cdp,'window.electronAPI.providerConfig.get().then(c=>c.llm)');
  assert.equal(current.model,config.model);assert.equal(current.baseUrl,config.baseUrl);
  await navigate(cdp,'chat');
  return {name:'provider-test-and-save-through-real-controls',passed:true};
}
async function enterFullMode(cdp) {
  if(await evaluate(cdp, `Boolean(document.querySelector('[data-testid="dream-room"]'))`))return;
  await navigate(cdp,'settings');
  await evaluate(cdp, `(() => {const s=Array.from(document.querySelectorAll('select')).find(s=>Array.from(s.options).some(o=>o.value==='dream'));Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'dream');s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await evaluate(cdp, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='保存界面模式').click();true`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="dream-room"][data-connection="connected"]'))`, 'full mode through saved UI');
}
async function returnCoreMode(cdp) {
  if(await evaluate(cdp, `Boolean(document.querySelector('[data-testid="mvp-room"]'))`)){await navigate(cdp,'chat');return;}
  await navigate(cdp,'settings');
  await waitFor(cdp, `Boolean(Array.from(document.querySelectorAll('[data-panel="settings"] button')).find(b=>b.textContent.trim()==='返回主界面'&&!b.disabled))`, 'return to core control');
  await evaluate(cdp, `Array.from(document.querySelectorAll('[data-panel="settings"] button')).find(b=>b.textContent.trim()==='返回主界面').click();true`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-testid="mvp-room"]'))`, 'core mode restored');
}
async function verifyFullWorkspace(cdp) {
  await enterFullMode(cdp);
  for(const section of ['settings','character','memory','activities','chat'])await navigate(cdp,section);
  await returnCoreMode(cdp);
  return {name:'full-experience-navigation-and-core-return',passed:true};
}
async function navigateDuringReply(cdp) {
  await navigate(cdp,'character'); await navigate(cdp,'settings'); await navigate(cdp,'chat');
  assert.ok(await evaluate(cdp, `window.__uiComposer===document.querySelector('textarea[placeholder^="给 "]') && window.__uiStage===document.querySelector('[data-stage]')`));
  return {name:'page-switch-during-reply-preserves-session-views',passed:true};
}
module.exports={prepareUiChecks,navigateDuringReply,saveProviderThroughUi,verifyFullWorkspace,enterFullMode,returnCoreMode,navigate,evaluate,waitFor,screenshot};
