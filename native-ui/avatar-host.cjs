'use strict';
// Headless reuse of the existing first-party asset transaction. No Electron UI.
const fs=require('node:fs'),path=require('node:path');
const {AvatarManager}=require('../frontend/electron/avatar-manager.cjs');
const {createRuntimeTextureTransformer}=require('../frontend/electron/live2d-import-transform.cjs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>{input+=v;if(Buffer.byteLength(input)>65536)process.exit(2);});
process.stdin.on('end',()=>{try{
 const c=JSON.parse(input);if(!path.isAbsolute(c.storageDir)||fs.realpathSync(path.dirname(c.storageDir))!==path.dirname(c.storageDir))throw Error('Unsafe model storage');
 const manager=new AvatarManager({storageDir:c.storageDir,live2dRuntime:{available:c.runtimeAvailable===true,coreAvailable:c.runtimeAvailable===true,rendererAvailable:c.runtimeAvailable===true,developmentOnly:true,licenseAccepted:false},live2dTextureTransformer:createRuntimeTextureTransformer({pythonPath:c.python,scriptPath:path.resolve(__dirname,'../frontend/script/downscale-live2d-textures.py')})});
 let result={};
 if(c.action==='scan'){const candidate=manager.beginImportDirectory(c.path);result={candidate,entryPath:path.join(manager.stagingDir,candidate.importId,'payload',decodeURIComponent(new URL(candidate.preview.url).pathname.split('/').slice(2).join('/')))};}
 else if(c.action==='preview'){result=manager.markPreviewReady(c.importId,{capabilities:{expressionPlayback:true,embeddedAnimationPlayback:true}});}
 else if(c.action==='commit'){const record=manager.commitImport({importId:c.importId,rightsConfirmed:c.rightsConfirmed===true,warningAccepted:c.warningAccepted===true});manager.setActive(record.id);}
 else if(c.action==='select')manager.setActive(c.id);
 else if(c.action==='remove')manager.remove(c.id);
 else if(c.action!=='list')throw Error('Unknown model action');
 if(!result.candidate){const list=manager.list();result.list=list;if(list.activeId){const record=list.records.find(r=>r.id===list.activeId);const u=new URL(record.entryUrl);const relative=u.pathname.split('/').slice(2).map(decodeURIComponent).join('/');const descriptor=manager.openAsset(list.activeId,relative);fs.closeSync(descriptor.fd);result.entryPath=path.join(manager.recordsDir,list.activeId,'payload',relative);}}
 process.stdout.write(JSON.stringify({ok:true,...result}));
 }catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e.message).slice(0,500)}));process.exitCode=1;}});
