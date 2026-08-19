/**
 * The operator's side of the same ledger: what this city owes the franchisor,
 * and declaring that it has been paid.
 *
 * Submitting does not clear anything. The amount is computed in the database
 * from what is actually outstanding rather than typed here, and only the
 * franchisor can confirm the money arrived — the same shape as a rider settling
 * with this operator, seen from the other side.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  territoryRoyaltySummary, royaltyPeriod, listOperatorSettlements,
  listRoyaltyEntries, submitRoyaltySettlement, getAppSettings,
  type OperatorSettlement, type RoyaltyEntry,
} from '@servdgo/supabase';
import { manilaDay, presetRange, errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from './ui.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

interface Summary {
  territoryName: string; rate: number; cycle: 'weekly' | 'monthly';
  platformRevenue: number; royaltyBooked: number; royaltyDue: number;
  royaltyOverdue: number; operatorKeeps: number;
}

const SAMPLE: Summary = {
  territoryName: 'Preview city', rate: 0.3, cycle: 'monthly',
  platformRevenue: 3150, royaltyBooked: 945, royaltyDue: 315,
  royaltyOverdue: 0, operatorKeeps: 2205,
};

export function Royalty() {
  const [summary, setSummary] = useState<Summary | null>(isSupabaseConfigured ? null : SAMPLE);
  const [period, setPeriod] = useState<{ period_start: string; period_end: string } | null>(null);
  const [history, setHistory] = useState<OperatorSettlement[]>([]);
  const [entries, setEntries] = useState<RoyaltyEntry[]>([]);
  const [method, setMethod] = useState('gcash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const range = presetRange('month');

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const settings = await getAppSettings(supabase);
      if (!settings.territory_id) {
        setError('You are not assigned to a city yet. Ask the franchisor to appoint you.');
        return;
      }
      const [s, p, h, e] = await Promise.all([
        territoryRoyaltySummary(supabase, settings.territory_id, range.from, range.to),
        royaltyPeriod(supabase, manilaDay()),
        listOperatorSettlements(supabase),
        listRoyaltyEntries(supabase, settings.territory_id, 50),
      ]);
      setSummary(s); setPeriod(p); setHistory(h); setEntries(e);
    } catch (e) { setError(errMessage(e)); }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  async function submit() {
    if (!supabase || !period) return;
    setBusy(true); setError(null); setNote(null);
    try {
      const id = await submitRoyaltySettlement(supabase, {
        periodStart: period.period_start,
        periodEnd: period.period_end,
        method, reference: reference.trim() || undefined,
      });
      const rows = await listOperatorSettlements(supabase);
      const mine = rows.find((r) => r.id === id);
      setNote(`Declared ${peso(Number(mine?.amount_due ?? 0))}. It clears once the franchisor confirms it.`);
      setReference('');
      await load();
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!summary) {
    return error ? <ErrorNote msg={error} /> : <Muted>Loading…</Muted>;
  }

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="You keep" value={peso(summary.operatorKeeps)} sub="this month" />
        <Stat label="Franchisor's share" value={peso(summary.royaltyBooked)}
          sub={`${(summary.rate * 100).toFixed(0)}% of platform revenue`} />
        <Stat label="Owed now" value={peso(summary.royaltyDue)}
          sub={summary.royaltyOverdue > 0 ? `${peso(summary.royaltyOverdue)} of it overdue` : 'nothing overdue'}
          alarm={summary.royaltyOverdue > 0} />
      </div>

      <Card title="Pay this period">
        <p className="text-sm text-black/60">
          Your share is only counted once a rider's settlement is <b>confirmed</b>, so this is a
          share of money that actually reached you — never of what is still out with a rider.
        </p>
        {period && (
          <p className="mt-2 text-sm">
            Current {summary.cycle} period: <b>{period.period_start}</b> to <b>{period.period_end}</b>.
          </p>
        )}
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Method</span>
            <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="gcash">GCash</option>
              <option value="maya">Maya</option>
              <option value="bank">Bank transfer</option>
              <option value="cash">Cash</option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium">Reference</span>
            <input className={inp} value={reference} placeholder="Transaction reference"
              onChange={(e) => setReference(e.target.value)} />
          </label>
        </div>
        <button disabled={busy || summary.royaltyDue <= 0} onClick={() => void submit()}
          className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
          {busy ? 'Submitting…'
            : summary.royaltyDue > 0 ? `Declare ${peso(summary.royaltyDue)} paid` : 'Nothing outstanding'}
        </button>
        <Muted>
          The amount is worked out from your outstanding entries, not typed here — so it cannot
          drift from what the ledger says.
        </Muted>
      </Card>

      <Card title="Your payments">
        {history.length === 0 ? <Muted>No payments yet.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr><Th>Period</Th><Th>Declared</Th><Th>Cleared</Th><Th>Method</Th><Th>Status</Th></tr></thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id} className="border-t border-black/5">
                    <Td>{s.period_start} – {s.period_end}</Td>
                    <Td>{peso(Number(s.amount_due))}</Td>
                    <Td>{s.amount_settled === null ? '—' : peso(Number(s.amount_settled))}</Td>
                    <Td>{s.method ?? '—'}</Td>
                    <Td>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        s.status === 'confirmed' ? 'bg-brand-orange/15 text-brand-orange' : 'bg-brand-yellow/30 text-yellow-800'}`}>
                        {s.status}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="What it was worked out from">
        {entries.length === 0 ? <Muted>Nothing booked yet.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr><Th>Day</Th><Th>Kind</Th><Th>Platform revenue</Th><Th>Rate</Th><Th>Share</Th><Th>Settled</Th></tr></thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-black/5">
                    <Td>{e.business_day}</Td>
                    <Td>{e.kind === 'royalty' ? 'Royalty' : e.kind === 'joining_fee' ? 'Joining fee' : 'Adjustment'}</Td>
                    <Td>{e.base_amount ? peso(Number(e.base_amount)) : '—'}</Td>
                    <Td>{e.rate ? `${(Number(e.rate) * 100).toFixed(1)}%` : '—'}</Td>
                    <Td>{peso(Number(e.amount))}</Td>
                    <Td>{e.settled ? 'yes' : 'no'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Muted>Each entry keeps the rate it was booked at, so a later rate change never rewrites what you already owed.</Muted>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub, alarm = false }:
  { label: string; value: string; sub: string; alarm?: boolean }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-xs font-semibold uppercase tracking-wide text-black/40">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${alarm ? 'text-brand-orange' : ''}`}>{value}</p>
      <p className="text-xs text-black/50">{sub}</p>
    </div>
  );
}
