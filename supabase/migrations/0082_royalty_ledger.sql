-- ServdGo — the franchisor's 30%, booked on money that actually arrived.
--
-- Decision 2: the royalty is booked when a rider's settlement is confirmed, not
-- when an order is delivered. A rider who has not settled is holding money the
-- operator does not have, and billing 30% of it would invoice an operator
-- against nothing.
--
-- What "confirmed" means in this schema is precise: confirming a settlement
-- flips commission_ledger.settled from false to true for the days it covers. So
-- the royalty is booked off that transition rather than off the settlements row
-- — it then holds for every path that settles a ledger entry, including a
-- payment that clears several days at once and any future one nobody has
-- written yet.
--
-- Decision 1: the base is all platform revenue. Both kinds already on the
-- ledger qualify — 'commission', and 'markup', which record_commission_on_delivery
-- already stores as the operator's share rather than the whole mark-up — so the
-- base is simply the ledger amount, whatever its kind. Negative adjustments
-- reduce the royalty, which is the behaviour you want.
--
-- No history is backfilled. A fork starts with an empty database, and the
-- franchisor's claim starts when the franchise does.

-- ---------------------------------------------------------------------------
-- Two corrections this depends on.
--
-- 1. record_commission_on_delivery() read markup_operator_share from
--    app_settings, which is now a view resolved from *the caller's* territory.
--    The caller here is a rider marking an order delivered, so with more than
--    one city it would read no territory at all and silently fall back to a 100%
--    operator share — feeding a wrong number straight into the royalty base.
--    Read it from the order's own territory, where it cannot depend on who is
--    asking.
-- ---------------------------------------------------------------------------
create or replace function record_commission_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day   date := (now() at time zone 'Asia/Manila')::date;
  v_share numeric;
  v_owed  numeric;
