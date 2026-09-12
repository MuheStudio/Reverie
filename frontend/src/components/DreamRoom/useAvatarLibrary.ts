import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { translate } from '@/i18';

interface AvatarLibraryState {
  records: AvatarRecord[];
  activeId: string | null;
  runtime?: AvatarListResult['runtime'];
}

const EMPTY_LIBRARY: AvatarLibraryState = { records: [], activeId: null };

function normalizeLibrary(value: AvatarListResult | AvatarRecord[]): AvatarLibraryState {
  if (Array.isArray(value)) {
    return { records: value, activeId: null };
  }
  return {
    records: Array.isArray(value.records) ? value.records : [],
    activeId: typeof value.activeId === 'string' ? value.activeId : null,
    runtime: value.runtime,
  };
}

export function useAvatarLibrary() {
  const api = window.electronAPI?.avatar;
  const [library, setLibrary] = useState<AvatarLibraryState>(EMPTY_LIBRARY);
  const [candidate, setCandidate] = useState<AvatarImportCandidate | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidateRef = useRef<AvatarImportCandidate | null>(null);

  useEffect(() => {
    candidateRef.current = candidate;
  }, [candidate]);

  const refresh = useCallback(async () => {
    if (!api) {
      setLibrary(EMPTY_LIBRARY);
      setError(translate('dream.avatarServiceUnavailable'));
      return;
    }
    try {
      setLibrary(normalizeLibrary(await api.list()));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarLibraryReadFailed'));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    return api?.onChanged((next) => setLibrary(normalizeLibrary(next)));
  }, [api, refresh]);

  useEffect(() => () => {
    const pending = candidateRef.current;
    if (pending) void api?.discardImport(pending.importId).catch(() => undefined);
  }, [api]);

  const beginImport = useCallback(async () => {
    if (!api || busy || candidate) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.beginImport();
      setCandidate(next);
      setPreviewState(next ? 'loading' : 'idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarInspectionFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, busy, candidate]);

  const beginImportFolder = useCallback(async () => {
    if (!api || busy || candidate) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.beginImportFolder();
      setCandidate(next);
      setPreviewState(next ? 'loading' : 'idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarInspectionFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, busy, candidate]);

  const beginImportLive2DFile = useCallback(async () => {
    if (!api?.beginImportLive2DFile || busy || candidate) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.beginImportLive2DFile();
      setCandidate(next);
      setPreviewState(next ? 'loading' : 'idle');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarInspectionFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, busy, candidate]);

  const confirmPreview = useCallback(async (detected: AvatarDetected) => {
    if (!api || !candidate || busy || previewState === 'ready') return previewState === 'ready';
    try {
      const result = await api.confirmPreview(candidate.importId, {
        detected,
        capabilities: {
          expressionPlayback: detected.expressions.length > 0,
          embeddedAnimationPlayback: detected.animationClips.length > 0,
        },
      });
      if (!result.ready) return false;
      setPreviewState('ready');
      setError('');
      return true;
    } catch (reason) {
      setPreviewState('error');
      setError(reason instanceof Error ? reason.message : translate('dream.avatarImportFailed'));
      return false;
    }
  }, [api, busy, candidate, previewState]);

  const failPreview = useCallback(async (message?: string) => {
    if (!api || !candidate) return;
    const failed = candidate;
    setCandidate(null);
    setPreviewState('error');
    setError(message || translate('dream.previewFailed'));
    try {
      await api.failPreview(failed.importId);
    } catch {
      setError(translate('dream.avatarDiscardFailed'));
    }
  }, [api, candidate]);

  const cancelImport = useCallback(async () => {
    if (!api || !candidate || busy) return;
    const cancelled = candidate;
    setCandidate(null);
    setPreviewState('idle');
    setError('');
    try {
      await api.discardImport(cancelled.importId);
    } catch {
      setError(translate('dream.avatarDiscardFailed'));
    }
  }, [api, busy, candidate]);

  const commitImport = useCallback(async (confirmation: AvatarImportConfirmation) => {
    if (!api || !candidate || busy || previewState !== 'ready') return false;
    setBusy(true);
    setError('');
    try {
      const record = await api.commitImport(candidate.importId, confirmation);
      setCandidate(null);
      setPreviewState('idle');
      await api.setActive(record.id);
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarImportFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, busy, candidate, previewState, refresh]);

  const setActive = useCallback(async (id: string | null) => {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.setActive(id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarSwitchFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, busy, refresh]);

  const remove = useCallback(async (id: string) => {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.remove(id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarRemoveFailed'));
    } finally {
      setBusy(false);
    }
  }, [api, busy, refresh]);

  const setMapping = useCallback(async (
    id: string,
    category: 'expression' | 'action',
    key: string,
    target: string | null,
  ) => {
    if (!api || busy) return false;
    setBusy(true);
    setError('');
    try {
      await api.setMapping(id, category, key, target);
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarImportFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, busy, refresh]);

  const addMotion = useCallback(async (id: string) => {
    if (!api || busy) return false;
    setBusy(true);
    setError('');
    try {
      const motion = await api.addMotion(id);
      if (motion) await refresh();
      return Boolean(motion);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarImportFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, busy, refresh]);

  const removeMotion = useCallback(async (id: string, motionId: string) => {
    if (!api || busy) return false;
    setBusy(true);
    setError('');
    try {
      await api.removeMotion(id, motionId);
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : translate('dream.avatarRemoveFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, busy, refresh]);

  const activeAvatar = useMemo(
    () => library.records.find((record) => record.id === library.activeId) ?? null,
    [library.activeId, library.records],
  );

  return {
    available: Boolean(api),
    ...library,
    activeAvatar,
    candidate,
    previewState,
    busy,
    error,
    refresh,
    beginImport,
    beginImportFolder,
    beginImportLive2DFile,
    confirmPreview,
    failPreview,
    commitImport,
    cancelImport,
    setActive,
    remove,
    setMapping,
    addMotion,
    removeMotion,
  };
}
