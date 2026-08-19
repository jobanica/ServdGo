/**
 * How every city is running, and what float it is carrying.
 *
 * The numbers come from a materialised view refreshed every quarter hour, so
 * the age is shown rather than implied. A city breaching its thresholds is
 * badged here and has an alert raised for it by the sweep — this screen is the
 * standing view, the alert centre is the queue.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listScorecard, scorecardBreaches, refreshScorecard,
  type ScorecardRow,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from '../ui.tsx';

const SAMPLE: ScorecardRow[] = [
  { territory_id: 't1', territory_name: 'Preview city', window_days: 7, orders: 42, delivered: 39,
    cancelled: 2, mins_to_assign: 4.2, mins_to_pickup: 11.8, mins_to_deliver: 24.5,
    completion_pct: 92.9, cancelled_pct: 4.8, decline_pct: 12.0, unremitted_cod: 1840,
    pending_remittances: 2, variance_remittances: 0, refreshed_at: new Date().toISOString() },
];

export function Scorecard() {
  const navigate = useNavigate();
  const [win, setWin] = useState<7 | 30>(7);
  const [rows, setRows] = useState<ScorecardRow[]>(isSupabaseConfigured ? [] : SAMPLE);
  const [breaches, setBreaches] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const r = await listScorecard(supabase, win);
      setRows(r);
      const pairs = await Promise.all(
        r.map(async (x) => [x.territory_id, await scorecardBreaches(supabase!, x.territory_id)] as const));
      setBreaches(Object.fromEntries(pairs));
    } catch (e) { setError(errMessage(e)); }
  }, [win]);
  useEffect(() => { void load(); }, [load]);

  const age = rows[0]?.refreshed_at
    ? Math.round((Date.now() - new Date(rows[0].refreshed_at).getTime()) / 60000) : null;
  const totalFloat = rows.reduce((n, r) => n + Number(r.unremitted_cod), 0);
  const totalVariance = rows.reduce((n, r) => n + Number(r.variance_remittances), 0);

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Cities reporting" value={String(rows.length)} sub={`rolling ${win} days`} />
        <Stat label="COD float outstanding" value={peso(totalFloat)}
          sub="collected at the door, not yet settled" />
        <Stat label="Remittances with a variance" value={String(totalVariance)}
          sub={totalVariance > 0 ? 'declared ≠ ledger' : 'all reconcile'} alarm={totalVariance > 0} />
      </div>

      <Card title="Partner scorecard" action={
        <div className="flex items-center gap-2">
          <select value={win} onChange={(e) => setWin(Number(e.target.value) as 7 | 30)}
            className="rounded-lg border border-black/10 bg-white px-2 py-1 text-xs">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <button disabled={busy}
            onClick={async () => {
              if (!supabase) return;
              setBusy(true);
              try { await refreshScorecard(supabase); await load(); }
              catch (e) { setError(errMessage(e)); }
              finally { setBusy(false); }
            }}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">
            {busy ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      }>
        {rows.length === 0 ? <Muted>No city has traded in this window yet.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead><tr>
                <Th>City</Th><Th>Orders</Th><Th>Completion</Th><Th>Cancelled</Th>
                <Th>To assign</Th><Th>To deliver</Th><Th>Declines</Th><Th>COD float</Th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const b = breaches[r.territory_id] ?? [];
                  return (
                    <tr key={r.territory_id} className="border-t border-black/5 align-top">
                      <Td>
                        <button onClick={() => navigate(`/hq/tenants/${r.territory_id}`)}
                          className="font-semibold text-brand-orange hover:underline">
                          {r.territory_name}
                        </button>
                        {b.length > 0 && (
                          <>
                            <span className="ml-2 rounded-full bg-brand-orange/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-brand-orange">
                              at risk
                            </span>
                            <span className="mt-1 block text-xs text-black/50">{b.join('; ')}</span>
                          </>
                        )}
                      </Td>
                      <Td>{r.orders}</Td>
                      <Td>{r.completion_pct === null ? '—' : `${r.completion_pct}%`}</Td>
                      <Td>{r.cancelled_pct === null ? '—' : `${r.cancelled_pct}%`}</Td>
                      <Td>{r.mins_to_assign === null ? '—' : `${r.mins_to_assign} min`}</Td>
                      <Td>{r.mins_to_deliver === null ? '—' : `${r.mins_to_deliver} min`}</Td>
                      <Td>{r.decline_pct === null ? '—' : `${r.decline_pct}%`}</Td>
                      <Td>
                        {peso(Number(r.unremitted_cod))}
                        {r.pending_remittances > 0 && (
                          <span className="block text-xs text-black/50">
                            {r.pending_remittances} awaiting confirmation
                          </span>
                        )}
                        {r.variance_remittances > 0 && (
                          <span className="block text-xs font-semibold text-brand-orange">
                            {r.variance_remittances} with a variance
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Muted>
          {age === null
            ? 'Refreshed every 15 minutes.'
            : `Figures are ${age} minute${age === 1 ? '' : 's'} old — refreshed every 15 minutes.`}
          {' '}COD float is commission riders have collected at the door and not yet settled;
          a variance means a rider declared a different amount from what their ledger said.
        </Muted>
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
