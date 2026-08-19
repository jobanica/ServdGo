-- ServdGo — HQ raises the invoice, instead of waiting to be told.
--
-- Until now an operator declared what they were paying and the franchisor
-- confirmed it. That works when there is one city and a standing relationship;
-- it does not scale, and it puts the operator in charge of saying what they owe.
--
-- The monthly run inverts it: for every live city, HQ issues an invoice for the
-- period — the fixed franchise fee plus everything outstanding on the royalty
-- ledger — with a due date derived from that city's own grace period. The
-- operator still declares a payment against it and HQ still confirms; what
-- changes is who states the amount.
--
-- The fixed fee goes on the royalty ledger as its own kind rather than living
-- only on the invoice, so "what does this city owe" has exactly one answer.

alter table royalty_ledger drop constraint if exists royalty_ledger_kind_check;
alter table royalty_ledger
  add constraint royalty_ledger_kind_check
  check (kind in ('royalty', 'joining_fee', 'franchise_fee', 'adjustment'));

alter table operator_settlements
  add column if not exists issued_at      timestamptz,
  add column if not exists due_at         date,
  add column if not exists franchise_fee  numeric(12, 2) not null default 0,
  add column if not exists royalty_amount numeric(12, 2) not null default 0,
  add column if not exists issued_by      uuid references profiles (id),
  add column if not exists notes          text;

comment on column operator_settlements.issued_at is
  'Set when HQ raised this as an invoice. Null means the operator declared it unprompted.';
comment on column operator_settlements.due_at is
  'period_end plus the city''s grace_days. Aging and the suspension sweep both read this.';

create index if not exists operator_settlements_due_idx
  on operator_settlements (due_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- A manual credit or charge has to say why.
--
-- An adjustment with no note is a number nobody can explain a year later, which
-- is exactly when someone asks.
-- ---------------------------------------------------------------------------
alter table royalty_ledger
  add constraint royalty_ledger_manual_needs_note
  check (kind not in ('adjustment', 'joining_fee')
         or nullif(btrim(coalesce(note, '')), '') is not null);

create or replace function charge_territory_fee(
  p_territory uuid,
  p_amount numeric,
  p_kind text default 'joining_fee',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can charge a territory'
      using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('joining_fee', 'adjustment') then
    raise exception 'A manual entry must be a joining_fee or an adjustment'
      using errcode = 'check_violation';
  end if;
  if p_amount = 0 then
    raise exception 'A charge of zero is not an entry' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'A manual entry needs a note saying what it is for'
      using errcode = 'check_violation';
  end if;

  insert into royalty_ledger (territory_id, kind, base_amount, rate, amount, business_day, note)
  values (p_territory, p_kind, 0, 0, round(p_amount, 2),
          (now() at time zone 'Asia/Manila')::date, btrim(p_note))
  returning id into v_id;

  perform log_action('royalty.manual_entry', 'royalty_ledger', v_id::text, p_territory,
                     jsonb_build_object('kind', p_kind, 'amount', round(p_amount, 2), 'note', btrim(p_note)));
  return v_id;
end;
$$;
revoke all on function charge_territory_fee(uuid, numeric, text, text) from public;
grant execute on function charge_territory_fee(uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The monthly run.
--
-- Idempotent on (territory, period): running it twice does not double-bill, and
-- re-running after a late royalty lands refreshes the amount as long as nobody
-- has paid it yet.
-- ---------------------------------------------------------------------------
create or replace function generate_invoice(p_territory uuid, p_period_start date, p_period_end date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  t         territories;
  v_fee     numeric(12, 2);
  v_royalty numeric(12, 2);
  v_id      uuid;
  v_status  settlement_status;
begin
  select * into t from territories where id = p_territory;
  if t.id is null then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;

  select status into v_status from operator_settlements
   where territory_id = p_territory and period_start = p_period_start and period_end = p_period_end;
  if v_status = 'confirmed' then
    return null;   -- already paid for; never reopen a settled period
  end if;

  -- The fixed fee becomes a ledger entry, so the ledger remains the one place
  -- that knows what a city owes.
  if coalesce(t.franchise_fee_monthly, 0) > 0 then
    insert into royalty_ledger (territory_id, kind, base_amount, rate, amount, business_day, note)
    select p_territory, 'franchise_fee', 0, 0, t.franchise_fee_monthly, p_period_end,
           'Monthly franchise fee for ' || to_char(p_period_start, 'FMMonth YYYY')
     where not exists (
       select 1 from royalty_ledger
        where territory_id = p_territory and kind = 'franchise_fee' and business_day = p_period_end);
  end if;

  select coalesce(sum(amount) filter (where kind = 'franchise_fee'), 0),
         coalesce(sum(amount) filter (where kind <> 'franchise_fee'), 0)
    into v_fee, v_royalty
    from royalty_ledger
   where territory_id = p_territory and not settled and business_day <= p_period_end;

  if v_fee + v_royalty <= 0 then
    return null;   -- nothing to bill
  end if;

  insert into operator_settlements (
    territory_id, period_start, period_end, amount_due, franchise_fee, royalty_amount,
    status, issued_at, issued_by, due_at)
  values (
    p_territory, p_period_start, p_period_end, v_fee + v_royalty, v_fee, v_royalty,
    'pending', now(), auth.uid(), p_period_end + coalesce(t.grace_days, 7))
  on conflict (territory_id, period_start, period_end) do update
    set amount_due     = excluded.amount_due,
        franchise_fee  = excluded.franchise_fee,
        royalty_amount = excluded.royalty_amount,
        issued_at      = coalesce(operator_settlements.issued_at, excluded.issued_at),
        due_at         = excluded.due_at
  returning id into v_id;

  perform log_action('invoice.issued', 'operator_settlement', v_id::text, p_territory,
                     jsonb_build_object('period', p_period_start || '..' || p_period_end,
                                        'amount', v_fee + v_royalty));
  return v_id;
end;
$$;
revoke all on function generate_invoice(uuid, date, date) from public;
grant execute on function generate_invoice(uuid, date, date) to authenticated, service_role;

/** Every live city, for the period containing the given day. Safe to re-run. */
create or replace function run_monthly_invoicing(p_day date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d       date := coalesce(p_day, (now() at time zone 'Asia/Manila')::date - 1);
  p       record;
  t       record;
  n       integer := 0;
begin
  select * into p from royalty_period(d);
  for t in select id from territories where status::text = 'live' loop
    if generate_invoice(t.id, p.period_start, p.period_end) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function run_monthly_invoicing(date) from public;
grant execute on function run_monthly_invoicing(date) to service_role;

-- ---------------------------------------------------------------------------
-- Aging. Buckets are counted from the due date, not the period end — a city
-- with 14 grace days is not late on day one.
-- ---------------------------------------------------------------------------
create or replace view invoice_aging with (security_invoker = true) as
select s.id, s.territory_id, t.name as territory_name,
       s.period_start, s.period_end, s.due_at,
       s.amount_due, s.franchise_fee, s.royalty_amount, s.status,
       greatest(0, current_date - s.due_at) as days_overdue,
       case
         when s.status = 'confirmed' then 'paid'
         when s.due_at is null or current_date <= s.due_at then 'current'
         when current_date - s.due_at <= 15 then '1-15'
         when current_date - s.due_at <= 30 then '16-30'
         else '30+'
       end as bucket
  from operator_settlements s
  join territories t on t.id = s.territory_id;

grant select on invoice_aging to authenticated;
