-- ServdGo — proof that a city operator cannot reach another city.
--
-- Run against a database with every migration applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/territory_isolation.sql
--
-- Every check raises on failure, so a clean run means the boundary holds. The
-- script rolls back, leaving nothing behind.

begin;

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Two cities, 600km apart, each with an operator, a rider and a store.
--
-- Provisioned as service_role, the way a server-side seed would: it bypasses
-- RLS and satisfies the role guard from 0012, so the fixture does not have to
-- work around the very rules under test.
-- ---------------------------------------------------------------------------
set local role service_role;
insert into territories (id, name, slug, status, service_center_lat, service_center_lng, service_radius_km, commission_rate)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu',  'cebu',  'active', 10.3157, 123.8854, 20, 0.15),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'active',  7.1907, 125.4553, 20, 0.20);

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'),  -- Cebu operator
  ('a0000000-0000-0000-0000-000000000002'),  -- Davao operator
  ('a0000000-0000-0000-0000-000000000003'),  -- Cebu rider
  ('a0000000-0000-0000-0000-000000000004'),  -- Davao rider
  ('a0000000-0000-0000-0000-000000000005'),  -- franchisor
  ('a0000000-0000-0000-0000-000000000006');  -- customer

insert into profiles (id, role, full_name, territory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'admin', 'Cebu operator',  '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002', 'admin', 'Davao operator', '22222222-2222-2222-2222-222222222222'),
  ('a0000000-0000-0000-0000-000000000003', 'rider', 'Cebu rider',     '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000004', 'rider', 'Davao rider',    '22222222-2222-2222-2222-222222222222'),
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor', null),
  ('a0000000-0000-0000-0000-000000000006', 'customer', 'A customer',  null)
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id;

update territories set operator_profile_id = 'a0000000-0000-0000-0000-000000000001'
  where id = '11111111-1111-1111-1111-111111111111';
update territories set operator_profile_id = 'a0000000-0000-0000-0000-000000000002'
  where id = '22222222-2222-2222-2222-222222222222';

insert into riders (id, profile_id, name, mobile_number, application_status, territory_id) values
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Cebu rider',  '09170000003', 'approved', '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'Davao rider', '09170000004', 'approved', '22222222-2222-2222-2222-222222222222');

insert into customers (id, profile_id, name, mobile_number) values
  ('c0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000006', 'A customer', '09170000006');

insert into stores (id, name, category, address, lat, lng, contact_number, territory_id) values
  ('d0000000-0000-0000-0000-000000000001', 'Cebu Carinderia',  'Filipino', 'Cebu',  10.3157, 123.8854, '09170001111', '11111111-1111-1111-1111-111111111111'),
  ('d0000000-0000-0000-0000-000000000002', 'Davao Carinderia', 'Filipino', 'Davao',  7.1907, 125.4553, '09170002222', '22222222-2222-2222-2222-222222222222');

-- One delivered order in each city, each with its own commission row.
insert into orders (id, customer_id, service_type, status, delivery_fee, delivery_lat, delivery_lng,
                    delivery_address, customer_name, customer_contact, rider_id, territory_id)
values
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006', 'food', 'delivered',
   50, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
   'b0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000006', 'food', 'delivered',
   50, 7.1950, 125.4600, 'Davao address', 'A customer', '09170000006',
   'b0000000-0000-0000-0000-000000000004', '22222222-2222-2222-2222-222222222222');

-- Two pending orders, one per city, for the rider-pool checks.
insert into orders (id, customer_id, service_type, status, delivery_fee, delivery_lat, delivery_lng,
                    delivery_address, customer_name, customer_contact, territory_id)
values
  ('e0000000-0000-0000-0000-000000000011', 'c0000000-0000-0000-0000-000000000006', 'food', 'pending',
   50, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006', '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000012', 'c0000000-0000-0000-0000-000000000006', 'food', 'pending',
   50, 7.1950, 125.4600, 'Davao address', 'A customer', '09170000006', '22222222-2222-2222-2222-222222222222');

