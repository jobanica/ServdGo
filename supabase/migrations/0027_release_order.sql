-- Let a rider release an active delivery back to the pool (e.g. their vehicle
-- broke down) so another rider can take it. A rider can't set rider_id back to
-- NULL under orders_rider_update (its WITH CHECK requires the row stay theirs),
-- so expose a narrow SECURITY DEFINER function that only releases an order the
-- caller is currently handling.
create or replace function release_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update orders
    set rider_id = null, status = 'pending'
    where id = p_order_id
      and rider_id = current_rider_id()
      and status not in ('delivered', 'cancelled');
  if not found then
    raise exception 'You can only release an active order you are handling.';
  end if;
  insert into order_status_events (order_id, status) values (p_order_id, 'pending');
end;
$$;

revoke all on function release_order(uuid) from public;
grant execute on function release_order(uuid) to authenticated;
