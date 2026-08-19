-- ServdGo — proof that the franchisor's 30% follows real money.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/royalty.sql
--
-- Every check raises on failure. The script rolls back and leaves nothing behind.

begin;
\set ON_ERROR_STOP on

create or replace function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', p_user::text, true); end $$;

create or replace function pg_temp.check(p_label text, p_got anyelement, p_want anyelement)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL % — got %, wanted %', p_label, p_got, p_want;
  end if;
  raise notice 'ok  %', p_label;
end $$;

set local role service_role;

-- Two cities. Cebu keeps half of any mark-up, Davao keeps all of it, so the
-- royalty base has to be read per city rather than from a global setting.
insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, markup_operator_share,
                         settlement_gcash_number, settlement_gcash_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu',  'cebu',  'live', 10.3157, 123.8854, 20, 0.15, 0.500, '09170000001', 'Cebu Operator'),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'live',  7.1907, 125.4553, 20, 0.20, 1.000, '09170000002', 'Davao Operator');

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000006');

insert into profiles (id, role, full_name, territory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'admin',      'Cebu operator',  '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002', 'admin',      'Davao operator', '22222222-2222-2222-2222-222222222222'),
  ('a0000000-0000-0000-0000-000000000003', 'rider',      'Cebu rider',     '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor',     null),
  ('a0000000-0000-0000-0000-000000000006', 'customer',   'A customer',     null)
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id,
                               full_name = excluded.full_name;

update territories set operator_profile_id = 'a0000000-0000-0000-0000-000000000001' where slug = 'cebu';
update territories set operator_profile_id = 'a0000000-0000-0000-0000-000000000002' where slug = 'davao';

insert into riders (id, profile_id, name, mobile_number, application_status, territory_id) values
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Cebu rider', '09170000003', 'approved', '11111111-1111-1111-1111-111111111111');

insert into customers (id, profile_id, name, mobile_number) values
  ('c0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000006', 'A customer', '09170000006');

-- A Cebu order worth ₱100 commission and ₱40 of mark-up. Cebu's operator share
-- is half, so the ledger should show ₱100 + ₱20 = ₱120 of platform revenue.
insert into orders (id, customer_id, rider_id, service_type, status, payment_method,
                    delivery_fee, commission_amount, markup_total,
                    delivery_lat, delivery_lng, delivery_address, customer_name, customer_contact,
                    territory_id)
values ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006',
        'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 'cod',
        50, 100, 40, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
        '11111111-1111-1111-1111-111111111111');

update orders set status = 'delivered' where id = 'e0000000-0000-0000-0000-000000000001';

select pg_temp.check('delivery books commission on the ledger',
  (select amount from commission_ledger where order_id = 'e0000000-0000-0000-0000-000000000001' and kind = 'commission'),
  100.00::numeric);
select pg_temp.check('mark-up is booked at the city''s own operator share',
  (select amount from commission_ledger where order_id = 'e0000000-0000-0000-0000-000000000001' and kind = 'markup'),
  20.00::numeric);

-- ---------------------------------------------------------------------------
-- Decision 2. This is the ₱6,554 case: the money is earned but the rider has
-- not handed it over, so the operator owes nothing yet.
-- ---------------------------------------------------------------------------
select pg_temp.check('nothing is owed while the rider has not settled',
  (select count(*)::int from royalty_ledger), 0);

-- The rider settles. Confirming is what flips the ledger.
update commission_ledger set settled = true
 where order_id = 'e0000000-0000-0000-0000-000000000001';

select pg_temp.check('royalty is booked once the settlement is confirmed',
  (select count(*)::int from royalty_ledger where kind = 'royalty'), 2);
select pg_temp.check('the royalty is 30% of commission plus the operator''s mark-up share',
  (select sum(amount) from royalty_ledger), 36.00::numeric);          -- 30% of 120
select pg_temp.check('the base recorded is the platform revenue it came from',
  (select sum(base_amount) from royalty_ledger), 120.00::numeric);
