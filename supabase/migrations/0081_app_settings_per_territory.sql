-- ServdGo — app_settings stops being one row and becomes one row per territory.
--
-- The apps read fees, hours and payout details through a single `app_settings`
-- row. Rather than rewrite every one of those call sites, the physical table is
-- split: what is genuinely platform-wide stays behind in platform_settings, and
-- app_settings becomes a view onto the caller's own territory. A rider in Cebu
-- and a rider in Davao issue the identical query and each get their own city's
-- numbers.
--
-- The view is updatable, so the admin settings screen keeps working and writes
-- land on the territory the operator runs.

alter table app_settings rename to platform_settings;
alter table platform_settings rename constraint app_settings_commission_band to platform_settings_commission_band;

-- Everything below now lives on territories, seeded there by 0077.
alter table platform_settings
  drop column is_open,
  drop column schedule,
  drop column default_delivery_fee,
  drop column per_store_fee,
  drop column convenience_fee,
  drop column commission_rate,
  drop column delivery_fee_model,
  drop column convenience_fee_mode,
  drop column settlement_cutoff,
  drop column sms_notify_stores,
  drop column delivery_base_fare,
  drop column delivery_base_km,
  drop column delivery_per_km,
  drop column service_food,
  drop column service_pabili,
  drop column service_padala,
  drop column max_active_orders_per_rider,
  drop column settlement_gcash_number,
  drop column settlement_gcash_name,
  drop column settlement_qr_url,
  drop column convenience_fee_food,
  drop column convenience_fee_pabili,
  drop column convenience_fee_padala,
  drop column service_center_lat,
  drop column service_center_lng,
  drop column service_radius_km,
  drop column closed_message,
  drop column markup_operator_share;

comment on table platform_settings is
  'Franchisor-wide settings. Anything a city can differ on lives on territories.';

-- The band is not a secret — the operator settings screen shows the limits it is
-- being held to — but only the franchisor may move it.
drop policy if exists app_settings_admin_write on platform_settings;
drop policy if exists app_settings_read on platform_settings;

create policy platform_settings_read on platform_settings
  for select using (true);

create policy platform_settings_franchisor_write on platform_settings
  for all using (is_franchisor()) with check (is_franchisor());

grant select on platform_settings to anon, authenticated;
grant update on platform_settings to authenticated;

-- ---------------------------------------------------------------------------
-- The compatibility view: one settings row, resolved per caller.
-- security_invoker keeps the caller's own RLS on territories in force, so this
-- is not a way around the boundary drawn in 0080.
-- ---------------------------------------------------------------------------
create view app_settings with (security_invoker = true) as
select
  true                          as id,
  t.id                          as territory_id,
  t.name                        as territory_name,
  t.is_open,
  t.closed_message,
  t.schedule,
  t.settlement_cutoff,
  t.commission_rate,
  t.markup_operator_share,
  t.default_delivery_fee,
  t.per_store_fee,
  t.delivery_fee_model,
  t.delivery_base_fare,
  t.delivery_base_km,
  t.delivery_per_km,
  t.convenience_fee,
  t.convenience_fee_mode,
  t.convenience_fee_food,
  t.convenience_fee_pabili,
  t.convenience_fee_padala,
  t.service_food,
  t.service_pabili,
  t.service_padala,
  t.max_active_orders_per_rider,
  t.sms_notify_stores,
  t.settlement_gcash_number,
  t.settlement_gcash_name,
  t.settlement_qr_url,
  t.service_center_lat,
  t.service_center_lng,
  t.service_radius_km,
  p.commission_rate_min,
  p.commission_rate_max,
  greatest(p.updated_at, t.updated_at) as updated_at
from platform_settings p
left join territories t on t.id = effective_territory_id()
where p.id = true;

comment on view app_settings is
  'The caller''s territory settings, shaped like the single row the apps were written against.';

grant select on app_settings to anon, authenticated;
grant update on app_settings to authenticated;

