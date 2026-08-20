-- ServdGo — two things happen that nobody outside this database ever hears.
--
-- 1. "I'm outside." rider_mark_arrived() has always been careful not to be a
--    status: it stamps arrived_at and posts into the chat, leaving the order
--    flow untouched (0053). That was the right call and it has one cost — the
--    partner callback trigger only fires on a status change, so the restaurant
--    and their diner are never told. The rider stands at the gate, and the only
--    person who knows is the rider.
--
-- 2. Messages. The chat is realtime for anyone with the thread open and silent
--    for everyone else. A diner who locked their phone after ordering, and a
--    rider with the app in their pocket, are exactly the two people a message
--    is for.
--
-- So: arrival becomes a callback event, every message becomes a callback event,
-- and a message the diner sends wakes the rider's phone. Nothing here changes
-- what a status means, which is the same reason 0053 did it this way.

-- ---------------------------------------------------------------------------
-- Arrival is an event, still not a status.
-- ---------------------------------------------------------------------------
create or replace function enqueue_merchant_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url   text;
  v_event text;
begin
  if new.merchant_id is null then
    return null;
  end if;

  select webhook_url into v_url from merchants where id = new.merchant_id;
  if nullif(btrim(coalesce(v_url, '')), '') is null then
    return null;   -- they poll instead
  end if;

  if tg_op = 'INSERT' then
    v_event := 'order.created';
  elsif new.status is distinct from old.status then
    v_event := 'order.' || new.status;
  elsif new.arrived_at is distinct from old.arrived_at and new.arrived_at is not null then
    v_event := 'order.arrived';
  elsif new.rider_id is distinct from old.rider_id and new.rider_id is not null then
    v_event := 'order.rider_assigned';
  else
    return null;
  end if;

  insert into merchant_webhook_deliveries (merchant_id, order_id, event, payload)
  values (new.merchant_id, new.id, v_event,
          merchant_order_view(new.id) || jsonb_build_object('event', v_event));
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Every message the partner's side should see.
--
-- Both directions go out. A rider's message is the one the diner needs pushed
-- to their phone; a diner's own message going back is what lets the
-- restaurant's thread show the same conversation without polling for it.
--
-- The body travels in the payload. It is a delivery instruction between two
-- people who are already talking about this order, sent over a signed callback
-- to the restaurant that took it — but it is somebody's words, so it is worth
-- saying out loud that they leave here.
-- ---------------------------------------------------------------------------
create or replace function enqueue_merchant_message_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o record;
  v_url text;
begin
  select id, merchant_id, merchant_reference into o
    from orders where id = new.order_id;
  if o.merchant_id is null then
    return null;
  end if;

  select webhook_url into v_url from merchants where id = o.merchant_id;
  if nullif(btrim(coalesce(v_url, '')), '') is null then
    return null;
  end if;

  insert into merchant_webhook_deliveries (merchant_id, order_id, event, payload)
  values (o.merchant_id, o.id, 'order.message',
          merchant_order_view(o.id) || jsonb_build_object(
            'event', 'order.message',
            'message', jsonb_build_object(
              'id', new.id,
              'from', new.sender_role,
              'body', new.body,
              'imageUrl', new.image_url,
              'at', new.created_at)));
  return null;
end;
$$;

drop trigger if exists order_messages_merchant_webhook on order_messages;
create trigger order_messages_merchant_webhook
  after insert on order_messages
  for each row
  execute function enqueue_merchant_message_webhook();

-- ---------------------------------------------------------------------------
-- Waking the rider's phone.
--
-- The rider app subscribes to the thread, which covers the case where it is
-- open. It is not open: it is in a pocket on a motorbike. So a message from the
-- diner pokes an edge function, which is the only thing here that can hold a
-- Google credential and talk to FCM.
--
-- Fire-and-forget through pg_net, the same shape as the callback drain (0114),
-- for the same reason: a chat message must not be able to fail an insert.
-- ---------------------------------------------------------------------------
create or replace function notify_rider_of_message()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rider uuid;
  v_url   text;
  v_key   text;
begin
  -- Only what the rider did not send themselves, and only while somebody is
  -- carrying the order.
  if new.sender_role = 'rider' then
    return null;
  end if;
  select rider_id into v_rider from orders
   where id = new.order_id and status not in ('delivered', 'cancelled');
  if v_rider is null then
    return null;
  end if;

  if to_regproc('net.http_post') is null then
    return null;                      -- no pg_net here; the app's realtime holds
  end if;

  v_key := vault_read('service_role_key');
  v_url := vault_read('functions_base_url');
  if v_key is null or v_url is null then
    return null;
  end if;

  perform net.http_post(
    url := rtrim(v_url, '/') || '/notify-message',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('messageId', new.id),
    timeout_milliseconds := 4000);
  return null;
end;
$$;

drop trigger if exists order_messages_notify_rider on order_messages;
create trigger order_messages_notify_rider
  after insert on order_messages
  for each row
  execute function notify_rider_of_message();

-- ---------------------------------------------------------------------------
-- What the push sender is allowed to know.
--
-- One call, because the alternative is an edge function joining four tables
-- with a service key and deciding for itself who may be told what.
-- ---------------------------------------------------------------------------
create or replace function order_message_push(p_message uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m record;
  o record;
begin
  select * into m from order_messages where id = p_message;
  if m.id is null then
    return null;
  end if;
  select id, rider_id, status, customer_name, merchant_reference, service_type
    into o from orders where id = m.order_id;
  if o.rider_id is null or o.status in ('delivered', 'cancelled') then
    return null;
  end if;

  return jsonb_build_object(
    'orderId', o.id,
    'reference', coalesce(o.merchant_reference, left(o.id::text, 8)),
    'from', m.sender_role,
    'senderName', coalesce(nullif(btrim(o.customer_name), ''), 'Your customer'),
    'body', coalesce(nullif(btrim(m.body), ''),
                     case when m.image_url is not null then 'Sent a photo' else '' end),
    'tokens', coalesce((
      select jsonb_agg(jsonb_build_object('token', t.token, 'platform', t.platform))
        from rider_push_tokens t where t.rider_id = o.rider_id), '[]'::jsonb));
end;
$$;
revoke all on function order_message_push(uuid) from public, anon, authenticated;
grant execute on function order_message_push(uuid) to service_role;

-- The riders a new order should wake, with their devices. Replaces the audience
-- query notify-riders was doing by hand against tables it should not be reading.
create or replace function pool_push_targets(p_order uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o record;
begin
  select id, territory_id, service_type, status, delivery_fee, commission_amount
    into o from orders where id = p_order;
  if o.id is null or o.status <> 'pending' then
    return null;
  end if;

  return jsonb_build_object(
    'orderId', o.id,
    'service', o.service_type,
    'fee', o.delivery_fee,
    'commission', o.commission_amount,
    'tokens', coalesce((
      select jsonb_agg(jsonb_build_object('token', t.token, 'platform', t.platform))
        from rider_push_tokens t
        join riders r on r.id = t.rider_id
       where r.application_status = 'approved'
         and not r.is_suspended
         and r.is_online
         and (r.territory_id is null or o.territory_id is null or r.territory_id = o.territory_id)
         and (o.service_type is null
              or r.services_accepted is null
              or array_length(r.services_accepted, 1) is null
              or o.service_type = any (r.services_accepted))
         and rider_overdue_balance(r.id, business_today(r.territory_id)) = 0), '[]'::jsonb));
end;
$$;
revoke all on function pool_push_targets(uuid) from public, anon, authenticated;
grant execute on function pool_push_targets(uuid) to service_role;
