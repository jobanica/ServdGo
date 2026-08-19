/**
 * App settings (the singleton `app_settings` row) and audience counts for
 * broadcasts. Admin-only writes are enforced by RLS.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface AppSettings {
  is_open: boolean;
  /** Shown to customers and riders while closed. Null uses the default wording. */
  closed_message: string | null;
  schedule: unknown;
  default_delivery_fee: number;
  per_store_fee: number;
  /** Legacy single convenience fee — kept as the fallback for the per-service ones. */
  convenience_fee: number;
  /** Per-service convenience fees (charged to the customer, earned by the rider). */
  convenience_fee_food: number;
  convenience_fee_pabili: number;
  convenience_fee_padala: number;
  commission_rate: number;
  /** Fraction of each price mark-up the operator keeps; the rest is the rider's. */
  markup_operator_share: number;
  delivery_fee_model: 'flat' | 'per_km' | 'per_zone';
  settlement_cutoff: string;
  sms_notify_stores: boolean;
  /** Distance-fee rate (used when delivery_fee_model = 'per_km'). */
  delivery_base_fare: number;
  delivery_base_km: number;
  delivery_per_km: number;
  /** Per-service on/off switches. */
  service_food: boolean;
  service_pabili: boolean;
  service_padala: boolean;
  /** Max active (not delivered/cancelled) orders a rider may hold. 0 = unlimited. */
  max_active_orders_per_rider: number;
  /** Where riders send their daily commission settlement (GCash/Maya). */
  settlement_gcash_number: string | null;
  settlement_gcash_name: string | null;
  settlement_qr_url: string | null;
  /** Delivery-area guard: pin + radius the drop-off must fall inside (0 = off). */
  service_center_lat: number | null;
  service_center_lng: number | null;
  service_radius_km: number;
}

export interface PlatformStatus {
  open: boolean;
  /** The operator's own wording, when they set one. */
  message: string | null;
  /** Orders neither delivered nor cancelled — the queue that must drain. */
  outstanding: number;
  /** Pending orders nobody has taken yet. */
  unassigned: number;
}

/** The default announcement, used when the operator hasn't written their own. */
export const CLOSED_MESSAGE =
  "ServdGo is closed at the moment. We're not taking new orders right now — please try again later.";

/**
 * Are we open, and how much work is still out there?
 *
 * Asked by both apps on launch. The outstanding count is what keeps the rider
 * app usable while the queue drains: closing stops new orders, it doesn't
 * abandon the ones already placed.
 */
export async function getPlatformStatus(db: SupabaseClient): Promise<PlatformStatus> {
  const { data, error } = await db.rpc('platform_status');
  if (error) throw error;
  const s = (data ?? {}) as Partial<PlatformStatus>;
  return {
    // Unknown means open: a failed lookup must never shutter a working service.
    open: s.open !== false,
    message: s.message ?? null,
    outstanding: Number(s.outstanding ?? 0),
    unassigned: Number(s.unassigned ?? 0),
  };
}

export async function getAppSettings(db: SupabaseClient): Promise<AppSettings> {
  const { data, error } = await db.from('app_settings').select('*').eq('id', true).single();
  if (error) throw error;
  return data as AppSettings;
}

export async function updateAppSettings(db: SupabaseClient, patch: Partial<AppSettings>): Promise<void> {
  const { error } = await db
    .from('app_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true);
  if (error) throw error;
}

export type BroadcastAudience = 'customers' | 'riders' | 'stores';

/** Count how many recipients an audience has (for the broadcast preview). */
export async function countAudience(db: SupabaseClient, audience: BroadcastAudience): Promise<number> {
  if (audience === 'customers') {
    const { count } = await db.from('customers').select('id', { count: 'exact', head: true });
    return count ?? 0;
  }
  if (audience === 'riders') {
    const { count } = await db
      .from('riders').select('id', { count: 'exact', head: true })
      .eq('application_status', 'approved');
    return count ?? 0;
  }
  const { count } = await db
    .from('stores').select('id', { count: 'exact', head: true })
    .not('contact_number', 'is', null);
  return count ?? 0;
}
