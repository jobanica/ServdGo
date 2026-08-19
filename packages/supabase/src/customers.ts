/**
 * Customer self-service: profile, saved delivery addresses, and order history.
 * All reads/writes are scoped to the signed-in customer by RLS
 * (customers_self / customer_addresses_self / orders_customer_read).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface MyCustomer {
  id: string;
  name: string | null;
  mobile_number: string;
}

/** The customer row for the signed-in user, or null if none yet. */
export async function getMyCustomer(db: SupabaseClient): Promise<MyCustomer | null> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data, error } = await db
    .from('customers')
    .select('id, name, mobile_number')
    .eq('profile_id', user.id)
    .maybeSingle();
  if (error) throw error;
  return (data as MyCustomer | null) ?? null;
}

export interface CustomerOrder {
  id: string;
  service_type: string;
  status: string;
  created_at: string;
  goods_cost: number;
  delivery_fee: number;
  store_fee_total: number;
  convenience_fee: number;
  payment_method: string | null;
  recipient_name: string | null;
  recipient_contact: string | null;
  /** Pabili: the customer's estimate, and the rider's receipt total once known. */
  estimated_amount: number | null;
  actual_amount: number | null;
  /** Pabili: the rider's photo of the store receipt. */
  goods_receipt_url: string | null;
  /** Who it was for — kept with the address when the customer saves it. */
  customer_name: string | null;
  customer_contact: string | null;
  /** Where it went — used to offer saving a one-off address after it lands. */
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_address: string | null;
  area_province: string | null;
  area_city: string | null;
  area_barangay: string | null;
  order_stores: { store: { name: string | null } | null }[];
}

/**
 * The goods figure to charge for an order. A pabili run has no goods_cost until
 * the rider records the receipt total, so fall back to the customer's estimate —
 * otherwise the total looks like fees only.
 */
export function orderGoodsAmount(o: Pick<CustomerOrder, 'service_type' | 'goods_cost' | 'actual_amount' | 'estimated_amount'>): number {
  if (o.service_type === 'pabili') {
    return Number(o.goods_cost) || Number(o.actual_amount ?? o.estimated_amount ?? 0);
  }
  return Number(o.goods_cost ?? 0);
}

/** True once the goods figure is the rider's real receipt total, not an estimate. */
export function orderGoodsIsFinal(o: Pick<CustomerOrder, 'service_type' | 'actual_amount'>): boolean {
  return o.service_type !== 'pabili' || o.actual_amount != null;
}

/**
 * Line-item lifecycle when a store runs out mid-order:
 *   ok       — on the bill
 *   sold_out — the rider couldn't get it; off the bill
 *   proposed — the rider's suggested replacement, awaiting the customer's answer
 *   replaced — swapped out for an accepted replacement
 *   removed  — a suggestion the customer declined (or the rider withdrew)
 */
export type OrderItemStatus = 'ok' | 'sold_out' | 'proposed' | 'replaced' | 'removed';

export interface OrderItem {
  id?: string;
  name: string;
  qty: number;
  unitPrice: number;
  status?: OrderItemStatus;
  replacesItemId?: string | null;
}

/** The rider suggests something else in place of a sold-out item. */
export async function riderProposeReplacement(
  db: SupabaseClient, itemId: string, name: string, qty: number, unitPrice: number,
): Promise<string> {
  const { data, error } = await db.rpc('rider_propose_replacement', {
    p_item_id: itemId, p_name: name, p_qty: qty, p_unit_price: unitPrice,
  });
  if (error) throw error;
  return data as string;
}

/** The rider marks an item unavailable — it comes off the bill immediately. */
export async function riderMarkItemSoldOut(db: SupabaseClient, itemId: string): Promise<void> {
  const { error } = await db.rpc('rider_mark_item_sold_out', { p_item_id: itemId });
  if (error) throw error;
}

