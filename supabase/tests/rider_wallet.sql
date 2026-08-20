-- ServdGo — proof that a prepaid rider wallet moves the same peso exactly once.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rider_wallet.sql
--
-- The thing worth testing here is not the balance. It is that one commission
-- lands in exactly three places and totals back to itself: the rider's wallet
-- loses it, the franchisor's royalty takes its cut, and the city is owed the
-- rest. Every check raises on failure; the script rolls back.

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

insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, markup_operator_share,
                         settlement_gcash_number, settlement_gcash_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Cebu',  'cebu',  'live', 10.3157, 123.8854, 20, 0.15, 1.000, '09170000001', 'Cebu Operator'),
  ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'live',  7.1907, 125.4553, 20, 0.20, 1.000, '09170000002', 'Davao Operator');

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'),
  ('a0000000-0000-0000-0000-000000000006');

insert into profiles (id, role, full_name, territory_id) values
  ('a0000000-0000-0000-0000-000000000001', 'admin',      'Cebu operator',  '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002', 'admin',      'Davao operator', '22222222-2222-2222-2222-222222222222'),
  ('a0000000-0000-0000-0000-000000000003', 'rider',      'Cebu rider',     '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000004', 'rider',      'Davao rider',    '22222222-2222-2222-2222-222222222222'),
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor',     null),
  ('a0000000-0000-0000-0000-000000000006', 'customer',   'A customer',     null)
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id,
                               full_name = excluded.full_name;

update territories set operator_profile_id = 'a0000000-0000-0000-0000-000000000001' where slug = 'cebu';
update territories set operator_profile_id = 'a0000000-0000-0000-0000-000000000002' where slug = 'davao';

insert into riders (id, profile_id, name, mobile_number, application_status, territory_id) values
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Cebu rider',  '09170000003', 'approved', '11111111-1111-1111-1111-111111111111'),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'Davao rider', '09170000004', 'approved', '22222222-2222-2222-2222-222222222222');

insert into customers (id, profile_id, name, mobile_number) values
  ('c0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000006', 'A customer', '09170000006');

-- ---------------------------------------------------------------------------
-- Off by default, and off means nothing changes.
-- ---------------------------------------------------------------------------
select pg_temp.check('the wallet is off until somebody turns it on',
  (select wallet_enabled from platform_settings where id = true), false);

insert into orders (id, customer_id, rider_id, service_type, status, payment_method,
                    delivery_fee, commission_amount, delivery_lat, delivery_lng,
                    delivery_address, customer_name, customer_contact, territory_id)
values ('e0000000-0000-0000-0000-00000000000f', 'c0000000-0000-0000-0000-000000000006',
        'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 'cod',
        50, 30, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
        '11111111-1111-1111-1111-111111111111');
update orders set status = 'delivered' where id = 'e0000000-0000-0000-0000-00000000000f';

select pg_temp.check('with the wallet off the commission is still owed in cash',
  (select settled from commission_ledger where order_id = 'e0000000-0000-0000-0000-00000000000f'),
  false);
select pg_temp.check('and no wallet entry was written',
  (select count(*)::int from rider_wallet_entries), 0);

-- Clear it the old way so it stops counting against the rider below.
update commission_ledger set settled = true
 where order_id = 'e0000000-0000-0000-0000-00000000000f';
delete from royalty_ledger;

-- ---------------------------------------------------------------------------
-- Switch it on.
-- ---------------------------------------------------------------------------
update platform_settings set wallet_enabled = true, royalty_rate = 0.30 where id = true;

-- ---------------------------------------------------------------------------
-- Putting money in. Starting a top-up credits nothing — a payment page is not
-- a payment.
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000003');

do $$
begin
  begin
    perform wallet_topup_start(10);
    raise exception 'FAIL a top-up below the minimum was accepted';
  exception when check_violation then
    raise notice 'ok  a top-up below the minimum is refused';
  end;
end $$;

select reference as topup_ref from wallet_topup_start(500) \gset

select pg_temp.check('a started top-up credits nothing yet',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 0.00::numeric);
select pg_temp.check('the rider can see their own pending top-up',
  (select status from wallet_topups where reference = :'topup_ref'), 'pending');

reset role;
set local role service_role;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');

select wallet_topup_attach_provider(:'topup_ref', 'xendit', 'inv_test_1',
                                    'https://checkout.xendit.co/web/inv_test_1');
