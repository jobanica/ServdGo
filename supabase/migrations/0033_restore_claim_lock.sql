-- Restore the daily settlement lock on order claims.
--
-- 0031 rebuilt orders_rider_claim to drop the documents requirement but also
-- inadvertently dropped the overdue-balance guard added in 0028. Re-add it so a
-- rider with unsettled commission from a previous business day can't claim new
-- orders until they settle.

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
