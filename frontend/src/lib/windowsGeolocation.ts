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
          const latitude = Number(position.coords.latitude);
          const longitude = Number(position.coords.longitude);
          const accuracy = Number(position.coords.accuracy);
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
            timestamp: new Date(position.timestamp || Date.now()).toISOString(),
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
