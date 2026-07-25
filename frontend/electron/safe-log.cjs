'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

function redact(value, secrets = []) {
  let text;
  if (value instanceof Error) text = value.stack || value.message;
  else if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\b(sk|api[-_]?key|token|secret|authorization)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[REDACTED]')
    .replace(/([?&](?:key|token|secret|auth|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:[A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, '[LOCAL_PATH]');
}

class SafeLogger {
  constructor(options = {}) {
    if (!options.logDir) throw new TypeError('SafeLogger requires logDir');
    this.logDir = path.resolve(options.logDir);
    this.filename = options.filename || 'electron.log';
    this.maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    this.maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES;
    this.secrets = new Set();
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  addSecret(secret) {
    if (typeof secret === 'string' && secret.length >= 8) this.secrets.add(secret);
  }

  _path(index = 0) {
    return path.join(this.logDir, index ? `${this.filename}.${index}` : this.filename);
  }

  _rotate(incomingBytes) {
    let size = 0;
    try { size = fs.statSync(this._path()).size; } catch {}
    if (size + incomingBytes <= this.maxBytes) return;
    try { fs.rmSync(this._path(this.maxFiles - 1), { force: true }); } catch {}
    for (let index = this.maxFiles - 2; index >= 0; index -= 1) {
      const source = this._path(index);
      const target = this._path(index + 1);
      try {
        if (fs.existsSync(source)) fs.renameSync(source, target);
      } catch {}
    }
  }

  write(level, args) {
    const safe = args.map((value) => redact(value, [...this.secrets])).join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${safe.slice(0, 16_384)}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      this._rotate(bytes);
      fs.appendFileSync(this._path(), line, { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }

  installConsole() {
    const originals = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    console.log = (...args) => { originals.log(...args); this.write('INFO', args); };
    console.warn = (...args) => { originals.warn(...args); this.write('WARN', args); };
    console.error = (...args) => { originals.error(...args); this.write('ERROR', args); };
    return () => Object.assign(console, originals);
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  SafeLogger,
  redact,
};
