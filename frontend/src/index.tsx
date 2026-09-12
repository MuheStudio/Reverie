import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import MvpRoom from '@/components/MvpRoom';
import OnboardingWizard from '@/components/Onboarding/OnboardingWizard';
import { useMvpBridge } from '@/hooks/useMvpBridge';
import { initI18n } from '@/i18';
import {
  decideBootMode,
  isOnboardingComplete,
  resolveStoredRoomMode,
  type RoomMode,
} from '@/lib/startupMode';

import './common.scss';
import './styles/reverie-theme.css';

document.body.classList.add('reverie-dark');

console.info('[ReverieRenderer] boot', {
  href: window.location.href,
  protocol: window.location.protocol,
});

window.addEventListener('error', (event) => {
  console.error('[ReverieRenderer] uncaught error', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[ReverieRenderer] unhandled rejection', event.reason);
});

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ReverieRenderer] react render error', error);
  }

  render() {
    if (this.state.error) {
      return (
        <main style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: '#141727',
          color: '#f0f1f5',
          fontFamily: 'sans-serif',
        }}>
          <section style={{ maxWidth: 720, lineHeight: 1.6 }}>
            <h1>Reverie 界面启动失败</h1>
            <p>渲染进程已启动，但 React 挂载失败。请查看 Electron 启动日志中的 Renderer ERR 条目。</p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

// DreamRoom is the full "her room" experience. It is loaded lazily so the
// compact MvpRoom shell stays fast to boot. Incomplete onboarding always
// lands on MvpRoom; a leftover ui.mode=dream cannot skip the wizard.
const DreamRoom = lazy(() => import('@/components/DreamRoom'));
const PetStage = lazy(() => import('@/components/PetStage/PetStage'));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scheduleIdle(callback: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(callback);
    return;
  }
  window.setTimeout(callback, 250);
}

function BootSplash() {
  return (
    <main
      data-testid="boot-splash"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'linear-gradient(160deg, #d8d0db, #c8aea8)',
        color: '#784354',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ textAlign: 'center', lineHeight: 1.8 }}>
        <span style={{ fontSize: 28, letterSpacing: 6 }}>Reverie</span>
        <div style={{ fontSize: 13, opacity: 0.75 }}>正在来到她的世界…</div>
      </div>
    </main>
  );
}

