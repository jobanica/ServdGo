import { useEffect, useState } from 'react';
import { getAppSettings } from '@ebd/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { PadalaForm } from './PadalaForm.tsx';
import { InstallApp } from './InstallApp.tsx';
import { PabiliForm } from './PabiliForm.tsx';
import { FoodFlow } from './FoodFlow.tsx';
import { Track } from './tracking/Track.tsx';
import { useAuth } from './auth/AuthContext.tsx';
import { REQUIRE_ACCOUNT } from './config.ts';
import { Welcome } from './Welcome.tsx';
import { Account } from './Account.tsx';
import { usePlatformStatus, ClosedNotice } from './PlatformStatus.tsx';

type Service = 'food' | 'pabili' | 'padala';
type Tab = Service | 'track' | 'account';
type ServiceAvailability = Record<Service, boolean>;
const ALL_ON: ServiceAvailability = { food: true, pabili: true, padala: true };

export function App() {
  const { live, mobile, email, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('food');
  const platform = usePlatformStatus();
  // When the account gate is on, AuthGate is the branded entry — skip the
  // in-app welcome so we don't show two landing screens.
  const [entered, setEntered] = useState(REQUIRE_ACCOUNT);
  const [enabled, setEnabled] = useState<ServiceAvailability>(ALL_ON);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    getAppSettings(supabase)
      .then((s) => setEnabled({ food: s.service_food, pabili: s.service_pabili, padala: s.service_padala }))
      .catch(() => { /* keep all-on if settings can't load */ });
  }, []);

  // If the selected service gets turned off, fall back to the first enabled one.
  useEffect(() => {
    if (tab === 'track' || tab === 'account' || enabled[tab]) return;
    const firstOn = (['food', 'pabili', 'padala'] as Service[]).find((k) => enabled[k]);
    if (firstOn) setTab(firstOn);
  }, [enabled, tab]);

  const noneEnabled = !enabled.food && !enabled.pabili && !enabled.padala;
  const tracking = tab === 'track';
  const account = tab === 'account';
  const service = tracking || account ? 'food' : tab;

  if (!entered) {
    return <Welcome onOrder={() => setEntered(true)} onTrack={() => { setEntered(true); setTab('track'); }} />;
  }

  return (
    <div className="min-h-screen pb-24">
      {/* App bar */}
      <header className="sticky top-0 z-30 bg-brand-green text-white shadow-sm">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 text-lg font-black">E</span>
            <div className="leading-tight">
              <h1 className="text-base font-extrabold tracking-tight">Easy Buy Delivery</h1>
              <p className="text-[11px] opacity-90">Food • Pabili • Padala</p>
            </div>
          </div>
          {live && REQUIRE_ACCOUNT && (
            <div className="flex min-w-0 items-center gap-2">
              {email && (
                <span className="hidden min-w-0 text-right text-[11px] leading-tight opacity-90 sm:block">
                  <span className="block opacity-70">Signed in as</span>
                  <span className="block truncate font-semibold">{email}</span>
                </span>
              )}
              <button onClick={() => void signOut()} title={email ? `Signed in as ${email}` : 'Sign out'}
                className="shrink-0 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium hover:bg-white/25">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-xl px-5 py-4">
        {!isSupabaseConfigured && (
          <p className="mb-4 rounded-xl border border-brand-yellow bg-brand-yellow/20 px-3 py-2 text-sm">
            Preview mode — set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to place real orders.
          </p>
        )}
        {account ? (
          <Account />
        ) : tracking ? (
          <Track onClose={() => setTab('food')} />
        ) : !platform.open ? (
          // Closed: no new orders, but Account and Track stay reachable above
          // so a delivery already on its way can still be followed.
          <ClosedNotice status={platform} />
        ) : noneEnabled ? (
          <p className="rounded-2xl bg-white p-6 text-center text-sm text-black/60 shadow-sm ring-1 ring-black/5">
            All services are temporarily unavailable. Please check back soon.
          </p>
        ) : !enabled[service] ? (
          <p className="rounded-2xl bg-white p-6 text-center text-sm text-black/60 shadow-sm ring-1 ring-black/5">
            This service is temporarily unavailable.
          </p>
        ) : (
          <>
            {service === 'food' && <FoodFlow />}
            {service === 'pabili' && <PabiliForm />}
            {service === 'padala' && <PadalaForm />}
          </>
        )}
      </main>

      {/* Sits above the tab bar, so it never covers the navigation. */}
      <InstallApp />

      {/* Bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-black/5 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-stretch justify-around px-2 py-1.5">
          <TabButton label="Food" active={tab === 'food'} disabled={!enabled.food} onClick={() => setTab('food')} icon={<FoodIcon />} />
          <TabButton label="Pabili" active={tab === 'pabili'} disabled={!enabled.pabili} onClick={() => setTab('pabili')} icon={<BagIcon />} />
          <TabButton label="Padala" active={tab === 'padala'} disabled={!enabled.padala} onClick={() => setTab('padala')} icon={<BoxIcon />} />
          <TabButton label="Track" active={tab === 'track'} onClick={() => setTab('track')} icon={<PinIcon />} />
          <TabButton label="Account" active={tab === 'account'} onClick={() => setTab('account')} icon={<UserIcon />} />
        </div>
      </nav>
    </div>
  );
}

function TabButton({ label, icon, active, onClick, disabled = false }:
  { label: string; icon: React.ReactNode; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      title={disabled ? 'Temporarily unavailable' : undefined}
      className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] font-semibold transition ${
        disabled ? 'cursor-not-allowed text-black/20'
          : active ? 'text-brand-green' : 'text-black/45 hover:text-black/70'
      }`}>
      <span className={`flex h-7 w-7 items-center justify-center rounded-full transition ${active && !disabled ? 'bg-brand-green/15' : ''}`}>
        {icon}
      </span>
      {label}
    </button>
  );
}

const iconProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function FoodIcon() { return <svg {...iconProps}><path d="M3 2v7a3 3 0 0 0 3 3v10M6 2v6M9 2v6M9 2v20M17 2c-1.5 0-3 1.5-3 5s1.5 5 3 5v10" /></svg>; }
function BagIcon() { return <svg {...iconProps}><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18M16 10a4 4 0 0 1-8 0" /></svg>; }
function BoxIcon() { return <svg {...iconProps}><path d="M21 8V6a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 6v12a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 18z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></svg>; }
function PinIcon() { return <svg {...iconProps}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>; }
function UserIcon() { return <svg {...iconProps}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>; }
