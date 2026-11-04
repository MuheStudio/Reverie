'use strict';
// Disposable loopback provider, deliberately separate from the sampler host.
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const MAX_REQUEST_BYTES = 1024 * 1024;
const PROTOCOLS = Object.freeze(['stress-v1', 'companion-transactions-v1']);
const SHORT_TEXT = '窗边的灯还亮着，刚才读到的位置也留在这里。先把这条短回复看完，再慢慢回到原来的段落。今天整理的事项可以一件一件完成，暂时没有答案的部分也可以留到明天。';
const LONG_TEXT = Array.from({ length: 12 }, (_, i) => `${i + 1}. 窗外的光缓慢地移过房间，我们把今天的记录放在桌边，先读完眼前这一段。读长文本时，每一处停顿都有自己的位置；调整窗口、切换面板或等待新的回复，也应当能够继续找到上一句。\n这一段包含中文、English text、数字 0123456789 和标点。我们可以逐项核对清单，留出明天继续思考的空间，把已经确认的内容保存下来。这里的句子只是固定的性能测试资料，不会引用任何人的真实对话。`).join('\n\n');
// The tiny short reply bypasses casual reply-length sampling. The built-in
// catchphrase is present in both texts; no global random seed or backend
// behavior is changed. Serious long/delayed UI prompts preserve full length.
const COMPANION_SHORT_TEXT = '嗯嗯，这条短回复已完成！';
const COMPANION_LONG_TEXT = '嗯嗯，下面逐项保留这份完整说明：\n\n' + Array.from({ length: 12 }, (_, i) =>
  `${i + 1}. 这是一段固定的合成记录，我们按原来的顺序读完每一项，保留中文、English text、数字 0123456789 和标点，方便继续核对已经确认的内容；切换面板、调整窗口或者等待新的回复之后，仍然可以找到前面的段落。\n每个条目都使用相同的句子长度和结构，长回复的完整文字需要保存在权威消息记录中；阅读位置、选区与输入草稿各自保留，回来时再逐项核对。这些句子不含真实个人信息，只用于这次已经登记的界面负载。`).join('\n\n') + '！';
const PROBE_TEXT = '本机性能测试模型已就绪。';
const textSha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function validateProtocol(protocol) {
  assert(PROTOCOLS.includes(protocol), 'Unknown performance protocol'); return protocol;
}
function modelPolicyRecord(protocol = 'stress-v1') {
  validateProtocol(protocol);
  const companion = protocol === 'companion-transactions-v1';
  const content = text => ({ contentSha256: textSha256(text), characters: Array.from(text).length, utf8Bytes: Buffer.byteLength(text) });
  const short = companion ? COMPANION_SHORT_TEXT : SHORT_TEXT, long = companion ? COMPANION_LONG_TEXT : LONG_TEXT;
  const policy = { schema: 'reverie.qt.performance-mock-policy.v1', protocol, classification: 'latest-user-marker-v1',
    maximumRequestBytes: MAX_REQUEST_BYTES, responses: {
      short: { delayMs: 0, ...content(short) }, long: { delayMs: 0, ...content(long) },
      delayed: { delayMs: companion ? 8000 : 2500, ...content(long) }, probe: { delayMs: 0, ...content(PROBE_TEXT) } },
    contentScope: 'Provider UTF-8 text before existing backend guards, punctuation and reply shaping. Canonical delivered-text hashes are separate native evidence.' };
  return { policy, sha256: textSha256(JSON.stringify(policy)) };
}
function classify(body, protocol = 'stress-v1') {
  validateProtocol(protocol);
  const companion = protocol === 'companion-transactions-v1';
  const short = companion ? COMPANION_SHORT_TEXT : SHORT_TEXT, long = companion ? COMPANION_LONG_TEXT : LONG_TEXT;
  const last = String(body?.messages?.filter(m => m?.role === 'user').at(-1)?.content || '');
  if (last.includes('性能延迟回复')) return { kind: 'delayed', delayMs: companion ? 8000 : 2500, content: long };
  if (last.includes('性能长回复')) return { kind: 'long', delayMs: 0, content: long };
  if (last.includes('性能短回复')) return { kind: 'short', delayMs: 0, content: short };
  return { kind: 'probe', delayMs: 0, content: PROBE_TEXT };
}
function modelServerArguments(args) {
  if (args.length === 0) return { protocol: 'stress-v1' };
  assert(args.length === 2 && args[0] === '--protocol', 'Mock provider accepts only one --protocol');
  return { protocol: validateProtocol(args[1]) };
}
function createModelServer({ onCall = () => {}, onComplete = () => {}, delayOverride, protocol = 'stress-v1' } = {}) {
  validateProtocol(protocol);
  assert(delayOverride === undefined || Number.isFinite(delayOverride) && delayOverride >= 0,
    'Invalid unit-test delay override');
  const mockPolicy = modelPolicyRecord(protocol);
  let requestNumber = 0;
  const timers = new Set();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
    const chunks = []; let bytes = 0, refused = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) { refused = true; res.writeHead(413); res.end(); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); } catch { res.writeHead(400); res.end(); return; }
      if (!Array.isArray(body.messages)) { res.writeHead(400); res.end(); return; }
      const fixture = classify(body, protocol), sequence = ++requestNumber;
      const startedUnixMs = Date.now();
      const response = Buffer.from(JSON.stringify({ id: `perf-${sequence}`, object: 'chat.completion',
        model: 'reverie-perf-test', choices: [{ index: 0, message: { role: 'assistant', content: fixture.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } }));
      const call = { sequence, kind: fixture.kind, protocol, mockPolicySha256: mockPolicy.sha256,
        delayMs: fixture.delayMs, effectiveDelayMs: delayOverride ?? fixture.delayMs, startedUnixMs, requestBytes: bytes,
        responseBytes: response.length, contentSha256: textSha256(fixture.content) };
      onCall(call);
      const finish = () => {
        timers.delete(timer);
        if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(response); }
        onComplete({ sequence, protocol, mockPolicySha256: mockPolicy.sha256, completedUnixMs: Date.now(), aborted: res.destroyed });
      };
      const timer = setTimeout(finish, delayOverride ?? fixture.delayMs);
      timers.add(timer);
      res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    });
  });
  server.dispose = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); server.closeAllConnections(); };
  return server;
}
if (require.main === module) {
  if (!process.send) throw Error('Mock provider requires an owned IPC child');
  const { protocol } = modelServerArguments(process.argv.slice(2));
  const mockPolicy = modelPolicyRecord(protocol);
  const server = createModelServer({ protocol, onCall: call => process.send?.({ type: 'call', ...call }),
    onComplete: call => process.send?.({ type: 'complete', ...call }) });
  let stopping = false;
  function stop() {
    if (stopping) return; stopping = true; server.dispose();
    server.close(() => { process.disconnect?.(); });
  }
  process.on('message', message => { if (message?.type === 'shutdown') stop(); });
  process.on('disconnect', stop);
  server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port,
    address: '127.0.0.1', pid: process.pid, protocol, mockPolicySha256: mockPolicy.sha256 }));
}
module.exports = { createModelServer, classify, modelServerArguments, modelPolicyRecord, validateProtocol,
  PROTOCOLS, SHORT_TEXT, LONG_TEXT, COMPANION_SHORT_TEXT, COMPANION_LONG_TEXT, MAX_REQUEST_BYTES };
