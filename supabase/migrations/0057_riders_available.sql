-- Can anyone actually take this order right now?
--
-- Customers can't read the riders table (RLS, rightly), so the app had no way
-- to know the pool was empty — an order placed with nobody on duty just sat
-- there looking accepted-any-minute. Expose the one number the checkout needs.
--
-- The conditions mirror orders_rider_claim exactly, so "available" means the
-- database would actually let them claim it: approved, not suspended, and no
-- overdue commission. Manual is_locked is deliberately not checked here, for
-- the same reason the claim policy doesn't — otherwise this would refuse
-- customers on behalf of riders the database still allows to take work.
create or replace function riders_available(p_service text default null)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from riders r
  where r.application_status = 'approved'
    and r.is_suspended = false
    and r.is_online
    -- A rider with no services listed accepts everything.
    and (p_service is null
         or r.services_accepted is null
         or array_length(r.services_accepted, 1) is null
         or p_service = any (r.services_accepted))
    and rider_overdue_balance(r.id, (now() at time zone 'Asia/Manila')::date) = 0;
$$;

revoke all on function riders_available(text) from public;
-- Customers may be signed in anonymously, so both roles need it.
grant execute on function riders_available(text) to anon, authenticated;
