import { createEbdClient } from '@ebd/supabase';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * The shared Supabase client for the customer web app. Configured, but only
 * instantiated when env vars are present so the UI still renders in a bare dev
 * environment (the form falls back to a preview-only submit).
 */
export const supabase = url && anonKey ? createEbdClient(url, anonKey) : null;

export const isSupabaseConfigured = supabase !== null;
