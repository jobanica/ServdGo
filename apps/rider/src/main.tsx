import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Capacitor } from '@capacitor/core';
import { recordAppInstall, isInstalledApp } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';
import { RiderGate } from './RiderGate.tsx';
import { VersionGate } from './VersionGate.tsx';

// Count rider-app installs: the packaged Android build always counts, and the
// web build counts once it's running as an installed app. Deduped per device.
if (supabase) {
  const native = Capacitor.isNativePlatform();
  if (native || isInstalledApp()) {
    void recordAppInstall(supabase, 'rider', native ? Capacitor.getPlatform() : 'pwa');
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VersionGate>
      <RiderGate />
    </VersionGate>
  </StrictMode>,
);