/** The customer accepts or declines a suggested replacement. */
/**
 * The rider corrects a line item's price to what the store is actually
 * charging. Recomputes the bill and tells the customer in the order chat —
 * a silent change to what someone owes is how you lose them.
 */
export async function riderCorrectItemPrice(
  db: SupabaseClient, itemId: string, unitPrice: number,
): Promise<void> {
  const { error } = await db.rpc('rider_correct_item_price', {
    p_item_id: itemId, p_unit_price: unitPrice,
  });
  if (error) throw error;
}

export interface PinCorrectionResult {
  updated: boolean;
  reason?: 'too_late' | 'too_far' | 'nothing_to_do';
  message?: string;
}

/**
 * The customer fixes a map pin they got wrong, before anyone has collected the
 * order. Refuses once the goods are with the rider, or if the new pin is far
 * enough away to be a different delivery — the message says which.
 */
export async function correctOrderPins(
  db: SupabaseClient,
  orderId: string,
  pins: { pickup?: { lat: number; lng: number }; dropoff?: { lat: number; lng: number }; address?: string },
): Promise<PinCorrectionResult> {
  const { data, error } = await db.rpc('customer_correct_order_pins', {
    p_order_id: orderId,
    p_pickup_lat: pins.pickup?.lat ?? null,
    p_pickup_lng: pins.pickup?.lng ?? null,
    p_delivery_lat: pins.dropoff?.lat ?? null,
    p_delivery_lng: pins.dropoff?.lng ?? null,
    p_delivery_address: pins.address ?? null,
  });
  if (error) throw error;
  return (data ?? { updated: false }) as PinCorrectionResult;
}

export interface RiderPinCorrectionResult {
  updated: boolean;
  reason?: 'outside_area' | 'unchanged';
  message?: string;
  /** How far the pin moved, in metres. */
  moved_m?: number | null;
  old_fee?: number;
  new_fee?: number;
}

/**
 * The rider moves the drop-off pin to where the customer actually is, and the
 * delivery fee is re-quoted from the real distance.
 *
 * The customer's own correction stops once the goods are collected — which is
 * usually before anyone has noticed the pin is wrong. The rider finds out at
 * the door, and under per-km pricing every kilometre of someone else's mistake
 * comes out of their pocket. The new fee is computed in the database, not
 * here: what a rider collects is not a number a rider types.
 *
 * Bounded by the service radius rather than by how far the pin moves — capping
 * the move would block the one case that needs this most, a pin dropped in the
 * wrong province. Every correction is recorded for the operator.
 */
export async function riderCorrectDeliveryPin(
  db: SupabaseClient,
  orderId: string,
  at: { lat: number; lng: number },
  address?: string,
): Promise<RiderPinCorrectionResult> {
  const { data, error } = await db.rpc('rider_correct_delivery_pin', {
    p_order_id: orderId, p_lat: at.lat, p_lng: at.lng, p_address: address ?? null,
  });
  if (error) throw error;
  return (data ?? { updated: false }) as RiderPinCorrectionResult;
}

export async function respondToItemChange(db: SupabaseClient, itemId: string, accept: boolean): Promise<void> {
  const { error } = await db.rpc('customer_respond_item_change', { p_item_id: itemId, p_accept: accept });
  if (error) throw error;
}

/** Cancel an order whose items have all sold out. Returns false if any remain. */
export async function cancelEmptyOrder(db: SupabaseClient, orderId: string): Promise<boolean> {
  const { data, error } = await db.rpc('customer_cancel_empty_order', { p_order_id: orderId });
  if (error) throw error;
  return data === true;
}

export interface OrderAddon {
  id: string;
  order_id: string;
  /** Set when the request carries a real store and basket, not free text. */
  store_id: string | null;
  /** What to buy there — empty for the older free-text errand. */
  items: { name: string; qty: number; unitPrice: number }[];
  description: string;
  store_name: string | null;
  est_amount: number;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  store_fee: number;
  created_at: string;
}

