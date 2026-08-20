// Xendit says the money arrived.
//
//   POST /functions/v1/xendit-webhook
//   x-callback-token: <the token from the Xendit dashboard>
//   { "external_id": "TOP-1A2B3C4D", "status": "PAID", "paid_amount": 500, ... }
//
// Set this URL under Settings → Webhooks → Invoices paid / expired in Xendit,
// and put the same callback token in XENDIT_CALLBACK_TOKEN, or into HQ →
// Platform settings → Xendit, which keeps it in Vault.
//
// The token is compared in constant time, because a comparison that returns
// early tells an attacker how much of their guess was right.
//
// A callback that arrives twice — and it will — credits once: the crediting
// happens inside wallet_topup_mark_paid(), which is idempotent on the top-up
// row rather than on this request. Anything unrecognised is answered 200 on
// purpose, so Xendit stops retrying a message we will never understand.
//
// Deploy: supabase functions deploy xendit-webhook --no-verify-jwt

import { serviceClient, xenditConfig } from '../_shared/xendit.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const db = serviceClient();
  const expected = (await xenditConfig(db)).callbackToken;
  if (!expected) return json({ error: 'not_configured' }, 503);
  if (!sameToken(req.headers.get('x-callback-token') ?? '', expected)) {
    return json({ error: 'unauthorised' }, 401);
  }

  let event: Record<string, unknown>;
  try {
    event = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const reference = String(event.external_id ?? '');
  const providerRef = event.id ? String(event.id) : null;
  const status = String(event.status ?? '').toUpperCase();
  if (!reference) return json({ ignored: 'no external_id' });

  if (status === 'PAID' || status === 'SETTLED') {
    // paid_amount is what actually cleared; the database refuses if it is not
    // the amount the rider asked to add.
    const paid = Number(event.paid_amount ?? event.amount ?? 0);
    const { error } = await db.rpc('wallet_topup_mark_paid', {
      p_reference: reference,
      p_provider_ref: providerRef,
      p_amount: Number.isFinite(paid) && paid > 0 ? paid : null,
      p_payload: event,
    });
    if (error) {
      console.error('top-up not credited', reference, error.message);
      // A mismatch is ours to investigate, not Xendit's to retry.
      return json({ error: 'not_credited', message: error.message }, 200);
    }
    return json({ credited: reference });
  }

  if (status === 'EXPIRED' || status === 'FAILED') {
    await db.rpc('wallet_topup_close', {
      p_reference: reference,
      p_status: status === 'EXPIRED' ? 'expired' : 'failed',
      p_payload: event,
    });
    return json({ closed: reference });
  }

  return json({ ignored: status });
});
