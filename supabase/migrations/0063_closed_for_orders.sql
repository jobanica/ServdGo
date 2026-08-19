-- Closing the platform has to actually close it.
--
-- app_settings.is_open has been there since the first schema and nothing ever
-- read it: the admin could flip the switch and customers kept ordering. The
-- toggle is now enforced where orders are created, so it holds however the
-- order was placed.
--
-- Closing stops NEW orders only. Everything already in the queue is finished:
-- riders keep accepting from the pool, keep delivering, keep settling. A
-- closed sign on the door doesn't turn out the customers already inside.
alter table app_settings
  add column if not exists closed_message text;

comment on column app_settings.closed_message is
  'Shown to customers and riders while is_open is false. Null uses the default wording.';

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
      'Easy Buy Delivery is closed at the moment, so we can''t take new orders. Please try again later.')
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

drop trigger if exists trg_order_customer_name on orders;
create trigger trg_order_customer_name
  before insert on orders
  for each row
  execute function fill_order_customer_name();

-- ---------------------------------------------------------------------------
-- What both apps ask on launch.
--
-- Returns whether we're open, what to say when we aren't, and how much work is
-- still outstanding — the last one is what keeps the rider app usable while the
-- queue drains, and tells the operator when the shutters can really come down.
-- ---------------------------------------------------------------------------
create or replace function platform_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'open', s.is_open,
    'message', nullif(btrim(coalesce(s.closed_message, '')), ''),
    -- Orders neither delivered nor cancelled: the queue that must drain first.
    'outstanding', (select count(*) from orders o where o.status not in ('delivered', 'cancelled')),
    'unassigned', (select count(*) from orders o
                    where o.status = 'pending' and o.rider_id is null)
  )
  from app_settings s where s.id = true;
$$;

revoke all on function platform_status() from public;
grant execute on function platform_status() to anon, authenticated;
