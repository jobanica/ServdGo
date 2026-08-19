import { useState } from 'react';
import { signOut } from '@servdgo/supabase';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Dashboard } from './Dashboard.tsx';
import { Stores } from './Stores.tsx';
import { RiderApplications } from './RiderApplications.tsx';
import { LiveOrders } from './LiveOrders.tsx';
import { Settlements } from './Settlements.tsx';
import { ServiceAreas } from './ServiceAreas.tsx';
import { UserMonitor } from './UserMonitor.tsx';
import { Settings } from './Settings.tsx';
import { Broadcast } from './Broadcast.tsx';
import { OrderHistory } from './OrderHistory.tsx';
import { Analytics } from './Analytics.tsx';
import { Riders } from './Riders.tsx';
import { Staff } from './Staff.tsx';
import { useAdminRole } from './AdminGate.tsx';
import { can, ROLE_LABEL, type AdminSection } from '@servdgo/shared';
import { Territories } from './Territories.tsx';
import { Royalty } from './Royalty.tsx';
import { Merchants } from './Merchants.tsx';
import {
  IconDashboard, IconChart, IconStore, IconRiders, IconScooter, IconOrders, IconHistory, IconWallet,
  IconSettings, IconMegaphone, IconUsers, IconSearch, IconMenu,
} from './icons.tsx';

type Tab = AdminSection;

const NAV: { key: Tab; label: string; icon: () => React.ReactNode }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: IconDashboard },
  { key: 'analytics', label: 'Analytics', icon: IconChart },
  { key: 'stores', label: 'Stores & menus', icon: IconStore },
  { key: 'ridersActive', label: 'Riders', icon: IconScooter },
  { key: 'riders', label: 'Rider applications', icon: IconRiders },
  { key: 'orders', label: 'Live orders', icon: IconOrders },
  { key: 'history', label: 'Order history', icon: IconHistory },
  { key: 'settlements', label: 'Settlements', icon: IconWallet },
  { key: 'royalty', label: 'Franchise royalty', icon: IconWallet },
  { key: 'merchants', label: 'Partner restaurants', icon: IconStore },
  { key: 'broadcast', label: 'Broadcast SMS', icon: IconMegaphone },
  { key: 'areas', label: 'Service areas', icon: IconStore },
  { key: 'users', label: 'Users & installs', icon: IconUsers },
  { key: 'staff', label: 'Staff', icon: IconUsers },
  { key: 'settings', label: 'Settings', icon: IconSettings },
  { key: 'territories', label: 'Territories', icon: IconStore },
];

const TITLES: Record<Tab, string> = {
  dashboard: 'Dashboard', analytics: 'Analytics', stores: 'Stores & menus',
  ridersActive: 'Riders', riders: 'Rider applications',
  orders: 'Live orders', history: 'Order history', settlements: 'Settlements',
  royalty: 'Franchise royalty', merchants: 'Partner restaurants',
  broadcast: 'Broadcast SMS', areas: 'Service areas', users: 'Users & installs', staff: 'Staff', settings: 'Settings',
  territories: 'Territories',
};

export function App() {
  const role = useAdminRole();
  const nav = NAV.filter((n) => can(role, n.key));
  // The franchisor has no city and so no dashboard; open on what they do own.
  const [tab, setTab] = useState<Tab>(role === 'franchisor' ? 'territories' : 'dashboard');
  const [open, setOpen] = useState(false); // mobile sidebar

  return (
    <div className="min-h-screen bg-[#f7f5f3] text-brand-ink">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-brand-orange text-white">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => setOpen((o) => !o)} className="rounded-lg p-1.5 hover:bg-white/15 lg:hidden">
            <IconMenu />
          </button>
          <div className="flex items-center gap-2 font-extrabold text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20"><IconScooter /></span>
            ServdGo
          </div>
          <div className="mx-auto hidden max-w-md flex-1 items-center gap-2 rounded-xl bg-white/15 px-3 py-2 md:flex">
            <span className="opacity-90"><IconSearch /></span>
            <input placeholder="Search orders, riders, stores"
              className="w-full bg-transparent text-sm text-white placeholder-white/70 outline-none" />
          </div>
          <div className="ml-auto flex items-center gap-2 rounded-xl bg-white/15 py-1 pl-1 pr-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-charcoal text-xs font-bold">SG</span>
            <span className="hidden text-sm font-semibold sm:inline">{ROLE_LABEL[role]}</span>
            {isSupabaseConfigured && supabase && (
              <button onClick={() => void signOut(supabase!)}
                className="ml-1 rounded-lg bg-white/20 px-2 py-1 text-xs font-medium hover:bg-white/30">
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className={`fixed inset-y-0 left-0 z-20 w-60 transform overflow-y-auto bg-white pt-16 shadow-lg transition-transform lg:sticky lg:top-16 lg:bottom-auto lg:h-[calc(100vh-4rem)] lg:self-start lg:translate-x-0 lg:pt-0 lg:shadow-none ${open ? 'translate-x-0' : '-translate-x-full'}`}>
          <nav className="p-4">
            <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wide text-black/40">Main Menu</p>
            <ul className="space-y-1">
              {nav.map(({ key, label, icon: Icon }) => {
                const active = tab === key;
                return (
                  <li key={key}>
                    <button onClick={() => { setTab(key); setOpen(false); }}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                        active ? 'bg-brand-orange text-white shadow-sm' : 'text-black/60 hover:bg-black/[0.04]'
                      }`}>
                      <Icon />
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Backdrop for mobile */}
        {open && <div onClick={() => setOpen(false)} className="fixed inset-0 z-10 bg-black/30 lg:hidden" />}

        {/* Content */}
        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <div className="mb-5">
            <h1 className="text-2xl font-extrabold">{TITLES[tab]}</h1>
            <p className="text-sm text-black/50">
              ServdGo — {role === 'franchisor' ? 'franchise console' : 'operator console'}
            </p>
          </div>

          {!isSupabaseConfigured && (
            <p className="mb-4 rounded-xl border border-brand-yellow bg-brand-yellow/20 px-3 py-2 text-sm">
              Preview mode — set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to load live data.
            </p>
          )}

          {!can(role, tab) ? (
            <p className="rounded-xl bg-white p-6 text-sm text-black/50 shadow-sm ring-1 ring-black/5">
              Your role ({ROLE_LABEL[role]}) doesn't have access to this section.
            </p>
          ) : (
            <>
              {tab === 'dashboard' && <Dashboard onNavigate={(t) => can(role, t as Tab) && setTab(t as Tab)} />}
              {tab === 'analytics' && <Analytics />}
              {tab === 'territories' && <Territories />}
              {tab === 'merchants' && <Merchants />}
              {tab === 'royalty' && <Royalty />}
              {tab === 'stores' && <Stores />}
              {tab === 'ridersActive' && <Riders />}
              {tab === 'riders' && <RiderApplications />}
              {tab === 'orders' && <LiveOrders />}
              {tab === 'history' && <OrderHistory />}
              {tab === 'settlements' && <Settlements />}
              {tab === 'areas' && <ServiceAreas />}
              {tab === 'users' && <UserMonitor />}
              {tab === 'broadcast' && <Broadcast />}
              {tab === 'staff' && <Staff />}
              {tab === 'settings' && <Settings />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
