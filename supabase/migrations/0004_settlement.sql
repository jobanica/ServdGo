-- Easy Buy Delivery — commission ledger and daily settlement gate

-- One entry per completed order that generates a commission the rider holds.
-- COD (and rider_qr) orders create entries; online-paid orders do NOT, because
-- that money already landed with the operator.
create table commission_ledger (
  id           uuid primary key default gen_random_uuid(),
  rider_id     uuid not null references riders (id) on delete cascade,
  order_id     uuid not null unique references orders (id) on delete cascade,
  amount       numeric(10, 2) not null check (amount >= 0),
  business_day date not null,
  settled      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index on commission_ledger (rider_id, business_day);
create index on commission_ledger (rider_id, settled);

-- A rider's payment against a business day's owed balance.
create table settlements (
  id            uuid primary key default gen_random_uuid(),
  rider_id      uuid not null references riders (id) on delete cascade,
  business_day  date not null,
  amount_due    numeric(10, 2) not null,
  method        text,                                  -- gcash / maya / cash / bank
  reference     text,
  status        settlement_status not null default 'pending',
  confirmed_by  uuid references profiles (id),
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  unique (rider_id, business_day)
);
create index on settlements (rider_id, status);

-- Running unsettled balance owed by a rider.
create or replace function rider_owed_balance(p_rider_id uuid)
returns numeric language sql stable as $$
  select coalesce(sum(amount), 0)
  from commission_ledger
  where rider_id = p_rider_id and settled = false;
$$;

-- Unsettled balance for business days strictly before a given day
-- (this is what the daily gate checks — yesterday and earlier must be clear).
create or replace function rider_overdue_balance(p_rider_id uuid, p_today date)
returns numeric language sql stable as $$
  select coalesce(sum(amount), 0)
  from commission_ledger
  where rider_id = p_rider_id
    and settled = false
    and business_day < p_today;
$$;
