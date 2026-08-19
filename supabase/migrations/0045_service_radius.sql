-- Deterministic service-area enforcement by distance.
--
-- The barangay dropdown is self-declared and the browser-side reverse-geocode
-- check fails open when the lookup is unavailable, so a pin dropped far outside
-- the service area could still be ordered. Add an operator-set service centre +
-- radius and enforce it on the order itself, in the database.

alter table app_settings
  add column if not exists service_center_lat double precision,
  add column if not exists service_center_lng double precision,
  add column if not exists service_radius_km  numeric(6, 1) not null default 0;  -- 0 = disabled

-- Seed from the operator's own store locations (centre of the pinned stores)
-- with a radius wide enough to cover the surrounding municipalities.
update app_settings s set
  service_center_lat = coalesce(s.service_center_lat, c.clat),
  service_center_lng = coalesce(s.service_center_lng, c.clng),
  service_radius_km  = case when s.service_radius_km > 0 then s.service_radius_km else 25 end
from (
  select avg(lat) clat, avg(lng) clng from stores where lat is not null and lng is not null
) c
where c.clat is not null;

/** Great-circle distance in kilometres. */
create or replace function km_between(lat1 double precision, lng1 double precision,
                                      lat2 double precision, lng2 double precision)
returns double precision
language sql immutable parallel safe as $$
  select 6371 * acos(least(1, greatest(-1,
    cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lng2) - radians(lng1))
    + sin(radians(lat1)) * sin(radians(lat2))
  )));
$$;

-- Extend the service-area guard: the barangay must be served AND the drop-off
-- pin must sit inside the service radius.
create or replace function enforce_service_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_any     int;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  numeric;
  v_km      double precision;
begin
  if is_staff() then
    return new;
  end if;

  select count(*) into v_any from service_areas where is_active;
  if v_any > 0 then
    if new.area_barangay is null or btrim(new.area_barangay) = '' then
      raise exception 'Please choose your delivery area before ordering.'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from service_areas
      where is_active
        and lower(btrim(province)) = lower(btrim(coalesce(new.area_province, '')))
        and lower(btrim(city))     = lower(btrim(coalesce(new.area_city, '')))
        and lower(btrim(barangay)) = lower(btrim(new.area_barangay))
    ) then
      raise exception 'Sorry, we do not deliver to % yet.', new.area_barangay
        using errcode = 'check_violation';
    end if;
  end if;

  -- Distance guard: the pin itself must be inside the service radius.
  select service_center_lat, service_center_lng, service_radius_km
    into v_lat, v_lng, v_radius
  from app_settings limit 1;

  if v_lat is not null and v_lng is not null and coalesce(v_radius, 0) > 0
     and new.delivery_lat is not null and new.delivery_lng is not null then
    v_km := km_between(v_lat, v_lng, new.delivery_lat, new.delivery_lng);
    if v_km > v_radius then
      raise exception 'That drop-off is about % km away, outside our % km delivery area. Please pin a location we serve.',
        round(v_km::numeric, 1), v_radius using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_enforce_service_area on orders;
create trigger orders_enforce_service_area
  before insert on orders
  for each row execute function enforce_service_area();
