-- ServdGo — platform settings, flags, announcements, overrides and exports.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hq_admin.sql

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
                         service_radius_km, commission_rate, settlement_gcash_number,
                         settlement_gcash_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu', 'cebu', 'live',
   10.3157, 123.8854, 20, 0.15, '09170000001', 'Cebu Operator'),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'live',
   7.1907, 125.4553, 20, 0.20, '09170000002', 'Davao Operator');

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000003');
insert into profiles (id, role, full_name) values
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor')
on conflict (id) do update set role = excluded.role;
insert into profiles (id, role, full_name, territory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'admin', 'Cebu operator',
   '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000003', 'rider', 'Cebu rider',
   '11111111-1111-1111-1111-111111111111')
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id;

insert into riders (id, profile_id, name, mobile_number, application_status, is_online, territory_id)
values
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003',
   'Ben Cruz', '09170000003', 'approved', true, '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000004', null, 'Carla Reyes', '09170000004', 'approved',
   true, '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000005', null, 'Davao rider', '09170000005', 'approved',
   true, '22222222-2222-2222-2222-222222222222');

insert into customers (id, profile_id, name, mobile_number)
values ('c0000000-0000-0000-0000-000000000006', null, 'A customer', '09170000006');

-- ---------------------------------------------------------------------------
-- 1. Platform-wide settings, and what an app is allowed to read before login.
-- ---------------------------------------------------------------------------
update platform_settings set min_rider_app_version = '2.4.0',
                             support_mobile = '09170001234',
                             maintenance_message = null
 where id;

reset role;
set local role anon;
select pg_temp.check('a signed-out app can ask which version it needs',
                     public_config() ->> 'min_rider_app_version', '2.4.0');
select pg_temp.check('and the support number', public_config() ->> 'support_mobile', '09170001234');
select pg_temp.check('but the royalty rate is not in there',
                     public_config() ? 'royalty_rate', false);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
-- Row-level security filters the row out rather than raising, so the test is
-- that nothing moved, not that anything complained.
update platform_settings set min_rider_app_version = '9.9.9' where id;
select pg_temp.check('an operator cannot set the platform-wide version',
                     (select min_rider_app_version from platform_settings), '2.4.0');

-- ---------------------------------------------------------------------------
-- 2. Feature flags: a default everywhere, overridden in one city.
-- ---------------------------------------------------------------------------
set local role service_role;
select pg_temp.check('a seeded flag is on by default',
                     feature_enabled('pabili', '11111111-1111-1111-1111-111111111111'), true);
select pg_temp.check('an unseeded flag is off, not on',
                     feature_enabled('teleportation', '11111111-1111-1111-1111-111111111111'), false);

insert into feature_flag_overrides (flag_key, territory_id, enabled, note)
values ('pabili', '11111111-1111-1111-1111-111111111111', false, 'no shops signed up yet');

select pg_temp.check('the override wins in that city',
                     feature_enabled('pabili', '11111111-1111-1111-1111-111111111111'), false);
select pg_temp.check('and the next city is untouched',
                     feature_enabled('pabili', '22222222-2222-2222-2222-222222222222'), true);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select pg_temp.check('an operator gets their own city without naming it',
                     feature_enabled('pabili'), false);
update feature_flags set default_enabled = false where key = 'padala';
select pg_temp.check('an operator cannot change a platform default',
                     feature_enabled('padala', '22222222-2222-2222-2222-222222222222'), true);

-- ---------------------------------------------------------------------------
-- 3. Announcements reach the audience they were addressed to, and nobody else.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
select publish_announcement('Rates change on the 1st', 'The band moves to 12–22%.', 'operators');
select publish_announcement('Cebu only', 'Bridge closed on Sunday.', 'operators',
                            '11111111-1111-1111-1111-111111111111');
select publish_announcement('Helmets', 'Wear one.', 'riders');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select pg_temp.check('the Cebu operator sees both operator notices',
                     (select count(*) from unread_announcements()), 2::bigint);
select pg_temp.check('and not the one for riders',
                     (select count(*) from unread_announcements() where title = 'Helmets'), 0::bigint);

-- Dismissing something you cannot see is a no-op, not an error.
select mark_announcement_read((select id from unread_announcements() where title = 'Helmets' limit 1));
select mark_announcement_read((select id from unread_announcements() order by title limit 1));
select pg_temp.check('dismissing one leaves the other',
                     (select count(*) from unread_announcements()), 1::bigint);
select pg_temp.check('and it is the one not dismissed',
                     (select title from unread_announcements()), 'Rates change on the 1st');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000003', true);
select pg_temp.check('the rider sees the rider notice only',
                     (select count(*) from unread_announcements()), 1::bigint);
select pg_temp.check('and it is theirs', (select title from unread_announcements()), 'Helmets');
do $$
begin
  begin
    perform publish_announcement('From a rider', 'Free lunch for everyone', 'operators');
    raise exception 'FAIL a rider published an announcement';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Delivery overrides: franchisor only, reason mandatory, all recorded.
