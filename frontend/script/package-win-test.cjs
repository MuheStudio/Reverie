const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertLive2DReleaseGate } = require('../electron/live2d-release-gate.cjs');
const { stageLive2DRuntimeAssets } = require('../electron/live2d-runtime-assets.cjs');
const { createTextureTransformer } = require('./live2d-build-assets.cjs');
const {
  assertProductionPayload,
  copyProductionPythonSource,
  preparePythonRuntime,
  writeProductionInventory,
} = require('./production-runtime.cjs');

const frontendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(frontendRoot, '..');
const repoRoot = path.resolve(projectRoot, '..', '..');
const outRoot = process.env.REVERIE_WINDOWS_OUT
  ? path.resolve(process.env.REVERIE_WINDOWS_OUT)
  : path.resolve(repoRoot, '将Reverie打包至各个平台', '半成品', 'Windows');
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const packageName = `Reverie-Windows-Test-${timestamp}`;
const packageDir = path.join(outRoot, packageName);
const resourcesDir = path.join(packageDir, 'resources');
const appDir = path.join(resourcesDir, 'app');
const smokeMarker = path.join(frontendRoot, '.package-smoke', 'latest-package.json');
const live2dBuildEnabled = process.env.REVERIE_LIVE2D_PUBLIC_BUILD === '1';
const live2dTestEnabled = process.env.REVERIE_LIVE2D_TEST_BUILD === '1';
const live2dAssetsEnabled = live2dBuildEnabled || live2dTestEnabled;
const live2dLicenseSource = process.env.REVERIE_LIVE2D_LICENSE_PATH
  ? path.resolve(process.env.REVERIE_LIVE2D_LICENSE_PATH)
  : path.join(projectRoot, 'LICENSES_CREDITS', 'LIVE2D_PUBLICATION_LICENSE.json');

function assertInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  if (!childResolved.startsWith(parentResolved + path.sep)) {
    throw new Error(`Refusing to write outside ${parentResolved}: ${childResolved}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest, options = {}) {
  const filter = options.filter || (() => true);
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to copy symlink into test package: ${src}`);
  }
  if (!filter(src, stat)) {
    return;
  }
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), options);
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

