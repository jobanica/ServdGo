-- ServdGo — the diner on a tracking link can talk to their rider.
--
-- The rider has had chat since 0038, and so has a customer with an account.
-- A diner who ordered through a partner platform has neither: no profile, no
-- session, nothing but the tracking token. Their only way to say "the gate is
-- locked, ring me" was to phone, which is exactly what the chat exists to save.
--
-- So the thread opens to the token. Two things follow from that, and both are
-- deliberate:
--
--   sender_profile becomes nullable. A message from a token-holder is not from
--   anybody in profiles, and inventing a row to satisfy a foreign key would put
--   a fiction in the table the operator reads to answer "who said this".
--
--   the token is the whole credential, so the functions below are the only way
--   in: no policy is loosened, anon gets no direct access to order_messages,
--   and every path checks the token resolves to that exact order.

alter table order_messages alter column sender_profile drop not null;

-- A rider is always somebody; a customer may be a token-holder with no account.
alter table order_messages
  add constraint order_messages_rider_is_somebody
  check (sender_profile is not null or sender_role = 'customer');

comment on column order_messages.sender_profile is
  'Who wrote it, or null for a diner writing from a tracking link — they have no account by design.';

/**
 * The thread behind a tracking token.
 *
 * Readable after delivery too: a conversation about where the food was left is
 * worth keeping visible to the person who was waiting for it.
 */
create or replace function track_messages(p_token text)
returns table (id uuid, sender_role text, body text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.sender_role, m.body, m.created_at
    from order_messages m
    join orders o on o.id = m.order_id
   where o.tracking_token = p_token
     and nullif(btrim(p_token), '') is not null
   order by m.created_at;
$$;
revoke all on function track_messages(text) from public;
grant execute on function track_messages(text) to anon, authenticated, service_role;

/**
 * Say something, as the diner.
 *
 * Only while somebody is actually carrying it — before a rider is assigned
 * there is nobody to read it, and after delivery the rider has moved on. A
 * message into either silence is worse than no chat at all, because the diner
 * believes it was heard.
 */
create or replace function track_send_message(p_token text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  uuid;
  v_status order_status;
  v_rider  uuid;
  v_count  int;
  v_body   text := btrim(coalesce(p_body, ''));
  v_id     uuid;
begin
  if v_body = '' then
    raise exception 'Nothing to send' using errcode = 'check_violation';
  end if;
  if length(v_body) > 1000 then
    raise exception 'That message is too long' using errcode = 'check_violation';
  end if;

  select o.id, o.status, o.rider_id into v_order, v_status, v_rider
    from orders o
   where o.tracking_token = p_token
     and nullif(btrim(p_token), '') is not null;
  if v_order is null then
    raise exception 'no such order' using errcode = 'no_data_found';
  end if;

  if v_rider is null then
    raise exception 'Nobody is carrying this yet — there is no one to read a message.'
      using errcode = 'check_violation';
  end if;
  if v_status in ('delivered', 'cancelled') then
    raise exception 'This delivery is over. Call the restaurant if something is wrong.'
      using errcode = 'check_violation';
  end if;

  -- The token is unguessable but it is not a login, so the thread is capped.
  -- Two hundred messages is far past any real conversation about a doorbell.
  select count(*) into v_count from order_messages
   where order_id = v_order and sender_profile is null;
  if v_count >= 200 then
    raise exception 'Too many messages on this delivery' using errcode = 'check_violation';
  end if;

  insert into order_messages (order_id, sender_profile, sender_role, body)
  values (v_order, null, 'customer', v_body)
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function track_send_message(text, text) from public;
grant execute on function track_send_message(text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The rider reads it through the policy they already have: order_messages_read
-- covers the order's assigned rider, and the diner's message is a row on that
-- order like any other. Nothing to change there — which is the point of putting
-- it in the same table rather than inventing a second kind of message.
-- ---------------------------------------------------------------------------
