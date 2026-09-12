const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertLive2DReleaseGate,
} = require('../electron/live2d-release-gate.cjs');
const {
  stageLive2DCoreOnlyTestRuntime,
} = require('../electron/live2d-runtime-assets.cjs');
const { createSeedConfig } = require('./seed-config.cjs');
const { verifyPackagedWindowsIcons } = require('./windows-icon-verification.cjs');
const {
  assertProductionPayload,
  compileProductionPythonSource,
  copyProductionPythonSource,
  preparePythonRuntime,
  writeProductionInventory,
} = require('./production-runtime.cjs');

const frontendRoot = path.resolve(__dirname, '..');
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
const appStage = path.join(frontendRoot, '.installer-app');
const resourceStage = path.join(frontendRoot, '.installer-resources');
const sourceStage = path.join(frontendRoot, '.installer-source');
const live2dBuildEnabled = process.env.REVERIE_LIVE2D_PUBLIC_BUILD === '1';
const onboardingTestInstaller = process.env.REVERIE_ONBOARDING_TEST_INSTALLER === '1';
const installerArtifactName = onboardingTestInstaller
  ? 'Reverie-Onboarding-Test-20260905-Setup-0.1.0-x64.exe'
  : 'Reverie0.5.5-Setup-0.5.5-x64.exe';
const sourceArtifactName = onboardingTestInstaller
  ? 'Reverie-Onboarding-Test-20260905-Corresponding-Source.zip'
  : 'Reverie0.5.5-Corresponding-Source.zip';
const sourceArchive = path.join(outputRoot, sourceArtifactName);
const live2dLicenseSource = process.env.REVERIE_LIVE2D_LICENSE_PATH
  ? path.resolve(process.env.REVERIE_LIVE2D_LICENSE_PATH)
  : path.join(projectRoot, 'LICENSES_CREDITS', 'LIVE2D_PUBLICATION_LICENSE.json');

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) {
    throw new Error(`${label} must stay inside ${parent}: ${child}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeStage(target) {
  assertInside(frontendRoot, target, 'Installer staging path');
  fs.rmSync(target, { recursive: true, force: true });
}

function shouldSkipSource(name) {
  return new Set([
    '.git', '.hypothesis', '.pytest_cache', '__pycache__', 'node_modules',
    'dist', 'venv', '.venv', '.installer-app', '.installer-resources',
  ]).has(name);
}

function copyRecursive(source, target, filter = () => true) {
  const stat = fs.lstatSync(source);
  if (!filter(source, stat)) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to package symlink: ${source}`);
  }
  if (stat.isDirectory()) {
    ensureDir(target);
    for (const name of fs.readdirSync(source)) {
      if (shouldSkipSource(name)) continue;
      copyRecursive(path.join(source, name), path.join(target, name), filter);
    }
    return;
  }
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function copyIfExists(source, target, filter) {
  if (fs.existsSync(source)) copyRecursive(source, target, filter);
}

