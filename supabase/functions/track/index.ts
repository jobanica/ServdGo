// The public tracking link: one URL to hand the diner, no login.
//
//   GET /functions/v1/track?t=<token>
//
// Answers with JSON, and sends a browser to the page that reads it.
//
// The page itself lives in the customer web app. It was server-rendered here
// until Supabase's gateway made that impossible: HTML from an edge function is
// served as text/plain with nosniff — deliberately, so nobody hosts pages on a
// *.supabase.co domain — and the diner got a screenful of markup instead of
// their delivery. JSON from the same function is served correctly, so the data
// was never the problem.
//
// The token is the only credential, so it is 244 bits of randomness and the
// answer behind it is deliberately narrow: the status, who is bringing it, and
// what is owed at the door. No internal ids, no merchant reference, nothing
// about the restaurant beyond its name, and the rider's position only while
// they are actually carrying it.
//
// Deploy: supabase functions deploy track --no-verify-jwt

import { serviceClient, merchantCors } from '../_shared/merchant.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: merchantCors });

  const token = new URL(req.url).searchParams.get('t') ?? '';
  const db = serviceClient();
  const { data } = await db.rpc('track_merchant_order', { p_token: token });
  const order = (data as Record<string, unknown> | null) ?? null;

  if ((req.headers.get('accept') ?? '').includes('application/json')) {
    return new Response(JSON.stringify(order ?? { error: 'not_found' }), {
      status: order ? 200 : 404,
      headers: { ...merchantCors, 'content-type': 'application/json' },
    });
  }

  // A browser gets sent to the page. Supabase serves HTML from a function as
  // text/plain with nosniff — deliberately, so nobody hosts pages on their
  // domain — so rendering here would show the diner the markup. The page lives
  // in the customer web app; this function stays the thing that answers with
  // JSON, which is served correctly and is what the page reads.
  const { data: link } = await db.rpc('tracking_link', { p_token: token });
  if (order && typeof link === 'string' && link) {
    return new Response(null, { status: 302, headers: { ...merchantCors, location: link } });
  }

  return new Response(
    order ? 'Open this link on a phone browser.' : 'This link is not valid.',
    { status: order ? 200 : 404, headers: { ...merchantCors, 'content-type': 'text/plain; charset=utf-8' } },
  );
});
