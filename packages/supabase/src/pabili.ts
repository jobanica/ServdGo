/**
 * Pabili (buy-anything) data access.
 *
 * The request stores an estimate + cap and free-text items (no fixed menu).
 * After buying, the rider records the actual amount; the final collectible is
 * the actual goods cost + the delivery fee.
 */

import {
  validateBudget,
  commission,
  storeFeeTotal,
  needsOverBudgetConfirmation,
  DEFAULT_FEE_CONFIG,
  type FeeConfig,
  type PabiliBudget,
  type PaymentMethod,
} from '@ebd/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PabiliStoreInput {
  name: string;
  lat?: number | null;
  lng?: number | null;
}

export interface PabiliItemInput {
  qty: number;
  name: string;
  notes?: string;
  /** Index into `stores` for where to buy this. Undefined/null = any store. */
  storeIndex?: number | null;
}

/** Render a shopping list as the one-line summary older screens still show. */
export function pabiliItemsSummary(items: PabiliItemInput[]): string {
  return items
    .filter((i) => i.name.trim() !== '')
    .map((i) => `${Math.max(1, Math.round(i.qty || 1))}x ${i.name.trim()}`)
    .join(', ');
}

export interface PabiliRequestInput {
  customerId: string;
  customerContact: string;
  deliveryFee: number;
  /** Operator-set convenience fee (from app settings; not customer-editable). */
  convenienceFee?: number;
  /** Free-text list of what to buy (kept as the human-readable summary). */
  itemsDescription: string;
  /** Structured shopping list — one row per item, so the rider can tick them off. */
  items?: PabiliItemInput[];
  /**
   * Optional budget. The app stopped asking — nobody knows what a shopping run
   * costs until the rider is at the counter, and a guessed ceiling only ever
   * blocked the wrong purchase. Left in place for orders that do set one.
   */
  estimate?: number | null;
  cap?: number | null;
  /** Where to buy (specific store or "any nearest"). */
  where?: string;
  /** Every store the rider must visit. Each one past the first bills a store fee. */
  stores?: PabiliStoreInput[];
  /** Where the rider should buy (pickup pin). */
  pickupLat?: number;
  pickupLng?: number;
  deliveryLat?: number;
  deliveryLng?: number;
  /** Written drop-off address, so the rider isn't relying on the pin alone. */
  deliveryAddress?: string;
  /** Serviceable area chosen by the customer (province / city / barangay). */
  areaProvince?: string;
  areaCity?: string;
  areaBarangay?: string;
  notes?: string;
  paymentMethod?: PaymentMethod;
  paid?: boolean;
}

export interface PabiliOrderRow {
  customer_id: string;
  service_type: 'pabili';
  status: 'pending';
  payment_method: PaymentMethod;
  payment_status: 'unpaid' | 'paid';
  delivery_fee: number;
  convenience_fee: number;
  store_fee_total: number;
  buy_stores: PabiliStoreInput[];
  goods_cost: 0;
  commission_amount: number;
  estimated_amount: number | null;
  budget_cap: number | null;
  item_description: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  area_province: string | null;
  area_city: string | null;
  area_barangay: string | null;
  customer_contact: string;
  delivery_address: string | null;
  notes: string | null;
}

/** Build the `orders` row for a Pabili request (pure, validated). */
export function buildPabiliOrderRow(
  input: PabiliRequestInput,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): PabiliOrderRow {
  if (!input.itemsDescription.trim()) {
    throw new Error('itemsDescription is required for a Pabili order');
  }
  // Only validate a budget when one was given; the app no longer asks for one.
  if (input.estimate != null || input.cap != null) {
    const budget: PabiliBudget = { estimate: input.estimate ?? 0, cap: input.cap ?? 0 };
    validateBudget(budget);
  }

  const stores = (input.stores ?? [])
    .filter((st) => st.name.trim() !== '')
    .map((st) => ({ name: st.name.trim(), lat: st.lat ?? null, lng: st.lng ?? null }));
  // A pabili run always touches at least one store, even an unnamed "nearest".
  const storeCount = Math.max(1, stores.length);
  const storeFees = storeFeeTotal(storeCount, config);

  const whereLine = input.where?.trim() ? `Buy at: ${input.where.trim()}\n` : '';
  const noteLine = input.notes?.trim() ?? '';

  return {
    customer_id: input.customerId,
    service_type: 'pabili',
    status: 'pending',
    payment_method: input.paymentMethod ?? 'cod',
    payment_status: input.paid ? 'paid' : 'unpaid',
    delivery_fee: input.deliveryFee,
    convenience_fee: input.convenienceFee ?? 0,
    store_fee_total: storeFees,
    buy_stores: stores,
    goods_cost: 0, // unknown until the rider buys
    commission_amount: commission({ deliveryFee: input.deliveryFee, storeCount }, config),
    estimated_amount: input.estimate ?? null,
    budget_cap: input.cap ?? null,
    item_description: input.itemsDescription.trim(),
    pickup_lat: input.pickupLat ?? null,
    pickup_lng: input.pickupLng ?? null,
    delivery_lat: input.deliveryLat ?? null,
    delivery_lng: input.deliveryLng ?? null,
    area_province: input.areaProvince?.trim() || null,
    area_city: input.areaCity?.trim() || null,
    area_barangay: input.areaBarangay?.trim() || null,
    customer_contact: input.customerContact,
    delivery_address: input.deliveryAddress?.trim() || null,
    notes: (whereLine + noteLine).trim() || null,
  };
}