/** Add-on requests on an order, newest first (visible to its customer and rider). */
export async function listOrderAddons(db: SupabaseClient, orderId: string): Promise<OrderAddon[]> {
  const { data, error } = await db
    .from('order_addons')
    .select('id, order_id, store_id, description, store_name, est_amount, status, store_fee, created_at, items:order_addon_items(name, qty, unit_price)')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: o.id as string,
      order_id: o.order_id as string,
      store_id: (o.store_id as string) ?? null,
      items: ((o.items ?? []) as { name: string; qty: number; unit_price: number }[])
        .map((i) => ({ name: i.name, qty: Number(i.qty), unitPrice: Number(i.unit_price) })),
      description: o.description as string,
      store_name: (o.store_name as string) ?? null,
      est_amount: Number(o.est_amount ?? 0),
      status: (o.status as OrderAddon['status']) ?? 'pending',
      store_fee: Number(o.store_fee ?? 0),
      created_at: o.created_at as string,
    };
  });
}

/** Customer asks their rider for an extra stop on an order already under way. */
export async function requestOrderAddon(
  db: SupabaseClient, orderId: string,
  input: { description: string; storeName?: string; lat?: number; lng?: number; estimate?: number },
): Promise<string> {
  const { data, error } = await db.rpc('customer_request_addon', {
    p_order_id: orderId,
    p_description: input.description,
    p_store_name: input.storeName ?? null,
    p_lat: input.lat ?? null,
    p_lng: input.lng ?? null,
    p_est: input.estimate ?? 0,
  });
  if (error) throw error;
  return data as string;
}

/** Rider accepts or declines the extra stop. Accepting bills it and recomputes commission. */
export async function respondToAddon(db: SupabaseClient, addonId: string, accept: boolean): Promise<void> {
  const { error } = await db.rpc('rider_respond_addon', { p_addon_id: addonId, p_accept: accept });
  if (error) throw error;
}

/** Customer withdraws a request the rider hasn't answered yet. */
export async function cancelOrderAddon(db: SupabaseClient, addonId: string): Promise<void> {
  const { error } = await db.rpc('customer_cancel_addon', { p_addon_id: addonId });
  if (error) throw error;
}

export interface ActiveDelivery {
  id: string;
  status: string;
  service_type: string;
  payment_method: string | null;
  pickup: { lat: number; lng: number } | null;
  dropoff: { lat: number; lng: number } | null;
  storeName: string | null;
  items: OrderItem[];
  /** What the customer owes, so a COD order can show the cash to prepare. */
  goods_cost: number;
  delivery_fee: number;
  store_fee_total: number;
  convenience_fee: number;
  estimated_amount: number | null;
  actual_amount: number | null;
  /** Set the moment the rider says they're at the door. */
  arrived_at: string | null;
  delivery_address: string | null;
}

/**
 * The customer's current in-progress delivery (a rider is assigned and it isn't
 * delivered/cancelled), with pickup (store) and drop-off coordinates for the
 * live tracking map. Null when there's nothing to track.
 */
