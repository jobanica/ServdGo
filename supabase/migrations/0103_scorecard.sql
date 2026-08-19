-- ServdGo — how each city is actually running.
--
-- A materialised view rather than a live one: every number here is an aggregate
-- over the whole order history, and the franchisor's screen should not make the
-- customer app's database do that work on every page load. Refreshed on a
-- schedule; `refreshed_at` is on the view so the screen can say how stale it is
-- instead of implying it is live.
--
-- Two definitions worth stating, because they are judgement calls rather than
-- facts:
--
--   * "Unremitted COD" is the unsettled commission ledger — in this model the
--     rider collects everything at the door, so what they have not settled is
--     the float the operator is carrying.
--   * "Remittance variance" compares what a rider declared they were paying
--     against what their ledger said they owed up to that day. Riders type the
--     amount themselves, so a gap is either a mistake or something worse; a
--     peso of tolerance keeps rounding out of it.

alter table platform_settings
  add column if not exists cod_float_limit numeric(12, 2) not null default 3000;

alter table territories
  add column if not exists cod_float_limit numeric(12, 2);

comment on column territories.cod_float_limit is
  'Per-city override of the platform COD float limit. Null uses the platform default.';

create materialized view territory_scorecard as
with span as (
  select id as territory_id, name,
         (now() at time zone 'Asia/Manila')::date as today
    from territories
),
o as (
  select t.territory_id, t.name, o.id, o.status, o.created_at, o.delivered_at,
         (o.created_at at time zone 'Asia/Manila')::date as day,
         (select min(e.created_at) from order_status_events e
           where e.order_id = o.id and e.status = 'accepted')   as accepted_at,
         (select min(e.created_at) from order_status_events e
           where e.order_id = o.id and e.status = 'picked_up')  as picked_at
    from orders o
    join span t on t.territory_id = o.territory_id
   where o.created_at >= now() - interval '30 days'
),
windowed as (
  select territory_id, name,
         case when created_at >= now() - interval '7 days' then 7 else 30 end as win,
         status, created_at, delivered_at, accepted_at, picked_at
    from o
),
paired as (
  select territory_id, name, 7 as win, status, created_at, delivered_at, accepted_at, picked_at
    from windowed where win = 7
  union all
  select territory_id, name, 30, status, created_at, delivered_at, accepted_at, picked_at
    from windowed
),
agg as (
  select
    territory_id, name, win,
    count(*)                                                        as orders,
    count(*) filter (where status = 'delivered')                    as delivered,
    count(*) filter (where status = 'cancelled')                    as cancelled,
    round(avg(extract(epoch from (accepted_at - created_at)) / 60)::numeric, 1)  as mins_to_assign,
    round(avg(extract(epoch from (picked_at - accepted_at)) / 60)::numeric, 1)   as mins_to_pickup,
    round(avg(extract(epoch from (delivered_at - picked_at)) / 60)::numeric, 1)  as mins_to_deliver
  from paired
  group by 1, 2, 3
)
select
  a.territory_id,
  a.name as territory_name,
  a.win  as window_days,
  a.orders,
  a.delivered,
  a.cancelled,
  a.mins_to_assign,
  a.mins_to_pickup,
  a.mins_to_deliver,
  case when a.orders = 0 then null
       else round(100.0 * a.delivered / a.orders, 1) end as completion_pct,
  case when a.orders = 0 then null
       else round(100.0 * a.cancelled / a.orders, 1) end as cancelled_pct,
  -- Decline rate: declines raised against orders offered in the window.
  case when a.orders = 0 then null else round(100.0 * (
    select count(*) from rider_request_events re
      join orders o2 on o2.id = re.order_id
     where o2.territory_id = a.territory_id and re.kind = 'declined'
       and re.created_at >= now() - (a.win || ' days')::interval
  ) / a.orders, 1) end as decline_pct,
  -- The float the operator is carrying: commission collected at the door and
  -- not yet handed over. Not windowed — what is outstanding is outstanding.
  (select coalesce(sum(cl.amount), 0)::numeric(12, 2) from commission_ledger cl
    where cl.territory_id = a.territory_id and not cl.settled) as unremitted_cod,
  (select count(*) from settlements s
    where s.territory_id = a.territory_id and s.status = 'pending') as pending_remittances,
  (select count(*) from settlements s
    where s.territory_id = a.territory_id
      and s.status = 'confirmed'
      and abs(s.amount_due - coalesce((
            select sum(cl.amount) from commission_ledger cl
             where cl.rider_id = s.rider_id and cl.business_day <= s.business_day and cl.settled
          ), 0)) > 1) as variance_remittances,
  now() as refreshed_at
