import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthContext.tsx';
import { AuthGate } from './auth/AuthGate.tsx';
import { recordAppInstall, isInstalledApp } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';

// Count installs of the customer app: when the browser confirms an install, and
// on launch when we're already running as an installed app (covers devices that
// installed it before this tracking existed). Deduplicated per device.
if (supabase) {
  window.addEventListener('appinstalled', () => { void recordAppInstall(supabase!, 'customer', 'pwa'); });
  if (isInstalledApp()) void recordAppInstall(supabase, 'customer', 'pwa');
}

// Auto-update the app when a new version is deployed: register immediately,
// re-check for a new service worker every 30 min and on tab focus, and reload
// as soon as one activates so users never stay on a stale build.
//
// Belt-and-suspenders: when a freshly activated worker takes control of this
// page (clientsClaim), reload once so the running tab picks up the new build
// even if the higher-level onNeedRefresh path doesn't fire. The guard prevents
// a reload loop and skips the very first controller (initial SW install).
if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !navigator.serviceWorker.controller) return;
    reloading = true;
    window.location.reload();
  });
}

const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    setInterval(() => void reg.update(), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update();
    });
  },
  onNeedRefresh() {
    void updateSW(true); // activate the new SW and reload
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
);
