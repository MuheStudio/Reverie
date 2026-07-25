const fs = require('fs');
const path = require('path');
const { assertLive2DReleaseGate } = require('./electron/live2d-release-gate.cjs');

const frontendRoot = __dirname;
const projectRoot = path.resolve(frontendRoot, '..');
const reverieRoot = path.resolve(projectRoot, '..', '..');
const outputRoot = process.env.REVERIE_WINDOWS_OUT
  ? path.resolve(process.env.REVERIE_WINDOWS_OUT)
  : path.join(
      reverieRoot,
      '\u5c06Reverie\u6253\u5305\u81f3\u5404\u4e2a\u5e73\u53f0',
      '\u534a\u6210\u54c1',
      'Windows',
    );
const stagingResources = path.join(frontendRoot, '.installer-resources');
const live2dBuildEnabled = process.env.REVERIE_LIVE2D_PUBLIC_BUILD === '1';

const runtimeFilter = [
  '**/*',
  '!**/__pycache__/**',
  '!**/.pytest_cache/**',
  '!**/*.pyc',
  '!**/*.pyo',
];

const extraResources = [
  { from: path.join(projectRoot, 'src'), to: 'src', filter: runtimeFilter },
  { from: path.join(projectRoot, 'app'), to: 'app', filter: runtimeFilter },
  { from: path.join(projectRoot, 'config'), to: 'config', filter: runtimeFilter },
  { from: path.join(projectRoot, 'plugin'), to: 'plugin', filter: runtimeFilter },
  { from: path.join(projectRoot, 'utils'), to: 'utils', filter: runtimeFilter },
  { from: path.join(projectRoot, 'venv'), to: 'venv', filter: runtimeFilter },
  { from: path.join(stagingResources, 'data'), to: 'data' },
  { from: path.join(stagingResources, 'SOURCE_CODE'), to: 'SOURCE_CODE' },
  { from: path.join(stagingResources, 'THIRD_PARTY_LICENSES'), to: 'THIRD_PARTY_LICENSES' },
  { from: path.join(projectRoot, 'LICENSES_CREDITS'), to: 'LICENSES_CREDITS' },
];

if (live2dBuildEnabled) {
  for (const name of ['LIVE2D_PUBLICATION_LICENSE.json', 'LIVE2D_RUNTIME_ENABLED']) {
    const source = path.join(stagingResources, name);
    if (!fs.existsSync(source)) {
      throw new Error(`Live2D release gate output is missing: ${name}`);
    }
    extraResources.push({ from: source, to: name });
  }
} else {
  assertLive2DReleaseGate({
    buildEnabled: '0',
    scanRoots: [
      path.join(frontendRoot, '.installer-app'),
      path.join(frontendRoot, '.installer-resources'),
    ],
  });
}

for (const name of fs.readdirSync(projectRoot)) {
  if (name.endsWith('.py')) {
    extraResources.push({ from: path.join(projectRoot, name), to: name });
  }
}

for (const name of ['LICENSE', 'NOTICE', 'CREDITS.md', 'AGPL_EXCLUDED.md', 'requirements.txt']) {
  extraResources.push({ from: path.join(projectRoot, name), to: name });
}

module.exports = {
  appId: 'studio.muhe.reverie',
  productName: 'Reverie',
  copyright: 'Copyright (C) Muhe Studio contributors',
  asar: true,
  compression: 'maximum',
  npmRebuild: false,
  removePackageScripts: true,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    // Renderer/Electron entrypoints are integrity-checked in app.asar. GPL
    // corresponding source remains separately available in SOURCE_CODE.
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  directories: {
    app: path.join(frontendRoot, '.installer-app'),
    output: outputRoot,
    buildResources: path.join(frontendRoot, 'public'),
  },
  files: ['**/*'],
  extraResources,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: path.join(frontendRoot, 'public', 'icon.svg'),
    executableName: 'Reverie',
    requestedExecutionLevel: 'asInvoker',
    artifactName: 'Reverie-Setup-${version}-x64.${ext}',
    publish: null,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Reverie',
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    installerLanguages: ['zh_CN', 'en_US'],
    multiLanguageInstaller: true,
    license: path.join(projectRoot, 'LICENSE'),
  },
};