function removeIfExists(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function writeJson(target, payload) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function runElectronBuild() {
  const result = spawnSync(
    process.execPath,
    [path.join(frontendRoot, 'script', 'run-clean-tool.cjs'), 'vite', 'build'],
    {
      cwd: frontendRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_ELECTRON_BUILD: 'true',
        VITE_LIVE2D_PUBLIC_ENABLED: live2dAssetsEnabled ? 'true' : 'false',
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Electron build failed with exit code ${result.status}`);
  }
}

function shouldCopyElectronRuntime(src, stat) {
  const name = path.basename(src);
  if (stat.isDirectory()) {
    return !['__fixtures__', 'fixtures', 'test', 'tests'].includes(name.toLowerCase());
  }
  if (name.toLowerCase() === 'bridge-supervisor.cjs') return false;
  return !/\.(?:test|spec|fixture)\.(?:c?js|mjs|json)$/i.test(name)
    && !/(?:^|[-_.])test-fixture(?:[-_.]|$)/i.test(name);
}

function assertNoTestCode(root) {
  if (!fs.existsSync(root)) return true;
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Test package contains a symlink: ${current}`);
    const name = path.basename(current);
    if ((!stat.isDirectory() && !shouldCopyElectronRuntime(current, stat))
      || (stat.isDirectory() && ['__fixtures__', 'fixtures', 'test', 'tests'].includes(name.toLowerCase()))) {
      throw new Error(`Test package contains test code or fixtures: ${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
    }
  };
  visit(root);
  return true;
}

function enforceLive2DTestPackageBoundary(scanRoots) {
  const license = assertLive2DReleaseGate({
    buildEnabled: live2dBuildEnabled ? '1' : '0',
    licensePath: live2dLicenseSource,
    platform: 'win32',
    scanRoots,
  });
  return license;
}

function createTestBuildMetadata() {
  return {
    schema: 'reverie.windows-test-build.v1',
    product: 'Reverie',
    publishable: false,
    distribution: 'TEST_ONLY_DO_NOT_RELEASE',
    live2dReleaseGate: live2dBuildEnabled
      ? 'licensed-test-runtime'
      : live2dTestEnabled ? 'internal-test-runtime' : 'disabled-and-scanned',
    generatedAtUtc: new Date().toISOString(),
  };
}

function copyIfExists(src, dest) {
  if (fs.existsSync(src)) {
    copyRecursive(src, dest);
  }
}

function copyDataSkeleton() {
  const dataDir = path.join(resourcesDir, 'data');
  const dirs = [
    'memory',
    'persona',
    'user',
  ];
  for (const dir of dirs) {
    ensureDir(path.join(dataDir, dir));
  }

  writeJson(path.join(dataDir, 'config.json'), {
    llm: {
      provider: 'ollama',
      model: '',
      base_url: 'http://localhost:11434/v1',
      temperature: 0.82,
      max_tokens: 2048,
    },
    memory: {
      embedding_model: 'BAAI/bge-small-zh-v1.5',
      retention_days: 730,
      forgetting_enabled: true,
      long_term_forget_days: 90,
      short_term_forget_days: 7,
      forget_probability: 0.05,
      decay_lambda: 0.0077,
      recall_reinforcement_alpha: 0.12,
      minimum_retrieval_retention: 0.05,
      misremembering_enabled: false,
      misremember_probability: 0.001,
      long_term_misremember_probability: 0.001,
      short_term_misremember_probability: 0.001,
    },
    chat: {
      reply_delay_min: 3,
      reply_delay_max: 25,
      split_messages: true,
      typing_indicator: true,
    },
    features: {
      web_surfing_enabled: false,
      web_disclaimer_acknowledged: false,
      web_allowed_topics: ['热门梗', '新番/动漫资讯', '二次元内容', '游戏更新'],
      web_refresh_interval_minutes: 180,
      diary_enabled: false,
      diary_privacy_enabled: true,
      diary_peek_enabled: true,
      timeline_enabled: false,
      proactive_chat_enabled: false,
      late_night_enabled: false,
      late_night_probability: 0.1,
      autonomous_memory_enabled: true,
      autonomous_memory_llm_enabled: false,
    },
    cloud_mode: 'local',
  });

  copyIfExists(
    path.join(projectRoot, 'data', 'persona', 'active.json'),
    path.join(dataDir, 'persona', 'active.json'),
  );
  writeJson(path.join(dataDir, 'user', 'profile.json'), {
    name: '',
    nickname: '',
    birthday: '',
    interests: [],
    hobbies: [],
    favorite_topics: [],
    important_dates: {},
    sticker_preferences: {},
    long_term_goals: [],
    habits: [],
    historical_events: [],
  });
}

function stageLive2DTestAssets() {
  if (!live2dAssetsEnabled) return null;
  const coreSource = process.env.REVERIE_LIVE2D_CORE_PATH
    ? path.resolve(process.env.REVERIE_LIVE2D_CORE_PATH)
    : '';
  const modelSource = process.env.REVERIE_YUMI_SOURCE
    ? path.resolve(process.env.REVERIE_YUMI_SOURCE)
    : path.resolve(repoRoot, '皮套-yumi');
  return stageLive2DRuntimeAssets({
    coreSource,
    modelSource,
    resourceRoot: resourcesDir,
    mode: live2dBuildEnabled ? 'public' : 'internal-test',
    transformCharacter: createTextureTransformer({ projectRoot, frontendRoot }),
  });
}

async function applyPortableExecutableMetadata(executable) {
  const { rcedit } = await import('rcedit');
  await rcedit(executable, {
    icon: path.join(frontendRoot, 'public', 'icon.ico'),
    'file-version': '0.1.0.0',
    'product-version': '0.1.0.0',
    'version-string': {
      ProductName: 'Reverie',
      FileDescription: 'Reverie local-first digital companion',
      OriginalFilename: 'Reverie.exe',
    },
  });
}

async function main() {
  const electronExe = require('electron');
  const electronDist = path.dirname(electronExe);

  removeIfExists(smokeMarker);
  runElectronBuild();
  enforceLive2DTestPackageBoundary([
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'data'),
    path.join(frontendRoot, 'electron'),
    path.join(frontendRoot, 'public'),
    path.join(frontendRoot, 'dist'),
  ]);

  if (!fs.existsSync(path.join(frontendRoot, 'dist', 'index.html'))) {
    throw new Error('frontend/dist/index.html not found. Run the desktop Vite build first.');
  }
  ensureDir(outRoot);
  assertInside(outRoot, packageDir);
  removeIfExists(packageDir);

  copyRecursive(electronDist, packageDir);

  const oldExe = path.join(packageDir, 'electron.exe');
  const newExe = path.join(packageDir, 'Reverie.exe');
  if (fs.existsSync(oldExe)) {
    fs.renameSync(oldExe, newExe);
  }
  await applyPortableExecutableMetadata(newExe);

  ensureDir(appDir);
  copyRecursive(path.join(frontendRoot, 'dist'), path.join(appDir, 'dist'));
  copyRecursive(path.join(frontendRoot, 'electron'), path.join(appDir, 'electron'), {
    filter: shouldCopyElectronRuntime,
  });
  writeJson(path.join(appDir, 'package.json'), {
    name: 'reverie-windows-test',
    version: '0.1.0',
    main: 'electron/main.js',
    private: true,
    reverieDistribution: 'TEST_ONLY_DO_NOT_RELEASE',
  });

  copyProductionPythonSource(
    path.join(projectRoot, 'src'),
    path.join(resourcesDir, 'src'),
    resourcesDir,
  );
  const runtime = preparePythonRuntime({
    projectRoot,
    frontendRoot,
    destination: path.join(resourcesDir, 'python'),
    stagingRoot: resourcesDir,
  });
  for (const docFile of [
    'LICENSE',
    'NOTICE',
    'CREDITS.md',
    'AGPL_EXCLUDED.md',
    'requirements-runtime.lock',
  ]) {
    copyIfExists(path.join(projectRoot, docFile), path.join(resourcesDir, docFile));
  }
  copyIfExists(path.join(projectRoot, 'LICENSES_CREDITS'), path.join(resourcesDir, 'LICENSES_CREDITS'));
  copyRecursive(path.join(frontendRoot, 'public', 'icon.ico'), path.join(resourcesDir, 'icon.ico'));
  copyDataSkeleton();
  stageLive2DTestAssets();
  const licenseResult = spawnSync(
    path.join(resourcesDir, 'python', 'python.exe'),
    [
      path.join(frontendRoot, 'script', 'collect-python-licenses.py'),
      path.join(resourcesDir, 'THIRD_PARTY_LICENSES', 'python'),
    ],
    { cwd: frontendRoot, stdio: 'inherit', windowsHide: true },
  );
  if (licenseResult.error) throw licenseResult.error;
  if (licenseResult.status !== 0) {
    throw new Error(`Python license inventory failed with exit code ${licenseResult.status}`);
  }
  writeProductionInventory({
    resourceRoot: resourcesDir,
    appRoot: appDir,
    runtime,
  });
  assertProductionPayload(resourcesDir, appDir);
  if (live2dBuildEnabled) {
    copyRecursive(
      live2dLicenseSource,
      path.join(resourcesDir, 'LIVE2D_PUBLICATION_LICENSE.json'),
    );
    fs.writeFileSync(
      path.join(resourcesDir, 'LIVE2D_RUNTIME_ENABLED'),
      'Licensed Live2D runtime in a non-publishable test build.\r\n',
      'utf8',
    );
  } else if (live2dTestEnabled) {
    fs.writeFileSync(
      path.join(resourcesDir, 'LIVE2D_RUNTIME_ENABLED'),
      'Internal test-only Live2D runtime. Redistribution is prohibited.\r\n',
      'utf8',
    );
  }
  assertNoTestCode(path.join(appDir, 'electron'));
  if (!live2dAssetsEnabled) {
    enforceLive2DTestPackageBoundary([appDir, resourcesDir]);
  }
  writeJson(path.join(packageDir, 'TEST-BUILD-DO-NOT-RELEASE.json'), createTestBuildMetadata());

  fs.writeFileSync(
    path.join(packageDir, 'PACKAGE-NOTES.txt'),
    [
      '*** TEST ONLY — NOT FOR RELEASE OR REDISTRIBUTION ***',
      '*** 测试构建——不可发布、不可分发 ***',
      '',
      'Reverie Windows test package',
      '',
      'Run Reverie.exe to start the Electron desktop shell.',
      'This is a portable test build generated without electron-builder/NSIS.',
      'It uses the same hash-locked minimal Python runtime as the formal installer.',
      'It includes a sanitized data skeleton and does not copy private diary keys or memory vectors.',
      'For a formal installer, add electron-builder or another installer toolchain later.',
      '',
    ].join('\r\n'),
    'utf-8',
  );

  writeJson(smokeMarker, {
    schema: 'reverie.package-smoke-target.v1',
    packageRoot: packageDir,
  });
  console.log(`[TEST ONLY - NOT FOR RELEASE] ${packageDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertNoTestCode,
  applyPortableExecutableMetadata,
  createTestBuildMetadata,
  enforceLive2DTestPackageBoundary,
  main,
  shouldCopyElectronRuntime,
};
