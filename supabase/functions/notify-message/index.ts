// Wake the rider's phone: their customer said something.
//
//   POST /functions/v1/notify-message
//   Authorization: Bearer <service role>
//   { "messageId": "…" }
//
// Called by a trigger on order_messages (0122) through pg_net, fire and forget.
// The database decides who may be told what — order_message_push() returns the
// text and the devices, or null when there is nobody to wake — so this function
// holds the Google credential and nothing else.
//
// Dead tokens are pruned here rather than left to fail forever: a rider who
// reinstalls the app leaves one behind every time.
//
// Deploy: supabase functions deploy notify-message

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { sendPush, type PushTarget } from '../_shared/fcm.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: { messageId?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  if (!body.messageId) return json({ error: 'bad_request', message: 'messageId is required.' }, 400);

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data, error } = await db.rpc('order_message_push', { p_message: body.messageId });
  if (error) return json({ error: 'db', message: error.message }, 500);
  if (!data) return json({ ignored: 'nobody to wake' });

  const targets = (data.tokens ?? []) as PushTarget[];
  const result = await sendPush(targets, {
    title: String(data.senderName ?? 'Your customer'),
    body: String(data.body ?? '').slice(0, 140) || 'Sent you a message',
    tag: `order-${data.orderId}`,
    channelId: 'servdgo-chat',
    data: { orderId: String(data.orderId), reference: String(data.reference ?? ''), kind: 'chat' },
  });

  if (result.dead.length > 0) {
    await db.from('rider_push_tokens').delete().in('token', result.dead);
  }
  return json(result);
});