function writeJson(target, value) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: frontendRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status}`);
  }
}

function runCaptured(command, args, cwd = frontendRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function buildRenderer() {
  run(
    process.execPath,
    [path.join(frontendRoot, 'script', 'run-clean-tool.cjs'), 'vite', 'build'],
    {
      NODE_ENV: 'production',
      VITE_ELECTRON_BUILD: 'true',
      VITE_LIVE2D_PUBLIC_ENABLED: live2dBuildEnabled ? 'true' : 'false',
    },
  );
}

function enforceLive2DReleaseBoundary() {
  if (onboardingTestInstaller) {
    if (live2dBuildEnabled) {
      throw new Error('Onboarding test installer must not use the public Live2D release mode');
    }
    return;
  }
  assertLive2DReleaseGate({
    buildEnabled: live2dBuildEnabled ? '1' : '0',
    licensePath: live2dLicenseSource,
    platform: 'win32',
    scanRoots: [
      path.join(projectRoot, 'src'),
      path.join(projectRoot, 'data'),
      path.join(frontendRoot, 'electron'),
      path.join(frontendRoot, 'public'),
      path.join(frontendRoot, 'dist'),
    ],
  });
  if (!live2dBuildEnabled) return;
  copyRecursive(
    live2dLicenseSource,
    path.join(resourceStage, 'LIVE2D_PUBLICATION_LICENSE.json'),
  );
  fs.writeFileSync(
    path.join(resourceStage, 'LIVE2D_RUNTIME_ENABLED'),
    'Licensed Live2D public runtime enabled for this build. No character model is bundled.\r\n',
    'utf8',
  );
}

function resolveLive2DCoreSource() {
  const configured = process.env.REVERIE_LIVE2D_CORE_PATH
    ? path.resolve(process.env.REVERIE_LIVE2D_CORE_PATH)
    : '';
  if (!configured) {
    throw new Error(
      'REVERIE_LIVE2D_CORE_PATH is required when Live2D is enabled. '
      + 'Point it at a regular Live2DCubismCore.js file.',
    );
  }
  const stat = fs.lstatSync(configured);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`Live2D Cubism Core is missing or not a regular file: ${configured}`);
  }
  return configured;
}

function stageLicensedLive2DAssets() {
  if (onboardingTestInstaller) {
    const coreSource = resolveLive2DCoreSource();
    const manifest = stageLive2DCoreOnlyTestRuntime({
      coreSource,
      resourceRoot: resourceStage,
      mode: 'internal-test',
    });
    fs.writeFileSync(
      path.join(resourceStage, 'LIVE2D_RUNTIME_ENABLED'),
      'Internal test-only Cubism Core runtime. No character model is bundled.\r\n',
      'utf8',
    );
    writeJson(path.join(resourceStage, 'TEST-BUILD-DO-NOT-RELEASE.json'), {
      schema: 'reverie.windows-test-build.v1',
      product: 'Reverie Onboarding Test 20260905',
      publishable: false,
      distribution: 'TEST_ONLY_DO_NOT_RELEASE',
      live2dReleaseGate: 'core-only-import-test',
      isolatedUserData: true,
      generatedAtUtc: new Date().toISOString(),
    });
    return manifest;
  }
  if (!live2dBuildEnabled) return null;
  const coreSource = resolveLive2DCoreSource();
  console.warn('[package:win] Public Live2D builds ship Cubism Core only; character models are user-imported.');
  return stageLive2DCoreOnlyTestRuntime({
    coreSource,
    resourceRoot: resourceStage,
    mode: 'public',
  });
}

function prepareDesktopApp() {
  copyRecursive(path.join(frontendRoot, 'dist'), path.join(appStage, 'dist'));
  copyRecursive(
    path.join(frontendRoot, 'electron'),
    path.join(appStage, 'electron'),
    (source, stat) => {
      const name = path.basename(source);
      if (stat.isDirectory()) {
        return !['__fixtures__', 'fixtures', 'test', 'tests'].includes(name.toLowerCase());
      }
      if (name.toLowerCase() === 'bridge-supervisor.cjs') return false;
      return !/\.(?:test|spec|fixture)\.(?:c?js|mjs|json)$/i.test(name);
    },
  );
  writeJson(path.join(appStage, 'package.json'), {
    name: onboardingTestInstaller ? 'reverie-onboarding-test' : 'reverie-desktop',
    productName: onboardingTestInstaller ? 'Reverie Onboarding Test 20260905' : 'Reverie',
    version: '0.5.5',
    description: 'Local-first digital companion',
    author: 'Muhe Studio contributors',
    main: 'electron/main.js',
    license: 'GPL-3.0-only',
  });
}

function prepareSeedData() {
  const dataRoot = path.join(resourceStage, 'data');
  const dirs = [
    'memory', 'persona', 'user',
  ];
  for (const dir of dirs) ensureDir(path.join(dataRoot, dir));

  writeJson(path.join(dataRoot, 'config.json'), createSeedConfig());
  writeJson(path.join(dataRoot, 'user', 'profile.json'), {
    name: '', nickname: '', birthday: '', interests: [], hobbies: [],
    favorite_topics: [], important_dates: {}, sticker_preferences: {},
    long_term_goals: [], habits: [], historical_events: [],
  });

  for (const name of ['active.json', 'speech_habits.json']) {
    copyIfExists(
      path.join(projectRoot, 'data', 'persona', name),
      path.join(dataRoot, 'persona', name),
    );
  }
}

function prepareSourceBundle() {
  copyProductionPythonSource(
    path.join(projectRoot, 'src'),
    path.join(sourceStage, 'src'),
    sourceStage,
  );
  copyIfExists(path.join(projectRoot, 'docs'), path.join(sourceStage, 'docs'));

  for (const name of ['src', 'electron', 'script', 'vendor']) {
    const source = path.join(frontendRoot, name);
    assertInside(projectRoot, source, 'Frontend source');
    copyIfExists(source, path.join(sourceStage, 'frontend', name));
  }

  const frontendFiles = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html',
    'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'electron-builder.config.cjs',
  ];
  for (const name of frontendFiles) {
    copyIfExists(path.join(frontendRoot, name), path.join(sourceStage, 'frontend', name));
  }

  for (const name of [
    'LICENSE', 'NOTICE', 'CREDITS.md', 'AGPL_EXCLUDED.md', 'CONTRIBUTING.md',
    'README.md', 'pyproject.toml', 'requirements-runtime.txt',
    'requirements-runtime.lock', 'requirements-migration.txt', 'requirements-dev.txt',
    '.env.example',
  ]) {
    copyIfExists(path.join(projectRoot, name), path.join(sourceStage, name));
  }
  copyIfExists(
    path.join(projectRoot, 'LICENSES_CREDITS'),
    path.join(sourceStage, 'LICENSES_CREDITS'),
  );

  fs.writeFileSync(
    path.join(sourceStage, 'SOURCE-CODE-README.txt'),
    [
      'Reverie source code corresponding to this Windows build.',
      'License: GNU GPL version 3.',
      'The Electron application is packaged in integrity-checked app.asar.',
      'Original TypeScript/Python production sources and locked build inputs are included.',
      'Reference projects, tests, local data, caches and virtual environments are omitted.',
      'Build entry: frontend/script/package-win-installer.cjs',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

function safePackageName(name) {
  return name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '__');
}

function collectFrontendLicenses() {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli || !fs.existsSync(pnpmCli)) {
    throw new Error('Run this build through "pnpm package:win" so npm_execpath is available.');
  }
  // When the build runs from a substituted drive (short paths so the NSIS
  // compiler can open app-builder-lib's templates), pnpm's package index only
  // resolves from the REAL path — collect licenses there. Everything else
  // stays on the substituted path.
  const licensesRoot = process.env.REVERIE_LICENSES_FRONTEND_ROOT
    ? path.resolve(process.env.REVERIE_LICENSES_FRONTEND_ROOT)
    : frontendRoot;
  const report = JSON.parse(runCaptured(
    process.execPath,
    [pnpmCli, 'licenses', 'list', '--prod', '--json'],
    licensesRoot,
  ));
  const licenseRoot = path.join(resourceStage, 'THIRD_PARTY_LICENSES', 'npm');
  const inventory = [];

  for (const [license, packages] of Object.entries(report)) {
    for (const entry of packages) {
      const versions = Array.isArray(entry.versions) ? entry.versions : [];
      const packagePaths = Array.isArray(entry.paths) ? entry.paths : [];
      const resolvedVersions = versions.length > 0
        ? versions
        : packagePaths.map((packagePath) => {
            if (!isInside(licensesRoot, packagePath)) {
              throw new Error(`npm license source escaped frontend root: ${packagePath}`);
            }
            const metadata = JSON.parse(
              fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'),
            );
            if (typeof metadata.version !== 'string' || !metadata.version.trim()) {
              throw new Error(`npm license source has no version: ${packagePath}`);
            }
            return metadata.version.trim();
          });
      inventory.push({
        name: entry.name,
        versions: resolvedVersions,
        license,
        homepage: entry.homepage || '',
      });
      for (let index = 0; index < packagePaths.length; index += 1) {
        const packagePath = packagePaths[index];
        if (!isInside(licensesRoot, packagePath)) {
          throw new Error(`npm license source escaped frontend root: ${packagePath}`);
        }
        const version = resolvedVersions[Math.min(index, resolvedVersions.length - 1)];
        const target = path.join(licenseRoot, `${safePackageName(entry.name)}@${version}`);
        for (const name of fs.readdirSync(packagePath)) {
          if (/^(licen[cs]e|copying|notice)(\..*)?$/i.test(name)) {
            copyIfExists(path.join(packagePath, name), path.join(target, name));
          }
        }
      }
    }
  }
  writeJson(path.join(licenseRoot, 'inventory.json'), inventory);

  const elephantopsLink = path.join(licensesRoot, 'node_modules', 'elephantops');
  if (!fs.existsSync(elephantopsLink)) {
    throw new Error('GPL dependency source is missing: node_modules/elephantops');
  }
  const elephantops = fs.realpathSync(elephantopsLink);
  if (!isInside(licensesRoot, elephantops)) {
    throw new Error(`GPL dependency source escaped frontend root: ${elephantops}`);
  }
  copyRecursive(
    elephantops,
    path.join(sourceStage, 'vendor', 'elephantops'),
  );
}

function collectPythonLicenses() {
  const python = path.join(resourceStage, 'python', 'python.exe');
  run(python, [
    path.join(frontendRoot, 'script', 'collect-python-licenses.py'),
    path.join(resourceStage, 'THIRD_PARTY_LICENSES', 'python'),
  ]);
}

function compressSourceBundle() {
  fs.rmSync(sourceArchive, { force: true });
  run('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Compress-Archive -Path (Join-Path $env:REVERIE_SOURCE_STAGE '*') -DestinationPath $env:REVERIE_SOURCE_ARCHIVE -CompressionLevel Optimal -Force",
  ], {
    REVERIE_SOURCE_STAGE: sourceStage,
    REVERIE_SOURCE_ARCHIVE: sourceArchive,
  });
  if (!fs.existsSync(sourceArchive) || fs.statSync(sourceArchive).size < 1024) {
    throw new Error('Corresponding source archive was not created');
  }
}

function buildInstaller() {
  const electronBuilderCli = process.env.REVERIE_ELECTRON_BUILDER_CLI
    ? path.resolve(process.env.REVERIE_ELECTRON_BUILDER_CLI)
    : require.resolve('electron-builder/out/cli/cli.js');
  const cliStat = fs.lstatSync(electronBuilderCli);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) {
    throw new Error('Electron Builder CLI override must be a regular file');
  }
  run(
    process.execPath,
    [electronBuilderCli, '--config', 'electron-builder.config.cjs', '--win', 'nsis', '--x64', '--publish', 'never'],
    { CSC_IDENTITY_AUTO_DISCOVERY: 'false', REVERIE_WINDOWS_OUT: outputRoot },
  );
}

function verifyWindowsIcons() {
  verifyPackagedWindowsIcons({
    executable: path.join(
      outputRoot,
      'win-unpacked',
      onboardingTestInstaller ? 'Reverie-Onboarding-Test.exe' : 'Reverie.exe',
    ),
    resourceIcon: path.join(outputRoot, 'win-unpacked', 'resources', 'icon.ico'),
  });
}

function writeArtifactHash() {
  const installer = path.join(outputRoot, installerArtifactName);
  if (!fs.existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  if (!fs.existsSync(sourceArchive)) throw new Error(`Source archive not found: ${sourceArchive}`);
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceArchive)).digest('hex');
  fs.writeFileSync(`${installer}.sha256`, `${hash}  ${path.basename(installer)}\r\n`, 'ascii');
  fs.writeFileSync(
    `${sourceArchive}.sha256`,
    `${sourceHash}  ${path.basename(sourceArchive)}\r\n`,
    'ascii',
  );
  writeJson(path.join(
    outputRoot,
    onboardingTestInstaller
      ? 'Reverie-Onboarding-Test-20260905-build-info.json'
      : 'Reverie0.5.5-Setup-build-info.json',
  ), {
    product: onboardingTestInstaller ? 'Reverie Onboarding Test 20260905' : 'Reverie',
    version: onboardingTestInstaller ? '0.1.0' : '0.5.5',
    architecture: 'x64',
    installer: path.basename(installer), sha256: hash,
    license: 'GPL-3.0-only', asar: true, sourceIncludedInRuntime: false,
    publishable: !onboardingTestInstaller,
    isolatedUserData: onboardingTestInstaller,
    bundledCharacter: false,
    bundledVoicePack: false,
    live2d: {
      enabled: live2dBuildEnabled || onboardingTestInstaller,
      mode: onboardingTestInstaller
        ? 'internal-test-core-only'
        : live2dBuildEnabled
          ? 'public-core-only'
          : 'disabled',
      bundledCharacter: false,
    },
    correspondingSource: path.basename(sourceArchive), correspondingSourceSha256: sourceHash,
    sourceRoot: projectRoot,
  });
  console.log(installer);
}

function main() {
  assertInside(path.join(reverieRoot, 'Reverie-project'), projectRoot, 'Project root');
  ensureDir(outputRoot);
  removeStage(appStage);
  removeStage(resourceStage);
  removeStage(sourceStage);
  try {
    buildRenderer();
    enforceLive2DReleaseBoundary();
    stageLicensedLive2DAssets();
    if (live2dBuildEnabled || onboardingTestInstaller) {
      const transformScript = path.join(frontendRoot, 'script', 'downscale-live2d-textures.py');
      if (!fs.existsSync(transformScript)) {
        throw new Error('Live2D texture downscale script is missing');
      }
      copyRecursive(transformScript, path.join(resourceStage, 'downscale-live2d-textures.py'));
    }
    prepareDesktopApp();
    prepareSeedData();
    copyProductionPythonSource(
      path.join(projectRoot, 'src'),
      path.join(resourceStage, 'src'),
      resourceStage,
    );
    compileProductionPythonSource(path.join(resourceStage, 'src'), projectRoot);
    const runtime = preparePythonRuntime({
      projectRoot,
      frontendRoot,
      destination: path.join(resourceStage, 'python'),
      stagingRoot: resourceStage,
    });
    prepareSourceBundle();
    collectFrontendLicenses();
    collectPythonLicenses();
    writeProductionInventory({
      resourceRoot: resourceStage,
      appRoot: appStage,
      runtime,
    });
    assertProductionPayload(resourceStage, appStage);
    // Scan the exact staged payload as the final release gate. This catches a
    // dependency or build step that introduced Cubism Core/models after the
    // source-input scan.
    if (!live2dBuildEnabled && !onboardingTestInstaller) {
      assertLive2DReleaseGate({
        buildEnabled: '0',
        scanRoots: [appStage, resourceStage],
      });
    }
    buildInstaller();
    verifyWindowsIcons();
    compressSourceBundle();
    writeArtifactHash();
  } finally {
    removeStage(appStage);
    removeStage(resourceStage);
    removeStage(sourceStage);
  }
}

main();
