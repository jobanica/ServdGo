-- Who to ask for at a saved address, and what number to ring.
--
-- An address is a place, but a delivery needs a person. The customer's own name
-- and number are the right default — and often wrong for the address they
-- labelled "Mama's" or "Office", where the rider should be asking for someone
-- else entirely.
--
-- Kept on the address so choosing one at checkout fills the whole doorstep in
-- a tap: place, person, number.
alter table customer_addresses
  add column if not exists contact_name  text,
  add column if not exists contact_phone text;

comment on column customer_addresses.contact_name is
  'Who the rider asks for here. Null falls back to the customer''s own name.';
comment on column customer_addresses.contact_phone is
  'Number to ring for this address. Null falls back to the customer''s own.';

-- Seed the existing ones from the customer they belong to, so a saved address
-- fills the form from the first order rather than the second.
update customer_addresses a
   set contact_name  = coalesce(a.contact_name, nullif(btrim(c.name), '')),
       contact_phone = coalesce(a.contact_phone, nullif(btrim(c.mobile_number), ''))
  from customers c
 where c.id = a.customer_id
   and (a.contact_name is null or a.contact_phone is null)
   and c.mobile_number <> 'unknown';
