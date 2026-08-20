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
// The map appears once the rider is actually carrying it, and shows only their
// last known position and the drop-off — never the restaurant's exact pin, and
// never a history of where they have been. Leaflet and OpenStreetMap tiles are
// loaded from a CDN; if that fails the page still tells the diner everything
// that matters in words, which is the part that has to work on a bad connection
// in someone's hand.
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
  const rider = o.rider as {
    name?: string; contact?: string; vehicle?: string;
    position?: { lat: number; lng: number; at: string } | null;
  } | null;
  const dropoff = o.dropoff as { lat: number; lng: number } | null;
  const pos = rider?.position ?? null;
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
  #map{height:16rem;border-radius:.8rem;margin-top:.75rem;background:#eceae8}
  .waiting{font-size:.85rem;color:#8a8a8a;margin:.6rem 0 0}
</style>
${pos ? '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">' : ''}
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
    ${pos ? '<div id="map"></div><p class="waiting" id="seen"></p>'
          : (status === 'picked_up' || status === 'on_the_way'
              ? '<p class="waiting">Waiting for your rider\'s location — it appears here once their phone reports in.</p>'
              : '')}
  </div>` : ''}

  <div class="card">
    <p class="muted">To pay on delivery</p>
    <p style="font-size:1.3rem;font-weight:800;margin:.1rem 0">₱${
      Number(o.amountDue ?? 0).toFixed(2)}</p>
    <p class="muted">Delivery only — the food is already paid for.</p>
  </div>
</div>
${pos ? `<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
  var rider = ${JSON.stringify(pos)};
  var drop = ${JSON.stringify(dropoff)};
  var el = document.getElementById('map');
  if (!el || typeof L === 'undefined') return;   // CDN blocked — words still work

  var map = L.map(el, { zoomControl: false, attributionControl: false })
             .setView([rider.lat, rider.lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  var icon = function (bg, glyph) {
    return L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
      html: '<div style="display:flex;align-items:center;justify-content:center;width:30px;'
          + 'height:30px;border-radius:50%;background:' + bg + ';box-shadow:0 0 0 2px #fff,'
          + '0 1px 4px rgba(0,0,0,.4);font-size:15px">' + glyph + '</div>' });
  };
  var mark = L.marker([rider.lat, rider.lng], { icon: icon('#E8552F', '\u{1F6F5}') }).addTo(map);
  if (drop) {
    L.marker([drop.lat, drop.lng], { icon: icon('#1e1e1e', '\u{1F4CD}') }).addTo(map);
    map.fitBounds(L.latLngBounds([[rider.lat, rider.lng], [drop.lat, drop.lng]]).pad(0.35));
  }

  var seen = document.getElementById('seen');
  var since = function (iso) {
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return s < 60 ? 'just now' : Math.round(s / 60) + ' min ago';
  };
  var show = function (at) { if (seen) seen.textContent = 'Location updated ' + since(at); };
  show(rider.at);

  // Poll rather than hold a socket open: this page sits in a phone's browser
  // for the length of a delivery, and a dropped socket is worse than a request
  // every fifteen seconds.
  setInterval(function () {
    fetch(location.href, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        var p = o && o.rider && o.rider.position;
        if (!p) return;
        mark.setLatLng([p.lat, p.lng]);
        show(p.at);
        if (o.status === 'delivered') location.reload();
      })
      .catch(function () {});
  }, 15000);
}());
</script>` : ''}`;
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
