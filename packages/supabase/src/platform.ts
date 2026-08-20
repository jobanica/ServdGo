/**
 * The franchisor's platform controls: viewing a city as its operator, the
 * settings and flags that apply everywhere, notices, overrides and exports.
 *
 * View-as is not a client-side filter. Starting a session changes what the
 * database itself will return for this user and refuses every write, so the
 * console has to reload after begin/end rather than assume its cached rows are
 * still the rows this user may see.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ViewSession {
  id: number;
  franchisor_id: string;
  territory_id: string;
  reason: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface PlatformSettings {
  min_rider_app_version: string;
  min_customer_app_version: string;
  support_email: string | null;
  support_mobile: string | null;
  maintenance_message: string | null;
  commission_rate_min: number;
  commission_rate_max: number;
  royalty_rate: number;
  royalty_cycle: string;
  webhook_max_attempts: number;
  cod_float_limit: number | null;
  /** When on, a delivery deducts its commission from the rider's wallet. */
  wallet_enabled: boolean;
  wallet_min_topup: number;
  wallet_max_topup: number;
  wallet_low_balance: number;
  /** How far below zero a wallet may sit overnight before the rider is locked. */
  wallet_credit_limit: number;
}

export interface FeatureFlag {
  key: string;
  description: string;
  default_enabled: boolean;
}

export interface FeatureFlagOverride {
  flag_key: string;
  territory_id: string;
  enabled: boolean;
  note: string | null;
}

export type AnnouncementAudience =
  'operators' | 'riders' | 'merchants' | 'customers' | 'everyone';

export interface Announcement {
  id: number;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  territory_id: string | null;
  severity: 'info' | 'warning' | 'critical';
  starts_at: string;
  ends_at: string | null;
  created_at: string;
}

export interface KeyUsage {
  key_id: string;
  merchant_id: string;
  merchant_name: string;
  label: string | null;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  calls: number;
}

export interface MerchantHealth {
  merchant_id: string;
  merchant_name: string;
  territory_id: string | null;
  territory_name: string | null;
  is_active: boolean;
  webhook_url: string | null;
  active_keys: number;
  last_call_at: string | null;
  calls: number;
  orders_placed: number;
  webhooks_pending: number;
  webhooks_failed: number;
  last_delivery_at: string | null;
  last_error: string | null;
}

export interface PublicConfig {
  min_rider_app_version: string;
  min_customer_app_version: string;
  support_email: string | null;
  support_mobile: string | null;
  maintenance_message: string | null;
}

/**
 * What an app may know before anybody signs in.
 *
 * Reachable with the anon key on purpose: a build that is too old to work still
 * has to be able to find out that it is too old.
 */
export async function publicConfig(db: SupabaseClient): Promise<PublicConfig> {
  const { data, error } = await db.rpc('public_config');
  if (error) throw error;
  return data as PublicConfig;
}

/**
 * Compare dotted versions. Missing parts count as zero, so "1.2" is 1.2.0, and
 * anything unparseable sorts as 0 rather than throwing at app launch.
 */
