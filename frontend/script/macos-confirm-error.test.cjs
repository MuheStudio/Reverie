'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('native fatal-alert controller accepts only the two exact test layouts before looking up a PID',
  { skip: process.platform !== 'darwin' }, async (t) => {
    const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reverie-alert-policy-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const source = path.join(scratch, 'confirm.swift'), executable = path.join(scratch, 'confirm');
    fs.copyFileSync(path.join(__dirname, 'macos-confirm-error.swift'), source);
    const compilation = spawnSync('/usr/bin/swiftc', ['-module-cache-path', path.join(scratch, 'cache'), source, '-o', executable], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(compilation.status, 0, compilation.stderr || compilation.error?.message);
    const app = 'Reverie macOS Test.app';
    const locations = [['/private/tmp/Reverie 核心 验收', '只读应用'], ['/private/tmp/Reverie DMG 验收', '安装 目录']];
    const allowedPaths = locations.map(([root, folder]) => {
      fs.mkdirSync(root, { recursive: true });
      const run = fs.mkdtempSync(path.join(root, 'run-'));
      t.after(() => fs.rmSync(run, { recursive: true, force: true }));
      const target = path.join(run, folder, app);
      // Match the real controller's existing-app path, including Foundation's
      // canonicalization of macOS /tmp aliases. No process is ever launched.
      fs.mkdirSync(target, { recursive: true });
      return target;
    });
    const cases = [
      ['original read-only test', allowedPaths[0], true],
      ['DMG installed-copy test', allowedPaths[1], true],
      ['unrelated temporary directory', `/private/tmp/unrelated/run-abc/安装 目录/${app}`, false],
      ['missing run identity', `/private/tmp/Reverie DMG 验收/run-/安装 目录/${app}`, false],
      ['nested directory', `/private/tmp/Reverie DMG 验收/run-abc/other/安装 目录/${app}`, false],
      ['mounted DMG is not a negative-test location', `/private/tmp/Reverie DMG 验收/run-abc/最终 镜像/${app}`, false],
      ['real installed application', `/Applications/${app}`, false],
    ];
    for (const [name, appRoot, allowed] of cases) await t.test(name, () => {
      const request = path.join(scratch, 'request.json');
      fs.writeFileSync(request, JSON.stringify({ appRoot, appId: 'com.muhe.reverie.macos.test',
        pid: 2147483647, expectedTitle: 'Reverie 启动失败',
        expectedMessage: '安全初始化未完成，应用将退出。', expectedExitCode: 1 }));
      const result = spawnSync(executable, [request], { cwd: scratch, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 2, result.stderr || result.error?.message);
      assert.match(result.stderr, allowed ? /Expected test process is absent or changed/ : /outside the fatal test-alert contract/);
      assert.equal(result.stdout, '', 'No UI action should run with an absent PID');
    });
  });