export async function createPabiliOrder(
  db: SupabaseClient,
  input: PabiliRequestInput,
  config?: FeeConfig,
): Promise<string> {
  const row = buildPabiliOrderRow(input, config);
  const { data, error } = await db.from('orders').insert(row).select('id').single();
  if (error) throw error;
  const id = (data as { id: string }).id;

  // Store the list as real line items so the rider gets a tickable list rather
  // than a paragraph. Prices are unknown until the receipt, hence unit_price 0.
  const items = (input.items ?? []).filter((i) => i.name.trim() !== '');
  if (items.length > 0) {
    const { error: itemsError } = await db.from('order_items').insert(
      items.map((i) => ({
        order_id: id,
        store_id: null,
        buy_store_index: i.storeIndex ?? null,
        name: i.name.trim(),
        qty: Math.max(1, Math.round(i.qty || 1)),
        unit_price: 0,
        notes: i.notes?.trim() || null,
      })),
    );
    // The order itself is placed; a failed item insert shouldn't lose it. The
    // description still carries the full list.
    if (itemsError) console.warn('pabili items not saved:', itemsError.message);
  }
  return id;
}

export interface ActualAmountResult {
  overCap: boolean;
}

/**
 * Upload the rider's photo of the store receipt for a pabili run. Lives in the
 * public store-assets bucket so the customer can open it from their order.
 */
export async function uploadPabiliReceipt(db: SupabaseClient, orderId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `pabili-receipts/${orderId}/${Date.now()}.${ext}`;
  const { error } = await db.storage.from('store-assets')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return db.storage.from('store-assets').getPublicUrl(path).data.publicUrl;
}

/**
 * Rider records the actual amount spent after buying. Sets goods_cost so the
 * amount-to-collect is accurate. Returns whether the spend exceeded the cap
 * (the caller/UI should prompt for customer confirmation before collecting).
 */
export async function updatePabiliActualAmount(
  db: SupabaseClient,
  order: { id: string; estimated_amount: number | null; budget_cap: number | null },
  actualAmount: number,
  receiptUrl?: string,
): Promise<ActualAmountResult> {
  if (actualAmount < 0) throw new Error('actualAmount must be non-negative');
  const patch: Record<string, unknown> = { actual_amount: actualAmount, goods_cost: actualAmount };
  if (receiptUrl) patch.goods_receipt_url = receiptUrl;
  const { error } = await db.from('orders').update(patch).eq('id', order.id);
  if (error) throw error;
  return {
    // No cap set means nothing to go over.
    overCap: order.budget_cap == null ? false : needsOverBudgetConfirmation(actualAmount, {
      estimate: order.estimated_amount ?? 0,
      cap: order.budget_cap,
    }),
  };
}

/**
 * The rider corrects where a pabili store actually is, from their own position.
 *
 * The customer pinned it from home, off memory or a map, and landed a street
 * away — on Pabili that is the normal case, not the exception, because they are
 * pinning a shop they are not standing in.
 *
 * Correcting the *first* store also moves the order's pickup pin and re-quotes
 * the delivery fee from it, because that is the pin the fee was measured from.
 * Later stores are extra stops paid for by the store fee, so fixing their pins
 * helps navigation without touching the bill.
 */
export interface BuyStorePinResult {
  updated: boolean;
  /** True when this pin drives the fee and the fee was re-quoted from it. */
  repriced?: boolean;
  reason?: 'outside_area' | 'unchanged';
  message?: string;
  moved_m?: number | null;
  old_fee?: number;
  new_fee?: number;
}

export async function riderSetBuyStoreLocation(
  db: SupabaseClient,
  orderId: string,
  index: number,
  at: { lat: number; lng: number },
): Promise<BuyStorePinResult> {
  const { data, error } = await db.rpc('rider_set_buy_store_location', {
    p_order_id: orderId, p_index: index, p_lat: at.lat, p_lng: at.lng,
  });
  if (error) throw error;
  return (data ?? { updated: false }) as BuyStorePinResult;
}
