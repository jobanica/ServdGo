-- ServdGo — viewing a city as its operator, and being unable to touch it.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hq_platform.sql

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

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002');
insert into profiles (id, role, full_name) values
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor')
on conflict (id) do update set role = excluded.role;

insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, settlement_gcash_number, settlement_gcash_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu', 'cebu', 'live',
   10.3157, 123.8854, 20, 0.15, '09170000001', 'Cebu Operator'),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'live',
   7.1907, 125.4553, 20, 0.20, '09170000002', 'Davao Operator');

insert into profiles (id, role, full_name, territory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'admin', 'Cebu operator',
   '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002', 'admin', 'Davao operator',
   '22222222-2222-2222-2222-222222222222')
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id;

-- A city HQ has not opened yet. Live cities are public — a customer has to be
-- able to see where the service runs — so this is the one that proves the
-- cross-city view really closed.
insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, settlement_gcash_number, settlement_gcash_name)
values ('33333333-3333-3333-3333-333333333333', 'Iloilo', 'iloilo', 'lead',
        10.7202, 122.5621, 20, 0.15, '09170000003', 'Iloilo Operator');

insert into customers (id, profile_id, name, mobile_number)
values ('c0000000-0000-0000-0000-000000000006', null, 'A customer', '09170000006');

insert into riders (id, profile_id, name, mobile_number, application_status, territory_id)
values
  ('b0000000-0000-0000-0000-000000000001', null, 'Cebu rider', '09170000011', 'approved',
   '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000002', null, 'Davao rider', '09170000012', 'approved',
   '22222222-2222-2222-2222-222222222222');

-- One order in each city.
insert into orders (id, customer_id, service_type, status, delivery_fee,
                    delivery_lat, delivery_lng, delivery_address, customer_name, customer_contact,
                    territory_id)
values
  ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006', 'food',
   'pending', 50, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
   '11111111-1111-1111-1111-111111111111'),
  ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000006', 'food',
   'pending', 50, 7.1950, 125.4600, 'Davao address', 'A customer', '09170000006',
   '22222222-2222-2222-2222-222222222222');

-- ---------------------------------------------------------------------------
-- 1. Before any visit, the franchisor is a franchisor and sees everything.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;

select pg_temp.check('not viewing anything to begin with', viewing_as_territory(), null::uuid);
select pg_temp.check('is the franchisor', is_franchisor(), true);
select pg_temp.check('is not operator staff', is_staff(), false);
select pg_temp.check('has no city of their own', current_territory_id(), null::uuid);
select pg_temp.check('sees both cities'' orders', (select count(*) from orders), 2::bigint);
select pg_temp.check('sees both cities'' riders', (select count(*) from riders), 2::bigint);
select pg_temp.check('sees the city that has not opened',
                     (select count(*) from territories where status <> 'live'), 1::bigint);

-- ---------------------------------------------------------------------------
-- 2. Inside a visit the franchisor is, for every purpose, the Cebu operator.
-- ---------------------------------------------------------------------------
select begin_view_as('11111111-1111-1111-1111-111111111111', 'checking a complaint');

select pg_temp.check('viewing Cebu', viewing_as_territory(),
                     '11111111-1111-1111-1111-111111111111'::uuid);
select pg_temp.check('stops being the franchisor', is_franchisor(), false);
select pg_temp.check('becomes staff', is_staff(), true);
select pg_temp.check('current city is the viewed one', current_territory_id(),
                     '11111111-1111-1111-1111-111111111111'::uuid);
select pg_temp.check('sees only Cebu', (select count(*) from orders), 1::bigint);
select pg_temp.check('and it is the Cebu one', (select id from orders),
                     'e0000000-0000-0000-0000-000000000001'::uuid);
select pg_temp.check('sees only Cebu''s riders', (select count(*) from riders), 1::bigint);
select pg_temp.check('the unopened city is out of sight',
                     (select count(*) from territories where status <> 'live'), 0::bigint);

-- ---------------------------------------------------------------------------
-- 3. Every kind of write is refused, including ones RLS would have allowed.
-- ---------------------------------------------------------------------------
do $$
declare msg text;
begin
  begin
    update orders set customer_name = 'Renamed by HQ'
     where id = 'e0000000-0000-0000-0000-000000000001';
    raise exception 'FAIL an order was updated during a view-as session';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    if msg not like '%viewing Cebu as its operator%' then
      raise exception 'FAIL the update was refused for the wrong reason: %', msg;
    end if;
  end;
end $$;

