'use strict';

const crypto = require('node:crypto');

const EVENT_ID_PATTERN = /^proactive_[0-9a-f]{32}$/;
const RECEIPT_SCHEMA = 'reverie.notification-receipt.v1';
const TERMINAL_OUTCOMES = new Set([
  'shown',
  'expired',
  'focus_suppressed',
  'foreground_suppressed',
]);

function parseNotificationTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  const text = String(value ?? '').trim();
  if (!text) return Number.NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return Date.parse(text);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function validateNotificationItem(name, payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid notification payload');
  }
  if (payload.schema !== 'reverie.notification.v1') {
    throw new Error('Unknown notification schema');
  }
  if (typeof payload.id !== 'string' || !EVENT_ID_PATTERN.test(payload.id)) {
    throw new Error('Invalid notification id');
  }
  if (name !== `${payload.id}.json`) {
    throw new Error('Notification filename does not match payload id');
  }
  if (typeof payload.title !== 'string' || typeof payload.body !== 'string'
      || !payload.body.trim() || typeof payload.only_when_unfocused !== 'boolean') {
    throw new Error('Invalid notification content');
  }
  const createdAt = parseNotificationTimestamp(payload.created_at);
  if (!Number.isFinite(createdAt)) throw new Error('Invalid notification timestamp');
  return { payload, hash: payloadHash(payload), tooOld: now - createdAt > 12 * 60 * 60 * 1000 };
}

function nativeNotificationOptions(payload, { locked = false, silent = false } = {}) {
  return {
    title: locked ? 'Reverie' : payload.title,
    body: locked ? '你有一条本地提醒。' : payload.body,
    silent: Boolean(silent),
    id: payload.id,
    groupId: payload.id,
  };
}

function attachNotificationClick(notification, restoreAndFocus) {
  notification.on('click', restoreAndFocus);
}

function atomicWriteJson(fs, path, destination, value) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function moveRejected(fs, path, directories, filePath, name, now, warn, error) {
  fs.mkdirSync(directories.rejected, { recursive: true });
  try {
    fs.renameSync(filePath, path.join(directories.rejected, `${now()}-${name}`));
  } catch {}
  warn(name, error);
}

function readMatchingReceipt(fs, path, directories, item, now, warn) {
  const receiptPath = path.join(directories.receipts, `${item.payload.id}.json`);
  if (!fs.existsSync(receiptPath)) return 'absent';
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (receipt.schema !== RECEIPT_SCHEMA || receipt.id !== item.payload.id
        || receipt.payload_hash !== item.hash || !TERMINAL_OUTCOMES.has(receipt.outcome)) {
      throw new Error('Notification receipt does not match canonical payload');
    }
    return 'matching';
  } catch (error) {
    warn(`${item.payload.id}.receipt.json`, error);
    return 'conflict';
  }
}

function completeProcessing(fs, path, directories, filePath, item, outcome, now, afterReceipt) {
  fs.mkdirSync(directories.receipts, { recursive: true });
  const receiptPath = path.join(directories.receipts, `${item.payload.id}.json`);
  atomicWriteJson(fs, path, receiptPath, {
    schema: RECEIPT_SCHEMA,
    id: item.payload.id,
    payload_hash: item.hash,
    outcome,
    completed_at: new Date(now()).toISOString(),
  });
  afterReceipt?.({ receiptPath, processingPath: filePath, outcome });
  fs.unlinkSync(filePath);
}

function processClaimedFile(options, directories, name) {
  const {
    fs, path, now, focusActive, windowFocused, showNotification, warn, afterReceipt,
  } = options;
  const filePath = path.join(directories.processing, name);
  let item;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new Error('Invalid notification processing item');
    }
    item = validateNotificationItem(
      name,
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
      now(),
    );
  } catch (error) {
    moveRejected(fs, path, directories, filePath, name, now, warn, error);
    return;
  }

  const receiptState = readMatchingReceipt(fs, path, directories, item, now, warn);
  if (receiptState === 'matching') {
    fs.unlinkSync(filePath);
    return;
  }
  if (receiptState === 'conflict') {
    moveRejected(
      fs, path, directories, filePath, name, now, warn,
      new Error('Notification payload conflicts with terminal receipt'),
    );
    return;
  }

  let outcome;
  if (item.tooOld) outcome = 'expired';
  else if (focusActive()) outcome = 'focus_suppressed';
  else if (item.payload.only_when_unfocused && windowFocused()) {
    outcome = 'foreground_suppressed';
  } else {
    try {
      if (showNotification(item.payload) !== true) return;
      outcome = 'shown';
    } catch (error) {
      warn(name, error);
      return;
    }
  }
  completeProcessing(fs, path, directories, filePath, item, outcome, now, afterReceipt);
}

function processNotificationOutbox(options) {
  const {
    fs,
    path,
    outbox,
    now = Date.now,
    focusActive = () => false,
    windowFocused = () => false,
    showNotification,
    warn = () => {},
    afterReceipt,
  } = options;
  const root = path.join(outbox, '..');
  const directories = {
    outbox,
    processing: path.join(root, 'processing'),
    receipts: path.join(root, 'receipts'),
    rejected: path.join(root, 'rejected'),
  };
  for (const directory of Object.values(directories)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const shared = {
    fs, path, now, focusActive, windowFocused, showNotification, warn, afterReceipt,
  };

  // Resume claims left by a previous process before accepting new work.
  const processingNames = fs.readdirSync(directories.processing)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .slice(0, 20);
  for (const name of processingNames) processClaimedFile(shared, directories, name);

  // Temporary producer files are deliberately ignored before limiting the batch.
  const outboxNames = fs.readdirSync(outbox)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .slice(0, 20);
  for (const name of outboxNames) {
    const source = path.join(outbox, name);
    const claimed = path.join(directories.processing, name);
    if (fs.existsSync(claimed)) continue;
    try {
      fs.renameSync(source, claimed);
    } catch (error) {
      if (fs.existsSync(source)) warn(name, error);
      continue;
    }
    processClaimedFile(shared, directories, name);
  }
}

module.exports = {
  EVENT_ID_PATTERN,
  RECEIPT_SCHEMA,
  attachNotificationClick,
  canonicalJson,
  nativeNotificationOptions,
  parseNotificationTimestamp,
  payloadHash,
  processNotificationOutbox,
  validateNotificationItem,
};
