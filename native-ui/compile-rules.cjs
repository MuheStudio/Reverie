'use strict';
const fs=require('node:fs'),path=require('node:path');
const ts=require('../frontend/node_modules/typescript');
function compile(name, output) {
  const source = path.resolve(__dirname, name);
  const generated = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS, removeComments: false },
  }).outputText;
  fs.writeFileSync(output, `(function(){const exports={};\n${generated}\nreturn exports;})()`);
}
compile('../frontend/src/components/DreamRoom/xiangqiEngine.ts', process.argv[2]);
if (process.argv[3]) compile('../frontend/src/components/DreamRoom/gameEngines.ts', process.argv[3]);
if (process.argv[4]) compile('rules/chessRules.ts', process.argv[4]);
if (process.argv[5]) compile('rules/goRules.ts', process.argv[5]);
