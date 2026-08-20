/**
 * What the franchisor owes each city, and paying it.
 *
 * Rider top-ups land in the franchisor's account, so the franchisor is holding
 * money that mostly is not theirs: of every commission a wallet pays, the
 * royalty stays and the rest belongs to the city that ran the delivery. This
 * screen is the record of that debt, day by day, and the button that discharges
 * it.
 *
 * A negative day is not a mistake. It means the city took more cash over the
 * counter than it earned in shares that day, so it is holding float and the
 * balance runs the other way.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  payoutQueue, operatorDailyShare, payOperator, listOperatorPayouts,
  adjustOperatorShare, listTerritories,
  type PayoutQueueRow, type OperatorDayRow, type OperatorPayout, type Territory,
} from '@servdgo/supabase';
import { errMessage, manilaDay, presetRange } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from '../ui.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

export function Payouts() {
  const [queue, setQueue] = useState<PayoutQueueRow[]>([]);
  const [days, setDays] = useState<OperatorDayRow[]>([]);
  const [payouts, setPayouts] = useState<OperatorPayout[]>([]);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [filter, setFilter] = useState('');
  const [range, setRange] = useState(() => presetRange('month'));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayoutQueueRow | null>(null);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [q, d, p, t] = await Promise.all([
        payoutQueue(supabase),
        operatorDailyShare(supabase, { territoryId: filter || undefined, from: range.from, to: range.to }),
        listOperatorPayouts(supabase, filter || undefined, 50),
        listTerritories(supabase),
      ]);
      setQueue(q); setDays(d); setPayouts(p); setTerritories(t);
    } catch (e) { setError(errMessage(e)); }
  }, [filter, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  if (!isSupabaseConfigured) {
    return <Card title="Operator payouts"><Muted>Connect Supabase to see payouts.</Muted></Card>;
  }

  const outstanding = queue.reduce((s, r) => s + Number(r.unpaid), 0);

  return (
    <div className="space-y-6">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{note}</p>}

      <Card title="Owed right now" action={
        <button onClick={() => void load()} className="text-sm font-semibold text-brand-orange">Refresh</button>
      }>
        <p className="mb-3 text-sm text-black/55">
          Every city with something outstanding, oldest first. Paying clears
          everything up to the end of the period, so an older day never gets left behind.
        </p>
        {queue.length === 0 ? <Muted>Nothing outstanding. Every city is square.</Muted> : (
          <>
            <table className="w-full text-sm">
              <thead><tr><Th>City</Th><Th>Oldest unpaid</Th><Th>Days</Th><Th>Today</Th><Th>Outstanding</Th><Th> </Th></tr></thead>
              <tbody>
                {queue.map((r) => (
                  <tr key={r.territory_id} className="border-t border-black/5">
                    <Td><span className="font-semibold">{r.territory_name}</span></Td>
                    <Td>{r.oldest_day ?? <Muted>—</Muted>}</Td>
                    <Td>{r.days_owed}</Td>
                    <Td>{peso(r.today_net)}</Td>
                    <Td className={Number(r.unpaid) < 0 ? 'font-bold text-red-600' : 'font-bold'}>{peso(r.unpaid)}</Td>
                    <Td>
                      <button onClick={() => setPaying(r)} className="text-sm font-semibold text-brand-orange">
                        {Number(r.unpaid) < 0 ? 'Settle' : 'Pay'}
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-sm font-semibold">Total outstanding: {peso(outstanding)}</p>
          </>
        )}
      </Card>

      <Card title="Daily record" action={
        <div className="flex gap-2">
          <select className="rounded-lg border border-black/10 px-2 py-1 text-sm"
            value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All cities</option>
            {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input type="date" className="rounded-lg border border-black/10 px-2 py-1 text-sm"
            value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <input type="date" className="rounded-lg border border-black/10 px-2 py-1 text-sm"
            value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
      }>
        {days.length === 0 ? <Muted>No wallet-funded deliveries in this window.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <Th>Day</Th><Th>City</Th><Th>Deliveries</Th><Th>Commission</Th>
                <Th>Your royalty</Th><Th>Their share</Th><Th>Cash they took</Th>
                <Th>You pay</Th><Th>Status</Th>
              </tr></thead>
              <tbody>
                {days.map((d) => (
                  <tr key={`${d.territory_id}-${d.business_day}`} className="border-t border-black/5">
                    <Td>{d.business_day}</Td>
                    <Td>{d.territory_name}</Td>
                    <Td>{d.deliveries}</Td>
                    <Td>{peso(d.gross)}</Td>
                    <Td className="font-semibold text-green-700">{peso(d.royalty)}</Td>
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

      <Card title="Paid">
        {payouts.length === 0 ? <Muted>Nothing paid out yet.</Muted> : (
          <table className="w-full text-sm">
            <thead><tr><Th>Paid</Th><Th>City</Th><Th>Period</Th><Th>Amount</Th><Th>Method</Th><Th>Reference</Th></tr></thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className="border-t border-black/5">
                  <Td>{new Date(p.paid_at).toLocaleDateString()}</Td>
                  <Td>{territories.find((t) => t.id === p.territory_id)?.name ?? <Muted>—</Muted>}</Td>
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

      {paying && (
        <PayDialog row={paying} onClose={() => setPaying(null)}
          onDone={(msg) => { setPaying(null); setNote(msg); void load(); }} />
      )}
    </div>
  );
}

function PayDialog({ row, onClose, onDone }: {
  row: PayoutQueueRow; onClose: () => void; onDone: (msg: string) => void;
}) {
  const today = manilaDay();
  const [from, setFrom] = useState(row.oldest_day ?? today);
  const [to, setTo] = useState(today);
  const [method, setMethod] = useState('gcash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [adjustment, setAdjustment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      if (adjustment.trim()) {
        const value = Number(adjustment);
        if (!Number.isFinite(value) || value === 0) throw new Error('That adjustment is not a number.');
        if (!note.trim()) throw new Error('An adjustment needs a reason — put it in the note.');
        await adjustOperatorShare(supabase, row.territory_id, value, note.trim(), to);
      }
      const paid = await payOperator(supabase, row.territory_id, from, to, {
        method, reference: reference || undefined, note: note || undefined,
      });
      onDone(`Recorded ${peso(paid.amount)} to ${row.territory_name}.`);
    } catch (e) { setError(errMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-extrabold">Pay {row.territory_name}</h2>
        <p className="mt-0.5 text-sm text-black/55">
          {peso(row.unpaid)} outstanding across {row.days_owed} day{row.days_owed === 1 ? '' : 's'}.
          The amount is worked out from the ledger, not typed here.
        </p>

        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-black/50">From
              <input type="date" className={inp} value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="text-xs font-semibold text-black/50">To
              <input type="date" className={inp} value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="gcash">GCash</option>
            <option value="bank">Bank transfer</option>
            <option value="maya">Maya</option>
            <option value="cash">Cash</option>
          </select>
          <input className={inp} placeholder="Reference number" value={reference}
            onChange={(e) => setReference(e.target.value)} />
          <input className={inp} placeholder="Note (optional)" value={note}
            onChange={(e) => setNote(e.target.value)} />
          <details className="rounded-lg bg-black/[0.03] px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-black/60">Add an adjustment first</summary>
            <input className={`${inp} mt-2`} inputMode="decimal"
              placeholder="Amount (negative takes it off)" value={adjustment}
              onChange={(e) => setAdjustment(e.target.value)} />
            <p className="mt-1 text-[11px] text-black/45">
              Goes on the same day as the end of the period, with your note as the reason.
            </p>
          </details>
          {error && <ErrorNote msg={error} />}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-black/50">Cancel</button>
            <button onClick={pay} disabled={busy}
              className="rounded-lg bg-brand-orange px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
              {busy ? 'Recording…' : 'Record payment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
