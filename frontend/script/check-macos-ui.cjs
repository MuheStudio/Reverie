'use strict';
const fs=require('node:fs'),path=require('node:path');
const {readInputs}=require('./macos-ui-materials.cjs');
async function main(args) {
  if(args.includes('--help')){console.log('Usage: script/check-macos-ui.sh [--core ABS_FILE --model ABS_DIR --materials ABS_JSON]\nWithout materials: runs isolated default UI checks; real rendering is explicitly not-run.\nWith hash-bound, locally authorized materials: also checks the actual Live2D adapter. No download, license acceptance, or distribution.');return;}
  const inputs=readInputs(args);
  const directory=path.resolve(__dirname,'../../.tools/reports/ui-materials');fs.mkdirSync(directory,{recursive:true});
  const report=path.join(directory,`${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.writeFileSync(report,JSON.stringify({schema:'reverie.ui-materials-check.v1',phase:'preflight-only',status:inputs.status,missing:inputs.missing??[],evidence:inputs.evidence??null,realRenderingPerformed:false},null,2)+'\n',{flag:'wx'});
  console.log(`Materials: ${inputs.status}; ${report}`);
  const {main:run}=require('./e2e-desktop-core-smoke.cjs');
  await run({uiContract:true,live2d:inputs.status==='ready'?inputs:null,materialsReport:report});
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
