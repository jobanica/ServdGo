/**
 * The callbacks we owe the partner platforms, and what happened to them.
 *
 * A failed callback is parked, not lost: the payload is still here and replay
 * puts it back at the front of the queue with its attempt count reset. That is
 * the whole point of an outbox — "did Servd get told?" has an answer, and if the
 * answer is no there is something to press.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listWebhookDeliveries, listMerchants, replayWebhook, replayFailedWebhooks,
  type WebhookDelivery, type Merchant,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote } from '../ui.tsx';

const TONE: Record<WebhookDelivery['status'], string> = {
  delivered: 'bg-brand-orange/15 text-green-800',
  pending: 'bg-brand-yellow/30 text-yellow-800',
  failed: 'bg-red-100 text-red-700',
};

export function Webhooks() {
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [status, setStatus] = useState<'' | WebhookDelivery['status']>('failed');
  const [merchantId, setMerchantId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setError(null);
    try {
      setRows(await listWebhookDeliveries(supabase, {
        merchantId: merchantId || undefined,
        status: status || undefined,
      }, 200));
    } catch (e) { setError(errMessage(e)); }
  }, [merchantId, status]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) return;
    void listMerchants(supabase).then(setMerchants).catch(() => setMerchants([]));
  }, []);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await load(); setNote(done); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!isSupabaseConfigured) return <Muted>Connect Supabase to see partner callbacks.</Muted>;

  const name = (id: string) => merchants.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  const failed = rows.filter((r) => r.status === 'failed').length;

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <Card title="Filter"
        action={merchantId && failed > 0 ? (
          <button disabled={busy}
            onClick={() => void run(() => replayFailedWebhooks(supabase!, merchantId),
              'Queued for another attempt')}
            className="rounded-xl bg-brand-orange px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Replay all failed
          </button>
        ) : undefined}>
        <div className="grid gap-3 sm:grid-cols-2">
          <select value={merchantId} onChange={(e) => setMerchantId(e.target.value)}
            className="rounded-lg border border-black/10 px-3 py-2 text-sm">
            <option value="">Every restaurant</option>
            {merchants.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}
            className="rounded-lg border border-black/10 px-3 py-2 text-sm">
            <option value="">Any outcome</option>
            <option value="failed">Given up on</option>
            <option value="pending">Still trying</option>
            <option value="delivered">Delivered</option>
          </select>
        </div>
      </Card>

      <Card title={`${rows.length} callbacks`}>
        {rows.length === 0 ? <p className="text-sm text-black/50">Nothing to show.</p> : (
          <ul className="divide-y divide-black/5">
            {rows.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[r.status]}`}>
                    {r.status}
                  </span>
                  <span className="font-semibold">{r.event}</span>
                  <span className="text-sm text-black/60">{name(r.merchant_id)}</span>
                  <span className="text-xs text-black/40">
                    {new Date(r.created_at).toLocaleString()} · {r.attempts} attempt
                    {r.attempts === 1 ? '' : 's'}
                  </span>
                  <div className="ml-auto flex gap-2">
                    <button onClick={() => setOpen(open === r.id ? null : r.id)}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-black/60 hover:bg-black/5">
                      {open === r.id ? 'Hide payload' : 'Payload'}
                    </button>
                    {r.status !== 'delivered' && (
                      <button disabled={busy}
                        onClick={() => void run(() => replayWebhook(supabase!, r.id), 'Queued again')}
                        className="rounded-lg bg-brand-orange px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">
                        Replay
                      </button>
                    )}
                  </div>
                </div>
                {r.last_error && (
                  <p className="mt-1 text-xs text-red-700">{r.last_error}</p>
                )}
                {open === r.id && (
                  <pre className="mt-2 overflow-x-auto rounded-xl bg-black/[0.03] p-3 text-xs">
                    {JSON.stringify(r.payload, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
