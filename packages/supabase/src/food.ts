/**
 * Food order data access — a multi-store cart becomes one order row plus its
 * line items and the store links that drive the per-store fee.
 */

import {
  summarizeCart,
  distinctStoreCount,
  withinStoreLimit,
  lineUnitPrice,
  DEFAULT_FEE_CONFIG,
  type CartLine,
  type FeeConfig,
  type PaymentMethod,
} from '@servdgo/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface FoodCheckoutInput {
  customerId: string;
  customerContact: string;
  customerName?: string;
  /** Serviceable area chosen by the customer (province / city / barangay). */
  areaProvince?: string;
  areaCity?: string;
  areaBarangay?: string;
  /** Recipient when delivering to someone else (sender still pays). */
  recipientName?: string;
  /** Written drop-off address, so the rider isn't relying on the pin alone. */
  deliveryAddress?: string;
  recipientContact?: string;
  deliveryFee: number;
  lines: CartLine[];
  deliveryLat?: number;
  deliveryLng?: number;
  notes?: string;
  paymentMethod?: PaymentMethod;
  paid?: boolean;
}

export interface FoodOrderRow {
  customer_id: string;
  service_type: 'food';
  status: 'pending';
  payment_method: PaymentMethod;
  payment_status: 'unpaid' | 'paid';
  delivery_fee: number;
  store_fee_total: number;
  convenience_fee: number;
  goods_cost: number;
  commission_amount: number;
  delivery_lat: number | null;
  delivery_lng: number | null;
  customer_contact: string;
  customer_name: string | null;
  area_province: string | null;
  area_city: string | null;
  area_barangay: string | null;
  recipient_name: string | null;
  delivery_address: string | null;
  recipient_contact: string | null;
  notes: string | null;
}

export interface BuiltFoodOrder {
  order: FoodOrderRow;
  storeIds: string[];
  items: {
    store_id: string;
    menu_item_id: string | null;
    name: string;
    qty: number;
    unit_price: number;
    options: unknown;
    notes: string | null;
  }[];
}

/**
 * Build the order row + line items + store links from a cart. Pure and
 * validated so checkout math can be tested without a database.
 */
export function buildFoodOrder(
  input: FoodCheckoutInput,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): BuiltFoodOrder {
  if (input.lines.length === 0) throw new Error('cart is empty');
  if (!withinStoreLimit(input.lines)) {
    throw new Error('an order may span at most 3 stores');
  }
  const summary = summarizeCart(input.lines, input.deliveryFee, config);
  return {
    order: {
      customer_id: input.customerId,
      service_type: 'food',
      status: 'pending',
      payment_method: input.paymentMethod ?? 'cod',
      payment_status: input.paid ? 'paid' : 'unpaid',
      delivery_fee: summary.deliveryFee,
      store_fee_total: summary.storeFeeTotal,
      convenience_fee: summary.convenienceFee,
      goods_cost: summary.goodsCost,
      commission_amount: summary.commission,
      delivery_lat: input.deliveryLat ?? null,
      delivery_lng: input.deliveryLng ?? null,
      customer_contact: input.customerContact,
      customer_name: input.customerName?.trim() || null,
    area_province: input.areaProvince?.trim() || null,
    area_city: input.areaCity?.trim() || null,
    area_barangay: input.areaBarangay?.trim() || null,
      recipient_name: input.recipientName?.trim() || null,
      delivery_address: input.deliveryAddress?.trim() || null,
      recipient_contact: input.recipientContact?.trim() || null,
      notes: input.notes?.trim() || null,
    },
    storeIds: [...new Set(input.lines.map((l) => l.storeId))],
    items: input.lines.map((l) => ({
      store_id: l.storeId,
      menu_item_id: l.menuItemId ?? null,
      name: l.name,
      qty: l.qty,
      unit_price: lineUnitPrice(l),
      options: l.options ?? null,
      notes: l.notes ?? null,
    })),
  };
}

/**
 * Persist a food order: insert the order, its line items, and store links.
 * (For production, prefer a Postgres RPC/transaction so the three writes are
 * atomic; kept as sequential inserts here for clarity.)
 */
export async function createFoodOrder(
  db: SupabaseClient,
  input: FoodCheckoutInput,
  config?: FeeConfig,
): Promise<string> {
  const built = buildFoodOrder(input, config);

  const { data, error } = await db.from('orders').insert(built.order).select('id').single();
  if (error) throw error;
  const orderId = (data as { id: string }).id;

  const itemsRes = await db
    .from('order_items')
    .insert(built.items.map((it) => ({ ...it, order_id: orderId })));
  if (itemsRes.error) throw itemsRes.error;

  const storesRes = await db
    .from('order_stores')
    .insert(built.storeIds.map((store_id) => ({ order_id: orderId, store_id })));
  if (storesRes.error) throw storesRes.error;

  return orderId;
}

export { distinctStoreCount };
