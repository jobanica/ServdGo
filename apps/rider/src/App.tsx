import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ORDER_FLOW,
  isLockedOut,
  overdueBalance,
  owedBalance,
  owedByKind,
  pabiliCollectible,
  counterTotal,
  riderEarnings,
  sortRequestQueue,
  SUPPORT_EMAIL,
  SUPPORT_PHONE,
  PRIVACY_URL,
  TERMS_URL,
  haversineMeters,
  summarizeEarnings,
  presetRange,
  normalizeRange,
  shiftDay,
  RANGE_LABELS,
  type RangePreset,
  type EarningRecord,
  type LatLng,
  type LedgerEntry,
  type OrderStatus,
  errMessage,
} from '@servdgo/shared';
import {
  subscribeToNewOrders, signOut,
  getRiderProfile, updateRiderProfile, uploadRiderPhoto, type RiderProfile,
  getAppSettings, uploadSettlementReceipt, type AppSettings,
} from '@servdgo/supabase';
import { makeRiderData, type RiderData, type RiderOrder } from './data/index.ts';
import type { OrderAddon } from './data/types.ts';
import { peso } from './ui.tsx';
import { Qr } from './Qr.tsx';
import { DeliveryMap } from './DeliveryMap.tsx';
import { PinPicker } from './PinPicker.tsx';
import { useLocationPublisher } from './useLocationPublisher.ts';
import { useRiderPosition, formatDistance } from './useRiderPosition.ts';
import { ChatButton } from './Chat.tsx';
import { usePushRegistration } from './usePushRegistration.ts';
import { useNewOrderAlert } from './useNewOrderAlert.ts';
import { isAlertMuted, setAlertMuted, playNewOrderAlert } from './alert.ts';
import { usePlatformStatus, ClosedBanner } from './PlatformStatus.tsx';
import { AnnouncementBanner } from './Announcements.tsx';
import { supabase } from './lib/supabase.ts';
import { APP_VERSION } from './config.ts';
import { DeleteAccount } from './DeleteAccount.tsx';
import { WalletPanel, useWalletGate } from './Wallet.tsx';

const SERVICES: { key: string; label: string }[] = [
  { key: 'food', label: 'Food' }, { key: 'pabili', label: 'Pabili' }, { key: 'padala', label: 'Padala' },
];

// Philippine business day (matches the commission_ledger trigger), so the
// daily settlement gate and the recorded commission agree on "today".
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
type Tab = 'dashboard' | 'requests' | 'deliveries' | 'earnings' | 'settings';