export function versionAtLeast(actual: string, required: string): boolean {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(actual), b = parts(required);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// ---------------------------------------------------------------------------
// View as tenant
// ---------------------------------------------------------------------------

/** The city being viewed, or null. Cheap enough to call on every page. */
export async function viewingAsTerritory(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.rpc('viewing_as_territory');
  if (error) throw error;
  return (data as string | null) ?? null;
}

export async function beginViewAs(
  db: SupabaseClient, territoryId: string, reason?: string,
): Promise<number> {
  const { data, error } = await db.rpc('begin_view_as', {
    p_territory: territoryId, p_reason: reason ?? null,
  });
  if (error) throw error;
  return Number(data);
}

export async function endViewAs(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc('end_view_as');
  if (error) throw error;
}

export async function listViewSessions(db: SupabaseClient): Promise<ViewSession[]> {
  const { data, error } = await db
    .from('hq_view_sessions')
    .select('id, franchisor_id, territory_id, reason, started_at, ended_at')
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as ViewSession[];
}

// ---------------------------------------------------------------------------
// Platform settings and feature flags
// ---------------------------------------------------------------------------

export async function getPlatformSettings(db: SupabaseClient): Promise<PlatformSettings> {
  const { data, error } = await db
    .from('platform_settings')
    .select('min_rider_app_version, min_customer_app_version, support_email, support_mobile, maintenance_message, commission_rate_min, commission_rate_max, royalty_rate, royalty_cycle, webhook_max_attempts, cod_float_limit, wallet_enabled, wallet_min_topup, wallet_max_topup, wallet_low_balance, wallet_credit_limit')
    .eq('id', true)
    .single();
  if (error) throw error;
  return data as PlatformSettings;
}

export async function savePlatformSettings(
  db: SupabaseClient, patch: Partial<PlatformSettings>,
): Promise<void> {
  const { error } = await db.from('platform_settings').update(patch).eq('id', true);
  if (error) throw error;
}

export async function listFeatureFlags(db: SupabaseClient): Promise<FeatureFlag[]> {
  const { data, error } = await db
    .from('feature_flags')
    .select('key, description, default_enabled')
    .order('key');
  if (error) throw error;
  return (data ?? []) as FeatureFlag[];
}

export async function listFlagOverrides(db: SupabaseClient): Promise<FeatureFlagOverride[]> {
  const { data, error } = await db
    .from('feature_flag_overrides')
    .select('flag_key, territory_id, enabled, note');
  if (error) throw error;
  return (data ?? []) as FeatureFlagOverride[];
}

export async function setFlagDefault(
  db: SupabaseClient, key: string, enabled: boolean,
): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .update({ default_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('key', key);
  if (error) throw error;
}

/** Set a city's override, or clear it so the platform default applies again. */
export async function setFlagOverride(
  db: SupabaseClient, key: string, territoryId: string, enabled: boolean | null,
): Promise<void> {
  if (enabled === null) {
    const { error } = await db
      .from('feature_flag_overrides')
      .delete()
      .eq('flag_key', key)
      .eq('territory_id', territoryId);
    if (error) throw error;
    return;
  }
  const { error } = await db
    .from('feature_flag_overrides')
    .upsert({ flag_key: key, territory_id: territoryId, enabled }, { onConflict: 'flag_key,territory_id' });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export async function listAnnouncements(db: SupabaseClient): Promise<Announcement[]> {
  const { data, error } = await db
    .from('announcements')
    .select('id, title, body, audience, territory_id, severity, starts_at, ends_at, created_at')
    .order('starts_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as Announcement[];
}

/** What this user has not dismissed yet — the banner in the partner panels. */
export async function unreadAnnouncements(db: SupabaseClient): Promise<Announcement[]> {
  const { data, error } = await db.rpc('unread_announcements');
  if (error) throw error;
  return (data ?? []) as Announcement[];
}

export async function markAnnouncementRead(db: SupabaseClient, id: number): Promise<void> {
  const { error } = await db.rpc('mark_announcement_read', { p_id: id });
  if (error) throw error;
}

export async function publishAnnouncement(
  db: SupabaseClient,
  input: {
    title: string; body: string; audience?: AnnouncementAudience;
    territoryId?: string | null; severity?: 'info' | 'warning' | 'critical';
    endsAt?: string | null;
  },
): Promise<number> {
  const { data, error } = await db.rpc('publish_announcement', {
    p_title: input.title,
    p_body: input.body,
    p_audience: input.audience ?? 'operators',
    p_territory: input.territoryId ?? null,
    p_severity: input.severity ?? 'info',
    p_ends_at: input.endsAt ?? null,
  });
  if (error) throw error;
  return Number(data);
}

export async function deleteAnnouncement(db: SupabaseClient, id: number): Promise<void> {
  const { error } = await db.from('announcements').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Merchant integrations
// ---------------------------------------------------------------------------

export async function merchantHealth(
  db: SupabaseClient, days = 30,
): Promise<MerchantHealth[]> {
  const { data, error } = await db.rpc('merchant_health', { p_days: days });
  if (error) throw error;
  return (data ?? []) as MerchantHealth[];
}

export async function keyUsage(
  db: SupabaseClient, merchantId?: string, days = 30,
): Promise<KeyUsage[]> {
  const { data, error } = await db.rpc('merchant_key_usage', {
    p_merchant: merchantId ?? null, p_days: days,
  });
  if (error) throw error;
  return (data ?? []) as KeyUsage[];
}

export async function replayWebhook(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.rpc('replay_merchant_webhook', { p_id: id });
  if (error) throw error;
}

export async function replayFailedWebhooks(
  db: SupabaseClient, merchantId: string,
): Promise<number> {
  const { data, error } = await db.rpc('replay_failed_webhooks', { p_merchant: merchantId });
  if (error) throw error;
  return Number(data ?? 0);
}

// ---------------------------------------------------------------------------
// Delivery overrides
// ---------------------------------------------------------------------------

export async function hqReassignOrder(
  db: SupabaseClient, orderId: string, riderId: string, reason: string,
): Promise<void> {
  const { error } = await db.rpc('hq_reassign_order', {
    p_order: orderId, p_rider: riderId, p_reason: reason,
  });
  if (error) throw error;
}

export async function hqCancelOrder(
  db: SupabaseClient, orderId: string, reason: string,
): Promise<void> {
  const { error } = await db.rpc('hq_cancel_order', { p_order: orderId, p_reason: reason });
  if (error) throw error;
}

export async function hqRedispatchOrder(
  db: SupabaseClient, orderId: string, reason: string,
): Promise<void> {
  const { error } = await db.rpc('hq_redispatch_order', { p_order: orderId, p_reason: reason });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type ExportDataset =
  'deliveries' | 'commissions' | 'remittances' | 'royalty' | 'invoices';

/**
 * Fetch a dataset as CSV text.
 *
 * The rows are turned into lines by the database, so the quoting is the same
 * whether this is called from the console or the hq-export function.
 */
export async function exportCsv(
  db: SupabaseClient, dataset: ExportDataset, territoryId: string,
  from?: string, to?: string,
): Promise<string> {
  const { data, error } = await db.rpc('hq_export', {
    p_dataset: dataset, p_territory: territoryId, p_from: from ?? null, p_to: to ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as string[]).join('\r\n');
}

// ---------------------------------------------------------------------------
// Finding the delivery an override applies to
// ---------------------------------------------------------------------------

export interface OverrideTarget {
  id: string;
  status: string;
  service_type: string;
  rider_id: string | null;
  territory_id: string | null;
  customer_name: string | null;
  customer_contact: string | null;
  delivery_address: string | null;
  delivery_fee: number;
  commission_amount: number;
  merchant_reference: string | null;
  created_at: string;
  delivered_at: string | null;
}

/** Look a delivery up by its id, its tracking token or a partner's reference. */
export async function findDelivery(
  db: SupabaseClient, needle: string,
): Promise<OverrideTarget | null> {
  const columns = 'id, status, service_type, rider_id, territory_id, customer_name, customer_contact, delivery_address, delivery_fee, commission_amount, merchant_reference, created_at, delivered_at';
  const term = needle.trim();
  if (!term) return null;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
  const { data, error } = isUuid
    ? await db.from('orders').select(columns).eq('id', term).maybeSingle()
    : await db.from('orders').select(columns)
        .or(`merchant_reference.eq.${term},tracking_token.eq.${term}`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
  if (error) throw error;
  return (data as OverrideTarget | null) ?? null;
}

export interface AssignableRider {
  id: string;
  name: string;
  mobile_number: string;
  is_online: boolean;
}

/** Approved riders in a city — who a delivery can be handed to. */
export async function assignableRiders(
  db: SupabaseClient, territoryId: string,
): Promise<AssignableRider[]> {
  const { data, error } = await db
    .from('riders')
    .select('id, name, mobile_number, is_online')
    .eq('territory_id', territoryId)
    .eq('application_status', 'approved')
    .order('is_online', { ascending: false })
    .order('name');
  if (error) throw error;
  return (data ?? []) as AssignableRider[];
}
