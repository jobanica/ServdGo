/**
 * Admin-side settlement management: see who owes/who's locked, confirm rider
 * payments, and reactivate accounts.
 */

import {
  summarizeRiderBalances,
  isLockedOut,
  type LedgerEntry,
  type RiderBalance,
  type RiderLedgerGroup,
} from '@ebd/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function toLedgerEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    amount: Number(row.amount ?? 0),
    businessDay: row.business_day as string,
    settled: Boolean(row.settled),
  };
}

/**
 * Per-rider owed/overdue/lock summary as of `today` (YYYY-MM-DD). Loads riders
 * and their unsettled ledger, then aggregates with the shared helper.
 */
export async function listRiderBalances(
  db: SupabaseClient,
  today: string,
): Promise<RiderBalance[]> {
  const riders = await db.from('riders').select('id, name');
  if (riders.error) throw riders.error;

  const ledger = await db
    .from('commission_ledger')
    .select('rider_id, amount, business_day, settled')
    .eq('settled', false);
  if (ledger.error) throw ledger.error;

  const byRider = new Map<string, RiderLedgerGroup>();
  for (const r of (riders.data ?? []) as { id: string; name: string }[]) {
    byRider.set(r.id, { riderId: r.id, riderName: r.name, entries: [] });
  }
  for (const row of (ledger.data ?? []) as Record<string, unknown>[]) {
    const g = byRider.get(row.rider_id as string);
    if (g) (g.entries as LedgerEntry[]).push(toLedgerEntry(row));
  }
  return summarizeRiderBalances([...byRider.values()], today);
}

/** Pending settlement submissions awaiting admin confirmation. */
export async function listPendingSettlements(db: SupabaseClient) {
  const { data, error } = await db
    .from('settlements')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Settlement history (confirmed + pending), optionally for one rider. */
export async function listSettlementHistory(db: SupabaseClient, riderId?: string) {
  let q = db.from('settlements').select('*').order('created_at', { ascending: false });
  if (riderId) q = q.eq('rider_id', riderId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/**
 * Confirm a rider's settlement for a business day:
 *  1. mark the settlement `confirmed`,
 *  2. mark that day's ledger entries `settled`,
 *  3. reactivate the account if no overdue balance remains.
 *
 * (Best done as a Postgres RPC/transaction in production; sequential here.)
 */
export async function confirmSettlement(
  db: SupabaseClient,
  params: { settlementId: string; riderId: string; businessDay: string; adminProfileId: string; today: string },
) {
  const upd = await db
    .from('settlements')
    .update({ status: 'confirmed', confirmed_by: params.adminProfileId || null, confirmed_at: new Date().toISOString() })
    .eq('id', params.settlementId);
  if (upd.error) throw upd.error;

  // Settle everything up to and including the paid day, so one payment clears
  // all the rider's overdue commission (not just that single day).
  const led = await db
    .from('commission_ledger')
    .update({ settled: true })
    .eq('rider_id', params.riderId)
    .lte('business_day', params.businessDay);
  if (led.error) throw led.error;

  // Recompute lock from whatever remains unsettled.
  const remaining = await db
    .from('commission_ledger')
    .select('amount, business_day, settled')
    .eq('rider_id', params.riderId)
    .eq('settled', false);
  if (remaining.error) throw remaining.error;

  const stillLocked = isLockedOut(
    (remaining.data ?? []).map((r) => toLedgerEntry(r as Record<string, unknown>)),
    params.today,
  );
  const lockUpd = await db.from('riders').update({ is_locked: stillLocked }).eq('id', params.riderId);
  if (lockUpd.error) throw lockUpd.error;

  return { reactivated: !stillLocked };
}
