import { useEffect, useMemo, useState } from 'react';
import {
  addOrderItem, addOrderStore, listOrderStores, listMenu, listAvailableStores,
  listOrderAddons, type AddableStore, type OrderAddon,
} from '@servdgo/supabase';
import { errMessage, MAX_STORES_PER_ORDER } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { peso } from './ui.tsx';

interface MenuItem { id: string; name: string; price: number; description: string | null }
interface PickedStore { id: string; name: string }

/**
 * "I forgot the drinks." — and "can you also swing by the bakery?"
 *
 * Two different asks with two different costs. Another item from a shop the
 * rider is already standing in costs them a second glance at the same counter,
 * so it goes straight on. A whole new store is a new stop — another queue,
 * another wait, usually a detour — so it is put to the rider first, priced as a
 * stop, and charged only if they say yes.
 *
 * Both close once the food is collected: at that point the counters are behind
 * them.
 */
export function AddToOrder({ orderId, status, onAdded }: {
  orderId: string;
  status: string;
  onAdded: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [stores, setStores] = useState<AddableStore[]>([]);
  const [others, setOthers] = useState<PickedStore[]>([]);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<OrderAddon[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // Only while the rider is still at or heading to the shops.
  const canAdd = ['pending', 'accepted', 'preparing'].includes(status);
  const onOrder = useMemo(() => new Set(stores.map((s) => s.storeId)), [stores]);
  const isNewStore = storeId != null && !onOrder.has(storeId);
  const roomForMore = stores.length < MAX_STORES_PER_ORDER;

  useEffect(() => {
    if (!open || !supabase) return;
    listOrderStores(supabase, orderId)
      .then((s) => { setStores(s); setStoreId((cur) => cur ?? s[0]?.storeId ?? null); })
      .catch((e) => setErr(errMessage(e)));
    listOrderAddons(supabase, orderId)
      .then((a) => setPending(a.filter((x) => x.status === 'pending')))
      .catch(() => { /* the panel still works without it */ });
    listAvailableStores(supabase)
      .then((s) => setOthers((s as { id: string; name: string }[]).map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => { /* adding to the existing store still works */ });
  }, [open, orderId]);

  useEffect(() => {
    if (!open || !storeId || !supabase) return;
    setItems(null); setBasket({});
    listMenu(supabase, storeId)
      .then((m) => setItems(((m.items ?? []) as unknown as (MenuItem & { customer_price?: number })[])
        .map((i) => ({ ...i, price: i.customer_price ?? i.price }))))
      .catch((e) => setErr(errMessage(e)));
  }, [open, storeId]);

  /** Straight onto the order — the rider is already going there. */
  async function add(item: MenuItem) {
    if (!supabase) return;
    setBusy(item.id); setErr(null);
    try {
      await addOrderItem(supabase, orderId, item.id, 1);
      setAdded((a) => [...a, item.id]);
      await onAdded();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** A new store: gather a basket, then ask the rider. */
  async function askForStop() {
    if (!supabase || !storeId) return;
    const chosen = Object.entries(basket).filter(([, q]) => q > 0);
    if (chosen.length === 0) return;
    setBusy('stop'); setErr(null);
    try {
      const res = await addOrderStore(supabase, orderId, storeId,
        chosen.map(([menuItemId, qty]) => ({ menuItemId, qty })));
      setSent(res.applied
        ? 'Added to your order.'
        : 'Sent to your rider. Nothing is charged unless they accept the stop.');
      setBasket({});
      await onAdded();
    } catch (e) {
      setErr(errMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!canAdd) return null;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="rounded-lg border border-brand-orange/50 px-2.5 py-1 text-xs font-semibold text-green-700">
        ➕ Add more items
      </button>
    );
  }

  const shown = (items ?? []).filter((i) =>
    !query.trim() || i.name.toLowerCase().includes(query.trim().toLowerCase()));
  const basketCount = Object.values(basket).reduce((n, q) => n + q, 0);
  const basketTotal = (items ?? []).reduce((sum, i) => sum + (basket[i.id] ?? 0) * i.price, 0);
  const otherStores = others.filter((s) => !onOrder.has(s.id));

  return (
    <div className="mt-2 w-full rounded-xl bg-brand-orange/[0.05] p-3 ring-1 ring-brand-orange/25">
      <p className="text-sm font-bold text-green-900">Add to this order</p>
      <p className="mt-0.5 text-xs text-green-900/70">
        Your rider is told straight away. If the kitchen has run out they'll mark it and you won't be charged.
      </p>

      {pending.length > 0 && (
        <p className="mt-2 rounded-lg bg-brand-yellow/25 px-3 py-2 text-xs font-medium text-yellow-900">
          ⏳ Waiting on your rider for {pending.map((a) => a.store_name || 'an extra stop').join(', ')}.
        </p>
      )}
      {sent && <p className="mt-2 rounded-lg bg-brand-orange/15 px-3 py-2 text-xs font-medium text-green-800">✓ {sent}</p>}

      <div className="mt-2 flex flex-wrap gap-2">
        {stores.map((s) => (
          <button key={s.storeId} onClick={() => { setStoreId(s.storeId); setSent(null); }}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition ${
              storeId === s.storeId ? 'bg-brand-orange text-white ring-brand-orange' : 'bg-white text-black/60 ring-black/10'}`}>
            {s.storeName}
          </button>
        ))}
      </div>

      {/* A store the rider isn't visiting yet — a stop they have to agree to. */}
      {roomForMore && otherStores.length > 0 && (
        <label className="mt-2 block">
          <span className="block text-[11px] font-medium text-black/50">Somewhere else too?</span>
          <select value={isNewStore ? storeId! : ''}
            onChange={(e) => { setStoreId(e.target.value || stores[0]?.storeId || null); setSent(null); }}
            className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm">
            <option value="">Pick another store…</option>
            {otherStores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      {!roomForMore && (
        <p className="mt-2 text-[11px] text-black/45">
          {MAX_STORES_PER_ORDER} stores is the limit for one trip.
        </p>
      )}

      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the menu"
        className="mt-2 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm" />

      {err && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}

      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
        {items === null ? (
          <p className="py-3 text-center text-xs text-black/40">Loading the menu…</p>
        ) : shown.length === 0 ? (
          <p className="py-3 text-center text-xs text-black/40">Nothing matches that.</p>
        ) : shown.map((i) => (
          <div key={i.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{i.name}</span>
              <span className="text-xs text-black/45">{peso(i.price)}</span>
            </span>
            {isNewStore ? (
              <span className="flex shrink-0 items-center gap-1.5">
                <button onClick={() => setBasket((b) => ({ ...b, [i.id]: Math.max(0, (b[i.id] ?? 0) - 1) }))}
                  aria-label={`One fewer ${i.name}`}
                  className="h-7 w-7 rounded-lg border border-black/10 text-sm font-bold text-black/50">−</button>
                <span className="w-5 text-center text-sm font-semibold">{basket[i.id] ?? 0}</span>
                <button onClick={() => setBasket((b) => ({ ...b, [i.id]: (b[i.id] ?? 0) + 1 }))}
                  aria-label={`One more ${i.name}`}
                  className="h-7 w-7 rounded-lg bg-brand-orange text-sm font-bold text-white">＋</button>
              </span>
            ) : (
              <button onClick={() => void add(i)} disabled={busy === i.id}
                className="shrink-0 rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {busy === i.id ? 'Adding…' : added.includes(i.id) ? '✓ Added — add again' : 'Add'}
              </button>
            )}
          </div>
        ))}
      </div>

      {isNewStore && (
        <div className="mt-2 rounded-lg bg-white p-3 ring-1 ring-black/10">
          <p className="text-xs text-black/60">
            A new store is an extra stop, so it adds a store fee and a convenience fee, and the delivery
            fee is worked out again for the longer route. <b>Your rider has to accept it first</b> — nothing
            is charged if they can't.
          </p>
          <button onClick={() => void askForStop()} disabled={busy === 'stop' || basketCount === 0}
            className="mt-2 w-full rounded-lg bg-brand-charcoal py-2.5 text-sm font-bold text-white disabled:opacity-50">
            {busy === 'stop' ? 'Sending…'
              : basketCount === 0 ? 'Choose what to buy there'
              : `Ask my rider to add this stop · ${basketCount} item${basketCount === 1 ? '' : 's'} · ${peso(basketTotal)}`}
          </button>
        </div>
      )}

      <button onClick={() => setOpen(false)}
        className="mt-2 w-full rounded-lg border border-black/10 bg-white py-2 text-xs font-semibold text-black/60">
        Done
      </button>
    </div>
  );
}
