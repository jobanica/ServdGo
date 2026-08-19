-- ServdGo — the partner scorecard, its thresholds, and the alert generators.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/hq_monitoring.sql

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
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000001');
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

-- Business hours are the city's own, so pin both cities to a zone where it is
-- currently midday. Otherwise this test passes or fails depending on the hour
-- it happens to run at.
update territories set timezone = (
  select case when off >= 0 then 'Etc/GMT-' || off else 'Etc/GMT+' || (-off) end
    from (select (12 - extract(hour from (now() at time zone 'UTC'))::int) as off) x);

insert into customers (id, profile_id, name, mobile_number)
values ('c0000000-0000-0000-0000-000000000006', null, 'A customer', '09170000006');

insert into riders (id, profile_id, name, mobile_number, application_status, is_online, territory_id)
values
  ('b0000000-0000-0000-0000-000000000001', null, 'Cebu rider', '09170000011', 'approved', true,
   '11111111-1111-1111-1111-111111111111');
-- Davao has nobody online at all.

-- Six Cebu orders: four delivered, one cancelled, one still pending.
insert into orders (id, customer_id, rider_id, service_type, status, delivery_fee,
                    delivery_lat, delivery_lng, delivery_address, customer_name, customer_contact,
                    territory_id, created_at, delivered_at)
select
  ('e0000000-0000-0000-0000-00000000000' || g)::uuid,
  'c0000000-0000-0000-0000-000000000006',
  case when g <= 5 then 'b0000000-0000-0000-0000-000000000001'::uuid else null end, 'food',
  (case when g <= 4 then 'delivered' when g = 5 then 'cancelled' else 'pending' end)::order_status,
  50, 10.3200, 123.8900, 'Cebu address', 'A customer', '09170000006',
  '11111111-1111-1111-1111-111111111111',
  now() - interval '2 days', now() - interval '2 days' + interval '38 minutes'
from generate_series(1, 6) g;

-- Timings for one of them, so the averages have something to average.
insert into order_status_events (order_id, status, created_at)
select ('e0000000-0000-0000-0000-00000000000' || g)::uuid, s.status, s.at
  from generate_series(1, 4) g,
       lateral (values
         ('accepted'::order_status,  now() - interval '2 days' + interval '4 minutes'),
         ('picked_up'::order_status, now() - interval '2 days' + interval '18 minutes')
       ) s(status, at);

select refresh_scorecard();

-- ---------------------------------------------------------------------------
-- 1. The scorecard.
-- ---------------------------------------------------------------------------
select pg_temp.check('both windows are computed per city',
  (select count(*)::int from territory_scorecard
    where territory_id = '11111111-1111-1111-1111-111111111111'), 2);
select pg_temp.check('the 7-day window counts the orders',
  (select orders::int from territory_scorecard
    where territory_id = '11111111-1111-1111-1111-111111111111' and window_days = 7), 6);
select pg_temp.check('completion is delivered over placed',
  (select completion_pct from territory_scorecard
    where territory_id = '11111111-1111-1111-1111-111111111111' and window_days = 7), 66.7::numeric);
select pg_temp.check('and cancellations are their own rate',
  (select cancelled_pct from territory_scorecard
    where territory_id = '11111111-1111-1111-1111-111111111111' and window_days = 7), 16.7::numeric);
select pg_temp.check('time to assign comes from the status events',
  (select mins_to_assign from territory_scorecard
    where territory_id = '11111111-1111-1111-1111-111111111111' and window_days = 7), 4.0::numeric);

-- ---------------------------------------------------------------------------
-- 2. Thresholds, and the per-city override.
-- ---------------------------------------------------------------------------
select pg_temp.check('a platform default exists',
  (select count(*)::int from scorecard_thresholds where territory_id is null), 1);
select pg_temp.check('and applies to a city with no override of its own',
  (thresholds_for('11111111-1111-1111-1111-111111111111')).min_completion_pct, 90.0::numeric);

-- Lenient on both bars this city would otherwise trip, so "no breach" means
-- what it says rather than "breached something else".
insert into scorecard_thresholds (territory_id, min_completion_pct, max_cancelled_pct)
values ('11111111-1111-1111-1111-111111111111', 50, 20);
select pg_temp.check('an override wins where one exists',
  (thresholds_for('11111111-1111-1111-1111-111111111111')).min_completion_pct, 50.0::numeric);
select pg_temp.check('and another city still gets the default',
  (thresholds_for('22222222-2222-2222-2222-222222222222')).min_completion_pct, 90.0::numeric);