export function App({ riderId, riderName }: { riderId?: string; riderName?: string } = {}) {
  // Which account this session belongs to — shown in the header so a leftover
  // login (e.g. a demo account) is obvious at a glance.
  const [signedInEmail, setSignedInEmail] = useState('');
  useEffect(() => { supabase?.auth.getSession().then(({ data }) => setSignedInEmail(data.session?.user.email ?? '')); }, []);
  const [data] = useState<RiderData>(() => makeRiderData(riderId));
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [open, setOpen] = useState<RiderOrder[]>([]);
  const [active, setActive] = useState<RiderOrder[]>([]);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [profile, setProfile] = useState<RiderProfile | null>(null);
  const riderPos = useRiderPosition();
  const platform = usePlatformStatus();

  const loadProfile = useCallback(async () => {
    if (!supabase || !riderId) return;
    try { setProfile(await getRiderProfile(supabase, riderId)); } catch { /* non-fatal */ }
  }, [riderId]);
  useEffect(() => { void loadProfile(); }, [loadProfile]);

  const refresh = useCallback(async () => {
    try {
      const [l, o, a] = await Promise.all([data.getLedger(), data.getOpenOrders(), data.getActiveOrders()]);
      setLedger(l); setOpen(o); setActive(a); setError(null);
    } catch (e) {
      setError(errMessage(e));
    }
  }, [data]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { data.getOnline().then(setOnline).catch(() => {}); }, [data]);
  usePushRegistration(riderId, profile?.push_enabled ?? true);

  useEffect(() => {
    if (!supabase) return;
    return subscribeToNewOrders(supabase, () => void refresh());
  }, [refresh]);

  // With a wallet the commission ledger settles the moment it is written, so
  // the database's own answer is the only one that means anything.
  const wallet = useWalletGate(riderId);
  const locked = wallet.enabled ? wallet.overdue > 0 : isLockedOut(ledger, today);
  const overdue = wallet.enabled ? wallet.overdue : overdueBalance(ledger, today);
  const owed = wallet.enabled ? -Math.min(wallet.balance, 0) : owedBalance(ledger);
  const accepts = (t: string) => !profile?.services_accepted || profile.services_accepted.includes(t);
  // The pool is a queue, not a menu: transfers first (a released delivery may
  // already have paid-for goods waiting), then oldest request first. Only the
  // head is acceptable — see the queue lock on RequestCard. There is no way to
  // pass: a rider takes the request in front of them or leaves it for someone
  // else, and it stays at the head until somebody does.
  const pool = sortRequestQueue(open.filter((o) => accepts(o.service_type)));
  const head = pool[0] ?? null;
  // Only announce what the rider could actually take right now.
  useNewOrderAlert(pool.map((o) => o.id), online && !locked);
  const transfers = pool.filter((o) => o.isTransfer);
  const newRequests = pool.filter((o) => !o.isTransfer);

  async function toggleOnline() {
    setOnlineBusy(true);
    try { setOnline(await data.setOnline(!online)); }
    catch (e) { setError(errMessage(e)); }
    finally { setOnlineBusy(false); }
  }

  async function accept(orderId: string) {
    // Belt and braces: the cards behind the head don't offer an Accept button,
    // but nothing should be able to jump the queue.
    if (head && orderId !== head.id) {
      setError('Answer the first request in the queue before taking another one.');
      return;
    }
    try { await data.accept(orderId); setTab('deliveries'); }
    catch (e) { setError(errMessage(e)); }
    await refresh();
  }

  async function submitSettlement(extra?: { reference?: string; receiptUrl?: string }) {
    // Settle the full owed balance: use the latest unsettled day (today's total
    // included) — confirmSettlement clears everything up to it.
    const unsettledDays = ledger.filter((e) => !e.settled).map((e) => e.businessDay).sort();
    const day = unsettledDays[unsettledDays.length - 1];
    if (!day) return;
    await data.settle(day, owed, extra);
    await refresh();
  }

  const firstName = ((profile?.name ?? riderName) ?? '').trim().split(/\s+/)[0] || 'Rider';

  return (
    <div className="min-h-screen bg-[#f8f6f4] pb-24">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-brand-orange/15 text-lg">
              {profile?.photo_url ? <img src={profile.photo_url} alt="" className="h-full w-full object-cover" /> : '🛵'}
            </span>
            <div className="leading-tight">
              <p className="text-xs text-black/45">Welcome back!</p>
              <h1 className="text-base font-extrabold">{firstName}</h1>
              {signedInEmail && <p className="max-w-[11rem] truncate text-[10px] text-black/35">{signedInEmail}</p>}
            </div>
          </div>
          <button onClick={() => setTab('requests')}
            className="relative flex h-10 w-10 items-center justify-center rounded-full bg-black/[0.04]">
            <BellIcon />
            {online && pool.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-charcoal px-1 text-[10px] font-bold text-white">
                {pool.length}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-5 py-4">
        <ClosedBanner status={platform} workLeft={pool.length + active.length} />
        <AnnouncementBanner />
        {error && <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {tab === 'dashboard' && (
          <Dashboard
            online={online} onlineBusy={onlineBusy} onToggleOnline={toggleOnline}
            pool={pool} active={active} owed={owed} locked={locked} riderPos={riderPos}
            onGo={setTab} onAccept={accept} data={data} onChange={refresh} />
        )}

        {tab === 'requests' && (
          locked ? <LockCard overdue={overdue} wallet={wallet.enabled} onSettle={() => setTab('earnings')} />
            : !online ? <OfflineCard onGoOnline={toggleOnline} busy={onlineBusy} />
            : pool.length === 0 ? <Empty icon="📭">No requests in the pool right now.</Empty>
            : <div className="space-y-5">
                <QueueNote waiting={pool.length} />
                {transfers.length > 0 && (
                  <div className="space-y-3">
                    <div className="rounded-2xl bg-brand-yellow/20 px-4 py-3 ring-1 ring-brand-yellow">
                      <h2 className="text-lg font-extrabold text-yellow-900">🔄 Transfer deliveries</h2>
                      <p className="text-xs text-yellow-900/80">
                        Released by another rider — these come first in the queue.
                      </p>
                    </div>
                    {transfers.map((o) => (
                      <RequestCard key={o.id} order={o} riderPos={riderPos}
                        queuePos={pool.indexOf(o) + 1} locked={o.id !== head?.id}
                        onAccept={() => accept(o.id)} />
                    ))}
                  </div>
                )}
                {newRequests.length > 0 && (
                  <div className="space-y-3">
                    <SectionTitle>{transfers.length > 0 ? 'Behind the transfers' : 'Request queue'}</SectionTitle>
                    {newRequests.map((o) => (
                      <RequestCard key={o.id} order={o} riderPos={riderPos}
                        queuePos={pool.indexOf(o) + 1} locked={o.id !== head?.id}
                        onAccept={() => accept(o.id)} />
                    ))}
                  </div>
                )}
              </div>
        )}

        {tab === 'deliveries' && (
          active.length === 0
            ? <Empty icon="✅">No active deliveries. Accept one from Requests.</Empty>
            : <div className="space-y-4">
                <SectionTitle>My deliveries</SectionTitle>
                {active.map((o) => <DeliveryCard key={o.id} order={o} data={data} onChange={refresh} payoutNumber={profile?.payout_number} riderPos={riderPos} />)}
              </div>
        )}

        {tab === 'earnings' && (
          <EarningsView live={data.live} data={data} riderId={riderId} ledger={ledger} owed={owed} overdue={overdue} onSettle={submitSettlement} />
        )}

        {tab === 'settings' && (
          <SettingsView live={data.live} online={online} busy={onlineBusy} onToggleOnline={toggleOnline}
            profile={profile} onProfileSaved={loadProfile} />
        )}
      </main>

      <BottomNav tab={tab} onTab={setTab} requests={online ? pool.length : 0} deliveries={active.length} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ online, onlineBusy, onToggleOnline, pool, active, owed, locked, riderPos, onGo, onAccept, data, onChange }: {
  online: boolean; onlineBusy: boolean; onToggleOnline: () => void;
  pool: RiderOrder[]; active: RiderOrder[]; owed: number; locked: boolean; riderPos: LatLng | null;
  onGo: (t: Tab) => void; onAccept: (id: string) => void;
  data: RiderData; onChange: () => Promise<void>;
}) {
  const todaysPotential = active.reduce((s, o) => s + riderEarn(o), 0);
  const transferCount = pool.filter((o) => o.isTransfer).length;
  return (
    <div className="space-y-4">
      <OnlineToggle online={online} busy={onlineBusy} onToggle={onToggleOnline} />

      {/* Transfers need a taker first — surface them above everything else. */}
      {online && !locked && transferCount > 0 && (
        <button onClick={() => onGo('requests')}
          className="flex w-full items-center justify-between rounded-2xl bg-brand-yellow/25 px-4 py-3 text-left ring-1 ring-brand-yellow">
          <span>
            <span className="block text-sm font-extrabold text-yellow-900">
              🔄 {transferCount} transfer {transferCount === 1 ? 'delivery' : 'deliveries'} waiting
            </span>
            <span className="text-xs text-yellow-900/80">Released by another rider — take these first</span>
          </span>
          <span className="shrink-0 rounded-lg bg-yellow-900 px-3 py-1.5 text-xs font-bold text-white">View</span>
        </button>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="In the pool" value={String(pool.length)} tint="green"
          hint={online ? 'Tap to view' : 'Go online to see'} onClick={() => onGo('requests')} icon={<InboxIcon />} />
        <StatCard label="My deliveries" value={String(active.length)} tint="purple"
          hint="In progress" onClick={() => onGo('deliveries')} icon={<BoxIcon />} />
      </div>

      {/* Owed / earnings */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-xs text-black/45">On your plate</p>
          <p className="mt-1 text-2xl font-black text-brand-ink">{peso(todaysPotential)}</p>
          <p className="text-[11px] text-black/40">Earnings from active deliveries</p>
        </div>
        <button onClick={() => onGo('earnings')}
          className={`rounded-2xl p-4 text-left shadow-sm ring-1 ${owed > 0 ? 'bg-brand-yellow/20 ring-brand-yellow/40' : 'bg-white ring-black/5'}`}>
          <p className="text-xs text-black/45">Commission owed</p>
          <p className={`mt-1 text-2xl font-black ${owed > 0 ? 'text-yellow-800' : 'text-brand-ink'}`}>{peso(owed)}</p>
          <p className="text-[11px] text-black/40">{owed > 0 ? 'Tap to settle' : 'All settled'}</p>
        </button>
      </div>

      {locked && <LockCard overdue={owed} onSettle={async () => onGo('earnings')} compact />}

      {/* Next up */}
      {active.length > 0 ? (
        <div>
          <SectionTitle>Continue delivery</SectionTitle>
          <DeliveryCard order={active[0]!} data={data} onChange={onChange} riderPos={riderPos} />
        </div>
      ) : online && !locked && pool.length > 0 ? (
        <div>
          <SectionTitle>{pool[0]!.isTransfer ? 'Transfer delivery' : 'Next in the queue'}</SectionTitle>
          <RequestCard order={pool[0]!} riderPos={riderPos} queuePos={1}
            onAccept={() => onAccept(pool[0]!.id)} />
          {pool.length > 1 && (
            <button onClick={() => onGo('requests')} className="mt-2 w-full text-center text-xs font-semibold text-brand-charcoal">
              {pool.length - 1} more waiting behind this one →
            </button>
          )}
        </div>
      ) : (
        <Empty icon={online ? '📭' : '😴'}>
          {online ? 'No requests yet — new orders appear here.' : "You're offline. Go online to receive orders."}
        </Empty>
      )}
    </div>
  );
}

function StatCard({ label, value, hint, tint, icon, onClick }: {
  label: string; value: string; hint: string; tint: 'green' | 'purple'; icon: React.ReactNode; onClick: () => void;
}) {
  const tintCls = tint === 'green' ? 'bg-brand-orange/15 text-green-800' : 'bg-brand-charcoal/15 text-brand-charcoal';
  return (
    <button onClick={onClick} className="rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-black/5 transition hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-full ${tintCls}`}>{icon}</span>
        <span className="text-3xl font-black text-brand-ink">{value}</span>
      </div>
      <p className="mt-2 text-sm font-semibold">{label}</p>
      <p className="text-[11px] text-black/40">{hint}</p>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Request (pool) card
// ---------------------------------------------------------------------------

function riderEarn(o: RiderOrder): number {
  return riderEarnings({
    deliveryFee: o.delivery_fee, storeFeeTotal: o.store_fee_total,
    convenienceFee: o.convenience_fee, commission: o.commission_amount,
  });
}

const serviceTint: Record<string, string> = {
  food: 'bg-brand-orange/15 text-green-800',
  pabili: 'bg-brand-charcoal/15 text-brand-charcoal',
  padala: 'bg-brand-yellow/30 text-yellow-800',
};

/**
 * Order items grouped by store: each restaurant shows its name + phone, with its
 * items listed underneath — so a multi-store order is clear at a glance.
 */
/**
 * One line item on an active delivery, with the controls for what the counter
 * actually says.
 *
 * Taking an item off the bill is unilateral — the customer only ever pays less,
 * so waiting for a reply at the counter would help nobody. Correcting a price is
 * the same kind of act: our menu copy went stale, the rider is the one looking
 * at the real number, and the bill should say what the store charges. Both post
 * to the order chat, so the customer sees the change as it happens. Offering a
 * replacement is different — it stays off the bill until they accept, because
 * nobody should be charged for something they didn't pick.
 */
function ItemActions({ item, data, onChange }: {
  item: RiderOrder['items'][number]; data: RiderData; onChange: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'idle' | 'suggest' | 'price'>('idle');
  const [name, setName] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!item.id) return null;

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); await onChange(); setMode('idle'); }
    catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (mode === 'price') {
    const next = Number(price);
    const valid = price.trim() !== '' && Number.isFinite(next) && next >= 0;
    return (
      <div className="mt-1.5 rounded-lg bg-white p-2 ring-1 ring-black/10">
        <p className="mb-1.5 text-[11px] font-medium text-black/60">
          Price at the store for {item.name} — ours says {peso(item.unitPrice - item.markup)}
        </p>
        <div className="flex gap-1.5">
          <input type="number" inputMode="decimal" min={0} step="0.01" autoFocus
            value={price} onChange={(e) => setPrice(e.target.value)} placeholder="₱"
            className="w-24 shrink-0 rounded-lg border border-black/10 px-2 py-1.5 text-sm" />
          <button disabled={busy || !valid}
            onClick={() => void run(() => data.correctItemPrice(item.id!, next))}
            className="flex-1 rounded-lg bg-brand-orange py-1.5 text-xs font-bold text-white disabled:opacity-50">
            {busy ? 'Saving…' : 'Correct the bill'}
          </button>
          <button onClick={() => setMode('idle')} className="rounded-lg border border-black/15 px-2 text-xs text-black/60">Cancel</button>
        </div>
        {/* They type the shelf price; the customer's line is that plus our
            mark-up, so the preview has to show the billed figure. */}
        {valid && next + item.markup !== item.unitPrice && (
          <p className="mt-1 text-[11px] text-black/50">
            {item.qty} × {peso(next + item.markup)} = <span className="font-semibold">{peso((next + item.markup) * item.qty)}</span>
            {' · '}{next + item.markup > item.unitPrice ? 'customer pays' : 'customer saves'}{' '}
            {peso(Math.abs(next + item.markup - item.unitPrice) * item.qty)}
          </p>
        )}
        {/* The order is repriced the moment they tap; the menu only follows if
            the office agrees. Saying so stops riders re-reporting the same item
            every shift wondering why nothing changed. */}
        {item.menuItemId && (
          <p className="mt-1 text-[11px] text-black/40">
            Also sent to the office — if they approve it, our menu is updated for everyone.
          </p>
        )}
        {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
      </div>
    );
  }

  if (mode === 'suggest') {
    return (
      <div className="mt-1.5 rounded-lg bg-white p-2 ring-1 ring-black/10">
        <p className="mb-1.5 text-[11px] font-medium text-black/60">Suggest instead of {item.name}</p>
        <div className="flex gap-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Item name"
            className="min-w-0 flex-1 rounded-lg border border-black/10 px-2 py-1.5 text-sm" />
          <input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)}
            className="w-12 shrink-0 rounded-lg border border-black/10 px-2 py-1.5 text-sm" />
          <input type="number" inputMode="decimal" min={0} value={price} onChange={(e) => setPrice(e.target.value)}
            placeholder="₱" className="w-20 shrink-0 rounded-lg border border-black/10 px-2 py-1.5 text-sm" />
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <button disabled={busy || !name.trim() || !(Number(price) >= 0)}
            onClick={() => void run(() => data.proposeReplacement(item.id!, name.trim(), Math.max(1, Number(qty) || 1), Number(price) || 0))}
            className="flex-1 rounded-lg bg-brand-charcoal py-1.5 text-xs font-bold text-white disabled:opacity-50">
            {busy ? 'Sending…' : 'Ask the customer'}
          </button>
          <button onClick={() => setMode('idle')} className="rounded-lg border border-black/15 px-2 text-xs text-black/60">Cancel</button>
        </div>
        {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
      </div>
    );
  }

  return (
    <div className="mt-1 flex gap-1.5">
      <button disabled={busy} onClick={() => void run(() => data.markSoldOut(item.id!))}
        className="rounded-lg border border-red-300 px-2 py-1 text-[11px] font-medium text-red-600 disabled:opacity-50">
        Sold out
      </button>
      <button disabled={busy} onClick={() => { setPrice(String(item.unitPrice)); setMode('price'); }}
        className="rounded-lg border border-brand-orange/50 px-2 py-1 text-[11px] font-medium text-green-700 disabled:opacity-50">
        💲 Price differs
      </button>
      <button disabled={busy} onClick={() => { setName(''); setPrice(''); setQty(String(item.qty)); setMode('suggest'); }}
        className="rounded-lg border border-brand-charcoal/40 px-2 py-1 text-[11px] font-medium text-brand-charcoal disabled:opacity-50">
        🔁 Suggest another
      </button>
      {err && <span className="text-[11px] text-red-600">{err}</span>}
    </div>
  );
}

/** The line under a store's items: the cash to hand that counter. */
function CounterTotal({ items }: { items: RiderOrder['items'] }) {
  const due = counterTotal(items);
  if (due <= 0) return null;
  const dropped = items.some((i) => i.status === 'sold_out' || i.status === 'proposed');
  return (
    <div className="mt-2 flex items-baseline justify-between border-t border-black/10 pt-2">
      <span className="text-xs font-semibold text-black/60">
        Pay this store{dropped && <span className="ml-1 font-normal text-black/40">(sold-out excluded)</span>}
      </span>
      <span className="text-sm font-black text-brand-charcoal">{peso(due)}</span>
    </div>
  );
}

function StoreGroups({ order, data, onChange }: {
  order: RiderOrder; data?: RiderData; onChange?: () => Promise<void>;
}) {
  const byStore = new Map<string, RiderOrder['items']>();
  const noStore: RiderOrder['items'] = [];
  // Declined suggestions and swapped-out originals are history, not the bag.
  for (const it of order.items.filter((i) => i.status !== 'removed' && i.status !== 'replaced')) {
    if (it.store_id) byStore.set(it.store_id, [...(byStore.get(it.store_id) ?? []), it]);
    else noStore.push(it);
  }

  const ItemRow = (it: RiderOrder['items'][number], j: number) => {
    const gone = it.status === 'sold_out';
    const waiting = it.status === 'proposed';
    return (
      <li key={it.id ?? j}>
        <div className="flex justify-between gap-2">
          <span className={`min-w-0 ${gone ? 'text-black/35' : ''}`}>
            <span className={gone ? 'line-through' : ''}>
              <span className="font-medium">{it.qty}×</span> {it.name}
            </span>
            {gone && <span className="ml-1.5 text-[11px] font-medium text-red-500">sold out</span>}
            {waiting && <span className="ml-1.5 text-[11px] font-medium text-brand-charcoal">awaiting customer</span>}
            {it.notes && <span className="block text-xs text-black/45">— {it.notes}</span>}
          </span>
          {it.unitPrice > 0 && (
            <span className={`shrink-0 text-right ${gone || waiting ? 'text-black/35' : 'text-black/50'}`}>
              {peso(it.unitPrice * it.qty)}
              {/* Part of that price is ours, not the shop's — say what to hand
                  over at the counter so the rider doesn't overpay. */}
              {it.markup > 0 && !gone && !waiting && (
                <span className="block text-[11px] text-brand-charcoal">
                  pay {peso((it.unitPrice - it.markup) * it.qty)}
                </span>
              )}
            </span>
          )}
        </div>
        {data && onChange && !gone && !waiting && (
          <ItemActions item={it} data={data} onChange={onChange} />
        )}
      </li>
    );
  };

  if (order.stores.length === 0 && noStore.length === 0) return null;

  // A pabili run names its stores on the order itself, so its items point at
  // that list by index rather than at a registered store. Group them the way a
  // food order groups by restaurant: a rider standing in one shop should see
  // that shop's lines, not the whole errand.
  const byBuyStore = new Map<number, RiderOrder['items']>();
  const anyStore: RiderOrder['items'] = [];
  for (const it of noStore) {
    const idx = it.buyStoreIndex;
    if (idx != null && order.buyStores[idx]) byBuyStore.set(idx, [...(byBuyStore.get(idx) ?? []), it]);
    else anyStore.push(it);
  }
  const splitByBuyStore = byBuyStore.size > 0;

  return (
    <div className="mt-3 space-y-2">
      {order.stores.map((s, i) => {
        const items = (s.id && byStore.get(s.id)) || [];
        return (
          <div key={s.id ?? i} className="rounded-xl bg-brand-charcoal/[0.06] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-bold">{s.name ?? 'Store'}</p>
              <span className="flex shrink-0 items-center gap-2">
                {s.contact
                  ? <a href={`tel:${s.contact}`} aria-label={`Call ${s.name ?? 'store'}`}
                      className="inline-flex items-center gap-1 text-sm font-semibold text-brand-charcoal"><PhoneIcon /> {s.contact}</a>
                  : <span className="text-[11px] text-black/40">No number</span>}
                {s.lat != null && s.lng != null && (
                  <a href={directionsTo({ lat: s.lat, lng: s.lng })} target="_blank" rel="noreferrer"
                    aria-label={`Navigate to ${s.name ?? 'store'}`}
                    className="rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-brand-charcoal">
                    🧭 Go
                  </a>
                )}
              </span>
            </div>
            {items.length > 0 && (
              <>
                <ul className="mt-2 space-y-1 text-sm">{items.map(ItemRow)}</ul>
                <CounterTotal items={items} />
              </>
            )}
          </div>
        );
      })}
      {/* Pabili: one block per named store, in visiting order. */}
      {splitByBuyStore && order.buyStores.map((st, i) => {
        const items = byBuyStore.get(i) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={`buy-${i}`} className="rounded-xl bg-brand-charcoal/[0.06] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-bold">
                <span className="mr-1.5 text-black/40">{i + 1}.</span>🛒 {st.name}
              </p>
              {st.lat != null && st.lng != null && (
                <a href={directionsTo({ lat: st.lat, lng: st.lng })} target="_blank" rel="noreferrer"
                  aria-label={`Navigate to ${st.name}`}
                  className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-brand-charcoal">
                  🧭 Go
                </a>
              )}
            </div>
            <ul className="mt-2 space-y-1 text-sm">{items.map(ItemRow)}</ul>
            <CounterTotal items={items} />
          </div>
        );
      })}

      {anyStore.length > 0 && (
        <div className="rounded-xl bg-black/[0.03] p-3">
          <p className="mb-1.5 text-xs font-semibold text-black/60">
            {splitByBuyStore ? '🛒 Any store — buy wherever you can' : 'Order'}
          </p>
          <ul className="space-y-1 text-sm">{anyStore.map(ItemRow)}</ul>
          <CounterTotal items={anyStore} />
        </div>
      )}
    </div>
  );
}

/**
 * Everywhere the rider has to reach before the drop-off, in visiting order:
 * the registered store(s) on a food order, the ad-hoc shops on a pabili run,
 * or the single pickup pin a padala starts from.
 */
function pickupStops(order: RiderOrder): { name: string; lat: number; lng: number }[] {
  const stops: { name: string; lat: number; lng: number }[] = [];
  for (const s of order.stores) {
    if (s.lat != null && s.lng != null) stops.push({ name: s.name ?? 'Store', lat: s.lat, lng: s.lng });
  }
  for (const s of order.buyStores) {
    if (s.lat != null && s.lng != null) stops.push({ name: s.name, lat: s.lat, lng: s.lng });
  }
  if (stops.length === 0 && order.pickupLat != null && order.pickupLng != null) {
    stops.push({
      name: order.service_type === 'padala' ? 'Pickup point' : 'Buy here',
      lat: order.pickupLat, lng: order.pickupLng,
    });
  }
  return stops;
}

/** Turn-by-turn to a pin, in whatever maps app the phone uses. */
const directionsTo = (p: { lat: number; lng: number }) =>
  `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

/** How far the rider is from the first stop, or null without a fix / a pin. */
function distanceToPickup(order: RiderOrder, from: LatLng | null): number | null {
  const first = pickupStops(order)[0];
  return from && first ? haversineMeters(from, first) : null;
}

/**
 * Who the order is for. A name makes the call at the door ("Ma'am Maria?")
 * land better than reading a number back at someone — and riders asked for it,
 * because a phone number alone tells them nothing about who they're meeting.
 */
function CustomerLine({ name, contact }: { name: string | null; contact: string }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-charcoal/10 text-xs font-bold text-brand-charcoal">
        {(name?.trim()[0] ?? '👤').toUpperCase()}
      </span>
      <span className="min-w-0">
        {name?.trim()
          ? <span className="block truncate text-sm font-semibold text-brand-ink">{name.trim()}</span>
          : <span className="block text-xs text-black/40">Name not given</span>}
        <a href={`tel:${contact}`} className="inline-flex items-center gap-1 text-xs text-brand-charcoal">
          <PhoneIcon /> {contact}
        </a>
      </span>
    </div>
  );
}

/**
 * Where the pickup is, before the rider commits to the run.
 *
 * Stores are pinned when they're registered, so the pool card can say how far
 * away the counter is — the difference between a run around the corner and one
 * across town — and open the route without accepting first.
 */
function StoreRoute({ order, stops, away, open, onToggle }: {
  order: RiderOrder;
  stops: { name: string; lat: number; lng: number }[];
  away: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const first = stops[0]!;
  return (
    <div className="mt-2 rounded-xl bg-brand-orange/[0.07] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-green-900">
            🏬 {first.name}{stops.length > 1 ? ` +${stops.length - 1} more` : ''}
          </span>
          <span className="text-[11px] text-green-900/70">
            {away == null ? 'Pinned on the map' : `${formatDistance(away)} from you`}
          </span>
        </span>
        <span className="flex shrink-0 gap-1.5">
          <button onClick={onToggle}
            className="rounded-lg border border-green-900/15 px-2 py-1 text-[11px] font-semibold text-green-900">
            {open ? 'Hide map' : 'Map'}
          </button>
          <a href={directionsTo(first)} target="_blank" rel="noreferrer"
            className="rounded-lg bg-brand-orange px-2 py-1 text-[11px] font-bold text-white">
            🧭 Navigate
          </a>
        </span>
      </div>
      {open && (
        <div className="mt-2">
          <DeliveryMap height={170}
            dropoff={order.deliveryLat != null && order.deliveryLng != null
              ? { lat: order.deliveryLat, lng: order.deliveryLng } : null}
            stores={stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng }))} />
          {stops.length > 1 && (
            <ol className="mt-1.5 space-y-1">
              {stops.slice(1).map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-[11px] text-green-900">
                  <span className="min-w-0 truncate">{i + 2}. {s.name}</span>
                  <a href={directionsTo(s)} target="_blank" rel="noreferrer" className="shrink-0 font-semibold underline">
                    Route
                  </a>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** Explains the queue once, above the pool, instead of on every locked card. */
function QueueNote({ waiting }: { waiting: number }) {
  return (
    <p className="rounded-2xl bg-brand-charcoal/[0.07] px-4 py-3 text-xs text-brand-charcoal">
      <span className="font-bold">First come, first served.</span> The request at the top is the one
      to take — {waiting} waiting right now. Leave it and it stays there for whoever takes it first.
    </p>
  );
}

function RequestCard({ order, riderPos, queuePos = 1, locked = false, onAccept }: {
  order: RiderOrder; riderPos?: LatLng | null; queuePos?: number; locked?: boolean;
  onAccept: () => void;
}) {
  const [mapOpen, setMapOpen] = useState(false);
  const stops = pickupStops(order);
  const away = distanceToPickup(order, riderPos ?? null);

  if (locked) {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-white/70 px-4 py-3 ring-1 ring-black/5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.06] text-xs font-black text-black/40">
          {queuePos}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-black/45">
            {order.isTransfer && '🔄 '}
            {order.item_description ?? (order.service_type === 'food' ? 'Food order' : 'Delivery')}
            {stops[0] && <span className="font-normal"> · {stops[0].name}</span>}
          </span>
          <span className="block text-[11px] text-black/35">
            {peso(riderEarn(order))} · opens up once #1 is answered
          </span>
        </span>
        <span className="shrink-0 text-black/25">🔒</span>
      </div>
    );
  }

  return (
    <div className={`overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ${order.isTransfer ? 'ring-2 ring-brand-yellow' : 'ring-black/5'}`}>
      {order.isTransfer && (
        <div className="bg-brand-yellow/30 px-4 py-2">
          <p className="text-xs font-bold text-yellow-900">
            🔄 Transfer{order.transferReason ? ` · ${order.transferReason}` : ''}
          </p>
          {order.transferHadGoods && (
            <p className="mt-0.5 text-[11px] text-yellow-900/80">
              ⚠️ Items already bought — you'll take them over from the previous rider.
            </p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between px-4 pt-4">
        <span className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${serviceTint[order.service_type] ?? 'bg-black/5'}`}>
            {order.service_type}
          </span>
          <span className="rounded-full bg-brand-orange/15 px-2 py-0.5 text-[11px] font-bold text-green-800">
            #{queuePos} · yours to answer
          </span>
        </span>
        <span className="rounded-full bg-brand-ink px-2.5 py-1 text-xs font-bold text-white">{peso(riderEarn(order))}</span>
      </div>
      <div className="px-4 py-3">
        {order.isTransfer && (order.transferredFromName || order.transferredFromContact) && (
          <PreviousRider name={order.transferredFromName} contact={order.transferredFromContact} />
        )}
        <p className="text-sm font-semibold">
          {order.item_description ?? (order.service_type === 'food' ? 'Food order' : 'Delivery')}
        </p>
        <CustomerLine name={order.customerName} contact={order.customer_contact} />
        {stops.length > 0 && (
          <StoreRoute order={order} stops={stops} away={away} open={mapOpen} onToggle={() => setMapOpen((v) => !v)} />
        )}
        <StoreGroups order={order} />
        {order.notes && (
          <p className="mt-2 rounded-lg bg-brand-yellow/20 px-2.5 py-1.5 text-xs text-yellow-900">📝 {order.notes}</p>
        )}
        <p className="mt-2 text-xs text-black/45">
          You earn <span className="font-bold text-green-700">{peso(riderEarn(order))}</span>
          <span className="text-black/35"> · after {peso(order.commission_amount)} commission</span>
        </p>
      </div>
      <div className="border-t border-black/5 p-3">
        <button onClick={onAccept}
          className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-bold text-white hover:brightness-95">
          Accept
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active delivery card
// ---------------------------------------------------------------------------

function nextStatus(order: RiderOrder): OrderStatus | null {
  const flow = ORDER_FLOW[order.service_type];
  const i = flow.indexOf(order.status);
  return i >= 0 && i < flow.length - 1 ? flow[i + 1]! : null;
}

const STATUS_ACTION: Record<OrderStatus, string> = {
  pending: 'Accept', accepted: 'Accepted', preparing: 'Mark preparing',
  picked_up: 'Picked up', on_the_way: 'On the way',
  delivered: 'Mark as completed', cancelled: 'Cancelled',
};

/** The full customer total (what COD collects / what a GCash-to-rider QR charges). */
function fullCollectible(o: RiderOrder): number | null {
  if (o.service_type === 'padala') return o.delivery_fee;
  if (o.service_type === 'pabili') {
    if (o.actual_amount == null) return null;
    return pabiliCollectible({
      actualGoods: o.actual_amount,
      deliveryFee: o.delivery_fee,
      storeFeeTotal: o.store_fee_total,
      convenienceFee: o.convenience_fee,
    });
  }
  // Food: goods + delivery + store + convenience.
  return o.goods_cost + o.delivery_fee + o.store_fee_total + o.convenience_fee;
}

function amountToCollect(o: RiderOrder): number | null {
  // Paid to the rider via GCash QR — no cash to collect at the door.
  if (o.payment_method === 'rider_qr') return 0;
  // "Pay online" takes no money yet (no gateway), so it collects like COD.
  return fullCollectible(o);
}

/**
 * GCash-to-rider payment proof.
 *
 * The customer can upload their receipt in the app, but plenty just hold up
 * their phone at the door — so the rider can record the payment either way.
 * Confirming is never a precondition for completing the delivery.
 */
function PaymentProof({ order, data, onChange }:
  { order: RiderOrder; data: RiderData; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const paid = order.payment_status === 'paid';
  const uploaded = Boolean(order.paymentReceiptUrl);
  const amount = fullCollectible(order);

  async function confirm() {
    setBusy(true); setErr(null);
    try {
      await data.confirmPayment(order.id, uploaded ? 'Receipt uploaded in app' : 'Receipt shown in person');
      await onChange();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mt-3 rounded-xl p-3 ring-1 ${paid ? 'bg-green-50 ring-green-200' : 'bg-brand-charcoal/[0.06] ring-brand-charcoal/20'}`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-wide text-black/45">Customer payment</p>
        {amount != null && <span className="text-sm font-bold">{peso(amount)}</span>}
      </div>

      {uploaded ? (
        <a href={order.paymentReceiptUrl!} target="_blank" rel="noreferrer"
          className="mt-2 flex items-center gap-3 rounded-lg bg-white p-2 ring-1 ring-black/5">
          <img src={order.paymentReceiptUrl!} alt="Payment receipt"
            className="h-16 w-16 shrink-0 rounded-md object-cover" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-brand-ink">Receipt uploaded 📎</p>
            {order.paymentReference && (
              <p className="truncate text-xs text-black/50">Ref: {order.paymentReference}</p>
            )}
            <p className="text-[11px] text-brand-charcoal">Tap to view full size</p>
          </div>
        </a>
      ) : (
        <p className="mt-1.5 text-xs text-black/55">
          No receipt uploaded yet. If the customer shows you the GCash receipt on their
          phone, confirm it here.
        </p>
      )}

      {paid ? (
        <p className="mt-2 text-xs font-semibold text-green-700">
          ✓ Payment confirmed
          {order.paymentConfirmedAt ? ` · ${new Date(order.paymentConfirmedAt).toLocaleString()}` : ''}
        </p>
      ) : (
        <button onClick={confirm} disabled={busy}
          className="mt-2 w-full rounded-xl bg-brand-orange py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {busy ? 'Saving…' : uploaded ? '✓ Receipt checks out — mark paid' : '✓ Customer showed receipt — mark paid'}
        </button>
      )}
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}

/**
 * The customer wants an extra stop mid-run. It's the rider's trip, so it's the
 * rider's call — accepting bills another store fee and lifts the spending cap,
 * which also raises the commission on the order.
 */
function AddonRequests({ order, data, onChange }:
  { order: RiderOrder; data: RiderData; onChange: () => Promise<void> }) {
  const [addons, setAddons] = useState<OrderAddon[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setAddons(await data.getAddons(order.id)); } catch { /* ignore */ }
  }, [data, order.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const pending = addons.filter((a) => a.status === 'pending');
  if (pending.length === 0) return null;

  async function respond(id: string, accept: boolean) {
    setBusy(id); setErr(null);
    try { await data.respondToAddon(id, accept); await load(); await onChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <>
      {pending.map((a) => (
        <div key={a.id} className="mt-3 rounded-xl bg-brand-yellow/20 p-3 ring-1 ring-brand-yellow/50">
          <p className="text-sm font-bold text-brand-ink">➕ Customer wants another stop</p>
          <p className="mt-1 text-sm font-semibold">{a.store_name || 'No store given'}</p>
          {/* A store-backed request carries the exact basket, so the rider can
              judge the stop before agreeing to it. */}
          {a.items.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[13px]">
              {a.items.map((i, n) => (
                <li key={n} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{i.qty}× {i.name}</span>
                  <span className="shrink-0 text-black/50">{peso(i.qty * i.unitPrice)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm">{a.description}</p>
          )}
          <p className="mt-1 text-[11px] text-black/50">
            {a.est_amount > 0 ? `About ${peso(a.est_amount)} of goods · ` : ''}
            you earn the extra stop and convenience fees, and the delivery fee is worked out again
            for the longer route.
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => void respond(a.id, true)} disabled={busy === a.id}
              className="flex-1 rounded-lg bg-brand-orange py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy === a.id ? '…' : 'Accept the stop'}
            </button>
            <button onClick={() => void respond(a.id, false)} disabled={busy === a.id}
              className="flex-1 rounded-lg border border-black/15 py-2 text-sm font-medium text-black/60 disabled:opacity-50">
              Can’t do it
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-black/50">
            Accepting adds a store fee to the order — you earn on it, minus commission.
          </p>
          {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
        </div>
      ))}
    </>
  );
}

/**
 * The pabili shopping route, and the controls that fix a bad shop pin.
 *
 * Customers pin these shops from home, off memory or a map, and land a street —
 * sometimes a barangay — away. The rider is the one standing in the doorway.
 *
 * The first shop is special: it is stored as the order's pickup, so it is the
 * pin the per-km delivery fee is measured from. Correcting it re-quotes the fee
 * and tells the customer in the chat. Later shops are extra stops already paid
 * for by the store fee, so fixing those pins only helps navigation.
 */
function BuyStores({ order, data, onChange }: {
  order: RiderOrder; data?: RiderData; onChange?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (order.buyStores.length === 0) return null;

  const canFix = Boolean(data && onChange);

  function open(i: number) {
    const st = order.buyStores[i];
    setEditing(i);
    setErr(null); setDone(null);
    setPin(st?.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : null);
  }

  async function save(i: number) {
    if (!data || !onChange || !pin) return;
    setBusy(true); setErr(null);
    try {
      const res = await data.setBuyStoreLocation(order.id, i, pin);
      if (!res.updated) { setErr(res.message ?? 'That pin could not be used.'); return; }
      const fee = res.old_fee != null && res.new_fee != null && res.old_fee !== res.new_fee
        ? ` Delivery fee ${peso(res.old_fee)} → ${peso(res.new_fee)}.`
        : '';
      setDone(res.repriced
        ? `Pin moved.${fee || ' The fee is unchanged.'} The customer has been told in the chat.`
        : 'Pin moved. This is an extra stop, so the fee is unchanged.');
      setEditing(null);
      await onChange();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl bg-brand-charcoal/[0.06] p-3">
      <p className="mb-1.5 text-xs font-semibold text-black/60">
        🛒 Buy from {order.buyStores.length} store{order.buyStores.length === 1 ? '' : 's'}
      </p>
      <ol className="space-y-2 text-sm">
        {order.buyStores.map((st, i) => {
          const here = st.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : null;
          const moved = pin && here ? haversineMeters(pin, here) : null;
          return (
            <li key={i}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="mr-1.5 text-black/40">{i + 1}.</span>{st.name}
                  {here == null && <span className="ml-1.5 text-[11px] text-black/40">no pin</span>}
                </span>
                <a href={here ? directionsTo(here)
                      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(st.name)}`}
                  target="_blank" rel="noreferrer"
                  className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-brand-charcoal">
                  🧭 Go
                </a>
              </div>

              {canFix && editing !== i && (
                <button type="button" onClick={() => open(i)}
                  className="mt-1 rounded-lg border border-brand-charcoal/40 px-2 py-1 text-[11px] font-medium text-brand-charcoal">
                  {here == null ? '📍 Set the pin' : '📍 Shop isn\'t here? Fix the pin'}
                </button>
              )}

              {editing === i && (
                <div className="mt-1.5 rounded-xl bg-white/70 p-2.5 ring-1 ring-brand-charcoal/20">
                  <p className="mb-1.5 text-[11px] text-black/55">
                    {i === 0
                      ? 'Drag the pin onto the real shop, or tap “I’m here”. The delivery fee is worked out from this pin, so it will be re-priced and the customer told in the chat.'
                      : 'Drag the pin onto the real shop, or tap “I’m here”. This is an extra stop — the fee does not change.'}
                  </p>
                  <PinPicker value={pin} onChange={setPin} height={180} />
                  {moved != null && moved >= 20 && (
                    <p className="mt-1.5 text-[11px] text-black/50">
                      Moving it {formatDistance(moved)} from the customer's pin.
                    </p>
                  )}
                  {err && <p className="mt-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{err}</p>}
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => setEditing(null)} disabled={busy}
                      className="flex-1 rounded-lg border border-black/10 bg-white py-1.5 text-[11px] font-semibold text-black/60">
                      Cancel
                    </button>
                    <button type="button" onClick={() => void save(i)} disabled={busy || !pin}
                      className="flex-1 rounded-lg bg-brand-charcoal py-1.5 text-[11px] font-bold text-white disabled:opacity-50">
                      {busy ? 'Saving…' : 'Move the pin'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {done && (
        <p className="mt-1.5 rounded-lg bg-brand-orange/10 px-2.5 py-1.5 text-[11px] font-medium text-green-800">
          ✓ {done}
        </p>
      )}
      {order.store_fee_total > 0 && (
        <p className="mt-1.5 text-[11px] text-black/45">
          Extra stops · {peso(order.store_fee_total)} store fee on this order.
        </p>
      )}
    </div>
  );
}

function AddressLine({ label, address, icon }: { label: string; address: string; icon: string }) {
  return (
    <div className="mt-2 flex items-start justify-between gap-2 rounded-xl bg-brand-yellow/15 px-3 py-2">
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-black/45">{icon} {label}</span>
        <span className="block text-sm font-medium text-brand-ink">{address}</span>
      </span>
      <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
        target="_blank" rel="noreferrer" aria-label="Search this address on Maps"
        className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-[11px] font-medium text-brand-charcoal">
        Search
      </a>
    </div>
  );
}

/**
 * "This is not where they live."
 *
 * The customer pinned the wrong place and nobody found out until the rider was
 * standing in it. The customer's own fix stops working the moment the goods are
 * collected, which is almost always before the mistake surfaces — so this is
 * the rider's, and it works right up to delivery.
 *
 * The fee moves with the pin, because under per-km pricing the fee *is* the
 * distance. The database re-quotes it and tells the customer in the chat; the
 * rider never types a peso figure.
 */
function FixDropoffPin({ order, data, onChange }: {
  order: RiderOrder; data: RiderData; onChange: () => Promise<void>;
}) {
  const current = order.deliveryLat != null && order.deliveryLng != null
    ? { lat: order.deliveryLat, lng: order.deliveryLng } : null;
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState<LatLng | null>(current);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const moved = pin && current ? haversineMeters(pin, current) : null;

  async function save() {
    if (!pin) return;
    setBusy(true); setErr(null);
    try {
      const res = await data.correctDeliveryPin(order.id, pin, address.trim() || undefined);
      if (!res.updated) { setErr(res.message ?? 'That pin could not be used.'); return; }
      const fee = res.old_fee != null && res.new_fee != null && res.old_fee !== res.new_fee
        ? ` Delivery fee ${peso(res.old_fee)} → ${peso(res.new_fee)}.` : '';
      setDone(`Pin moved.${fee} The customer has been told in the chat.`);
      setOpen(false);
      await onChange();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done && !open) {
    return <p className="mt-2 rounded-lg bg-brand-orange/10 px-3 py-2 text-xs font-medium text-green-800">✓ {done}</p>;
  }

  if (!open) {
    return (
      <button type="button" onClick={() => { setPin(current); setOpen(true); }}
        className="mt-2 w-full rounded-lg border border-brand-charcoal/40 py-2 text-xs font-semibold text-brand-charcoal">
        📍 Wrong drop-off pin? Fix it
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-xl bg-brand-charcoal/[0.06] p-3 ring-1 ring-brand-charcoal/20">
      <p className="text-sm font-bold text-brand-charcoal">Put the pin where they actually are</p>
      <p className="mb-2 mt-0.5 text-[11px] text-black/55">
        The delivery fee is worked out by distance, so moving the pin re-prices it. The customer sees
        the change in the chat.
      </p>
      <PinPicker value={pin} onChange={setPin} />
      <input value={address} onChange={(e) => setAddress(e.target.value)}
        placeholder="Correct address (optional)"
        className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-xs" />
      {moved != null && moved >= 20 && (
        <p className="mt-1.5 text-[11px] text-black/50">Moving it {formatDistance(moved)} from the customer's pin.</p>
      )}
      {err && <p className="mt-1.5 rounded-lg bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{err}</p>}
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => setOpen(false)} disabled={busy}
          className="flex-1 rounded-lg border border-black/10 bg-white py-2 text-xs font-semibold text-black/60">
          Cancel
        </button>
        <button type="button" onClick={() => void save()} disabled={busy || !pin}
          className="flex-1 rounded-lg bg-brand-charcoal py-2 text-xs font-bold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Move the pin'}
        </button>
      </div>
    </div>
  );
}

function DeliveryCard({ order, data, onChange, payoutNumber, riderPos }:
  { order: RiderOrder; data: RiderData; onChange: () => Promise<void>; payoutNumber?: string | null; riderPos?: LatLng | null }) {
  const stops = pickupStops(order);
  const storeAway = riderPos && stops[0] ? haversineMeters(riderPos, stops[0]) : null;
  const [note, setNote] = useState<string | null>(null);
  const [arriving, setArriving] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseErr, setReleaseErr] = useState<string | null>(null);
  const next = nextStatus(order);
  const collect = amountToCollect(order);
  const isRiderQr = order.payment_method === 'rider_qr';
  // Amount encoded in the scan-to-pay QR: for GCash-to-rider, the full total.
  const qrAmount = isRiderQr ? fullCollectible(order) : collect;
  const needsActual = order.service_type === 'pabili' && order.actual_amount == null;

  useLocationPublisher(order.id, order.status);

  const hasGoods = order.status === 'picked_up' || order.status === 'on_the_way';

  /** Only worth offering once the goods are with the rider and moving. */
  const canAnnounceArrival = order.status === 'picked_up' || order.status === 'on_the_way';

  async function announceArrival() {
    setArriving(true);
    try { await data.markArrived(order.id); await onChange(); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setArriving(false); }
  }

  async function release() {
    const msg = hasGoods
      ? "You've already picked up the items for this order. Transfer it? It goes to the top of the pool as a transfer delivery, and you'll coordinate handing the items over to the rider who takes it.\n\nWhy can't you continue? (shown to the next rider)"
      : "Transfer this delivery back to the pool? It's prioritised so another rider takes it first.\n\nWhy can't you continue? (shown to the next rider)";
    const reason = window.prompt(msg, 'Breakdown');
    if (reason === null) return; // cancelled
    setReleasing(true); setReleaseErr(null);
    try { await data.releaseOrder(order.id, reason.trim() || undefined); await onChange(); }
    catch (e) { setReleaseErr(errMessage(e)); setReleasing(false); }
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      {/* Status banner */}
      <div className="flex items-center justify-between bg-brand-orange/10 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-bold text-green-800">
          <span className="h-2 w-2 animate-pulse rounded-full bg-brand-orange" />
          {order.status.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase())}
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${serviceTint[order.service_type] ?? 'bg-black/5'}`}>
          {order.service_type}
        </span>
      </div>

      <div className="p-4">
        <p className="text-sm font-semibold">
          {order.item_description ?? (order.service_type === 'food' ? 'Food order' : 'Delivery')}
        </p>

        {/* Live tracking map + navigation */}
        {(order.deliveryLat != null || stops.length > 0) && (
          <div className="mt-3">
            <DeliveryMap
              dropoff={order.deliveryLat != null && order.deliveryLng != null ? { lat: order.deliveryLat, lng: order.deliveryLng } : null}
              stores={stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng }))} />
            <div className="mt-2 flex gap-2">
              {/* Food orders carry no pickup pin — the route starts at the store's
                  own pin, which is why this reads the stops rather than pickup_lat. */}
              {stops[0] && (
                <a href={directionsTo(stops[0])} target="_blank" rel="noreferrer"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-orange py-2.5 text-sm font-bold text-white">
                  🧭 {order.service_type === 'padala' ? 'To pickup' : 'To store'}
                  {storeAway != null && <span className="font-medium opacity-80">· {formatDistance(storeAway)}</span>}
                </a>
              )}
              {order.deliveryLat != null && order.deliveryLng != null && (
                <a href={`https://www.google.com/maps/dir/?api=1&destination=${order.deliveryLat},${order.deliveryLng}`}
                  target="_blank" rel="noreferrer"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-charcoal py-2.5 text-sm font-bold text-white">
                  🧭 To drop-off
                </a>
              )}
            </div>
          </div>
        )}

        {order.pickupAddress && <AddressLine label="Pick up at" address={order.pickupAddress} icon="🛒" />}
        {order.deliveryAddress && <AddressLine label="Deliver to" address={order.deliveryAddress} icon="📍" />}
        {order.status !== 'delivered' && order.status !== 'cancelled' && (
          <FixDropoffPin order={order} data={data} onChange={onChange} />
        )}

        {/* What the customer ordered */}
        {/* Fee breakdown — so the delivery fee is always visible */}
        <div className="mt-3 space-y-1 rounded-xl bg-black/[0.03] p-3 text-sm">
          {order.goods_cost > 0 && (
            <div className="flex justify-between text-black/60">
              <span>{order.service_type === 'food' ? 'Food subtotal' : 'Goods'}</span><span>{peso(order.goods_cost)}</span>
            </div>
          )}
          <div className="flex justify-between font-medium">
            <span>Delivery fee</span><span className="text-green-700">{peso(order.delivery_fee)}</span>
          </div>
          {order.store_fee_total > 0 && (
            <div className="flex justify-between text-black/60">
              <span>Store fee</span><span>{peso(order.store_fee_total)}</span>
            </div>
          )}
          {order.convenience_fee > 0 && (
            <div className="flex justify-between text-black/60">
              <span>Convenience fee</span><span>{peso(order.convenience_fee)}</span>
            </div>
          )}
        </div>

        {/* Deliver-to (recipient if a gift order) + contact. */}
        {order.recipientContact ? (
          <>
            <div className="mt-3 flex items-center justify-between rounded-xl bg-black/[0.03] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs text-black/45">🎁 Deliver to</p>
                <p className="truncate text-sm font-medium">{order.recipientName || order.recipientContact}</p>
                {order.recipientName && <p className="truncate text-xs text-black/45">{order.recipientContact}</p>}
              </div>
              <div className="flex gap-2">
                <a href={`tel:${order.recipientContact}`} aria-label="Call recipient"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-orange text-white"><PhoneIcon /></a>
                <a href={`sms:${order.recipientContact}`} aria-label="Message recipient"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-charcoal text-white"><ChatIcon /></a>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between rounded-xl bg-black/[0.03] px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs text-black/45">Sender (pays)</p>
                <p className="truncate text-sm font-medium">{order.customerName || order.customer_contact}</p>
              </div>
              <a href={`tel:${order.customer_contact}`} aria-label="Call sender"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-charcoal text-white"><PhoneIcon /></a>
            </div>
          </>
        ) : (
          <div className="mt-3 flex items-center justify-between rounded-xl bg-black/[0.03] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs text-black/45">Customer</p>
              <p className="truncate text-sm font-medium">{order.customerName || order.customer_contact}</p>
              {order.customerName && <p className="truncate text-xs text-black/45">{order.customer_contact}</p>}
            </div>
            <div className="flex gap-2">
              <a href={`tel:${order.customer_contact}`} aria-label="Call customer"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-orange text-white"><PhoneIcon /></a>
              <a href={`sms:${order.customer_contact}`} aria-label="Message customer"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-charcoal text-white"><ChatIcon /></a>
            </div>
          </div>
        )}
        {/* Who handed this delivery over — kept after accepting so the new rider
            can still reach them to coordinate the hand-over. */}
        {(order.transferredFromName || order.transferredFromContact) && (
          <div className="mt-3">
            <PreviousRider name={order.transferredFromName} contact={order.transferredFromContact}
              reason={order.transferReason} hadGoods={order.transferHadGoods} />
          </div>
        )}

        <BuyStores order={order} data={data} onChange={onChange} />

        {/* Restaurant / store with its items grouped underneath. */}
        <StoreGroups order={order} data={data} onChange={onChange} />
        <div className="mt-2">
          <ChatButton orderId={order.id} role="rider"
            title={`Chat with ${order.recipientContact ? 'sender' : 'customer'}`}
            className="relative w-full rounded-xl bg-brand-charcoal py-2.5 text-sm font-bold text-white" />
        </div>
        {order.notes && (
          <p className="mt-2 rounded-lg bg-brand-yellow/20 px-2.5 py-1.5 text-xs text-yellow-900">📝 {order.notes}</p>
        )}

        {/* Extra-stop requests reach food orders too now, not just pabili. */}
        {order.status !== 'delivered' && <AddonRequests order={order} data={data} onChange={onChange} />}
        {order.service_type === 'pabili' && order.status !== 'delivered' && (
          <>
            <PabiliCalculator order={order} data={data} onChange={onChange} onNote={setNote} />
          </>
        )}
        {note && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">⚠️ {note}</p>}

        {order.payment_status !== 'paid' && order.status === 'on_the_way' && (
          <div className={`mt-3 flex flex-col items-center rounded-xl p-3 ${isRiderQr ? 'bg-brand-charcoal/[0.06] ring-1 ring-brand-charcoal/20' : 'bg-black/[0.02]'}`}>
            <p className="mb-2 text-xs font-medium text-black/60">
              {isRiderQr
                ? <>Customer pays by GCash — let them scan to send <span className="font-bold text-brand-ink">{qrAmount != null ? peso(qrAmount) : ''}</span></>
                : 'Let the customer scan to pay'}
            </p>
            <Qr payload={payoutNumber ? `ebd://pay?to=${encodeURIComponent(payoutNumber)}&amount=${qrAmount ?? 0}` : `ebd://pay?order=${order.id}&amount=${qrAmount ?? 0}`} />
            {payoutNumber
              ? <p className="mt-2 text-xs text-black/60">GCash/Maya: <span className="font-semibold text-brand-ink">{payoutNumber}</span></p>
              : <p className="mt-2 text-[11px] text-black/35">Set your GCash/Maya number in Settings</p>}
          </div>
        )}

        {/* GCash-to-rider: check the receipt (uploaded or shown in person). */}
        {isRiderQr && order.status !== 'cancelled' && (
          <PaymentProof order={order} data={data} onChange={onChange} />
        )}

        {canAnnounceArrival && (
          order.arrivedAt ? (
            <p className="mt-3 rounded-xl bg-brand-orange/10 px-3 py-2 text-center text-xs font-medium text-green-800">
              ✅ Customer alerted that you're outside ·{' '}
              {new Date(order.arrivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </p>
          ) : (
            <button onClick={announceArrival} disabled={arriving}
              className="mt-3 w-full rounded-xl bg-brand-yellow py-3 text-sm font-extrabold text-yellow-900 disabled:opacity-50">
              {arriving ? 'Telling them…' : "🔔 I've arrived — tell the customer"}
            </button>
          )
        )}

        {/* Collect + advance */}
        <div className="mt-3 flex items-center justify-between border-t border-black/5 pt-3">
          <span className="text-sm">
            {order.payment_status === 'paid'
              ? isRiderQr
                ? <span className="text-green-700">✓ Paid by GCash to you — no cash to collect</span>
                : <span className="text-green-700">✓ Paid online{collect ? ` · collect ${peso(collect)} goods` : ' · nothing to collect'}</span>
              : isRiderQr
                ? <span className="text-brand-charcoal">GCash to rider{qrAmount != null ? ` · ${peso(qrAmount)}` : ''} — no cash to collect</span>
                : collect == null
                  ? <span className="text-black/50">
                      Collect: save the receipt total first
                      {order.estimated_amount != null && (
                        <span className="block text-xs">
                          about {peso(order.estimated_amount + order.delivery_fee + order.convenience_fee)} at the customer's estimate
                        </span>
                      )}
                    </span>
                  : <>Collect <span className="font-bold">{peso(collect)}</span></>}
          </span>
          {next && (
            <button disabled={next === 'delivered' && needsActual}
              onClick={async () => { await data.advance(order, next); await onChange(); }}
              className="rounded-xl bg-brand-orange px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
              {STATUS_ACTION[next]}
            </button>
          )}
        </div>

        {/* Breakdown / can't-continue handoff: return to the pool. */}
        <button onClick={release} disabled={releasing}
          className="mt-3 w-full rounded-xl border border-red-300 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">
          {releasing ? 'Transferring…' : '⚠️ Can’t continue — transfer delivery'}
        </button>
        {hasGoods && (
          <p className="mt-1.5 text-center text-[11px] text-black/45">
            You already have the items — coordinate the hand-over with the rider who takes it.
          </p>
        )}
        {releaseErr && <p className="mt-2 text-xs text-red-600">{releaseErr}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Earnings / settlement
// ---------------------------------------------------------------------------

const RANGE_CHIPS: RangePreset[] = ['today', 'week', 'month', 'all'];

/**
 * What the rider actually made, over whatever span they pick.
 *
 * The commission ledger below answers "what do I owe?"; this answers the
 * question riders ask first — "how much did I make?" — and the calendar is
 * there because "this week" and "the 15th to the 30th" are both real questions
 * when you're working out whether the week paid for itself.
 */
function EarningsBoard({ data }: { data: RiderData }) {
  const [preset, setPreset] = useState<RangePreset>('week');
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(() => shiftDay(today, -6));
  const [to, setTo] = useState(today);
  const [records, setRecords] = useState<EarningRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const range = customOpen ? normalizeRange({ from, to }) : presetRange(preset, today);

  useEffect(() => {
    let alive = true;
    setRecords(null); setErr(null);
    data.getEarnings(range.from, range.to)
      .then((r) => { if (alive) setRecords(r); })
      .catch((e) => { if (alive) { setErr(errMessage(e)); setRecords([]); } });
    return () => { alive = false; };
  }, [data, range.from, range.to]);

  const summary = useMemo(() => summarizeEarnings(records ?? []), [records]);
  const loading = records === null;
  const heading = customOpen
    ? `${dayLabel(range.from, today)} – ${dayLabel(range.to, today)}`
    : RANGE_LABELS[preset];

  const chipCls = (on: boolean) =>
    `rounded-full px-3 py-1.5 text-xs font-semibold transition ${
      on ? 'bg-brand-ink text-white' : 'bg-white text-black/55 ring-1 ring-black/10'}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {RANGE_CHIPS.map((p) => (
          <button key={p} onClick={() => { setPreset(p); setCustomOpen(false); }}
            className={chipCls(!customOpen && preset === p)}>
            {RANGE_LABELS[p]}
          </button>
        ))}
        <button onClick={() => setCustomOpen((v) => !v)} className={chipCls(customOpen)}>
          📅 Pick dates
        </button>
      </div>

      {customOpen && (
        <div className="flex items-end gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
          <label className="flex-1 text-[11px] font-medium text-black/45">
            From
            <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value || from)}
              className="mt-0.5 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm text-brand-ink" />
          </label>
          <label className="flex-1 text-[11px] font-medium text-black/45">
            To
            <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value || to)}
              className="mt-0.5 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm text-brand-ink" />
          </label>
        </div>
      )}

      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <p className="text-xs text-black/45">You earned · {heading}</p>
        <p className="mt-1 text-4xl font-black text-brand-ink">
          {loading ? <span className="text-black/20">…</span> : peso(summary.earned)}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-black/[0.03] py-2">
            <p className="text-sm font-bold text-brand-ink">{loading ? '—' : summary.deliveries}</p>
            <p className="text-[11px] text-black/45">Deliveries</p>
          </div>
          <div className="rounded-xl bg-black/[0.03] py-2">
            <p className="text-sm font-bold text-brand-ink">{loading ? '—' : peso(summary.perDelivery)}</p>
            <p className="text-[11px] text-black/45">Per delivery</p>
          </div>
          <div className="rounded-xl bg-black/[0.03] py-2">
            <p className="text-sm font-bold text-brand-ink">{loading ? '—' : peso(summary.commission)}</p>
            <p className="text-[11px] text-black/45">Commission</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-black/40">
          Take-home after commission. Goods money you front is repaid on top and isn't counted here.
        </p>
      </div>

      {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}

      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <p className="mb-2 text-sm font-semibold">Day by day</p>
        {loading ? (
          <p className="py-4 text-center text-sm text-black/35">Loading…</p>
        ) : summary.byDay.length === 0 ? (
          <p className="py-4 text-center text-sm text-black/40">No completed deliveries in this range.</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {summary.byDay.map((d) => (
              <li key={d.day} className="flex items-center justify-between py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-brand-ink">{dayLabel(d.day, today)}</span>
                  <span className="block text-[11px] text-black/40">
                    {d.deliveries} {d.deliveries === 1 ? 'delivery' : 'deliveries'} · {peso(d.commission)} commission
                  </span>
                </span>
                <span className="shrink-0 text-sm font-bold text-green-700">{peso(d.earned)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** "Today" / "Yesterday" / "Tue, 4 Aug" — how a rider reads a day. */
function dayLabel(day: string, todayDay: string): string {
  if (day === todayDay) return 'Today';
  if (day === shiftDay(todayDay, -1)) return 'Yesterday';
  return new Date(`${day}T00:00:00`).toLocaleDateString('en-PH', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

function EarningsView({ live, data, riderId, ledger, owed, overdue, onSettle }:
  { live: boolean; data: RiderData; riderId?: string; ledger: LedgerEntry[]; owed: number; overdue: number;
    onSettle: (extra?: { reference?: string; receiptUrl?: string }) => Promise<void> }) {
  const history = useMemo(() => [...ledger].sort((a, b) => b.businessDay.localeCompare(a.businessDay)), [ledger]);
  const [payOpen, setPayOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => { if (live && supabase) getAppSettings(supabase).then(setSettings).catch(() => {}); }, [live]);

  return (
    <div className="space-y-4">
      <SectionTitle>Earnings &amp; settlement</SectionTitle>

      <WalletPanel riderId={riderId} />

      <EarningsBoard data={data} />

      <div className="rounded-2xl bg-gradient-to-br from-brand-orange to-[#c4451f] p-5 text-white shadow-md">
        <p className="text-xs uppercase tracking-wide text-white/80">
          {owed < 0 ? 'The operator owes you' : 'Owed to operator'}
        </p>
        <p className="mt-1 text-3xl font-black">{peso(Math.abs(owed))}</p>
        {/* A charge with no explanation looks like a mistake, and a rider who
            thinks they have been shorted stops riding. A credit unexplained is
            just as bad — it reads as an error waiting to be taken back. */}
        {(() => {
          const split = owedByKind(ledger);
          const parts = [
            split.commission !== 0 ? `${peso(split.commission)} commission` : null,
            split.markup !== 0 ? `${peso(split.markup)} store mark-up you collected at the door` : null,
            split.adjustment !== 0
              ? `${peso(Math.abs(split.adjustment))} ${split.adjustment < 0 ? 'credited back to you' : 'adjustment'}`
              : null,
          ].filter(Boolean);
          return parts.length > 1 ? (
            <p className="mt-1 text-xs text-white/85">{parts.join(' · ')}</p>
          ) : null;
        })()}
        <p className="mt-1 text-xs text-white/85">
          {owed < 0
            ? 'This comes off your next commissions — nothing to settle today.'
            : 'Settle your commission before the end of the day — any unsettled balance locks your account at midnight until it\'s paid.'}
        </p>
        {owed > 0 && (
          <button onClick={() => setPayOpen(true)} className="mt-3 w-full rounded-xl bg-white py-2.5 text-sm font-bold text-brand-charcoal">
            Settle {peso(owed)} now
          </button>
        )}
        {overdue > 0 && (
          <p className="mt-2 rounded-lg bg-black/20 px-3 py-1.5 text-xs font-medium text-white">
            ⚠️ {peso(overdue)} overdue — your account is locked until you settle.
          </p>
        )}
      </div>

      {payOpen && (
        <SettleModal amount={owed} settings={settings} live={live}
          onClose={() => setPayOpen(false)}
          onSubmit={async (extra) => { await onSettle(extra); setPayOpen(false); }} />
      )}

      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <p className="mb-2 text-sm font-semibold">Commission history</p>
        {history.length === 0 ? (
          <p className="py-4 text-center text-sm text-black/40">No commission recorded yet.</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {/* A day can hold several entries — a commission, a mark-up, a
                credit — so the day alone is not a key. */}
            {history.map((e, i) => (
              <li key={`${e.businessDay}-${i}`} className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-black/60">{e.businessDay}</span>
                <span className="flex items-center gap-2">
                  <span className={`font-semibold ${e.amount < 0 ? 'text-green-700' : ''}`}>
                    {e.amount < 0 ? `− ${peso(-e.amount)}` : peso(e.amount)}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    e.amount < 0 ? 'bg-brand-orange/15 text-green-800'
                      : e.settled ? 'bg-brand-orange/15 text-green-800'
                      : 'bg-brand-yellow/30 text-yellow-800'}`}>
                    {e.amount < 0 ? 'Credit' : e.settled ? 'Settled' : 'Unsettled'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Payment sheet: shows the operator's GCash/QR and takes a receipt + reference. */
function SettleModal({ amount, settings, live, onClose, onSubmit }: {
  amount: number; settings: AppSettings | null; live: boolean;
  onClose: () => void; onSubmit: (extra?: { reference?: string; receiptUrl?: string }) => Promise<void>;
}) {
  const [reference, setReference] = useState('');
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const num = settings?.settlement_gcash_number ?? null;

  async function upload(file: File) {
    if (!supabase) return;
    setUploading(true); setErr(null);
    try { setReceiptUrl(await uploadSettlementReceipt(supabase, file)); }
    catch (e) { setErr(errMessage(e)); }
    finally { setUploading(false); }
  }
  async function submit() {
    setSubmitting(true); setErr(null);
    try { await onSubmit({ reference: reference.trim() || undefined, receiptUrl: receiptUrl ?? undefined }); }
    catch (e) { setErr(errMessage(e)); setSubmitting(false); }
  }
  function copyNum() {
    if (!num) return;
    void navigator.clipboard?.writeText(num).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 sm:items-center sm:justify-center sm:p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full overflow-y-auto rounded-t-3xl bg-white sm:max-w-md sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-black/5 px-5 py-4">
          <h3 className="text-lg font-extrabold">Settle {peso(amount)}</h3>
          <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full bg-black/5 text-black/60">✕</button>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-sm text-black/60">Send your commission to the operator, then submit your proof of payment.</p>

          {/* Operator GCash / QR */}
          <div className="rounded-2xl bg-brand-charcoal/[0.06] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-charcoal">Pay via GCash / Maya</p>
            {num ? (
              <>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-lg font-black text-brand-ink">{num}</p>
                    {settings?.settlement_gcash_name && <p className="text-sm text-black/55">{settings.settlement_gcash_name}</p>}
                  </div>
                  <button onClick={copyNum} className="shrink-0 rounded-lg bg-brand-charcoal px-3 py-1.5 text-xs font-bold text-white">
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                {settings?.settlement_qr_url && (
                  <img src={settings.settlement_qr_url} alt="GCash QR"
                    className="mx-auto mt-3 h-56 w-56 rounded-xl bg-white object-contain p-2 ring-1 ring-black/5" />
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-black/50">
                {live ? 'The operator hasn’t set their payment details yet — please contact them for where to send payment.'
                      : 'Payment details appear here once the operator sets them.'}
              </p>
            )}
          </div>

          {/* Proof of payment */}
          <div>
            <label className="mb-1 block text-sm font-medium">Reference number <span className="font-normal text-black/40">(optional)</span></label>
            <input value={reference} onChange={(e) => setReference(e.target.value)}
              placeholder="GCash reference #"
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm outline-none focus:border-brand-orange" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Receipt / screenshot <span className="font-normal text-red-500">*required</span></label>
            {receiptUrl ? (
              <div className="flex items-center gap-3">
                <img src={receiptUrl} alt="Receipt" className="h-20 w-20 rounded-lg object-cover ring-1 ring-black/10" />
                <button onClick={() => setReceiptUrl(null)} className="text-sm font-medium text-red-600">Remove</button>
              </div>
            ) : (
              <label className={`flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/20 py-3 text-sm font-medium text-black/60 ${!live ? 'pointer-events-none opacity-50' : ''}`}>
                {uploading ? 'Uploading…' : '＋ Upload receipt'}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              </label>
            )}
          </div>

          {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}

          <button onClick={submit} disabled={submitting || uploading || (live && !receiptUrl)}
            className="w-full rounded-xl bg-brand-orange py-3 font-bold text-white disabled:opacity-50">
            {submitting ? 'Submitting…' : `I’ve paid ${peso(amount)} — submit`}
          </button>
          <p className="text-center text-xs text-black/40">
            {live && !receiptUrl
              ? 'Upload your payment receipt to submit.'
              : 'The operator confirms your payment; your balance clears once confirmed.'}
          </p>
        </div>
      </div>
    </div>
  );
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="mb-3 text-sm font-bold">{title}</p>
      {children}
    </div>
  );
}

const settingsInp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

function SettingsView({ live, online, busy, onToggleOnline, profile, onProfileSaved }: {
  live: boolean; online: boolean; busy: boolean; onToggleOnline: () => void;
  profile: RiderProfile | null; onProfileSaved: () => Promise<void>;
}) {
  const canEdit = live && !!supabase;
  return (
    <div className="space-y-4">
      <SectionTitle>Settings</SectionTitle>
      <OnlineToggle online={online} busy={busy} onToggle={onToggleOnline} />

      {canEdit && profile && <ProfileSection profile={profile} onSaved={onProfileSaved} />}
      {canEdit && profile && <PayoutSection profile={profile} onSaved={onProfileSaved} />}
      {canEdit && profile && <ServicesSection profile={profile} onSaved={onProfileSaved} />}
      {canEdit && profile && <PushSection profile={profile} onSaved={onProfileSaved} />}

      <SoundSection />
      <LocationSection />

      <SettingsCard title="Help & support">
        <p className="mb-3 text-sm text-black/55">Reach the operator if you have an issue with an order or your account.</p>
        <div className="flex gap-2">
          {SUPPORT_PHONE && (
            <>
              <a href={`tel:${SUPPORT_PHONE.replace(/\s/g, '')}`}
                className="flex-1 rounded-xl bg-brand-orange py-2.5 text-center text-sm font-bold text-white">Call operator</a>
              <a href={`sms:${SUPPORT_PHONE.replace(/\s/g, '')}`}
                className="flex-1 rounded-xl bg-brand-charcoal py-2.5 text-center text-sm font-bold text-white">Message</a>
            </>
          )}
          <a href={`mailto:${SUPPORT_EMAIL}`}
            className="flex-1 rounded-xl bg-brand-charcoal py-2.5 text-center text-sm font-bold text-white">Email operator</a>
        </div>
      </SettingsCard>

      <SettingsCard title="About">
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between"><span className="text-black/55">App version</span><span className="font-medium">{APP_VERSION}</span></div>
          <div className="flex justify-between">
            <span className="text-black/55">Connection</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${live ? 'bg-brand-orange/15 text-green-800' : 'bg-brand-yellow/30 text-yellow-800'}`}>{live ? 'Live' : 'Preview mode'}</span>
          </div>
          <div className="flex gap-3 pt-1">
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="text-brand-charcoal">Privacy Policy</a>
            <a href={TERMS_URL} target="_blank" rel="noreferrer" className="text-brand-charcoal">Terms</a>
          </div>
        </div>
      </SettingsCard>

      {live && supabase && <DeleteAccount />}

      {live && supabase && (
        <button onClick={() => void signOut(supabase!)}
          className="w-full rounded-2xl bg-white py-3 text-sm font-bold text-red-600 shadow-sm ring-1 ring-black/5">
          Log out
        </button>
      )}
      {!canEdit && <p className="px-1 text-xs text-black/40">Connect the app to edit your profile.</p>}
      <p className="px-1 pb-2 text-center text-xs text-black/35">ServdGo — Rider · v{APP_VERSION}</p>
    </div>
  );
}

/** Reusable save wrapper: runs an update, reloads the profile, shows state. */
function useSaver(onSaved: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setSaved(false); setErr(null);
    try { await fn(); await onSaved(); setSaved(true); }
    catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }
  return { busy, saved, err, run, setSaved };
}

function ProfileSection({ profile, onSaved }: { profile: RiderProfile; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(profile.name);
  const [mobile, setMobile] = useState(profile.mobile_number);
  const [vehicle, setVehicle] = useState(profile.vehicle ?? '');
  const [photoBusy, setPhotoBusy] = useState(false);
  const { busy, saved, err, run, setSaved } = useSaver(onSaved);
  const dirty = name !== profile.name || mobile !== profile.mobile_number || vehicle !== (profile.vehicle ?? '');

  async function save() {
    await run(() => updateRiderProfile(supabase!, {
      name, mobile, vehicle,
      payoutNumber: profile.payout_number, services: profile.services_accepted,
      pushEnabled: profile.push_enabled, photoUrl: profile.photo_url,
    }));
  }
  async function pickPhoto(file: File) {
    setPhotoBusy(true);
    try {
      const url = await uploadRiderPhoto(supabase!, file);
      await updateRiderProfile(supabase!, {
        name: profile.name, mobile: profile.mobile_number, vehicle: profile.vehicle,
        photoUrl: url, payoutNumber: profile.payout_number,
        services: profile.services_accepted, pushEnabled: profile.push_enabled,
      });
      await onSaved();
    } catch { /* surfaced elsewhere */ } finally { setPhotoBusy(false); }
  }

  return (
    <SettingsCard title="Profile">
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-brand-orange/15 text-2xl">
          {profile.photo_url ? <img src={profile.photo_url} alt="" className="h-full w-full object-cover" /> : '🛵'}
        </span>
        <label className="cursor-pointer rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold text-black/70 hover:bg-black/[0.03]">
          {photoBusy ? 'Uploading…' : 'Change photo'}
          <input type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickPhoto(f); }} />
        </label>
      </div>
      <div className="space-y-2">
        <input className={settingsInp} placeholder="Full name" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
        <input className={settingsInp} placeholder="Mobile number" inputMode="tel" value={mobile} onChange={(e) => { setMobile(e.target.value); setSaved(false); }} />
        <input className={settingsInp} placeholder="Vehicle (e.g. motorcycle)" value={vehicle} onChange={(e) => { setVehicle(e.target.value); setSaved(false); }} />
      </div>
      <button onClick={save} disabled={busy || !dirty || !name.trim() || !mobile.trim()}
        className="mt-3 w-full rounded-lg bg-brand-orange py-2.5 text-sm font-bold text-white disabled:opacity-50">
        {busy ? 'Saving…' : saved ? '✓ Saved' : 'Save profile'}
      </button>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </SettingsCard>
  );
}

function PayoutSection({ profile, onSaved }: { profile: RiderProfile; onSaved: () => Promise<void> }) {
  const [num, setNum] = useState(profile.payout_number ?? '');
  const { busy, saved, err, run, setSaved } = useSaver(onSaved);
  const dirty = num !== (profile.payout_number ?? '');
  async function save() {
    await run(() => updateRiderProfile(supabase!, {
      name: profile.name, mobile: profile.mobile_number, vehicle: profile.vehicle,
      photoUrl: profile.photo_url, payoutNumber: num,
      services: profile.services_accepted, pushEnabled: profile.push_enabled,
    }));
  }
  return (
    <SettingsCard title="Payout · GCash / Maya">
      <p className="mb-2 text-sm text-black/55">Shown to customers at the door so they can pay you online instead of cash.</p>
      <input className={settingsInp} placeholder="GCash / Maya number" inputMode="tel"
        value={num} onChange={(e) => { setNum(e.target.value); setSaved(false); }} />
      <button onClick={save} disabled={busy || !dirty}
        className="mt-3 w-full rounded-lg bg-brand-orange py-2.5 text-sm font-bold text-white disabled:opacity-50">
        {busy ? 'Saving…' : saved ? '✓ Saved' : 'Save payout number'}
      </button>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </SettingsCard>
  );
}

function ServicesSection({ profile, onSaved }: { profile: RiderProfile; onSaved: () => Promise<void> }) {
  const { busy, run } = useSaver(onSaved);
  // null/empty accepted = all on.
  const accepted = new Set(profile.services_accepted ?? SERVICES.map((s) => s.key));
  function toggle(key: string) {
    const next = new Set(accepted);
    if (next.has(key)) next.delete(key); else next.add(key);
    const arr = SERVICES.map((s) => s.key).filter((k) => next.has(k));
    void run(() => updateRiderProfile(supabase!, {
      name: profile.name, mobile: profile.mobile_number, vehicle: profile.vehicle,
      photoUrl: profile.photo_url, payoutNumber: profile.payout_number,
      services: arr.length === SERVICES.length ? null : arr, // all → null
      pushEnabled: profile.push_enabled,
    }));
  }
  return (
    <SettingsCard title="Services I accept">
      <p className="mb-3 text-sm text-black/55">Only orders for the services you turn on will show in your pool.</p>
      <div className="divide-y divide-black/5">
        {SERVICES.map((s) => (
          <label key={s.key} className="flex items-center justify-between py-2.5">
            <span className="text-sm font-medium">{s.label}</span>
            <Switch on={accepted.has(s.key)} disabled={busy} onChange={() => toggle(s.key)} />
          </label>
        ))}
      </div>
    </SettingsCard>
  );
}

function PushSection({ profile, onSaved }: { profile: RiderProfile; onSaved: () => Promise<void> }) {
  const { busy, run } = useSaver(onSaved);
  function toggle() {
    void run(() => updateRiderProfile(supabase!, {
      name: profile.name, mobile: profile.mobile_number, vehicle: profile.vehicle,
      photoUrl: profile.photo_url, payoutNumber: profile.payout_number,
      services: profile.services_accepted, pushEnabled: !profile.push_enabled,
    }));
  }
  return (
    <SettingsCard title="Notifications">
      <label className="flex items-center justify-between">
        <span>
          <span className="block text-sm font-medium">New-order push alerts</span>
          <span className="block text-xs text-black/45">Get notified when orders enter the pool.</span>
        </span>
        <Switch on={profile.push_enabled} disabled={busy} onChange={toggle} />
      </label>
    </SettingsCard>
  );
}

/**
 * The alert sound, and a way to hear it on purpose.
 *
 * A rider who has never heard it cannot know whether it works, and finding out
 * during a shift is too late — so there is a Test button. The preference is per
 * device, not per account: the phone that is muted is the phone in the pocket.
 */
function SoundSection() {
  const [muted, setMuted] = useState(isAlertMuted);
  return (
    <SettingsCard title="Request alert sound">
      <label className="flex items-center justify-between">
        <span>
          <span className="block text-sm font-medium">Chime for new requests</span>
          <span className="block text-xs text-black/45">
            Sounds and buzzes when an order enters the pool, and repeats every 25s while it waits.
          </span>
        </span>
        <Switch on={!muted} onChange={() => { const next = !muted; setMuted(next); setAlertMuted(next); }} />
      </label>
      <button type="button" onClick={() => playNewOrderAlert()}
        className="mt-3 w-full rounded-xl border border-brand-charcoal/40 py-2 text-sm font-semibold text-brand-charcoal">
        🔔 Play it now
      </button>
      <p className="mt-2 text-xs text-black/45">
        Hear nothing? Turn off silent mode and check the volume — a browser can only
        play sound after you've tapped the screen at least once.
      </p>
    </SettingsCard>
  );
}

function LocationSection() {
  const [state, setState] = useState<string>('checking');
  useEffect(() => {
    if (!('permissions' in navigator) || !navigator.permissions?.query) { setState('unknown'); return; }
    navigator.permissions.query({ name: 'geolocation' as PermissionName })
      .then((p) => { setState(p.state); p.onchange = () => setState(p.state); })
      .catch(() => setState('unknown'));
  }, []);
  function enable() {
    navigator.geolocation?.getCurrentPosition(() => setState('granted'), () => setState('denied'));
  }
  const label = state === 'granted' ? 'Allowed' : state === 'denied' ? 'Blocked' : state === 'prompt' ? 'Not set' : '—';
  const tint = state === 'granted' ? 'bg-brand-orange/15 text-green-800'
    : state === 'denied' ? 'bg-red-100 text-red-700' : 'bg-brand-yellow/30 text-yellow-800';
  return (
    <SettingsCard title="Location">
      <div className="flex items-center justify-between">
        <span>
          <span className="block text-sm font-medium">GPS permission</span>
          <span className="block text-xs text-black/45">Needed to share your location during delivery.</span>
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tint}`}>{label}</span>
      </div>
      {state !== 'granted' && (
        <button onClick={enable} className="mt-3 w-full rounded-lg bg-brand-charcoal py-2.5 text-sm font-bold text-white">
          Enable location
        </button>
      )}
    </SettingsCard>
  );
}

function Switch({ on, onChange, disabled = false }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button onClick={onChange} disabled={disabled} aria-pressed={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60 ${on ? 'bg-brand-orange' : 'bg-black/20'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[1.375rem]' : 'left-0.5'}`} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function OnlineToggle({ online, busy, onToggle }: { online: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} disabled={busy} aria-pressed={online}
      className={`flex w-full items-center justify-between rounded-2xl px-4 py-3.5 text-left shadow-sm ring-1 transition disabled:opacity-70 ${
        online ? 'bg-brand-orange text-white ring-brand-orange' : 'bg-white text-brand-ink ring-black/10'
      }`}>
      <span className="flex items-center gap-2.5">
        <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-white' : 'bg-black/30'}`} />
        <span className="font-bold">{busy ? 'Saving…' : online ? "You're online" : "You're offline"}</span>
      </span>
      <span className={`relative h-6 w-11 rounded-full transition ${online ? 'bg-white/30' : 'bg-black/15'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${online ? 'left-[1.375rem]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

function LockCard({ overdue, onSettle, compact = false, wallet = false }: {
  overdue: number; onSettle: () => void; compact?: boolean; wallet?: boolean;
}) {
  return (
    <div className={`rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5 ${compact ? '' : 'mt-2'}`}>
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl">🔒</div>
      <h2 className="text-lg font-bold">Account locked</h2>
      <p className="mt-1 text-sm text-black/60">
        {wallet
          ? 'Your wallet ran short. Top it up to accept new orders.'
          : "Settle yesterday's commission balance to accept new orders."}
      </p>
      <p className="my-4 text-3xl font-black text-brand-charcoal">{peso(overdue)}</p>
      <button onClick={onSettle} className="w-full rounded-xl bg-brand-orange py-3 font-semibold text-white">
        {compact ? (wallet ? 'Go to wallet' : 'Go to settlement')
                 : wallet ? `Top up ${peso(overdue)} to continue` : `Settle ${peso(overdue)} to continue`}
      </button>
    </div>
  );
}

function OfflineCard({ onGoOnline, busy }: { onGoOnline: () => void; busy: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.05] text-2xl">😴</div>
      <h2 className="text-lg font-bold">You're offline</h2>
      <p className="mt-1 text-sm text-black/60">Go online to see the order pool and accept deliveries.</p>
      <button onClick={onGoOnline} disabled={busy}
        className="mt-4 w-full rounded-xl bg-brand-orange py-3 font-semibold text-white disabled:opacity-60">
        {busy ? 'Saving…' : 'Go online'}
      </button>
    </div>
  );
}

const SectionTitle = ({ children }: { children: React.ReactNode }) =>
  <h2 className="mb-2 text-lg font-extrabold">{children}</h2>;

const Empty = ({ children, icon = '📭' }: { children: React.ReactNode; icon?: string }) => (
  <div className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-black/5">
    <div className="mb-2 text-3xl">{icon}</div>
    <p className="text-sm text-black/50">{children}</p>
  </div>
);

function BottomNav({ tab, onTab, requests, deliveries }:
  { tab: Tab; onTab: (t: Tab) => void; requests: number; deliveries: number }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-black/5 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-2 py-1.5">
        <NavBtn active={tab === 'dashboard'} onClick={() => onTab('dashboard')} label="Dashboard" icon={<HomeIcon />} />
        <NavBtn active={tab === 'requests'} onClick={() => onTab('requests')} label="Requests" icon={<InboxIcon />} badge={requests} />
        <NavBtn active={tab === 'deliveries'} onClick={() => onTab('deliveries')} label="Deliveries" icon={<BoxIcon />} badge={deliveries} />
        <NavBtn active={tab === 'earnings'} onClick={() => onTab('earnings')} label="Earnings" icon={<WalletIcon />} />
        <NavBtn active={tab === 'settings'} onClick={() => onTab('settings')} label="Settings" icon={<GearIcon />} />
      </div>
    </nav>
  );
}

function NavBtn({ active, onClick, label, icon, badge = 0 }:
  { active: boolean; onClick: () => void; label: string; icon: React.ReactNode; badge?: number }) {
  return (
    <button onClick={onClick}
      className={`relative flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] font-semibold transition ${
        active ? 'text-brand-orange' : 'text-black/45 hover:text-black/70'
      }`}>
      <span className={`relative flex h-7 w-7 items-center justify-center rounded-full transition ${active ? 'bg-brand-orange/15' : ''}`}>
        {icon}
        {badge > 0 && (
          <span className="absolute -right-1.5 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-brand-charcoal px-1 text-[9px] font-bold text-white">
            {badge}
          </span>
        )}
      </span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const ic = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function HomeIcon() { return <svg {...ic}><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>; }
function InboxIcon() { return <svg {...ic}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z" /></svg>; }
function BoxIcon() { return <svg {...ic}><path d="M21 8V6a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 6v12a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 18z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></svg>; }
function WalletIcon() { return <svg {...ic}><path d="M20 7H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" /><path d="M2 9V7a2 2 0 0 1 2-2h13M17 13h.01" /></svg>; }
function GearIcon() { return <svg {...ic}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>; }
function BellIcon() { return <svg {...ic} width="20" height="20"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>; }
function PhoneIcon() { return <svg {...ic} width="14" height="14"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>; }
function ChatIcon() { return <svg {...ic} width="14" height="14"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" /></svg>; }

/**
 * Pabili goods calculator. The rider punches in each item's price; the running
 * total becomes the order's goods amount (what the customer repays). Stays
 * editable after saving so extra items the customer adds can be tacked on.
 */
/** A line in the pabili price sheet. `store` groups it under a heading. */
interface PriceRow { label: string; amount: string; store?: string | null }

function PabiliCalculator({ order, data, onChange, onNote }: {
  order: RiderOrder; data: RiderData; onChange: () => Promise<void>;
  onNote: (n: string | null) => void;
}) {
  const saved = order.actual_amount;
  const [open, setOpen] = useState(saved == null);
  // Start from the customer's shopping list so the rider just fills in prices
  // next to each item instead of retyping the whole thing.
  const [rows, setRows] = useState<PriceRow[]>(() => {
    const wanted = order.items.filter((i) => i.status !== 'removed' && i.status !== 'replaced');
    if (wanted.length === 0) return [{ label: '', amount: '' }];
    // Seeded in visiting order and tagged with the store, so the rider fills in
    // one shop's prices at a time instead of hunting up and down the list.
    const storeOf = (i: RiderOrder['items'][number]) =>
      i.buyStoreIndex != null ? order.buyStores[i.buyStoreIndex]?.name ?? null : null;
    const ordered = [...wanted].sort((a, b) =>
      (a.buyStoreIndex ?? Number.MAX_SAFE_INTEGER) - (b.buyStoreIndex ?? Number.MAX_SAFE_INTEGER));
    return ordered.map((i) => ({
      label: i.qty > 1 ? `${i.qty}x ${i.name}` : i.name,
      amount: '',
      store: storeOf(i),
    }));
  });
  const [busy, setBusy] = useState(false);
  // The customer pays this total, so it has to be backed by the store receipt.
  const [receiptUrl, setReceiptUrl] = useState<string | null>(order.goodsReceiptUrl);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cap = order.budget_cap ?? 0;

  const total = rows.reduce((sum, r) => {
    const n = Number(r.amount);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  const counted = rows.filter((r) => Number(r.amount) > 0).length;
  const overCap = cap > 0 && total > cap;

  function setRow(i: number, patch: Partial<PriceRow>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows((rs) => [...rs, { label: '', amount: '' }]); }
  function removeRow(i: number) {
    setRows((rs) => (rs.length === 1 ? [{ label: '', amount: '' }] : rs.filter((_, j) => j !== i)));
  }

  async function pickReceipt(file: File) {
    setUploading(true); setErr(null);
    try { setReceiptUrl(await data.uploadGoodsReceipt(order.id, file)); }
    catch (e) { setErr(errMessage(e)); }
    finally { setUploading(false); }
  }

  async function save() {
    if (total <= 0) return;
    setBusy(true); setErr(null);
    try {
      const res = await data.setActual(order, Math.round(total * 100) / 100, receiptUrl ?? undefined);
      onNote(res.overCap ? 'Over the cap — confirm with the customer before collecting.' : null);
      await onChange();
      setOpen(false);
    } catch (e) {
      setErr(errMessage(e));
    } finally { setBusy(false); }
  }

  // Saved and closed: show the total with an Edit button.
  if (!open) {
    return (
      <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-brand-yellow/15 p-3">
        <span className="flex min-w-0 items-center gap-2">
          {receiptUrl && (
            <a href={receiptUrl} target="_blank" rel="noreferrer" aria-label="View receipt photo">
              <img src={receiptUrl} alt="Store receipt" className="h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-black/10" />
            </a>
          )}
          <span className="min-w-0">
            <span className="block text-xs text-black/50">Goods total (receipt)</span>
            <span className="text-lg font-black">{peso(saved ?? 0)}</span>
          </span>
        </span>
        <button onClick={() => { setRows([{ label: 'Current total', amount: String(saved ?? '') }]); setOpen(true); }}
          className="shrink-0 rounded-lg bg-brand-charcoal px-3 py-2 text-sm font-semibold text-white">
          ✏️ Edit / add items
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl bg-brand-yellow/15 p-3">
      <p className="mb-2 text-xs font-medium">
        🧮 Add each item's price{cap > 0 && <span className="text-black/50"> · cap {peso(cap)}</span>}
      </p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i}>
            {/* One heading per store, where the list moves on to the next shop. */}
            {r.store && r.store !== rows[i - 1]?.store && (
              <p className="mb-1 mt-2 text-[11px] font-bold text-brand-charcoal">🛒 {r.store}</p>
            )}
            <div className="flex gap-2">
            <input value={r.label} onChange={(e) => setRow(i, { label: e.target.value })}
              placeholder={`Item ${i + 1}`}
              className="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm" />
            <input type="number" inputMode="decimal" min={0} value={r.amount}
              onChange={(e) => setRow(i, { amount: e.target.value })}
              placeholder="₱"
              className="w-24 shrink-0 rounded-lg border border-black/10 px-3 py-2 text-sm" />
            <button onClick={() => removeRow(i)} aria-label="Remove item"
              className="shrink-0 rounded-lg border border-black/10 px-2 text-sm text-black/40">✕</button>
            </div>
          </div>
        ))}
      </div>
      <button onClick={addRow}
        className="mt-2 w-full rounded-lg border border-dashed border-black/20 py-2 text-sm font-medium text-black/60">
        ＋ Add item
      </button>

      <div className="mt-3 flex items-center justify-between border-t border-black/10 pt-2">
        <span className="text-sm">
          Total <span className="text-xs text-black/45">({counted} item{counted === 1 ? '' : 's'})</span>
        </span>
        <span className={`text-xl font-black ${overCap ? 'text-red-600' : ''}`}>{peso(total)}</span>
      </div>
      {overCap && (
        <p className="mt-1 text-xs text-red-600">
          ⚠️ Over the {peso(cap)} cap — confirm with the customer before paying.
        </p>
      )}

      {/* The customer is billed this amount, so back it with the actual receipt. */}
      <div className="mt-3 border-t border-black/10 pt-2">
        <p className="text-xs font-medium">
          🧾 Photo of the store receipt <span className="font-normal text-black/40">(optional)</span>
        </p>
        {receiptUrl ? (
          <div className="mt-1 flex items-center gap-3">
            <a href={receiptUrl} target="_blank" rel="noreferrer">
              <img src={receiptUrl} alt="Store receipt" className="h-16 w-16 rounded-lg object-cover ring-1 ring-black/10" />
            </a>
            <span className="text-sm font-medium text-green-700">✓ Attached</span>
            <label className="cursor-pointer text-xs text-brand-charcoal underline">
              Replace
              <input type="file" accept="image/*" capture="environment" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickReceipt(f); e.target.value = ''; }} />
            </label>
          </div>
        ) : (
          <label className="mt-1 flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/25 py-3 text-sm font-medium text-black/60">
            {uploading ? 'Uploading…' : '📷 Attach receipt photo (optional)'}
            <input type="file" accept="image/*" capture="environment" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickReceipt(f); e.target.value = ''; }} />
          </label>
        )}
      </div>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}

      <div className="mt-2 flex gap-2">
        <button onClick={save} disabled={busy || total <= 0 || uploading}
          className="flex-1 rounded-lg bg-brand-charcoal py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {busy ? 'Saving…' : `Save ${peso(total)} as goods total`}
        </button>
        {saved != null && (
          <button onClick={() => setOpen(false)}
            className="rounded-lg border border-black/15 px-3 text-sm font-medium text-black/60">Cancel</button>
        )}
      </div>
    </div>
  );
}

/**
 * The rider who handed this delivery over, with a tap-to-call number so the new
 * rider can coordinate — especially when the goods were already bought.
 */
function PreviousRider({ name, contact, reason, hadGoods }: {
  name: string | null; contact: string | null; reason?: string | null; hadGoods?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-brand-yellow/20 px-3 py-2.5 ring-1 ring-brand-yellow/50">
      <div className="min-w-0">
        <p className="text-xs text-yellow-900/70">🔄 Transferred from</p>
        <p className="truncate text-sm font-bold text-brand-ink">{name ?? 'Previous rider'}</p>
        {contact
          ? <p className="truncate text-xs text-black/50">{contact}</p>
          : <p className="text-xs text-black/40">No number on file</p>}
        {reason && <p className="mt-0.5 truncate text-[11px] text-yellow-900/70">Reason: {reason}</p>}
        {hadGoods && <p className="mt-0.5 text-[11px] font-medium text-yellow-900">⚠️ They already have the items</p>}
      </div>
      {contact && (
        <span className="flex shrink-0 gap-2">
          <a href={`tel:${contact}`} aria-label="Call previous rider"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-orange text-white"><PhoneIcon /></a>
          <a href={`sms:${contact}`} aria-label="Message previous rider"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-charcoal text-white"><ChatIcon /></a>
        </span>
      )}
    </div>
  );
}
