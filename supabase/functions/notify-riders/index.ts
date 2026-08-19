// Supabase Edge Function: notify available riders of a new order via FCM.
//
// Wire it as a Database Webhook on `orders` INSERT (Dashboard → Database →
// Webhooks), or call it from a trigger. Requires two secrets:
//   supabase secrets set FCM_SERVER_KEY=...        # Firebase Cloud Messaging
//   SUPABASE_SERVICE_ROLE_KEY is injected automatically.
//
// Deploy:  supabase functions deploy notify-riders
//
// This runs in Deno on Supabase's edge runtime (not the local dev stack used in
// this repo's verification). It is a template — adjust the audience query to
// your rider-assignment model (open decision #7).

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const payload = await req.json();
  const order = payload.record ?? payload.new;
  if (!order || order.status !== 'pending') {
    return new Response('ignored', { status: 200 });
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Audience: approved, unlocked riders. Refine per your assignment strategy.
  const { data: riders } = await db
    .from('riders')
    .select('id')
    .eq('application_status', 'approved')
    .eq('is_locked', false);
  const riderIds = (riders ?? []).map((r) => r.id);
  if (riderIds.length === 0) return new Response('no riders', { status: 200 });

  const { data: tokens } = await db
    .from('rider_push_tokens')
    .select('token')
    .in('rider_id', riderIds);

  const fcmKey = Deno.env.get('FCM_SERVER_KEY');
  if (!fcmKey) return new Response('FCM_SERVER_KEY not set', { status: 500 });

  const body = {
    service: order.service_type,
    fee: order.delivery_fee,
    commission: order.commission_amount,
  };

  await Promise.all(
    (tokens ?? []).map((t) =>
      fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: { Authorization: `key=${fcmKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: t.token,
          notification: {
            title: 'New order in the pool',
            body: `${body.service} · ₱${body.fee} delivery · earn ₱${body.commission}`,
          },
          data: { orderId: order.id },
        }),
      }),
    ),
  );

  return new Response(JSON.stringify({ notified: tokens?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
