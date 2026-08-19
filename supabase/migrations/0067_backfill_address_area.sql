-- Teach the old saved addresses which barangay they're in.
--
-- Addresses saved before the area picker existed carry a pin and a written
-- address but no province/city/barangay. Choosing one at checkout was supposed
-- to spare the customer every decision, and instead it still left "Choose your
-- delivery area" blocking the button — on every order, forever.
--
-- The answer is already in their own order history: a delivered order pinned at
-- the same spot names the area the customer themselves chose. Match an address
-- to that customer's nearest order pin within 150 m — close enough to be the
-- same doorstep, far too close to be the next barangay.
with candidate as (
  select distinct on (a.id)
    a.id,
    o.area_province, o.area_city, o.area_barangay,
    6371000 * 2 * asin(sqrt(
      power(sin(radians(o.delivery_lat - a.lat) / 2), 2)
      + cos(radians(a.lat)) * cos(radians(o.delivery_lat))
        * power(sin(radians(o.delivery_lng - a.lng) / 2), 2))) as metres
  from customer_addresses a
  join orders o
    on o.customer_id = a.customer_id
   and o.delivery_lat is not null
   and o.delivery_lng is not null
   and o.area_province is not null
   and o.area_city is not null
   and o.area_barangay is not null
  where a.lat is not null
    and a.lng is not null
    and (a.province is null or a.city is null or a.barangay is null)
  order by a.id, metres
)
update customer_addresses a
   set province  = c.area_province,
       city      = c.area_city,
       barangay  = c.area_barangay
  from candidate c
 where c.id = a.id
   and c.metres <= 150;

-- Anything left over (no matching order, or no pin at all) is asked once at the
-- next checkout and written back from the app — see useAreaBackfill.
