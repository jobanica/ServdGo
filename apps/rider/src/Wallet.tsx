/**
 * The rider's wallet.
 *
 * A rider prepays and every delivery takes its commission straight out of the
 * balance, so this screen answers two questions and nothing else: how much is
 * left, and how do I put more in. The statement is underneath for the day
 * somebody disagrees with the first answer.
 *
 * The whole panel disappears when the franchisor has not switched wallets on —
 * a rider settling in cash should never see a balance that means nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  walletSummary, walletStatement, startTopup, listTopups,
  type WalletSummary, type WalletEntry, type WalletTopup,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase } from './lib/supabase.ts';
import { peso, inputCls } from './ui.tsx';

const PRESETS = [200, 500, 1000, 2000];

const KIND_LABEL: Record<WalletEntry['kind'], string> = {
  topup: 'Top-up',
  commission: 'Commission',
  markup: 'Mark-up share',
  adjustment: 'Adjustment',
  refund: 'Refund',
};

export function WalletPanel({ riderId }: { riderId?: string }) {
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [pending, setPending] = useState<WalletTopup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !riderId) return;
    try {
      const [s, e, t] = await Promise.all([
        walletSummary(supabase, riderId),
        walletStatement(supabase, { riderId, limit: 60 }),
        listTopups(supabase, riderId, 10),
      ]);
      setSummary(s);
      setEntries(e);
      setPending(t.filter((x) => x.status === 'pending'));
      setError(null);
    } catch (err) {
      setError(errMessage(err));
    }
  }, [riderId]);

  useEffect(() => { void load(); }, [load]);

  // Money added on a payment page arrives here as a webhook, not as a reply to
  // anything this screen did — so while a top-up is outstanding, keep looking.
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => { void load(); }, 6000);
    return () => clearInterval(id);
  }, [pending.length, load]);

  if (!summary?.walletEnabled) return null;

  const low = summary.balance < 0 || summary.low;
  const shown = showAll ? entries : entries.slice(0, 6);

  return (
    <section className="space-y-3">
      <div className={`rounded-2xl px-5 py-4 text-white ${summary.balance < 0 ? 'bg-red-600' : 'bg-brand-charcoal'}`}>
        <p className="text-xs uppercase tracking-wide text-white/60">Wallet balance</p>
        <p className="text-3xl font-extrabold">{peso(summary.balance)}</p>
        {summary.chargedToday > 0 && (
          <p className="mt-1 text-xs text-white/70">
            {peso(summary.chargedToday)} in commission taken today
          </p>
        )}
        {summary.balance < 0 ? (
          <p className="mt-2 rounded-xl bg-black/25 px-3 py-2 text-xs">
            You are {peso(-summary.balance)} short. Top up before tomorrow or you will
            not be able to accept requests.
          </p>
        ) : low ? (
          <p className="mt-2 rounded-xl bg-black/25 px-3 py-2 text-xs">
            Running low. Commission comes out of this balance on every delivery.
          </p>
        ) : null}
        <button onClick={() => setOpen(true)}
          className="mt-3 w-full rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-brand-charcoal">
          Top up
        </button>
      </div>

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {pending.map((t) => (
        <div key={t.id} className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <p className="font-semibold">Waiting for {peso(Number(t.amount))}</p>
          <p className="text-xs">
            Reference {t.reference}. It lands here on its own once you have paid.
          </p>
          {t.checkout_url && (
            <a href={t.checkout_url} target="_blank" rel="noreferrer"
              className="mt-1 inline-block text-xs font-bold underline">Open the payment page</a>
          )}
        </div>
      ))}

      {entries.length > 0 && (
        <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-black/5">
          {shown.map((e) => (
            <div key={e.id} className="flex items-start justify-between gap-3 border-b border-black/5 px-4 py-3 last:border-0">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{KIND_LABEL[e.kind] ?? e.kind}</p>
                <p className="truncate text-xs text-black/45">{e.note ?? e.businessDay}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`text-sm font-bold ${e.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {e.amount < 0 ? '−' : '+'}{peso(Math.abs(e.amount))}
                </p>
                <p className="text-[11px] text-black/40">{peso(e.balanceAfter)}</p>
              </div>
            </div>
          ))}
          {entries.length > 6 && (
            <button onClick={() => setShowAll((v) => !v)}
              className="w-full bg-black/[0.02] px-4 py-2.5 text-xs font-bold text-black/60">
              {showAll ? 'Show less' : `Show all ${entries.length}`}
            </button>
          )}
        </div>
      )}

      {open && (
        <TopUpSheet summary={summary} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void load(); }} />
      )}
    </section>
  );
}

function TopUpSheet({ summary, onClose, onDone }: {
  summary: WalletSummary; onClose: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState<string>(String(PRESETS[1]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ reference: string; url: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const value = Number(amount);
  const valid = Number.isFinite(value) && value >= summary.minTopup && value <= summary.maxTopup;

  async function go() {
    if (!supabase || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const started = await startTopup(supabase, value, window.location.origin);
      if (!alive.current) return;
      setLink({ reference: started.reference, url: started.checkoutUrl });
      if (started.checkoutUrl) window.open(started.checkoutUrl, '_blank', 'noopener');
    } catch (err) {
      if (alive.current) setError(errMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div className="w-full rounded-t-3xl bg-white px-5 pb-8 pt-5" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-black/15" />
        <h2 className="text-lg font-extrabold">Top up your wallet</h2>
        <p className="mt-0.5 text-xs text-black/50">
          {peso(summary.minTopup)} to {peso(summary.maxTopup)} at a time. You can also pay
          cash at the city office and they will add it here.
        </p>

        {link ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
              <p className="font-semibold">Reference {link.reference}</p>
              <p className="text-xs">
                Finish the payment in the page that opened. Your balance updates here
                by itself — you do not need to come back and tell us.
              </p>
            </div>
            {link.url && (
              <a href={link.url} target="_blank" rel="noreferrer"
                className="block rounded-xl bg-brand-charcoal px-4 py-3 text-center text-sm font-bold text-white">
                Open the payment page again
              </a>
            )}
            <button onClick={onDone} className="w-full rounded-xl bg-black/[0.05] px-4 py-3 text-sm font-bold">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-4 gap-2">
              {PRESETS.map((p) => (
                <button key={p} onClick={() => setAmount(String(p))}
                  className={`rounded-xl px-2 py-2.5 text-sm font-bold ring-1 ${
                    Number(amount) === p ? 'bg-brand-charcoal text-white ring-brand-charcoal'
                                         : 'bg-white text-black/70 ring-black/10'}`}>
                  {p}
                </button>
              ))}
            </div>
            <input className={`${inputCls} mt-3`} inputMode="decimal" value={amount}
              onChange={(e) => setAmount(e.target.value)} placeholder="Other amount" />
            {!valid && amount !== '' && (
              <p className="mt-1 text-xs text-red-600">
                Enter an amount between {peso(summary.minTopup)} and {peso(summary.maxTopup)}.
              </p>
            )}
            {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
            <button onClick={go} disabled={!valid || busy}
              className="mt-4 w-full rounded-xl bg-brand-orange px-4 py-3 text-sm font-bold text-white disabled:opacity-50">
              {busy ? 'Opening…' : `Pay ${valid ? peso(value) : ''}`}
            </button>
            <button onClick={onClose} className="mt-2 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-black/50">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The lock, as the database sees it.
 *
 * The rider app has always worked the lock out from the commission ledger, and
 * under a wallet that ledger is settled the instant it is written — so it would
 * cheerfully show an unlocked rider the pool that the database will refuse to
 * let them claim from. Ask the database instead.
 */
export function useWalletGate(riderId?: string): {
  enabled: boolean; balance: number; overdue: number; loaded: boolean;
} {
  const [state, setState] = useState({ enabled: false, balance: 0, overdue: 0, loaded: false });

  useEffect(() => {
    if (!supabase || !riderId) return;
    let alive = true;
    const read = async () => {
      try {
        const s = await walletSummary(supabase!, riderId);
        if (alive && s) {
          setState({ enabled: s.walletEnabled, balance: s.balance, overdue: s.overdue, loaded: true });
        }
      } catch { /* the ledger fallback still holds */ }
    };
    void read();
    const id = setInterval(read, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [riderId]);

  return state;
}
