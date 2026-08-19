/**
 * Declines and transfers — the record of riders turning work down.
 *
 * A pass in the pool and a released delivery are different acts (one costs a
 * customer a few seconds, the other strands an order mid-run, sometimes with
 * the goods already bought), so they're counted separately but read together:
 * the operator's question is "who keeps saying no?", not "who pressed which
 * button".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type RequestEventKind = 'declined' | 'transferred';

export interface RiderRequestEvent {
  id: string;
  riderId: string;
  riderName: string;
  orderId: string;
  kind: RequestEventKind;
  reason: string | null;
  /** Transfers only: the goods were already bought when they let go. */
  hadGoods: boolean;
  createdAt: string;
  /** The order as it stands now — so the operator can see where it ended up. */
  order: { serviceType: string; status: string; deliveryFee: number } | null;
}

const MANILA_OFFSET = '+08:00';

/**
 * History of declines and transfers between two business days (inclusive),
 * newest first. Admin-only by RLS.
 */
export async function listRiderRequestEvents(
  db: SupabaseClient,
  opts: { fromDay: string; toDay: string; riderId?: string; kind?: RequestEventKind; limit?: number } ,
): Promise<RiderRequestEvent[]> {
  const dayAfter = new Date(`${opts.toDay}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

  let q = db
    .from('rider_request_events')
    .select('id, rider_id, order_id, kind, reason, had_goods, created_at, rider:riders(name), order:orders(service_type, status, delivery_fee)')
    .gte('created_at', `${opts.fromDay}T00:00:00${MANILA_OFFSET}`)
    .lt('created_at', `${dayAfter.toISOString().slice(0, 10)}T00:00:00${MANILA_OFFSET}`)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.riderId) q = q.eq('rider_id', opts.riderId);
  if (opts.kind) q = q.eq('kind', opts.kind);

  const { data, error } = await q;
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((row): RiderRequestEvent => {
    const rider = row.rider as { name?: string } | null;
    const order = row.order as { service_type?: string; status?: string; delivery_fee?: number } | null;
    return {
      id: row.id as string,
      riderId: row.rider_id as string,
      riderName: rider?.name ?? '—',
      orderId: row.order_id as string,
      kind: row.kind as RequestEventKind,
      reason: (row.reason as string) ?? null,
      hadGoods: Boolean(row.had_goods),
      createdAt: row.created_at as string,
      order: order
        ? { serviceType: order.service_type ?? '—', status: order.status ?? '—', deliveryFee: Number(order.delivery_fee ?? 0) }
        : null,
    };
  });
}

/** Which order ids this rider has passed on, so the pool stays skipped across devices. */
export async function listMyDeclinedOrderIds(db: SupabaseClient, riderId: string): Promise<string[]> {
  const { data, error } = await db
    .from('rider_request_events')
    .select('order_id')
    .eq('rider_id', riderId)
    .eq('kind', 'declined')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as { order_id: string }[]).map((r) => r.order_id);
}

/** A rider passes on a pool request. Silently ignored once someone takes it. */
export async function declineOrder(db: SupabaseClient, orderId: string, reason?: string): Promise<void> {
  const { error } = await db.rpc('rider_decline_order', {
    p_order_id: orderId, p_reason: reason ?? null,
  });
  if (error) throw error;
}

export interface RiderRefusalTally {
  riderId: string;
  riderName: string;
  declined: number;
  transferred: number;
  /** Transfers where the goods were already bought — the costly kind. */
  transferredWithGoods: number;
  total: number;
  lastAt: string;
}

/**
 * Per-rider counts, worst first. Transfers outrank declines on a tie because
 * they cost more: a declined request is still in the pool, a transferred one
 * has a customer already waiting.
 */
export function summarizeRefusals(events: readonly RiderRequestEvent[]): RiderRefusalTally[] {
  const byRider = new Map<string, RiderRefusalTally>();
  for (const e of events) {
    const row = byRider.get(e.riderId) ?? {
      riderId: e.riderId, riderName: e.riderName,
      declined: 0, transferred: 0, transferredWithGoods: 0, total: 0, lastAt: e.createdAt,
    };
    if (e.kind === 'declined') row.declined++;
    else {
      row.transferred++;
      if (e.hadGoods) row.transferredWithGoods++;
    }
    row.total++;
    if (e.createdAt > row.lastAt) row.lastAt = e.createdAt;
    byRider.set(e.riderId, row);
  }
  return [...byRider.values()].sort(
    (a, b) =>
      b.transferred - a.transferred ||
      b.declined - a.declined ||
      b.lastAt.localeCompare(a.lastAt) ||
      a.riderName.localeCompare(b.riderName),
  );
}

/** A pin a rider moved, and what it did to the delivery fee. */
export interface PinCorrection {
  id: string;
  riderId: string | null;
  riderName: string;
  orderId: string;
  /** Which end of the trip moved: where we deliver, or the pabili shop. */
  kind: 'dropoff' | 'pickup';
  /** How far the pin moved, in metres. */
  movedM: number | null;
  oldFee: number;
  newFee: number;
  createdAt: string;
  order: { serviceType: string; status: string } | null;
}

/**
 * Pins riders have corrected, newest first. Admin-only by RLS.
 *
 * Worth watching because a pin correction is the one rider action that raises
 * what a customer owes without anyone approving it. Almost all of these are
 * honest — the customer really did pin the wrong street, or a pabili shop they
 * were never standing in — but a rider who quietly nudges every trip longer
 * shows up here and nowhere else.
 */
export async function listPinCorrections(
  db: SupabaseClient,
  opts: { fromDay: string; toDay: string; limit?: number },
): Promise<PinCorrection[]> {
  const dayAfter = new Date(`${opts.toDay}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);

  const { data, error } = await db
    .from('order_pin_corrections')
    .select('id, rider_id, order_id, kind, moved_m, old_fee, new_fee, created_at, rider:riders(name), order:orders(service_type, status)')
    .gte('created_at', `${opts.fromDay}T00:00:00${MANILA_OFFSET}`)
    .lt('created_at', `${dayAfter.toISOString().slice(0, 10)}T00:00:00${MANILA_OFFSET}`)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((row): PinCorrection => {
    const rider = row.rider as { name?: string } | null;
    const order = row.order as { service_type?: string; status?: string } | null;
    return {
      id: row.id as string,
      riderId: (row.rider_id as string | null) ?? null,
      riderName: rider?.name ?? 'Unknown rider',
      orderId: row.order_id as string,
      kind: row.kind === 'pickup' ? 'pickup' : 'dropoff',
      movedM: row.moved_m == null ? null : Number(row.moved_m),
      oldFee: Number(row.old_fee ?? 0),
      newFee: Number(row.new_fee ?? 0),
      createdAt: row.created_at as string,
      order: order ? { serviceType: order.service_type ?? '', status: order.status ?? '' } : null,
    };
  });
}
