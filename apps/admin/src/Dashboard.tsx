import { useEffect, useState } from 'react';
import { listAllStores, listRiders, listOpenOrders, listRiderBalances } from '@servdgo/supabase';
import { supabase } from './lib/supabase.ts';
import { Card, peso } from './ui.tsx';
import { LiveOrders } from './LiveOrders.tsx';
import { OnDuty } from './OnDuty.tsx';
import { RefusalSummary } from './Refusals.tsx';
import { PriceReportsAlert } from './PriceReports.tsx';
import { IconStore, IconRiders, IconOrders, IconWallet, IconScooter } from './icons.tsx';

const today = new Date().toISOString().slice(0, 10);

interface Stats { stores: number; pendingRiders: number; openOrders: number; owed: number; locked: number }
const SAMPLE: Stats = { stores: 3, pendingRiders: 2, openOrders: 3, owed: 28.5, locked: 1 };

export function Dashboard({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [s, setS] = useState<Stats | null>(null);
  // Kept by the roster below, which polls; the tile is the same number.
  const [online, setOnline] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      if (!supabase) { setS(SAMPLE); return; }
      try {
        const [stores, riders, orders, balances] = await Promise.all([
          listAllStores(supabase), listRiders(supabase, 'pending'),
          listOpenOrders(supabase), listRiderBalances(supabase, today),
        ]);
        setS({
          stores: stores.length,
          pendingRiders: riders.length,
          openOrders: orders.length,
          owed: balances.reduce((t, b) => t + b.owed, 0),
          locked: balances.filter((b) => b.locked).length,
        });
      } catch { setS({ stores: 0, pendingRiders: 0, openOrders: 0, owed: 0, locked: 0 }); }
    })();
  }, []);

  return (
    <div className="space-y-5">
      {/* Branded promo / status banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-brand-green to-[#4e9e15] p-6 text-white shadow-sm">
        <div className="relative z-10 max-w-md">
          <p className="text-sm font-medium opacity-90">ServdGo</p>
          <h2 className="mt-1 text-2xl font-extrabold leading-tight">
            Pabili • Padala <span className="text-brand-yellow">delivered fast</span>
          </h2>
          <p className="mt-1 text-sm opacity-90">Monitor stores, riders, orders and settlements in one place.</p>
        </div>
        <div className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -bottom-10 right-16 h-28 w-28 rounded-full bg-brand-yellow/20" />
      </div>

      <PriceReportsAlert onNavigate={onNavigate} />

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat label="Riders online" value={online == null ? '—' : String(online)}
          sub={online === 0 ? 'nobody on duty' : undefined}
          icon={<IconScooter />} tint={online === 0 ? 'yellow' : 'green'} onClick={() => onNavigate('ridersActive')} />
        <Stat label="Stores" value={s ? String(s.stores) : '—'} icon={<IconStore />} tint="green" onClick={() => onNavigate('stores')} />
        <Stat label="Pending riders" value={s ? String(s.pendingRiders) : '—'} icon={<IconRiders />} tint="purple" onClick={() => onNavigate('riders')} />
        <Stat label="Open orders" value={s ? String(s.openOrders) : '—'} icon={<IconOrders />} tint="yellow" onClick={() => onNavigate('orders')} />
        <Stat label="Owed by riders" value={s ? peso(s.owed) : '—'} sub={s && s.locked > 0 ? `${s.locked} locked` : undefined} icon={<IconWallet />} tint="green" onClick={() => onNavigate('settlements')} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <OnDuty onNavigate={onNavigate} onCount={setOnline} />
        <Card title="Live orders" action={<button onClick={() => onNavigate('orders')} className="text-sm font-medium text-brand-purple">View all →</button>}>
          <LiveOrders embedded />
        </Card>
      </div>

      <RefusalSummary onNavigate={onNavigate} />
    </div>
  );
}

const tints: Record<string, string> = {
  green: 'bg-brand-green/15 text-green-700',
  purple: 'bg-brand-purple/15 text-brand-purple',
  yellow: 'bg-brand-yellow/30 text-yellow-700',
};

function Stat({ label, value, sub, icon, tint, onClick }:
  { label: string; value: string; sub?: string; icon: React.ReactNode; tint: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-black/5 transition hover:ring-brand-green/40">
      <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${tints[tint]}`}>{icon}</span>
      <span>
        <span className="block text-xl font-bold text-brand-ink">{value}</span>
        <span className="block text-xs text-black/50">{label}{sub ? ` · ${sub}` : ''}</span>
      </span>
    </button>
  );
}
