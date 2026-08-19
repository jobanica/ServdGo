-- ServdGo — a city cannot be born live.
--
-- The go-live gate is a BEFORE UPDATE trigger, so it never saw an INSERT. A
-- franchisor could create a territory with status 'live' in one statement and
-- skip the checklist entirely — not maliciously, just by filling in a form.
--
-- Checking the checklist on INSERT would not work either: the checklist is
-- seeded by an AFTER INSERT trigger, so at BEFORE INSERT time there are no rows
-- and "nothing outstanding" is trivially true. The honest rule is simpler — a
-- city is created, then opened. Two steps, and the second one is gated.
--
-- service_role is exempt so that seeding and restores still work.

-- Deliberately NOT security definer: the exemption is decided by current_user,
-- and a definer function reports its owner instead — which would exempt
-- everybody. Same reasoning as the profile role guard in 0012 and the territory
-- operator guard in 0077.
create or replace function guard_born_live()
returns trigger
language plpgsql
as $$
begin
  if new.status::text in ('live', 'suspended')
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'A territory cannot be created as %. Create it, then open it — that is where the checklist is checked.',
      new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger territories_guard_born_live
  before insert on territories
  for each row execute function guard_born_live();
