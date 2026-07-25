import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Check, MessageCircle, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReverieWS, WSMsgType } from '@/hooks/useReverieWS';
import { type MemoryRetentionYears } from '@/lib/reverieArchive';
import { confirmMemoryRetention } from './retentionSetup';
import styles from './FirstRunGuide.module.scss';

type ReverieWS = ReturnType<typeof useReverieWS>;

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
}

export default function FirstRunGuide({ ws, onComplete }: { ws: ReverieWS; onComplete: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2>(1);
  const [years, setYears] = useState<MemoryRetentionYears>(2);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const complete = useCallback(async (persistRetention: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      if (persistRetention) await confirmMemoryRetention(ws, years);
      const response = await ws.request<{ ok?: boolean; error?: string }>(
        WSMsgType.SETTINGS_UPDATE,
        { section: 'onboarding', completed: true },
        { expectedType: WSMsgType.SETTINGS_UPDATE_RESULT, timeout: 8_000 },
      );
      if (response.ok !== true) throw new Error(response.error || 'onboarding update was rejected');
      onComplete();
    } catch {
      setSaveError(t('dream.guideSaveFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onComplete, t, ws, years]);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-dream-shell-content]');
    shell?.setAttribute('inert', '');
    const dialog = dialogRef.current;
    if (dialog) focusable(dialog)[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void complete(false);
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const nodes = focusable(dialog);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      shell?.removeAttribute('inert');
      dialog?.removeEventListener('keydown', onKeyDown);
    };
  }, [complete]);

  return (
    <div className={styles.layer}>
      <section
        ref={dialogRef}
        className={styles.guide}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <span>0{step} / 02</span>
          <h1 id={titleId}>{t('dream.guideTitle')}</h1>
        </header>
        {step === 1 ? (
          <>
            <div className={styles.copy}>
              <strong>{t('dream.guideRetention')}</strong>
              <p>{t('dream.guideRetentionDetail')}</p>
            </div>
            <div className={styles.retention} role="radiogroup" aria-label={t('dream.guideRetention')}>
              {([1, 2, 3] as MemoryRetentionYears[]).map((value) => (
                <button
                  type="button"
                  role="radio"
                  disabled={saving}
                  aria-checked={years === value}
                  data-active={years === value}
                  key={value}
                  onClick={() => setYears(value)}
                >
                  {t('dream.years', { count: value })}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className={styles.copy}>
              <strong>{t('dream.guideTour')}</strong>
              <p>{t('dream.guideTourDetail')}</p>
            </div>
            <div className={styles.tour} aria-label={t('dream.guideTour')}>
              <span><MessageCircle size={20} /> {t('dream.chat')}</span>
              <span><BookOpen size={20} /> {t('dream.diary')}</span>
              <span><Smartphone size={20} /> {t('dream.phone')}</span>
            </div>
          </>
        )}
        {saveError && <p className={styles.error} role="alert">{saveError}</p>}
        <footer>
          <button type="button" disabled={saving} onClick={() => void complete(false)}>
            {t('dream.skip')}
          </button>
          {step === 1 ? (
            <button type="button" disabled={saving} onClick={() => setStep(2)}>{t('dream.next')}</button>
          ) : (
            <button type="button" disabled={saving} onClick={() => void complete(true)}>
              <Check size={16} /> {saving ? t('dream.guideSaving') : t('dream.finish')}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
