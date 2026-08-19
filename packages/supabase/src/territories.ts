/**
 * Territories — one city operator each.
 *
 * A territory owns its own fees, boundary, trading hours and payout details.
 * Row-level security decides what comes back: an operator sees their own city,
 * the franchisor sees every one. Opening, suspending and redrawing a territory
 * are franchisor-only and rejected at the database if anyone else tries.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type TerritoryStatus = 'draft' | 'active' | 'suspended';

export interface Territory {
  id: string;
  name: string;
  slug: string;
  status: TerritoryStatus;
  operator_profile_id: string | null;
  service_center_lat: number | null;
  service_center_lng: number | null;
  service_radius_km: number;
  is_open: boolean;
  commission_rate: number;
  markup_operator_share: number;
  created_at: string;
}

/** Every territory the caller may see, oldest first. */
export async function listTerritories(db: SupabaseClient): Promise<Territory[]> {
  const { data, error } = await db
    .from('territories')
    .select('id, name, slug, status, operator_profile_id, service_center_lat, service_center_lng, service_radius_km, is_open, commission_rate, markup_operator_share, created_at')
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as Territory[];
}

/** One territory, or null when the caller may not see it. */
export async function getTerritory(db: SupabaseClient, id: string): Promise<Territory | null> {
  const { data, error } = await db
    .from('territories')
    .select('id, name, slug, status, operator_profile_id, service_center_lat, service_center_lng, service_radius_km, is_open, commission_rate, markup_operator_share, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as Territory) ?? null;
}

/**
 * Open a new city. Starts as a draft: it takes no orders until it is activated,
 * which is what stops an operator trading before the franchisor says so.
 */
export async function createTerritory(
  db: SupabaseClient,
  territory: {
    name: string;
    slug: string;
    serviceCenterLat: number;
    serviceCenterLng: number;
    serviceRadiusKm: number;
    commissionRate: number;
    operatorProfileId?: string | null;
  },
): Promise<string> {
  const { data, error } = await db
    .from('territories')
    .insert({
      name: territory.name,
      slug: territory.slug,
      status: 'draft',
      service_center_lat: territory.serviceCenterLat,
      service_center_lng: territory.serviceCenterLng,
      service_radius_km: territory.serviceRadiusKm,
      commission_rate: territory.commissionRate,
      operator_profile_id: territory.operatorProfileId ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * Franchisor only. Suspending stops new orders without touching history, so a
 * city can be paused and restarted rather than lost.
 */
export async function setTerritoryStatus(
  db: SupabaseClient, id: string, status: TerritoryStatus,
): Promise<void> {
  const { error } = await db.from('territories').update({ status }).eq('id', id);
  if (error) throw error;
}

/** Franchisor only: move a city's centre or widen its radius. */
export async function setTerritoryBoundary(
  db: SupabaseClient,
  id: string,
  boundary: { lat: number; lng: number; radiusKm: number },
): Promise<void> {
  const { error } = await db
    .from('territories')
    .update({
      service_center_lat: boundary.lat,
      service_center_lng: boundary.lng,
      service_radius_km: boundary.radiusKm,
    })
    .eq('id', id);
  if (error) throw error;
}

/** Hand a city to an operator, or take it back with null. */
export async function assignTerritoryOperator(
  db: SupabaseClient, id: string, profileId: string | null,
): Promise<void> {
  const { error } = await db
    .from('territories')
    .update({ operator_profile_id: profileId })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Which territory a coordinate falls inside, or null if none does.
 *
 * The same routing the database applies when an order is written, exposed so the
 * apps can tell someone they are outside the service area before they have
 * filled in a whole order.
 */
export async function territoryForPoint(
  db: SupabaseClient, lat: number, lng: number,
): Promise<string | null> {
  const { data, error } = await db.rpc('territory_for_point', { p_lat: lat, p_lng: lng });
  if (error) throw error;
  return (data as string | null) ?? null;
}
