// Book a delivery.
//
//   POST /functions/v1/merchant-book
//   X-API-Key: sgo_…
//   {
//     "reference": "SERVD-1001",
//     "dropoff": { "lat": 10.32, "lng": 123.888, "address": "9 Mango Ave" },
//     "recipient": { "name": "Maria Santos", "contact": "09175556666" },
//     "items": "Chicken adobo",
//     "notes": "Ring the bell"
//   }
//
// `reference` is the restaurant's own order id and is what makes this safe to
// retry: booking the same reference twice returns the first order with
// "duplicate": true rather than putting a second rider on the road.
//
// Deploy: supabase functions deploy merchant-book --no-verify-jwt

import { handle, json, dbError } from '../_shared/merchant.ts';

Deno.serve((req) => handle(req, async (db, merchantId, body) => {
  const dropoff = (body.dropoff ?? {}) as Record<string, unknown>;
  const recipient = (body.recipient ?? {}) as Record<string, unknown>;
  const lat = Number(dropoff.lat);
  const lng = Number(dropoff.lng);

  if (!body.reference) {
    return json({ error: 'bad_request', message: 'reference is required.' }, 400);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ error: 'bad_request', message: 'dropoff.lat and dropoff.lng are required.' }, 400);
  }

  const { data, error } = await db.rpc('merchant_book', {
    p_merchant: merchantId,
    p_reference: String(body.reference),
    p_dropoff_lat: lat,
    p_dropoff_lng: lng,
    p_dropoff_address: dropoff.address ?? null,
    p_recipient_name: recipient.name ?? null,
    p_recipient_contact: recipient.contact ?? null,
    p_notes: body.notes ?? null,
    p_item_description: body.items ?? null,
  });
  if (error) return dbError(error);

  const created = (data as Record<string, unknown>)?.duplicate === false;
  return json(data, created ? 201 : 200);
}));
