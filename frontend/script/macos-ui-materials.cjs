'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function regular(file,max) {
  if(!path.isAbsolute(file))throw Error('Material paths must be absolute');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||!stat.size||stat.size>max||fs.realpathSync(file)!==path.resolve(file))throw Error('Material must be a bounded, unaliased regular file');
  return fs.readFileSync(file);
}
function modelInventory(root) {
  if(!path.isAbsolute(root)||fs.realpathSync(root)!==path.resolve(root))throw Error('Model directory must be absolute and unaliased');
  const entries=[];let bytes=0;
  function walk(directory) {
    const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Model directory cannot be a link');
    for(const name of fs.readdirSync(directory).sort()) {
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink())throw Error('Model links are not accepted');
      if(stat.isDirectory())walk(file);
      else {if(!stat.isFile())throw Error('Unsupported model member');bytes+=stat.size;if(bytes>512*1024*1024||entries.length>=4096)throw Error('Model exceeds local validation limits');entries.push({path:path.relative(root,file).split(path.sep).join('/'),bytes:stat.size,sha256:sha(fs.readFileSync(file))});}
    }
  }
  walk(root);if(entries.filter(e=>e.path.endsWith('.model3.json')).length!==1)throw Error('Exactly one model3.json is required');
  return {entries,bytes,sha256:sha(Buffer.from(JSON.stringify(entries)))};
}
function readInputs(args) {
  const values={};
  for(let i=0;i<args.length;i+=2){const flag=args[i];if(!['--core','--model','--materials'].includes(flag)||!args[i+1]||values[flag])throw Error('Usage: --core ABS_FILE --model ABS_DIR --materials ABS_JSON');values[flag]=args[i+1];}
  if(!args.length)return {status:'not-run',missing:['Fixed official Core with accepted applicable terms','Authorized real Live2D model','Hash-bound local-use materials declaration']};
  for(const flag of ['--core','--model','--materials'])if(!values[flag])throw Error(`Missing ${flag}`);
  const declaration=JSON.parse(regular(values['--materials'],64*1024));
  if(!['reverie.live2d.local-validation-materials.v1','reverie.live2d.local-validation-materials.v2'].includes(declaration.schema)||declaration.purpose!=='local-development-only')throw Error('Wrong local material declaration');
  const suppliedForTest=declaration.schema==='reverie.live2d.local-validation-materials.v2'
    && declaration.model?.permissionBasis?.kind==='direct-user-request'
    && typeof declaration.model.permissionBasis.statement==='string'
    && declaration.model.permissionBasis.statement.trim().length>0;
  if(declaration.core?.termsAccepted!==true||!declaration.core.version||declaration.model?.localTestingPermitted!==true||(!declaration.model.rightsHolder&&!suppliedForTest))throw Error('Applicable terms/local model permission are not confirmed');
  const source=new URL(declaration.core.sourceUrl);
  if(source.protocol!=='https:'||!(source.hostname==='live2d.com'||source.hostname.endsWith('.live2d.com')))throw Error('Core source must identify an official Live2D URL');
  const core=regular(values['--core'],16*1024*1024);if(!core.includes(Buffer.from('Live2DCubismCore')))throw Error('Core runtime symbol missing');
  const model=modelInventory(values['--model']);
  if(sha(core)!==declaration.core.sha256||model.sha256!==declaration.model.treeSha256)throw Error('Material hashes do not match the declared inputs');
  return {status:'ready',corePath:values['--core'],modelPath:values['--model'],declaration,
    evidence:{core:{version:declaration.core.version,sourceUrl:source.href,sha256:sha(core),termsAccepted:true},model:{treeSha256:model.sha256,files:model.entries.length,bytes:model.bytes,localTestingPermitted:true,rightsHolder:declaration.model.rightsHolder||null,permissionBasis:declaration.model.permissionBasis||null},distributionAuthorized:false}};
}
module.exports={readInputs,modelInventory};