create or replace function app_settings_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
begin
  v_territory := coalesce(new.territory_id, effective_territory_id());
  if v_territory is null then
    raise exception 'No territory in context — a settings change has to say which city it is for.'
      using errcode = 'check_violation';
  end if;

  if not (is_franchisor() or (is_staff() and v_territory = current_territory_id())) then
    raise exception 'You can only change the settings of your own territory'
      using errcode = 'insufficient_privilege';
  end if;

  update territories set
    is_open                     = new.is_open,
    closed_message              = new.closed_message,
    schedule                    = new.schedule,
    settlement_cutoff           = new.settlement_cutoff,
    commission_rate             = new.commission_rate,
    markup_operator_share       = new.markup_operator_share,
    default_delivery_fee        = new.default_delivery_fee,
    per_store_fee               = new.per_store_fee,
    delivery_fee_model          = new.delivery_fee_model,
    delivery_base_fare          = new.delivery_base_fare,
    delivery_base_km            = new.delivery_base_km,
    delivery_per_km             = new.delivery_per_km,
    convenience_fee             = new.convenience_fee,
    convenience_fee_mode        = new.convenience_fee_mode,
    convenience_fee_food        = new.convenience_fee_food,
    convenience_fee_pabili      = new.convenience_fee_pabili,
    convenience_fee_padala      = new.convenience_fee_padala,
    service_food                = new.service_food,
    service_pabili              = new.service_pabili,
    service_padala              = new.service_padala,
    max_active_orders_per_rider = new.max_active_orders_per_rider,
    sms_notify_stores           = new.sms_notify_stores,
    settlement_gcash_number     = new.settlement_gcash_number,
    settlement_gcash_name       = new.settlement_gcash_name,
    settlement_qr_url           = new.settlement_qr_url,
    service_center_lat          = new.service_center_lat,
    service_center_lng          = new.service_center_lng,
    service_radius_km           = new.service_radius_km
  where id = v_territory;

  -- The band moves only for the franchisor; an operator's settings save leaves
  -- it exactly as it was rather than failing.
  if is_franchisor()
     and (new.commission_rate_min is distinct from old.commission_rate_min
          or new.commission_rate_max is distinct from old.commission_rate_max) then
    update platform_settings
       set commission_rate_min = new.commission_rate_min,
           commission_rate_max = new.commission_rate_max,
           updated_at = now()
     where id = true;
  end if;

  return new;
end;
$$;

create trigger app_settings_instead_of_update
  instead of update on app_settings
  for each row execute function app_settings_write();

-- ---------------------------------------------------------------------------
-- What both apps ask on launch, now answered for the caller's own city.
-- ---------------------------------------------------------------------------
create or replace function platform_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'open', coalesce(t.is_open, false),
    'message', nullif(btrim(coalesce(t.closed_message, '')), ''),
    'territory', t.id,
    'territoryName', t.name,
    'outstanding', (select count(*) from orders o
                     where o.status not in ('delivered', 'cancelled')
                       and o.territory_id is not distinct from t.id),
    'unassigned', (select count(*) from orders o
                    where o.status = 'pending' and o.rider_id is null
                      and o.territory_id is not distinct from t.id)
  )
  from territories t
  where t.id = effective_territory_id();
$$;

revoke all on function platform_status() from public;
grant execute on function platform_status() to anon, authenticated;

-- The closed-platform guard reads the order's own territory rather than a global
-- switch, so one city closing does not shut the others.
create or replace function fill_order_customer_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open boolean;
  v_msg  text;
begin
  select t.is_open, nullif(btrim(coalesce(t.closed_message, '')), '')
    into v_open, v_msg
    from territories t where t.id = new.territory_id;

  if v_open is false then
    raise exception '%', coalesce(v_msg,
      'ServdGo is closed at the moment, so we can''t take new orders. Please try again later.')
      using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(new.customer_name, '')), '') is null then
    select nullif(btrim(c.name), '')
      into new.customer_name
      from customers c
      where c.id = new.customer_id;
  end if;

  if nullif(btrim(coalesce(new.customer_name, '')), '') is null then
    raise exception 'Please add your name before placing an order — your rider needs to know who to hand it to.'
      using errcode = 'check_violation';
  end if;

  if new.delivery_lat is null or new.delivery_lng is null then
    raise exception 'Please pin your delivery location on the map before placing an order.'
      using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(new.delivery_address, '')), '') is null then
    raise exception 'Please give your complete delivery address — the pin gets your rider to the street, the address gets them to your door.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- A suspended or draft territory takes no new orders, whoever asks.
create or replace function reject_orders_outside_active_territory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_status territory_status;
begin
  select status into v_status from territories where id = new.territory_id;
  if v_status is not null and v_status <> 'active' then
    raise exception 'This delivery area is not currently open for orders.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_active_territory on orders;
create trigger orders_active_territory
  before insert on orders
  for each row execute function reject_orders_outside_active_territory();
