// What would this delivery cost, and can anyone take it right now?
//
//   POST /functions/v1/merchant-quote
//   X-API-Key: sgo_…
//   { "dropoff": { "lat": 10.32, "lng": 123.888 } }
//
// Deploy: supabase functions deploy merchant-quote --no-verify-jwt
// (--no-verify-jwt because callers authenticate with their own API key, not a
// Supabase user token.)

import { handle, json, dbError } from '../_shared/merchant.ts';

Deno.serve((req) => handle(req, async (db, merchantId, body) => {
  const dropoff = (body.dropoff ?? body) as Record<string, unknown>;
  const lat = Number(dropoff.lat);
  const lng = Number(dropoff.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: 'bad_request', message: 'dropoff.lat and dropoff.lng are required.' }, 400);
  }

  const { data, error } = await db.rpc('merchant_quote', {
    p_merchant: merchantId, p_dropoff_lat: lat, p_dropoff_lng: lng,
  });
  if (error) return dbError(error);
  return json(data);
}));