-- 66.7% completion clears an override of 50 but not the default of 90.
select pg_temp.check('no breach against the lenient override',
  scorecard_breaches('11111111-1111-1111-1111-111111111111'), '{}'::text[]);
update scorecard_thresholds set min_completion_pct = 95
 where territory_id = '11111111-1111-1111-1111-111111111111';
select pg_temp.check('a breach is named once the bar is raised',
  (select array_length(scorecard_breaches('11111111-1111-1111-1111-111111111111'), 1)) > 0, true);

-- ---------------------------------------------------------------------------
-- 3. Alerts, and that a standing condition does not spam.
-- ---------------------------------------------------------------------------
insert into merchants (id, name, slug, pickup_lat, pickup_lng, webhook_url)
values ('d0000000-0000-0000-0000-000000000001', 'A restaurant', 'a-restaurant',
        10.3157, 123.8854, 'https://example.invalid/hook');
insert into merchant_webhook_deliveries (merchant_id, order_id, event, payload, status, attempts, last_error)
values ('d0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
        'order.created', '{}'::jsonb, 'pending', 4, 'connection refused');

insert into commission_ledger (rider_id, order_id, amount, business_day, territory_id)
values ('b0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002',
        5000, current_date, '11111111-1111-1111-1111-111111111111');

update orders set created_at = now() - interval '25 minutes'
 where id = 'e0000000-0000-0000-0000-000000000006';

select generate_alerts() as first_run \gset
select pg_temp.check('the sweep raises alerts', (:'first_run'::int > 0), true);

select pg_temp.check('a city with nobody online is flagged',
  (select count(*)::int from alerts where kind = 'no_riders_online'
    and territory_id = '22222222-2222-2222-2222-222222222222'), 1);
select pg_temp.check('an order nobody has taken is flagged',
  (select count(*)::int from alerts where kind = 'order_unassigned'), 1);
select pg_temp.check('a rider over the float limit is flagged',
  (select count(*)::int from alerts where kind = 'cod_over_limit'), 1);
select pg_temp.check('failing callbacks are flagged',
  (select count(*)::int from alerts where kind = 'webhook_failing'), 1);
select pg_temp.check('a scorecard breach is flagged',
  (select count(*)::int from alerts where kind = 'scorecard_breach'), 1);

select generate_alerts();
select pg_temp.check('running again does not duplicate a standing condition',
  (select count(*)::int from alerts where kind = 'order_unassigned'), 1);

-- ---------------------------------------------------------------------------
-- 4. Acknowledging closes it, and lets it recur.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000005', true);
set local role authenticated;

select id as alert_id from alerts where kind = 'order_unassigned' limit 1 \gset
select acknowledge_alert(:'alert_id');
select pg_temp.check('acknowledging closes it',
  (select acknowledged_at is not null from alerts where id = :'alert_id'), true);
select pg_temp.check('and records who',
  (select acknowledged_by from alerts where id = :'alert_id'),
  'a0000000-0000-0000-0000-000000000005'::uuid);

reset role;
set local role service_role;
select generate_alerts();
select pg_temp.check('the same condition can alert again once closed',
  (select count(*)::int from alerts where kind = 'order_unassigned'), 2);
select pg_temp.check('but only one of them is open',
  (select count(*)::int from alerts where kind = 'order_unassigned' and acknowledged_at is null), 1);

-- ---------------------------------------------------------------------------
-- 5. An operator sees only their own city's alerts.
-- ---------------------------------------------------------------------------
insert into profiles (id, role, full_name, territory_id)
values ('a0000000-0000-0000-0000-000000000001', 'admin', 'Cebu operator',
        '11111111-1111-1111-1111-111111111111')
on conflict (id) do update set role = excluded.role, territory_id = excluded.territory_id;

reset role;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.check('an operator sees none of another city''s alerts',
  (select count(*)::int from alerts where territory_id = '22222222-2222-2222-2222-222222222222'), 0);
select pg_temp.check('but does see their own',
  (select count(*)::int from alerts
    where territory_id = '11111111-1111-1111-1111-111111111111') > 0, true);

do $$
begin
  begin
    perform acknowledge_alert((select id from alerts
      where territory_id = '22222222-2222-2222-2222-222222222222' limit 1));
    raise exception 'FAIL an operator acknowledged another city''s alert';
  exception
    when insufficient_privilege then raise notice 'ok  an operator cannot acknowledge another city''s alert';
    when no_data_found then raise notice 'ok  an operator cannot even see another city''s alert to acknowledge it';
  end;
end $$;

reset role;
rollback;
