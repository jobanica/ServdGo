-- ServdGo — the endpoints behind the Servd door.
--
-- The logic lives here rather than in the edge functions so that pricing,
-- routing and authorisation are testable without a deployed runtime, and so a
-- second caller (a second partner, the console, a script) cannot drift from the
-- first. The edge functions are thin: authenticate the key, call one of these,
-- return the JSON.
--
-- All of them run as SECURITY DEFINER and take the merchant id resolved by
-- verify_merchant_key(), never a merchant id supplied by the caller.

/**
 * What would this delivery cost, and can anyone actually take it?
 *
 * Mirrors the fee maths the customer app uses — the per-km model bills the
 * pickup-to-drop-off leg, anything else is the flat fee — so a restaurant is
 * quoted the same number a customer would be.
 */
create or replace function merchant_quote(
  p_merchant uuid,
  p_dropoff_lat double precision,
  p_dropoff_lng double precision
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m           merchants;
  t           territories;
  v_km        numeric;
  v_fee       numeric;
  v_conv      numeric;
  v_riders    int;
  v_reason    text;
begin
  select * into m from merchants where id = p_merchant;
  if m.id is null then
    raise exception 'unknown merchant' using errcode = 'no_data_found';
  end if;
  if m.pickup_lat is null or m.pickup_lng is null then
    raise exception 'This restaurant has no pickup location set'
      using errcode = 'check_violation';
  end if;
  if p_dropoff_lat is null or p_dropoff_lng is null then
    raise exception 'A drop-off location is required' using errcode = 'check_violation';
  end if;

  select * into t from territories where id = m.territory_id;
  if t.id is null then
    return jsonb_build_object(
      'serviceable', false,
      'reason', 'This restaurant is outside every area we deliver to.');
  end if;

  v_km := round(km_between(m.pickup_lat, m.pickup_lng, p_dropoff_lat, p_dropoff_lng)::numeric, 2);

  -- The drop-off has to be inside the restaurant's own city, the same rule an
  -- order placed in the app is held to.
  if t.service_radius_km > 0
     and km_between(t.service_center_lat, t.service_center_lng, p_dropoff_lat, p_dropoff_lng) > t.service_radius_km then
    return jsonb_build_object(
      'serviceable', false,
      'territory', t.id, 'territoryName', t.name,
      'distanceKm', v_km,
      'reason', format('That drop-off is outside the %s km area we deliver to.', t.service_radius_km));
  end if;

  if t.delivery_fee_model = 'per_km' then
    v_fee := round(t.delivery_base_fare + t.delivery_per_km * greatest(0, v_km - t.delivery_base_km), 2);
  else
    v_fee := round(t.default_delivery_fee, 2);
  end if;

  -- Padala shaped: one pickup, so no per-store add-on. The convenience fee is
  -- the rider's in full and never enters the commission base.
  v_conv := round(coalesce(nullif(t.convenience_fee_padala, 0), t.convenience_fee, 0), 2);

  select count(*) into v_riders
    from riders r
   where r.territory_id = t.id
     and r.application_status = 'approved'
     and r.is_online
     and not r.is_suspended
     and not r.is_locked;

  v_reason := case
    when t.status <> 'active' then 'This area is not open for orders.'
    when not t.is_open then coalesce(nullif(btrim(t.closed_message), ''), 'We are closed at the moment.')
    when not t.service_padala then 'Courier deliveries are switched off in this area.'
    else null
  end;

  return jsonb_build_object(
    'serviceable', v_reason is null,
    'reason', v_reason,
    'territory', t.id,
    'territoryName', t.name,
    'currency', 'PHP',
    'distanceKm', v_km,
    'deliveryFee', v_fee,
    'convenienceFee', v_conv,
    'total', round(v_fee + v_conv, 2),
    'payer', 'diner',
    'availability', jsonb_build_object(
      'ridersOnline', v_riders,
      'accepting', v_reason is null
    ));
end;
$$;
revoke all on function merchant_quote(uuid, double precision, double precision) from public;
grant execute on function merchant_quote(uuid, double precision, double precision) to service_role;

/**
 * Book it.
 *
 * Idempotent on the restaurant's own reference: Servd retrying a call that
 * already succeeded gets the same order back rather than a second rider turning
 * up. The fee is recomputed here rather than accepted from the caller — a quote
 * is a quote, not an instruction.
 */
create or replace function merchant_book(
  p_merchant       uuid,
  p_reference      text,
  p_dropoff_lat    double precision,
  p_dropoff_lng    double precision,
  p_dropoff_address text,
  p_recipient_name text,
  p_recipient_contact text,
  p_notes          text default null,
  p_item_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m        merchants;
  q        jsonb;
  v_order  uuid;
  v_token  text;
  v_commission numeric;
  v_rate   numeric;
begin
  select * into m from merchants where id = p_merchant;
  if m.id is null then
    raise exception 'unknown merchant' using errcode = 'no_data_found';
  end if;
  if nullif(btrim(coalesce(p_reference, '')), '') is null then
    raise exception 'A reference is required so a retry cannot book twice'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_dropoff_address, '')), '') is null then
    raise exception 'A drop-off address is required — the pin gets the rider to the street, the address gets them to the door'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_recipient_contact, '')), '') is null then
    raise exception 'A contact number for the recipient is required'
      using errcode = 'check_violation';
  end if;

  -- Already booked? Hand back what exists.
  select o.id, o.tracking_token into v_order, v_token
    from orders o
   where o.merchant_id = p_merchant and o.merchant_reference = p_reference;
  if v_order is not null then
    return merchant_order_view(v_order) || jsonb_build_object('duplicate', true);
  end if;

  q := merchant_quote(p_merchant, p_dropoff_lat, p_dropoff_lng);
  if not (q ->> 'serviceable')::boolean then
    raise exception '%', coalesce(q ->> 'reason', 'We cannot deliver that right now.')
      using errcode = 'check_violation';
  end if;

  select commission_rate into v_rate from territories where id = m.territory_id;
  -- One pickup, so no per-store add-on; the convenience fee is not commissioned.
  v_commission := round((q ->> 'deliveryFee')::numeric * coalesce(v_rate, 0), 2);
  v_token := random_token();

  insert into orders (
    customer_id, merchant_id, merchant_reference, tracking_token,
    service_type, status, payment_method, payment_status, padala_fee_payer,
    delivery_fee, convenience_fee, commission_amount,
    pickup_lat, pickup_lng, pickup_address, pickup_contact,
    delivery_lat, delivery_lng, delivery_address,
    dropoff_lat, dropoff_lng, dropoff_contact,
    customer_name, customer_contact, recipient_name, recipient_contact,
    item_description, notes, territory_id
  ) values (
    null, p_merchant, btrim(p_reference), v_token,
    'padala', 'pending', 'cod', 'unpaid', 'receiver',
    (q ->> 'deliveryFee')::numeric, (q ->> 'convenienceFee')::numeric, v_commission,
    m.pickup_lat, m.pickup_lng, m.pickup_address, m.contact_number,
    p_dropoff_lat, p_dropoff_lng, btrim(p_dropoff_address),
    p_dropoff_lat, p_dropoff_lng, nullif(btrim(p_recipient_contact), ''),
    m.name, m.contact_number,
    nullif(btrim(p_recipient_name), ''), nullif(btrim(p_recipient_contact), ''),
    nullif(btrim(coalesce(p_item_description, 'Food order')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    m.territory_id
  )
  returning id into v_order;

  return merchant_order_view(v_order) || jsonb_build_object('duplicate', false);
end;
$$;
revoke all on function merchant_book(uuid, text, double precision, double precision, text, text, text, text, text) from public;
grant execute on function merchant_book(uuid, text, double precision, double precision, text, text, text, text, text) to service_role;

/**
 * One order, as the restaurant sees it. The rider's name and number appear once
 * somebody has accepted it — that is the whole point of the callback.
 */
create or replace function merchant_order_view(p_order uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'orderId', o.id,
    'reference', o.merchant_reference,
    'status', o.status,
    'trackingToken', o.tracking_token,
    'currency', 'PHP',
    'deliveryFee', o.delivery_fee,
    'convenienceFee', o.convenience_fee,
    'total', round(o.delivery_fee + o.convenience_fee, 2),
    'payer', 'diner',
    'pickup', jsonb_build_object('address', o.pickup_address, 'lat', o.pickup_lat, 'lng', o.pickup_lng),
    'dropoff', jsonb_build_object('address', o.delivery_address, 'lat', o.delivery_lat, 'lng', o.delivery_lng),
    'recipient', jsonb_build_object('name', o.recipient_name, 'contact', o.recipient_contact),
    'rider', case when r.id is null then null else jsonb_build_object(
      'name', r.name, 'contact', r.mobile_number, 'vehicle', r.vehicle) end,
    'placedAt', o.created_at,
    'arrivedAt', o.arrived_at,
    'deliveredAt', o.delivered_at
  )
  from orders o
  left join riders r on r.id = o.rider_id
  where o.id = p_order;
$$;
revoke all on function merchant_order_view(uuid) from public;
grant execute on function merchant_order_view(uuid) to service_role;

/** The same view, looked up the way a restaurant holds it, and scoped to them. */
create or replace function merchant_order_status(p_merchant uuid, p_reference text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_order uuid;
begin
  select id into v_order from orders
   where merchant_id = p_merchant and merchant_reference = p_reference;
  if v_order is null then
    raise exception 'no such order' using errcode = 'no_data_found';
  end if;
  return merchant_order_view(v_order);
end;
$$;
revoke all on function merchant_order_status(uuid, text) from public;
grant execute on function merchant_order_status(uuid, text) to service_role;

/**
 * The public tracking link: one URL to hand the diner, no login.
 *
 * Deliberately narrower than the merchant view. It answers "where is my food"
 * and nothing else — no merchant reference, no internal ids, and none of the
 * restaurant's own contact details.
 */
create or replace function track_merchant_order(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'status', o.status,
    'placedAt', o.created_at,
    'arrivedAt', o.arrived_at,
    'deliveredAt', o.delivered_at,
    'from', m.name,
    'dropoffAddress', o.delivery_address,
    'amountDue', round(o.delivery_fee + o.convenience_fee, 2),
    'currency', 'PHP',
    'rider', case when r.id is null then null else jsonb_build_object(
      'name', r.name, 'contact', r.mobile_number, 'vehicle', r.vehicle) end
  )
  from orders o
  join merchants m on m.id = o.merchant_id
  left join riders r on r.id = o.rider_id
  where o.tracking_token = p_token
    and nullif(btrim(p_token), '') is not null;
$$;
revoke all on function track_merchant_order(text) from public;
grant execute on function track_merchant_order(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The barangay list is a customer-app control, not a delivery rule.
--
-- A merchant booking has no barangay to declare — Servd's diner never saw the
-- dropdown — and the restaurant's own pin has already decided the city. The
-- distance guard still applies, and merchant_quote() refuses an out-of-area
-- drop-off before a booking is ever attempted.
-- ---------------------------------------------------------------------------
create or replace function enforce_service_area()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_any     int;
  v_lat     double precision;
  v_lng     double precision;
  v_radius  numeric;
  v_km      double precision;
begin
  if is_staff() then
    return new;
  end if;

  if new.territory_id is null
     and exists (select 1 from territories where status = 'active' and service_radius_km > 0) then
    raise exception 'Sorry, that location is outside every area we deliver to.'
      using errcode = 'check_violation';
  end if;

  if new.merchant_id is null then
    select count(*) into v_any
      from service_areas
     where is_active
       and (territory_id is null or territory_id = new.territory_id);

    if v_any > 0 then
      if new.area_barangay is null or btrim(new.area_barangay) = '' then
        raise exception 'Please choose your delivery area before ordering.'
          using errcode = 'check_violation';
      end if;
      if not exists (
        select 1 from service_areas
        where is_active
          and (territory_id is null or territory_id = new.territory_id)
          and lower(btrim(province)) = lower(btrim(coalesce(new.area_province, '')))
          and lower(btrim(city))     = lower(btrim(coalesce(new.area_city, '')))
          and lower(btrim(barangay)) = lower(btrim(new.area_barangay))
      ) then
        raise exception 'Sorry, we do not deliver to % yet.', new.area_barangay
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  select service_center_lat, service_center_lng, service_radius_km
    into v_lat, v_lng, v_radius
  from territories where id = new.territory_id;

  if v_lat is not null and v_lng is not null and coalesce(v_radius, 0) > 0
     and new.delivery_lat is not null and new.delivery_lng is not null then
    v_km := km_between(v_lat, v_lng, new.delivery_lat, new.delivery_lng);
    if v_km > v_radius then
      raise exception 'That drop-off is about % km away, outside our % km delivery area. Please pin a location we serve.',
        round(v_km::numeric, 1), v_radius using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- Likewise the name guard: a merchant booking is placed by a restaurant, and
-- the name on it is the restaurant's, filled in by merchant_book().
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

  if nullif(btrim(coalesce(new.customer_name, '')), '') is null and new.customer_id is not null then
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
