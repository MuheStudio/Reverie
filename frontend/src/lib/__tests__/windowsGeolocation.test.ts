import { describe, expect, it } from 'vitest';
import {
  coarseSystemLocationMemoryPayload,
  immersionNearbyPayload,
  requestWindowsBrowserLocation,
} from '../windowsGeolocation';

describe('Windows browser geolocation adapter', () => {
  it('returns a validated operating-system position', async () => {
    const geolocation = {
      getCurrentPosition(success: PositionCallback) {
        success({
          coords: {
            latitude: 31.2304,
            longitude: 121.4737,
            accuracy: 35,
          },
          timestamp: Date.parse('2026-07-25T00:00:00Z'),
        } as GeolocationPosition);
      },
    };
    await expect(requestWindowsBrowserLocation(geolocation)).resolves.toMatchObject({
      ok: true,
      latitude: 31.2304,
      longitude: 121.4737,
      source: 'windows-browser-geolocation',
    });
  });

  it.each([
    [1, 'REVERIE_LOCATION_PERMISSION_DENIED'],
    [2, 'REVERIE_LOCATION_DEVICE_UNAVAILABLE'],
    [3, 'REVERIE_LOCATION_TIMEOUT'],
  ])('maps browser failure %s without inventing a coordinate', async (code, expected) => {
    const geolocation = {
      getCurrentPosition(_success: PositionCallback, failure: PositionErrorCallback) {
        failure({ code, message: 'must not cross the UI boundary' } as GeolocationPositionError);
      },
    };
    await expect(requestWindowsBrowserLocation(geolocation)).resolves.toMatchObject({
      ok: false,
      code: expected,
    });
  });

  it('rejects malformed native coordinates', async () => {
    const geolocation = {
      getCurrentPosition(success: PositionCallback) {
        success({
          coords: { latitude: 999, longitude: 0, accuracy: 1 },
          timestamp: Date.now(),
        } as GeolocationPosition);
      },
    };
    await expect(requestWindowsBrowserLocation(geolocation)).resolves.toMatchObject({
      ok: false,
      code: 'REVERIE_LOCATION_NATIVE_FAILURE',
    });
  });

  it.each([
    { latitude: Number.NaN, longitude: 0, accuracy: 1 },
    { latitude: 0, longitude: -181, accuracy: 1 },
    { latitude: 0, longitude: 0, accuracy: -1 },
    { latitude: 0, longitude: 0, accuracy: Number.POSITIVE_INFINITY },
    { latitude: null, longitude: 0, accuracy: 1 },
    { latitude: 0, longitude: 0, accuracy: '25' },
  ])('rejects bad coordinate or accuracy data without projecting it', async (coords) => {
    const geolocation = {
      getCurrentPosition(success: PositionCallback) {
        success({ coords, timestamp: Date.now() } as GeolocationPosition);
      },
    };
    const result = await requestWindowsBrowserLocation(geolocation);
    expect(result).toEqual({
      ok: false,
      code: 'REVERIE_LOCATION_NATIVE_FAILURE',
      status: 'InvalidCoordinate',
      source: 'windows-browser-geolocation',
    });
    expect(result).not.toHaveProperty('latitude');
    expect(result).not.toHaveProperty('longitude');
  });

  it('builds the exact strict Protocol V4 nearby payload without accuracy metadata', () => {
    const payload = immersionNearbyPayload({
      ok: true,
      code: 'REVERIE_LOCATION_OK',
      latitude: 31.2304,
      longitude: 121.4737,
      accuracy: 35,
      timestamp: '2026-07-25T00:00:00.000Z',
      source: 'windows-browser-geolocation',
    }, 1200);

    expect(payload).toEqual({
      latitude: 31.2304,
      longitude: 121.4737,
      radius_m: 1200,
      place_types: ['restaurant', 'shop', 'cafe', 'supermarket', 'park'],
    });
    expect(payload).not.toHaveProperty('accuracy_m');
  });

  it.each([
    [1_000, 'neighborhood-scale'],
    [1_001, 'city-scale'],
    [10_000, 'city-scale'],
    [10_001, 'regional-scale'],
  ])('projects accuracy %s to only the closed coarse enum %s', (accuracy, expected) => {
    const payload = coarseSystemLocationMemoryPayload({
      ok: true,
      code: 'REVERIE_LOCATION_OK',
      latitude: 51.5074,
      longitude: -0.1278,
      accuracy,
      timestamp: '2026-07-25T00:00:00.000Z',
      source: 'windows-browser-geolocation',
    }, Date.parse('2026-07-25T00:05:00.000Z'));

    expect(payload).toEqual({
      kind: 'coarse_system_location',
      neighborhood_scale: expected,
      user_confirmed: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(/51\.5074|-0\.1278|1000|1001|10000|10001|2026|google|amap/i);
  });

  it('rejects stale OS results instead of retaining their accuracy or timestamp', () => {
    const payload = coarseSystemLocationMemoryPayload({
      ok: true,
      code: 'REVERIE_LOCATION_OK',
      latitude: 1,
      longitude: 2,
      accuracy: 50,
      timestamp: '2026-07-25T00:00:00.000Z',
      source: 'windows-browser-geolocation',
    }, Date.parse('2026-07-25T00:10:00.001Z'));
    expect(payload).toBeNull();
  });
});
