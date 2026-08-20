import { createEbdClient } from '@servdgo/supabase';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * The shared Supabase client for the customer web app. Configured, but only
 * instantiated when env vars are present so the UI still renders in a bare dev
 * environment (the form falls back to a preview-only submit).
 */
export const supabase = url && anonKey ? createEbdClient(url, anonKey) : null;

export const isSupabaseConfigured = supabase !== null;

/**
 * Where a partner platform points its integration.
 *
 * Derived from the project URL rather than typed into a settings screen: it is
 * not a preference, it is where this deployment's endpoints actually are, and
 * an operator handing it over should never have to ask anybody for it.
 */
export const functionsBaseUrl = url ? `${url.replace(/\/+$/, '')}/functions/v1` : null;
