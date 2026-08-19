-- ServdGo — a way in for a restaurant that is not holding a phone.
--
-- Servd sends orders over an API rather than through the customer app. That
-- needs an identity the current model does not have: a Servd restaurant is not
-- a "customer", it has no phone in anyone's hand, and it books on behalf of a
-- diner it will never hand the food to itself.
--
-- What it is not is a new economy. A merchant job is Padala shaped — the food
-- is already bought and paid for on Servd's side, the rider collects it and
-- carries it — so the delivery fee is collected at the door exactly as every
-- other order's is, and commission, settlement and the royalty all work
-- unchanged. Billing the restaurant instead would invert who owes whom and
-- needs an invoicing system nobody has asked for; see docs/merchant-api.md.

create table merchants (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null unique,

  -- Where the rider collects. This is also what routes the job: a restaurant's
  -- location decides which city's riders see it (decision 4).
  pickup_lat     double precision,
  pickup_lng     double precision,
  pickup_address text,
  territory_id   uuid references territories (id),

  contact_name   text,
  contact_number text,
  contact_email  text,

  -- Where status changes are posted back to, and the secret they are signed
  -- with. Null webhook_url means Servd polls instead.
  webhook_url    text,
  webhook_secret text,

  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index merchants_territory_idx on merchants (territory_id);

comment on table merchants is
  'A partner platform''s restaurant, booking deliveries over the API rather than through the customer app.';

-- A restaurant belongs to the city its own pin falls inside.
create or replace function fill_merchant_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.pickup_lat is not null and new.pickup_lng is not null then
    new.territory_id := coalesce(
      territory_for_point(new.pickup_lat, new.pickup_lng), new.territory_id);
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger merchants_territory
  before insert or update on merchants
  for each row execute function fill_merchant_territory();

-- ---------------------------------------------------------------------------
-- Keys. One per restaurant, not one shared key: a leak has to be revocable
-- without taking every other restaurant offline with it.
--
-- Only the hash is stored. Nobody — including the operator — can read a key
-- back out of the database once it has been shown to the restaurant.
-- ---------------------------------------------------------------------------
create table merchant_api_keys (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references merchants (id) on delete cascade,
  label        text,
  prefix       text not null,          -- shown in the console so a key is identifiable
  key_hash     text not null unique,   -- sha256 of the whole key, hex
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index merchant_api_keys_merchant_idx on merchant_api_keys (merchant_id);

comment on column merchant_api_keys.key_hash is
  'sha256 of the key. The key itself is shown once, at creation, and never stored.';

-- Unguessable without pgcrypto: two uuids is 244 bits of randomness, and
-- gen_random_uuid() is in core where gen_random_bytes() is an extension.
create or replace function random_token()
returns text
language sql
volatile
as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

/**
 * Mint a key for a restaurant. Returns the key in the clear — the only time it
 * exists anywhere outside the caller's hands.
 */
create or replace function create_merchant_api_key(p_merchant uuid, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_territory uuid;
begin
  select territory_id into v_territory from merchants where id = p_merchant;
  if v_territory is null and not is_franchisor() then
    raise exception 'That restaurant has no territory yet' using errcode = 'no_data_found';
  end if;
  if not staff_sees(v_territory) then
    raise exception 'That restaurant is not in your territory'
      using errcode = 'insufficient_privilege';
  end if;

  v_key := 'sgo_' || random_token();

  insert into merchant_api_keys (merchant_id, label, prefix, key_hash)
  values (p_merchant, nullif(btrim(p_label), ''), left(v_key, 12),
          encode(sha256(convert_to(v_key, 'utf8')), 'hex'));

  return v_key;
end;
$$;
revoke all on function create_merchant_api_key(uuid, text) from public;
grant execute on function create_merchant_api_key(uuid, text) to authenticated;

/**
 * Resolve a key to its restaurant, or null.
 *
 * Called by the edge functions on the service role. Deliberately says nothing
 * about *why* a key failed — unknown, revoked and belonging to a deactivated
 * restaurant are one answer, so the endpoint cannot be used to enumerate.
 */
create or replace function verify_merchant_key(p_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_merchant uuid;
begin
  if p_key is null or btrim(p_key) = '' then
    return null;
  end if;

  update merchant_api_keys k
     set last_used_at = now()
    from merchants m
   where k.key_hash = encode(sha256(convert_to(p_key, 'utf8')), 'hex')
     and k.revoked_at is null
     and m.id = k.merchant_id
     and m.is_active
  returning k.merchant_id into v_merchant;

  return v_merchant;
end;
$$;
revoke all on function verify_merchant_key(text) from public;
grant execute on function verify_merchant_key(text) to service_role;

create or replace function revoke_merchant_api_key(p_key_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_territory uuid;
begin
  select m.territory_id into v_territory
    from merchant_api_keys k join merchants m on m.id = k.merchant_id
   where k.id = p_key_id;
  if not staff_sees(v_territory) then
    raise exception 'That key is not yours to revoke' using errcode = 'insufficient_privilege';
  end if;
  update merchant_api_keys set revoked_at = now() where id = p_key_id and revoked_at is null;
end;
$$;
revoke all on function revoke_merchant_api_key(uuid) from public;
grant execute on function revoke_merchant_api_key(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What an order carries when it came in over the API.
-- ---------------------------------------------------------------------------
alter table orders
  add column if not exists merchant_id        uuid references merchants (id),
  add column if not exists merchant_reference text,
  add column if not exists tracking_token     text;

create unique index if not exists orders_tracking_token_uniq on orders (tracking_token);
-- One Servd order is one ServdGo order, however many times they retry the call.
create unique index if not exists orders_merchant_reference_uniq
  on orders (merchant_id, merchant_reference)
  where merchant_id is not null and merchant_reference is not null;
create index if not exists orders_merchant_idx on orders (merchant_id);

comment on column orders.tracking_token is
  'Unguessable token behind the public tracking link handed to the diner. No login.';

-- ---------------------------------------------------------------------------
-- Access. Restaurants are the operator's own records; the API reaches them on
-- the service role, never with a user's rights.
-- ---------------------------------------------------------------------------
grant select on merchants to authenticated;
grant all on merchants, merchant_api_keys to service_role;
grant insert, update on merchants to authenticated;
alter table merchants enable row level security;
alter table merchant_api_keys enable row level security;

create policy merchants_staff on merchants
  for all using (staff_sees(territory_id)) with check (staff_sees(territory_id));

-- Reaching a restaurant's territory has to be a security definer function, not
-- an inline subselect. A subselect inside a policy runs under the *caller's*
-- own RLS, so another city's merchant row comes back invisible — as NULL — and
-- staff_sees(null) is permissive by design, which would hand every operator
-- every other city's keys.
create or replace function staff_sees_merchant(p_merchant uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from merchants m where m.id = p_merchant and staff_sees(m.territory_id)
  );
$$;
revoke all on function staff_sees_merchant(uuid) from public;
grant execute on function staff_sees_merchant(uuid) to anon, authenticated;

-- Keys are readable so the console can list and revoke them; the hash is what
-- makes that safe, and nothing here can turn one back into a key.
grant select on merchant_api_keys to authenticated;
create policy merchant_api_keys_staff on merchant_api_keys
  for select using (staff_sees_merchant(merchant_id));

-- ---------------------------------------------------------------------------
-- An order now has two possible placers, and exactly one of them.
--
-- orders.customer_id was NOT NULL because until now every order came from
-- somebody holding the customer app. A Servd restaurant is not a customer — it
-- has no account, no saved addresses and no order history of its own — so
-- inventing a customer row for it would put a fiction in the one table the
-- operator reads to answer "who ordered this".
-- ---------------------------------------------------------------------------
alter table orders alter column customer_id drop not null;
alter table orders
  add constraint orders_has_a_placer
  check (customer_id is not null or merchant_id is not null);
