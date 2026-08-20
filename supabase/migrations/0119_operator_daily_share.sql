-- ServdGo — when the franchisor holds the money, the franchisor owes the city.
--
-- 0118 moved the commission out of the rider's pocket and into a wallet funded
-- through the franchisor's account. That is convenient for everyone and quietly
-- reverses the direction of the whole franchise: yesterday the operator
-- collected the commission and paid the franchisor a royalty on it; today the
-- franchisor collects it and owes the operator the rest.
--
-- So the royalty ledger is not wrong, it is just already paid. A royalty booked
-- off a wallet-funded commission is marked settled the moment it is booked —
-- the franchisor is holding it — and the operator's 70% becomes an entry here,
-- on the day it was earned.
--
-- Two things can land on that day's total:
--
--   share            + the operator's part of a commission the franchisor holds
--   topup_collected  - a top-up the city office took in cash, which is float
--                      the franchisor is owed rather than money it holds
--
-- Net them and you have the one number this migration exists to produce: what
-- the franchisor pays that city today. It can be negative, which simply means
-- the city took in more cash than it earned in shares and owes the difference.

-- ---------------------------------------------------------------------------
-- The payment itself.
-- ---------------------------------------------------------------------------
create table operator_payouts (
  id            uuid primary key default gen_random_uuid(),
  territory_id  uuid not null references territories (id),
  period_start  date not null,
  period_end    date not null,

  amount        numeric(12, 2) not null,
  method        text,
  reference     text,
  receipt_url   text,
  note          text,

  status        text not null default 'paid' check (status in ('paid', 'void')),
  -- Plain uuids: a payment record must outlive the account that made it (0110).
  paid_by       uuid,
  paid_at       timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  unique (territory_id, period_start, period_end),
  constraint operator_payouts_period check (period_end >= period_start)
);
create index operator_payouts_territory_idx on operator_payouts (territory_id, period_end desc);

comment on table operator_payouts is
  'What the franchisor actually paid a city, and when. The amount owed lives on operator_payout_ledger.';

