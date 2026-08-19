-- The rider needs the customer's address in words, not just a pin.
--
-- A dropped pin can be off by a street, and when it is the rider has nothing to
-- go on — no house number, no landmark, nobody to ask for. Carry the written
-- address onto the order so they can knock on the right door or ask a neighbour.

alter table orders
  add column if not exists delivery_address text,
  add column if not exists pickup_address text;

comment on column orders.delivery_address is
  'Written drop-off address shown to the rider alongside the map pin.';
comment on column orders.pickup_address is
  'Written pickup address (pabili/padala), where the pin alone is not enough.';
