import { useState } from 'react';
import { setStoreMarkup, setMenuItemMarkup } from '@ebd/supabase';
import { errMessage } from '@ebd/shared';
import { supabase } from './lib/supabase.ts';
import { Toggle } from './ui.tsx';

const peso2 = (n: number) => `₱${n.toFixed(2)}`;

/**
 * Store-wide mark-up: a peso margin the customer pays on top of the shelf price.
 *
 * Off by default, and off means off — a store with a ₱15 amount saved but the
 * switch down marks up nothing, so the number can be prepared before it goes
 * live. Individual items can still opt out below.
 */
export function StoreMarkup({ store, onSaved }: {
  store: { id: string; markup_enabled?: boolean | null; markup_amount?: number | null };
  onSaved: () => void | Promise<void>;
}) {
  const enabled = store.markup_enabled ?? false;
  const [amount, setAmount] = useState(String(Number(store.markup_amount ?? 0)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(patch: { enabled?: boolean; amount?: number }) {
    if (!supabase) return;
    setBusy(true); setErr(null);
    try { await setStoreMarkup(supabase, store.id, patch); await onSaved(); }
    catch (e) { setErr(errMessage(e)); }
    finally { setBusy(false); }
  }

  const parsed = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  return (
    <div className="rounded-xl bg-brand-purple/[0.04] p-3 ring-1 ring-brand-purple/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          <span className="text-sm font-semibold text-brand-purple">Price mark-up</span>
          <span className="block text-xs text-black/50">
            Added to every item's price for the customer. The rider pays the shelf price and owes the
            mark-up back with their commission.
          </span>
        </span>
        <Toggle on={enabled} onChange={(v) => void save({ enabled: v })} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-black/50">₱ per item</span>
        <input type="number" min={0} step="0.5" value={amount} disabled={busy}
          onChange={(e) => setAmount(e.target.value)}
          className="w-28 rounded-lg border border-black/10 px-2 py-1.5 text-sm" />
        <button onClick={() => valid && void save({ amount: parsed })} disabled={busy || !valid}
          className="rounded-lg bg-brand-purple px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
          Save amount
        </button>
        {!enabled && parsed > 0 && (
          <span className="text-[11px] text-black/45">Saved, but nothing is marked up while the switch is off.</span>
        )}
      </div>
      {err && <p className="mt-1.5 text-[11px] text-red-600">{err}</p>}
    </div>
  );
}

/**
 * One item's mark-up: leave it out, or charge something different from the rest
 * of the store. Only worth showing once the store's switch is on.
 */
export function ItemMarkup({ item, storeAmount, onSaved }: {
  item: { id: string; markup_enabled?: boolean | null; markup_amount?: number | null };
  storeAmount: number;
  onSaved: () => void | Promise<void>;
}) {
  const on = item.markup_enabled ?? true;
  const own = item.markup_amount != null;
  const [amount, setAmount] = useState(own ? String(Number(item.markup_amount)) : '');
  const [busy, setBusy] = useState(false);

  async function save(patch: { enabled?: boolean; amount?: number | null }) {
    if (!supabase) return;
    setBusy(true);
    try { await setMenuItemMarkup(supabase, item.id, patch); await onSaved(); }
    finally { setBusy(false); }
  }

  const parsed = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  return (
    <div className="mt-2 rounded-lg bg-brand-purple/[0.04] p-2.5 ring-1 ring-brand-purple/15">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-brand-purple">
          Mark-up · {on ? peso2(own ? Number(item.markup_amount) : storeAmount) : 'none'}
          {on && !own && <span className="font-normal text-black/40"> (store default)</span>}
        </span>
        <Toggle on={on} onChange={(v) => void save({ enabled: v })} />
      </div>
      {on && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input type="number" min={0} step="0.5" value={amount} disabled={busy}
            placeholder={`Store default ${peso2(storeAmount)}`}
            onChange={(e) => setAmount(e.target.value)}
            className="w-40 rounded-lg border border-black/10 px-2 py-1 text-xs" />
          <button onClick={() => valid && void save({ amount: parsed })} disabled={busy || !valid}
            className="rounded-lg bg-brand-purple px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-50">
            Use this amount
          </button>
          {own && (
            <button onClick={() => void save({ amount: null })} disabled={busy}
              className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-black/55 ring-1 ring-black/10">
              Back to store default
            </button>
          )}
        </div>
      )}
    </div>
  );
}
