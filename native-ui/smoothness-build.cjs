'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const records = require('./build-record.cjs');
const original = require('../script/build-qt-macos.cjs');
const root = path.resolve(__dirname, '..');
const roles = Object.freeze({
  // Preserve all prior builds; this is the single bootstrap-failure retry.
  timing: {candidate: 'smoothness-20261115-timing-bootstrap-retry', timing: true, profiler: false, core: true},
  corefree: {candidate: 'smoothness-20261115-corefree-timing-bootstrap-retry', timing: true, profiler: false, core: false},
  profiler: {candidate: 'smoothness-20261115-profiler-bootstrap-retry', timing: false, profiler: true, core: true},
});
// Supplement uses a new directory without changing the phase-one role table.
const supplementRole = Object.freeze({candidate:'smoothness-20261115-timing-supplement',timing:true,profiler:false,core:true});
function supplementPlan(sdk) {
  assert(path.isAbsolute(sdk),'SMOOTHNESS_FIXED_SDK');
  return {...supplementRole,corePath:sdk,
    cmakeDirectory:path.join(root,'.tools/qt-builds',supplementRole.candidate),
    candidateDirectory:path.join(root,'.tools/qt-candidates',supplementRole.candidate)};
}
const environmentRole = Object.freeze({candidate:'smoothness-20261115-timing-environment',timing:true,profiler:false,core:true});
function environmentPlan(sdk) {
  assert(path.isAbsolute(sdk),'SMOOTHNESS_FIXED_SDK');
  return {...environmentRole,corePath:sdk,
    cmakeDirectory:path.join(root,'.tools/qt-builds',environmentRole.candidate),
    candidateDirectory:path.join(root,'.tools/qt-candidates',environmentRole.candidate)};
}
const phase2Role = Object.freeze({candidate:'smoothness-20261115-timing-phase2',timing:true,profiler:false,core:true});
function phase2Plan(sdk) {
  assert(path.isAbsolute(sdk),'SMOOTHNESS_FIXED_SDK');
  return {...phase2Role,corePath:sdk,
    cmakeDirectory:path.join(root,'.tools/qt-builds',phase2Role.candidate),
    candidateDirectory:path.join(root,'.tools/qt-candidates',phase2Role.candidate)};
}
function plan(role, sdk) {
  assert(Object.hasOwn(roles, role), 'SMOOTHNESS_BUILD_ROLE');
  const selected = roles[role];
  assert(!selected.core || path.isAbsolute(sdk), 'SMOOTHNESS_FIXED_SDK');
  return {...selected, corePath: selected.core ? sdk : '',
    cmakeDirectory: path.join(root, '.tools/qt-builds', selected.candidate),
    candidateDirectory: path.join(root, '.tools/qt-candidates', selected.candidate)};
}
function main(args) {
  assert(args.length === 2, 'usage: smoothness-build.cjs ROLE ABS_SDK');
  const selected = args[0]==='phase2' ? phase2Plan(args[1]) : args[0]==='environment' ? environmentPlan(args[1]) : args[0]==='supplement' ? supplementPlan(args[1]) : plan(...args);
  original.validateCMakeDirectory(selected.cmakeDirectory);
  assert(!fs.existsSync(selected.cmakeDirectory) && !fs.existsSync(selected.candidateDirectory),
    'SMOOTHNESS_FRESH_BUILD_REQUIRED');
  const toolchain = require('../config/qt-macos-toolchain.json');
  const run = (cmd, argv, extra = {}) => execFileSync(cmd, argv, {cwd: root, ...extra});
  const qt = path.join(root, '.tools/qt-sdk');
  assert.equal(run(path.join(qt, 'bin/qtpaths'), ['--qt-version'], {encoding:'utf8'}).trim(), toolchain.qtVersion);
  for (const archive of toolchain.sdkArchives)
    assert.equal(records.fileHash(path.join(root, '.tools/qt-downloads', archive.filename)), archive.sha256);
  const coreFile = selected.corePath && path.join(selected.corePath, 'Core/lib/macos/arm64/libLive2DCubismCore.a');
  if (coreFile) assert.equal(records.fileHash(coreFile), toolchain.localNativeSdk.arm64CoreSha256);
  const python = path.join(root, '.venv/bin/python');
  const pythonInfo = JSON.parse(run(python, ['-I','-B','-c',
    'import sys,platform,json;print(json.dumps(dict(version=platform.python_version(),architecture=platform.machine(),executable=sys.executable,prefix=sys.prefix,basePrefix=sys.base_prefix)))'], {encoding:'utf8'}));
  assert(pythonInfo.version === '3.12.14' && pythonInfo.architecture === 'arm64' && pythonInfo.prefix === path.join(root,'.venv'));
  const source = records.sourceInventory(root);
  const head = run('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim();
  const status = run('git', ['status','--porcelain'], {encoding:'utf8'}).trim().split('\n');
  assert.deepEqual(status, ['?? .c2cignore','?? outputs/']);
  const cmake = run('/usr/bin/which',['cmake'],{encoding:'utf8'}).trim();
  run(cmake, ['-S',path.join(root,'native-ui'),'-B',selected.cmakeDirectory,
    '-DCMAKE_PREFIX_PATH='+qt, '-DREVERIE_TRUST_CURRENT_HEAD='+head,
    '-DREVERIE_TRUST_CURRENT_INPUTS='+records.digest(records.runtimeInputs(source)).sha256,
    '-DREVERIE_TRUST_CURRENT_PYTHON='+records.fileHash(fs.realpathSync(python)),
    '-DREVERIE_LOCAL_CUBISM='+selected.corePath,
    '-DREVERIE_TIMING_DIAGNOSTICS='+(selected.timing?'ON':'OFF'),
    '-DREVERIE_QML_PROFILER='+(selected.profiler?'ON':'OFF'),
    '-DCMAKE_OSX_ARCHITECTURES=arm64','-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0','-DCMAKE_BUILD_TYPE=RelWithDebInfo'], {stdio:'inherit'});
  run(cmake,['--build',selected.cmakeDirectory,'--parallel','6'], {stdio:'inherit'});
  assert.deepEqual(records.digest(records.sourceInventory(root)),records.digest(source),'SMOOTHNESS_SOURCE_CHANGED_DURING_BUILD');
  fs.mkdirSync(selected.candidateDirectory);
  const app = path.join(selected.candidateDirectory,'Reverie Scene.app');
  run('/usr/bin/ditto',[path.join(selected.cmakeDirectory,'Reverie Scene.app'),app]);
  run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',app]);
  run('/usr/bin/codesign',['--verify','--strict',app]);
  const binary = path.join(app,'Contents/MacOS/Reverie Scene');
  const libraries = run('/usr/bin/otool',['-L',binary],{encoding:'utf8'});
  const externalFiles = libraries.split('\n').slice(1).map(line=>line.trim().split(' (')[0])
    .map(file=>file.startsWith('@rpath/') ? path.join(qt,'lib',file.slice(7)) : file)
    .filter(file=>file.startsWith(qt+'/')&&fs.existsSync(file));
  externalFiles.push(fs.realpathSync(python),process.execPath);
  if(coreFile) externalFiles.push(coreFile);
  const inventory=records.directoryInventory(app);
  const record={schema:'reverie.qt.local-build.v2',candidate:selected.candidate,
    previewWorkspaceContract:'v1', supportedDataFormat:1, workspaceControlContract:'v1',
    diagnostics:original.buildDiagnosticRecord({profiler:selected.profiler,timing:selected.timing}),
    compilation:{buildType:'RelWithDebInfo',cmakeDirectory:selected.cmakeDirectory,
      cleanCompilationPolicy:{mode:'fresh-diagnostic-check-build',cleanFirst:false,builderSha256:records.fileHash(__filename)},
      flagsSha256:records.fileHash(path.join(selected.cmakeDirectory,'CMakeFiles/ReverieScene.dir/flags.make')),
      flags:fs.readFileSync(path.join(selected.cmakeDirectory,'CMakeFiles/ReverieScene.dir/flags.make'),'utf8')},
    source:{head,dirty:false,inventory:records.digest(source),postBuildInventory:records.digest(source),
      postBuildInventoryVerified:true,runtimeInputs:records.digest(records.runtimeInputs(source))},
    application:{relativePath:'Reverie Scene.app',inventory:records.digest(inventory),
      executableSha256:records.fileHash(binary),architecture:run('/usr/bin/lipo',['-archs',binary],{encoding:'utf8'}).trim(),
      signature:'ad-hoc-local-test',strictSignatureVerified:true},
    qt:{version:toolchain.qtVersion,build:toolchain.qtBuild},python:pythonInfo,node:process.version,
    core:coreFile?toolchain.localNativeSdk:null,
    externalFiles:[...new Set(externalFiles)].map(file=>({path:file,sha256:records.fileHash(file)})),
    externalTrees:coreFile?[{path:path.join(selected.corePath,'Framework'),inventory:records.digest(records.directoryInventory(path.join(selected.corePath,'Framework')))}]:[],
    dynamicLibraries:libraries.split('\n').slice(1).filter(Boolean),
    diagnosticOnly:true, pointerPublication:false, scope:'W20 diagnostic preparation, fresh directory and named candidate'};
  for(const [name,value] of [['build.json',record],['source-inventory.json',source],['application-inventory.json',inventory]])
    fs.writeFileSync(path.join(selected.candidateDirectory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  records.verifyBuild(root,selected.candidateDirectory);
  console.log(JSON.stringify({build:selected.candidateDirectory,sha256:records.fileHash(path.join(selected.candidateDirectory,'build.json'))}));
}
if(require.main===module) main(process.argv.slice(2));
module.exports={plan,roles,supplementRole,supplementPlan,environmentRole,environmentPlan,phase2Role,phase2Plan};
