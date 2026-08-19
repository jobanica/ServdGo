-- ServdGo — the franchisor's view across cities, and the gate a city passes
-- through before it can trade.

-- The role guard from 0012 only ever knew about admins, so it blocks the
-- franchisor from appointing one. Not security definer, for the same reason it
-- never was: it compares current_user, which a definer function would report as
-- its owner.
create or replace function guard_profile_role()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role
     and current_user <> 'service_role'
     and not is_admin()
     and not is_franchisor() then
    raise exception 'only an admin may change a role';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Onboarding an operator.
--
-- Two things have to happen together: the territory names its operator, and the
-- operator's profile is bound to the territory. Doing them separately leaves a
-- window where an operator has admin rights over nothing, or a city claims
-- somebody who cannot see it.
-- ---------------------------------------------------------------------------
create or replace function assign_territory_operator(p_territory uuid, p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can appoint an operator'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from territories where id = p_territory) then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from profiles where id = p_profile) then
    raise exception 'No such profile' using errcode = 'no_data_found';
  end if;

  update profiles set role = 'admin', territory_id = p_territory where id = p_profile;
  update territories set operator_profile_id = p_profile where id = p_territory;
end;
$$;
revoke all on function assign_territory_operator(uuid, uuid) from public;
grant execute on function assign_territory_operator(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Activating a city (decision 5).
--
-- The checks are not ceremony. A city with no boundary routes nothing; a city
-- with no payout details takes riders' commission nowhere; a city with no
-- operator has nobody to owe the royalty. Each of those is only discoverable
-- once real orders are running, which is exactly when it is expensive.
-- ---------------------------------------------------------------------------
create or replace function approve_territory(p_territory uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t territories;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can open a territory'
      using errcode = 'insufficient_privilege';
  end if;

  select * into t from territories where id = p_territory;
  if t.id is null then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;

  if t.operator_profile_id is null then
    raise exception 'Appoint an operator before opening %', t.name
      using errcode = 'check_violation';
  end if;
  if t.service_center_lat is null or t.service_center_lng is null or t.service_radius_km <= 0 then
    raise exception 'Draw the boundary of % before opening it — without a radius nothing routes to it', t.name
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(t.settlement_gcash_number, '')), '') is null
     or nullif(btrim(coalesce(t.settlement_gcash_name, '')), '') is null then
    raise exception 'Set the settlement payout details for % — riders have nowhere to send commission', t.name
      using errcode = 'check_violation';
  end if;

  update territories set status = 'active' where id = p_territory;
end;
$$;
revoke all on function approve_territory(uuid) from public;
grant execute on function approve_territory(uuid) to authenticated;

create or replace function suspend_territory(p_territory uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can suspend a territory'
      using errcode = 'insufficient_privilege';
  end if;
  update territories
     set status = 'suspended',
         closed_message = coalesce(nullif(btrim(p_reason), ''), closed_message)
   where id = p_territory;
end;
$$;
revoke all on function suspend_territory(uuid, text) from public;
grant execute on function suspend_territory(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Every city on one screen: what it did, what it earned, what it owes, and
-- whether it is behind.
--
-- Orders and revenue are windowed by the dates asked for. The balances are not:
-- what a city owes is what it owes, whatever window you happen to be looking
-- through.
-- ---------------------------------------------------------------------------
create or replace function franchisor_overview(p_from date, p_to date)
returns table (
  territory_id      uuid,
  territory_name    text,
  status            territory_status,
  operator_name     text,
  commission_rate   numeric,
  orders_delivered  bigint,
  platform_revenue  numeric,
  royalty_booked    numeric,
  royalty_settled   numeric,
  royalty_due       numeric,
  royalty_overdue   numeric,
  last_settled_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can see across territories'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    t.id,
    t.name,
    t.status,
    p.full_name,
    t.commission_rate,
    (select count(*) from orders o
      where o.territory_id = t.id and o.status = 'delivered'
        and (o.created_at at time zone 'Asia/Manila')::date between p_from and p_to),
    (select coalesce(sum(cl.amount), 0)::numeric(12, 2) from commission_ledger cl
      where cl.territory_id = t.id and cl.business_day between p_from and p_to),
    (select coalesce(sum(r.amount), 0)::numeric(12, 2) from royalty_ledger r
      where r.territory_id = t.id and r.business_day between p_from and p_to),
    (select coalesce(sum(r.amount), 0)::numeric(12, 2) from royalty_ledger r
      where r.territory_id = t.id and r.settled),
    territory_royalty_due(t.id),
    territory_royalty_overdue(t.id, p_to),
    (select max(os.confirmed_at) from operator_settlements os
      where os.territory_id = t.id and os.status = 'confirmed')
  from territories t
  left join profiles p on p.id = t.operator_profile_id
  order by t.name;
end;
$$;
revoke all on function franchisor_overview(date, date) from public;
grant execute on function franchisor_overview(date, date) to authenticated;

-- The same numbers for one city, readable by that city's own operator — they
-- are being billed from them.
create or replace function territory_royalty_summary(p_territory uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not (is_franchisor() or (is_staff() and p_territory = current_territory_id())) then
    raise exception 'That is not your territory' using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'territory', t.id,
    'territoryName', t.name,
    'rate', (select royalty_rate from platform_settings where id = true),
    'cycle', (select royalty_cycle from platform_settings where id = true),
    'platformRevenue', (select coalesce(sum(cl.amount), 0) from commission_ledger cl
                         where cl.territory_id = t.id and cl.business_day between p_from and p_to),
    'royaltyBooked', (select coalesce(sum(r.amount), 0) from royalty_ledger r
                       where r.territory_id = t.id and r.business_day between p_from and p_to),
    'royaltyDue', territory_royalty_due(t.id),
    'royaltyOverdue', territory_royalty_overdue(t.id, p_to),
    'operatorKeeps', (select coalesce(sum(cl.amount), 0) from commission_ledger cl
                       where cl.territory_id = t.id and cl.business_day between p_from and p_to)
                     - (select coalesce(sum(r.amount), 0) from royalty_ledger r
                         where r.territory_id = t.id and r.business_day between p_from and p_to)
  ) into v
  from territories t where t.id = p_territory;

  return v;
end;
$$;
revoke all on function territory_royalty_summary(uuid, date, date) from public;
grant execute on function territory_royalty_summary(uuid, date, date) to authenticated;
