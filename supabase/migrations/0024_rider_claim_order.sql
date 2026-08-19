-- Let an approved rider claim an order from the pool.
--
-- orders_rider_update only allows updates where rider_id already equals the
-- rider (for advancing their own orders). A pending, unassigned order has
-- rider_id = NULL, so that policy's USING is false and the accept update
-- matched zero rows — riders could never accept from the pool. Add a claim
-- policy: a rider may update a pending, unassigned order as long as the new row
-- assigns it to themselves.
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
  )
  with check (rider_id = current_rider_id());
