import { useCallback, useEffect, useState } from 'react';
import {
  listMenuPriceProposals, reviewMenuPriceProposal, type MenuPriceProposal,
} from '@ebd/supabase';
import { errMessage } from '@ebd/shared';
import { supabase } from './lib/supabase.ts';

const peso = (n: number) => `₱${n.toFixed(2)}`;

/** Load once, share between the banner and the full list. */
export function usePriceReports() {
  const [rows, setRows] = useState<MenuPriceProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) { setRows([]); return; }
    try { setRows(await listMenuPriceProposals(supabase)); setError(null); }
    catch (e) { setError(errMessage(e)); setRows([]); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { rows, error, reload: load };
}

/**
 * Prices riders found different at the counter, waiting on a decision.
 *
 * The rider's correction has already gone onto the order they were holding —
 * that part can't wait for anyone. What's pending here is whether it also
 * becomes the price every future customer is quoted, which is the operator's
 * call. Approving writes it straight onto the menu.
 */
export function PriceReports() {
  const { rows, error, reload } = usePriceReports();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function review(p: MenuPriceProposal, approve: boolean) {
    if (!supabase) return;
    setBusy(p.id); setErr(null);
    try { await reviewMenuPriceProposal(supabase, p.id, approve); await reload(); }
    catch (e) { setErr(errMessage(e)); }
    finally { setBusy(null); }
  }

  if (!rows || rows.length === 0) return null;

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <h3 className="font-semibold">Price reports from riders</h3>
      <p className="mb-3 mt-0.5 text-sm text-black/50">
        Found at the counter. The customer's bill was already corrected — approving updates the menu,
        so the next customer is quoted the right price.
      </p>
      {(error || err) && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error ?? err}</p>
      )}
      <ul className="divide-y divide-black/5">
        {rows.map((p) => {
          const up = p.actualPrice > p.menuPrice;
          return (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-brand-ink">{p.itemName}</span>
                <span className="block truncate text-xs text-black/45">
                  {p.storeName}
                  {p.riderName && ` · reported by ${p.riderName}`}
                  {p.reports > 1 && ` · ${p.reports} reports`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="whitespace-nowrap text-sm">
                  <span className="text-black/40 line-through">{peso(p.menuPrice)}</span>
                  <span className={`ml-2 font-semibold ${up ? 'text-yellow-700' : 'text-green-700'}`}>
                    {peso(p.actualPrice)}
                  </span>
                </span>
                <button onClick={() => void review(p, false)} disabled={busy === p.id}
                  className="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold text-black/55 disabled:opacity-50">
                  Keep ours
                </button>
                <button onClick={() => void review(p, true)} disabled={busy === p.id}
                  className="rounded-lg bg-brand-green px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                  {busy === p.id ? '…' : 'Update the menu'}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Dashboard nudge — a decision nobody has made is a decision nobody has seen. */
export function PriceReportsAlert({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { rows } = usePriceReports();
  const n = rows?.length ?? 0;
  if (n === 0) return null;

  return (
    <button onClick={() => onNavigate('stores')}
      className="flex w-full items-center justify-between gap-3 rounded-2xl bg-brand-yellow/25 px-4 py-3 text-left ring-1 ring-yellow-600/20">
      <span>
        <span className="block text-sm font-bold text-yellow-900">
          💲 {n} price {n === 1 ? 'report' : 'reports'} from riders
        </span>
        <span className="block text-xs text-yellow-900/70">
          Store prices that don't match our menu. Approve to fix what customers are quoted.
        </span>
      </span>
      <span className="shrink-0 text-sm font-semibold text-yellow-900">Review →</span>
    </button>
  );
}
