/**
 * Rider-side settlement & active-order data access.
 *
 * The daily gate is enforced with the pure helpers in @ebd/shared
 * (owedBalance / overdueBalance / isLockedOut) applied to the rider's ledger
 * rows loaded here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A rider's in-progress orders (accepted but not yet delivered/cancelled),
 * with the linked store(s) embedded so the rider can call the restaurant.
 */
export async function listRiderActiveOrders(db: SupabaseClient, riderId: string) {
  const { data, error } = await db
    .from('orders')
    .select('*, order_stores(store:stores(id, name, contact_number, lat, lng)), order_items(id, store_id, menu_item_id, buy_store_index, name, qty, unit_price, markup_amount, notes, status, replaces_item_id)')
    .eq('rider_id', riderId)
    .not('status', 'in', '(delivered,cancelled)')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Manila is UTC+8 year-round (no DST), so a business day is a fixed offset. */
const MANILA_OFFSET = '+08:00';

/**
 * The rider's completed deliveries between two Philippine business days
 * (inclusive), newest first — the raw material for the earnings view.
 *
 * `delivered_at` is stamped when the order flips to delivered (migration 0054),
 * so a run that was accepted before midnight and finished after it counts on the
 * day it was actually completed — the same day the commission ledger books.
 */
export async function listRiderEarnings(
  db: SupabaseClient,
  riderId: string,
  fromDay: string,
  toDay: string,
) {
  // Half-open upper bound: everything before 00:00 Manila the day after `toDay`.
  const dayAfter = new Date(`${toDay}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  const { data, error } = await db
    .from('orders')
    .select('id, service_type, delivery_fee, store_fee_total, convenience_fee, commission_amount, payment_method, delivered_at')
    .eq('rider_id', riderId)
    .eq('status', 'delivered')
    .gte('delivered_at', `${fromDay}T00:00:00${MANILA_OFFSET}`)
    .lt('delivered_at', `${dayAfter.toISOString().slice(0, 10)}T00:00:00${MANILA_OFFSET}`)
    .order('delivered_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** The rider's commission ledger entries. */
export async function listRiderLedger(db: SupabaseClient, riderId: string) {
  const { data, error } = await db
    .from('commission_ledger')
    .select('*')
    .eq('rider_id', riderId)
    .order('business_day', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export interface SettlementRowInput {
  riderId: string;
  businessDay: string; // YYYY-MM-DD
  amountDue: number;
  method?: string;
  reference?: string;
  receiptUrl?: string;
}

export interface SettlementRow {
  rider_id: string;
  business_day: string;
  amount_due: number;
  method: string | null;
  reference: string | null;
  receipt_url: string | null;
  status: 'pending';
}

/** Build a settlement row (pure). Status starts pending until admin confirms. */
export function buildSettlementRow(input: SettlementRowInput): SettlementRow {
  if (input.amountDue < 0) throw new Error('amountDue must be non-negative');
  return {
    rider_id: input.riderId,
    business_day: input.businessDay,
    amount_due: input.amountDue,
    method: input.method ?? null,
    reference: input.reference ?? null,
    receipt_url: input.receiptUrl ?? null,
    status: 'pending',
  };
}

/** Upload a settlement receipt to the public store-assets bucket; returns its URL. */
export async function uploadSettlementReceipt(db: SupabaseClient, file: File): Promise<string> {
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new Error('not signed in');
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `settlement-receipts/${user.id}/${Date.now()}.${ext}`;
  const { error } = await db.storage.from('store-assets')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return db.storage.from('store-assets').getPublicUrl(path).data.publicUrl;
}

/** Upload the operator's settlement QR image (admin). Returns its public URL. */
export async function uploadSettlementQr(db: SupabaseClient, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const path = `settlement-qr/${Date.now()}.${ext}`;
  const { error } = await db.storage.from('store-assets')
    .upload(path, file, { upsert: true, contentType: file.type || undefined });
  if (error) throw error;
  return db.storage.from('store-assets').getPublicUrl(path).data.publicUrl;
}

/**
 * Rider submits a settlement payment for a business day. Admin confirmation
 * (mark-as-paid) flips it to `confirmed` and reactivates the account.
 */
export async function createSettlement(db: SupabaseClient, input: SettlementRowInput) {
  if (input.amountDue < 0) throw new Error('amountDue must be non-negative');
  // Upsert via RPC so re-settling a day that already has a settlement row
  // (e.g. confirmed earlier, then more commission accrued) reopens it as pending
  // instead of failing the unique(rider_id, business_day) constraint.
  const { data, error } = await db.rpc('rider_submit_settlement', {
    p_business_day: input.businessDay,
    p_amount: input.amountDue,
    p_method: input.method ?? null,
    p_reference: input.reference ?? null,
    p_receipt_url: input.receiptUrl ?? null,
  });
  if (error) throw new Error(error.message ?? 'Could not submit settlement');
  return data as string;
}

/**
 * The assigned rider records that a GCash-to-rider payment arrived — either
 * from the receipt the customer uploaded in the app, or one shown in person.
 */
export async function riderConfirmPayment(
  db: SupabaseClient, orderId: string, note?: string,
): Promise<void> {
  const { error } = await db.rpc('rider_confirm_payment', {
    p_order_id: orderId, p_note: note ?? null,
  });
  if (error) throw error;
}
