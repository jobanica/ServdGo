-- ServdGo — the franchisee lifecycle: the checklist gate, territory overlap,
-- config history and the append-only audit log.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hq_lifecycle.sql

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
  ('a0000000-0000-0000-0000-000000000001');
insert into profiles (id, role, full_name) values
  ('a0000000-0000-0000-0000-000000000005', 'franchisor', 'Franchisor')
on conflict (id) do update set role = excluded.role;

-- A live city, far from everything, with its checklist already satisfied.
insert into territories (id, name, slug, status, service_center_lat, service_center_lng,
                         service_radius_km, commission_rate, settlement_gcash_number, settlement_gcash_name)
values ('11111111-1111-1111-1111-111111111111', 'Cebu', 'cebu', 'approved',
        10.3157, 123.8854, 20, 0.15, '09170000001', 'Cebu Operator');

-- ---------------------------------------------------------------------------
-- 1. Every new city gets the list.
-- ---------------------------------------------------------------------------
select pg_temp.check('a new city is seeded with the default checklist',
  (select count(*)::int from territory_onboarding_checklist
    where territory_id = '11111111-1111-1111-1111-111111111111'), 6);
select pg_temp.check('three of them are the database''s to answer',
  (select count(*)::int from territory_onboarding_checklist
    where territory_id = '11111111-1111-1111-1111-111111111111' and auto), 3);

-- ---------------------------------------------------------------------------
-- 2. The automatic items answer themselves.
-- ---------------------------------------------------------------------------
select refresh_territory_checklist('11111111-1111-1111-1111-111111111111');
select pg_temp.check('the boundary item ticks itself once a boundary exists',
  (select done from territory_onboarding_checklist
    where territory_id = '11111111-1111-1111-1111-111111111111' and item_key = 'boundary_drawn'), true);
select pg_temp.check('the payout item ticks itself once payout details exist',
  (select done from territory_onboarding_checklist
    where territory_id = '11111111-1111-1111-1111-111111111111' and item_key = 'payout_details_set'), true);
select pg_temp.check('but riders do not, with none on file',
  (select done from territory_onboarding_checklist
    where territory_id = '11111111-1111-1111-1111-111111111111' and item_key = 'riders_verified_min3'), false);

reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;

do $$
begin
  begin
    perform set_checklist_item('11111111-1111-1111-1111-111111111111', 'boundary_drawn', true);
    raise exception 'FAIL an automatic item was ticked by hand';
  exception when check_violation then
    raise notice 'ok  an automatic item cannot be ticked by hand';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The gate, and that it says what is missing.
-- ---------------------------------------------------------------------------
do $$
declare msg text;
begin
  begin
    perform go_live('11111111-1111-1111-1111-111111111111');
    raise exception 'FAIL a city opened with items outstanding';
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like '%Franchise agreement signed%' then
      raise exception 'FAIL the refusal did not name what is missing: %', msg;
    end if;
    raise notice 'ok  opening is refused, naming what is still outstanding';
  end;
end $$;

reset role;
set local role service_role;
insert into riders (profile_id, name, mobile_number, application_status, territory_id)
select null, 'Rider ' || g, '0917000100' || g, 'approved', '11111111-1111-1111-1111-111111111111'
  from generate_series(1, 3) g;

reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;
select set_checklist_item('11111111-1111-1111-1111-111111111111', 'agreement_signed', true);
select set_checklist_item('11111111-1111-1111-1111-111111111111', 'franchise_fee_paid', true);
select set_checklist_item('11111111-1111-1111-1111-111111111111', 'test_delivery_completed', true);
select go_live('11111111-1111-1111-1111-111111111111');
select pg_temp.check('a complete city opens', 
  (select status from territories where slug = 'cebu'), 'live'::territory_status);
select pg_temp.check('and the rider item ticked itself along the way',
  (select done from territory_onboarding_checklist
    where territory_id = '11111111-1111-1111-1111-111111111111' and item_key = 'riders_verified_min3'), true);

-- ---------------------------------------------------------------------------
-- 4. Two cities cannot claim the same ground.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;

do $$
begin
  begin
    -- 8 km from Cebu's centre, with a 20 km radius: squarely on top of it.
    insert into territories (name, slug, status, service_center_lat, service_center_lng, service_radius_km)
    values ('Mandaue', 'mandaue', 'approved', 10.3800, 123.9400, 20);
    raise exception 'FAIL an overlapping territory was accepted';
  exception when check_violation then
    raise notice 'ok  an overlapping boundary is refused';
  end;
end $$;

do $$
declare msg text;
begin
  begin
    insert into territories (name, slug, status, service_center_lat, service_center_lng, service_radius_km)
    values ('Mandaue', 'mandaue', 'approved', 10.3800, 123.9400, 20);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    if msg not like '%Cebu %' then
      raise exception 'FAIL the refusal did not name the conflicting city: %', msg;
    end if;
    raise notice 'ok  and it names the city it conflicts with';
  end;
