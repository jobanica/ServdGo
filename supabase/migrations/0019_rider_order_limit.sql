-- Limit how many active orders a single rider may hold at once (admin setting).
--
-- 0 means unlimited (default, so existing behaviour is unchanged). A positive
-- value caps a rider's in-progress orders — anything not yet delivered or
-- cancelled counts. Enforced by a BEFORE UPDATE trigger at the moment a rider
-- claims an order, so it's atomic and can't be raced or bypassed by the client.
alter table app_settings
  add column if not exists max_active_orders_per_rider int not null default 0;

create or replace function enforce_rider_order_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lim int;
  cnt int;
begin
  -- Only when a rider is being newly assigned to this order (a claim), and not
  -- an admin override.
  if new.rider_id is not null
     and new.rider_id is distinct from old.rider_id
     and not public.is_admin() then
    select max_active_orders_per_rider into lim from app_settings where id = true;
    if lim is not null and lim > 0 then
      select count(*) into cnt
        from orders
        where rider_id = new.rider_id
          and status not in ('delivered', 'cancelled')
          and id <> new.id;
      if cnt >= lim then
        raise exception 'Order limit reached — you may hold at most % active order(s) at a time. Finish a delivery first.', lim
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_rider_order_limit on orders;
create trigger trg_rider_order_limit
  before update on orders
  for each row
  execute function enforce_rider_order_limit();
