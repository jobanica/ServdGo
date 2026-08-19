-- Easy Buy Delivery — the unified order queue
-- One row per order regardless of surface (web / mobile) or service type.

create table orders (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers (id),
  rider_id         uuid references riders (id),        -- null until accepted
  service_type     service_type not null,
  status           order_status not null default 'pending',

  payment_method   payment_method not null default 'cod',
  payment_status   payment_status not null default 'unpaid',

  -- Fees (commission is on delivery_fee + store_fee_total only)
  delivery_fee     numeric(10, 2) not null default 0,
  store_fee_total  numeric(10, 2) not null default 0,  -- per_store_fee x added stores
  convenience_fee  numeric(10, 2) not null default 0,
  commission_amount numeric(10, 2) not null default 0,

  -- Goods (food/pabili) — pass-through, excluded from commission
  goods_cost       numeric(10, 2) not null default 0,

  -- Pabili
  estimated_amount numeric(10, 2),
  budget_cap       numeric(10, 2),
  actual_amount    numeric(10, 2),

  -- Padala (point-to-point)
  pickup_lat       double precision,
  pickup_lng       double precision,
  pickup_contact   text,
  dropoff_lat      double precision,
  dropoff_lng      double precision,
  dropoff_contact  text,
  item_description text,
  padala_fee_payer fee_payer,

  -- Customer-side
  delivery_lat     double precision,
  delivery_lng     double precision,
  customer_contact text not null,                      -- required
  notes            text,

  created_at       timestamptz not null default now()
);
create index on orders (status);
create index on orders (rider_id);
create index on orders (customer_id);
create index on orders (service_type);

-- Which stores an order touches (drives the per-store fee; max 3 per trip).
create table order_stores (
  order_id  uuid not null references orders (id) on delete cascade,
  store_id  uuid not null references stores (id),
  primary key (order_id, store_id)
);

-- Enforce the "up to 3 stores per trip" rule.
create or replace function check_order_store_limit()
returns trigger language plpgsql as $$
begin
  if (select count(*) from order_stores where order_id = new.order_id) >= 3 then
    raise exception 'An order may reference at most 3 stores';
  end if;
  return new;
end;
$$;

create trigger order_store_limit
  before insert on order_stores
  for each row execute function check_order_store_limit();

-- Food/Pabili line items.
create table order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders (id) on delete cascade,
  menu_item_id  uuid references menu_items (id),       -- null for free-text Pabili
  name          text not null,
  qty           int not null default 1 check (qty > 0),
  unit_price    numeric(10, 2) not null default 0,
  options       jsonb,
  notes         text
);
create index on order_items (order_id);

-- Status transition audit trail (tracking + history).
create table order_status_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders (id) on delete cascade,
  status     order_status not null,
  changed_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
create index on order_status_events (order_id);

-- Payment records (one order may have a COD collection or an online charge).
create table payments (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders (id) on delete cascade,
  method       payment_method not null,
  amount       numeric(10, 2) not null,
  provider_ref text,
  status       payment_status not null default 'unpaid',
  created_at   timestamptz not null default now()
);
create index on payments (order_id);

-- Live rider GPS during an active delivery (feeds the customer's map).
-- Realtime broadcast is preferred; this table is for optional persistence/replay.
create table rider_locations (
  id         bigint generated always as identity primary key,
  rider_id   uuid not null references riders (id) on delete cascade,
  order_id   uuid references orders (id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  created_at timestamptz not null default now()
);
create index on rider_locations (order_id, created_at desc);
