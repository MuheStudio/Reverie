import type { useReverieWS } from '@/hooks/useReverieWS';

/** Existing archive/settings operations; ownership stays with the window session. */
export type ArchiveClient = Pick<ReturnType<typeof useReverieWS>,
  'connState' | 'personaScope' | 'persona' | 'worldbookDiagnostics' | 'settingsSnapshot' |
  'apiBudget' | 'localMode' | 'request' | 'send' | 'subscribe' |
  'refreshApiBudget' | 'refreshDiary' | 'refreshTimeline'> & { viewActive?: boolean };
