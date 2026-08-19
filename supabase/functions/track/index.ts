// The public tracking link: one URL to hand the diner, no login.
//
//   GET /functions/v1/track?t=<token>
//
// Returns a small page a phone can open, or JSON when asked for it — Servd can
// embed the same URL in their own UI if they would rather.
//
// The token is the only credential, so it is 244 bits of randomness and the
// answer behind it is deliberately narrow: the status, who is bringing it, and
// what is owed at the door. No internal ids, no merchant reference, nothing
// about the restaurant beyond its name.
//
// Deploy: supabase functions deploy track --no-verify-jwt

import { serviceClient, merchantCors } from '../_shared/merchant.ts';

const STEPS = ['pending', 'accepted', 'preparing', 'picked_up', 'on_the_way', 'delivered'];
const WORDS: Record<string, string> = {
  pending: 'Looking for a rider',
  accepted: 'A rider is on the way to collect it',
  preparing: 'Being prepared',
  picked_up: 'Collected',
  on_the_way: 'On the way to you',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(o: Record<string, unknown> | null): string {
  if (!o) {
    return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ServdGo</title>
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;height:100vh;
background:#f8f6f4;color:#1e1e1e;text-align:center;padding:1.5rem}</style>
<div><h1 style="font-size:1.25rem">This link is not valid</h1>
<p style="color:#666">Ask the restaurant for a new tracking link.</p></div>`;
  }

  const status = String(o.status ?? 'pending');
  const rider = o.rider as { name?: string; contact?: string; vehicle?: string } | null;
  const done = STEPS.indexOf(status);

  const steps = STEPS.map((s, i) => {
    const on = done >= i && status !== 'cancelled';
    return `<li style="display:flex;gap:.7rem;align-items:center;padding:.45rem 0;
      color:${on ? '#1e1e1e' : '#9a9a9a'}">
      <span style="width:.65rem;height:.65rem;border-radius:99px;flex:none;
        background:${on ? '#E8552F' : '#d9d5d2'}"></span>${escape(WORDS[s] ?? s)}</li>`;
  }).join('');

  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your ServdGo delivery</title>
<style>
  body{font:16px/1.55 system-ui,-apple-system,sans-serif;margin:0;background:#f8f6f4;color:#1e1e1e}
  .wrap{max-width:26rem;margin:0 auto;padding:1.5rem 1.25rem 3rem}
  .card{background:#fff;border-radius:1rem;padding:1.1rem 1.25rem;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-top:1rem}
  h1{font-size:1.4rem;margin:.2rem 0 .1rem}
  .muted{color:#6b6b6b;font-size:.9rem}
  ul{list-style:none;margin:0;padding:0}
  a.call{display:inline-block;margin-top:.6rem;background:#E8552F;color:#fff;text-decoration:none;
    padding:.55rem 1rem;border-radius:.7rem;font-weight:700;font-size:.95rem}
</style>
<div class="wrap">
  <p class="muted">ServdGo</p>
  <h1>${escape(WORDS[status] ?? status)}</h1>
  <p class="muted">From ${escape(String(o.from ?? ''))} to ${escape(String(o.dropoffAddress ?? ''))}</p>

  <div class="card"><ul>${steps}</ul></div>

  ${rider?.name ? `<div class="card">
    <p class="muted">Your rider</p>
    <p style="font-weight:700;margin:.1rem 0">${escape(rider.name)}${
      rider.vehicle ? ` · ${escape(rider.vehicle)}` : ''}</p>
    ${rider.contact ? `<a class="call" href="tel:${escape(rider.contact)}">Call ${escape(rider.contact)}</a>` : ''}
  </div>` : ''}

  <div class="card">
    <p class="muted">To pay on delivery</p>
    <p style="font-size:1.3rem;font-weight:800;margin:.1rem 0">₱${
      Number(o.amountDue ?? 0).toFixed(2)}</p>
    <p class="muted">Delivery only — the food is already paid for.</p>
  </div>
</div>`;
}

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

  return new Response(page(order), {
    status: order ? 200 : 404,
    headers: { ...merchantCors, 'content-type': 'text/html; charset=utf-8' },
  });
});