from agg a;

create unique index territory_scorecard_key on territory_scorecard (territory_id, window_days);
create index territory_scorecard_win on territory_scorecard (window_days);

comment on materialized view territory_scorecard is
  'Rolling 7 and 30 day operating metrics per city. Refreshed on a schedule — read refreshed_at before trusting it as live.';

-- ---------------------------------------------------------------------------
-- Thresholds: a platform default with a per-city override, so one struggling
-- city can be given room without loosening the bar for everyone.
-- ---------------------------------------------------------------------------
create table scorecard_thresholds (
  -- Null territory_id is the platform default row.
  territory_id           uuid references territories (id) on delete cascade,
  max_mins_to_assign     numeric(6, 1) not null default 10,
  max_mins_to_deliver    numeric(6, 1) not null default 45,
  min_completion_pct     numeric(5, 1) not null default 90,
  max_cancelled_pct      numeric(5, 1) not null default 8,
  max_decline_pct        numeric(5, 1) not null default 30,
  updated_at             timestamptz not null default now()
);

create unique index scorecard_thresholds_default on scorecard_thresholds ((territory_id is null))
  where territory_id is null;
create unique index scorecard_thresholds_territory on scorecard_thresholds (territory_id)
  where territory_id is not null;

insert into scorecard_thresholds (territory_id) values (null);

/** The thresholds in force for a city: its own row, else the platform default. */
create or replace function thresholds_for(p_territory uuid)
returns scorecard_thresholds
language sql
stable
security definer
set search_path = public
as $$
  select * from scorecard_thresholds
   where territory_id is not distinct from p_territory
   union all
  select * from scorecard_thresholds where territory_id is null
   order by 1 nulls last
   limit 1;
$$;
revoke all on function thresholds_for(uuid) from public;
grant execute on function thresholds_for(uuid) to authenticated;

/** Which thresholds a city is breaching over 7 days, as a readable list. */
create or replace function scorecard_breaches(p_territory uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s territory_scorecard;
  th scorecard_thresholds;
  out text[] := '{}';
begin
  select * into s from territory_scorecard
   where territory_id = p_territory and window_days = 7;
  if s.territory_id is null or coalesce(s.orders, 0) = 0 then
    return out;   -- no traffic is not a breach
  end if;
  th := thresholds_for(p_territory);

  if s.mins_to_assign  > th.max_mins_to_assign  then out := out || format('slow to assign (%s min)', s.mins_to_assign); end if;
  if s.mins_to_deliver > th.max_mins_to_deliver then out := out || format('slow to deliver (%s min)', s.mins_to_deliver); end if;
  if s.completion_pct  < th.min_completion_pct  then out := out || format('completion %s%%', s.completion_pct); end if;
  if s.cancelled_pct   > th.max_cancelled_pct   then out := out || format('cancelled %s%%', s.cancelled_pct); end if;
  if s.decline_pct     > th.max_decline_pct     then out := out || format('declines %s%%', s.decline_pct); end if;
  return out;
end;
$$;
revoke all on function scorecard_breaches(uuid) from public;
grant execute on function scorecard_breaches(uuid) to authenticated;

create or replace function refresh_scorecard()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Concurrently, so the franchisor's screen is never blocked by the refresh.
  refresh materialized view concurrently territory_scorecard;
exception when others then
  refresh materialized view territory_scorecard;   -- first run has nothing to be concurrent with
end;
$$;
revoke all on function refresh_scorecard() from public;
grant execute on function refresh_scorecard() to service_role, authenticated;

grant select on territory_scorecard to authenticated;
grant select on scorecard_thresholds to authenticated;
grant all on scorecard_thresholds to service_role;
alter table scorecard_thresholds enable row level security;

create policy thresholds_read on scorecard_thresholds
  for select using (is_franchisor() or territory_id is null or staff_sees(territory_id));
create policy thresholds_franchisor_write on scorecard_thresholds
  for all using (is_franchisor()) with check (is_franchisor());
