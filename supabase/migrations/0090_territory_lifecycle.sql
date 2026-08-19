-- ServdGo — the franchisee lifecycle: seven states, not three.
--
-- A city goes lead → applied → approved → onboarding → live, and can be
-- suspended or terminated from anywhere after that. The three states that
-- existed map onto the new pipeline rather than sitting beside it:
--
--   draft  → onboarding   (an operator is appointed, a boundary is being drawn)
--   active → live         (trading)
--   suspended             (unchanged)
--
-- Renaming rather than adding-and-migrating keeps every existing row correct
-- with no data movement. It does mean every place that compared against the old
-- labels has to be rewritten in the same migration — a renamed enum label makes
-- the old literal invalid at runtime, not at deploy time, so a missed one would
-- surface as a broken order hours later. The rewrites below are mechanical: the
-- function bodies are unchanged apart from the literal.
--
-- The four genuinely new labels are added but deliberately not *used* here —
-- not in a default, not in a literal. Postgres will not let a value added by
-- ALTER TYPE be used in the same transaction, and every migration runs in one.
-- The new default lives in 0097 for exactly that reason; the rewrites below are
-- safe because 'live' is a *renamed* label, not a new one.

alter type territory_status rename value 'draft' to 'onboarding';
alter type territory_status rename value 'active' to 'live';

-- Added in pipeline order so ordering by the enum sorts the funnel correctly.
alter type territory_status add value if not exists 'lead' before 'onboarding';
alter type territory_status add value if not exists 'applied' after 'lead';
alter type territory_status add value if not exists 'approved' after 'applied';
alter type territory_status add value if not exists 'terminated' after 'suspended';

comment on column territories.status is
  'lead → applied → approved → onboarding → live, plus suspended and terminated. Only the franchisor moves it (decision 5).';

-- ---------------------------------------------------------------------------
-- Everything that compared against 'active'.
-- ---------------------------------------------------------------------------
create or replace function public.effective_territory_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select territory_id from profiles where id = auth.uid()),
    (select t.id from territories t
      where t.status = 'live'
        and (select count(*) from territories where status = 'live') = 1)
  );
$function$;

create or replace function public.territory_for_point(p_lat double precision, p_lng double precision)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.id
  from territories t
  where t.status = 'live'
    and t.service_center_lat is not null
    and t.service_center_lng is not null
    and t.service_radius_km > 0
    and p_lat is not null and p_lng is not null
    and km_between(t.service_center_lat, t.service_center_lng, p_lat, p_lng) <= t.service_radius_km
  order by km_between(t.service_center_lat, t.service_center_lng, p_lat, p_lng)
  limit 1;
$function$;

create or replace function public.assign_order_territory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_territory uuid;
begin
  if new.territory_id is not null then
    return new;
  end if;

  if new.pickup_lat is not null and new.pickup_lng is not null then
    v_territory := territory_for_point(new.pickup_lat, new.pickup_lng);
  end if;

  -- No pickup pin (Food, or a Pabili where the customer named no shop): the
  -- drop-off stands in for it, and is checked against that territory's radius.
  if v_territory is null then
    v_territory := territory_for_point(
      coalesce(new.delivery_lat, new.dropoff_lat),
      coalesce(new.delivery_lng, new.dropoff_lng));
  end if;

  -- Single-city databases where no boundary has been drawn yet: everything
  -- belongs to the one active territory rather than to nothing.
  if v_territory is null then
    select t.id into v_territory
    from territories t
    where t.status = 'live'
      and (select count(*) from territories where status = 'live') = 1;
  end if;

  new.territory_id := v_territory;
  return new;
end;
$function$;

create or replace function public.enforce_service_area()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     and exists (select 1 from territories where status = 'live' and service_radius_km > 0) then
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
$function$;

create or replace function public.reject_orders_outside_active_territory()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_status territory_status;
begin
  select status into v_status from territories where id = new.territory_id;
  if v_status is not null and v_status <> 'live' then
    raise exception 'This delivery area is not currently open for orders.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

create or replace function public.approve_territory(p_territory uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t territories;
begin
  if not is_franchisor() then
    raise exception 'Only the franchisor can open a territory'
      using errcode = 'insufficient_privilege';
  end if;

  select * into t from territories where id = p_territory;
  if t.id is null then
    raise exception 'No such territory' using errcode = 'no_data_found';
  end if;

  if t.operator_profile_id is null then
    raise exception 'Appoint an operator before opening %', t.name
      using errcode = 'check_violation';
  end if;
  if t.service_center_lat is null or t.service_center_lng is null or t.service_radius_km <= 0 then
    raise exception 'Draw the boundary of % before opening it — without a radius nothing routes to it', t.name
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(t.settlement_gcash_number, '')), '') is null
     or nullif(btrim(coalesce(t.settlement_gcash_name, '')), '') is null then
    raise exception 'Set the settlement payout details for % — riders have nowhere to send commission', t.name
      using errcode = 'check_violation';
  end if;

  update territories set status = 'live' where id = p_territory;
end;
$function$;

create or replace function public.merchant_quote(p_merchant uuid, p_dropoff_lat double precision, p_dropoff_lng double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    when t.status <> 'live' then 'This area is not open for orders.'
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
$function$;
-- The public-read policy carried the literal too.
drop policy if exists territories_public_read on territories;
create policy territories_public_read on territories
  for select using (status = 'live' or staff_sees(id) or is_franchisor());