-- ---------------------------------------------------------------------------
-- The entries it pays off.
-- ---------------------------------------------------------------------------
create table operator_payout_ledger (
  id            uuid primary key default gen_random_uuid(),
  territory_id  uuid not null references territories (id),
  business_day  date not null,

  kind          text not null
                  check (kind in ('share', 'topup_collected', 'adjustment')),

  rider_id      uuid references riders (id) on delete set null,
  order_id      uuid references orders (id) on delete set null,
  source_royalty_id uuid references royalty_ledger (id) on delete set null,
  topup_id      uuid references wallet_topups (id) on delete set null,

  gross_amount   numeric(12, 2) not null default 0,
  royalty_amount numeric(12, 2) not null default 0,
  -- Signed, from the franchisor's side: positive is owed to the city.
  amount        numeric(12, 2) not null,

  note          text,
  paid          boolean not null default false,
  payout_id     uuid references operator_payouts (id),
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index operator_payout_ledger_day_idx on operator_payout_ledger (territory_id, business_day);
create index operator_payout_ledger_unpaid_idx on operator_payout_ledger (territory_id, paid);
create unique index operator_payout_ledger_royalty_uniq
  on operator_payout_ledger (source_royalty_id) where source_royalty_id is not null;
create unique index operator_payout_ledger_topup_uniq
  on operator_payout_ledger (topup_id) where topup_id is not null;

comment on table operator_payout_ledger is
  'What the franchisor owes each city and why, one entry per commission it collected and per top-up the city collected for it.';

-- ---------------------------------------------------------------------------
-- A royalty on money the franchisor already has is not a debt to chase.
-- ---------------------------------------------------------------------------
create or replace function royalty_settled_when_prepaid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source_ledger_id is not null
     and exists (select 1 from rider_wallet_entries e
                  where e.source_ledger_id = new.source_ledger_id) then
    new.settled := true;
    new.note := coalesce(new.note, 'Collected from the rider''s wallet');
  end if;
  return new;
end;
$$;

drop trigger if exists royalty_ledger_prepaid on royalty_ledger;
create trigger royalty_ledger_prepaid
  before insert on royalty_ledger
  for each row
  execute function royalty_settled_when_prepaid();

/** The other side of the same peso: what is left over belongs to the city. */
create or replace function book_operator_share()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_net numeric(12, 2);
begin
  if new.source_ledger_id is null then
    return null;                              -- a joining fee or a manual entry
  end if;
  if not exists (select 1 from rider_wallet_entries e
                  where e.source_ledger_id = new.source_ledger_id) then
    return null;                              -- the operator collected this one themselves
  end if;

  v_net := round(new.base_amount - new.amount, 2);
  if v_net = 0 then
    return null;
  end if;

  insert into operator_payout_ledger (territory_id, business_day, kind, rider_id, order_id,
                                      source_royalty_id, gross_amount, royalty_amount, amount, note)
  values (new.territory_id, new.business_day, 'share', new.rider_id, new.order_id,
          new.id, new.base_amount, new.amount, v_net,
          'Commission collected through the rider wallet')
  on conflict (source_royalty_id) where source_royalty_id is not null do nothing;

  return null;
end;
$$;

drop trigger if exists royalty_ledger_operator_share on royalty_ledger;
create trigger royalty_ledger_operator_share
  after insert on royalty_ledger
  for each row
  execute function book_operator_share();

/**
 * A top-up the city office took in cash never reached the franchisor, so it
 * comes off what the franchisor pays them.
 */
create or replace function book_topup_collected_by_operator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'paid' or new.collected_by <> 'operator' or new.territory_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'paid' then
    return null;
  end if;

  insert into operator_payout_ledger (territory_id, business_day, kind, rider_id,
                                      topup_id, amount, note)
  values (new.territory_id, business_today(new.territory_id), 'topup_collected',
          new.rider_id, new.id, -new.amount,
          'Top-up taken in ' || new.channel || ' at the city office (' || new.reference || ')')
  on conflict (topup_id) where topup_id is not null do nothing;

  return null;
end;
$$;

drop trigger if exists wallet_topups_operator_float on wallet_topups;
create trigger wallet_topups_operator_float
  after insert or update of status on wallet_topups
  for each row
  execute function book_topup_collected_by_operator();

-- ---------------------------------------------------------------------------
-- Reading the day.
-- ---------------------------------------------------------------------------

/**
 * The daily record: one line per city per day, what it is made of, and whether
 * it has been paid. Defaults to the last thirty days.
 */
create or replace function operator_daily_share(
  p_territory uuid default null,
  p_from date default null,
  p_to date default null)
returns table (
  territory_id   uuid,
  territory_name text,
  business_day   date,
  deliveries     bigint,
  gross          numeric,
  royalty        numeric,
  share          numeric,
  topups_collected numeric,
  net            numeric,
  paid           numeric,
  unpaid         numeric,
  payout_id      uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select l.territory_id,
         t.name,
         l.business_day,
         count(*) filter (where l.kind = 'share'),
         coalesce(sum(l.gross_amount), 0)::numeric(12, 2),
         coalesce(sum(l.royalty_amount), 0)::numeric(12, 2),
         coalesce(sum(l.amount) filter (where l.kind = 'share'), 0)::numeric(12, 2),
         coalesce(-sum(l.amount) filter (where l.kind = 'topup_collected'), 0)::numeric(12, 2),
         coalesce(sum(l.amount), 0)::numeric(12, 2),
         coalesce(sum(l.amount) filter (where l.paid), 0)::numeric(12, 2),
         coalesce(sum(l.amount) filter (where not l.paid), 0)::numeric(12, 2),
         (array_agg(l.payout_id) filter (where l.payout_id is not null))[1]
    from operator_payout_ledger l
    join territories t on t.id = l.territory_id
   where staff_sees(l.territory_id)
     and (p_territory is null or l.territory_id = p_territory)
     and l.business_day >= coalesce(p_from, business_today(l.territory_id) - 30)
     and l.business_day <= coalesce(p_to, business_today(l.territory_id))
   group by l.territory_id, t.name, l.business_day
   order by l.business_day desc, t.name;
$$;
revoke all on function operator_daily_share(uuid, date, date) from public;
grant execute on function operator_daily_share(uuid, date, date) to authenticated;

/** What is still owed to a city, all days together. */
create or replace function operator_payout_balance(p_territory uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric(12, 2)
    from operator_payout_ledger
   where not paid
     and staff_sees(territory_id)
     and (p_territory is null or territory_id = p_territory);
$$;
revoke all on function operator_payout_balance(uuid) from public;
grant execute on function operator_payout_balance(uuid) to authenticated;

/** Every city's outstanding balance on one screen — the franchisor's morning. */
create or replace function franchisor_payout_queue(p_day date default null)
returns table (
  territory_id   uuid,
  territory_name text,
  oldest_day     date,
  days_owed      bigint,
  unpaid         numeric,
  today_net      numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select l.territory_id, t.name,
         min(l.business_day) filter (where not l.paid),
         count(distinct l.business_day) filter (where not l.paid),
         coalesce(sum(l.amount) filter (where not l.paid), 0)::numeric(12, 2),
         coalesce(sum(l.amount) filter (
           where l.business_day = coalesce(p_day, business_today(l.territory_id))), 0)::numeric(12, 2)
    from operator_payout_ledger l
    join territories t on t.id = l.territory_id
   where is_franchisor()
   group by l.territory_id, t.name
  having coalesce(sum(l.amount) filter (where not l.paid), 0) <> 0
   order by min(l.business_day) filter (where not l.paid) nulls last;
$$;
revoke all on function franchisor_payout_queue(date) from public;
grant execute on function franchisor_payout_queue(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Paying it.
-- ---------------------------------------------------------------------------
create or replace function franchisor_pay_operator(
  p_territory   uuid,
  p_from        date,
  p_to          date default null,
  p_method      text default null,
  p_reference   text default null,
  p_receipt_url text default null,
  p_note        text default null)
returns operator_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_to     date := coalesce(p_to, p_from);
  v_amount numeric(12, 2);
  v_row    operator_payouts;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor pays a city its share'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from territories where id = p_territory) then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;
  if v_to < p_from then
    raise exception 'The period ends before it starts' using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_amount
    from operator_payout_ledger
   where territory_id = p_territory and not paid and business_day <= v_to;

  if v_amount = 0 then
    raise exception 'There is nothing outstanding for that period'
      using errcode = 'check_violation';
  end if;

  insert into operator_payouts (territory_id, period_start, period_end, amount, method,
                                reference, receipt_url, note, paid_by)
  values (p_territory, p_from, v_to, v_amount, nullif(btrim(p_method), ''),
          nullif(btrim(p_reference), ''), nullif(btrim(p_receipt_url), ''),
          nullif(btrim(p_note), ''), auth.uid())
  on conflict (territory_id, period_start, period_end) do update
    set amount = excluded.amount, method = excluded.method, reference = excluded.reference,
        receipt_url = excluded.receipt_url, note = excluded.note,
        status = 'paid', paid_by = excluded.paid_by, paid_at = now()
  returning * into v_row;

  -- Everything up to the end of the period, not just inside it: one payment
  -- should not leave an older peso hanging, the same rule the royalty
  -- settlements already follow.
  update operator_payout_ledger
     set paid = true, payout_id = v_row.id
   where territory_id = p_territory and not paid and business_day <= v_to;

  perform log_action('operator.payout.paid', 'territory', p_territory::text, p_territory,
                     jsonb_build_object('amount', v_amount, 'from', p_from, 'to', v_to,
                                        'method', v_row.method, 'reference', v_row.reference));
  return v_row;
end;
$$;
revoke all on function franchisor_pay_operator(uuid, date, date, text, text, text, text) from public;
grant execute on function franchisor_pay_operator(uuid, date, date, text, text, text, text) to authenticated;

/** A correction on what a city is owed, in either direction, with a reason. */
create or replace function franchisor_adjust_operator_share(
  p_territory uuid, p_amount numeric, p_note text, p_day date default null)
returns operator_payout_ledger
language plpgsql
security definer
set search_path = public
as $$
declare v_row operator_payout_ledger;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can adjust a city''s share'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'An adjustment of nothing is not an adjustment'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Say why' using errcode = 'check_violation';
  end if;

  insert into operator_payout_ledger (territory_id, business_day, kind, amount, note, created_by)
  values (p_territory, coalesce(p_day, business_today(p_territory)), 'adjustment',
          round(p_amount, 2), btrim(p_note), auth.uid())
  returning * into v_row;

  perform log_action('operator.share.adjusted', 'territory', p_territory::text, p_territory,
                     jsonb_build_object('amount', v_row.amount, 'note', v_row.note));
  return v_row;
end;
$$;
revoke all on function franchisor_adjust_operator_share(uuid, numeric, text, date) from public;
grant execute on function franchisor_adjust_operator_share(uuid, numeric, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Who may see it. A city sees its own money; only the franchisor writes.
-- ---------------------------------------------------------------------------
alter table operator_payouts enable row level security;
alter table operator_payout_ledger enable row level security;

create policy operator_payouts_read on operator_payouts
  for select using (staff_sees(territory_id));
create policy operator_payout_ledger_read on operator_payout_ledger
  for select using (staff_sees(territory_id));

grant select on operator_payouts to authenticated;
grant select on operator_payout_ledger to authenticated;
grant all on operator_payouts to service_role;
grant all on operator_payout_ledger to service_role;

select hq_attach_readonly_guards();

-- ---------------------------------------------------------------------------
-- Unwinding one.
--
-- 0108 refuses to cancel a delivered order once its commission has been
-- settled, because in cash mode the money has changed hands twice over and
-- unwinding it is a refund somebody has to make in person. Through a wallet it
-- is not: the franchisor is holding the money, so it can simply be handed back.
--
-- Handing it back means all three sides move together — the rider's balance,
-- the franchisor's royalty on it, and the city's share of it — or the reversal
-- is just a discount somebody paid for.
-- ---------------------------------------------------------------------------
create unique index rider_wallet_entries_refund_uniq
  on rider_wallet_entries (order_id) where kind = 'refund';

create or replace function wallet_refund_order(p_order uuid, p_reason text)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider     uuid;
  v_territory uuid;
  v_day       date;
  v_total     numeric(12, 2);
  r           record;
begin
  select coalesce(-sum(e.amount), 0),
         (array_agg(e.rider_id))[1],
         (array_agg(e.territory_id) filter (where e.territory_id is not null))[1]
    into v_total, v_rider, v_territory
    from rider_wallet_entries e
   where e.order_id = p_order
     and e.source_ledger_id is not null
     and e.kind in ('commission', 'markup', 'adjustment');

  if coalesce(v_total, 0) = 0 or v_rider is null then
    return 0;
  end if;
  if exists (select 1 from rider_wallet_entries
              where order_id = p_order and kind = 'refund') then
    return 0;                                   -- already given back
  end if;

  v_day := business_today(v_territory);

  insert into rider_wallet_entries (rider_id, territory_id, kind, amount, business_day,
                                    order_id, note, created_by)
  values (v_rider, v_territory, 'refund', v_total, v_day, p_order,
          coalesce(nullif(btrim(p_reason), ''), 'Order reversed'), auth.uid());

  -- The franchisor gives back the royalty it took on it...
  for r in
    select ry.* from royalty_ledger ry
      join commission_ledger cl on cl.id = ry.source_ledger_id
     where cl.order_id = p_order and ry.kind = 'royalty'
  loop
    insert into royalty_ledger (territory_id, rider_id, order_id, kind, base_amount,
                                rate, amount, business_day, note, settled)
    values (r.territory_id, r.rider_id, r.order_id, 'adjustment', -r.base_amount,
            r.rate, -r.amount, v_day,
            'Reversed: ' || coalesce(nullif(btrim(p_reason), ''), 'order cancelled'), true);

    -- ...and the city gives back its share of it.
    insert into operator_payout_ledger (territory_id, business_day, kind, rider_id, order_id,
                                        gross_amount, royalty_amount, amount, note)
    values (r.territory_id, v_day, 'adjustment', r.rider_id, r.order_id,
            -r.base_amount, -r.amount, -round(r.base_amount - r.amount, 2),
            'Reversed: ' || coalesce(nullif(btrim(p_reason), ''), 'order cancelled'));
  end loop;

  return v_total;
end;
$$;
revoke all on function wallet_refund_order(uuid, text) from public;
grant execute on function wallet_refund_order(uuid, text) to authenticated, service_role;

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
  v_refunded  numeric(12, 2);
begin
  select status into v_status from orders where id = p_order;
  if v_status = 'cancelled' then
    return;
  end if;

  v_refunded := wallet_refund_order(p_order, 'Cancelled by HQ: ' || btrim(p_reason));

  -- Anything settled in cash is still a refund somebody has to make by hand.
  select count(*) into v_settled
    from commission_ledger cl
   where cl.order_id = p_order
     and cl.settled
     and not exists (select 1 from rider_wallet_entries e where e.source_ledger_id = cl.id);
  if v_settled > 0 then
    raise exception 'The commission on that order has been settled. Refund it rather than cancelling.'
      using errcode = 'check_violation';
  end if;

  -- A wallet-settled row stays: its royalty entry points at it, and the
  -- reversal above is the record of what happened to it.
  delete from commission_ledger cl
   where cl.order_id = p_order
     and not exists (select 1 from royalty_ledger ry where ry.source_ledger_id = cl.id);
  get diagnostics v_removed = row_count;

  update orders set
    status = 'cancelled',
    notes  = coalesce(notes || E'\n', '') || 'Cancelled by HQ: ' || btrim(p_reason)
  where id = p_order;

  insert into order_status_events (order_id, status) values (p_order, 'cancelled');

  perform log_action('hq.order_cancelled', 'order', p_order::text, v_territory,
                     jsonb_build_object('was', v_status, 'reason', btrim(p_reason),
                                        'commission_rows_removed', v_removed,
                                        'wallet_refunded', v_refunded));
end;
$$;
revoke all on function hq_cancel_order(uuid, text) from public;
grant execute on function hq_cancel_order(uuid, text) to authenticated;
