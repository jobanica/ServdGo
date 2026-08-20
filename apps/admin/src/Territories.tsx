/**
 * The franchisor's screen: every city on one page.
 *
 * Nobody else can open it — `franchisor_overview` refuses anyone who is not the
 * franchisor, so this is a view onto a right the database already enforces
 * rather than a permission of its own.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  franchisorOverview, listOperatorSettlements, confirmRoyaltySettlement,
  goLive, suspendTerritory, TERRITORY_PIPELINE, TERRITORY_STATUS_LABEL,
  type FranchisorRow, type OperatorSettlement, type TerritoryStatus,
} from '@servdgo/supabase';
import { manilaDay, presetRange, errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from './lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from './ui.tsx';
import { NewCity } from './hq/NewCity.tsx';

const inp = 'w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/30';

const STATUS_CHIP: Record<FranchisorRow['status'], string> = {
  live: 'bg-brand-orange/15 text-brand-orange',
  approved: 'bg-brand-orange/10 text-brand-orange',
  onboarding: 'bg-black/5 text-black/60',
  applied: 'bg-black/5 text-black/60',
  lead: 'bg-black/5 text-black/50',
  suspended: 'bg-brand-yellow/30 text-yellow-800',
  terminated: 'bg-black/10 text-black/40',
};

const SAMPLE: FranchisorRow[] = [
  { territory_id: '1', territory_name: 'Preview city', status: 'live', operator_name: 'An operator',
    commission_rate: 0.15, orders_delivered: 42, platform_revenue: 3150, royalty_booked: 945,
    royalty_settled: 630, royalty_due: 315, royalty_overdue: 0, last_settled_at: null },
];

export function Territories() {
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState<TerritoryStatus | 'all'>('all');
  const [rows, setRows] = useState<FranchisorRow[]>(isSupabaseConfigured ? [] : SAMPLE);
  const [pending, setPending] = useState<OperatorSettlement[]>([]);
  const [rate, setRate] = useState(0.3);
  const [band, setBand] = useState({ min: 0.1, max: 0.25 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const range = presetRange('month');

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      const [overview, settlements] = await Promise.all([
        franchisorOverview(supabase, range.from, range.to),
        listOperatorSettlements(supabase),
      ]);
      setRows(overview);
      setPending(settlements.filter((s) => s.status === 'pending'));
    } catch (e) { setError(errMessage(e)); }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  // Franchise-wide terms, read from where they live.
  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    supabase.from('platform_settings')
      .select('royalty_rate, commission_rate_min, commission_rate_max')
      .eq('id', true).maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setRate(Number(data.royalty_rate));
        setBand({ min: Number(data.commission_rate_min), max: Number(data.commission_rate_max) });
      });
  }, []);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setError(null); setNote(null);
    try { await fn(); await load(); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(null); }
  }

  // Written straight to platform_settings rather than through the app_settings
  // view: these are franchise-wide terms, and the franchisor runs no city, so
  // the view has no territory to resolve for them.
  async function saveTerms() {
    if (!supabase) return;
    await act('rate', async () => {
      const { error: e } = await supabase!.from('platform_settings').update({
        royalty_rate: rate,
        commission_rate_min: band.min,
        commission_rate_max: band.max,
      }).eq('id', true);
      if (e) throw e;
      setNote('Saved. Existing royalty entries keep the rate they were booked at.');
    });
  }

  const totalDue = rows.reduce((n, r) => n + Number(r.royalty_due), 0);
  const totalOverdue = rows.reduce((n, r) => n + Number(r.royalty_overdue), 0);

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Cities" value={String(rows.length)} sub={`${rows.filter((r) => r.status === 'live').length} live`} />
        <Stat label="Owed to you" value={peso(totalDue)} sub="across every city" />
        <Stat label="Overdue" value={peso(totalOverdue)} sub={totalOverdue > 0 ? 'past its period' : 'nothing behind'}
          alarm={totalOverdue > 0} />
      </div>

      <Card title="Every city" action={
        <div className="flex items-center gap-2">
          <select value={pipeline} onChange={(e) => setPipeline(e.target.value as TerritoryStatus | 'all')}
            className="rounded-lg border border-black/10 bg-white px-2 py-1 text-xs">
            <option value="all">All stages</option>
            {TERRITORY_PIPELINE.map((s2) => (
              <option key={s2} value={s2}>{TERRITORY_STATUS_LABEL[s2]}</option>
            ))}
          </select>
          <NewCity onCreated={(id) => navigate(`/hq/tenants/${id}`)} />
        </div>
      }>
        <Muted>This month for the counts; the balances are whatever is outstanding right now.</Muted>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr>
              <Th>City</Th><Th>Operator</Th><Th>Rate</Th><Th>Delivered</Th>
              <Th>Platform revenue</Th><Th>Your share</Th><Th>Owed now</Th><Th>Overdue</Th><Th>{''}</Th>
            </tr></thead>
            <tbody>
              {rows.filter((r) => pipeline === 'all' || r.status === pipeline).map((r) => (
                <tr key={r.territory_id} className="border-t border-black/5">
                  <Td>
                    <button onClick={() => navigate(`/hq/tenants/${r.territory_id}`)}
                      className="font-semibold text-brand-orange hover:underline">{r.territory_name}</button>
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_CHIP[r.status]}`}>
                      {r.status}
                    </span>
                  </Td>
                  <Td>{r.operator_name ?? <span className="text-black/40">none appointed</span>}</Td>
                  <Td>{(Number(r.commission_rate) * 100).toFixed(1)}%</Td>
                  <Td>{r.orders_delivered}</Td>
                  <Td>{peso(Number(r.platform_revenue))}</Td>
                  <Td>{peso(Number(r.royalty_booked))}</Td>
                  <Td className={Number(r.royalty_due) > 0 ? 'font-semibold' : ''}>{peso(Number(r.royalty_due))}</Td>
                  <Td className={Number(r.royalty_overdue) > 0 ? 'font-semibold text-brand-orange' : ''}>
                    {peso(Number(r.royalty_overdue))}
                  </Td>
                  <Td>
                    {r.status === 'live' ? (
                      <button disabled={busy !== null}
                        onClick={() => act(r.territory_id, () => suspendTerritory(supabase!, r.territory_id))}
                        className="rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">
                        Suspend
                      </button>
                    ) : (
                      <button disabled={busy !== null}
                        onClick={() => act(r.territory_id, () => goLive(supabase!, r.territory_id))}
                        className="rounded-lg bg-brand-orange px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
                        Open
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><Td className="text-black/40">No territories yet.</Td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Muted>
          Opening a city is refused until it has an operator, a boundary and payout details —
          each of those is only discoverable once real orders are running.
        </Muted>
      </Card>

      <Card title="Payments waiting on you">
        {pending.length === 0 ? (
          <Muted>Nothing to confirm.</Muted>
        ) : (
          <ul className="space-y-2">
            {pending.map((s) => {
              const city = rows.find((r) => r.territory_id === s.territory_id);
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-black/[0.02] px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {city?.territory_name ?? 'A city'} — {peso(Number(s.amount_due))}
                    </p>
                    <p className="text-xs text-black/50">
                      {s.period_start} to {s.period_end}
                      {s.method ? ` · ${s.method}` : ''}{s.reference ? ` · ${s.reference}` : ''}
                    </p>
                  </div>
                  <button disabled={busy !== null}
                    onClick={() => act(s.id, async () => {
                      const cleared = await confirmRoyaltySettlement(supabase!, s.id);
                      setNote(`Confirmed. ${peso(cleared)} cleared.`);
                    })}
                    className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
                    Confirm received
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Muted>
          Confirming clears everything outstanding up to the end of that period, so one payment
          does not leave an older peso hanging.
        </Muted>
      </Card>

      <Card title="Platform terms">
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Your share (%)</span>
            <input type="number" min={0} max={100} step={0.5} className={inp}
              value={Math.round(rate * 1000) / 10}
              onChange={(e) => setRate(Number(e.target.value) / 100)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Commission floor (%)</span>
            <input type="number" min={0} max={100} step={0.5} className={inp}
              value={Math.round(band.min * 1000) / 10}
              onChange={(e) => setBand((b) => ({ ...b, min: Number(e.target.value) / 100 }))} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Commission ceiling (%)</span>
            <input type="number" min={0} max={100} step={0.5} className={inp}
              value={Math.round(band.max * 1000) / 10}
              onChange={(e) => setBand((b) => ({ ...b, max: Number(e.target.value) / 100 }))} />
          </label>
        </div>
        <Muted>
          The band is what stops an operator undercutting the network to poach riders — your
          income is a share of whatever they charge. Changing your share reprices what happens
          next; every royalty already booked keeps the rate it was booked at.
        </Muted>
        <button disabled={busy !== null} onClick={() => void saveTerms()}
          className="mt-3 rounded-xl bg-brand-orange px-4 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
          {busy === 'rate' ? 'Saving…' : 'Save terms'}
        </button>
      </Card>

      <Muted>Figures cover {range.from} to {range.to} (today is {manilaDay()}).</Muted>
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
