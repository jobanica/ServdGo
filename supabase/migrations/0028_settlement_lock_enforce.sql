-- Enforce the daily settlement lock at the database, not just in the app.
--
-- A rider with any unsettled commission from a business day BEFORE today
-- (Philippine time) may not accept new orders — i.e. if they didn't settle by
-- end of day, at 00:00 the next day their account can't claim orders. This is
-- evaluated live from the ledger, so it locks automatically at midnight and
-- unlocks the moment the balance is settled (admin-confirmed). No cron needed.

-- Make the overdue-balance helper reliable inside RLS (bypass ledger RLS; it
-- still filters strictly by the rider id it is passed).
create or replace function rider_overdue_balance(p_rider_id uuid, p_today date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)
  from commission_ledger
  where rider_id = p_rider_id and settled = false and business_day < p_today;
$$;

-- Rebuild the claim policy to also require a clear overdue balance.
drop policy if exists orders_rider_claim on orders;
create policy orders_rider_claim on orders
  for update
  using (
    rider_id is null
    and status = 'pending'
    and current_rider_id() is not null
    and exists (
      select 1 from riders r
      where r.id = current_rider_id() and r.application_status = 'approved'
    )
    and rider_overdue_balance(current_rider_id(), (now() at time zone 'Asia/Manila')::date) = 0
  )
  with check (rider_id = current_rider_id());
