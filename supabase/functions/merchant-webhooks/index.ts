// Drain the callback outbox: post each queued status change to the restaurant
// that is waiting for it, signed so they can tell it came from us.
//
// Run it on a schedule (Supabase → Integrations → Cron, every minute):
//   select net.http_post(
//     url := 'https://<ref>.supabase.co/functions/v1/merchant-webhooks',
//     headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>'));
//
// Also safe to call directly after a status change if you want callbacks sooner
// than the next tick; claim_merchant_webhooks() takes rows FOR UPDATE SKIP
// LOCKED, so two runs overlapping cannot send the same callback twice.
//
// Deploy: supabase functions deploy merchant-webhooks

import { serviceClient, json } from '../_shared/merchant.ts';

/**
 * Signature over `${timestamp}.${body}`, hex HMAC-SHA256, sent as
 *   X-ServdGo-Signature: t=<unix>,v1=<hex>
 *
 * The timestamp is inside the signed string so a captured callback cannot be
 * replayed later — the receiver rejects anything older than a few minutes.
 */
async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async () => {
  const db = serviceClient();

  const { data: due, error } = await db.rpc('claim_merchant_webhooks', { p_limit: 25 });
  if (error) {
    console.error('could not claim webhooks', error);
    return json({ error: 'server_error' }, 500);
  }

  const rows = (due ?? []) as {
    id: string; url: string; secret: string | null; payload: unknown; attempts: number;
  }[];

  let delivered = 0;
  let failed = 0;

  for (const row of rows) {
    const body = JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-servdgo-delivery': row.id,
    };
    if (row.secret) {
      headers['x-servdgo-signature'] = `t=${timestamp},v1=${await sign(row.secret, timestamp, body)}`;
    }

    try {
      // A restaurant that hangs must not hold up the ones behind it.
      const res = await fetch(row.url, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        await db.rpc('complete_merchant_webhook', { p_id: row.id, p_ok: true });
        delivered++;
      } else {
        await db.rpc('complete_merchant_webhook', {
          p_id: row.id, p_ok: false, p_error: `HTTP ${res.status}`,
        });
        failed++;
      }
    } catch (e) {
      await db.rpc('complete_merchant_webhook', {
        p_id: row.id, p_ok: false, p_error: (e as Error).message ?? 'request failed',
      });
      failed++;
    }
  }

  return json({ claimed: rows.length, delivered, failed });
});