end $$;

insert into territories (id, name, slug, status, service_center_lat, service_center_lng, service_radius_km)
values ('22222222-2222-2222-2222-222222222222', 'Davao', 'davao', 'approved', 7.1907, 125.4553, 20);
select pg_temp.check('a boundary that clears the others is accepted',
  (select name from territories where slug = 'davao'), 'Davao');

-- A terminated city has released its ground.
update territories set status = 'terminated' where slug = 'davao';
insert into territories (name, slug, status, service_center_lat, service_center_lng, service_radius_km)
values ('Davao South', 'davao-south', 'approved', 7.1907, 125.4553, 20);
select pg_temp.check('a terminated city releases its ground',
  (select count(*)::int from territories where slug = 'davao-south'), 1);

-- ---------------------------------------------------------------------------
-- 5. Permission is decided before geometry.
--
-- An operator may not move a boundary at all. If the overlap trigger ran first
-- they would be told which other city they clashed with — a city they cannot
-- otherwise see.
-- ---------------------------------------------------------------------------
insert into profiles (id, role, full_name, territory_id)
values ('a0000000-0000-0000-0000-000000000001', 'admin', 'Cebu operator',
        '11111111-1111-1111-1111-111111111111')
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id;

reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
declare msg text;
begin
  begin
    update territories set service_center_lat = 7.1907, service_center_lng = 125.4553
     where slug = 'cebu';
    raise exception 'FAIL an operator moved a boundary';
  exception
    when insufficient_privilege then
      raise notice 'ok  an operator is refused before any geometry is considered';
    when check_violation then
      get stacked diagnostics msg = message_text;
      raise exception 'FAIL the overlap check ran before the permission check: %', msg;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Config history.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;
update territories set commission_rate = 0.18, franchise_fee_monthly = 2500 where slug = 'cebu';

select pg_temp.check('a rev-share change is recorded',
  (select new_value from territory_config_history
    where territory_id = '11111111-1111-1111-1111-111111111111' and field = 'commission_rate'
    order by changed_at desc limit 1), '0.1800');
select pg_temp.check('with what it was before',
  (select old_value from territory_config_history
    where territory_id = '11111111-1111-1111-1111-111111111111' and field = 'commission_rate'
    order by changed_at desc limit 1), '0.1500');
select pg_temp.check('and the franchise fee too',
  (select new_value from territory_config_history
    where territory_id = '11111111-1111-1111-1111-111111111111' and field = 'franchise_fee_monthly'
    order by changed_at desc limit 1), '2500.00');
select pg_temp.check('against the person who changed it',
  (select changed_by from territory_config_history
    where territory_id = '11111111-1111-1111-1111-111111111111' and field = 'commission_rate'
    order by changed_at desc limit 1), 'a0000000-0000-0000-0000-000000000005'::uuid);

-- ---------------------------------------------------------------------------
-- 7. The audit log, and that it cannot be rewritten.
-- ---------------------------------------------------------------------------
select pg_temp.check('going live was logged',
  (select count(*)::int from audit_log
    where action = 'territory.status_changed' and diff ->> 'to' = 'live'), 1);

do $$
begin
  begin
    update audit_log set action = 'nothing to see here' where true;
    raise exception 'FAIL the audit log was edited';
  exception when insufficient_privilege then
    raise notice 'ok  the audit log cannot be edited, even by the franchisor';
  end;
end $$;

do $$
begin
  begin
    delete from audit_log where true;
    raise exception 'FAIL the audit log was deleted from';
  exception when insufficient_privilege then
    raise notice 'ok  and cannot be deleted from';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Document expiry.
-- ---------------------------------------------------------------------------
reset role;
set local role service_role;
insert into territory_documents (territory_id, kind, label, file_url, expires_at) values
  ('11111111-1111-1111-1111-111111111111', 'agreement', 'Franchise agreement',
   '11111111-1111-1111-1111-111111111111/agreement.pdf', business_today() + 400),
  ('11111111-1111-1111-1111-111111111111', 'permit', 'Business permit',
   '11111111-1111-1111-1111-111111111111/permit.pdf', business_today() + 10),
  ('11111111-1111-1111-1111-111111111111', 'insurance', 'Insurance',
   '11111111-1111-1111-1111-111111111111/insurance.pdf', business_today() - 1);

select pg_temp.check('a document far from expiry is fine',
  (select state from territory_document_expiry where kind = 'agreement'), 'ok');
select pg_temp.check('one inside 30 days is flagged',
  (select state from territory_document_expiry where kind = 'permit'), 'expiring');
select pg_temp.check('and one past its date is expired',
  (select state from territory_document_expiry where kind = 'insurance'), 'expired');

reset role;
rollback;
