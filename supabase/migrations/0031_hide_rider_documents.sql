-- Temporarily disable the rider-documents requirement.
--
-- The documents feature (bucket, columns, set_rider_documents) stays in place,
-- but going online and claiming orders no longer require the three documents,
-- so the upload step can be hidden in the app without locking riders out.

create or replace function set_rider_online(p_online boolean)
returns boolean
language sql
security definer
set search_path = public
as $$
  update riders set is_online = p_online where profile_id = auth.uid()
  returning is_online;
$$;
revoke all on function set_rider_online(boolean) from public;
grant execute on function set_rider_online(boolean) to authenticated;

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
  )
  with check (rider_id = current_rider_id());
