'use strict';
const fs=require('node:fs'),path=require('node:path');
const ts=require('../frontend/node_modules/typescript');
const source=path.resolve(__dirname,'../frontend/src/components/DreamRoom/xiangqiEngine.ts');
const generated=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.CommonJS,removeComments:false}}).outputText;
fs.writeFileSync(process.argv[2],`(function(){const exports={};\n${generated}\nreturn exports;})()`);