do $$
declare msg text;
begin
  begin
    insert into orders (customer_id, service_type, status, delivery_fee, delivery_lat,
                        delivery_lng, delivery_address, customer_name, customer_contact,
                        territory_id)
    values ('c0000000-0000-0000-0000-000000000006', 'food', 'pending', 50, 10.3200, 123.8900,
            'Cebu address', 'A customer', '09170000006',
            '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL an order was created during a view-as session';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    if msg not like '%viewing Cebu%' then
      raise exception 'FAIL the insert was refused for the wrong reason: %', msg;
    end if;
  end;
end $$;

do $$
declare msg text;
begin
  begin
    delete from orders where id = 'e0000000-0000-0000-0000-000000000001';
    raise exception 'FAIL an order was deleted during a view-as session';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    if msg not like '%viewing Cebu%' then
      raise exception 'FAIL the delete was refused for the wrong reason: %', msg;
    end if;
  end;
end $$;

-- A statement that matches no rows still has to be refused: the guard runs per
-- statement, not per row, and "nothing matched" must not read as "allowed".
do $$
begin
  begin
    update orders set customer_name = 'nobody' where id = gen_random_uuid();
    raise exception 'FAIL a no-op update slipped past the guard';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- And a table nobody would think to protect.
do $$
begin
  begin
    update territories set service_radius_km = 999
     where id = '11111111-1111-1111-1111-111111111111';
    raise exception 'FAIL a boundary was moved during a view-as session';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- Every public table except the two that must keep working carries the guard.
select pg_temp.check('no table was left unguarded',
  (select count(*) from pg_tables t
    where t.schemaname = 'public'
      and t.tablename not in ('hq_view_sessions', 'audit_log')
      and not exists (
        select 1 from pg_trigger g
         where g.tgrelid = format('public.%I', t.tablename)::regclass
           and g.tgname = 'zz_hq_readonly')),
  0::bigint);

-- ---------------------------------------------------------------------------
-- 4. Someone else's writes are untouched — the block follows the person.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
update orders set customer_name = 'Renamed by Davao'
 where id = 'e0000000-0000-0000-0000-000000000002';
select pg_temp.check('the Davao operator still works while HQ is looking at Cebu',
                     (select customer_name from orders where id = 'e0000000-0000-0000-0000-000000000002'),
                     'Renamed by Davao');

-- ---------------------------------------------------------------------------
-- 5. Leaving works even though writes are blocked, and both ends are recorded.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
select end_view_as();

select pg_temp.check('no longer viewing', viewing_as_territory(), null::uuid);
select pg_temp.check('is the franchisor again', is_franchisor(), true);
select pg_temp.check('sees both cities again', (select count(*) from orders), 2::bigint);
select pg_temp.check('and the unopened city is back', 
                     (select count(*) from territories where status <> 'live'), 1::bigint);

-- The order can be edited now, which is what the guard was stopping.
update orders set customer_name = 'Renamed by HQ'
 where id = 'e0000000-0000-0000-0000-000000000001';
select pg_temp.check('writing works once the visit is over',
                     (select customer_name from orders where id = 'e0000000-0000-0000-0000-000000000001'),
                     'Renamed by HQ');

set local role service_role;
select pg_temp.check('the visit was logged',
                     (select count(*) from audit_log where action = 'hq.view_as_started'
                        and territory_id = '11111111-1111-1111-1111-111111111111'), 1::bigint);
select pg_temp.check('the reason was kept',
                     (select diff ->> 'reason' from audit_log where action = 'hq.view_as_started'),
                     'checking a complaint');
select pg_temp.check('leaving was logged',
                     (select count(*) from audit_log where action = 'hq.view_as_ended'), 1::bigint);
select pg_temp.check('ending twice is harmless',
                     (select count(*) from hq_view_sessions where ended_at is null), 0::bigint);

-- ---------------------------------------------------------------------------
-- 6. Only the franchisor can start a visit, and only into a real city.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  begin
    perform begin_view_as('22222222-2222-2222-2222-222222222222');
    raise exception 'FAIL an operator viewed another city as its operator';
  exception when insufficient_privilege then
    null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
do $$
begin
  begin
    perform begin_view_as('44444444-4444-4444-4444-444444444444');
    raise exception 'FAIL a visit was started to a city that does not exist';
  exception when no_data_found then
    null;
  end;
end $$;

-- Starting a second visit closes the first: one city at a time.
select begin_view_as('11111111-1111-1111-1111-111111111111');
select end_view_as();
select begin_view_as('22222222-2222-2222-2222-222222222222');
select pg_temp.check('now viewing Davao', viewing_as_territory(),
                     '22222222-2222-2222-2222-222222222222'::uuid);
select begin_view_as('11111111-1111-1111-1111-111111111111');
select pg_temp.check('switching cities does not leave two sessions open',
                     (select count(*) from hq_view_sessions where ended_at is null), 1::bigint);
select pg_temp.check('and the open one is Cebu', viewing_as_territory(),
                     '11111111-1111-1111-1111-111111111111'::uuid);
select end_view_as();

rollback;