insert into commission_ledger (rider_id, order_id, amount, business_day, territory_id) values
  ('b0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 7.50, current_date, '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000002', 10.00, current_date, '22222222-2222-2222-2222-222222222222');

-- ---------------------------------------------------------------------------
-- Helpers to act as somebody.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
end $$;

create or replace function pg_temp.check(p_label text, p_got anyelement, p_want anyelement)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL % — got %, wanted %', p_label, p_got, p_want;
  end if;
  raise notice 'ok  %', p_label;
end $$;

-- ---------------------------------------------------------------------------
-- 1. An operator reads only their own city.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');

select pg_temp.check('cebu operator sees only cebu orders',
  (select count(*)::int from orders where territory_id = '22222222-2222-2222-2222-222222222222'), 0);
select pg_temp.check('cebu operator sees its own orders',
  (select count(*)::int from orders where territory_id = '11111111-1111-1111-1111-111111111111'), 2);
select pg_temp.check('cebu operator sees only cebu riders',
  (select count(*)::int from riders where territory_id = '22222222-2222-2222-2222-222222222222'), 0);
select pg_temp.check('cebu operator sees only cebu ledger',
  (select count(*)::int from commission_ledger), 1);
select pg_temp.check('cebu operator cannot read davao staff profiles',
  (select count(*)::int from profiles where id = 'a0000000-0000-0000-0000-000000000002'), 0);

-- 2. And cannot write into the other city.
do $$
begin
  update orders set status = 'cancelled' where id = 'e0000000-0000-0000-0000-000000000002';
  if found then
    raise exception 'FAIL cebu operator wrote a davao order';
  end if;
  raise notice 'ok  cebu operator cannot write davao orders';
end $$;

-- 3. The rider pool stops at the city line.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000003');
select pg_temp.check('cebu rider pool excludes davao',
  (select count(*)::int from orders where status = 'pending' and rider_id is null
     and territory_id = '22222222-2222-2222-2222-222222222222'), 0);
select pg_temp.check('cebu rider pool has its own city',
  (select count(*)::int from orders where status = 'pending' and rider_id is null), 1);

do $$
begin
  update orders set rider_id = 'b0000000-0000-0000-0000-000000000003'
   where id = 'e0000000-0000-0000-0000-000000000012';
  if found then
    raise exception 'FAIL cebu rider claimed a davao order';
  end if;
  raise notice 'ok  cebu rider cannot claim a davao order';
end $$;

-- 4. The franchisor sees across every city.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
select pg_temp.check('franchisor sees all orders',      (select count(*)::int from orders), 4);
select pg_temp.check('franchisor sees all riders',      (select count(*)::int from riders), 2);
select pg_temp.check('franchisor sees the whole ledger',(select count(*)::int from commission_ledger), 2);
select pg_temp.check('franchisor sees both territories',(select count(*)::int from territories where slug in ('cebu','davao')), 2);

-- 5. Settings resolve to the caller's own city.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
select pg_temp.check('cebu operator settings are cebu''s',
  (select commission_rate from app_settings), 0.1500::numeric);
select pg_temp.act_as('a0000000-0000-0000-0000-000000000002');
select pg_temp.check('davao operator settings are davao''s',
  (select commission_rate from app_settings), 0.2000::numeric);

-- 6. An operator changes their own fees, but not the boundary or the status.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000002');
update app_settings set per_store_fee = 30;
select pg_temp.check('operator can change their own fee',
  (select per_store_fee from territories where slug = 'davao'), 30.00::numeric);

do $$
begin
  begin
    update territories set service_radius_km = 500 where slug = 'davao';
    raise exception 'FAIL operator moved their own boundary';
  exception when insufficient_privilege then
    raise notice 'ok  operator cannot move the boundary';
  end;
end $$;

do $$
begin
  begin
    update territories set status = 'suspended' where slug = 'davao';
    raise exception 'FAIL operator changed their own status';
  exception when insufficient_privilege then
    raise notice 'ok  operator cannot open or suspend a territory';
  end;
end $$;

-- 7. The commission band holds.
reset role;
do $$
begin
  begin
    update territories set commission_rate = 0.02 where slug = 'cebu';
    raise exception 'FAIL commission below the band was accepted';
  exception when check_violation then
    raise notice 'ok  commission below the band is refused';
  end;
  begin
    update territories set commission_rate = 0.90 where slug = 'cebu';
    raise exception 'FAIL commission above the band was accepted';
  exception when check_violation then
    raise notice 'ok  commission above the band is refused';
  end;
end $$;

-- 8. Routing: the pickup decides which city an order belongs to.
select pg_temp.check('a cebu pin routes to cebu',
  territory_for_point(10.3157, 123.8854), '11111111-1111-1111-1111-111111111111'::uuid);
select pg_temp.check('a davao pin routes to davao',
  territory_for_point(7.1907, 125.4553), '22222222-2222-2222-2222-222222222222'::uuid);
select pg_temp.check('a pin in neither city routes nowhere',
  territory_for_point(14.5995, 120.9842), null::uuid);

-- 9. A drop-off outside every territory is refused outright.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000006');
set local role authenticated;
do $$
begin
  begin
    insert into orders (customer_id, service_type, status, delivery_fee,
                        delivery_lat, delivery_lng, delivery_address, customer_name, customer_contact)
    values ('c0000000-0000-0000-0000-000000000006', 'food', 'pending', 50,
            14.5995, 120.9842, 'Manila', 'A customer', '09170000006');
    raise exception 'FAIL an out-of-area order was accepted';
  exception when check_violation then
    raise notice 'ok  an out-of-area drop-off is refused';
  end;
end $$;

-- 10. An in-area order is routed and accepted without being told its city.
insert into orders (id, customer_id, service_type, status, delivery_fee,
                    delivery_lat, delivery_lng, delivery_address, customer_name, customer_contact)
values ('e0000000-0000-0000-0000-0000000000aa', 'c0000000-0000-0000-0000-000000000006', 'food', 'pending', 50,
        10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006');

reset role;
select pg_temp.check('a new cebu order was routed to cebu, unprompted',
  (select territory_id from orders where id = 'e0000000-0000-0000-0000-0000000000aa'),
  '11111111-1111-1111-1111-111111111111'::uuid);

-- 11. A suspended city stops taking orders; the others carry on.
set local role service_role;
update territories set status = 'suspended' where slug = 'cebu';
reset role;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000006');
set local role authenticated;
do $$
begin
  begin
    insert into orders (customer_id, service_type, status, delivery_fee,
                        delivery_lat, delivery_lng, delivery_address, customer_name, customer_contact)
    values ('c0000000-0000-0000-0000-000000000006', 'food', 'pending', 50,
            10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006');
    raise exception 'FAIL a suspended city took an order';
  exception when check_violation then
    raise notice 'ok  a suspended city takes no new orders';
  end;
end $$;

reset role;
rollback;
