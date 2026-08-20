-- ServdGo — proof that the Servd door only opens for the right key, prices the
-- same as the app, routes by the restaurant's own pin, and tells Servd what
-- happened.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/merchant_api.sql

begin;
\set ON_ERROR_STOP on

create or replace function pg_temp.check(p_label text, p_got anyelement, p_want anyelement)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL % — got %, wanted %', p_label, p_got, p_want;
  end if;
  raise notice 'ok  %', p_label;
end $$;

set local role service_role;

insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, delivery_fee_model,
                         default_delivery_fee, delivery_base_fare, delivery_base_km, delivery_per_km,
                         convenience_fee_padala, settlement_gcash_number, settlement_gcash_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu',  'cebu',  'live', 10.3157, 123.8854, 20, 0.15,
   'per_km', 50, 50, 2, 10, 5, '09170000001', 'Cebu Operator'),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'live',  7.1907, 125.4553, 20, 0.20,
   'flat', 60, 50, 2, 10, 0, '09170000002', 'Davao Operator');

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003');
insert into profiles (id, role, full_name, territory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'admin', 'Cebu operator',  '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002', 'admin', 'Davao operator', '22222222-2222-2222-2222-222222222222'),
  ('a0000000-0000-0000-0000-000000000003', 'rider', 'Cebu rider',     '11111111-1111-1111-1111-111111111111')
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id;

insert into riders (id, profile_id, name, mobile_number, application_status, is_online, territory_id, vehicle)
values ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003',
        'Ben Cruz', '09170000003', 'approved', true, '11111111-1111-1111-1111-111111111111', 'Motorcycle');

-- ---------------------------------------------------------------------------
-- 1. A restaurant belongs to the city its own pin falls inside.
-- ---------------------------------------------------------------------------
insert into merchants (id, name, slug, pickup_lat, pickup_lng, pickup_address,
                       contact_name, contact_number, webhook_url, webhook_secret)
values ('d0000000-0000-0000-0000-000000000001', 'Lutong Bahay', 'lutong-bahay',
        10.3157, 123.8854, '123 Colon St, Cebu City', 'Ana', '09171112222',
        'https://servd.example/hooks/servdgo', 'whsec_test');

insert into merchants (id, name, slug, pickup_lat, pickup_lng, pickup_address, contact_number)
values ('d0000000-0000-0000-0000-000000000002', 'Davao Grill', 'davao-grill',
        7.1907, 125.4553, '1 Roxas Ave, Davao', '09173334444');

select pg_temp.check('a restaurant is routed to its own city',
  (select territory_id from merchants where slug = 'lutong-bahay'),
  '11111111-1111-1111-1111-111111111111'::uuid);
select pg_temp.check('and a restaurant in another city to that one',
  (select territory_id from merchants where slug = 'davao-grill'),
  '22222222-2222-2222-2222-222222222222'::uuid);

-- A restaurant whose pin lands nowhere cannot be given a key, and the refusal
-- has to say why — this is the first thing anybody hits on a fresh install,
-- where the seeded city has no boundary at all.
set local role service_role;
insert into merchants (id, name, slug, pickup_lat, pickup_lng, pickup_address, contact_number)
values ('d0000000-0000-0000-0000-00000000000f', 'Nowhere Cafe', 'nowhere-cafe',
        0.5, 0.5, 'In the sea', '09170000009');
select pg_temp.check('a pin outside every city gets no territory',
  (select territory_id from merchants where slug = 'nowhere-cafe'), null::uuid);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
do $$
declare msg text;
begin
  begin
    perform create_merchant_api_key('d0000000-0000-0000-0000-00000000000f');
    raise exception 'FAIL a key was minted for a restaurant in no city';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like '%not inside any live city%' then
      raise exception 'FAIL the refusal did not say why: %', msg;
    end if;
    if msg not like '%Nowhere Cafe%' then
      raise exception 'FAIL the refusal did not name the restaurant: %', msg;
    end if;
  end;
end $$;

-- Moving the boundary to cover it is the fix, and re-deriving picks it up.
set local role service_role;
update territories set service_center_lat = 0.5, service_center_lng = 0.5, service_radius_km = 5
 where slug = 'davao';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select pg_temp.check('re-deriving lands it in the city that now covers it',
  refresh_merchant_territory('d0000000-0000-0000-0000-00000000000f'),
  '22222222-2222-2222-2222-222222222222'::uuid);