-- ---------------------------------------------------------------------------
set local role service_role;
insert into orders (id, customer_id, rider_id, service_type, status, delivery_fee,
                    commission_amount, delivery_lat, delivery_lng, delivery_address,
                    customer_name, customer_contact, territory_id)
values
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006',
   'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 50, 7.5,
   10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
   '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000006',
   'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 50, 7.5,
   10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
   '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000006',
   'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 50, 7.5,
   10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
   '11111111-1111-1111-1111-111111111111');

-- Somebody already passed on order 3, which re-dispatching has to forget.
insert into rider_request_events (rider_id, order_id, kind, reason)
values ('b0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000003',
        'declined', 'too far');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
do $$
begin
  begin
    perform hq_reassign_order('e0000000-0000-0000-0000-000000000001',
                              'b0000000-0000-0000-0000-000000000004', 'because');
    raise exception 'FAIL an operator used an HQ override';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
do $$
begin
  begin
    perform hq_reassign_order('e0000000-0000-0000-0000-000000000001',
                              'b0000000-0000-0000-0000-000000000004', '   ');
    raise exception 'FAIL an override went through without a reason';
  exception when check_violation then
    null;
  end;
end $$;

do $$
begin
  begin
    perform hq_reassign_order('e0000000-0000-0000-0000-000000000001',
                              'b0000000-0000-0000-0000-000000000005', 'wrong city');
    raise exception 'FAIL an order was handed to a rider in another city';
  exception when check_violation then
    null;
  end;
end $$;

select hq_reassign_order('e0000000-0000-0000-0000-000000000001',
                         'b0000000-0000-0000-0000-000000000004', 'rider unreachable');
select pg_temp.check('the order moved to the new rider',
                     (select rider_id from orders where id = 'e0000000-0000-0000-0000-000000000001'),
                     'b0000000-0000-0000-0000-000000000004'::uuid);
select pg_temp.check('and it is marked as a transfer',
                     (select is_transfer from orders where id = 'e0000000-0000-0000-0000-000000000001'),
                     true);
select pg_temp.check('the old rider will not be offered it again',
                     (select count(*) from rider_request_events
                       where order_id = 'e0000000-0000-0000-0000-000000000001'
                         and rider_id = 'b0000000-0000-0000-0000-000000000003'), 1::bigint);
select pg_temp.check('the reassignment was recorded',
                     (select diff ->> 'reason' from audit_log where action = 'hq.order_reassigned'),
                     'rider unreachable');

-- Cancelling a delivered order takes the rider's commission with it.
set local role service_role;
update orders set status = 'delivered', delivered_at = now()
 where id = 'e0000000-0000-0000-0000-000000000002';
select pg_temp.check('the delivery booked commission',
                     (select count(*) from commission_ledger
                       where order_id = 'e0000000-0000-0000-0000-000000000002'), 1::bigint);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
select hq_cancel_order('e0000000-0000-0000-0000-000000000002', 'never arrived, customer refunded');
select pg_temp.check('the order is cancelled',
                     (select status::text from orders where id = 'e0000000-0000-0000-0000-000000000002'),
                     'cancelled');
select pg_temp.check('and the rider no longer owes commission on it',
                     (select count(*) from commission_ledger
                       where order_id = 'e0000000-0000-0000-0000-000000000002'), 0::bigint);
select pg_temp.check('the reason is on the order',
                     (select notes like '%Cancelled by HQ: never arrived%' from orders
                       where id = 'e0000000-0000-0000-0000-000000000002'), true);

-- A settled commission is money that has changed hands. Refuse, do not guess.
set local role service_role;
update orders set status = 'delivered', delivered_at = now()
 where id = 'e0000000-0000-0000-0000-000000000003';
update commission_ledger set settled = true
 where order_id = 'e0000000-0000-0000-0000-000000000003';

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
do $$
declare msg text;
begin
  begin
    perform hq_cancel_order('e0000000-0000-0000-0000-000000000003', 'customer complained');
    raise exception 'FAIL a settled order was cancelled out from under the ledger';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like '%settled%' then
      raise exception 'FAIL refused for the wrong reason: %', msg;
    end if;
  end;
end $$;

-- Re-dispatch puts it back in the pool and forgets who passed.
set local role service_role;
update orders set status = 'accepted', delivered_at = null
 where id = 'e0000000-0000-0000-0000-000000000003';
-- Unwind the settlement the way the ledger requires: the royalty booked off it
-- first, then the commission row it points at.
delete from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000003';
delete from commission_ledger where order_id = 'e0000000-0000-0000-0000-000000000003';

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
select hq_redispatch_order('e0000000-0000-0000-0000-000000000003', 'rider went offline');
select pg_temp.check('the order is back in the pool',
                     (select status::text from orders where id = 'e0000000-0000-0000-0000-000000000003'),
                     'pending');