select pg_temp.check('the city owes it',
  territory_royalty_due('11111111-1111-1111-1111-111111111111'), 36.00::numeric);

-- Settling again must not book it twice.
update commission_ledger set settled = true
 where order_id = 'e0000000-0000-0000-0000-000000000001';
select pg_temp.check('re-settling books nothing further',
  (select sum(amount) from royalty_ledger), 36.00::numeric);

-- ---------------------------------------------------------------------------
-- The rate is snapshotted: moving it reprices the future, never the past.
-- ---------------------------------------------------------------------------
update platform_settings set royalty_rate = 0.40 where id = true;

insert into orders (id, customer_id, rider_id, service_type, status, payment_method,
                    delivery_fee, commission_amount, delivery_lat, delivery_lng,
                    delivery_address, customer_name, customer_contact, territory_id)
values ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000006',
        'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 'cod',
        50, 200, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
        '11111111-1111-1111-1111-111111111111');
update orders set status = 'delivered' where id = 'e0000000-0000-0000-0000-000000000002';
update commission_ledger set settled = true where order_id = 'e0000000-0000-0000-0000-000000000002';

select pg_temp.check('the new entry uses the new rate',
  (select amount from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000002'),
  80.00::numeric);
select pg_temp.check('the earlier entries kept the old rate',
  (select distinct rate from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000001'),
  0.3000::numeric);
update platform_settings set royalty_rate = 0.30 where id = true;

-- ---------------------------------------------------------------------------
-- Reversal: a settlement confirmed in error is taken back.
-- ---------------------------------------------------------------------------
update commission_ledger set settled = false where order_id = 'e0000000-0000-0000-0000-000000000002';
select pg_temp.check('un-confirming removes a royalty that was never paid across',
  (select count(*)::int from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000002'), 0);
select pg_temp.check('the balance goes back down',
  territory_royalty_due('11111111-1111-1111-1111-111111111111'), 36.00::numeric);

-- ---------------------------------------------------------------------------
-- The operator pays the franchisor.
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
set local role authenticated;

select pg_temp.check('an operator sees only their own royalty entries',
  (select count(*)::int from royalty_ledger where territory_id = '22222222-2222-2222-2222-222222222222'), 0);

select operator_submit_royalty_settlement(
  (select period_start from royalty_period(business_today())),
  (select period_end from royalty_period(business_today())),
  'gcash', 'REF-1', null) as submitted \gset

select pg_temp.check('the submitted amount is computed, not taken on trust',
  (select amount_due from operator_settlements where id = :'submitted'), 36.00::numeric);
select pg_temp.check('submitting clears nothing on its own',
  territory_royalty_due('11111111-1111-1111-1111-111111111111'), 36.00::numeric);

do $$
begin
  begin
    perform franchisor_confirm_royalty_settlement(
      (select id from operator_settlements limit 1));
    raise exception 'FAIL an operator confirmed their own payment';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot confirm their own payment';
  end;
end $$;

-- The franchisor confirms it.
reset role;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
set local role authenticated;

select franchisor_confirm_royalty_settlement(:'submitted') as cleared \gset
select pg_temp.check('confirming clears exactly what was outstanding', :'cleared'::numeric, 36.00::numeric);
select pg_temp.check('the city owes nothing now',
  territory_royalty_due('11111111-1111-1111-1111-111111111111'), 0.00::numeric);
select pg_temp.check('what was cleared is recorded against the payment',
  (select amount_settled from operator_settlements where id = :'submitted'), 36.00::numeric);
select pg_temp.check('the entries point at the payment that cleared them',
  (select count(*)::int from royalty_ledger where operator_settlement_id = :'submitted'), 2);

-- ---------------------------------------------------------------------------
-- Opening a city: the gate refuses one that is not ready.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
insert into territories (id, name, slug, status, commission_rate)
values ('33333333-3333-3333-3333-333333333333', 'Iloilo', 'iloilo', 'lead', 0.15);

reset role;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
set local role authenticated;

do $$
begin
  begin
    perform approve_territory('33333333-3333-3333-3333-333333333333');
    raise exception 'FAIL an unconfigured city was opened';
  exception when check_violation then
    raise notice 'ok  a city with no operator cannot be opened';
  end;
end $$;

select assign_territory_operator('33333333-3333-3333-3333-333333333333',
                                 'a0000000-0000-0000-0000-000000000006');
select pg_temp.check('appointing an operator binds them to the city',
  (select territory_id from profiles where id = 'a0000000-0000-0000-0000-000000000006'),
  '33333333-3333-3333-3333-333333333333'::uuid);

-- Approving appoints; opening is the separate, checklist-gated step.
select approve_territory('33333333-3333-3333-3333-333333333333');
select pg_temp.check('approving moves it to approved, not to trading',
  (select status from territories where slug = 'iloilo'), 'approved'::territory_status);

do $$
begin
  begin
    perform go_live('33333333-3333-3333-3333-333333333333');
    raise exception 'FAIL a city opened with its checklist outstanding';
  exception when check_violation then
    raise notice 'ok  a city cannot open with its checklist outstanding';
  end;
end $$;

-- Satisfy the items the database checks for itself...
update territories set service_center_lat = 10.72, service_center_lng = 122.56, service_radius_km = 15,
       settlement_gcash_number = '09170000003', settlement_gcash_name = 'Iloilo Operator'
 where id = '33333333-3333-3333-3333-333333333333';
insert into riders (profile_id, name, mobile_number, application_status, territory_id)
select null, 'Iloilo rider ' || g, '0917000900' || g, 'approved', '33333333-3333-3333-3333-333333333333'
  from generate_series(1, 3) g;

do $$
begin
  begin
    perform go_live('33333333-3333-3333-3333-333333333333');
    raise exception 'FAIL a city opened without the human items ticked';
  exception when check_violation then
    raise notice 'ok  the automatic items alone are not enough';
  end;
end $$;

-- ...and the ones a person has to vouch for.
select set_checklist_item('33333333-3333-3333-3333-333333333333', 'agreement_signed', true);
select set_checklist_item('33333333-3333-3333-3333-333333333333', 'franchise_fee_paid', true);
select set_checklist_item('33333333-3333-3333-3333-333333333333', 'test_delivery_completed', true);
select go_live('33333333-3333-3333-3333-333333333333');
select pg_temp.check('a complete city opens',
  (select status from territories where slug = 'iloilo'), 'live'::territory_status);

-- ---------------------------------------------------------------------------
-- The cross-city view, and who may see it.
-- ---------------------------------------------------------------------------
select pg_temp.check('the franchisor sees every city',
  (select count(*)::int from franchisor_overview(business_today() - 30, business_today())
    where territory_name in ('Cebu', 'Davao', 'Iloilo')), 3);
select pg_temp.check('and the revenue each one made',
  (select platform_revenue from franchisor_overview(business_today() - 30, business_today())
    where territory_name = 'Cebu'), 320.00::numeric);
select pg_temp.check('and what it has paid across',
  (select royalty_settled from franchisor_overview(business_today() - 30, business_today())
    where territory_name = 'Cebu'), 36.00::numeric);

reset role;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
begin
  begin
    perform * from franchisor_overview(business_today() - 30, business_today());
    raise exception 'FAIL an operator read the cross-city view';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot read the cross-city view';
  end;
end $$;

select pg_temp.check('an operator can see their own summary',
  (territory_royalty_summary('11111111-1111-1111-1111-111111111111',
                             business_today() - 30, business_today()) ->> 'royaltyDue')::numeric,
  0.00::numeric);

do $$
begin
  begin
    perform territory_royalty_summary('22222222-2222-2222-2222-222222222222',
                                      business_today() - 30, business_today());
    raise exception 'FAIL an operator read another city''s summary';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot read another city''s summary';
  end;
end $$;

reset role;
rollback;
