-- ServdGo — a city that does not pay stops taking new work.
--
-- Suspension already does the right thing operationally: new orders are refused
-- and everything already in the queue is delivered and settled, because the
-- guard is on the insert. What was missing is the trigger for it.
--
-- The sweep only ever touches cities it suspended itself. A franchisor who
-- suspends a city for a reason of their own must not have that undone by a
-- payment landing — so the flag records who did it, and reactivation checks.

alter table territories
  add column if not exists auto_suspended boolean not null default false,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspend_reason text;

comment on column territories.auto_suspended is
  'True only when the overdue sweep suspended this city. A hand suspension is never lifted automatically.';

create or replace function suspend_territory(p_territory uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can suspend a territory'
      using errcode = 'insufficient_privilege';
  end if;
  update territories
     set status = 'suspended',
         auto_suspended = false,
         suspended_at = now(),
         suspend_reason = nullif(btrim(p_reason), ''),
         closed_message = coalesce(nullif(btrim(p_reason), ''), closed_message)
   where id = p_territory;

  perform log_action('territory.suspended', 'territory', p_territory::text, p_territory,
                     jsonb_build_object('by', 'franchisor', 'reason', p_reason));
end;
$$;

/** What a city owes that is genuinely late, ignoring anything still in grace. */
create or replace function territory_overdue_invoices(p_territory uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount_due), 0)::numeric(12, 2)
    from operator_settlements
   where territory_id = p_territory
     and status = 'pending'
     and due_at is not null
     and due_at < current_date;
$$;
revoke all on function territory_overdue_invoices(uuid) from public;
grant execute on function territory_overdue_invoices(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The daily sweep.
-- ---------------------------------------------------------------------------
create or replace function sweep_overdue_territories()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
  n integer := 0;
begin
  for t in
    select ter.id, ter.name, territory_overdue_invoices(ter.id) as owed
      from territories ter
     where ter.status::text = 'live'
       and territory_overdue_invoices(ter.id) > 0
  loop
    update territories
       set status = 'suspended',
           auto_suspended = true,
           suspended_at = now(),
           suspend_reason = 'Automatically suspended — invoice overdue',
           closed_message = 'This area is temporarily closed. Please try again soon.'
     where id = t.id;

    perform log_action('territory.auto_suspended', 'territory', t.id::text, t.id,
                       jsonb_build_object('overdue_amount', t.owed, 'name', t.name));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function sweep_overdue_territories() from public;
grant execute on function sweep_overdue_territories() to service_role;

-- ---------------------------------------------------------------------------
-- Reactivation, on payment.
--
-- Only lifts a suspension the sweep applied, and only once nothing is still
-- overdue — paying one of three late invoices does not reopen the city.
-- ---------------------------------------------------------------------------
create or replace function reactivate_if_paid_up(p_territory uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare t territories;
begin
  select * into t from territories where id = p_territory;
  if t.id is null or t.status::text <> 'suspended' or not t.auto_suspended then
    return false;
  end if;
  if territory_overdue_invoices(p_territory) > 0 then
    return false;
  end if;

  update territories
     set status = 'live',
         auto_suspended = false,
         suspended_at = null,
         suspend_reason = null,
         closed_message = null
   where id = p_territory;

  perform log_action('territory.auto_reactivated', 'territory', p_territory::text, p_territory,
                     jsonb_build_object('name', t.name));
  return true;
end;
$$;
revoke all on function reactivate_if_paid_up(uuid) from public;
grant execute on function reactivate_if_paid_up(uuid) to authenticated, service_role;

-- Confirming a payment now clears the ledger, closes the invoice and reopens the
-- city in one step, so nobody has to remember the last part.
create or replace function franchisor_confirm_royalty_settlement(p_settlement uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
  v_end       date;
  v_status    settlement_status;
  v_cleared   numeric(12, 2);
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can confirm a royalty settlement'
      using errcode = 'insufficient_privilege';
  end if;

  select territory_id, period_end, status
    into v_territory, v_end, v_status
    from operator_settlements where id = p_settlement;

  if v_territory is null then
    raise exception 'No such settlement' using errcode = 'no_data_found';
  end if;
  if v_status = 'confirmed' then
    raise exception 'That settlement is already confirmed' using errcode = 'check_violation';
  end if;

  update royalty_ledger
     set settled = true, operator_settlement_id = p_settlement
   where territory_id = v_territory
     and not settled
     and business_day <= v_end;

  select coalesce(sum(amount), 0) into v_cleared
    from royalty_ledger where operator_settlement_id = p_settlement;

  update operator_settlements
     set status = 'confirmed',
         amount_settled = v_cleared,
         confirmed_by = auth.uid(),
         confirmed_at = now()
   where id = p_settlement;

  perform log_action('invoice.confirmed', 'operator_settlement', p_settlement::text, v_territory,
                     jsonb_build_object('cleared', v_cleared));
  perform reactivate_if_paid_up(v_territory);

  return v_cleared;
end;
$$;
