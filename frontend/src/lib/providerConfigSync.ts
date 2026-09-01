/**
 * Authoritative provider configuration sync for the settings panels.
 *
 * The Electron provider store only answers once the Python bridge has
 * completed its handshake, and both settings panels mount before that. A
 * bounded retry loop keeps the panels from staying frozen on their defaults
 * for the whole session when the first read loses the race with bridge boot.
 *
 * Saved values are merged field by field and never overwrite what the user
 * has already typed — including the API key fields, which the authoritative
 * store never returns.
 */

import { useEffect, useRef, useState } from 'react';

export type CredentialStorageMode = 'persistent' | 'session';

export const PROVIDER_CONFIG_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

export type SavedProviderFields = {
  provider: string;
  baseUrl: string;
  model: string;
  customProviderName: string;
};

export const SAVED_PROVIDER_FIELDS = [
  'provider',
  'baseUrl',
  'model',
  'customProviderName',
] as const;

export function credentialStorageModeFromStatus(
  status: CredentialStatus | null | undefined,
): CredentialStorageMode {
  if (status?.llm.sessionOnly === true || status?.persistentAvailable === false) {
    return 'session';
  }
  return 'persistent';
}

export function useCredentialStorageMode(): {
  credentialMode: CredentialStorageMode;
  setCredentialMode: (mode: CredentialStorageMode) => void;
  credentialStatus: CredentialStatus | null;
} {
  const [credentialMode, setMode] = useState<CredentialStorageMode>('persistent');
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const modeTouchedRef = useRef(false);

  useEffect(() => {
    const api = window.electronAPI?.credentials;
    if (!api) return undefined;
    const applyStatus = (status: CredentialStatus) => {
      setCredentialStatus(status);
      const hasCredential = status.llm.hasApiKey || status.llm.hasCustomHeaders;
      if (status.persistentAvailable === false || hasCredential || !modeTouchedRef.current) {
        setMode(credentialStorageModeFromStatus(status));
      }
    };
    void api.status().then(applyStatus).catch(() => undefined);
    return api.onChanged(applyStatus);
  }, []);

  return {
    credentialMode,
    setCredentialMode: (mode) => {
      modeTouchedRef.current = true;
      setMode(mode);
    },
    credentialStatus,
  };
}

/**
 * Merge the authoritative snapshot into the current draft, skipping every
 * field the user has touched and every empty saved value. Returns the same
 * object when nothing changes so React can bail out of the state update.
 */
export function mergeSavedDraft<Draft extends SavedProviderFields>(
  current: Draft,
  saved: Partial<SavedProviderFields> | null | undefined,
  touched: ReadonlySet<string>,
): Draft {
  if (!saved) return current;
  let merged = current;
  for (const field of SAVED_PROVIDER_FIELDS) {
    if (touched.has(field)) continue;
    const value = saved[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (merged[field] === value) continue;
    merged = { ...merged, [field]: value };
  }
  return merged;
}

/**
 * Poll the authoritative provider store until it answers. `load` may reject
 * (channel unavailable) or resolve to null/undefined (no saved config yet);
 * both schedule the next retry. After the final delay `onUnavailable` fires
 * once and the loop stops. The first attempt runs immediately.
 */
export function useAuthoritativeProviderConfig(options: {
  load: () => Promise<unknown>;
  onLoaded: (value: unknown) => void;
  onUnavailable: () => void;
}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attemptLoad = (attempt: number) => {
      optionsRef.current.load()
        .then((value) => {
          if (disposed) return;
          if (value === null || value === undefined) {
            schedule(attempt);
            return;
          }
          optionsRef.current.onLoaded(value);
        })
        .catch(() => {
          if (disposed) return;
          schedule(attempt);
        });
    };
    const schedule = (attempt: number) => {
      if (attempt >= PROVIDER_CONFIG_RETRY_DELAYS_MS.length) {
        optionsRef.current.onUnavailable();
        return;
      }
      timer = setTimeout(() => {
        void attemptLoad(attempt + 1);
      }, PROVIDER_CONFIG_RETRY_DELAYS_MS[attempt]);
    };
    attemptLoad(0);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
}