select wallet_topup_mark_paid(:'topup_ref', 'inv_test_1', 500);

select pg_temp.check('paying it credits the wallet',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 500.00::numeric);

-- Xendit will send the same callback again. It must not pay twice.
select wallet_topup_mark_paid(:'topup_ref', 'inv_test_1', 500);
select pg_temp.check('the same callback twice credits once',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 500.00::numeric);

select pg_temp.check('a top-up paid to the franchisor owes the city nothing',
  (select count(*)::int from operator_payout_ledger where kind = 'topup_collected'), 0);

-- ---------------------------------------------------------------------------
-- A delivery, and the three places its commission lands.
-- ---------------------------------------------------------------------------
insert into orders (id, customer_id, rider_id, service_type, status, payment_method,
                    delivery_fee, commission_amount, delivery_lat, delivery_lng,
                    delivery_address, customer_name, customer_contact, territory_id)
values ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006',
        'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 'cod',
        50, 100, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
        '11111111-1111-1111-1111-111111111111');
update orders set status = 'delivered' where id = 'e0000000-0000-0000-0000-000000000001';

select pg_temp.check('the commission comes out of the wallet',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 400.00::numeric);
select pg_temp.check('a charged commission is a settled commission',
  (select settled from commission_ledger where order_id = 'e0000000-0000-0000-0000-000000000001'),
  true);
select pg_temp.check('the rider owes nothing in cash',
  rider_owed_balance('b0000000-0000-0000-0000-000000000003'), 0.00::numeric);

select pg_temp.check('the franchisor''s royalty is booked',
  (select amount from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000001'
     and kind = 'royalty'), 30.00::numeric);
select pg_temp.check('and it is already collected, not owed',
  (select settled from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000001'
     and kind = 'royalty'), true);
select pg_temp.check('so the city is not billed for it',
  territory_royalty_due('11111111-1111-1111-1111-111111111111'), 0.00::numeric);

select pg_temp.check('the city is owed the rest of it',
  (select amount from operator_payout_ledger where order_id = 'e0000000-0000-0000-0000-000000000001'
     and kind = 'share'), 70.00::numeric);
select pg_temp.check('the three parts add back up to the commission',
  (select -e.amount from rider_wallet_entries e
     where e.order_id = 'e0000000-0000-0000-0000-000000000001' and e.kind = 'commission')
  - ((select amount from royalty_ledger where order_id = 'e0000000-0000-0000-0000-000000000001' and kind = 'royalty')
     + (select amount from operator_payout_ledger where order_id = 'e0000000-0000-0000-0000-000000000001' and kind = 'share')),
  0.00::numeric);

select pg_temp.check('one delivery cannot be charged twice',
  (select count(*)::int from rider_wallet_entries
    where order_id = 'e0000000-0000-0000-0000-000000000001'), 1);

-- ---------------------------------------------------------------------------
-- The daily record — the number the franchisor pays out on.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
reset role;
set local role authenticated;

select pg_temp.check('the day nets to the city''s share',
  (select net from operator_daily_share('11111111-1111-1111-1111-111111111111')
    where business_day = business_today('11111111-1111-1111-1111-111111111111')),
  70.00::numeric);
select pg_temp.check('and it is unpaid',
  operator_payout_balance('11111111-1111-1111-1111-111111111111'), 70.00::numeric);

-- Cash taken at the city office is float the franchisor is owed, so it comes
-- off what the franchisor pays out.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
select wallet_record_topup('b0000000-0000-0000-0000-000000000003', 200, 'cash', null, 'Paid at the office');

select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
select pg_temp.check('cash at the office still funds the rider',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 600.00::numeric);
select pg_temp.check('but the franchisor now owes the city 200 less',
  operator_payout_balance('11111111-1111-1111-1111-111111111111'), -130.00::numeric);

-- Pay it. Negative means the city owes the franchisor, and the record says so
-- either way.
select amount as paid_amount from franchisor_pay_operator(
  '11111111-1111-1111-1111-111111111111',
  business_today('11111111-1111-1111-1111-111111111111'),
  null, 'gcash', 'PAY-1') \gset

select pg_temp.check('the payout records what was settled', :paid_amount::numeric, -130.00::numeric);
select pg_temp.check('and nothing is left outstanding',
  operator_payout_balance('11111111-1111-1111-1111-111111111111'), 0.00::numeric);
