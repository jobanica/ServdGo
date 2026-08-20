-- ServdGo — the rider pays the commission before they earn it, not after.
--
-- Until now a rider collected the fare at the door, kept it, and owed the
-- operator the commission inside it until they settled — cash, once a day, on
-- trust. That works with ten riders in one city and stops working somewhere
-- around thirty, because every unsettled peso is money the operator has already
-- earned and cannot see.
--
-- The wallet inverts it. The rider tops up (Xendit, or cash handed over and
-- recorded), the money reaches the franchisor, and every delivery deducts its
-- commission from that balance the moment it is booked. Nobody chases anybody:
-- a rider with no balance simply cannot start tomorrow.
--
-- Three things follow, and they are the whole design:
--
--   1. A commission that is deducted has been PAID, so commission_ledger.settled
--      goes true immediately — which is exactly the transition the royalty
--      ledger already books off (0082). The franchisor's 30% therefore keeps
--      working untouched.
--   2. The wallet is a ledger, not a number. A balance you can only read is a
--      balance nobody can argue with; a balance you can total from its entries
--      is one a rider can check themselves.
--   3. Money never moves in a float. Every column here is numeric(12,2).
--
-- What the franchisor now owes the operator for holding their commissions is
-- 0119's problem, not this migration's.

-- ---------------------------------------------------------------------------
-- The dials. Franchisor-wide, because the float sits in the franchisor's own
-- account and the rules for it cannot differ by city.
-- ---------------------------------------------------------------------------
alter table platform_settings
  add column if not exists wallet_enabled       boolean not null default false,
  add column if not exists wallet_min_topup     numeric(12, 2) not null default 100,
  add column if not exists wallet_max_topup     numeric(12, 2) not null default 20000,
  add column if not exists wallet_low_balance   numeric(12, 2) not null default 100,
  add column if not exists wallet_credit_limit  numeric(12, 2) not null default 0;

do $$ begin
  alter table platform_settings
    add constraint platform_settings_wallet_topup_band
    check (wallet_min_topup > 0 and wallet_max_topup >= wallet_min_topup);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table platform_settings
    add constraint platform_settings_wallet_credit_limit
    check (wallet_credit_limit >= 0);
exception when duplicate_object then null; end $$;

comment on column platform_settings.wallet_enabled is
  'When on, a delivered order deducts its commission from the rider''s wallet instead of leaving it in their pocket.';
-- Off until the franchisor says otherwise, deliberately. Switching it on moves
-- every rider onto prepay overnight, and a database that flips that for you
-- during a migration is a database that locked out a city's riders at 00:01.
comment on column platform_settings.wallet_credit_limit is
  'How far below zero a wallet may sit overnight before the rider is locked out. Zero means prepaid, strictly.';

