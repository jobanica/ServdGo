-- ServdGo — coming back is not the same as starting.
--
-- The checklist gate fired on any transition into 'live', including the one the
-- overdue sweep's reactivation makes when an invoice is finally paid. That is
-- wrong in a way that only shows up under stress: a city that has been trading
-- for months pays its bill, and reopening silently fails because a rider was
-- suspended last week and the "three riders approved" item now reads false.
-- The operator has paid and is still shut, for a reason nobody is looking at.
--
-- The checklist answers "is this city ready to trade for the first time". A
-- suspension is a pause on a city that already answered it. So the gate applies
-- to the pre-trading states only, and restoring from suspended is not gated —
-- which also means suspension remains the deliberate, reversible lever it is
-- meant to be rather than a trapdoor.

create or replace function guard_go_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status::text = 'live'
     and old.status::text is distinct from 'live'
     -- Only on the way up from a state that has never traded.
     and old.status::text in ('lead', 'applied', 'approved', 'onboarding') then
    perform refresh_territory_checklist(new.id);
    if not can_go_live(new.id) then
      raise exception '% cannot go live yet — still outstanding: %',
        new.name, coalesce(territory_outstanding_items(new.id), 'unknown')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
