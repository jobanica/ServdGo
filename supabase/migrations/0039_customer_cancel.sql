-- Let a customer cancel their own order, but only while it is still pending and
-- unassigned (no rider has accepted it yet).
create or replace function cancel_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update orders set status = 'cancelled'
  where id = p_order_id
    and customer_id = current_customer_id()
    and status = 'pending'
    and rider_id is null;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function cancel_order(uuid) from public;
grant execute on function cancel_order(uuid) to authenticated;
