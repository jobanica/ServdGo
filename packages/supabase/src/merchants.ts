/**
 * Restaurants that book over the API rather than through the customer app.
 *
 * The operator onboards them: pin the restaurant, mint a key, point us at a
 * webhook URL. Everything here is scoped to the operator's own city by RLS —
 * a key minted for another city's restaurant is refused in the database.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface Merchant {
  id: string;
  name: string;
  slug: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_address: string | null;
  territory_id: string | null;
  contact_name: string | null;
  contact_number: string | null;
  contact_email: string | null;
  webhook_url: string | null;
  is_active: boolean;
  created_at: string;
}

export interface MerchantApiKey {
  id: string;
  merchant_id: string;
  label: string | null;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface WebhookDelivery {
  id: string;
  merchant_id: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export async function listMerchants(db: SupabaseClient): Promise<Merchant[]> {
  const { data, error } = await db
    .from('merchants')
    .select('id, name, slug, pickup_lat, pickup_lng, pickup_address, territory_id, contact_name, contact_number, contact_email, webhook_url, is_active, created_at')
    .order('name');
  if (error) throw error;
  return (data ?? []) as Merchant[];
}

export async function createMerchant(
  db: SupabaseClient,
  m: {
    name: string; slug: string;
    pickupLat: number; pickupLng: number; pickupAddress: string;
    contactName?: string; contactNumber?: string; contactEmail?: string;
    webhookUrl?: string; webhookSecret?: string;
  },
): Promise<string> {
  const { data, error } = await db
    .from('merchants')
    .insert({
      name: m.name,
      slug: m.slug,
      pickup_lat: m.pickupLat,
      pickup_lng: m.pickupLng,
      pickup_address: m.pickupAddress,
      contact_name: m.contactName ?? null,
      contact_number: m.contactNumber ?? null,
      contact_email: m.contactEmail ?? null,
      webhook_url: m.webhookUrl ?? null,
      webhook_secret: m.webhookSecret ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function setMerchantActive(
  db: SupabaseClient, id: string, active: boolean,
): Promise<void> {
  const { error } = await db.from('merchants').update({ is_active: active }).eq('id', id);
  if (error) throw error;
}

/** Where status changes are posted, and the secret they are signed with. */
export async function setMerchantWebhook(
  db: SupabaseClient, id: string, url: string | null, secret: string | null,
): Promise<void> {
  const { error } = await db
    .from('merchants')
    .update({ webhook_url: url || null, webhook_secret: secret || null })
    .eq('id', id);
  if (error) throw error;
}

export async function listMerchantKeys(
  db: SupabaseClient, merchantId: string,
): Promise<MerchantApiKey[]> {
  const { data, error } = await db
    .from('merchant_api_keys')
    .select('id, merchant_id, label, prefix, created_at, last_used_at, revoked_at')
    .eq('merchant_id', merchantId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as MerchantApiKey[];
}

/**
 * Mint a key. The returned string is the only copy — the database keeps a hash,
 * so it cannot be shown again and has to be handed over now.
 */
export async function createMerchantKey(
  db: SupabaseClient, merchantId: string, label?: string,
): Promise<string> {
  const { data, error } = await db.rpc('create_merchant_api_key', {
    p_merchant: merchantId, p_label: label ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function revokeMerchantKey(db: SupabaseClient, keyId: string): Promise<void> {
  const { error } = await db.rpc('revoke_merchant_api_key', { p_key_id: keyId });
  if (error) throw error;
}

/** Recent callbacks — the first question when a partner says an order went missing. */
export async function listWebhookDeliveries(
  db: SupabaseClient, merchantId?: string, limit = 50,
): Promise<WebhookDelivery[]> {
  let q = db
    .from('merchant_webhook_deliveries')
    .select('id, merchant_id, event, status, attempts, last_error, created_at, delivered_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (merchantId) q = q.eq('merchant_id', merchantId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as WebhookDelivery[];
}