select pg_temp.check('and a key can be minted now',
  left(create_merchant_api_key('d0000000-0000-0000-0000-00000000000f'), 4), 'sgo_');

set local role service_role;
update territories set service_center_lat = 7.1907, service_center_lng = 125.4553,
                       service_radius_km = 20 where slug = 'davao';
delete from merchants where slug = 'nowhere-cafe';
reset role;

-- ---------------------------------------------------------------------------
-- 2. Keys: one per restaurant, stored only as a hash.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);

select create_merchant_api_key('d0000000-0000-0000-0000-000000000001', 'Servd production') as key \gset

reset role;
set local role service_role;

select pg_temp.check('the key is not stored anywhere in the clear',
  (select count(*)::int from merchant_api_keys where key_hash = :'key'), 0);
select pg_temp.check('a valid key resolves to its restaurant',
  verify_merchant_key(:'key'), 'd0000000-0000-0000-0000-000000000001'::uuid);
select pg_temp.check('a wrong key resolves to nothing',
  verify_merchant_key('sgo_not_a_real_key'), null::uuid);
select pg_temp.check('an empty key resolves to nothing', verify_merchant_key(''), null::uuid);
select pg_temp.check('using a key records that it was used',
  (select count(*)::int from merchant_api_keys where last_used_at is not null), 1);

-- An operator cannot mint a key for another city's restaurant.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
do $$
begin
  begin
    perform create_merchant_api_key('d0000000-0000-0000-0000-000000000001');
    raise exception 'FAIL an operator minted a key for another city';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot mint a key for another city';
  end;
end $$;

reset role;
set local role service_role;

-- ---------------------------------------------------------------------------
-- 3. Quotes price the same way the customer app does.
-- ---------------------------------------------------------------------------
-- Under 2 km, so the base fare covers it exactly.
select pg_temp.check('a short trip is the base fare',
  (merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3200, 123.8880) ->> 'deliveryFee')::numeric,
  50.00::numeric);
select pg_temp.check('the convenience fee comes from the city',
  (merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3200, 123.8880) ->> 'convenienceFee')::numeric,
  5.00::numeric);
select pg_temp.check('and the total is both',
  (merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3200, 123.8880) ->> 'total')::numeric,
  55.00::numeric);

-- A longer trip bills the distance beyond the base.
do $$
declare q jsonb; v_km numeric;
begin
  q := merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3900, 123.8854);
  v_km := (q ->> 'distanceKm')::numeric;
  if v_km <= 2 then
    raise exception 'FAIL the test trip is not long enough to bill distance';
  end if;
  if (q ->> 'deliveryFee')::numeric <> round(50 + 10 * (v_km - 2), 2) then
    raise exception 'FAIL a long trip is not billed per km — got %, wanted %',
      q ->> 'deliveryFee', round(50 + 10 * (v_km - 2), 2);
  end if;
  raise notice 'ok  a long trip is billed base fare plus the distance beyond it';
end $$;

select pg_temp.check('the other city''s flat model is a flat fee',
  (merchant_quote('d0000000-0000-0000-0000-000000000002', 7.1950, 125.4600) ->> 'deliveryFee')::numeric,
  60.00::numeric);

select pg_temp.check('a drop-off outside the area is refused before booking',
  (merchant_quote('d0000000-0000-0000-0000-000000000001', 14.5995, 120.9842) ->> 'serviceable')::boolean,
  false);

select pg_temp.check('the quote says how many riders are online',
  (merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3200, 123.8880)
     -> 'availability' ->> 'ridersOnline')::int, 1);

-- Closing the city closes the door, and says why.
update territories set is_open = false, closed_message = 'Closed for the holiday.'
 where slug = 'cebu';
select pg_temp.check('a closed city is not serviceable',
  (merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3200, 123.8880) ->> 'serviceable')::boolean,
  false);
select pg_temp.check('and says what the operator wrote',
  merchant_quote('d0000000-0000-0000-0000-000000000001', 10.3200, 123.8880) ->> 'reason',
  'Closed for the holiday.');
update territories set is_open = true, closed_message = null where slug = 'cebu';

