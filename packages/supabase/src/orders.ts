/**
 * Order queries for the admin console: filtered history and per-order detail.
 * Admin reads all orders (RLS `orders_admin_all`).
 */

import type { OrderStatus, ServiceType } from '@servdgo/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface OrderListFilters {
  serviceType?: ServiceType;
  status?: OrderStatus;
  /** Matches customer_contact (partial). */
  search?: string;
  /** Philippine business days, inclusive — the same span the ledger uses. */
  fromDay?: string;
  toDay?: string;
  limit?: number;
  offset?: number;
}

/** Manila is UTC+8 year-round, so a business day is a fixed eight-hour offset. */
const MANILA_OFFSET = '+08:00';

export interface OrderListResult<T = Record<string, unknown>> {
  rows: T[];
  count: number;
}

/** Filtered, paginated order list, newest first. */
export async function listOrders(
  db: SupabaseClient,
  filters: OrderListFilters = {},
): Promise<OrderListResult> {
  const limit = filters.limit ?? 20;
  const offset = filters.offset ?? 0;
  let q = db
    .from('orders')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.serviceType) q = q.eq('service_type', filters.serviceType);
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.search?.trim()) q = q.ilike('customer_contact', `%${filters.search.trim()}%`);
  if (filters.fromDay) q = q.gte('created_at', `${filters.fromDay}T00:00:00${MANILA_OFFSET}`);
  if (filters.toDay) {
    // Inclusive of the last day: everything before midnight that starts the next.
    const after = new Date(`${filters.toDay}T00:00:00Z`);
    after.setUTCDate(after.getUTCDate() + 1);
    q = q.lt('created_at', `${after.toISOString().slice(0, 10)}T00:00:00${MANILA_OFFSET}`);
  }

  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: data ?? [], count: count ?? 0 };
}

export interface OrderDetail {
  order: Record<string, unknown>;
  items: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

/** One order with its line items and status timeline. */
export async function getOrderDetail(db: SupabaseClient, orderId: string): Promise<OrderDetail> {
  const [order, items, events] = await Promise.all([
    db.from('orders').select('*').eq('id', orderId).single(),
    db.from('order_items').select('*').eq('order_id', orderId),
    db.from('order_status_events').select('*').eq('order_id', orderId).order('created_at'),
  ]);
  if (order.error) throw order.error;
  return {
    order: order.data as Record<string, unknown>,
    items: (items.data ?? []) as Record<string, unknown>[],
    events: (events.data ?? []) as Record<string, unknown>[],
  };
}

/**
 * Admin/staff manual cancellation of an order at any stage except delivered.
 * The reason is appended to the order notes. Returns true if it was cancelled.
 */
export async function adminCancelOrder(
  db: SupabaseClient, orderId: string, reason?: string,
): Promise<boolean> {
  const { data, error } = await db.rpc('admin_cancel_order', {
    p_order_id: orderId, p_reason: reason ?? null,
  });
  if (error) throw error;
  return Boolean(data);
}
