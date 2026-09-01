'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  ENDPOINT,
  FIELD_MASK,
  MAX_RESPONSE_BYTES,
  searchGooglePlaces,
} = require('./google-places.cjs');

function transport({ statusCode = 200, responseBody = '{"places":[]}', redirect = false } = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.setTimeout = (_ms, handler) => { req.timeoutHandler = handler; };
    req.write = (chunk) => { body += chunk; };
    req.end = (chunk = '') => {
      body += chunk;
      calls.push({ url, options, body });
      const response = new EventEmitter();
      response.statusCode = redirect ? 302 : statusCode;
      response.resume = () => {};
      callback(response);
      if (!redirect) {
        response.emit('data', Buffer.from(responseBody));
        response.emit('end');
      }
    };
    req.destroy = () => {};
    return req;
  };
  return { calls, request };
}

const input = {
  apiKey: 'google-canary', latitude: 39.9, longitude: 116.4, radiusM: 1200,
  placeTypes: ['restaurant', 'cafe', 'dessert', 'convenience', 'snacks'],
};

test('Google Nearby Search uses one fixed POST, exact field mask, bounded result count and body coordinates', async () => {
  const fake = transport({ responseBody: JSON.stringify({ places: [{
    displayName: { text: 'Cafe' }, primaryType: 'cafe', attributions: [{ displayName: 'Owner' }],
  }] }) });
  const result = await searchGooglePlaces(input, { request: fake.request });
  const call = fake.calls[0];
  assert.equal(fake.calls.length, 1);
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['X-Goog-FieldMask'], FIELD_MASK);
  assert.equal(FIELD_MASK.includes('*'), false);
  assert.equal(call.url.includes('39.9'), false);
  assert.equal(call.url.includes('116.4'), false);
  assert.equal(call.url.includes('google-canary'), false);
  assert.deepEqual(JSON.parse(call.body), {
    includedTypes: ['restaurant', 'cafe', 'dessert_shop', 'convenience_store', 'snack_bar'],
    maxResultCount: 8,
    locationRestriction: { circle: { center: { latitude: 39.9, longitude: 116.4 }, radius: 1200 } },
    rankPreference: 'DISTANCE',
  });
  assert.deepEqual(result.items, [{ name: 'Cafe', primaryType: 'cafe', attributions: ['Owner'] }]);
});

test('Google transport rejects redirects, does not retry, and returns redacted stable errors', async () => {
  const fake = transport({ redirect: true });
  const result = await searchGooglePlaces(input, { request: fake.request });
  assert.deepEqual(result, { ok: false, code: 'unavailable', provider: 'Google', items: [] });
  assert.equal(fake.calls.length, 1);
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test('Google transport bounds response bodies', async () => {
  const fake = transport({ responseBody: 'x'.repeat(MAX_RESPONSE_BYTES + 1) });
  assert.equal((await searchGooglePlaces(input, { request: fake.request })).code, 'unavailable');
  assert.equal(fake.calls.length, 1);
});

test('Google transport enforces a bounded timeout without retrying', async () => {
  let requestCount = 0;
  let timeoutMs = 0;
  const request = () => {
    requestCount += 1;
    const req = new EventEmitter();
    req.setTimeout = (value, handler) => {
      timeoutMs = value;
      req.timeoutHandler = handler;
    };
    req.end = () => req.timeoutHandler();
    req.destroy = () => {};
    return req;
  };

  const result = await searchGooglePlaces(input, { request, timeoutMs: 25 });
  assert.deepEqual(result, { ok: false, code: 'timeout', provider: 'Google', items: [] });
  assert.equal(timeoutMs, 25);
  assert.equal(requestCount, 1);
});
