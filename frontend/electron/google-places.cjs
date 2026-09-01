'use strict';

const crypto = require('crypto');
const https = require('https');

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const ENDPOINT_BINDING = crypto.createHash('sha256').update(ENDPOINT).digest('hex');
const FIELD_MASK = 'places.displayName.text,places.primaryType,places.attributions';
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;
const TYPE_MAP = Object.freeze({
  restaurant: 'restaurant',
  cafe: 'cafe',
  bakery: 'bakery',
  dessert: 'dessert_shop',
  convenience: 'convenience_store',
  snacks: 'snack_bar',
  supermarket: 'supermarket',
});

function failure(code) {
  return { ok: false, code, provider: 'Google', items: [] };
}

function normalizeAttributions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item) => {
    if (typeof item === 'string') return item.slice(0, 256);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
    const label = typeof item.displayName === 'string' ? item.displayName : item.provider;
    return typeof label === 'string' ? label.slice(0, 256) : '';
  }).filter(Boolean);
}

function parseResponse(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return failure('unavailable');
  }
  if (!Array.isArray(payload?.places)) return { ok: true, code: 'ok', provider: 'Google', items: [] };
  const items = payload.places.slice(0, 8).map((place) => ({
    name: typeof place?.displayName?.text === 'string'
      ? place.displayName.text.slice(0, 512)
      : '',
    primaryType: typeof place?.primaryType === 'string' ? place.primaryType.slice(0, 128) : '',
    attributions: normalizeAttributions(place?.attributions),
  })).filter((item) => item.name);
  return { ok: true, code: 'ok', provider: 'Google', items };
}

function searchGooglePlaces(input, options = {}) {
  const request = options.request || https.request;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const includedTypes = [...new Set(input.placeTypes)].map((type) => TYPE_MAP[type]);
  const body = JSON.stringify({
    includedTypes,
    maxResultCount: 8,
    locationRestriction: {
      circle: {
        center: { latitude: input.latitude, longitude: input.longitude },
        radius: input.radiusM,
      },
    },
    rankPreference: 'DISTANCE',
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = request(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Goog-Api-Key': input.apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
      }, (response) => {
        const status = Number(response.statusCode || 0);
        if (status >= 300 && status < 400) {
          response.resume();
          finish(failure('unavailable'));
          req.destroy();
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(failure('unavailable'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (status === 429) return finish(failure('quota'));
          if (status === 401 || status === 403) return finish(failure('key-required'));
          if (status < 200 || status >= 300) return finish(failure('unavailable'));
          return finish(parseResponse(Buffer.concat(chunks).toString('utf8')));
        });
        response.on('error', () => finish(failure('unavailable')));
      });
      req.setTimeout(timeoutMs, () => {
        finish(failure('timeout'));
        req.destroy();
      });
      req.on('error', () => finish(failure('unavailable')));
      req.end(body);
    } catch {
      finish(failure('unavailable'));
    }
  });
}

module.exports = {
  ENDPOINT,
  ENDPOINT_BINDING,
  FIELD_MASK,
  MAX_RESPONSE_BYTES,
  TIMEOUT_MS,
  TYPE_MAP,
  searchGooglePlaces,
};