select pg_temp.check('the day now reads as paid',
  (select unpaid from operator_daily_share('11111111-1111-1111-1111-111111111111')
    where business_day = business_today('11111111-1111-1111-1111-111111111111')),
  0.00::numeric);

do $$
begin
  begin
    perform franchisor_pay_operator('11111111-1111-1111-1111-111111111111',
                                    business_today('11111111-1111-1111-1111-111111111111'));
    raise exception 'FAIL a payout was made against nothing';
  exception when check_violation then
    raise notice 'ok  paying a city that is owed nothing is refused';
  end;
end $$;

select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
do $$
begin
  begin
    perform franchisor_pay_operator('11111111-1111-1111-1111-111111111111',
                                    business_today('11111111-1111-1111-1111-111111111111'));
    raise exception 'FAIL an operator paid themselves';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot pay themselves';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Running dry. A rider is not stranded mid-shift; they are stopped the next
-- morning.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;

insert into orders (id, customer_id, rider_id, service_type, status, payment_method,
                    delivery_fee, commission_amount, delivery_lat, delivery_lng,
                    delivery_address, customer_name, customer_contact, territory_id)
values ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000006',
        'b0000000-0000-0000-0000-000000000003', 'food', 'accepted', 'cod',
        50, 700, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
        '11111111-1111-1111-1111-111111111111');
update orders set status = 'delivered' where id = 'e0000000-0000-0000-0000-000000000002';

select pg_temp.check('a wallet may go under during the day',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), -100.00::numeric);
select pg_temp.check('and the rider finishes their shift',
  rider_overdue_balance('b0000000-0000-0000-0000-000000000003',
                        business_today('11111111-1111-1111-1111-111111111111')),
  0.00::numeric);
select pg_temp.check('but cannot start the next one',
  rider_overdue_balance('b0000000-0000-0000-0000-000000000003',
                        business_today('11111111-1111-1111-1111-111111111111') + 1),
  100.00::numeric);

-- Topping up clears it, with no settlement to confirm and nobody to chase. This
-- one lands in the franchisor's own bank account, so the city's share is
-- untouched by it.
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
select wallet_record_topup('b0000000-0000-0000-0000-000000000003', 500, 'bank', 'REF-9');
select pg_temp.check('topping up unlocks them',
  rider_overdue_balance('b0000000-0000-0000-0000-000000000003',
                        business_today('11111111-1111-1111-1111-111111111111') + 1),
  0.00::numeric);

-- ---------------------------------------------------------------------------
-- Cancelling a delivery that was already paid for hands the money back — all
-- three ways at once.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
reset role;
set local role authenticated;

select pg_temp.check('the city is owed the second delivery''s share',
  operator_payout_balance('11111111-1111-1111-1111-111111111111'), 490.00::numeric);

select hq_cancel_order('e0000000-0000-0000-0000-000000000002',
                       'The restaurant never sent the food');

select pg_temp.check('the rider gets the commission back',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 1100.00::numeric);
select pg_temp.check('the franchisor gives back its royalty',
  (select coalesce(sum(amount), 0) from royalty_ledger
    where order_id = 'e0000000-0000-0000-0000-000000000002'), 0.00::numeric);
select pg_temp.check('and the city gives back its share',
  operator_payout_balance('11111111-1111-1111-1111-111111111111'), 0.00::numeric);

-- ---------------------------------------------------------------------------
-- Who may see and touch a wallet.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a0000000-0000-0000-0000-000000000003');
select pg_temp.check('a rider reads their own statement',
  (select count(*)::int > 0 from rider_wallet_statement()), true);

select pg_temp.act_as('a0000000-0000-0000-0000-000000000004');
select pg_temp.check('another city''s rider sees none of it',
  (select count(*)::int from rider_wallet_entries
    where rider_id = 'b0000000-0000-0000-0000-000000000003'), 0);

do $$
begin
  begin
    perform wallet_adjust('b0000000-0000-0000-0000-000000000003', 100, 'because');
    raise exception 'FAIL a rider adjusted a wallet';
  exception when insufficient_privilege then
    raise notice 'ok  a rider cannot adjust a wallet';
  end;
end $$;

