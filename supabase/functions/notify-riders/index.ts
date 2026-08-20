// Wake the riders who could actually take this order.
//
//   POST /functions/v1/notify-riders
//   { "record": { "id": "…", "status": "pending" } }      ← Database Webhook
//   { "orderId": "…" }                                     ← or call it directly
//
// Wire it as a Database Webhook on `orders` INSERT (Dashboard → Database →
// Webhooks), or from a trigger.
//
// Two things changed here after the wallet work. The audience is no longer a
// query this function writes for itself — pool_push_targets() answers it in the
// database, where the rules about territory, service, suspension and an unpaid
// balance already live, and where they cannot drift out of step with the claim
// policy. And the send is FCM v1: the legacy endpoint this used to post to was
// switched off by Google in June 2024, so every notification since has gone
// nowhere.
//
// Deploy: supabase functions deploy notify-riders

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush, type PushTarget } from '../_shared/fcm.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const peso = (n: unknown) => `₱${Number(n ?? 0).toFixed(0)}`;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }

  const record = (payload.record ?? payload.new) as Record<string, unknown> | undefined;
  const orderId = String(payload.orderId ?? record?.id ?? '');
  if (!orderId) return json({ ignored: 'no order' });

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // pool_push_targets() returns null unless the order is still pending, so a
  // webhook that arrives after somebody claimed it is not a second alarm.
  const { data, error } = await db.rpc('pool_push_targets', { p_order: orderId });
  if (error) return json({ error: 'db', message: error.message }, 500);
  if (!data) return json({ ignored: 'not in the pool' });

  const targets = (data.tokens ?? []) as PushTarget[];
  const result = await sendPush(targets, {
    title: 'New request in the pool',
    body: `${data.service ?? 'delivery'} · ${peso(data.fee)} delivery · earn ${peso(data.commission)}`,
    tag: 'servdgo-pool',
    channelId: 'servdgo-pool',
    data: { orderId, kind: 'pool' },
  });

  if (result.dead.length > 0) {
    await db.from('rider_push_tokens').delete().in('token', result.dead);
  }
  return json(result);
});
