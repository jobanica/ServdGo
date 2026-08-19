// What a client needs to know before anybody signs in.
//
//   GET /functions/v1/v1-config
//   { "min_rider_app_version": "2.4.0", "min_customer_app_version": "1.0.0",
//     "support_email": …, "support_mobile": …, "maintenance_message": null }
//
// The rider app calls this at launch. If it is older than min_rider_app_version
// it shows the update screen instead of the sign-in screen, which is the only
// way to retire a build that is on somebody's phone and doing something wrong.
//
// Unauthenticated by design: a rider who cannot sign in because their build is
// broken still has to be told to update. It returns five fields and nothing
// else — public_config() picks them out of platform_settings in the database,
// so this function has no say in what is public.
//
// Deploy: supabase functions deploy v1-config --no-verify-jwt

import { serviceClient, json, preflight } from '../_shared/merchant.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const { data, error } = await serviceClient().rpc('public_config');
  if (error) {
    console.error('could not read platform config', error);
    return json({ error: 'server_error' }, 500);
  }

  // Cached briefly: every app launch hits this, and a minute of staleness on a
  // minimum version costs nothing.
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
