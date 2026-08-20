// Where the Xendit credentials come from.
//
// Two places, in this order: the edge-function environment, then the database.
// The environment wins because a deployment that already had XENDIT_SECRET_KEY
// set must not change behaviour the day the console gained the field for it.
//
// The database copy lives in Vault and comes back through xendit_credentials(),
// which is granted to service_role and to nothing else — that is the whole
// reason the franchisor can type a payment key into a browser and never read it
// back out of one.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface XenditConfig {
  secretKey: string | null;
  callbackToken: string | null;
  mode: 'test' | 'live';
  enabled: boolean;
  successUrl: string | null;
  invoiceDuration: number;
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

export async function xenditConfig(db?: SupabaseClient): Promise<XenditConfig> {
  const envKey = Deno.env.get('XENDIT_SECRET_KEY') ?? null;
  const envToken = Deno.env.get('XENDIT_CALLBACK_TOKEN') ?? null;

  let stored: Record<string, unknown> = {};
  try {
    const { data } = await (db ?? serviceClient()).rpc('xendit_credentials');
    if (data && typeof data === 'object') stored = data as Record<string, unknown>;
  } catch {
    // An older database without the settings simply has nothing to add.
  }

  const duration = Number(stored.invoiceDuration ?? 3600);
  return {
    secretKey: envKey ?? (stored.secretKey as string | null) ?? null,
    callbackToken: envToken ?? (stored.callbackToken as string | null) ?? null,
    mode: (stored.mode as 'test' | 'live') ?? 'test',
    // Env-configured deployments predate the switch, so a key with no stored
    // row still counts as on.
    enabled: stored.enabled === undefined ? Boolean(envKey) : Boolean(stored.enabled),
    successUrl: (stored.successUrl as string | null) ?? null,
    invoiceDuration: Number.isFinite(duration) ? duration : 3600,
  };
}

/** Basic auth the way Xendit wants it: the secret key as the username. */
export const xenditAuth = (key: string) => `Basic ${btoa(`${key}:`)}`;
