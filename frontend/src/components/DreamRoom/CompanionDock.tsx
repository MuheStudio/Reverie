import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BookOpen,
  Brain,
  ChevronLeft,
  ChevronRight,
  Flame,
  HardDrive,
  LockKeyhole,
  MessageCircle,
  Settings,
  Smartphone,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { type RelationshipData, useReverieWS } from '@/hooks/useReverieWS';
import ChatPanel from './ChatPanel';
import FocusPanel from './FocusPanel';
import styles from './CompanionDock.module.scss';

type ReverieWS = ReturnType<typeof useReverieWS>;
export type DockTab = 'status' | 'chat' | 'focus';

interface CompanionDockProps {
  ws: ReverieWS;
  personaName: string;
  identityLine: string;
  relationship: RelationshipData;
  relationshipStage: string;
  recentInterest: string;
  onOpenDiary: () => void;
  onOpenPhone: () => void;
  onOpenSettings: () => void;
  onFocusActivityChange: (active: boolean) => void;
  onCompanionAtmosphereChange: (weather: 'none' | 'rain' | 'wind') => void;
  activeTab: DockTab;
  onTabChange: (tab: DockTab) => void;
}

export default function CompanionDock({
  ws,
  personaName,
  identityLine,
  relationship,
  relationshipStage,
  recentInterest,
  onOpenDiary,
  onOpenPhone,
  onOpenSettings,
  onFocusActivityChange,
  onCompanionAtmosphereChange,
  activeTab: tab,
  onTabChange: setTab,
}: CompanionDockProps) {
  const { t } = useTranslation();
  const [compactOpen, setCompactOpen] = useState(true);
  const connected = ws.connState === 'connected';
  const apiUsage = useMemo(() => {
    const requests = ws.apiBudget.requests || 0;
    const tokens = (ws.apiBudget.prompt_tokens || 0) + (ws.apiBudget.completion_tokens || 0);
    return t('dream.apiUsageValue', {
      requests,
      tokens: tokens.toLocaleString(document.documentElement.lang || 'zh-CN'),
    });
  }, [t, ws.apiBudget]);

  return (
    <aside
      className={styles.dock}
      data-open={compactOpen}
      data-active-tab={tab}
      aria-label={t('dream.status')}
      data-module="companion-dock"
    >
      <button
        type="button"
        className={styles.compactToggle}
        aria-expanded={compactOpen}
        aria-label={compactOpen ? t('dream.collapseDock') : t('dream.openDock')}
        onClick={() => setCompactOpen((value) => !value)}
      >
        {compactOpen ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
      </button>

      <nav className={styles.tabs} aria-label={t('dream.dockViews')}>
        <button type="button" data-active={tab === 'status'} onClick={() => { setTab('status'); setCompactOpen(true); }}>
          <Activity size={18} /><span>{t('dream.status')}</span>
        </button>
        <button
          type="button"
          data-active={tab === 'chat'}
          data-testid="primary-chat-action"
          onClick={() => { setTab('chat'); setCompactOpen(true); }}
        >
          <MessageCircle size={18} /><span>{t('dream.chat')}</span>
        </button>
        <button type="button" data-active={tab === 'focus'} onClick={() => { setTab('focus'); setCompactOpen(true); }}>
          <Flame size={18} /><span>{t('dream.focus')}</span>
        </button>
      </nav>

      <div className={styles.content}>
        {tab === 'status' && (
          <section className={styles.status} aria-labelledby="status-title">
            <header>
              <div>
                <span className={styles.eyebrow}>{t('dream.tonight')}</span>
                <h2 id="status-title">{personaName}</h2>
                <p>{identityLine}</p>
              </div>
              <span className={styles.connection} data-connected={connected}>
                {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
                {connected ? t('dream.connected') : ws.connState === 'unavailable' ? t('dream.unavailable') : t('dream.offline')}
              </span>
            </header>

            <div className={styles.identityLock}>
              <LockKeyhole size={19} />
              <div>
                <strong>{t('dream.identityLocked')}</strong>
                <small>{t('dream.identityLockDetail')}</small>
              </div>
            </div>

            <div className={styles.relationship}>
              <span>{t('dream.relationshipStage')}</span>
              <strong>{relationshipStage}</strong>
              <small>{recentInterest}</small>
              <progress
                max={100}
                value={Math.min(100, Math.max(0, relationship.intimacy || 0))}
                aria-label={t('dream.relationshipProgress', { value: relationship.intimacy || 0 })}
              />
            </div>

            <div className={styles.primaryActions}>
              <button type="button" data-testid="primary-diary-action" onClick={onOpenDiary}>
                <BookOpen size={18} />
                <span>{t('dream.diary')}</span>
              </button>
              <button type="button" data-testid="primary-phone-action" onClick={onOpenPhone}>
                <Smartphone size={18} />
                <span>{t('dream.phone')}</span>
              </button>
              <button type="button" data-testid="primary-settings-action" onClick={onOpenSettings}>
                <Settings size={18} />
                <span>{t('dream.settings')}</span>
              </button>
            </div>

            <div className={styles.principles}>
              <article>
                <HardDrive size={17} />
                <div>
                  <strong>{t('dream.localFirst')}</strong>
                  <small>{t('dream.localFirstDetail')}</small>
                </div>
              </article>
              <article>
                <Brain size={17} />
                <div>
                  <strong>{t('dream.memoryUnlimited')}</strong>
                  <small>{t('dream.memoryUnlimitedDetail')}</small>
                </div>
              </article>
            </div>

            <section className={styles.apiDisclosure} aria-label={t('dream.apiConsumption')}>
              <strong>{t('dream.apiUsage')}</strong>
              <span>{apiUsage}</span>
              <small>{t('dream.apiDisclosure')}</small>
            </section>
          </section>
        )}
        {tab === 'chat' && <ChatPanel ws={ws} personaName={personaName} />}
        <div hidden={tab !== 'focus'} aria-hidden={tab !== 'focus'}>
          <FocusPanel
            onCompleted={(id, content) => ws.addLocalFocusMessage(content, id)}
            onActivityChange={onFocusActivityChange}
            onAtmosphereChange={onCompanionAtmosphereChange}
            generationInFlight={Object.values(ws.chatRequestStates).some(
              (request) => request.state === 'generating',
            )}
            onCancelGeneration={() => ws.stopChat()}
          />
        </div>
      </div>
    </aside>
  );
}
