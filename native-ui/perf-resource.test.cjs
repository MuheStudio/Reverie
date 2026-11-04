'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const os = require('node:os'), fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const guard = require('../frontend/script/acceptance-isolation.cjs');
const { compileSampler, sampleOwned } = require('./perf-sampling.cjs');
const { childCompletion, safeEnvironment } = require('./check-performance.cjs');
test('libproc samples only the expected live birth and rejects a changed identity', { skip: process.platform !== 'darwin' }, async () => {
  const run = guard.createIsolationContext(fs.realpathSync(os.tmpdir()));
  const data = guard.createIsolatedDirectory(run.runRoot, 'data');
  try {
    const sampler = compileSampler(run.runRoot);
    const expected = guard.inspectProcesses(run.runRoot, [process.pid])[0];
    assert.equal(expected.uid, process.getuid());
    const running = { runRoot: run.runRoot, userData: data, owned: new Map() };
    const result = await sampleOwned(sampler, running, [expected]);
    assert.equal(result.samples.length, 1); assert.equal(result.absent.length, 0);
    assert.equal(result.schema, 'reverie.qt.owned-resource-sample.v2');
    assert(result.cpuTimebase.numerator > 0 && result.cpuTimebase.denominator > 0);
    assert.deepEqual(result.samples[0].cpuTimebase, result.cpuTimebase);
    assert(guard.sameIdentity(result.samples[0].identity, expected));
    assert(result.samples[0].residentBytes > 1024 * 1024); assert(result.samples[0].physicalFootprintBytes > 0);
    assert(result.samples[0].threads > 0); assert(result.samples[0].userCpuNs + result.samples[0].systemCpuNs > 0);
    await assert.rejects(sampleOwned(sampler, running, [{ ...expected, birth: expected.birth + '-changed' }]), /identity changed/);
  } finally { guard.removeIsolationContext(run.runRoot); }
});
test('fixed Qt QTextStream consumes one command per acknowledged write', { skip: process.platform !== 'darwin' }, async () => {
  const run = guard.createIsolationContext(fs.realpathSync(os.tmpdir()));
  const data = guard.createIsolatedDirectory(run.runRoot, 'data');
  let running;
  try {
    const qt = path.resolve(__dirname, '../.tools/qt-sdk/lib');
    const source = path.join(data, 'command-reader.cpp'), executable = path.join(data, 'command-reader');
    // Match Qt v6.11.2 tools/qmlprofiler/commandlistener.cpp: the temporary
    // stream is destroyed after readLine, including its read-ahead buffer.
    fs.writeFileSync(source, '#include <QtCore/QTextStream>\n#include <QtCore/QString>\n#include <cstdio>\nint main(){auto first=QTextStream(stdin).readLine();std::printf("first=%s\\n",qPrintable(first));std::fflush(stdout);auto second=QTextStream(stdin).readLine();std::printf("second=%s\\n",qPrintable(second));std::fflush(stdout);return second=="q"?0:1;}\n');
    const compilation = spawnSync('/usr/bin/clang++', ['-std=c++20', '-F', qt, '-framework', 'QtCore', '-Wl,-rpath,' + qt, source, '-o', executable],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(compilation.status, 0, compilation.stderr);
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    running = { runRoot: run.runRoot, userData: data, child, owned: new Map(), identity: { executable } };
    await once(child, 'spawn'); guard.registerRoot(running);
    const writeOwned = async command => {
      assert(guard.sameIdentity(guard.inspectProcesses(run.runRoot, [child.pid])[0], running.rootIdentity));
      await new Promise((resolve, reject) => child.stdin.write(command, error => error ? reject(error) : resolve()));
    };
    await writeOwned('f\nq\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert(output.includes('first=f')); assert.equal(child.exitCode, null, 'batched second command was unexpectedly retained');
    await writeOwned('q\n'); await childCompletion(child, 2000, 'Qt command reader');
    assert.equal(child.exitCode, 0); assert(output.includes('second=q'));
  } finally {
    if (running?.rootIdentity) for (const expected of guard.remainingProcesses(running)) guard.signalOwned(running, expected, 'SIGKILL');
    guard.removeIsolationContext(run.runRoot);
  }
});

test('converted libproc CPU agrees with a real busy child process.cpuUsage clock', { skip: process.platform !== 'darwin' }, async t => {
  const run = guard.createIsolationContext(fs.realpathSync(os.tmpdir()));
  const data = guard.createIsolatedDirectory(run.runRoot, 'data');
  let running;
  try {
    const sampler = compileSampler(run.runRoot);
    const program = `process.on('message', message => {
      if (message.type === 'busy') {
        const start = process.cpuUsage(); let sink = 0, used;
        do { for (let i = 0; i < 10000; i++) sink += Math.sin(i); used = process.cpuUsage(start); }
        while (used.user + used.system < 300000);
        process.send({ type: 'busy-complete', cpuMicros: used.user + used.system, sink });
      } else if (message.type === 'shutdown') process.disconnect();
    }); process.send({ type: 'ready' });`;
    const child = spawn(process.execPath, ['-e', program], { env: safeEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const ready = once(child, 'message');
    running = { runRoot: run.runRoot, userData: data, child, owned: new Map(), identity: { executable: process.execPath } };
    assert.equal((await ready)[0].type, 'ready'); guard.registerRoot(running);
    const first = (await sampleOwned(sampler, running, [])).samples.find(sample => sample.identity.pid === child.pid);
    const busyDone = once(child, 'message');
    assert(guard.sameIdentity(guard.inspectProcesses(run.runRoot, [child.pid])[0], running.rootIdentity));
    await new Promise((resolve, reject) => child.send({ type: 'busy' }, error => error ? reject(error) : resolve()));
    const completed = (await busyDone)[0]; assert.equal(completed.type, 'busy-complete'); assert(completed.cpuMicros >= 300000);
    const captured = await sampleOwned(sampler, running, []);
    const last = captured.samples.find(sample => sample.identity.pid === child.pid);
    assert(first && last); assert.deepEqual(first.cpuTimebase, last.cpuTimebase);
    for (const sample of [first, last]) {
      const n = BigInt(sample.cpuTimebase.numerator), d = BigInt(sample.cpuTimebase.denominator);
      assert.equal(BigInt(sample.userCpuNs), BigInt(sample.rawUserCpuTicks) * n / d);
      assert.equal(BigInt(sample.systemCpuNs), BigInt(sample.rawSystemCpuTicks) * n / d);
    }
    const deltaNs = last.userCpuNs + last.systemCpuNs - first.userCpuNs - first.systemCpuNs;
    const cpuUsageNs = completed.cpuMicros * 1000;
    const ratio = deltaNs / cpuUsageNs;
    t.diagnostic(JSON.stringify({ cpuTimebase: last.cpuTimebase, busyChildCpuMicros: completed.cpuMicros,
      convertedLibprocDeltaNs: deltaNs, ratioToProcessCpuUsage: ratio }));
    assert(ratio > .9 && ratio < 1.2, `CPU clocks disagree: converted=${deltaNs}ns, process.cpuUsage=${cpuUsageNs}ns, ratio=${ratio}`);
    if (last.cpuTimebase.numerator !== last.cpuTimebase.denominator) {
      const rawDelta = last.rawUserCpuTicks + last.rawSystemCpuTicks - first.rawUserCpuTicks - first.rawSystemCpuTicks;
      assert(Math.abs(rawDelta / cpuUsageNs - 1) > .5, 'test did not distinguish raw ticks from converted nanoseconds');
    }
    assert(guard.sameIdentity(guard.inspectProcesses(run.runRoot, [child.pid])[0], running.rootIdentity));
    await new Promise((resolve, reject) => child.send({ type: 'shutdown' }, error => error ? reject(error) : resolve()));
    await childCompletion(child, 3000, 'busy CPU helper shutdown'); assert.equal(child.exitCode, 0);
  } finally {
    if (running?.rootIdentity) for (const expected of guard.remainingProcesses(running)) guard.signalOwned(running, expected, 'SIGKILL');
    guard.removeIsolationContext(run.runRoot);
  }
});
