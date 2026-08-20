// A rider adds money to their wallet.
//
//   POST /functions/v1/wallet-topup
//   Authorization: Bearer <the rider's session token>
//   { "amount": 500, "returnUrl": "https://rider.example/?topup=done" }
//
// Two steps, in this order and never the other way round: the database reserves
// the top-up and its reference first, then Xendit is asked for a payment page
// against that reference. If Xendit is down the rider sees an error and the
// worst that exists is a pending row nobody paid; if it were the other way
// round, a payment could arrive for a top-up this database had never heard of.
//
// Nothing here credits anything. Only the callback does that, because only the
// callback knows the money arrived.
//
// The Xendit key comes from XENDIT_SECRET_KEY, or from the franchisor's setup
// in HQ → Platform settings → Xendit, which keeps it in Vault. Without either,
// the endpoint says so plainly rather than pretending to work.
//
// Deploy: supabase functions deploy wallet-topup

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { serviceClient, xenditConfig, xenditAuth } from '../_shared/xendit.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });

/** Only an https page is worth redirecting a payer back to. */
const httpsOnly = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  if (!auth) return json({ error: 'unauthorised' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'Send a JSON body.' }, 400);
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: 'bad_request', message: 'How much would you like to add?' }, 400);
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  // The rider's own token: wallet_topup_start() resolves which rider they are
  // and refuses if they are not one.
  const asRider = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
  });

  const { data: topup, error } = await asRider.rpc('wallet_topup_start', {
    p_amount: amount,
    p_channel: 'xendit',
  });
  if (error) {
    return json({ error: 'refused', message: error.message }, 422);
  }

  const service = serviceClient();
  const config = await xenditConfig(service);
  const key = config.enabled ? config.secretKey : null;
  if (!key) {
    return json({
      error: 'not_configured',
      message: 'Card and e-wallet top-ups are not switched on yet. Pay at the city office for now.',
      reference: topup.reference,
    }, 503);
  }

  const success = httpsOnly(body.returnUrl) ?? httpsOnly(config.successUrl);
  const invoice = {
    external_id: topup.reference,
    amount: Number(topup.amount),
    currency: 'PHP',
    description: `ServdGo rider wallet top-up (${topup.reference})`,
    invoice_duration: config.invoiceDuration,
    should_send_email: false,
    ...(success ? { success_redirect_url: success, failure_redirect_url: success } : {}),
  };

  const res = await fetch('https://api.xendit.co/v2/invoices', {
    method: 'POST',
    headers: {
      authorization: xenditAuth(key),
      'content-type': 'application/json',
    },
    body: JSON.stringify(invoice),
  });
  const payment = await res.json().catch(() => ({}));

  if (!res.ok) {
    // Close the reservation: a top-up nobody can pay should not sit pending.
    await service.rpc('wallet_topup_close', {
      p_reference: topup.reference,
      p_status: 'failed',
      p_payload: payment,
    });
    return json({
      error: 'payment_provider',
      message: payment?.message ?? 'The payment page could not be created. Try again.',
    }, 502);
  }

  await service.rpc('wallet_topup_attach_provider', {
    p_reference: topup.reference,
    p_provider: 'xendit',
    p_provider_ref: payment.id ?? null,
    p_checkout_url: payment.invoice_url ?? null,
    p_expires_at: payment.expiry_date ?? null,
  });

  return json({
    reference: topup.reference,
    amount: Number(topup.amount),
    checkoutUrl: payment.invoice_url ?? null,
    expiresAt: payment.expiry_date ?? null,
  });
});
