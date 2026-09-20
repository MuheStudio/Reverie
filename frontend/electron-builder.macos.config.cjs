'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const frontendRoot = __dirname;
const projectRoot = path.resolve(frontendRoot, '..');
const buildRoot = path.join(os.homedir(), 'Library', 'Developer', 'Reverie', 'LocalBuilds',
  crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 12));
const buildOutput = process.env.REVERIE_MACOS_BUILD_OUTPUT || path.join(buildRoot, 'builder-output');
const resources = path.join(buildRoot, '.macos-installer-resources');
const runtime = JSON.parse(fs.readFileSync(path.join(resources, 'MACOS-SIGNING-INPUTS.json'), 'utf8'));

module.exports = {
  appId: 'com.muhe.reverie.macos.test',
  productName: 'Reverie macOS Test',
  asar: true,
  compression: 'normal',
  npmRebuild: false,
  removePackageScripts: true,
  publish: null,
  electronVersion: require('./node_modules/electron/package.json').version,
  electronDist: path.dirname(require('electron')) + '/../../..',
  directories: {
    app: path.join(buildRoot, '.macos-installer-app'),
    output: buildOutput,
    buildResources: path.join(frontendRoot, 'public'),
  },
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!node_modules/**/*'],
  afterPack: async (context) => {
    // Finder/File Provider can annotate the newly generated bundle in Documents.
    // Remove only the two metadata attributes codesign rejects, never quarantine
    // or other security metadata, and never touch the source Electron install.
    const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const expected = path.join(buildOutput, 'mac-arm64', 'Reverie macOS Test.app');
    if (path.resolve(bundle) !== expected || fs.lstatSync(bundle).isSymbolicLink()) throw new Error('Unexpected metadata-cleanup target');
    const script = [
      'import ctypes,json,os,sys',
      'lib=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)',
      'lib.listxattr.argtypes=[ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int]; lib.listxattr.restype=ctypes.c_ssize_t',
      'lib.removexattr.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int]; lib.removexattr.restype=ctypes.c_int',
      'root=sys.argv[1]; removed=[]',
      'for directory,dirs,files in os.walk(root,followlinks=False):',
      ' for target in [directory]+[os.path.join(directory,n) for n in files]:',
      '  if os.path.islink(target): continue',
      '  encoded=os.fsencode(target); size=lib.listxattr(encoded,None,0,1)',
      '  if size<0: raise OSError(ctypes.get_errno(),"listxattr failed",target)',
      '  if not size: continue',
      '  buffer=ctypes.create_string_buffer(size); count=lib.listxattr(encoded,buffer,size,1)',
      '  if count<0: raise OSError(ctypes.get_errno(),"listxattr failed",target)',
      '  for name in buffer.raw[:count].split(b"\\0"):',
      '   if name in (b"com.apple.FinderInfo",b"com.apple.ResourceFork"):',
      '    if lib.removexattr(encoded,name,1)!=0: raise OSError(ctypes.get_errno(),"removexattr failed",target)',
      '    removed.append({"path":os.path.relpath(target,root),"attribute":name.decode()})',
      'print(json.dumps(removed))',
    ].join('\n');
    const removed = JSON.parse(execFileSync(path.join(bundle, 'Contents', 'Resources', 'python', 'bin', 'python3.12'),
      ['-I', '-B', '-c', script, bundle], { encoding: 'utf8' }));
    fs.writeFileSync(path.join(frontendRoot, 'release-macos', 'signing-metadata-cleanup.json'), `${JSON.stringify(removed, null, 2)}\n`);
  },
  extraResources: [
    { from: resources, to: '.', filter: ['**/*', '!MACOS-SIGNING-INPUTS.json'] },
    { from: path.join(projectRoot, 'LICENSES_CREDITS'), to: 'LICENSES_CREDITS' },
  ],
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    identity: '-',
    // The builder's standard macOS entitlements are used unchanged. This is
    // explicitly an ad-hoc local test identity, never a distribution claim.
    hardenedRuntime: true,
    preAutoEntitlements: false,
    strictVerify: true,
    gatekeeperAssess: false,
    notarize: false,
    minimumSystemVersion: '14.0',
    category: 'public.app-category.entertainment',
    binaries: runtime.binaries,
    extendInfo: {
      CFBundleDisplayName: 'Reverie macOS Test',
      NSHighResolutionCapable: true,
      ReverieBuildChannel: 'local-core-test',
    },
  },
};