function AppShell() {
  const bridge = useMvpBridge();
  const [mode, setMode] = useState<RoomMode>('mvp');
  const [modeKnown, setModeKnown] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const bootSyncedRef = useRef(false);
  const intendedModeRef = useRef<RoomMode | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [electronUi, setElectronUi] = useState<Record<string, unknown> | null>(null);
  const [electronUiKnown, setElectronUiKnown] = useState(false);
  const pythonUi = isRecord(bridge.settings.ui) ? bridge.settings.ui : null;
  const uiSettings = pythonUi || electronUi;
  const hostReady = bridge.connection === 'connected';
  const onboardingCompleted = onboardingDismissed || isOnboardingComplete(uiSettings);

  useEffect(() => {
    let cancelled = false;
    const reader = window.electronAPI?.appState?.getUiSnapshot;
    if (!reader) {
      setElectronUiKnown(true);
      return undefined;
    }
    const failSafe = window.setTimeout(() => {
      if (!cancelled) setElectronUiKnown(true);
    }, 800);
    void reader()
      .then((snapshot) => {
        if (!cancelled && isRecord(snapshot)) setElectronUi(snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(failSafe);
        if (!cancelled) setElectronUiKnown(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(failSafe);
    };
  }, []);

  useEffect(() => {
    if (!electronUiKnown && !pythonUi) return;
    const stored = resolveStoredRoomMode(uiSettings?.mode);
    const complete = onboardingDismissed || isOnboardingComplete(uiSettings);
    if (!bootSyncedRef.current) {
      // First snapshot ends the splash. Incomplete onboarding always opens
      // MvpRoom so a leftover dream mode cannot hide the wizard. Electron can
      // read this from config.json even while Python is still starting.
      bootSyncedRef.current = true;
      const boot = decideBootMode(stored, complete);
      setMode(boot.mode);
      setModeKnown(true);
      return;
    }
    if (!complete && !onboardingDismissed) {
      setMode('mvp');
      return;
    }
    if (intendedModeRef.current) {
      const intended = intendedModeRef.current;
      intendedModeRef.current = null;
      setMode(intended);
      return;
    }
    setMode(stored);
  }, [electronUiKnown, onboardingDismissed, pythonUi, uiSettings]);

  // Once the settings handshake is done, warm the DreamRoom chunk so entering
  // her room in-session is effectively instant.
  useEffect(() => {
    if (!modeKnown) return;
    scheduleIdle(() => {
      void import('@/components/DreamRoom');
    });
  }, [modeKnown]);

  // Murphy fallback: if the host never answers, never strand the user on the
  // splash. The wizard overlays the splash as soon as the bridge authenticates.
  useEffect(() => {
    if (modeKnown) return;
    const timer = window.setTimeout(() => setBootTimedOut(true), 3000);
    return () => window.clearTimeout(timer);
  }, [modeKnown]);

  useEffect(() => {
    void initI18n().catch((error) => {
      console.warn('[ReverieRenderer] i18n init failed', error);
    });
  }, []);

  useEffect(() => {
    console.info('[ReverieRenderer] app mounted', {
      pathname: window.location.pathname,
      hash: window.location.hash,
      bodyClass: document.body.className,
      mode,
    });
  }, [mode]);

  const wizard = electronUiKnown && !onboardingCompleted ? (
    <OnboardingWizard
      key="reverie-onboarding"
      initialUi={uiSettings}
      initialProfile={isRecord(bridge.userProfile) ? bridge.userProfile : null}
      hostReady={hostReady}
      updateSettings={bridge.updateSettings}
      completeOnboarding={bridge.completeOnboarding}
      importCharacterCard={bridge.importCharacterCard}
      importWorldBook={bridge.importWorldBook}
      onCompleted={(result) => {
        setOnboardingDismissed(true);
        const next: RoomMode = result?.experienceMode === 'core' ? 'mvp' : 'dream';
        intendedModeRef.current = next;
        setMode(next);
      }}
    />
  ) : null;

  const room = mode === 'dream' ? (
    <Suspense fallback={(
      <main style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#141727',
        color: '#f0f1f5',
        fontFamily: 'sans-serif',
      }}>
        <span>正在布置她的房间…</span>
      </main>
    )}>
      <DreamRoom />
    </Suspense>
  ) : (
    <MvpRoom />
  );

  // Before the Python host reports in, show a lightweight splash — never the
  // full room, so a stored dream mode cannot flash-switch later. The wizard
  // still mounts over the splash so a first-run user is not stranded on
  // "正在来到她的世界".
  if (!modeKnown && !bootTimedOut) {
    return (
      <>
        <BootSplash />
        {wizard}
      </>
    );
  }
  return (
    <>
      {bootTimedOut && !hostReady && (
        <div
          role="status"
          style={{
            position: 'fixed',
            inset: '0 0 auto 0',
            zIndex: 60,
            padding: '8px 16px',
            textAlign: 'center',
            fontSize: 13,
            color: '#f0f1f5',
            background: 'rgba(20, 23, 39, 0.92)',
          }}
        >
          本地服务还在启动。新手引导可以先导入 Live2D；聊天要等服务恢复。
        </div>
      )}
      {room}
      {wizard}
    </>
  );
}

function ReverieApp() {
  const [petMode, setPetMode] = useState(false);
  useEffect(() => {
    setPetMode(window.location.hash === '#pet');
  }, []);
  if (petMode) {
    return (
      <Suspense fallback={null}>
        <PetStage />
      </Suspense>
    );
  }
  return <AppShell />;
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Reverie root element #root was not found.');
}

ReactDOM.createRoot(rootElement).render(
  <RootErrorBoundary>
    <ReverieApp />
  </RootErrorBoundary>,
);
