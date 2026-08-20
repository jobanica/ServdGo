/**
 * Rider wallets, and what this city earns from them.
 *
 * Two things live here because they are two ends of the same peso. Above: every
 * rider's balance, so the office can see who is about to lock themselves out
 * and take cash over the counter for them. Below: the daily share — the
 * commission the franchisor collected on this city's behalf, less the royalty,
 * which is what the franchisor owes back.
 *
 * Cash taken here is the one thing that flows the other way, so it is netted
 * off the day rather than hidden: a city that took ₱2,000 over the counter is
 * holding ₱2,000 of the franchisor's float.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  territoryRiderWallets, recordTopup, adjustWallet, walletStatement,
  operatorDailyShare, operatorPayoutBalance, listOperatorPayouts, getAppSettings,
  type RiderWalletRow, type OperatorDayRow, type OperatorPayout, type WalletEntry,
} from '@servdgo/supabase';
import { errMessage, manilaDay } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from './ui.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

export function Wallets() {
  const [rows, setRows] = useState<RiderWalletRow[]>([]);
  const [days, setDays] = useState<OperatorDayRow[]>([]);
  const [payouts, setPayouts] = useState<OperatorPayout[]>([]);
  const [owed, setOwed] = useState(0);
  const [walletOn, setWalletOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<RiderWalletRow | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [w, d, b, p] = await Promise.all([
        territoryRiderWallets(supabase),
        operatorDailyShare(supabase),
        operatorPayoutBalance(supabase),
        listOperatorPayouts(supabase, undefined, 30),
      ]);
      setRows(w); setDays(d); setOwed(b); setPayouts(p);
      const { data } = await supabase.from('platform_settings').select('wallet_enabled').maybeSingle();
      setWalletOn(Boolean(data?.wallet_enabled ?? true));
    } catch (e) { setError(errMessage(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const short = useMemo(() => rows.filter((r) => r.locked || r.balance < 0), [rows]);
  const today = manilaDay();
  const todayRow = days.find((d) => d.business_day === today);

  if (!isSupabaseConfigured) {
    return <Card title="Rider wallets"><Muted>Connect Supabase to see rider wallets.</Muted></Card>;
  }

  return (
    <div className="space-y-6">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{note}</p>}

      {!walletOn && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          Wallets are switched off for the network, so riders are still settling in cash.
          Balances below stay as they are until the franchisor turns them on.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Owed to you by the franchisor" value={peso(owed)}
          tone={owed < 0 ? 'bad' : 'good'} />
        <Stat label="Your share today" value={peso(todayRow?.net ?? 0)} />
        <Stat label="Riders short" value={String(short.length)} tone={short.length ? 'bad' : 'good'} />
      </div>

      <Card title="Rider wallets" action={
        <button onClick={() => void load()} className="text-sm font-semibold text-brand-orange">Refresh</button>
      }>
        {rows.length === 0 ? <Muted>No approved riders yet.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <Th>Rider</Th><Th>Balance</Th><Th>Last top-up</Th>
                <Th>Charged (30d)</Th><Th>Topped up (30d)</Th><Th> </Th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.rider_id} className="border-t border-black/5">
                    <Td>
                      <span className="font-semibold">{r.rider_name}</span>
                      <span className="ml-2 text-xs text-black/40">{r.mobile_number}</span>
                      {r.locked && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-700">locked</span>}
                    </Td>
                    <Td className={r.balance < 0 ? 'font-bold text-red-600' : 'font-semibold'}>{peso(r.balance)}</Td>
                    <Td>{r.last_topup_at ? new Date(r.last_topup_at).toLocaleDateString() : <Muted>never</Muted>}</Td>
                    <Td>{peso(r.charged_30d)}</Td>
                    <Td>{peso(r.topped_up_30d)}</Td>
                    <Td>
                      <button onClick={() => setOpen(r)} className="text-sm font-semibold text-brand-orange">
                        Add / adjust
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Your daily share">
        <p className="mb-3 text-sm text-black/55">
          Commission the franchisor collected through rider wallets, less their royalty.
          Cash you took at the office comes off it — that money is already in your hands.
        </p>
        {days.length === 0 ? <Muted>Nothing yet. This fills in as wallet-funded deliveries complete.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <Th>Day</Th><Th>Deliveries</Th><Th>Commission</Th><Th>Royalty</Th>
                <Th>Your share</Th><Th>Cash you took</Th><Th>Net</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {days.map((d) => (
                  <tr key={`${d.territory_id}-${d.business_day}`} className="border-t border-black/5">
                    <Td>{d.business_day}</Td>
                    <Td>{d.deliveries}</Td>
                    <Td>{peso(d.gross)}</Td>
                    <Td>{peso(d.royalty)}</Td>
                    <Td>{peso(d.share)}</Td>
                    <Td>{d.topups_collected ? `−${peso(d.topups_collected)}` : '—'}</Td>
                    <Td className="font-semibold">{peso(d.net)}</Td>
                    <Td>{d.unpaid === 0
                      ? <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-bold text-green-700">paid</span>
                      : <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">{peso(d.unpaid)} due</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Payments received">
        {payouts.length === 0 ? <Muted>No payouts recorded yet.</Muted> : (
          <table className="w-full text-sm">
            <thead><tr><Th>Paid</Th><Th>Period</Th><Th>Amount</Th><Th>Method</Th><Th>Reference</Th></tr></thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-t border-black/5">
                  <Td>{new Date(p.paid_at).toLocaleDateString()}</Td>
                  <Td>{p.period_start === p.period_end ? p.period_start : `${p.period_start} → ${p.period_end}`}</Td>
                  <Td className="font-semibold">{peso(p.amount)}</Td>
                  <Td>{p.method ?? <Muted>—</Muted>}</Td>
                  <Td>{p.reference ?? <Muted>—</Muted>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {open && (
        <RiderWalletDialog rider={open} onClose={() => setOpen(null)}
          onDone={(msg) => { setOpen(null); setNote(msg); void load(); }} />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-xs text-black/50">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${tone === 'bad' ? 'text-red-600' : tone === 'good' ? 'text-green-700' : ''}`}>
        {value}
      </p>
    </div>
  );
}

function RiderWalletDialog({ rider, onClose, onDone }: {
  rider: RiderWalletRow; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<'topup' | 'adjust'>('topup');
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState<'cash' | 'bank' | 'grant'>('cash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    walletStatement(supabase, { riderId: rider.rider_id, limit: 20 })
      .then(setEntries).catch(() => {});
  }, [rider.rider_id]);

  async function save() {
    if (!supabase) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value === 0) { setError('Enter an amount.'); return; }
    setBusy(true); setError(null);
    try {
      if (mode === 'topup') {
        if (value <= 0) throw new Error('A top-up must be more than zero.');
        await recordTopup(supabase, rider.rider_id, value, channel, reference || undefined);
        onDone(`Added ${peso(value)} to ${rider.rider_name}'s wallet.`);
      } else {
        if (!reason.trim()) throw new Error('Say why you are adjusting this wallet.');
        await adjustWallet(supabase, rider.rider_id, value, reason.trim());
        onDone(`Adjusted ${rider.rider_name}'s wallet by ${peso(value)}.`);
      }
    } catch (e) { setError(errMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-extrabold">{rider.rider_name}</h2>
        <p className="text-sm text-black/55">
          Balance <span className={rider.balance < 0 ? 'font-bold text-red-600' : 'font-semibold'}>{peso(rider.balance)}</span>
        </p>

        <div className="mt-4 flex gap-2">
          <button onClick={() => setMode('topup')}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${mode === 'topup' ? 'bg-brand-charcoal text-white' : 'bg-black/[0.05]'}`}>
            Record money in
          </button>
          <button onClick={() => setMode('adjust')}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${mode === 'adjust' ? 'bg-brand-charcoal text-white' : 'bg-black/[0.05]'}`}>
            Adjust
          </button>
        </div>

        <div className="mt-3 space-y-3">
          <input className={inp} inputMode="decimal" placeholder={mode === 'topup' ? 'Amount received' : 'Amount (negative to charge)'}
            value={amount} onChange={(e) => setAmount(e.target.value)} />
          {mode === 'topup' ? (
            <>
              <select className={inp} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                <option value="cash">Cash at the office</option>
                <option value="bank">Bank transfer</option>
                <option value="grant">Credit you are granting</option>
              </select>
              <input className={inp} placeholder="Reference (optional)" value={reference}
                onChange={(e) => setReference(e.target.value)} />
              {channel === 'cash' && (
                <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-black/60">
                  Cash you take is float belonging to the franchisor, so it comes off what
                  they pay you for the day.
                </p>
              )}
            </>
          ) : (
            <input className={inp} placeholder="Why (shown to the rider)" value={reason}
              onChange={(e) => setReason(e.target.value)} />
          )}
          {error && <ErrorNote msg={error} />}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-black/50">Cancel</button>
            <button onClick={save} disabled={busy}
              className="rounded-lg bg-brand-orange px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {entries.length > 0 && (
          <div className="mt-5">
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-black/40">Recent</p>
            <table className="w-full text-sm">
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-black/5">
                    <Td>{e.businessDay}</Td>
                    <Td>{e.note ?? e.kind}</Td>
                    <Td className={e.amount < 0 ? 'text-right text-red-600' : 'text-right text-green-700'}>
                      {e.amount < 0 ? '−' : '+'}{peso(Math.abs(e.amount))}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
