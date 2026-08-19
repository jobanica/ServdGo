-- Easy Buy Delivery — core tables
-- Profiles, stores + menus, customers, riders, and app settings.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- Mirrors auth.users; carries the app role.
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        user_role not null default 'customer',
  full_name   text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Stores & menus (admin-owned; merchants do not log in)
-- ---------------------------------------------------------------------------

create table stores (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  category        text,
  address         text,
  lat             double precision,
  lng             double precision,
  contact_number  text,
  is_available    boolean not null default true,   -- per-merchant on/off toggle
  created_at      timestamptz not null default now()
);

create table menu_categories (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores (id) on delete cascade,
  title       text not null,
  sort_order  int not null default 0
);
create index on menu_categories (store_id);

create table menu_items (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores (id) on delete cascade,
  category_id  uuid references menu_categories (id) on delete set null,
  name         text not null,
  description  text,
  price        numeric(10, 2) not null check (price >= 0),
  is_available boolean not null default true
);
create index on menu_items (store_id);
create index on menu_items (category_id);

create table menu_item_options (
  id            uuid primary key default gen_random_uuid(),
  menu_item_id  uuid not null references menu_items (id) on delete cascade,
  group_name    text not null,                       -- e.g. "Size", "Add-ons"
  option_name   text not null,                       -- e.g. "Large"
  price_delta   numeric(10, 2) not null default 0,
  required      boolean not null default false
);
create index on menu_item_options (menu_item_id);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

create table customers (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid unique references profiles (id) on delete cascade,
  name           text,
  mobile_number  text not null,                      -- required: rider calls + OTP
  created_at     timestamptz not null default now()
);

create table customer_addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers (id) on delete cascade,
  label        text,
  address      text not null,
  lat          double precision,
  lng          double precision,
  is_default   boolean not null default false
);
create index on customer_addresses (customer_id);

-- ---------------------------------------------------------------------------
-- Riders
-- ---------------------------------------------------------------------------

create table riders (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid unique references profiles (id) on delete cascade,
  name                text not null,
  mobile_number       text not null,
  id_document         text,
  vehicle             text,
  application_status  rider_application_status not null default 'pending',
  is_locked           boolean not null default false,  -- unsettled previous-day balance
  qr_code_ref         text,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- App settings (single row)
-- ---------------------------------------------------------------------------

create table app_settings (
  id                    boolean primary key default true check (id),  -- singleton guard
  is_open               boolean not null default true,                -- system-wide switch
  schedule              jsonb,                                        -- weekly hours
  default_delivery_fee  numeric(10, 2) not null default 50,
  per_store_fee         numeric(10, 2) not null default 25,
  convenience_fee       numeric(10, 2) not null default 0,
  commission_rate       numeric(5, 4) not null default 0.15,
  delivery_fee_model    delivery_fee_model not null default 'flat',
  convenience_fee_mode  convenience_fee_mode not null default 'pass_through',
  settlement_cutoff     time not null default '00:00',
  updated_at            timestamptz not null default now()
);

insert into app_settings (id) values (true);
