import { WSMsgType, type WSRequestOptions } from '@/hooks/useReverieWS';
import {
  createOnboardingPreferences,
  type MemoryRetentionYears,
  type OnboardingPreferences,
} from '@/lib/reverieArchive';

interface SettingsRequestClient {
  request<T = unknown>(
    type: string,
    payload: unknown,
    options: WSRequestOptions,
  ): Promise<T>;
}

export async function confirmMemoryRetention(
  client: SettingsRequestClient,
  years: MemoryRetentionYears,
): Promise<OnboardingPreferences> {
  const preferences = createOnboardingPreferences(years);
  const response = await client.request<{ ok?: boolean; error?: string }>(
    WSMsgType.SETTINGS_UPDATE,
    {
      section: 'memory',
      retention_days: preferences.memoryRetentionDays,
    },
    {
      expectedType: WSMsgType.SETTINGS_UPDATE_RESULT,
      timeout: 8_000,
    },
  );
  if (response?.ok !== true) {
    throw new Error(response?.error || 'retention update was rejected');
  }
  return preferences;
}
