-- ServdGo — "That restaurant has no territory yet" told nobody anything.
--
-- A restaurant's city is never set by hand: fill_merchant_territory() derives it
-- from the pickup pin, and territory_for_point() only matches a city that is
-- live AND has a boundary drawn (a centre and a radius above zero). So a null
-- territory means one of three things, and the operator seeing the message can
-- act on none of them:
--
--   the pin sits outside every live city
--   the city it should belong to has no boundary drawn yet
--   the city is not live
--
-- The first city this project ever creates is seeded with no boundary at all
-- (0077) and is live from birth, which is precisely the case that produced this
-- message on somebody's first attempt. Say which, and say who can fix it.
--
-- Also: the old check let the franchisor through with a null territory. A key
-- for a restaurant that routes nowhere cannot quote, cannot book, and cannot be
-- told apart from a working one — so it is refused for everybody now.

create or replace function create_merchant_api_key(p_merchant uuid, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key       text;
  v_territory uuid;
  v_lat       double precision;
  v_lng       double precision;
  v_name      text;
  v_live      int;
begin
  select territory_id, pickup_lat, pickup_lng, name
    into v_territory, v_lat, v_lng, v_name
    from merchants where id = p_merchant;
  if v_name is null then
    raise exception 'No such restaurant' using errcode = 'no_data_found';
  end if;

  if v_territory is null then
    select count(*) into v_live from territories
     where status = 'live' and service_radius_km > 0
       and service_center_lat is not null and service_center_lng is not null;

    if v_lat is null or v_lng is null then
      raise exception '% has no pickup pin, and the pin is what puts it in a city. Add one on the restaurant first.',
        v_name using errcode = 'check_violation';
    elsif v_live = 0 then
      raise exception 'No city has a boundary drawn yet, so no pin can land in one. The franchisor draws it under Territories → the city → Territory.'
        using errcode = 'check_violation';
    else
      raise exception '%''s pickup pin is not inside any live city. Move the pin, or have the franchisor widen the city''s boundary to cover it.',
        v_name using errcode = 'check_violation';
    end if;
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
 * Re-derive a restaurant's city from its pin.
 *
 * The pin is stamped on insert, so a restaurant added before its city had a
 * boundary keeps a null territory forever — until somebody moves the pin. This
 * is the "the boundary exists now, try again" button.
 */
create or replace function refresh_merchant_territory(p_merchant uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory uuid;
  v_lat double precision;
  v_lng double precision;
begin
  select pickup_lat, pickup_lng into v_lat, v_lng from merchants where id = p_merchant;
  if v_lat is null then
    raise exception 'That restaurant has no pickup pin' using errcode = 'check_violation';
  end if;

  v_territory := territory_for_point(v_lat, v_lng);
  if v_territory is null then
    raise exception 'That pin is still not inside any live city with a boundary'
      using errcode = 'check_violation';
  end if;
  if not staff_sees(v_territory) then
    raise exception 'That pin is in a city you do not run' using errcode = 'insufficient_privilege';
  end if;

  update merchants set territory_id = v_territory where id = p_merchant;
  return v_territory;
end;
$$;
revoke all on function refresh_merchant_territory(uuid) from public;
grant execute on function refresh_merchant_territory(uuid) to authenticated;