-- ---------------------------------------------------------------------------
-- A top-up: one attempt to put money in, whatever the channel.
--
-- The row exists before the money does, because a payment that is started and
-- never finished is a thing you need to be able to see. Xendit is told our own
-- reference and hands back theirs; either one finds the row again.
-- ---------------------------------------------------------------------------
create table wallet_topups (
  id            uuid primary key default gen_random_uuid(),
  rider_id      uuid not null references riders (id) on delete cascade,
  territory_id  uuid references territories (id),

  amount        numeric(12, 2) not null check (amount > 0),
  channel       text not null default 'xendit'
                  check (channel in ('xendit', 'cash', 'bank', 'grant')),

  -- Who physically received the money. A card payment lands in the franchisor's
  -- Xendit account; cash handed to the city office does not, and 0119 has to
  -- know the difference to work out who owes whom at the end of the day.
  collected_by  text not null default 'franchisor'
                  check (collected_by in ('franchisor', 'operator')),

  reference     text not null unique,
  provider      text,
  provider_ref  text,
  provider_status text,
  checkout_url  text,
  expires_at    timestamptz,

  status        text not null default 'pending'
                  check (status in ('pending', 'paid', 'expired', 'failed', 'cancelled')),
  paid_at       timestamptz,
  payload       jsonb,
  note          text,

  -- A plain uuid, not a foreign key: a top-up is a record of money moving and
  -- must outlive the account of whoever keyed it in (0110).
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index wallet_topups_rider_idx on wallet_topups (rider_id, created_at desc);
create index wallet_topups_status_idx on wallet_topups (status, created_at desc);
create index wallet_topups_territory_idx on wallet_topups (territory_id, created_at desc);
create unique index wallet_topups_provider_ref_uniq
  on wallet_topups (provider, provider_ref) where provider_ref is not null;

comment on table wallet_topups is
  'One row per attempt to fund a rider wallet. Pending until the provider says otherwise; paid exactly once.';

-- ---------------------------------------------------------------------------
-- The wallet itself: entries, signed. Credit is positive, a charge is negative,
-- and the balance is their sum. There is no balance column to drift.
-- ---------------------------------------------------------------------------
create table rider_wallet_entries (
  id            uuid primary key default gen_random_uuid(),
  rider_id      uuid not null references riders (id) on delete cascade,
  territory_id  uuid references territories (id),

  kind          text not null
                  check (kind in ('topup', 'commission', 'markup', 'adjustment', 'refund')),
  amount        numeric(12, 2) not null check (amount <> 0),
  business_day  date not null,

  -- The commission-ledger row this discharged. Unique, so a retry, a replayed
  -- trigger or a re-run migration cannot charge the same delivery twice.
  source_ledger_id uuid references commission_ledger (id) on delete set null,
  order_id      uuid references orders (id) on delete set null,
  topup_id      uuid references wallet_topups (id) on delete set null,

  note          text,
  created_by    uuid,
  created_at    timestamptz not null default now(),

  constraint rider_wallet_entries_topup_credits check (kind <> 'topup' or amount > 0),
  constraint rider_wallet_entries_commission_charges
    check (kind not in ('commission', 'markup') or amount < 0)
);

create index rider_wallet_entries_rider_idx on rider_wallet_entries (rider_id, created_at desc);
create index rider_wallet_entries_day_idx on rider_wallet_entries (rider_id, business_day);
create index rider_wallet_entries_territory_idx on rider_wallet_entries (territory_id, business_day);
create unique index rider_wallet_entries_source_uniq
  on rider_wallet_entries (source_ledger_id) where source_ledger_id is not null;
create unique index rider_wallet_entries_topup_uniq
  on rider_wallet_entries (topup_id) where topup_id is not null;

comment on table rider_wallet_entries is
  'A rider''s wallet, as entries. Positive credits, negative charges; the balance is the sum and is never stored.';

-- ---------------------------------------------------------------------------
-- Reading it.
-- ---------------------------------------------------------------------------

/** What the rider has right now. */
create or replace function rider_wallet_balance(p_rider uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric(12, 2)
    from rider_wallet_entries where rider_id = p_rider;
$$;
revoke all on function rider_wallet_balance(uuid) from public;
grant execute on function rider_wallet_balance(uuid) to authenticated, service_role;

/**
 * What the wallet held at the end of the day before p_today.
 *
 * This is the number the lock-out reads, and the reason it exists separately:
 * going negative on the last delivery of a shift should not strand a rider
 * mid-street. They finish the day, and they start the next one funded.
 */
create or replace function rider_wallet_balance_before(p_rider uuid, p_today date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(amount), 0)::numeric(12, 2)
    from rider_wallet_entries
   where rider_id = p_rider and business_day < p_today;
$$;
revoke all on function rider_wallet_balance_before(uuid, date) from public;
grant execute on function rider_wallet_balance_before(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The gate.
--
-- Every claim policy in this database already asks one question —
-- rider_overdue_balance(...) = 0 — so the wallet answers that same question
-- rather than adding a second one nobody would remember to check. Cash-era
-- unsettled commission still counts: switching the wallet on does not forgive
-- what was owed before it.
-- ---------------------------------------------------------------------------
create or replace function rider_overdue_balance(p_rider_id uuid, p_today date)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select sum(amount) from commission_ledger
     where rider_id = p_rider_id and settled = false and business_day < p_today
  ), 0)
  + case when (select wallet_enabled from platform_settings where id = true)
         then greatest(0,
                -rider_wallet_balance_before(p_rider_id, p_today)
                - coalesce((select wallet_credit_limit from platform_settings where id = true), 0))
         else 0 end;
$$;
revoke all on function rider_overdue_balance(uuid, date) from public;
grant execute on function rider_overdue_balance(uuid, date) to anon, authenticated, service_role;

comment on function rider_overdue_balance(uuid, date) is
  'What must be cleared before this rider may accept work today: old unsettled commission, plus any wallet shortfall carried in from yesterday.';

-- ---------------------------------------------------------------------------
-- Charging the wallet.
--
-- record_commission_on_delivery() books the ledger row; this discharges it. It
-- deliberately runs after the insert rather than inside it, so the settled flag
-- moves as its own UPDATE and the royalty trigger sees the transition it is
-- written to watch.
--
-- An adjustment the operator posted in the rider's favour is negative on the
-- ledger, so negating it credits the wallet. One rule covers both directions.
-- ---------------------------------------------------------------------------
create or replace function wallet_charge_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
  v_kind      text;
begin
  if not coalesce((select wallet_enabled from platform_settings where id = true), false) then
    return null;
  end if;
  if new.settled then
    return null;                      -- settled on arrival: nothing left to charge
  end if;
  if new.amount = 0 then
    return null;
  end if;

  select coalesce(o.territory_id, r.territory_id) into v_territory
    from riders r
    left join orders o on o.id = new.order_id
   where r.id = new.rider_id;

  v_kind := case when new.kind = 'markup' then 'markup'
                 when new.kind = 'adjustment' then 'adjustment'
                 else 'commission' end;

  insert into rider_wallet_entries (rider_id, territory_id, kind, amount, business_day,
                                    source_ledger_id, order_id, note)
  values (new.rider_id, v_territory, v_kind, -new.amount, new.business_day,
          new.id, new.order_id,
          case when new.kind = 'markup' then 'Mark-up share on a delivery'
               when new.kind = 'adjustment' then 'Adjustment posted by the city office'
               else 'Commission on a delivery' end)
  on conflict (source_ledger_id) where source_ledger_id is not null do nothing;

  -- Charged, therefore paid. This is the transition the royalty ledger books on.
  update commission_ledger set settled = true where id = new.id and not settled;
  return null;
end;
$$;

drop trigger if exists commission_ledger_charge_wallet on commission_ledger;
create trigger commission_ledger_charge_wallet
  after insert on commission_ledger
  for each row
  execute function wallet_charge_commission();

-- ---------------------------------------------------------------------------
-- Putting money in.
-- ---------------------------------------------------------------------------

/** A short, human-quotable reference. Collision-checked against the table. */
create or replace function wallet_topup_reference()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
begin
  loop
    v_ref := 'TOP-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
    exit when not exists (select 1 from wallet_topups where reference = v_ref);
  end loop;
  return v_ref;
end;
$$;
revoke all on function wallet_topup_reference() from public;

/**
 * The rider asks to add money. Nothing is credited here — this only reserves
 * the row and the reference that the payment page will be created against.
 */
create or replace function wallet_topup_start(p_amount numeric, p_channel text default 'xendit')
returns wallet_topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider     uuid := current_rider_id();
  v_min       numeric(12, 2);
  v_max       numeric(12, 2);
  v_on        boolean;
  v_territory uuid;
  v_row       wallet_topups;
begin
  if v_rider is null then
    raise exception 'Only a rider can top up their own wallet'
      using errcode = 'insufficient_privilege';
  end if;
  select wallet_enabled, wallet_min_topup, wallet_max_topup
    into v_on, v_min, v_max from platform_settings where id = true;
  if not coalesce(v_on, false) then
    raise exception 'Wallet top-ups are switched off' using errcode = 'check_violation';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter how much you want to add' using errcode = 'check_violation';
  end if;
  if p_amount < v_min or p_amount > v_max then
    raise exception 'A top-up must be between % and %',
      to_char(v_min, 'FM999999990.00'), to_char(v_max, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;
  if coalesce(p_channel, 'xendit') not in ('xendit', 'cash', 'bank') then
    raise exception 'Unknown top-up channel' using errcode = 'check_violation';
  end if;

  select territory_id into v_territory from riders where id = v_rider;

  insert into wallet_topups (rider_id, territory_id, amount, channel, collected_by,
                             reference, provider, status, created_by)
  values (v_rider, v_territory, round(p_amount, 2), coalesce(p_channel, 'xendit'),
          'franchisor', wallet_topup_reference(),
          case when coalesce(p_channel, 'xendit') = 'xendit' then 'xendit' end,
          'pending', auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function wallet_topup_start(numeric, text) from public;
grant execute on function wallet_topup_start(numeric, text) to authenticated;

/** The payment page has been created; remember where to send the rider. */
create or replace function wallet_topup_attach_provider(
  p_reference text, p_provider text, p_provider_ref text,
  p_checkout_url text, p_expires_at timestamptz default null)
returns wallet_topups
language plpgsql
security definer
set search_path = public
as $$
declare v_row wallet_topups;
begin
  update wallet_topups
     set provider     = nullif(btrim(p_provider), ''),
         provider_ref = nullif(btrim(p_provider_ref), ''),
         checkout_url = nullif(btrim(p_checkout_url), ''),
         expires_at   = coalesce(p_expires_at, expires_at)
   where reference = p_reference and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'No pending top-up with that reference' using errcode = 'no_data_found';
  end if;
  return v_row;
end;
$$;
revoke all on function wallet_topup_attach_provider(text, text, text, text, timestamptz) from public;
grant execute on function wallet_topup_attach_provider(text, text, text, text, timestamptz) to service_role;

/**
 * The money arrived. Idempotent on purpose: a payment gateway will send the
 * same callback twice, and crediting a wallet twice is the one bug in this
 * whole file nobody would ever notice.
 */
create or replace function wallet_topup_mark_paid(
  p_reference text,
  p_provider_ref text default null,
  p_amount numeric default null,
  p_payload jsonb default null)
returns wallet_topups
language plpgsql
security definer
set search_path = public
as $$
declare v_row wallet_topups;
begin
  select * into v_row from wallet_topups
   where reference = p_reference
      or (p_provider_ref is not null and provider_ref = p_provider_ref)
   limit 1;

  if v_row.id is null then
    raise exception 'No such top-up' using errcode = 'no_data_found';
  end if;
  if v_row.status = 'paid' then
    return v_row;                                        -- already credited
  end if;
  if p_amount is not null and round(p_amount, 2) <> v_row.amount then
    raise exception 'The payment was % but the top-up was for %',
      to_char(round(p_amount, 2), 'FM999999990.00'),
      to_char(v_row.amount, 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  update wallet_topups
     set status = 'paid',
         paid_at = now(),
         provider_ref = coalesce(nullif(btrim(p_provider_ref), ''), provider_ref),
         provider_status = 'PAID',
         payload = coalesce(p_payload, payload)
   where id = v_row.id
  returning * into v_row;

  insert into rider_wallet_entries (rider_id, territory_id, kind, amount, business_day,
                                    topup_id, note)
  values (v_row.rider_id, v_row.territory_id, 'topup', v_row.amount,
          business_today(v_row.territory_id), v_row.id,
          case v_row.channel
            when 'xendit' then 'Top-up (' || coalesce(v_row.provider_ref, v_row.reference) || ')'
            when 'cash'   then 'Cash top-up (' || v_row.reference || ')'
            when 'bank'   then 'Bank transfer (' || v_row.reference || ')'
            else 'Top-up (' || v_row.reference || ')' end)
  on conflict (topup_id) where topup_id is not null do nothing;

  return v_row;
end;
$$;
revoke all on function wallet_topup_mark_paid(text, text, numeric, jsonb) from public;
grant execute on function wallet_topup_mark_paid(text, text, numeric, jsonb) to service_role;

/** It did not go through. Nothing is credited, and the row says why. */
create or replace function wallet_topup_close(
  p_reference text, p_status text, p_payload jsonb default null)
returns wallet_topups
language plpgsql
security definer
set search_path = public
as $$
declare v_row wallet_topups;
begin
  if p_status not in ('expired', 'failed', 'cancelled') then
    raise exception 'A top-up can only be closed as expired, failed or cancelled'
      using errcode = 'check_violation';
  end if;
  update wallet_topups
     set status = p_status, provider_status = upper(p_status), payload = coalesce(p_payload, payload)
   where reference = p_reference and status = 'pending'
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from wallet_topups where reference = p_reference;
    if v_row.id is null then
      raise exception 'No such top-up' using errcode = 'no_data_found';
    end if;
  end if;
  return v_row;
end;
$$;
revoke all on function wallet_topup_close(text, text, jsonb) from public;
grant execute on function wallet_topup_close(text, text, jsonb) to service_role;

/**
 * Cash over the counter, or a credit the office decided to give.
 *
 * collected_by is the whole point of this function: money handed to the city
 * office is money the franchisor is owed rather than money it holds, and 0119
 * settles that up at the end of the day.
 */
create or replace function wallet_record_topup(
  p_rider uuid,
  p_amount numeric,
  p_channel text default 'cash',
  p_reference text default null,
  p_note text default null)
returns wallet_topups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
  v_row       wallet_topups;
  v_collector text;
begin
  select territory_id into v_territory from riders where id = p_rider;
  if v_territory is null and not exists (select 1 from riders where id = p_rider) then
    raise exception 'No such rider' using errcode = 'no_data_found';
  end if;
  if not admin_sees(v_territory) then
    raise exception 'Only the city office or the franchisor can record a top-up'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A top-up must be more than zero' using errcode = 'check_violation';
  end if;
  if coalesce(p_channel, 'cash') not in ('cash', 'bank', 'grant') then
    raise exception 'Record cash, a bank transfer, or a grant' using errcode = 'check_violation';
  end if;

  v_collector := case when is_franchisor() then 'franchisor' else 'operator' end;
  -- A grant is written off by whoever granted it; it is not money anyone holds.
  if coalesce(p_channel, 'cash') = 'grant' then
    v_collector := 'franchisor';
  end if;

  insert into wallet_topups (rider_id, territory_id, amount, channel, collected_by,
                             reference, status, note, created_by)
  values (p_rider, v_territory, round(p_amount, 2), coalesce(p_channel, 'cash'), v_collector,
          coalesce(nullif(btrim(p_reference), ''), wallet_topup_reference()),
          'pending', nullif(btrim(p_note), ''), auth.uid())
  returning * into v_row;

  -- Cash in hand is not a promise, so it clears at once.
  update wallet_topups set status = 'paid', paid_at = now() where id = v_row.id
  returning * into v_row;

  insert into rider_wallet_entries (rider_id, territory_id, kind, amount, business_day,
                                    topup_id, note, created_by)
  values (v_row.rider_id, v_row.territory_id, 'topup', v_row.amount,
          business_today(v_row.territory_id), v_row.id,
          coalesce(v_row.note, initcap(v_row.channel) || ' top-up (' || v_row.reference || ')'),
          auth.uid());

  perform log_action('wallet.topup.recorded', 'rider', p_rider::text, v_territory,
                     jsonb_build_object('amount', v_row.amount, 'channel', v_row.channel,
                                        'reference', v_row.reference,
                                        'collected_by', v_row.collected_by));
  return v_row;
end;
$$;
revoke all on function wallet_record_topup(uuid, numeric, text, text, text) from public;
grant execute on function wallet_record_topup(uuid, numeric, text, text, text) to authenticated;

/** A correction to a wallet, in either direction, with a reason attached. */
create or replace function wallet_adjust(p_rider uuid, p_amount numeric, p_note text)
returns rider_wallet_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
  v_row       rider_wallet_entries;
begin
  select territory_id into v_territory from riders where id = p_rider;
  if not exists (select 1 from riders where id = p_rider) then
    raise exception 'No such rider' using errcode = 'no_data_found';
  end if;
  if not admin_sees(v_territory) then
    raise exception 'Only the city office or the franchisor can adjust a wallet'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'An adjustment of nothing is not an adjustment'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Say why' using errcode = 'check_violation';
  end if;

  insert into rider_wallet_entries (rider_id, territory_id, kind, amount, business_day,
                                    note, created_by)
  values (p_rider, v_territory, 'adjustment', round(p_amount, 2),
          business_today(v_territory), btrim(p_note), auth.uid())
  returning * into v_row;

  perform log_action('wallet.adjusted', 'rider', p_rider::text, v_territory,
                     jsonb_build_object('amount', v_row.amount, 'note', v_row.note));
  return v_row;
end;
$$;
revoke all on function wallet_adjust(uuid, numeric, text) from public;
grant execute on function wallet_adjust(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- What the apps ask for.
-- ---------------------------------------------------------------------------

/** One rider's wallet at a glance — the rider app's header, and the gate. */
create or replace function rider_wallet_summary(p_rider uuid default null)
returns table (
  rider_id        uuid,
  rider_name      text,
  territory_id    uuid,
  balance         numeric,
  balance_yesterday numeric,
  overdue         numeric,
  locked          boolean,
  low             boolean,
  wallet_enabled  boolean,
  min_topup       numeric,
  max_topup       numeric,
  credit_limit    numeric,
  last_topup_at   timestamptz,
  charged_today   numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select r.id, r.name, r.territory_id
      from riders r
     where r.id = coalesce(p_rider, current_rider_id())
       and (r.id = current_rider_id() or staff_sees(r.territory_id))
  ), s as (select * from platform_settings where id = true)
  select t.id, t.name, t.territory_id,
         rider_wallet_balance(t.id),
         rider_wallet_balance_before(t.id, business_today(t.territory_id)),
         rider_overdue_balance(t.id, business_today(t.territory_id)),
         rider_overdue_balance(t.id, business_today(t.territory_id)) > 0,
         rider_wallet_balance(t.id) < s.wallet_low_balance,
         s.wallet_enabled, s.wallet_min_topup, s.wallet_max_topup, s.wallet_credit_limit,
         (select max(paid_at) from wallet_topups w where w.rider_id = t.id and w.status = 'paid'),
         coalesce((select -sum(e.amount) from rider_wallet_entries e
                    where e.rider_id = t.id
                      and e.business_day = business_today(t.territory_id)
                      and e.kind in ('commission', 'markup')), 0)
    from target t cross join s;
$$;
revoke all on function rider_wallet_summary(uuid) from public;
grant execute on function rider_wallet_summary(uuid) to authenticated;

/** The statement, newest first, with the balance as it stood after each line. */
create or replace function rider_wallet_statement(
  p_rider uuid default null,
  p_from  date default null,
  p_to    date default null,
  p_limit int default 200)
returns table (
  id           uuid,
  created_at   timestamptz,
  business_day date,
  kind         text,
  amount       numeric,
  balance_after numeric,
  note         text,
  order_id     uuid,
  topup_id     uuid
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select r.id from riders r
     where r.id = coalesce(p_rider, current_rider_id())
       and (r.id = current_rider_id() or staff_sees(r.territory_id))
  ), rows as (
    select e.*,
           sum(e.amount) over (order by e.created_at, e.id
                               rows between unbounded preceding and current row) as running
      from rider_wallet_entries e
      join target t on t.id = e.rider_id
  )
  select r.id, r.created_at, r.business_day, r.kind, r.amount,
         r.running::numeric(12, 2), r.note, r.order_id, r.topup_id
    from rows r
   where (p_from is null or r.business_day >= p_from)
     and (p_to   is null or r.business_day <= p_to)
   order by r.created_at desc, r.id desc
   limit greatest(coalesce(p_limit, 200), 1);
$$;
revoke all on function rider_wallet_statement(uuid, date, date, int) from public;
grant execute on function rider_wallet_statement(uuid, date, date, int) to authenticated;

/** Every rider's wallet in a city — the operator's roll-call. */
create or replace function territory_rider_wallets(p_territory uuid default null)
returns table (
  rider_id      uuid,
  rider_name    text,
  mobile_number text,
  territory_id  uuid,
  balance       numeric,
  overdue       numeric,
  locked        boolean,
  last_topup_at timestamptz,
  charged_30d   numeric,
  topped_up_30d numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.name, r.mobile_number, r.territory_id,
         rider_wallet_balance(r.id),
         rider_overdue_balance(r.id, business_today(r.territory_id)),
         rider_overdue_balance(r.id, business_today(r.territory_id)) > 0,
         (select max(w.paid_at) from wallet_topups w where w.rider_id = r.id and w.status = 'paid'),
         coalesce((select -sum(e.amount) from rider_wallet_entries e
                    where e.rider_id = r.id and e.kind in ('commission', 'markup')
                      and e.business_day > business_today(r.territory_id) - 30), 0),
         coalesce((select sum(e.amount) from rider_wallet_entries e
                    where e.rider_id = r.id and e.kind = 'topup'
                      and e.business_day > business_today(r.territory_id) - 30), 0)
    from riders r
   where staff_sees(r.territory_id)
     and (p_territory is null or r.territory_id = p_territory)
     and r.application_status = 'approved'
   order by rider_overdue_balance(r.id, business_today(r.territory_id)) desc,
            rider_wallet_balance(r.id) asc;
$$;
revoke all on function territory_rider_wallets(uuid) from public;
grant execute on function territory_rider_wallets(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Who may see what. Nobody writes to either table directly — every path in is
-- a function above, so there is exactly one place each rule is enforced.
-- ---------------------------------------------------------------------------
alter table rider_wallet_entries enable row level security;
alter table wallet_topups enable row level security;

create policy rider_wallet_entries_read on rider_wallet_entries
  for select using (rider_id = current_rider_id() or staff_sees(territory_id));

create policy wallet_topups_read on wallet_topups
  for select using (rider_id = current_rider_id() or staff_sees(territory_id));

grant select on rider_wallet_entries to authenticated;
grant select on wallet_topups to authenticated;
grant all on rider_wallet_entries to service_role;
grant all on wallet_topups to service_role;

-- The view-as session must stay read-only on the tables added here too.
select hq_attach_readonly_guards();
