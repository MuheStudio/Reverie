import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, createHashRouter, RouterProvider } from 'react-router-dom';
import rootRouter from '@/routers';

import './common.scss';
import './styles/reverie-theme.css';
import { initI18n } from './i18';

declare const __ROUTER_BASE__: string;

initI18n();
document.body.classList.add('reverie-dark');

const basename = typeof __ROUTER_BASE__ !== 'undefined' && __ROUTER_BASE__ ? __ROUTER_BASE__ : '/';
const useFileRouter = window.location.protocol === 'file:';
const router = useFileRouter
  ? createHashRouter(rootRouter)
  : createBrowserRouter(rootRouter, { basename });

console.info('[ReverieRenderer] boot', {
  href: window.location.href,
  protocol: window.location.protocol,
  routerMode: useFileRouter ? 'hash' : 'browser',
  basename,
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

function ReverieApp() {
  useEffect(() => {
    console.info('[ReverieRenderer] app mounted', {
      pathname: window.location.pathname,
      hash: window.location.hash,
      bodyClass: document.body.className,
    });
  }, []);

  return <RouterProvider router={router} />;
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
