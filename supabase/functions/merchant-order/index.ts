// Where is it?
//
//   GET /functions/v1/merchant-order?reference=SERVD-1001
//   X-API-Key: sgo_…
//
// The same body the webhook posts, for restaurants that would rather poll — or
// for reconciling after an outage.
//
// Deploy: supabase functions deploy merchant-order --no-verify-jwt

import { handle, json, dbError } from '../_shared/merchant.ts';

Deno.serve((req) => handle(req, async (db, merchantId, body) => {
  const reference = body.reference;
  if (!reference) {
    return json({ error: 'bad_request', message: 'reference is required.' }, 400);
  }

  const { data, error } = await db.rpc('merchant_order_status', {
    p_merchant: merchantId, p_reference: String(reference),
  });
  if (error) return dbError(error);
  return json(data);
}));
