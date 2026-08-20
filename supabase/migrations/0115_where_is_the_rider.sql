-- ServdGo — a tracking link that actually tracks.
--
-- A rider's position was only ever broadcast on a Realtime channel: live for a
-- customer app already listening, and nothing at all for anybody who opens the
-- link a minute later. rider_locations existed and was documented as "optional:
-- persist for replay/audit" — nothing ever wrote to it, so after a real
-- delivery there were zero rows and the tracking page had nothing to draw.
--
-- Broadcast is right for the customer app: no round trip, no storage. But a
-- link handed to a diner, or a partner polling our API, needs the last known
-- position to be a fact somebody can ask for. So the rider app now persists a
-- throttled fix alongside the broadcast, and both read paths expose it.

/**
 * Record where the rider is, for the order they are carrying.
 *
 * Security definer so the rider does not have to know their own rider id, and
 * so the caller cannot claim to be somebody else: the id comes from the session,
 * and the order must actually be theirs and still in flight. A position for a
 * delivered order is not tracking, it is a record of where somebody was.
 */
create or replace function record_rider_position(p_order uuid, p_lat double precision, p_lng double precision)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_rider uuid := current_rider_id();
begin
  if v_rider is null then
    raise exception 'not a rider' using errcode = 'insufficient_privilege';
  end if;
  if p_lat is null or p_lng is null then
    return;
  end if;
  if not exists (
    select 1 from orders
     where id = p_order and rider_id = v_rider
       and status in ('accepted', 'preparing', 'picked_up', 'on_the_way')
  ) then
    return;   -- not theirs, or over — quietly nothing, not an error
  end if;

  insert into rider_locations (rider_id, order_id, lat, lng)
  values (v_rider, p_order, p_lat, p_lng);
end;
$$;
revoke all on function record_rider_position(uuid, double precision, double precision) from public;
grant execute on function record_rider_position(uuid, double precision, double precision) to authenticated;

/** The rider's last known position on an order, or null. */
create or replace function last_rider_position(p_order uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('lat', l.lat, 'lng', l.lng, 'at', l.created_at)
    from rider_locations l
   where l.order_id = p_order
   order by l.created_at desc
   limit 1;
$$;
revoke all on function last_rider_position(uuid) from public;
grant execute on function last_rider_position(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Both read paths carry it now.
-- ---------------------------------------------------------------------------
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
    -- The rider now carries where they are, so a partner's own tracker can
    -- draw it without us streaming anything at them.
    'rider', case when r.id is null then null else jsonb_build_object(
      'name', r.name, 'contact', r.mobile_number, 'vehicle', r.vehicle,
      'position', last_rider_position(o.id)) end,
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
    -- Where it is going, so the page can draw the destination even before a
    -- rider has moved. Deliberately not the pickup: the diner knows where the
    -- restaurant is, and the restaurant's exact pin is not theirs to have.
    'dropoff', case when o.delivery_lat is null then null else
      jsonb_build_object('lat', o.delivery_lat, 'lng', o.delivery_lng) end,
    'rider', case when r.id is null then null else jsonb_build_object(
      'name', r.name, 'contact', r.mobile_number, 'vehicle', r.vehicle,
      'position', case when o.status in ('picked_up', 'on_the_way')
                       then last_rider_position(o.id) end) end
  )
  from orders o
  join merchants m on m.id = o.merchant_id
  left join riders r on r.id = o.rider_id
  where o.tracking_token = p_token
    and nullif(btrim(p_token), '') is not null;
$$;
revoke all on function track_merchant_order(text) from public;
grant execute on function track_merchant_order(text) to anon, authenticated, service_role;

comment on function track_merchant_order(text) is
  'The diner-facing view behind a tracking token. Carries the rider''s position only while they are actually carrying it.';
