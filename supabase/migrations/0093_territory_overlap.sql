-- ServdGo — two cities cannot claim the same ground.
--
-- A territory is a circle here, not a polygon, so overlap is arithmetic rather
-- than geometry: two circles overlap when the distance between their centres is
-- less than the sum of their radii. No PostGIS, no new extension, and it uses
-- the km_between() the routing already trusts.
--
-- If a territory ever needs a real shape, this is the function to replace and
-- PostGIS is the way to do it — but a circle that cannot overlap another circle
-- is the honest version of the rule today, and it is enforced rather than
-- documented.

create or replace function territories_overlap(
  p_lat double precision, p_lng double precision, p_radius_km numeric,
  p_exclude uuid default null
)
returns table (id uuid, name text, overlap_km numeric)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.name,
         round((t.service_radius_km + p_radius_km
                - km_between(t.service_center_lat, t.service_center_lng, p_lat, p_lng))::numeric, 2)
    from territories t
   where t.status::text in ('approved', 'onboarding', 'live', 'suspended')
     and (p_exclude is null or t.id <> p_exclude)
     and t.service_center_lat is not null
     and t.service_center_lng is not null
     and t.service_radius_km > 0
     and p_lat is not null and p_lng is not null and p_radius_km > 0
     and km_between(t.service_center_lat, t.service_center_lng, p_lat, p_lng)
         < (t.service_radius_km + p_radius_km)
   order by 3 desc;
$$;
revoke all on function territories_overlap(double precision, double precision, numeric, uuid) from public;
grant execute on function territories_overlap(double precision, double precision, numeric, uuid) to authenticated;

create or replace function reject_overlapping_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c record;
begin
  if new.service_center_lat is null or new.service_center_lng is null
     or coalesce(new.service_radius_km, 0) <= 0 then
    return new;
  end if;
  -- A terminated city has released its ground; a lead has not claimed any.
  if new.status::text in ('lead', 'applied', 'terminated') then
    return new;
  end if;

  select * into c
    from territories_overlap(new.service_center_lat, new.service_center_lng,
                             new.service_radius_km, new.id)
   limit 1;

  if c.id is not null then
    raise exception
      'That boundary overlaps % by about % km. Shrink one of them or move the centre.',
      c.name, c.overlap_km
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Named to sort after trg_territory_operator_guard: BEFORE triggers fire in name
-- order, and permission has to be decided before geometry. Otherwise an operator
-- who may not touch the boundary at all is told which other city it overlaps.
create trigger trg_territory_overlap_guard
  before insert or update of service_center_lat, service_center_lng, service_radius_km, status
  on territories
  for each row execute function reject_overlapping_territory();