-- ---------------------------------------------------------------------------
-- 4. Booking.
-- ---------------------------------------------------------------------------
select merchant_book('d0000000-0000-0000-0000-000000000001', 'SERVD-1001',
                     10.3200, 123.8880, '9 Mango Ave, Cebu City',
                     'Maria Santos', '09175556666', 'Ring the bell', 'Chicken adobo') as booked \gset

select pg_temp.check('booking returns the reference it was given',
  (:'booked'::jsonb) ->> 'reference', 'SERVD-1001');
select pg_temp.check('it is not a duplicate the first time',
  ((:'booked'::jsonb) ->> 'duplicate')::boolean, false);
select pg_temp.check('it starts pending',
  (:'booked'::jsonb) ->> 'status', 'pending');
select pg_temp.check('the fee on the order is the fee that was quoted',
  ((:'booked'::jsonb) ->> 'total')::numeric, 55.00::numeric);

select pg_temp.check('the order is a courier job',
  (select service_type::text from orders where merchant_reference = 'SERVD-1001'), 'padala');
select pg_temp.check('routed to the restaurant''s own city',
  (select territory_id from orders where merchant_reference = 'SERVD-1001'),
  '11111111-1111-1111-1111-111111111111'::uuid);
select pg_temp.check('commission is the city''s rate on the delivery fee, not the convenience fee',
  (select commission_amount from orders where merchant_reference = 'SERVD-1001'), 7.50::numeric);
select pg_temp.check('it carries a tracking token',
  (select length(tracking_token) from orders where merchant_reference = 'SERVD-1001'), 64);

-- Servd retrying the same call must not put a second rider on the road.
select merchant_book('d0000000-0000-0000-0000-000000000001', 'SERVD-1001',
                     10.3200, 123.8880, '9 Mango Ave, Cebu City',
                     'Maria Santos', '09175556666', null, null) as again \gset
select pg_temp.check('a retry is recognised as a duplicate',
  ((:'again'::jsonb) ->> 'duplicate')::boolean, true);
select pg_temp.check('and returns the same order',
  (:'again'::jsonb) ->> 'orderId', (:'booked'::jsonb) ->> 'orderId');
select pg_temp.check('with only one order on the table',
  (select count(*)::int from orders where merchant_reference = 'SERVD-1001'), 1);

do $$
begin
  begin
    perform merchant_book('d0000000-0000-0000-0000-000000000001', 'SERVD-1002',
                          14.5995, 120.9842, 'Manila', 'Someone', '09170000000', null, null);
    raise exception 'FAIL an out-of-area booking was accepted';
  exception when check_violation then
    raise notice 'ok  an out-of-area booking is refused';
  end;
end $$;

do $$
begin
  begin
    perform merchant_book('d0000000-0000-0000-0000-000000000001', 'SERVD-1003',
                          10.3200, 123.8880, '9 Mango Ave', 'Someone', null, null, null);
    raise exception 'FAIL a booking with no contact number was accepted';
  exception when check_violation then
    raise notice 'ok  a booking needs a contact number for the recipient';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. One restaurant cannot read another's orders.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    perform merchant_order_status('d0000000-0000-0000-0000-000000000002', 'SERVD-1001');
    raise exception 'FAIL a restaurant read another restaurant''s order';
  exception when no_data_found then
    raise notice 'ok  a restaurant cannot read another restaurant''s order';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The rider appears once somebody takes it.
-- ---------------------------------------------------------------------------
select pg_temp.check('no rider on it yet',
  merchant_order_status('d0000000-0000-0000-0000-000000000001', 'SERVD-1001') -> 'rider', 'null'::jsonb);

update orders set rider_id = 'b0000000-0000-0000-0000-000000000003', status = 'accepted'
 where merchant_reference = 'SERVD-1001';

select pg_temp.check('the callback carries the rider''s name',
  merchant_order_status('d0000000-0000-0000-0000-000000000001', 'SERVD-1001') -> 'rider' ->> 'name',
  'Ben Cruz');
select pg_temp.check('and their number',
  merchant_order_status('d0000000-0000-0000-0000-000000000001', 'SERVD-1001') -> 'rider' ->> 'contact',
  '09170000003');

-- ---------------------------------------------------------------------------
-- 7. The public tracking link.
-- ---------------------------------------------------------------------------
select tracking_token as token from orders where merchant_reference = 'SERVD-1001' \gset

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);

