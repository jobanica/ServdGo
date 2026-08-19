-- ServdGo — HQ-issued invoicing, aging, and what happens when a city does not pay.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hq_billing.sql

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

insert into auth.users (id) values ('a0000000-0000-0000-0000-000000000005');
insert into profiles (id, role, full_name) values
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor')
on conflict (id) do update set role = excluded.role;

-- Two live cities: one billed a fixed fee on top, one royalty only.
insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, franchise_fee_monthly, grace_days,
                         settlement_gcash_number, settlement_gcash_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu', 'cebu', 'live',
   10.3157, 123.8854, 20, 0.15, 2500, 7, '09170000001', 'Cebu Operator'),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'live',
   7.1907, 125.4553, 20, 0.20, 0, 7, '09170000002', 'Davao Operator');

-- Royalty already earned and settled by riders, so it is owed to HQ.
insert into royalty_ledger (territory_id, kind, base_amount, rate, amount, business_day)
values
  ('11111111-1111-1111-1111-111111111111', 'royalty', 1000, 0.30, 300, current_date - 10),
  ('11111111-1111-1111-1111-111111111111', 'royalty',  500, 0.30, 150, current_date - 5),
  ('22222222-2222-2222-2222-222222222222', 'royalty',  800, 0.30, 240, current_date - 5);

-- ---------------------------------------------------------------------------
-- 1. A city cannot be created already trading.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;
do $$
begin
  begin
    insert into territories (name, slug, status) values ('Sneaky', 'sneaky', 'live');
    raise exception 'FAIL a city was created already live, skipping the checklist';
  exception when check_violation then
    raise notice 'ok  a city cannot be created already live';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The monthly run.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
select run_monthly_invoicing(current_date) as issued \gset
select pg_temp.check('an invoice is issued per live city', :'issued'::int, 2);

select pg_temp.check('the fixed fee is billed alongside the royalty',
  (select amount_due from operator_settlements
    where territory_id = '11111111-1111-1111-1111-111111111111'), 2950.00::numeric);
select pg_temp.check('and the two parts are shown separately',
  (select franchise_fee || '/' || royalty_amount from operator_settlements
    where territory_id = '11111111-1111-1111-1111-111111111111'), '2500.00/450.00');
select pg_temp.check('a city with no fixed fee is billed royalty only',
  (select amount_due from operator_settlements
    where territory_id = '22222222-2222-2222-2222-222222222222'), 240.00::numeric);
select pg_temp.check('the fixed fee landed on the ledger, not only on the invoice',
  (select count(*)::int from royalty_ledger
    where territory_id = '11111111-1111-1111-1111-111111111111' and kind = 'franchise_fee'), 1);

-- Re-running must not double-bill.
select run_monthly_invoicing(current_date);
select pg_temp.check('re-running does not double-bill',
  (select amount_due from operator_settlements
    where territory_id = '11111111-1111-1111-1111-111111111111'), 2950.00::numeric);
select pg_temp.check('nor duplicate the fixed fee on the ledger',
  (select count(*)::int from royalty_ledger
    where territory_id = '11111111-1111-1111-1111-111111111111' and kind = 'franchise_fee'), 1);

-- The due date is the city's own grace period, not a global one.
select pg_temp.check('the due date is the period end plus that city''s grace days',
  (select due_at - period_end from operator_settlements
    where territory_id = '11111111-1111-1111-1111-111111111111'), 7);

-- ---------------------------------------------------------------------------
-- 3. Aging.
-- ---------------------------------------------------------------------------
select pg_temp.check('an invoice inside its grace period is current',
  (select bucket from invoice_aging where territory_id = '11111111-1111-1111-1111-111111111111'), 'current');

update operator_settlements set due_at = current_date - 20
 where territory_id = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('twenty days late lands in the 16-30 bucket',
  (select bucket from invoice_aging where territory_id = '11111111-1111-1111-1111-111111111111'), '16-30');
select pg_temp.check('and the days are counted from the due date',
  (select days_overdue from invoice_aging where territory_id = '11111111-1111-1111-1111-111111111111'), 20);

-- ---------------------------------------------------------------------------
-- 4. A manual entry has to say what it is for.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;
do $$
begin
  begin
    perform charge_territory_fee('22222222-2222-2222-2222-222222222222', 500, 'adjustment', null);
    raise exception 'FAIL an adjustment was accepted with no note';
  exception when check_violation then
    raise notice 'ok  a manual adjustment needs a note';
  end;
end $$;
select charge_territory_fee('22222222-2222-2222-2222-222222222222', -100, 'adjustment',
                            'Goodwill credit for the October outage') as adj \gset
select pg_temp.check('a credit with a note is accepted',
  (select amount from royalty_ledger where id = :'adj'), -100.00::numeric);

-- ---------------------------------------------------------------------------
-- 5. The overdue sweep.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
select sweep_overdue_territories() as swept \gset
select pg_temp.check('the overdue city is suspended', :'swept'::int, 1);
select pg_temp.check('and it is the late one',
  (select status from territories where slug = 'cebu'), 'suspended'::territory_status);
select pg_temp.check('the city inside its grace period is untouched',
  (select status from territories where slug = 'davao'), 'live'::territory_status);
select pg_temp.check('the suspension is marked as automatic',
  (select auto_suspended from territories where slug = 'cebu'), true);
select pg_temp.check('and it is on the audit log',
  (select count(*)::int from audit_log where action = 'territory.auto_suspended'), 1);

-- A suspended city takes no new orders; the ones in flight are unaffected.
insert into customers (id, profile_id, name, mobile_number)
values ('c0000000-0000-0000-0000-000000000006', null, 'A customer', '09170000006');
do $$
begin
  begin
    insert into orders (customer_id, service_type, status, delivery_fee, delivery_lat, delivery_lng,
                        delivery_address, customer_name, customer_contact,
                        territory_id)
    values ('c0000000-0000-0000-0000-000000000006', 'food', 'pending', 50, 10.3200, 123.8900,
            'Cebu address', 'A customer', '09170000006', '11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL a suspended city took a new order';
  exception when check_violation then
    raise notice 'ok  a suspended city takes no new orders';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Paying up reopens it — but only what the sweep closed.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;

select id as inv from operator_settlements
 where territory_id = '11111111-1111-1111-1111-111111111111' \gset
select franchisor_confirm_royalty_settlement(:'inv');

select pg_temp.check('paying up reopens the city',
  (select status from territories where slug = 'cebu'), 'live'::territory_status);
select pg_temp.check('and clears the automatic flag',
  (select auto_suspended from territories where slug = 'cebu'), false);
select pg_temp.check('the reactivation is on the audit log',
  (select count(*)::int from audit_log where action = 'territory.auto_reactivated'), 1);

-- A suspension somebody chose is not undone by a payment.
select suspend_territory('22222222-2222-2222-2222-222222222222', 'Under investigation');
select pg_temp.check('a hand suspension is not marked automatic',
  (select auto_suspended from territories where slug = 'davao'), false);
select pg_temp.check('and a payment does not lift it',
  reactivate_if_paid_up('22222222-2222-2222-2222-222222222222'), false);
select pg_temp.check('so the city stays suspended',
  (select status from territories where slug = 'davao'), 'suspended'::territory_status);

reset role;
rollback;
