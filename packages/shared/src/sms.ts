/**
 * SMS message composition.
 *
 * Optional store notification: when enabled, the operator texts each store the
 * items to prepare when an order comes in. This complements the "rider calls the
 * store" model — it does not replace it. Delivery is via an SMS provider
 * (Semaphore for PH) from a server-side Edge Function.
 */

export interface SmsOrderItem {
  name: string;
  qty: number;
}

export interface StoreOrderSms {
  storeName: string;
  items: readonly SmsOrderItem[];
  /** Customer mobile so the store can coordinate if needed. */
  customerContact?: string;
  /** Free-text order notes (allergies, special requests). */
  notes?: string;
}

/**
 * Compose the SMS body texted to a store for its portion of an order. Kept
 * short — SMS bills per 160-char segment.
 *
 * @example
 * composeStoreOrderSms({ storeName: 'Lutong Bahay', items: [{name:'Adobo',qty:2}] })
 * // "ServdGo order for Lutong Bahay:\n2x Adobo\nPlease prepare for pickup."
 */
export function composeStoreOrderSms(order: StoreOrderSms): string {
  const lines = order.items.map((i) => `${i.qty}x ${i.name}`);
  const parts = [`ServdGo order for ${order.storeName}:`, ...lines];
  if (order.notes?.trim()) parts.push(`Note: ${order.notes.trim()}`);
  if (order.customerContact) parts.push(`Customer: ${order.customerContact}`);
  parts.push('Please prepare for pickup.');
  return parts.join('\n');
}

/** Number of 160-char SMS segments a message will cost. */
export function smsSegments(body: string): number {
  return Math.max(1, Math.ceil(body.length / 160));
}

/**
 * Normalize a PH mobile number to MSISDN form `639XXXXXXXXX` (digits only, no
 * '+') — what most PH SMS gateways (iSMS/BulkSMS PH, Semaphore) expect.
 * Accepts `09xx…`, `+639xx…`, `639xx…`, or `9xx…`.
 */
export function normalizePhMobile(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('63')) return digits;
  if (digits.startsWith('0')) return '63' + digits.slice(1);
  if (digits.startsWith('9') && digits.length === 10) return '63' + digits;
  return digits;
}
