-- Expose the assigned rider's name/contact/photo to the order's own customer
-- (sender), for the live-tracking courier card. SECURITY DEFINER, scoped to an
-- order the caller placed and only once a rider is assigned.
create or replace function order_rider_info(p_order_id uuid)
returns table(name text, mobile_number text, photo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select r.name, r.mobile_number, r.photo_url
  from orders o
  join riders r on r.id = o.rider_id
  where o.id = p_order_id
    and o.customer_id = current_customer_id()
    and o.rider_id is not null;
$$;

revoke all on function order_rider_info(uuid) from public;
grant execute on function order_rider_info(uuid) to authenticated;