select pg_temp.check('the diner sees the status without signing in',
  track_merchant_order(:'token') ->> 'status', 'accepted');
select pg_temp.check('and who is bringing it',
  track_merchant_order(:'token') -> 'rider' ->> 'name', 'Ben Cruz');
select pg_temp.check('and where it is from',
  track_merchant_order(:'token') ->> 'from', 'Lutong Bahay');
select pg_temp.check('but not the restaurant''s reference',
  track_merchant_order(:'token') ? 'reference', false);
select pg_temp.check('an unknown token shows nothing',
  track_merchant_order('not-a-token'), null::jsonb);

reset role;
set local role service_role;

-- ---------------------------------------------------------------------------
-- 8. Callbacks are queued, not fired inside the order's transaction.
-- ---------------------------------------------------------------------------
select pg_temp.check('creating and accepting both queued a callback',
  (select count(*)::int from merchant_webhook_deliveries
    where merchant_id = 'd0000000-0000-0000-0000-000000000001'), 2);
select pg_temp.check('the first is the booking',
  (select event from merchant_webhook_deliveries order by created_at limit 1), 'order.created');
select pg_temp.check('the payload carries the rider once there is one',
  (select payload -> 'rider' ->> 'name' from merchant_webhook_deliveries
    where event = 'order.accepted'), 'Ben Cruz');

-- A restaurant that gave no URL is polling; nothing is queued for it.
select merchant_book('d0000000-0000-0000-0000-000000000002', 'SERVD-2001',
                     7.1950, 125.4600, '2 Roxas Ave', 'Juan', '09177778888', null, null) as davao \gset
select pg_temp.check('nothing is queued for a restaurant that polls',
  (select count(*)::int from merchant_webhook_deliveries
    where merchant_id = 'd0000000-0000-0000-0000-000000000002'), 0);

-- ---------------------------------------------------------------------------
-- 9. Draining the outbox.
-- ---------------------------------------------------------------------------
select count(*)::int as claimed from claim_merchant_webhooks(10) \gset
select pg_temp.check('the worker claims what is due', :'claimed'::int, 2);
select pg_temp.check('claiming counts the attempt',
  (select min(attempts) from merchant_webhook_deliveries where status = 'pending'), 1);
select pg_temp.check('a claimed callback is not handed out again straight away',
  (select count(*)::int from claim_merchant_webhooks(10)), 0);

select id as first_delivery from merchant_webhook_deliveries order by created_at limit 1 \gset
select complete_merchant_webhook(:'first_delivery', true);
select pg_temp.check('a delivered callback is done',
  (select status from merchant_webhook_deliveries where id = :'first_delivery'), 'delivered');

select id as second_delivery from merchant_webhook_deliveries
 where status = 'pending' order by created_at limit 1 \gset
select complete_merchant_webhook(:'second_delivery', false, 'connection refused');
select pg_temp.check('a failure stays pending for another go',
  (select status from merchant_webhook_deliveries where id = :'second_delivery'), 'pending');
select pg_temp.check('and records why',
  (select last_error from merchant_webhook_deliveries where id = :'second_delivery'), 'connection refused');
select pg_temp.check('and is backed off rather than retried at once',
  (select next_attempt_at > now() + interval '30 seconds'
     from merchant_webhook_deliveries where id = :'second_delivery'), true);

-- Give up after the platform's limit, and leave the record standing.
update merchant_webhook_deliveries set attempts = 99 where id = :'second_delivery';
select complete_merchant_webhook(:'second_delivery', false, 'still down');
select pg_temp.check('it gives up eventually',
  (select status from merchant_webhook_deliveries where id = :'second_delivery'), 'failed');

-- ---------------------------------------------------------------------------
-- 10. A restaurant is the operator's record, and only theirs.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select pg_temp.check('an operator sees only their own city''s restaurants',
  (select count(*)::int from merchants), 1);
select pg_temp.check('and only their own callbacks',
  (select count(*)::int from merchant_webhook_deliveries), 0);
select pg_temp.check('and none of another city''s keys',
  (select count(*)::int from merchant_api_keys), 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select pg_temp.check('while the city that owns the key can list it',
  (select count(*)::int from merchant_api_keys), 1);
select pg_temp.check('seeing only its prefix',
  (select prefix from merchant_api_keys), left(:'key', 12));

reset role;
rollback;
