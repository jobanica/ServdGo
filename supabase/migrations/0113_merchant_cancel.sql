-- ServdGo — a restaurant can call off an order it booked.
--
-- The merchant API could create a delivery and never take it back, so a
-- partner platform integrating against it had to leave its own cancel button
-- lying: it would report success while a rider was still on the way here.
--
-- Where the line sits: a rider who has collected is carrying somebody's food
-- and is owed the trip, so cancelling stops at pickup. Before that the job is
-- only a job, and dropping it costs nobody anything.

create or replace function merchant_cancel(p_merchant uuid, p_reference text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order  uuid;
  v_status order_status;
begin
  select id, status into v_order, v_status
    from orders
   where merchant_id = p_merchant and merchant_reference = p_reference;
  if v_order is null then
    raise exception 'no such order' using errcode = 'no_data_found';
  end if;

  -- Cancelling twice is the same answer as cancelling once: a retry after a
  -- timeout must not be an error.
  if v_status = 'cancelled' then
    return merchant_order_view(v_order);
  end if;

  if v_status in ('picked_up', 'on_the_way') then
    raise exception 'The rider already has this order. Call them on the number in the status response.'
      using errcode = 'check_violation';
  end if;
  if v_status = 'delivered' then
    raise exception 'That order was already delivered' using errcode = 'check_violation';
  end if;

  update orders set
    status = 'cancelled',
    notes  = coalesce(notes || E'\n', '')
             || 'Cancelled by the restaurant'
             || coalesce(': ' || nullif(btrim(p_reason), ''), '')
   where id = v_order;

  insert into order_status_events (order_id, status) values (v_order, 'cancelled');

  -- Nothing was earned on a trip that did not happen. Commission books on
  -- delivery, so there is normally nothing here — this is the belt to that
  -- brace, and it deliberately refuses to touch a settled row.
  delete from commission_ledger where order_id = v_order and not settled;

  return merchant_order_view(v_order);
end;
$$;
revoke all on function merchant_cancel(uuid, text, text) from public;
grant execute on function merchant_cancel(uuid, text, text) to service_role;