select pg_temp.check('with nobody on it',
                     (select rider_id from orders where id = 'e0000000-0000-0000-0000-000000000003'),
                     null::uuid);
select pg_temp.check('and the declines forgotten, or it would be offered to nobody',
                     (select count(*) from rider_request_events
                       where order_id = 'e0000000-0000-0000-0000-000000000003' and kind = 'declined'),
                     0::bigint);

-- ---------------------------------------------------------------------------
-- 5. Merchant keys: usage counted, health summarised, callbacks replayable.
-- ---------------------------------------------------------------------------
set local role service_role;
insert into merchants (id, name, slug, pickup_lat, pickup_lng, pickup_address, contact_number,
                       webhook_url)
values ('d0000000-0000-0000-0000-000000000001', 'Lutong Bahay', 'lutong-bahay',
        10.3157, 123.8854, '123 Colon St, Cebu City', '09171112222',
        'https://servd.example/hooks/servdgo');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select create_merchant_api_key('d0000000-0000-0000-0000-000000000001', 'live') as key \gset

set local role service_role;
select verify_merchant_key(:'key');
select verify_merchant_key(:'key');
select verify_merchant_key('sk_not_a_key');

select pg_temp.check('two calls were counted, and the miss was not',
                     (select sum(calls)::bigint from merchant_api_key_usage), 2::bigint);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select pg_temp.check('the key list shows the count',
                     (select calls from merchant_key_usage('d0000000-0000-0000-0000-000000000001')),
                     2::bigint);
select pg_temp.check('and never the key itself',
                     (select prefix = left(:'key', length(prefix))
                        from merchant_key_usage('d0000000-0000-0000-0000-000000000001')), true);

set local role service_role;
insert into merchant_webhook_deliveries (id, merchant_id, order_id, event, payload, status,
                                         attempts, last_error)
values ('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
        'e0000000-0000-0000-0000-000000000001', 'order.delivered', '{}'::jsonb, 'failed',
        8, 'connection refused');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
select pg_temp.check('health shows the failure',
                     (select webhooks_failed from merchant_health()
                       where merchant_id = 'd0000000-0000-0000-0000-000000000001'), 1::bigint);
select pg_temp.check('and the last error, so somebody can act on it',
                     (select last_error from merchant_health()
                       where merchant_id = 'd0000000-0000-0000-0000-000000000001'),
                     'connection refused');

select replay_merchant_webhook('f0000000-0000-0000-0000-000000000001');
select pg_temp.check('replay puts it back in the queue',
                     (select status from merchant_webhook_deliveries
                       where id = 'f0000000-0000-0000-0000-000000000001'), 'pending');
select pg_temp.check('with its attempts reset, or it gives up at once',
                     (select attempts from merchant_webhook_deliveries
                       where id = 'f0000000-0000-0000-0000-000000000001'), 0);
select pg_temp.check('and the replay was recorded',
                     (select count(*) from audit_log where action = 'merchant.webhook_replayed'),
                     1::bigint);

-- ---------------------------------------------------------------------------
-- 6. Exports: one city at a time, header first, and quoting that survives it.
-- ---------------------------------------------------------------------------
set local role service_role;
update orders set customer_name = 'Dela Cruz, Juan "JD"'
 where id = 'e0000000-0000-0000-0000-000000000001';

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);

select pg_temp.check('the first line is the header',
  (select line from hq_export('deliveries', '11111111-1111-1111-1111-111111111111',
                              current_date - 1, current_date) as t(line) limit 1),
  'order_id,placed_at,delivered_at,status,service,rider,customer,contact,address,delivery_fee,store_fees,convenience_fee,goods,commission,payment');
select pg_temp.check('every order in the window came out',
  (select count(*) - 1 from hq_export('deliveries', '11111111-1111-1111-1111-111111111111',
                                      current_date - 1, current_date) as t(line)), 3::bigint);
select pg_temp.check('a comma and a quote in a name do not break the file',
  (select count(*) from hq_export('deliveries', '11111111-1111-1111-1111-111111111111',
                                  current_date - 1, current_date) as t(line)
    where line like '%"Dela Cruz, Juan ""JD"""%'), 1::bigint);
select pg_temp.check('and the export itself was recorded',
  (select count(*) from (
     select 1 where exists (
       select 1 from audit_log where action = 'hq.exported'))) , 1::bigint);

do $$
begin
  begin
    perform hq_export('everything', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL an unknown dataset was accepted';
  exception when check_violation then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
do $$
begin
  begin
    perform hq_export('deliveries', '22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL an operator exported another city';
  exception when insufficient_privilege then
    null;
  end;
end $$;
select pg_temp.check('but their own city exports fine',
  (select count(*) > 0 from hq_export('deliveries', '11111111-1111-1111-1111-111111111111',
                                      current_date - 1, current_date) as t(line)), true);

rollback;
