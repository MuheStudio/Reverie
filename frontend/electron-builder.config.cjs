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
      '将Reverie打包至各个平台',
      '半成品',
      'Windows',
    );
const stagingResources = path.join(frontendRoot, '.installer-resources');
const live2dBuildEnabled = process.env.REVERIE_LIVE2D_PUBLIC_BUILD === '1';
const onboardingTestInstaller = process.env.REVERIE_ONBOARDING_TEST_INSTALLER === '1';
const productName = onboardingTestInstaller
  ? 'Reverie Onboarding Test 20260905'
  : 'Reverie';
const appId = onboardingTestInstaller
  ? 'studio.muhe.reverie.onboarding-test-20260905'
  : 'studio.muhe.reverie';

const extraResources = [
  { from: path.join(stagingResources, 'src'), to: 'src' },
  { from: path.join(stagingResources, 'python'), to: 'python' },
  { from: path.join(stagingResources, 'data'), to: 'data' },
  {
    from: path.join(stagingResources, 'PRODUCTION-INVENTORY.json'),
    to: 'PRODUCTION-INVENTORY.json',
  },
  {
    from: path.join(projectRoot, 'requirements-runtime.lock'),
    to: 'requirements-runtime.lock',
  },
  { from: path.join(stagingResources, 'THIRD_PARTY_LICENSES'), to: 'THIRD_PARTY_LICENSES' },
  { from: path.join(projectRoot, 'LICENSES_CREDITS'), to: 'LICENSES_CREDITS' },
  { from: path.join(frontendRoot, 'public', 'icon.ico'), to: 'icon.ico' },
];

if (onboardingTestInstaller) {
  for (const name of [
    'LIVE2D_RUNTIME_ENABLED',
    'LIVE2D-RUNTIME-ASSETS.json',
    'Live2DCubismCore.js',
    'downscale-live2d-textures.py',
  ]) {
    const source = path.join(stagingResources, name);
    if (!fs.existsSync(source)) throw new Error(`Live2D test runtime output is missing: ${name}`);
    extraResources.push({ from: source, to: name });
  }
} else if (live2dBuildEnabled) {
  for (const name of [
    'LIVE2D_PUBLICATION_LICENSE.json',
    'LIVE2D_RUNTIME_ENABLED',
    'LIVE2D-RUNTIME-ASSETS.json',
    'Live2DCubismCore.js',
    'downscale-live2d-textures.py',
  ]) {
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

for (const name of ['LICENSE', 'NOTICE', 'CREDITS.md', 'AGPL_EXCLUDED.md']) {
  extraResources.push({ from: path.join(projectRoot, name), to: name });
}

module.exports = {
  appId,
  productName,
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
    // corresponding source is emitted beside the installer, never inside the
    // executable production payload.
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
  extraFiles: onboardingTestInstaller
    ? [{ from: path.join(stagingResources, 'TEST-BUILD-DO-NOT-RELEASE.json'), to: 'TEST-BUILD-DO-NOT-RELEASE.json' }]
    : [],
  extraResources,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: path.join(frontendRoot, 'public', 'icon.ico'),
    executableName: onboardingTestInstaller ? 'Reverie-Onboarding-Test' : 'Reverie',
    requestedExecutionLevel: 'asInvoker',
    artifactName: onboardingTestInstaller
      ? 'Reverie-Onboarding-Test-20260905-Setup-${version}-x64.${ext}'
      : 'Reverie0.5.5-Setup-${version}-x64.${ext}',
    publish: null,
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    selectPerMachineByDefault: true,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: productName,
    include: path.join(frontendRoot, 'nsis', 'installer.nsh'),
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    differentialPackage: false,
    installerLanguages: ['zh_CN', 'en_US'],
    multiLanguageInstaller: true,
    license: path.join(projectRoot, 'LICENSE'),
  },
};
