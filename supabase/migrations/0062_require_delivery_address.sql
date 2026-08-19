-- An order needs somewhere to go.
--
-- The food checkout only asked for a pin and a written address under distance
-- pricing — on a flat rate, a non-gift order could be placed with neither, and
-- 151 food orders are on record with no written address at all. The rider gets
-- a phone number and a guess.
--
-- The apps ask for both now, but the same reasoning as the name applies: a rule
-- about what an order *is* belongs next to the orders, not in one client.
--
-- Written address AND pin: the pin gets the rider to the street, the address
-- gets them to the door, and neither substitutes for the other when a pin lands
-- on the wrong house.
create or replace function fill_order_customer_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

drop trigger if exists trg_order_customer_name on orders;
create trigger trg_order_customer_name
  before insert on orders
  for each row
  execute function fill_order_customer_name();
