import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Create a Supabase client from explicit url/key (framework-agnostic so it works
 * in Vite apps, RN, and Node). Apps typically read these from their own env.
 */
export function createEbdClient(url: string, anonKey: string): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error('Supabase url and anon key are required');
  }
  return createClient(url, anonKey, {
    auth: {
      // Keep the session in storage and renew the access token in the
      // background, so riders/customers stay signed in across app restarts.
      persistSession: true,
      autoRefreshToken: true,
      // Password-reset links carry their token in the URL and must still sign
      // the user in when opened from their email app — including in a different
      // browser, which is why this stays on the implicit flow rather than PKCE
      // (PKCE needs the verifier from the browser that started the request).
      detectSessionInUrl: true,
      flowType: 'implicit',
    },
  });
}

export type { SupabaseClient };
