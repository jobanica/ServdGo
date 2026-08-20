// Does the key the franchisor just pasted actually work?
//
//   POST /functions/v1/xendit-test
//   Authorization: Bearer <the franchisor's session token>
//
// Setting up a payment account is three fields and one long silence, and the
// usual way to find out you got it wrong is a rider paying ₱500 into nothing.
// This asks Xendit for the account balance — the cheapest authenticated call
// there is — and reports back what it found.
//
// The key is never sent to the browser and never comes back in the reply. Only
// the verdict does.
//
// Deploy: supabase functions deploy xendit-test

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { serviceClient, xenditConfig, xenditAuth } from '../_shared/xendit.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  if (!auth) return json({ error: 'unauthorised' }, 401);

  // The caller's own token decides whether they may do this: xendit_status()
  // refuses anyone who is not staff, and only the franchisor ever gets here
  // from the console.
  const asCaller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: status, error: statusError } = await asCaller.rpc('xendit_status');
  if (statusError) return json({ error: 'unauthorised', message: statusError.message }, 403);
  if (!status?.keySet && !Deno.env.get('XENDIT_SECRET_KEY')) {
    return json({ ok: false, reason: 'no_key', message: 'No secret key is stored yet.' });
  }

  const config = await xenditConfig(serviceClient());
  if (!config.secretKey) {
    return json({ ok: false, reason: 'no_key', message: 'No secret key is stored yet.' });
  }

  let res: Response;
  try {
    res = await fetch('https://api.xendit.co/balance', {
      headers: { authorization: xenditAuth(config.secretKey) },
    });
  } catch (e) {
    return json({ ok: false, reason: 'unreachable', message: String(e) });
  }

  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    return json({
      ok: false, reason: 'rejected',
      message: 'Xendit refused that key. Check you copied the secret key, not the public one.',
    });
  }
  if (!res.ok) {
    return json({ ok: false, reason: 'error', message: body?.message ?? `Xendit answered ${res.status}.` });
  }

  // A live key on an account still in test mode is the mismatch worth naming.
  const looksLive = config.secretKey.startsWith('xnd_production');
  return json({
    ok: true,
    mode: config.mode,
    keyIsProduction: looksLive,
    modeMismatch: looksLive !== (config.mode === 'live'),
    balance: typeof body?.balance === 'number' ? body.balance : null,
    callbackTokenSet: Boolean(config.callbackToken),
  });
});
