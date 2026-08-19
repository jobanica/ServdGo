-- ServdGo — the three things HQ can do to a delivery that nobody else can.
--
-- An operator already has admin_cancel_order() and a rider has release_order().
-- These are the overrides: they work on orders those two refuse to touch, they
-- belong to the franchisor alone, and none of them runs without a reason,
-- because the reason is the only thing the audit trail cannot reconstruct.

/** Guard shared by all three: franchisor, a real order, and a reason given. */
create or replace function hq_override_check(p_order uuid, p_reason text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_territory uuid;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can override a delivery'
      using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'An override needs a reason' using errcode = 'check_violation';
  end if;
  select territory_id into v_territory from orders where id = p_order;
  if not found then
    raise exception 'No such order' using errcode = 'no_data_found';
  end if;
  return v_territory;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Force a reassignment. The rider has to be one who could have taken it —
--    a rider from another city cannot be handed a job they cannot reach.
-- ---------------------------------------------------------------------------
create or replace function hq_reassign_order(p_order uuid, p_rider uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory     uuid := hq_override_check(p_order, p_reason);
  v_old_rider     uuid;
  v_status        order_status;
  v_rider_city    uuid;
  v_old_name      text;
  v_old_contact   text;
begin
  select rider_id, status into v_old_rider, v_status from orders where id = p_order;
  if v_status in ('delivered', 'cancelled') then
    raise exception 'That order is already %, there is nobody to reassign it to', v_status
      using errcode = 'check_violation';
  end if;

  select territory_id into v_rider_city from riders
   where id = p_rider and application_status = 'approved';
  if v_rider_city is null then
    raise exception 'That rider is not approved to take deliveries'
      using errcode = 'check_violation';
  end if;
  if v_territory is not null and v_rider_city is distinct from v_territory then
    raise exception 'That rider works in another city' using errcode = 'check_violation';
  end if;
  if v_old_rider = p_rider then
    raise exception 'That rider already has it' using errcode = 'check_violation';
  end if;

  -- The outgoing rider gets the same record a voluntary transfer would leave,
  -- so the pool stops offering it back to them and their history is honest.
  if v_old_rider is not null then
    select name, mobile_number into v_old_name, v_old_contact from riders where id = v_old_rider;
    insert into rider_request_events (rider_id, order_id, kind, reason, had_goods)
    values (v_old_rider, p_order, 'transferred', btrim(p_reason),
            v_status in ('picked_up', 'on_the_way'))
    on conflict (rider_id, order_id, kind) do update
      set reason = excluded.reason, had_goods = excluded.had_goods, created_at = now();
  end if;

  update orders set
    rider_id = p_rider,
    status   = case when status = 'pending' then 'accepted'::order_status else status end,
    is_transfer              = v_old_rider is not null,
    transferred_at           = case when v_old_rider is not null then now() end,
    transfer_reason          = case when v_old_rider is not null then btrim(p_reason) end,
    transfer_had_goods       = v_old_rider is not null and v_status in ('picked_up', 'on_the_way'),
    transferred_from_name    = v_old_name,
    transferred_from_contact = v_old_contact
  where id = p_order;

  insert into order_status_events (order_id, status)
  select p_order, 'accepted' where v_status = 'pending';

  perform log_action('hq.order_reassigned', 'order', p_order::text, v_territory,
                     jsonb_build_object('from_rider', v_old_rider, 'to_rider', p_rider,
                                        'status', v_status, 'reason', btrim(p_reason)));
end;
$$;
revoke all on function hq_reassign_order(uuid, uuid, text) from public;
grant execute on function hq_reassign_order(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Force a cancellation, including of an order already marked delivered.
--
--    Cancelling a delivered order has to take the rider's commission off the
--    books with it, or they carry a debt for a job that officially never
--    happened. Once that commission has been settled the money has changed
--    hands twice over, and unwinding it is a refund, not a cancellation — so
--    that is refused rather than guessed at.
-- ---------------------------------------------------------------------------
create or replace function hq_cancel_order(p_order uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid := hq_override_check(p_order, p_reason);
  v_status    order_status;
  v_settled   int;
  v_removed   int := 0;
begin
  select status into v_status from orders where id = p_order;
  if v_status = 'cancelled' then
    return;
  end if;

  select count(*) into v_settled from commission_ledger
   where order_id = p_order and settled;
  if v_settled > 0 then
    raise exception 'The commission on that order has been settled. Refund it rather than cancelling.'
      using errcode = 'check_violation';
  end if;

  delete from commission_ledger where order_id = p_order;
  get diagnostics v_removed = row_count;

  update orders set
    status = 'cancelled',
    notes  = coalesce(notes || E'\n', '') || 'Cancelled by HQ: ' || btrim(p_reason)
  where id = p_order;

  insert into order_status_events (order_id, status) values (p_order, 'cancelled');

  perform log_action('hq.order_cancelled', 'order', p_order::text, v_territory,
                     jsonb_build_object('was', v_status, 'reason', btrim(p_reason),
                                        'commission_rows_removed', v_removed));
end;
$$;
revoke all on function hq_cancel_order(uuid, text) from public;
grant execute on function hq_cancel_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Put it back in front of the riders. The declines are cleared too —
--    otherwise re-dispatching offers it to everyone who already said no, which
--    is to say nobody.
-- ---------------------------------------------------------------------------
create or replace function hq_redispatch_order(p_order uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid := hq_override_check(p_order, p_reason);
  v_status    order_status;
  v_rider     uuid;
  v_cleared   int;
begin
  select status, rider_id into v_status, v_rider from orders where id = p_order;
  if v_status in ('delivered', 'cancelled') then
    raise exception 'That order is already %, there is nothing to dispatch', v_status
      using errcode = 'check_violation';
  end if;

  delete from rider_request_events where order_id = p_order and kind = 'declined';
  get diagnostics v_cleared = row_count;

  update orders set rider_id = null, status = 'pending' where id = p_order;
  insert into order_status_events (order_id, status)
  select p_order, 'pending' where v_status <> 'pending';

  perform log_action('hq.order_redispatched', 'order', p_order::text, v_territory,
                     jsonb_build_object('was', v_status, 'off_rider', v_rider,
                                        'declines_cleared', v_cleared,
                                        'reason', btrim(p_reason)));
end;
$$;
revoke all on function hq_redispatch_order(uuid, text) from public;
grant execute on function hq_redispatch_order(uuid, text) to authenticated;
