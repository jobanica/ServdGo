-- ServdGo — how a city pays the franchisor.
--
-- Deliberately the same shape as a rider settling with their operator, because
-- the operator already runs that flow from the other side: a period, an amount,
-- a method, a reference, a receipt, and somebody confirming it. Submitting does
-- not clear anything — confirmation does, and only the franchisor confirms.

alter table platform_settings
  add column if not exists royalty_cycle text not null default 'monthly'
    check (royalty_cycle in ('weekly', 'monthly'));

comment on column platform_settings.royalty_cycle is
  'How often a city is expected to settle its royalty with the franchisor.';

create table operator_settlements (
  id             uuid primary key default gen_random_uuid(),
  territory_id   uuid not null references territories (id),
  period_start   date not null,
  period_end     date not null,

  -- What the operator said they were paying, and what confirming it actually
  -- cleared. Keeping both means a shortfall shows up instead of disappearing.
  amount_due     numeric(12, 2) not null,
  amount_settled numeric(12, 2),

  method         text,
  reference      text,
  receipt_url    text,

  status         settlement_status not null default 'pending',
  submitted_by   uuid references profiles (id),
  confirmed_by   uuid references profiles (id),
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),

  unique (territory_id, period_start, period_end),
  constraint operator_settlements_period check (period_end >= period_start),
  constraint operator_settlements_amount check (amount_due >= 0)
);

create index operator_settlements_territory_idx on operator_settlements (territory_id, status);

-- Which payment cleared a given royalty entry.
alter table royalty_ledger
  add column if not exists operator_settlement_id uuid references operator_settlements (id);
create index royalty_ledger_settlement_idx on royalty_ledger (operator_settlement_id);

-- ---------------------------------------------------------------------------
-- The period a date falls in, on the franchisor's cycle.
-- ---------------------------------------------------------------------------
create or replace function royalty_period(p_day date)
returns table (period_start date, period_end date)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when s.royalty_cycle = 'weekly'
         then date_trunc('week', p_day)::date
         else date_trunc('month', p_day)::date end,
    case when s.royalty_cycle = 'weekly'
         then (date_trunc('week', p_day) + interval '6 days')::date
         else (date_trunc('month', p_day) + interval '1 month - 1 day')::date end
  from platform_settings s where s.id = true;
$$;
revoke all on function royalty_period(date) from public;
grant execute on function royalty_period(date) to authenticated;

-- ---------------------------------------------------------------------------
-- The operator declares a payment. Amount is computed here rather than taken on
-- trust: it is everything unsettled up to the end of the period.
-- ---------------------------------------------------------------------------
create or replace function operator_submit_royalty_settlement(
  p_period_start date,
  p_period_end   date,
  p_method       text default null,
  p_reference    text default null,
  p_receipt_url  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
  v_amount    numeric(12, 2);
  v_id        uuid;
begin
  v_territory := current_territory_id();
  if v_territory is null or not (is_admin() or is_franchisor()) then
    raise exception 'Only a city operator can submit a royalty settlement'
      using errcode = 'insufficient_privilege';
  end if;
  if p_period_end < p_period_start then
    raise exception 'The period ends before it starts' using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_amount
    from royalty_ledger
   where territory_id = v_territory
     and not settled
     and business_day <= p_period_end;

  if v_amount <= 0 then
    raise exception 'There is nothing outstanding for that period'
      using errcode = 'check_violation';
  end if;

  insert into operator_settlements (territory_id, period_start, period_end, amount_due,
                                    method, reference, receipt_url, status, submitted_by)
  values (v_territory, p_period_start, p_period_end, v_amount,
          nullif(btrim(p_method), ''), nullif(btrim(p_reference), ''),
          nullif(btrim(p_receipt_url), ''), 'pending', auth.uid())
  on conflict (territory_id, period_start, period_end) do update
    set amount_due   = excluded.amount_due,
        method       = excluded.method,
        reference    = excluded.reference,
        receipt_url  = excluded.receipt_url,
        status       = 'pending',
        confirmed_by = null,
        confirmed_at = null,
        submitted_by = excluded.submitted_by,
        created_at   = now()
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function operator_submit_royalty_settlement(date, date, text, text, text) from public;
grant execute on function operator_submit_royalty_settlement(date, date, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The franchisor confirms it, and only then is anything cleared.
--
-- Clears everything unsettled up to the period end, the same way confirming a
-- rider's payment clears their earlier days: one payment should not leave an
-- older peso hanging.
-- ---------------------------------------------------------------------------
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

  return v_cleared;
end;
$$;
revoke all on function franchisor_confirm_royalty_settlement(uuid) from public;
grant execute on function franchisor_confirm_royalty_settlement(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Is a city behind? Anything unsettled from a period that has already closed.
-- ---------------------------------------------------------------------------
create or replace function territory_royalty_overdue(p_territory uuid, p_today date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(r.amount), 0)::numeric(12, 2)
    from royalty_ledger r
   where r.territory_id = p_territory
     and not r.settled
     and r.business_day < (select period_start from royalty_period(p_today));
$$;
revoke all on function territory_royalty_overdue(uuid, date) from public;
grant execute on function territory_royalty_overdue(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Access. An operator sees and submits their own; the franchisor sees all and
-- is the only one who can confirm.
-- ---------------------------------------------------------------------------
grant select on operator_settlements to authenticated;
grant all on operator_settlements to service_role;
alter table operator_settlements enable row level security;

create policy operator_settlements_read on operator_settlements
  for select using (is_franchisor() or (is_staff() and territory_id = current_territory_id()));

create policy operator_settlements_franchisor_write on operator_settlements
  for all using (is_franchisor()) with check (is_franchisor());
