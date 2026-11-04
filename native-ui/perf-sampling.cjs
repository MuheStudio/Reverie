'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync, execFile } = require('node:child_process');
const guard = require('../frontend/script/acceptance-isolation.cjs');
function compileSampler(runRoot) {
  const directory = guard.createIsolatedDirectory(runRoot, 'resource-sampler');
  const executable = path.join(directory, 'sampler');
  const source = path.join(__dirname, 'perf-resource.swift');
  const r = spawnSync('/usr/bin/swiftc', ['-module-cache-path', path.join(directory, 'cache'), source, '-o', executable],
    { cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(r.status, 0, `Resource sampler compilation failed: ${r.error?.message || r.stderr}`);
  return { directory, executable, sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
}
function processTreeSnapshot() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, 'PID tree inspection failed');
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number); return { pid, ppid };
  });
}
async function sampleOwned(sampler, running, rootIdentities) {
  const directories = guard.assertIsolation(running.runRoot, running.userData);
  if (running.rootIdentity) guard.collectProcesses(running, processTreeSnapshot());
  const expected = [...new Map([...rootIdentities, ...running.owned.values()].map(p => [p.pid, p])).values()];
  assert(expected.length <= 32, 'Owned workload process count exceeds resource scope');
  const request = path.join(sampler.directory, `sample-${crypto.randomUUID()}.json`);
  fs.writeFileSync(request, JSON.stringify({ expected, directories }), { flag: 'wx', mode: 0o600 });
  try {
    return await new Promise((resolve, reject) => execFile(sampler.executable, [request],
      { cwd: sampler.directory, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Error(`Owned resource sampler refused: ${stderr || error.message}`));
        else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } }
      }));
  } finally { fs.unlinkSync(request); }
}
function summarizeResources(samples, phases = []) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.role}:${sample.identity.pid}:${sample.identity.birth}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const stats = items => {
    if (!items.length) return { sampleCount: 0, cpuMs: null, cpuPercent: null, maximumResidentBytes: null, maximumPhysicalFootprintBytes: null };
    const ordered = items.toSorted((a, b) => a.unixMs - b.unixMs), first = ordered[0], last = ordered.at(-1);
    const cpuNs = Math.max(0, last.userCpuNs + last.systemCpuNs - first.userCpuNs - first.systemCpuNs);
    const elapsed = last.unixMs - first.unixMs;
    return { sampleCount: items.length, firstUnixMs: first.unixMs, lastUnixMs: last.unixMs,
      cpuMs: cpuNs / 1e6, cpuPercent: elapsed > 0 ? cpuNs / (elapsed * 1e4) : null,
      maximumResidentBytes: Math.max(...items.map(s => s.residentBytes)),
      maximumPhysicalFootprintBytes: Math.max(...items.map(s => s.physicalFootprintBytes)),
      maximumThreads: Math.max(...items.map(s => s.threads)) };
  };
  return [...groups.values()].map(items => ({ role: items[0].role, identity: items[0].identity, ...stats(items),
    phases: phases.map(phase => ({ phase: phase.phase || phase.name,
      ...stats(items.filter(s => s.unixMs >= phase.startUnixMs && s.unixMs <= phase.endUnixMs)) })) }));
}
module.exports = { compileSampler, processTreeSnapshot, sampleOwned, summarizeResources };
