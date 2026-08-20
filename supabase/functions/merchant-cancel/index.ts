// Call it off.
//
//   POST /functions/v1/merchant-cancel
//   X-API-Key: sgo_…
//   { "reference": "SERVD-1001", "reason": "customer changed their mind" }
//
// Returns the order in its cancelled state — the same body every other merchant
// endpoint returns, so a caller has one shape to parse.
//
// Cancelling twice is not an error: a retry after a timeout must not report a
// failure for something that already happened. Once a rider has collected, it
// is refused — they are carrying somebody's food and are owed the trip.
//
// Deploy: supabase functions deploy merchant-cancel --no-verify-jwt

import { handle, json, dbError } from '../_shared/merchant.ts';

Deno.serve((req) => handle(req, async (db, merchantId, body) => {
  const reference = body.reference;
  if (!reference) {
    return json({ error: 'bad_request', message: 'reference is required.' }, 400);
  }

  const { data, error } = await db.rpc('merchant_cancel', {
    p_merchant: merchantId,
    p_reference: String(reference),
    p_reason: body.reason ? String(body.reason) : null,
  });
  if (error) return dbError(error);
  return json(data);
}));