export async function getActiveDelivery(db: SupabaseClient, customerId: string): Promise<ActiveDelivery | null> {
  const { data, error } = await db
    .from('orders')
    .select('id, status, service_type, payment_method, item_description, pickup_lat, pickup_lng, delivery_lat, delivery_lng, goods_cost, delivery_fee, store_fee_total, convenience_fee, estimated_amount, actual_amount, arrived_at, delivery_address, order_stores(store:stores(name, lat, lng)), order_items(id, name, qty, unit_price, status, replaces_item_id)')
    .eq('customer_id', customerId)
    .not('rider_id', 'is', null)
    .not('status', 'in', '(delivered,cancelled)')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as {
    id: string; status: string; service_type: string; payment_method: string | null; item_description: string | null;
    pickup_lat: number | null; pickup_lng: number | null;
    delivery_lat: number | null; delivery_lng: number | null;
    goods_cost: number | null; delivery_fee: number | null;
    store_fee_total: number | null; convenience_fee: number | null;
    estimated_amount: number | null; actual_amount: number | null;
    arrived_at: string | null; delivery_address: string | null;
    order_stores?: { store: { name: string | null; lat: number | null; lng: number | null } | null }[];
    order_items?: { id: string; name: string; qty: number; unit_price: number; status: string | null; replaces_item_id: string | null }[];
  } | undefined;
  if (!row) return null;
  const store = row.order_stores?.find((os) => os.store?.lat != null && os.store?.lng != null)?.store
    ?? row.order_stores?.[0]?.store ?? null;
  const items = (row.order_items ?? []).map((it) => ({
    id: it.id, name: it.name, qty: Number(it.qty ?? 1), unitPrice: Number(it.unit_price ?? 0),
    status: (it.status ?? 'ok') as OrderItemStatus, replacesItemId: it.replaces_item_id ?? null,
  }));
  return {
    id: row.id,
    status: row.status,
    service_type: row.service_type,
    payment_method: row.payment_method ?? null,
    // Food orders pick up at a store; pabili/padala have no store row, so fall
    // back to the pickup pin the customer set on the order.
    pickup: store && store.lat != null && store.lng != null
      ? { lat: store.lat, lng: store.lng }
      : row.pickup_lat != null && row.pickup_lng != null
        ? { lat: row.pickup_lat, lng: row.pickup_lng }
        : null,
    dropoff: row.delivery_lat != null && row.delivery_lng != null ? { lat: row.delivery_lat, lng: row.delivery_lng } : null,
    storeName: store?.name ?? (row.service_type === 'padala' ? 'Pickup point' : row.service_type === 'pabili' ? 'Buy here' : null),
    items: items.length ? items : (row.item_description ? [{ name: row.item_description, qty: 1, unitPrice: 0 }] : []),
    goods_cost: Number(row.goods_cost ?? 0),
    delivery_fee: Number(row.delivery_fee ?? 0),
    store_fee_total: Number(row.store_fee_total ?? 0),
    convenience_fee: Number(row.convenience_fee ?? 0),
    estimated_amount: row.estimated_amount == null ? null : Number(row.estimated_amount),
    actual_amount: row.actual_amount == null ? null : Number(row.actual_amount),
    arrived_at: row.arrived_at ?? null,
    delivery_address: row.delivery_address ?? null,
  };
}

export interface MyOrderDetail {
  id: string;
  service_type: string;
  status: string;
  created_at: string;
  delivered_at: string | null;
  payment_method: string | null;
  payment_status: string | null;
  goods_cost: number;
  delivery_fee: number;
  store_fee_total: number;
  convenience_fee: number;
  estimated_amount: number | null;
  actual_amount: number | null;
  goods_receipt_url: string | null;
  item_description: string | null;
  notes: string | null;
  delivery_address: string | null;
  area_province: string | null;
  area_city: string | null;
  area_barangay: string | null;
  recipient_name: string | null;
  recipient_contact: string | null;
  customer_name: string | null;
  customer_contact: string | null;
  stores: string[];
  items: {
    id: string;
    name: string;
    qty: number;
    unitPrice: number;
    notes: string | null;
    status: OrderItemStatus;
    storeName: string | null;
  }[];
}

/**
 * One of the caller's own orders in full — what was bought, from where, and
 * what each part of the bill was for.
 *
 * The history list can only show a total; when someone questions a charge weeks
 * later, the total is exactly the number they are querying. RLS scopes this to
 * the caller's own orders, so there is nothing to check here beyond the id.
 */
