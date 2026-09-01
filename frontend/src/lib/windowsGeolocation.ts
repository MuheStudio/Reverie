export type WindowsBrowserLocation =
  | {
      ok: true;
      code: 'REVERIE_LOCATION_OK';
      latitude: number;
      longitude: number;
      accuracy: number;
      timestamp: string;
      source: 'windows-browser-geolocation';
    }
  | {
      ok: false;
      code:
        | 'REVERIE_LOCATION_PERMISSION_DENIED'
        | 'REVERIE_LOCATION_DEVICE_UNAVAILABLE'
        | 'REVERIE_LOCATION_TIMEOUT'
        | 'REVERIE_LOCATION_NATIVE_FAILURE';
      status: string;
      source: 'windows-browser-geolocation';
    };

type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>;

export type ImmersionNearbyPayload = {
  latitude: number;
  longitude: number;
  radius_m: number;
  place_types: string[];
};

export type SystemLocationScale = 'neighborhood-scale' | 'city-scale' | 'regional-scale';

export type CoarseSystemLocationMemoryPayload = {
  kind: 'coarse_system_location';
  neighborhood_scale: SystemLocationScale;
  user_confirmed: true;
};

const MAX_SYSTEM_LOCATION_AGE_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

function failure(
  code: Extract<WindowsBrowserLocation, { ok: false }>['code'],
  status: string,
): WindowsBrowserLocation {
  return {
    ok: false,
    code,
    status,
    source: 'windows-browser-geolocation',
  };
}

export function requestWindowsBrowserLocation(
  geolocation: GeolocationLike | null | undefined = globalThis.navigator?.geolocation,
): Promise<WindowsBrowserLocation> {
  if (!geolocation) {
    return Promise.resolve(failure(
      'REVERIE_LOCATION_DEVICE_UNAVAILABLE',
      'BrowserGeolocationUnavailable',
    ));
  }
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (position) => {
          const latitude = position.coords.latitude;
          const longitude = position.coords.longitude;
          const accuracy = position.coords.accuracy;
          const timestamp = position.timestamp || Date.now();
          const capturedAt = new Date(timestamp);
          if (
            !Number.isFinite(latitude)
            || latitude < -90
            || latitude > 90
            || !Number.isFinite(longitude)
            || longitude < -180
            || longitude > 180
            || !Number.isFinite(accuracy)
            || accuracy < 0
            || accuracy > 1_000_000
            || !Number.isFinite(timestamp)
            || !Number.isFinite(capturedAt.getTime())
          ) {
            resolve(failure('REVERIE_LOCATION_NATIVE_FAILURE', 'InvalidCoordinate'));
            return;
          }
          resolve({
            ok: true,
            code: 'REVERIE_LOCATION_OK',
            latitude,
            longitude,
            accuracy,
            timestamp: capturedAt.toISOString(),
            source: 'windows-browser-geolocation',
          });
        },
        (error) => {
          const code = Number(error?.code);
          if (code === 1) {
            resolve(failure('REVERIE_LOCATION_PERMISSION_DENIED', 'Denied'));
          } else if (code === 3) {
            resolve(failure('REVERIE_LOCATION_TIMEOUT', 'Timeout'));
          } else {
            resolve(failure('REVERIE_LOCATION_DEVICE_UNAVAILABLE', 'PositionUnavailable'));
          }
        },
        {
          enableHighAccuracy: false,
          maximumAge: 10 * 60 * 1000,
          timeout: 12_000,
        },
      );
    } catch {
      resolve(failure('REVERIE_LOCATION_NATIVE_FAILURE', 'RequestFailed'));
    }
  });
}

export function immersionNearbyPayload(
  position: Extract<WindowsBrowserLocation, { ok: true }>,
  radiusM: number,
): ImmersionNearbyPayload {
  return {
    latitude: position.latitude,
    longitude: position.longitude,
    radius_m: radiusM,
    place_types: ['restaurant', 'shop', 'cafe', 'supermarket', 'park'],
  };
}

export function coarseSystemLocationMemoryPayload(
  position: Extract<WindowsBrowserLocation, { ok: true }>,
  nowMs: number = Date.now(),
): CoarseSystemLocationMemoryPayload | null {
  if (position.source !== 'windows-browser-geolocation') return null;
  const capturedAt = Date.parse(position.timestamp);
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(capturedAt)
    || capturedAt > nowMs + MAX_CLOCK_SKEW_MS
    || nowMs - capturedAt > MAX_SYSTEM_LOCATION_AGE_MS
    || !Number.isFinite(position.accuracy)
    || position.accuracy < 0
    || position.accuracy > 1_000_000
  ) return null;

  const neighborhoodScale: SystemLocationScale = position.accuracy <= 1_000
    ? 'neighborhood-scale'
    : position.accuracy <= 10_000
      ? 'city-scale'
      : 'regional-scale';
  return {
    kind: 'coarse_system_location',
    neighborhood_scale: neighborhoodScale,
    user_confirmed: true,
  };
}
