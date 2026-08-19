-- ServdGo — rebrand from "Easy Buy Delivery".
--
-- The trading name lives in two places the database owns: the fallback text a
-- customer sees when the platform is closed, baked into the order guard, and
-- any custom closed_message the operator typed by hand. Everything else is in
-- the apps.
--
-- Migrations 0001-0075 are left as they were written. They are the applied
-- ledger of what already ran against the live database — rewriting the old
-- brand name into them would change nothing in Postgres and lose the record of
-- what was actually deployed. 0063 is where the old fallback came from; this
-- migration supersedes it.

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
  -- New orders only. Admin-placed orders go through the same door, on purpose:
  -- if the operator wants to take one while closed, they reopen first.
  select is_open, nullif(btrim(coalesce(closed_message, '')), '')
    into v_open, v_msg
    from app_settings where id = true;
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

-- The trigger already points at this function; recreating it is not needed.

-- Rewrite a closed_message the operator typed under the old name. Idempotent:
-- once no row mentions the old brand, this matches nothing on a re-run.
update app_settings
   set closed_message = replace(closed_message, 'Easy Buy Delivery', 'ServdGo')
 where closed_message like '%Easy Buy Delivery%';

update app_settings
   set closed_message = replace(closed_message, 'Easy Buy', 'ServdGo')
 where closed_message like '%Easy Buy%';