export async function getMyOrderDetail(db: SupabaseClient, orderId: string): Promise<MyOrderDetail | null> {
  const { data, error } = await db
    .from('orders')
    .select('id, service_type, status, created_at, delivered_at, payment_method, payment_status, goods_cost, delivery_fee, store_fee_total, convenience_fee, estimated_amount, actual_amount, goods_receipt_url, item_description, notes, delivery_address, area_province, area_city, area_barangay, recipient_name, recipient_contact, customer_name, customer_contact, order_stores(store:stores(name)), order_items(id, name, qty, unit_price, notes, status, store:stores(name))')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as Record<string, unknown>;
  const num = (v: unknown) => Number(v ?? 0);
  return {
    id: row.id as string,
    service_type: row.service_type as string,
    status: row.status as string,
    created_at: row.created_at as string,
    delivered_at: (row.delivered_at as string) ?? null,
    payment_method: (row.payment_method as string) ?? null,
    payment_status: (row.payment_status as string) ?? null,
    goods_cost: num(row.goods_cost),
    delivery_fee: num(row.delivery_fee),
    store_fee_total: num(row.store_fee_total),
    convenience_fee: num(row.convenience_fee),
    estimated_amount: row.estimated_amount == null ? null : num(row.estimated_amount),
    actual_amount: row.actual_amount == null ? null : num(row.actual_amount),
    goods_receipt_url: (row.goods_receipt_url as string) ?? null,
    item_description: (row.item_description as string) ?? null,
    notes: (row.notes as string) ?? null,
    delivery_address: (row.delivery_address as string) ?? null,
    area_province: (row.area_province as string) ?? null,
    area_city: (row.area_city as string) ?? null,
    area_barangay: (row.area_barangay as string) ?? null,
    recipient_name: (row.recipient_name as string) ?? null,
    recipient_contact: (row.recipient_contact as string) ?? null,
    customer_name: (row.customer_name as string) ?? null,
    customer_contact: (row.customer_contact as string) ?? null,
    stores: ((row.order_stores ?? []) as { store: { name: string | null } | null }[])
      .map((os) => os.store?.name).filter((n): n is string => Boolean(n)),
    items: ((row.order_items ?? []) as Record<string, unknown>[]).map((it) => ({
      id: it.id as string,
      name: it.name as string,
      qty: Number(it.qty ?? 1),
      unitPrice: num(it.unit_price),
      notes: (it.notes as string) ?? null,
      status: ((it.status as OrderItemStatus) ?? 'ok'),
      storeName: (it.store as { name?: string } | null)?.name ?? null,
    })),
  };
}

export interface OrderRiderInfo {
  name: string | null;
  mobile_number: string | null;
  photo_url: string | null;
}

