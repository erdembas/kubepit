import { initializeDesktopLocale } from './lib/i18n';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { perfEnabled } from '@/lib/perf/probe';
import { installScrollIdleTracker } from '@/lib/scrollIdle';
import { installTextInputGuard } from '@/lib/textInputGuard';
import { useAppStore } from '@/store/useAppStore';
import { useDockStore } from '@/store/useDockStore';
import './styles.css';

installScrollIdleTracker();
installTextInputGuard();

// Dev-only handle for poking stores from DevTools:
//   __kp.app.getState().openCluster('c-kind')
if (import.meta.env.DEV) {
  (window as unknown as { __kp?: unknown }).__kp = { app: useAppStore, dock: useDockStore };
}

// Performance probe (`?perf=1`): `window.__kubepitPerf`. The driver is its own
// chunk, loaded only while the probe is on.
if (perfEnabled()) void import('@/lib/perf/driver').then((m) => m.installPerfDriver());

initializeDesktopLocale();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
