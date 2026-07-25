import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ImagePlus, Trash2, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AvatarStage, {
  AVATAR_ACTION_KEYS,
  AVATAR_EXPRESSION_KEYS,
  type AvatarDetectedCapabilities,
  type AvatarExpressionKey,
  type CharacterActivity,
} from './AvatarStage';
import { useAvatarLibrary } from './useAvatarLibrary';
import defaultYumiPreview from '@/assets/dreamroom/yumi-default-transparent.png';
import styles from './CharacterStage.module.scss';

interface CharacterStageProps {
  personaName: string;
  identityLine: string;
  activity: CharacterActivity;
}

function focusableNodes(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((node) => !node.hasAttribute('hidden'));
}

export default function CharacterStage({
  personaName,
  identityLine,
  activity,
}: CharacterStageProps) {
  const { t } = useTranslation();
  const avatars = useAvatarLibrary();
  const [managerOpen, setManagerOpen] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [warningsAccepted, setWarningsAccepted] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const managerButtonRef = useRef<HTMLButtonElement | null>(null);
  const previewDetectedRef = useRef<AvatarDetected>({ animationClips: [], expressions: [] });
  const [previewDetected, setPreviewDetected] = useState<AvatarDetectedCapabilities | null>(null);
  const [activeDetected, setActiveDetected] = useState<AvatarDetectedCapabilities | null>(null);
  const [previewAction, setPreviewAction] = useState<CharacterActivity | null>(null);
  const [previewExpression, setPreviewExpression] = useState<AvatarExpressionKey | null>(null);
  const previewResetTimer = useRef<number>();
  const titleId = useId();
  const previewAvatar = useMemo<AvatarRecord | null>(() => {
    const candidate = avatars.candidate;
    if (!candidate) return null;
    return {
      id: `preview:${candidate.importId}`,
      name: candidate.name,
      kind: candidate.preview.format,
      entryUrl: candidate.preview.url,
      status: 'ready',
      warnings: candidate.warnings,
      capabilities: candidate.preview.capabilities,
    };
  }, [avatars.candidate]);

  const closeManager = useCallback(() => {
    if (avatars.candidate) void avatars.cancelImport();
    setManagerOpen(false);
  }, [avatars.cancelImport, avatars.candidate]);

  const handlePreviewCapabilities = useCallback((capabilities: AvatarDetectedCapabilities) => {
    previewDetectedRef.current = {
      animationClips: capabilities.animationClips,
      expressions: capabilities.expressions,
    };
    setPreviewDetected(capabilities);
  }, []);

  const handlePreviewStatus = useCallback((status: 'empty' | 'loading' | 'ready' | 'paused' | 'error') => {
    if (!avatars.candidate) return;
    if (status === 'ready') {
      void avatars.confirmPreview(previewDetectedRef.current).then((confirmed) => {
        if (!confirmed) void avatars.failPreview(t('dream.previewFailed'));
      });
    } else if (status === 'error') {
      void avatars.failPreview(t('dream.previewFailed'));
    }
  }, [avatars.candidate, avatars.confirmPreview, avatars.failPreview, t]);

  useEffect(() => {
    if (!avatars.candidate || avatars.previewState === 'ready') return undefined;
    const expiresIn = Date.parse(avatars.candidate.preview.expiresAtUtc) - Date.now();
    const timeout = Math.max(0, Math.min(15_000, Number.isFinite(expiresIn) ? expiresIn : 15_000));
    const timer = window.setTimeout(() => {
      void avatars.failPreview(t('dream.previewTimeout'));
    }, timeout);
    return () => window.clearTimeout(timer);
  }, [avatars.candidate, avatars.failPreview, avatars.previewState, t]);

  useEffect(() => {
    if (!managerOpen) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const first = focusableNodes(dialog)[0];
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeManager();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusableNodes(dialog);
      if (!nodes.length) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      managerButtonRef.current?.focus();
    };
  }, [closeManager, managerOpen]);

  useEffect(() => {
    setRightsConfirmed(false);
    setWarningsAccepted(false);
    setPreviewDetected(null);
    setPreviewAction(null);
    setPreviewExpression(null);
    window.clearTimeout(previewResetTimer.current);
    previewDetectedRef.current = { animationClips: [], expressions: [] };
  }, [avatars.candidate?.importId]);

  useEffect(() => {
    setActiveDetected(null);
    setPreviewAction(null);
    setPreviewExpression(null);
    window.clearTimeout(previewResetTimer.current);
  }, [avatars.activeAvatar?.id]);

  const warningRequired = Boolean(avatars.candidate?.warnings.length);
  const previewForMoment = (action: CharacterActivity | null, expression: AvatarExpressionKey | null) => {
    window.clearTimeout(previewResetTimer.current);
    setPreviewAction(action);
    setPreviewExpression(expression);
    previewResetTimer.current = window.setTimeout(() => {
      setPreviewAction(null);
      setPreviewExpression(null);
    }, 2_500);
  };

  useEffect(() => () => window.clearTimeout(previewResetTimer.current), []);

  useEffect(() => {
    const openFromArchive = (event: Event) => {
      setManagerOpen(true);
      const start = (event as CustomEvent<{ start?: 'file' | 'folder' }>).detail?.start;
      if (start === 'folder') void avatars.beginImportFolder();
      if (start === 'file') void avatars.beginImport();
    };
    window.addEventListener('reverie:open-avatar-manager', openFromArchive);
    return () => window.removeEventListener('reverie:open-avatar-manager', openFromArchive);
  }, [avatars.beginImport, avatars.beginImportFolder]);

  return (
    <section className={styles.characterStage} data-module="character-stage">
      {!avatars.candidate && (
        avatars.activeAvatar ? (
          <AvatarStage
            avatar={avatars.activeAvatar}
            live2dRuntime={avatars.runtime}
            activity={previewAction || activity}
            expressionOverride={previewExpression}
            onCapabilitiesDetected={setActiveDetected}
          />
        ) : (
          <div
            className={styles.defaultAvatar}
            data-character-activity={previewAction || activity}
            role="img"
            aria-label={t('dream.defaultYumiPreview')}
          >
            <img src={defaultYumiPreview} alt="" />
            <small>{t('dream.defaultYumiStatic')}</small>
          </div>
        )
      )}
      <header className={styles.identity}>
        <div>
          <strong>{personaName}</strong>
          <span>{identityLine}</span>
        </div>
        <button
          ref={managerButtonRef}
          type="button"
          onClick={() => setManagerOpen(true)}
          aria-haspopup="dialog"
        >
          <UserRound size={17} />
          {t('dream.avatar')}
        </button>
      </header>

      {managerOpen && (
        <div className={styles.dialogLayer}>
          <button
            type="button"
            className={styles.scrim}
            aria-label={t('dream.closeAvatarManager')}
            onClick={closeManager}
          />
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <header>
              <div>
                <strong id={titleId}>{t('dream.localAvatars')}</strong>
                <small>{t('dream.avatarPrivacy')}</small>
              </div>
              <button type="button" onClick={closeManager} aria-label={t('dream.close')}>
                <X size={18} />
              </button>
            </header>

            {!avatars.available && (
              <p className={styles.error} role="status">{t('dream.avatarServiceUnavailable')}</p>
            )}
            {avatars.error && <p className={styles.error} role="alert">{avatars.error}</p>}

            <div className={styles.avatarList}>
              {avatars.records.map((record) => (
                <div key={record.id} className={styles.avatarRow} data-active={record.id === avatars.activeId}>
                  <button
                    type="button"
                    disabled={avatars.busy || record.status !== 'ready'}
                    onClick={() => void avatars.setActive(record.id)}
                  >
                    <span>{record.kind.toUpperCase()}</span>
                    <strong>{record.name}</strong>
                    <small>{record.id === avatars.activeId ? t('dream.avatarActive') : record.status}</small>
                  </button>
                  <button
                    type="button"
                    aria-label={t('dream.removeAvatar', { name: record.name })}
                    disabled={avatars.busy || record.id === avatars.activeId}
                    onClick={() => void avatars.remove(record.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {!avatars.records.length && <p>{t('dream.avatarEmpty')}</p>}
            </div>

            {avatars.activeAvatar && activeDetected && (
              <section className={styles.mappingEditor}>
                <strong>{t('dream.avatarMapping')}</strong>
                <small>{t('dream.avatarMappingDetail')}</small>
                {AVATAR_ACTION_KEYS.map((key) => {
                  const mapped = avatars.activeAvatar?.mapping?.actions?.[key];
                  const automatic = activeDetected.actionMatches[key];
                  const value = mapped || (automatic ? `clip:${automatic}` : '');
                  return (
                    <div key={key}>
                      <label>
                        <span>{key}</span>
                        <select
                          value={value}
                          disabled={avatars.busy || !activeDetected.animationClips.length}
                          onChange={(event) => void avatars.setMapping(
                            avatars.activeAvatar!.id,
                            'action',
                            key,
                            event.target.value || null,
                          )}
                        >
                          <option value="">{t('dream.avatarFallback')}</option>
                          {activeDetected.animationClips.map((clip) => (
                            <option key={clip} value={`clip:${clip}`}>{clip}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={!value}
                        onClick={() => previewForMoment(key, null)}
                      >
                        {t('dream.preview')}
                      </button>
                    </div>
                  );
                })}
                {AVATAR_EXPRESSION_KEYS.map((key) => {
                  const mapped = avatars.activeAvatar?.mapping?.expressions?.[key];
                  const automatic = activeDetected.expressionMatches[key];
                  const value = mapped || (automatic ? `expression:${automatic}` : '');
                  return (
                    <div key={key}>
                      <label>
                        <span>{key}</span>
                        <select
                          value={value}
                          disabled={avatars.busy || !activeDetected.expressions.length}
                          onChange={(event) => void avatars.setMapping(
                            avatars.activeAvatar!.id,
                            'expression',
                            key,
                            event.target.value || null,
                          )}
                        >
                          <option value="">{t('dream.avatarFallback')}</option>
                          {activeDetected.expressions.map((expression) => (
                            <option key={expression} value={`expression:${expression}`}>{expression}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={!value}
                        onClick={() => previewForMoment(null, key)}
                      >
                        {t('dream.preview')}
                      </button>
                    </div>
                  );
                })}
                {avatars.activeAvatar.kind === 'vrm' && (
                  <div className={styles.motionLibrary}>
                    <button
                      type="button"
                      disabled={avatars.busy || avatars.activeAvatar.capabilities?.vrmaImport !== true}
                      onClick={() => void avatars.addMotion(avatars.activeAvatar!.id)}
                    >
                      {t('dream.addVrma')}
                    </button>
                    <small>{t('dream.vrmaPlaybackUnavailable')}</small>
                    {avatars.activeAvatar.motions?.map((motion) => (
                      <span key={motion.id}>
                        {motion.name}
                        <button
                          type="button"
                          aria-label={t('dream.removeMotion', { name: motion.name })}
                          onClick={() => void avatars.removeMotion(avatars.activeAvatar!.id, motion.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </section>
            )}

            {avatars.candidate ? (
              <section className={styles.confirmation}>
                <strong>{t('dream.confirmAvatarImport', { name: avatars.candidate.name })}</strong>
                <small>
                  {t('dream.avatarStructureChecked', { kind: avatars.candidate.kind.toUpperCase() })}
                </small>
                {previewAvatar && (
                  <div className={styles.previewStage}>
                    <AvatarStage
                      avatar={previewAvatar}
                      live2dRuntime={avatars.runtime}
                      activity="idle.default"
                      lowPower
                      onStatusChange={handlePreviewStatus}
                      onCapabilitiesDetected={handlePreviewCapabilities}
                    />
                  </div>
                )}
                <p role="status">
                  {avatars.previewState === 'ready'
                    ? t('dream.previewReady')
                    : t('dream.previewLoading')}
                </p>
                {previewDetected && (
                  <div className={styles.capabilityReport}>
                    <strong>{t('dream.avatarCapabilities')}</strong>
                    <small>
                      {previewDetected.animationClips.length
                        ? previewDetected.animationClips.join(' · ')
                        : t('dream.noDetectedActions')}
                    </small>
                    <small>
                      {previewDetected.expressions.length
                        ? previewDetected.expressions.join(' · ')
                        : t('dream.noDetectedExpressions')}
                    </small>
                    <small>{t('dream.mappingNotVerified')}</small>
                  </div>
                )}
                {warningRequired && (
                  <ul>
                    {avatars.candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={rightsConfirmed}
                    onChange={(event) => setRightsConfirmed(event.target.checked)}
                  />
                  {t('dream.rightsConfirm')}
                </label>
                {warningRequired && (
                  <label>
                    <input
                      type="checkbox"
                      checked={warningsAccepted}
                      onChange={(event) => setWarningsAccepted(event.target.checked)}
                    />
                    {t('dream.warningsConfirm')}
                  </label>
                )}
                <div>
                  <button type="button" onClick={() => void avatars.cancelImport()}>{t('dream.cancel')}</button>
                  <button
                    type="button"
                    disabled={
                      avatars.previewState !== 'ready'
                      || !rightsConfirmed
                      || (warningRequired && !warningsAccepted)
                      || avatars.busy
                    }
                    onClick={() => void avatars.commitImport({
                      rightsConfirmed,
                      warningsAccepted: !warningRequired || warningsAccepted,
                    })}
                  >
                    {t('dream.commitAvatar')}
                  </button>
                </div>
              </section>
            ) : (
              <div className={styles.importActions}>
                <button
                  type="button"
                  className={styles.importButton}
                  disabled={!avatars.available || avatars.busy}
                  onClick={() => void avatars.beginImport()}
                >
                  <ImagePlus size={18} />
                  {avatars.busy ? t('dream.importChecking') : t('dream.importAvatar')}
                </button>
                <button
                  type="button"
                  className={styles.importButton}
                  disabled={!avatars.available || avatars.busy}
                  onClick={() => void avatars.beginImportFolder()}
                >
                  <ImagePlus size={18} />
                  {t('dream.importLive2dFolder')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
