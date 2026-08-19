/**
 * Serviceable areas — Province → City/Municipality → Barangay.
 * The operator maintains the list; the customer app uses it to check whether a
 * delivery address is inside the service area before an order is placed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ServiceArea {
  id: string;
  province: string;
  city: string;
  barangay: string;
  is_active: boolean;
}

/** All areas. Customers only ever see active ones (enforced by RLS). */
export async function listServiceAreas(db: SupabaseClient): Promise<ServiceArea[]> {
  const { data, error } = await db
    .from('service_areas')
    .select('id, province, city, barangay, is_active')
    .order('province')
    .order('city')
    .order('barangay');
  if (error) throw error;
  return (data ?? []) as ServiceArea[];
}

/** Add a barangay to the service list (staff only). */
export async function addServiceArea(
  db: SupabaseClient, area: { province: string; city: string; barangay: string; is_active?: boolean },
): Promise<ServiceArea> {
  const { data, error } = await db
    .from('service_areas')
    .insert({
      province: area.province.trim(),
      city: area.city.trim(),
      barangay: area.barangay.trim(),
      is_active: area.is_active ?? true,
    })
    .select('id, province, city, barangay, is_active')
    .single();
  if (error) throw error;
  return data as ServiceArea;
}

/** Tick/untick whether an area is currently served. */
export async function setServiceAreaActive(db: SupabaseClient, id: string, active: boolean) {
  const { error } = await db.from('service_areas').update({ is_active: active }).eq('id', id);
  if (error) throw error;
}

/** Set every barangay in a city (optionally one province) at once. */
export async function setCityAreasActive(
  db: SupabaseClient, province: string, city: string, active: boolean,
) {
  const { error } = await db
    .from('service_areas')
    .update({ is_active: active })
    .eq('province', province)
    .eq('city', city);
  if (error) throw error;
}

export async function deleteServiceArea(db: SupabaseClient, id: string) {
  const { error } = await db.from('service_areas').delete().eq('id', id);
  if (error) throw error;
}

/** Whether a specific barangay is currently served. */
export async function isAreaServiceable(
  db: SupabaseClient, province: string, city: string, barangay: string,
): Promise<boolean> {
  const { data, error } = await db.rpc('is_area_serviceable', {
    p_province: province, p_city: city, p_barangay: barangay,
  });
  if (error) throw error;
  return Boolean(data);
}

export interface AreaSelection { province: string; city: string; barangay: string }

/** Group areas into province → city → barangays for cascading pickers. */
export function groupAreas(areas: ServiceArea[]): Map<string, Map<string, ServiceArea[]>> {
  const byProvince = new Map<string, Map<string, ServiceArea[]>>();
  for (const a of areas) {
    const cities = byProvince.get(a.province) ?? new Map<string, ServiceArea[]>();
    const list = cities.get(a.city) ?? [];
    list.push(a);
    cities.set(a.city, list);
    byProvince.set(a.province, cities);
  }
  return byProvince;
}
