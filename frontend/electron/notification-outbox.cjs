'use strict';

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

module.exports = { parseNotificationTimestamp };
