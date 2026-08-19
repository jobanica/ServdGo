/**
 * Active-rider management for the admin console: each approved rider's current
 * delivery, owed balance, lock state, plus a manual lock/unlock action.
 */

import { owedBalance, overdueBalance, isLockedOut, type LedgerEntry } from '@ebd/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export type RiderActivity = 'suspended' | 'locked' | 'on_delivery' | 'available' | 'offline';

export interface ActiveRider {
  id: string;
  name: string;
  mobile_number: string;
  vehicle: string | null;
  is_locked: boolean;
  is_suspended: boolean;
  suspend_reason: string | null;
  /** The rider's own on-duty toggle. */
  is_online: boolean;
  /** When they went on duty (null when off duty). */
  online_since: string | null;
  owed: number;
  overdue: number;
  activity: RiderActivity;
  activeOrder: { id: string; service_type: string; status: string } | null;
}

const IN_PROGRESS = ['accepted', 'preparing', 'picked_up', 'on_the_way'];

/** All approved riders with their current delivery, balance, and lock state. */
export async function listActiveRiders(db: SupabaseClient, today: string): Promise<ActiveRider[]> {
  const riders = await db
    .from('riders')
    .select('id, name, mobile_number, vehicle, is_locked, is_suspended, suspend_reason, is_online, online_since')
    .eq('application_status', 'approved')
    .order('name');
  if (riders.error) throw riders.error;

  const ledger = await db
    .from('commission_ledger')
    .select('rider_id, amount, business_day, settled')
    .eq('settled', false);
  if (ledger.error) throw ledger.error;

  const active = await db
    .from('orders')
    .select('id, rider_id, service_type, status')
    .not('rider_id', 'is', null)
    .in('status', IN_PROGRESS);
  if (active.error) throw active.error;

  const entriesByRider = new Map<string, LedgerEntry[]>();
  for (const row of (ledger.data ?? []) as Record<string, unknown>[]) {
    const rid = row.rider_id as string;
    const list = entriesByRider.get(rid) ?? [];
    list.push({ amount: Number(row.amount ?? 0), businessDay: row.business_day as string, settled: false });
    entriesByRider.set(rid, list);
  }
  const orderByRider = new Map<string, { id: string; service_type: string; status: string }>();
  for (const o of (active.data ?? []) as Record<string, unknown>[]) {
    orderByRider.set(o.rider_id as string, {
      id: o.id as string, service_type: o.service_type as string, status: o.status as string,
    });
  }

  return ((riders.data ?? []) as Record<string, unknown>[]).map((r) => {
    const id = r.id as string;
    const entries = entriesByRider.get(id) ?? [];
    const locked = (r.is_locked as boolean) || isLockedOut(entries, today);
    const suspended = Boolean(r.is_suspended);
    const activeOrder = orderByRider.get(id) ?? null;
    const online = Boolean(r.is_online);
    // "Available" used to mean "approved and not locked", which said nothing
    // about whether anyone was actually working. It now means on duty and free.
    const activity: RiderActivity =
      suspended ? 'suspended'
      : locked ? 'locked'
      : activeOrder ? 'on_delivery'
      : online ? 'available'
      : 'offline';
    return {
      id,
      name: r.name as string,
      mobile_number: r.mobile_number as string,
      vehicle: (r.vehicle as string) ?? null,
      is_locked: r.is_locked as boolean,
      is_suspended: suspended,
      suspend_reason: (r.suspend_reason as string) ?? null,
      is_online: online,
      online_since: (r.online_since as string) ?? null,
      owed: owedBalance(entries),
      overdue: overdueBalance(entries, today),
      activity,
      activeOrder,
    };
  });
}

/**
 * Who is on duty right now, for the dashboard roster.
 *
 * On duty means the rider's own toggle is on — plus anyone mid-delivery, since
 * a rider carrying an order is working whatever the toggle says (they may have
 * flipped it off to stop new requests while they finish). Suspended accounts
 * are never on duty; suspension forces them offline.
 *
 * Ordered the way an operator scans the list: who's out on a job first, then
 * whoever has been waiting longest for one.
 */
export function onDutyRiders(riders: readonly ActiveRider[]): ActiveRider[] {
  return riders
    .filter((r) => !r.is_suspended && (r.is_online || r.activity === 'on_delivery'))
    .sort((a, b) =>
      Number(b.activity === 'on_delivery') - Number(a.activity === 'on_delivery') ||
      (a.online_since ?? '').localeCompare(b.online_since ?? '') ||
      a.name.localeCompare(b.name));
}

/** Manually lock or unlock a rider (overrides the settlement gate). */
export async function setRiderLocked(db: SupabaseClient, riderId: string, locked: boolean) {
  const { error } = await db.from('riders').update({ is_locked: locked }).eq('id', riderId);
  if (error) throw error;
}

/**
 * Suspend (or reinstate) a rider account. A suspended rider can't go online or
 * claim orders, and is forced offline immediately.
 */
export async function setRiderSuspended(
  db: SupabaseClient, riderId: string, suspended: boolean, reason?: string,
) {
  const { error } = await db.rpc('admin_set_rider_suspended', {
    p_rider_id: riderId, p_suspended: suspended, p_reason: reason ?? null,
  });
  if (error) throw error;
}

export interface DeleteRiderResult {
  deleted: boolean;
  reason?: 'active_orders' | 'has_history';
  message?: string;
}

/**
 * Delete a rider who is no longer connected. Riders with delivery or commission
 * history can't be deleted (that history must be kept) — suspend them instead.
 */
export async function deleteRider(db: SupabaseClient, riderId: string): Promise<DeleteRiderResult> {
  const { data, error } = await db.rpc('admin_delete_rider', { p_rider_id: riderId });
  if (error) throw error;
  return (data ?? { deleted: false }) as DeleteRiderResult;
}
