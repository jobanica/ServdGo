/**
 * Padala (point-to-point courier) data access.
 *
 * Pure row builders are separated from I/O so the order-construction logic can
 * be unit-tested without a live database.
 */

import {
  commission,
  canTransition,
  DEFAULT_FEE_CONFIG,
  type FeeConfig,
  type FeePayer,
  type OrderStatus,
  type PaymentMethod,
} from '@ebd/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PadalaRequestInput {
  customerId: string;
  customerContact: string;
  deliveryFee: number;
  feePayer: FeePayer;
  itemDescription: string;
  pickup: { lat?: number; lng?: number; contact: string; address?: string };
  /** The receiver's full name matters: if the call goes unanswered the rider
   *  needs a name to ask for at the gate. */
  dropoff: { lat?: number; lng?: number; contact: string; name?: string; address?: string };
  /** Serviceable area chosen by the customer (province / city / barangay). */
  areaProvince?: string;
  areaCity?: string;
  areaBarangay?: string;
  notes?: string;
  paymentMethod?: PaymentMethod;
  /** Set when an online payment has already completed at checkout. */
  paid?: boolean;
}

/** The row inserted into `orders` for a Padala request. */
export interface PadalaOrderRow {
  customer_id: string;
  service_type: 'padala';
  status: 'pending';
  payment_method: PaymentMethod;
  payment_status: 'unpaid' | 'paid';
  delivery_fee: number;
  store_fee_total: 0;
  goods_cost: 0;
  commission_amount: number;
  item_description: string;
  padala_fee_payer: FeePayer;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_contact: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  dropoff_contact: string;
  recipient_name: string | null;
  recipient_contact: string;
  delivery_address: string | null;
  pickup_address: string | null;
  /** Mirrors the drop-off so live tracking (which reads delivery_*) works. */
  delivery_lat: number | null;
  delivery_lng: number | null;
  area_province: string | null;
  area_city: string | null;
  area_barangay: string | null;
  customer_contact: string;
  notes: string | null;
}

/**
 * Build the `orders` row for a Padala request. No goods, no store fee; the
 * commission is 15% of the delivery fee (storeCount 0).
 */
export function buildPadalaOrderRow(
  input: PadalaRequestInput,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): PadalaOrderRow {
  if (!input.itemDescription.trim()) {
    throw new Error('itemDescription is required for a Padala order');
  }
  if (input.deliveryFee < 0) {
    throw new Error('deliveryFee must be non-negative');
  }
  return {
    customer_id: input.customerId,
    service_type: 'padala',
    status: 'pending',
    payment_method: input.paymentMethod ?? 'cod',
    payment_status: input.paid ? 'paid' : 'unpaid',
    delivery_fee: input.deliveryFee,
    store_fee_total: 0,
    goods_cost: 0,
    commission_amount: commission({ deliveryFee: input.deliveryFee, storeCount: 0 }, config),
    item_description: input.itemDescription.trim(),
    padala_fee_payer: input.feePayer,
    pickup_lat: input.pickup.lat ?? null,
    pickup_lng: input.pickup.lng ?? null,
    pickup_contact: input.pickup.contact,
    dropoff_lat: input.dropoff.lat ?? null,
    dropoff_lng: input.dropoff.lng ?? null,
    dropoff_contact: input.dropoff.contact,
    recipient_name: input.dropoff.name?.trim() || null,
    recipient_contact: input.dropoff.contact,
    delivery_address: input.dropoff.address?.trim() || null,
    pickup_address: input.pickup.address?.trim() || null,
    delivery_lat: input.dropoff.lat ?? null,
    delivery_lng: input.dropoff.lng ?? null,
    area_province: input.areaProvince?.trim() || null,
    area_city: input.areaCity?.trim() || null,
    area_barangay: input.areaBarangay?.trim() || null,
    customer_contact: input.customerContact,
    notes: input.notes?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// I/O wrappers
// ---------------------------------------------------------------------------

/** Create a Padala order and return its id. */
export async function createPadalaOrder(
  db: SupabaseClient,
  input: PadalaRequestInput,
  config?: FeeConfig,
): Promise<string> {
  const row = buildPadalaOrderRow(input, config);
  const { data, error } = await db.from('orders').insert(row).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** The open pool a rider can accept from: pending, unassigned. */
export async function listOpenOrders(db: SupabaseClient) {
  const { data, error } = await db
    .from('orders')
    .select('*, order_stores(store:stores(id, name, contact_number, lat, lng)), order_items(id, store_id, menu_item_id, buy_store_index, name, qty, unit_price, markup_amount, notes, status, replaces_item_id)')
    .eq('status', 'pending')
    .is('rider_id', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Admin live board: all in-progress orders (not delivered/cancelled), newest
 * first, with the assigned rider embedded (null until someone accepts).
 */
export async function listActiveOrdersAdmin(db: SupabaseClient) {
  const { data, error } = await db
    .from('orders')
    // Name the FK explicitly: orders points at riders twice (rider_id and
    // payment_confirmed_by), so a bare riders(...) embed is ambiguous.
    .select('*, rider:riders!orders_rider_id_fkey(id, name, mobile_number)')
    .not('status', 'in', '(delivered,cancelled)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** A rider accepts an order: claim it and move to `accepted`. */
export async function acceptOrder(db: SupabaseClient, orderId: string, riderId: string) {
  const { data, error } = await db
    .from('orders')
    .update({ rider_id: riderId, status: 'accepted' })
    .eq('id', orderId)
    .eq('status', 'pending')
    .is('rider_id', null)
    .select('id');
  if (error) throw error;
  // No row updated means someone else grabbed it first (or it's no longer
  // pending). Surface it instead of silently doing nothing.
  if (!data || data.length === 0) {
    throw new Error('This order was just taken or is no longer available.');
  }
}

/**
 * A rider releases an active delivery back to the pool (e.g. breakdown), so
 * another rider can accept it. Goes through the release_order RPC so only the
 * handling rider can release their own order.
 */
export async function releaseOrder(db: SupabaseClient, orderId: string, reason?: string) {
  const { error } = await db.rpc('release_order', { p_order_id: orderId, p_reason: reason ?? null });
  if (error) throw error;
}

/**
 * Advance an order to the next status, validating the transition against the
 * service's flow. Also records an audit event.
 */
export async function advanceOrderStatus(
  db: SupabaseClient,
  order: { id: string; service_type: 'food' | 'pabili' | 'padala'; status: OrderStatus },
  next: OrderStatus,
) {
  if (!canTransition(order.service_type, order.status, next)) {
    throw new Error(`Illegal transition ${order.status} -> ${next} for ${order.service_type}`);
  }
  const { error } = await db.from('orders').update({ status: next }).eq('id', order.id);
  if (error) throw error;
  await db.from('order_status_events').insert({ order_id: order.id, status: next });
}