begin
  if new.status = 'delivered'
     and old.status is distinct from 'delivered'
     and new.rider_id is not null
     and coalesce(new.payment_method, 'cod') in ('cod', 'rider_qr') then

    if coalesce(new.commission_amount, 0) > 0 then
      insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
      values (new.rider_id, new.id, new.commission_amount, v_day, 'commission')
      on conflict (order_id, kind) do nothing;
    end if;

    if coalesce(new.markup_total, 0) > 0 then
      select coalesce(t.markup_operator_share, 1) into v_share
        from territories t where t.id = new.territory_id;
      v_owed := round(new.markup_total * coalesce(v_share, 1), 2);
      if v_owed > 0 then
        insert into commission_ledger (rider_id, order_id, amount, business_day, kind)
        values (new.rider_id, new.id, v_owed, v_day, 'markup')
        on conflict (order_id, kind) do nothing;
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- 2. A rider's territory lives on their rider row, not their profile, so
--    current_territory_id() returned null for them and the per-territory
--    app_settings view handed the rider app an empty row. Fall back to the
--    rider record rather than duplicating the column.
create or replace function current_territory_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.territory_id from profiles p where p.id = auth.uid()),
    (select r.territory_id from riders r where r.profile_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- The rate. Franchisor-wide, and snapshotted onto every entry so changing it
-- later reprices the future and never rewrites the past.
-- ---------------------------------------------------------------------------
alter table platform_settings
  add column if not exists royalty_rate numeric(5, 4) not null default 0.30,
  add constraint platform_settings_royalty_rate_range check (royalty_rate >= 0 and royalty_rate <= 1);

comment on column platform_settings.royalty_rate is
  'The franchisor''s share of platform revenue. Snapshotted onto each royalty entry when booked.';

-- ---------------------------------------------------------------------------
-- The royalty ledger: what each city owes the franchisor, and why.
-- ---------------------------------------------------------------------------
create table royalty_ledger (
  id                uuid primary key default gen_random_uuid(),
  territory_id      uuid not null references territories (id),

  -- The ledger entry this was earned from. Unique, so a settlement that is
  -- reversed and re-confirmed cannot book the same royalty twice. Null for a
  -- joining fee or a manual adjustment, and Postgres allows many nulls in a
  -- unique index.
  source_ledger_id  uuid references commission_ledger (id) on delete restrict,

  rider_id          uuid references riders (id),
  order_id          uuid references orders (id),

  kind              text not null default 'royalty'
                      check (kind in ('royalty', 'joining_fee', 'adjustment')),
  base_amount       numeric(12, 2) not null default 0,
  rate              numeric(5, 4) not null default 0,
  amount            numeric(12, 2) not null,
  business_day      date not null,
  note              text,

  -- Has the operator paid this across to the franchisor?
  settled           boolean not null default false,

  created_at        timestamptz not null default now()
);

create unique index royalty_ledger_source_uniq on royalty_ledger (source_ledger_id);
create index royalty_ledger_territory_idx on royalty_ledger (territory_id, settled);
create index royalty_ledger_day_idx on royalty_ledger (territory_id, business_day);

comment on table royalty_ledger is
  'The franchisor''s share, one entry per settled commission-ledger row. Booked on confirmed settlement, never on delivery.';
comment on column royalty_ledger.rate is
  'The royalty rate as it stood when this was booked. History does not move when the rate does.';

-- ---------------------------------------------------------------------------
-- Booking, and unbooking.
-- ---------------------------------------------------------------------------
create or replace function book_royalty_on_settled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate    numeric(5, 4);
  v_amount  numeric(12, 2);
  v_settled boolean;
begin
  -- Reversal: an operator confirmed a settlement in error and took it back.
  if tg_op = 'UPDATE' and old.settled and not new.settled then
    select settled into v_settled from royalty_ledger where source_ledger_id = new.id;
    if v_settled is null then
      return null;                                   -- nothing was booked
    elsif v_settled then
      -- Already paid across to the franchisor, so it cannot simply vanish.
      -- Cancel it with an offsetting entry and leave both on the record.
      insert into royalty_ledger (territory_id, rider_id, order_id, kind, base_amount,
                                  rate, amount, business_day, note)
      select r.territory_id, r.rider_id, r.order_id, 'adjustment', -r.base_amount,
             r.rate, -r.amount, new.business_day,
             'Reversal: the settlement this was booked from was un-confirmed'
        from royalty_ledger r where r.source_ledger_id = new.id;
    else
      delete from royalty_ledger where source_ledger_id = new.id and not settled;
    end if;
    return null;
  end if;

  if not new.settled then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.settled then
    return null;                                     -- already settled, nothing new
  end if;
  if new.territory_id is null then
    return null;                                     -- nobody to owe it to
  end if;

  select royalty_rate into v_rate from platform_settings where id = true;
  if coalesce(v_rate, 0) = 0 then
    return null;
  end if;

  v_amount := round(new.amount * v_rate, 2);
  if v_amount = 0 then
    return null;
  end if;

  insert into royalty_ledger (territory_id, source_ledger_id, rider_id, order_id,
                              kind, base_amount, rate, amount, business_day)
  values (new.territory_id, new.id, new.rider_id, new.order_id,
          'royalty', new.amount, v_rate, v_amount, new.business_day)
  on conflict (source_ledger_id) do nothing;

  return null;
end;
$$;

create trigger commission_ledger_book_royalty
  after insert or update of settled on commission_ledger
  for each row execute function book_royalty_on_settled();

-- ---------------------------------------------------------------------------
-- What a city owes right now.
-- ---------------------------------------------------------------------------
create or replace function territory_royalty_due(p_territory uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric(12, 2)
    from royalty_ledger
   where territory_id = p_territory and not settled;
$$;
revoke all on function territory_royalty_due(uuid) from public;
grant execute on function territory_royalty_due(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Access. An operator reads their own royalty entries — they are being billed
-- from them, so they can see them — and cannot write any. Only the franchisor
-- writes, and only through the functions below.
-- ---------------------------------------------------------------------------
grant select on royalty_ledger to authenticated;
grant all on royalty_ledger to service_role;
alter table royalty_ledger enable row level security;

create policy royalty_ledger_read on royalty_ledger
  for select using (is_franchisor() or (is_staff() and territory_id = current_territory_id()));

create policy royalty_ledger_franchisor_write on royalty_ledger
  for all using (is_franchisor()) with check (is_franchisor());

-- A one-off charge against a city: a joining fee, a credit, a correction.
-- The joining-fee policy is still open, so this gives it somewhere to live
-- without deciding whether one is charged.
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

  insert into royalty_ledger (territory_id, kind, base_amount, rate, amount, business_day, note)
  values (p_territory, p_kind, 0, 0, round(p_amount, 2),
          (now() at time zone 'Asia/Manila')::date, nullif(btrim(p_note), ''))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function charge_territory_fee(uuid, numeric, text, text) from public;
grant execute on function charge_territory_fee(uuid, numeric, text, text) to authenticated;
