/**
 * Staff directory & role management (admin-only via RLS).
 *
 * Listing staff and changing roles are simple profile reads/writes. Creating a
 * brand-new staff *account* needs the service role, so it goes through the
 * `create-staff` Edge Function (see supabase/functions/create-staff).
 */

import { STAFF_ROLES, type StaffRole } from '@servdgo/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface StaffMember {
  id: string;
  full_name: string | null;
  role: StaffRole;
}

/** All users holding a staff role. */
export async function listStaff(db: SupabaseClient): Promise<StaffMember[]> {
  const { data, error } = await db
    .from('profiles')
    .select('id, full_name, role')
    .in('role', STAFF_ROLES)
    .order('role');
  if (error) throw error;
  return (data ?? []) as StaffMember[];
}

/** Change a user's role (admin only, enforced by RLS). */
export async function setUserRole(db: SupabaseClient, userId: string, role: StaffRole | 'customer') {
  const { error } = await db.from('profiles').update({ role }).eq('id', userId);
  if (error) throw error;
}

/** Revoke staff access (demote to customer). */
export async function revokeStaff(db: SupabaseClient, userId: string) {
  return setUserRole(db, userId, 'customer');
}

export interface CreateStaffInput {
  email: string;
  password: string;
  role: StaffRole;
  fullName?: string;
}

/** Create a new staff account via the admin-gated Edge Function. */
export async function createStaff(db: SupabaseClient, input: CreateStaffInput) {
  const { data, error } = await db.functions.invoke('create-staff', { body: input });
  if (error) throw error;
  return data as { id: string };
}
