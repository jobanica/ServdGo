-- Enforce the serviceable-area rule in the database, not just the UI.
--
-- A customer-placed order must name an active barangay from service_areas.
-- Staff/admin can still create orders anywhere (phone bookings, corrections),
-- and the rule is skipped entirely while no areas are configured so the app
-- keeps working before setup.

create or replace function enforce_service_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_any int;
begin
  if is_staff() then
    return new;
  end if;

  select count(*) into v_any from service_areas where is_active;
  if v_any = 0 then
    return new;  -- not configured yet — don't block ordering
  end if;

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

  return new;
end;
$$;

drop trigger if exists orders_enforce_service_area on orders;
create trigger orders_enforce_service_area
  before insert on orders
  for each row execute function enforce_service_area();
