-- A name is required to place an order.
--
-- The apps ask for one now, but a client is not where a rule like this belongs:
-- an order with no name reaches a rider who has to stand at a gate and ask for
-- "the person who ordered". The trigger already filled the name from the
-- customer's saved profile; now it refuses the insert when there is still
-- nothing to fill it with.
--
-- Existing customers who never gave a name are prompted by the apps on their
-- next order, which saves it to their profile before the insert — so this
-- affects nobody who is using a current build.
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

  return new;
end;
$$;

drop trigger if exists trg_order_customer_name on orders;
create trigger trg_order_customer_name
  before insert on orders
  for each row
  execute function fill_order_customer_name();
