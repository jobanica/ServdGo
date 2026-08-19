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
  territory_id: string | null;
}

/**
 * Users holding a staff role.
 *
 * An operator sees their own city's, because that is all RLS will return them.
 * The franchisor sees every city's, so they can narrow to one.
 */
export async function listStaff(
  db: SupabaseClient, territoryId?: string,
): Promise<StaffMember[]> {
  let q = db
    .from('profiles')
    .select('id, full_name, role, territory_id')
    .in('role', STAFF_ROLES)
    .order('role');
  if (territoryId) q = q.eq('territory_id', territoryId);
  const { data, error } = await q;
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
  /** Franchisor only — which city the account belongs to. An operator's own
   *  city is taken from their profile and cannot be overridden here. */
  territoryId?: string;
  /** Franchisor only — also make this account the city's operator of record. */
  appointAsOperator?: boolean;
  /** Give the role to an account that already exists on this email, rather
   *  than failing. Its password is left alone. */
  attachExisting?: boolean;
}

export interface CreateStaffResult {
  id: string;
  /** True when an existing account was given the role instead of a new one made. */
  existing: boolean;
  appointed: boolean;
  territory: string | null;
}

/** Thrown when the email already belongs to somebody. Carries the offer to
 *  attach that account instead, so the caller can ask rather than guess. */
export class EmailTakenError extends Error {
  readonly emailTaken = true;
  constructor(message: string) {
    super(message);
    this.name = 'EmailTakenError';
  }
}

/**
 * Create a console account via the Edge Function that holds the service role.
 *
 * There is no sign-up screen anywhere in ServdGo: the franchisor makes an
 * operator's account and hands over the details, and an operator makes their
 * own staff's. This is the only door.
 */
export async function createStaff(
  db: SupabaseClient, input: CreateStaffInput,
): Promise<CreateStaffResult> {
  const { data, error } = await db.functions.invoke('create-staff', { body: input });
  if (!error) return data as CreateStaffResult;

  // invoke() reports "non-2xx status" and puts the real answer in the response,
  // which is where every message worth showing lives.
  const body = await readFunctionError(error);
  if (body?.emailTaken) throw new EmailTakenError(String(body.error ?? 'That email is taken'));
  throw new Error(String(body?.error ?? error.message));
}

async function readFunctionError(error: unknown): Promise<Record<string, unknown> | null> {
  const context = (error as { context?: Response }).context;
  if (!context || typeof context.json !== 'function') return null;
  try { return await context.json() as Record<string, unknown>; }
  catch { return null; }
}

/**
 * A password nobody has to invent.
 *
 * Handed over once and changed by the recipient; "Forgot password?" on the
 * sign-in screen is how they change it, so this never has to be memorable.
 */
export function generatePassword(length = 16): string {
  // No l/I/1/O/0: this gets read aloud or copied by hand often enough to matter.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
