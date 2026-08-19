-- When a rider went on duty.
--
-- `is_online` says whether a rider is available right now, but not since when —
-- so the admin dashboard can't tell a rider who started an hour ago from one
-- who left the toggle on overnight. Stamp the transition.
--
-- A trigger rather than a change to set_rider_online, because is_online is
-- flipped from several places (the rider's own toggle, suspension, admin
-- tools) and all of them should keep this column honest.
alter table riders
  add column if not exists online_since timestamptz;

create or replace function stamp_rider_online_since()
returns trigger
language plpgsql
as $$
begin
  if new.is_online is distinct from old.is_online then
    new.online_since := case when new.is_online then now() else null end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_rider_online_since on riders;
create trigger trg_rider_online_since
  before update on riders
  for each row
  execute function stamp_rider_online_since();

-- Riders already online have no start time on record; count from now so the
-- dashboard shows "just now" instead of a blank.
update riders set online_since = now() where is_online and online_since is null;
