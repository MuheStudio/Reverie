import { describe, expect, it } from 'vitest';
import { requestWindowsBrowserLocation } from '../windowsGeolocation';

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
});
