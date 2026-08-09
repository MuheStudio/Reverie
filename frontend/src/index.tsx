import React, { Suspense, lazy, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import MvpRoom from '@/components/MvpRoom';
import { useMvpBridge } from '@/hooks/useMvpBridge';
import { initI18n } from '@/i18';

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
            <h1>Reverie renderer failed</h1>
            <p>The renderer started, but React failed while mounting. Check Renderer ERR in the Electron startup log.</p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

// DreamRoom is the full "her room" experience. It is loaded lazily so the
// compact MvpRoom shell stays fast to boot; the Python host decides the active
// mode via settings.ui.mode (mvp | dream).
const DreamRoom = lazy(() => import('@/components/DreamRoom'));
const PetStage = lazy(() => import('@/components/PetStage/PetStage'));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function AppShell() {
  const bridge = useMvpBridge();
  const [mode, setMode] = useState<'mvp' | 'dream'>('mvp');
  const [modeKnown, setModeKnown] = useState(false);

  useEffect(() => {
    if (!bridge.settings || !isRecord(bridge.settings.ui)) return;
    const stored = bridge.settings.ui.mode;
    if (stored === 'dream' || stored === 'mvp') {
      setMode(stored);
      setModeKnown(true);
    } else {
      setModeKnown(true);
    }
  }, [bridge.settings]);

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

  // Before the Python host reports the stored mode, show the compact shell.
  if (!modeKnown) return <MvpRoom />;
  if (mode === 'dream') {
    return (
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
    );
  }
  return <MvpRoom />;
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
