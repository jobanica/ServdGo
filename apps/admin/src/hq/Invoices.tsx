/**
 * What every city has been billed, and what is late.
 *
 * The nightly sweep suspends an overdue city on its own; both buttons here run
 * the same functions by hand, so the effect is something you can see and cause
 * rather than something that happens to you overnight.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listInvoiceAging, runMonthlyInvoicing, sweepOverdue, confirmRoyaltySettlement,
  AGING_ORDER, AGING_LABEL,
  type InvoiceRow, type AgingBucket,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, Th, Td, peso } from '../ui.tsx';

const SAMPLE: InvoiceRow[] = [
  { id: '1', territory_id: 't1', territory_name: 'Preview city', period_start: '2026-07-01',
    period_end: '2026-07-31', due_at: '2026-08-07', amount_due: 2950, franchise_fee: 2500,
    royalty_amount: 450, status: 'pending', days_overdue: 0, bucket: 'current' },
];

const BUCKET_TONE: Record<AgingBucket, string> = {
  current: 'bg-black/5 text-black/60',
  '1-15': 'bg-brand-yellow/30 text-yellow-800',
  '16-30': 'bg-brand-yellow/40 text-yellow-900',
  '30+': 'bg-brand-orange/20 text-brand-orange',
  paid: 'bg-brand-orange/15 text-brand-orange',
};

export function Invoices() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<InvoiceRow[]>(isSupabaseConfigured ? [] : SAMPLE);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    try { setRows(await listInvoiceAging(supabase)); }
    catch (e) { setError(errMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await load(); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  const outstanding = rows.filter((r) => r.status === 'pending');
  const totals = AGING_ORDER.map((b) => ({
    bucket: b,
    total: rows.filter((r) => r.bucket === b).reduce((n, r) => n + Number(r.amount_due), 0),
    count: rows.filter((r) => r.bucket === b).length,
  }));
  const overdue = outstanding.filter((r) => r.days_overdue > 0);

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {totals.filter((t) => t.bucket !== 'paid').map((t) => (
          <div key={t.bucket} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <p className="text-xs font-semibold uppercase tracking-wide text-black/40">
              {AGING_LABEL[t.bucket]}
            </p>
            <p className={`mt-1 text-2xl font-extrabold ${t.bucket === '30+' && t.total > 0 ? 'text-brand-orange' : ''}`}>
              {peso(t.total)}
            </p>
            <p className="text-xs text-black/50">{t.count} invoice{t.count === 1 ? '' : 's'}</p>
          </div>
        ))}
      </div>

      <Card title="Invoices" action={
        <div className="flex gap-2">
          <button disabled={busy}
            onClick={() => void run(async () => {
              const n = await runMonthlyInvoicing(supabase!);
              setNote(n === 0 ? 'Nothing outstanding to bill.' : `Issued or refreshed ${n} invoice${n === 1 ? '' : 's'}.`);
            })}
            className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
            Issue this period
          </button>
          <button disabled={busy}
            onClick={() => void run(async () => {
              const n = await sweepOverdue(supabase!);
              setNote(n === 0 ? 'Nothing overdue — no city suspended.' : `${n} city suspended for non-payment.`);
            })}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">
            Run overdue sweep
          </button>
        </div>
      }>
        {rows.length === 0 ? <Muted>Nothing billed yet.</Muted> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead><tr>
                <Th>City</Th><Th>Period</Th><Th>Due</Th><Th>Fixed fee</Th>
                <Th>Royalty</Th><Th>Total</Th><Th>Age</Th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-black/5">
                    <Td>
                      <button onClick={() => navigate(`/hq/tenants/${r.territory_id}`)}
                        className="font-semibold text-brand-orange hover:underline">
                        {r.territory_name}
                      </button>
                    </Td>
                    <Td>{r.period_start} – {r.period_end}</Td>
                    <Td>{r.due_at ?? '—'}</Td>
                    <Td>{Number(r.franchise_fee) ? peso(Number(r.franchise_fee)) : '—'}</Td>
                    <Td>{peso(Number(r.royalty_amount))}</Td>
                    <Td className="font-semibold">{peso(Number(r.amount_due))}</Td>
                    <Td>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${BUCKET_TONE[r.bucket]}`}>
                        {r.bucket === 'paid' ? 'paid' : AGING_LABEL[r.bucket]}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Muted>
          Ages are counted from the due date, which is each city's own period end plus its grace
          days — a city on fourteen days' grace is not late on day one.
        </Muted>
      </Card>

      <Card title="Waiting on you">
        {outstanding.length === 0 ? <Muted>Nothing to confirm.</Muted> : (
          <ul className="space-y-2">
            {outstanding.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-black/[0.02] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{r.territory_name} — {peso(Number(r.amount_due))}</p>
                  <p className="text-xs text-black/50">
                    {r.period_start} to {r.period_end}
                    {r.days_overdue > 0 ? ` · ${r.days_overdue} days overdue` : ''}
                  </p>
                </div>
                <button disabled={busy}
                  onClick={() => void run(async () => {
                    const cleared = await confirmRoyaltySettlement(supabase!, r.id);
                    setNote(`Confirmed. ${peso(cleared)} cleared${r.days_overdue > 0 ? ', and the city reopened if it was suspended for this.' : '.'}`);
                  })}
                  className="rounded-lg bg-brand-orange px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  Confirm received
                </button>
              </li>
            ))}
          </ul>
        )}
        <Muted>
          Confirming clears the ledger up to the period end and, if that city was suspended for
          this invoice, reopens it. A suspension you applied by hand is left alone.
        </Muted>
      </Card>

      {overdue.length > 0 && (
        <Card title="Overdue">
          <p className="text-sm text-black/60">
            {overdue.length} invoice{overdue.length === 1 ? '' : 's'} past the due date.
            The nightly sweep suspends these cities automatically; new orders stop, and everything
            already in the queue is still delivered and settled.
          </p>
        </Card>
      )}
    </div>
  );
}
