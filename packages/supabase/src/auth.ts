/**
 * Authentication (phone/email OTP) and identity bootstrap.
 *
 * Supabase Auth issues the session; RLS then resolves it through `profiles` to
 * the `customers` / `riders` row. `ensureCustomer` / `ensureRider` create that
 * domain row for the signed-in user on first login.
 *
 * Phone OTP needs an SMS provider configured on the Supabase project (Twilio,
 * etc.). Email OTP works with the built-in mailer. The helpers accept either.
 */

import type { SupabaseClient, User } from '@supabase/supabase-js';

export type OtpContact = { phone: string } | { email: string };

/** Send an OTP code (SMS or email depending on the contact). */
export async function sendOtp(db: SupabaseClient, contact: OtpContact) {
  const { error } = await db.auth.signInWithOtp(
    'phone' in contact ? { phone: contact.phone } : { email: contact.email },
  );
  if (error) throw error;
}

/**
 * Send a 6-digit sign-in code to an email (creates the account on first use).
 * Uses Supabase's built-in mailer — no SMS provider needed.
 */
export async function sendEmailOtp(db: SupabaseClient, email: string, redirectTo?: string) {
  const { error } = await db.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
  });
  if (error) throw error;
}

/** Verify an email OTP code and establish a session; returns the user. */
export async function verifyEmailOtp(db: SupabaseClient, email: string, token: string) {
  const { data, error } = await db.auth.verifyOtp({
    email: email.trim().toLowerCase(), token: token.trim(), type: 'email',
  });
  if (error) throw error;
  return data.user;
}

/** Verify the OTP code and establish a session. */
export async function verifyOtp(db: SupabaseClient, contact: OtpContact, token: string) {
  const params =
    'phone' in contact
      ? { phone: contact.phone, token, type: 'sms' as const }
      : { email: contact.email, token, type: 'email' as const };
  const { data, error } = await db.auth.verifyOtp(params);
  if (error) throw error;
  return data.user;
}

/** Sign in with an email + password. */
export async function signInWithPassword(db: SupabaseClient, email: string, password: string) {
  const { data, error } = await db.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) throw error;
  return data.user;
}

/**
 * Create an account with an email + password. With email confirmation disabled
 * on the project this returns an active session immediately (no email link).
 */
export async function signUpWithPassword(db: SupabaseClient, email: string, password: string) {
  const { data, error } = await db.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error) throw error;
  return data.user;
}

/** Send a password-reset email. The link returns to `redirectTo` (or the app). */
export async function sendPasswordReset(db: SupabaseClient, email: string, redirectTo?: string) {
  const { error } = await db.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
  if (error) throw error;
}

/** Set a new password for the currently-authenticated (or recovery) session. */
export async function updatePassword(db: SupabaseClient, password: string) {
  const { error } = await db.auth.updateUser({ password });
  if (error) throw error;
}

/**
 * Subscribe to the PASSWORD_RECOVERY auth event (fired when a user opens a
 * reset link). Returns an unsubscribe function.
 */
export function onPasswordRecovery(db: SupabaseClient, cb: () => void): () => void {
  const { data } = db.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') cb();
  });
  return () => data.subscription.unsubscribe();
}

export async function currentUser(db: SupabaseClient): Promise<User | null> {
  const { data } = await db.auth.getUser();
  return data.user;
}

export async function signOut(db: SupabaseClient) {
  await db.auth.signOut();
}

/** Subscribe to auth state changes; returns an unsubscribe function. */
export function onAuthChange(db: SupabaseClient, cb: (user: User | null) => void): () => void {
  const { data } = db.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
  return () => data.subscription.unsubscribe();
}

/**
 * Ensure a `customers` row exists for the signed-in user; returns its id.
 * Idempotent — safe to call on every login.
 */
export async function ensureCustomer(
  db: SupabaseClient,
  info: { name?: string; mobile: string },
): Promise<string> {
  const user = await currentUser(db);
  if (!user) throw new Error('not authenticated');
  const { data, error } = await db
    .from('customers')
    .upsert(
      { profile_id: user.id, name: info.name ?? null, mobile_number: info.mobile },
      { onConflict: 'profile_id' },
    )
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * Ensure a `riders` row exists for the signed-in user (application starts
 * `pending` until an admin approves). Returns the rider id.
 */
export async function ensureRider(
  db: SupabaseClient,
  info: { name: string; mobile: string; vehicle?: string },
): Promise<{ id: string; application_status: string }> {
  const user = await currentUser(db);
  if (!user) throw new Error('not authenticated');
  const { data, error } = await db
    .from('riders')
    .upsert(
      { profile_id: user.id, name: info.name, mobile_number: info.mobile, vehicle: info.vehicle ?? null },
      { onConflict: 'profile_id' },
    )
    .select('id, application_status')
    .single();
  if (error) throw error;
  return data as { id: string; application_status: string };
}