/** The assigned rider's name/contact/photo for the caller's own order (tracking card). */
export async function getOrderRiderInfo(db: SupabaseClient, orderId: string): Promise<OrderRiderInfo | null> {
  const { data, error } = await db.rpc('order_rider_info', { p_order_id: orderId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { name: row.name ?? null, mobile_number: row.mobile_number ?? null, photo_url: row.photo_url ?? null } : null;
}

export interface OrderPayToRider {
  rider_name: string | null;
  payout_number: string | null;
  amount: number;
  /** Goods portion of `amount` — an estimate until the rider records the receipt. */
  goods_amount: number;
  goods_is_final: boolean;
  goods_receipt_url: string | null;
  delivery_fee: number;
  store_fee_total: number;
  convenience_fee: number;
  /** Flips to 'paid' once the rider confirms the GCash transfer arrived. */
  payment_status: 'unpaid' | 'paid';
  /** Proof already on file, so a reload doesn't look like nothing was sent. */
  payment_receipt_url: string | null;
  payment_reference: string | null;
  payment_confirmed_at: string | null;
}

/**
 * The assigned rider's GCash/Maya details + amount for one of the caller's own
 * orders, so the sender can pay. Null until a rider accepts. If the rider has no
 * payout number, the caller falls back to the operator's settlement number.
 */
export async function getOrderPayToRider(db: SupabaseClient, orderId: string): Promise<OrderPayToRider | null> {
  const { data, error } = await db.rpc('order_pay_to_rider', { p_order_id: orderId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row ? {
    rider_name: row.rider_name ?? null,
    payout_number: row.payout_number ?? null,
    amount: Number(row.amount ?? 0),
    goods_amount: Number(row.goods_amount ?? 0),
    goods_is_final: row.goods_is_final !== false,
    goods_receipt_url: row.goods_receipt_url ?? null,
    delivery_fee: Number(row.delivery_fee ?? 0),
    store_fee_total: Number(row.store_fee_total ?? 0),
    convenience_fee: Number(row.convenience_fee ?? 0),
    payment_status: row.payment_status === 'paid' ? 'paid' : 'unpaid',
    payment_receipt_url: row.payment_receipt_url ?? null,
    payment_reference: row.payment_reference ?? null,
    payment_confirmed_at: row.payment_confirmed_at ?? null,
  } : null;
}

/** Upload the sender's proof of payment for an order and record it on the order. */
export async function uploadPaymentReceipt(db: SupabaseClient, orderId: string, file: File, reference?: string): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `payment-receipts/${orderId}/${Date.now()}.${ext}`;
  const { error: upErr } = await db.storage.from('store-assets')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (upErr) throw upErr;
  const url = db.storage.from('store-assets').getPublicUrl(path).data.publicUrl;
  const { error } = await db.rpc('set_order_payment_proof', { p_order_id: orderId, p_receipt_url: url, p_reference: reference ?? null });
  if (error) throw error;
  return url;
}

/** Record just a payment reference (no receipt image) on the caller's order. */
export async function setOrderPaymentReference(db: SupabaseClient, orderId: string, reference: string): Promise<void> {
  const { error } = await db.rpc('set_order_payment_proof', { p_order_id: orderId, p_receipt_url: null, p_reference: reference });
  if (error) throw error;
}

export interface AddableStore {
  storeId: string;
  storeName: string;
}

export interface AddStoreResult {
  /** True when it went straight onto the order — no rider had taken it yet. */
  applied: boolean;
  addon_id: string;
}

/**
 * Ask for a whole extra store on an order already under way, with what to buy.
 *
 * A new store is a new stop — another queue, another counter, often a detour —
 * so unlike adding to a shop the rider is already visiting, this one is put to
 * them first. Nothing is charged and nothing is added until they accept; a stop
 * they can't make should never reach the bill. Up to three stores in all.
 */
export async function addOrderStore(
  db: SupabaseClient,
  orderId: string,
  storeId: string,
  items: { menuItemId: string; qty: number }[],
): Promise<AddStoreResult> {
  const { data, error } = await db.rpc('customer_add_order_store', {
    p_order_id: orderId,
    p_store_id: storeId,
    p_items: items.map((i) => ({ menu_item_id: i.menuItemId, qty: i.qty })),
  });
  if (error) throw error;
  return data as AddStoreResult;
}

/**
 * Add one more thing from a store already on a food order.
 *
 * Allowed while the rider is still at or heading to the shop; once they have
 * the food and are on the way, the counter is behind them. The rider is told
 * in the chat, and marks it sold out if the kitchen has run out — the same
 * path as any other item.
 */
export async function addOrderItem(
  db: SupabaseClient,
  orderId: string,
  menuItemId: string,
  qty = 1,
  notes?: string,
): Promise<string> {
  const { data, error } = await db.rpc('customer_add_order_item', {
    p_order_id: orderId, p_menu_item_id: menuItemId, p_qty: qty, p_notes: notes ?? null,
  });
  if (error) throw error;
  return data as string;
}

/** The stores on an order, so the customer can add from the right menu. */
export async function listOrderStores(db: SupabaseClient, orderId: string): Promise<AddableStore[]> {
  const { data, error } = await db
    .from('order_stores')
    .select('store_id, store:stores(name)')
    .eq('order_id', orderId);
  if (error) throw error;
  return ((data ?? []) as unknown as { store_id: string; store: { name: string | null } | null }[])
    .map((r) => ({ storeId: r.store_id, storeName: r.store?.name ?? 'Store' }));
}

/** Cancel a still-pending, unassigned order. Returns true if it was cancelled. */
export async function cancelOrder(db: SupabaseClient, orderId: string): Promise<boolean> {
  const { data, error } = await db.rpc('cancel_order', { p_order_id: orderId });
  if (error) throw error;
  return Boolean(data);
}

/** The customer's recent orders (newest first). */
export async function listCustomerOrders(db: SupabaseClient, customerId: string): Promise<CustomerOrder[]> {
  const { data, error } = await db
    .from('orders')
    .select('id, service_type, status, created_at, goods_cost, delivery_fee, store_fee_total, convenience_fee, payment_method, recipient_name, recipient_contact, estimated_amount, actual_amount, goods_receipt_url, customer_name, customer_contact, delivery_lat, delivery_lng, delivery_address, area_province, area_city, area_barangay, order_stores(store:stores(name))')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as unknown as CustomerOrder[];
}

export interface CustomerAddress {
  id: string;
  label: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  is_default: boolean;
  /** Who the rider asks for here; null falls back to the customer's own name. */
  contact_name: string | null;
  /** Number to ring for this address; null falls back to the customer's own. */
  contact_phone: string | null;
  /** Serviceable area saved with the address, so ordering can prefill it. */
  province: string | null;
  city: string | null;
  barangay: string | null;
}

export async function listAddresses(db: SupabaseClient, customerId: string): Promise<CustomerAddress[]> {
  const { data, error } = await db
    .from('customer_addresses')
    .select('*')
    .eq('customer_id', customerId)
    .order('is_default', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CustomerAddress[];
}

export async function addAddress(db: SupabaseClient, input: {
  customerId: string; label?: string; address: string; lat?: number | null; lng?: number | null; isDefault?: boolean;
  /** Saved alongside so ordering can prefill the serviceable area too. */
  province?: string | null; city?: string | null; barangay?: string | null;
  /** Who to ask for here and what number to ring — an address needs a person. */
  contactName?: string | null; contactPhone?: string | null;
}) {
  if (input.isDefault) {
    await db.from('customer_addresses').update({ is_default: false }).eq('customer_id', input.customerId);
  }
  const { error } = await db.from('customer_addresses').insert({
    customer_id: input.customerId,
    label: input.label?.trim() || null,
    address: input.address.trim(),
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    is_default: input.isDefault ?? false,
    province: input.province ?? null,
    city: input.city ?? null,
    barangay: input.barangay ?? null,
    contact_name: input.contactName?.trim() || null,
    contact_phone: input.contactPhone?.trim() || null,
  });
  if (error) throw error;
}

/**
 * Stamp the serviceable area onto a saved address that hasn't got one.
 *
 * Addresses saved before the area picker existed carry a pin and a written
 * address but no province/city/barangay, so every order to them asked for the
 * area again — the one thing choosing a saved address was supposed to spare
 * the customer. The first time they pick it, it sticks.
 */
export async function setAddressArea(
  db: SupabaseClient,
  id: string,
  area: { province: string; city: string; barangay: string },
) {
  const { error } = await db.from('customer_addresses')
    .update({ province: area.province, city: area.city, barangay: area.barangay })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteAddress(db: SupabaseClient, id: string) {
  const { error } = await db.from('customer_addresses').delete().eq('id', id);
  if (error) throw error;
}

export async function setDefaultAddress(db: SupabaseClient, customerId: string, id: string) {
  await db.from('customer_addresses').update({ is_default: false }).eq('customer_id', customerId);
  const { error } = await db.from('customer_addresses').update({ is_default: true }).eq('id', id);
  if (error) throw error;
}
