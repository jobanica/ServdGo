/**
 * The overrides: reassign, cancel, put back in the pool.
 *
 * These exist for the delivery that is stuck in a way the operator's own tools
 * will not shift — a rider whose phone died mid-trip, an order marked delivered
 * that never arrived. Every one of them needs a reason, and the reason is what
 * ends up in the audit log; the database refuses without it.
 *
 * Cancelling a delivered order takes the rider's commission off the books with
 * it. If that commission has already been settled, the money has moved and the
 * database refuses — that is a refund, and it is somebody's decision, not a
 * button.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  findDelivery, assignableRiders, hqReassignOrder, hqCancelOrder, hqRedispatchOrder,
  type OverrideTarget, type AssignableRider,
} from '@servdgo/supabase';
import { errMessage } from '@servdgo/shared';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { Card, Muted, ErrorNote, peso } from '../ui.tsx';

export function Deliveries() {
  const [needle, setNeedle] = useState('');
  const [order, setOrder] = useState<OverrideTarget | null>(null);
  const [riders, setRiders] = useState<AssignableRider[]>([]);
  const [riderId, setRiderId] = useState('');
  const [reason, setReason] = useState('');
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    if (!supabase || !isSupabaseConfigured) return;
    setBusy(true); setError(null); setNote(null); setSearched(true);
    try {
      const found = await findDelivery(supabase, needle);
      setOrder(found);
      setRiders(found?.territory_id ? await assignableRiders(supabase, found.territory_id) : []);
      setRiderId('');
    } catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }, [needle]);

  const refresh = useCallback(async () => {
    if (!supabase || !order) return;
    setOrder(await findDelivery(supabase, order.id));
  }, [order]);

  useEffect(() => { setNote(null); }, [order?.id]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await refresh(); setNote(done); setReason(''); }
    catch (e) { setError(errMessage(e)); }
    finally { setBusy(false); }
  }

  if (!isSupabaseConfigured) return <Muted>Connect Supabase to override a delivery.</Muted>;

  const closed = order && (order.status === 'delivered' || order.status === 'cancelled');
  const canAct = !!reason.trim();

  return (
    <div className="space-y-5">
      {error && <ErrorNote msg={error} />}
      {note && <p className="rounded-xl bg-brand-orange/10 px-3 py-2 text-sm text-brand-orange">{note}</p>}

      <Card title="Find the delivery">
        <div className="flex flex-wrap gap-2">
          <input value={needle} onChange={(e) => setNeedle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="Order id, tracking token, or the partner's reference"
            className="min-w-[16rem] flex-1 rounded-lg border border-black/10 px-3 py-2 text-sm" />
          <button onClick={() => void search()} disabled={busy || !needle.trim()}
            className="rounded-xl bg-brand-orange px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Looking…' : 'Find'}
          </button>
        </div>
      </Card>

      {searched && !order && !busy && (
        <Muted>Nothing found. Check the id — a partner reference only matches within their own orders.</Muted>
      )}

      {order && (
        <>
          <Card title="Delivery">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Status</dt>
                <dd className="font-semibold capitalize">{order.status.replace('_', ' ')}</dd></div>
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Service</dt>
                <dd className="capitalize">{order.service_type}</dd></div>
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Placed</dt>
                <dd>{new Date(order.created_at).toLocaleString()}</dd></div>
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Customer</dt>
                <dd>{order.customer_name} · {order.customer_contact}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-wide text-black/40">Address</dt>
                <dd>{order.delivery_address ?? '—'}</dd></div>
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Delivery fee</dt>
                <dd>{peso(order.delivery_fee)}</dd></div>
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Commission</dt>
                <dd>{peso(order.commission_amount)}</dd></div>
              <div><dt className="text-xs uppercase tracking-wide text-black/40">Rider</dt>
                <dd>{riders.find((r) => r.id === order.rider_id)?.name ?? (order.rider_id ? order.rider_id.slice(0, 8) : 'none')}</dd></div>
            </dl>
          </Card>

          <Card title="Override">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-black/40">
                Reason — required, and recorded
              </span>
              <input value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. rider unreachable for 40 minutes"
                className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm" />
            </label>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl bg-black/[0.03] p-3">
                <p className="font-semibold">Reassign</p>
                <p className="mt-1 text-xs text-black/50">
                  Hand it to another approved rider in the same city. The current rider will not be
                  offered it again.
                </p>
                <select value={riderId} onChange={(e) => setRiderId(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-black/10 px-3 py-2 text-sm">
                  <option value="">Choose a rider</option>
                  {riders.filter((r) => r.id !== order.rider_id).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} {r.is_online ? '· online' : ''}
                    </option>
                  ))}
                </select>
                <button disabled={busy || !canAct || !riderId || !!closed}
                  onClick={() => void run(
                    () => hqReassignOrder(supabase!, order.id, riderId, reason), 'Reassigned')}
                  className="mt-2 w-full rounded-xl bg-brand-charcoal px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
                  Reassign
                </button>
              </div>

              <div className="rounded-xl bg-black/[0.03] p-3">
                <p className="font-semibold">Put back in the pool</p>
                <p className="mt-1 text-xs text-black/50">
                  Takes the rider off and offers it to everyone again, including anyone who had
                  already passed on it.
                </p>
                <button disabled={busy || !canAct || !!closed}
                  onClick={() => void run(
                    () => hqRedispatchOrder(supabase!, order.id, reason), 'Back in the pool')}
                  className="mt-2 w-full rounded-xl bg-brand-charcoal px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
                  Re-dispatch
                </button>
              </div>

              <div className="rounded-xl bg-red-50 p-3 ring-1 ring-red-100">
                <p className="font-semibold text-red-800">Cancel</p>
                <p className="mt-1 text-xs text-red-700/80">
                  Works even on a delivered order, and removes the rider's commission with it.
                  Refused once that commission has been settled.
                </p>
                <button disabled={busy || !canAct || order.status === 'cancelled'}
                  onClick={() => void run(
                    () => hqCancelOrder(supabase!, order.id, reason), 'Cancelled')}
                  className="mt-2 w-full rounded-xl bg-red-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
                  Cancel delivery
                </button>
              </div>
            </div>

            {!canAct && (
              <p className="mt-3 text-xs text-black/45">Write a reason to enable these.</p>
            )}
            {closed && (
              <p className="mt-1 text-xs text-black/45">
                This delivery is {order.status}; only cancelling still applies.
              </p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