select pg_temp.act_as('a0000000-0000-0000-0000-000000000002');
do $$
begin
  begin
    perform wallet_adjust('b0000000-0000-0000-0000-000000000003', 100, 'because');
    raise exception 'FAIL an operator adjusted another city''s rider';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot adjust another city''s rider';
  end;
end $$;

select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
do $$
begin
  begin
    perform wallet_adjust('b0000000-0000-0000-0000-000000000003', 100, '   ');
    raise exception 'FAIL an adjustment was posted without a reason';
  exception when check_violation then
    raise notice 'ok  an adjustment without a reason is refused';
  end;
end $$;

select wallet_adjust('b0000000-0000-0000-0000-000000000003', -50, 'Fuel advance');
select pg_temp.check('an operator can correct their own rider''s wallet',
  rider_wallet_balance('b0000000-0000-0000-0000-000000000003'), 1050.00::numeric);

select pg_temp.check('the statement carries a running balance',
  (select balance_after from rider_wallet_statement('b0000000-0000-0000-0000-000000000003')
    order by created_at desc, id desc limit 1),
  1050.00::numeric);

select pg_temp.check('the summary agrees with the ledger',
  (select balance from rider_wallet_summary('b0000000-0000-0000-0000-000000000003')),
  1050.00::numeric);

select pg_temp.check('the city sees every wallet it is responsible for',
  (select count(*)::int from territory_rider_wallets()), 1);

-- ---------------------------------------------------------------------------
-- The payment account. The key is write-only: the console can say which key is
-- stored and when, and cannot read it back — not even for the person who set
-- it. These checks are about who may touch it, since a throwaway Postgres has
-- no Vault to put a secret in.
-- ---------------------------------------------------------------------------
select pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
do $$
begin
  begin
    perform set_xendit_credentials(p_mode => 'live');
    raise exception 'FAIL an operator configured the payment account';
  exception when insufficient_privilege then
    raise notice 'ok  an operator cannot configure the payment account';
  end;
end $$;

select pg_temp.act_as('a0000000-0000-0000-0000-000000000003');
do $$
begin
  begin
    perform xendit_status();
    raise exception 'FAIL a rider read the payment settings';
  exception when insufficient_privilege then
    raise notice 'ok  a rider cannot read the payment settings';
  end;
end $$;

select pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
do $$
begin
  begin
    perform set_xendit_credentials(p_secret_key => 'sk_live_not_a_xendit_key');
    raise exception 'FAIL a key that is not a Xendit key was accepted';
  exception when check_violation then
    raise notice 'ok  a key that is not a Xendit key is refused';
  end;
end $$;

do $$
begin
  begin
    perform set_xendit_credentials(p_mode => 'production');
    raise exception 'FAIL an unknown environment was accepted';
  exception when check_violation then
    raise notice 'ok  the environment is test or live, nothing else';
  end;
end $$;

select pg_temp.check('the franchisor can read the payment settings',
  (xendit_status() ->> 'keySet')::boolean, false);
select pg_temp.check('and nothing is enabled before a key is stored',
  (xendit_status() ->> 'enabled')::boolean, false);
select pg_temp.check('the settings say plainly that there is nowhere to keep a key here',
  (xendit_status() ->> 'vaultAvailable')::boolean, false);

-- ---------------------------------------------------------------------------
-- The doors that must stay shut.
--
-- These are not "the app does not call them" — they are reachable by name with
-- the anon key, which ships inside every app, so the grant is the only thing
-- standing between a signed-in stranger and the payment key or somebody else's
-- wallet. 0121 closed them; this is what notices if they ever reopen.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select pg_temp.act_as('a0000000-0000-0000-0000-000000000003');

do $$
begin
  begin
    perform xendit_credentials();
    raise exception 'FAIL a signed-in user read the payment key';
  exception when insufficient_privilege then
    raise notice 'ok  the payment key is not readable from a browser';
  end;
end $$;

do $$
begin
  begin
    perform wallet_topup_mark_paid('TOP-ANYTHING', null, 999999);
    raise exception 'FAIL a rider credited their own wallet';
  exception when insufficient_privilege then
    raise notice 'ok  a rider cannot credit their own wallet';
  end;
end $$;

do $$
begin
  begin
    perform verify_merchant_key('sgo_guess');
    raise exception 'FAIL partner keys can be tested from a browser';
  exception when insufficient_privilege then
    raise notice 'ok  partner keys cannot be tested from a browser';
  end;
end $$;

reset role;
rollback;
