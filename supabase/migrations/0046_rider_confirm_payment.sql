-- Let the assigned rider confirm a GCash-to-rider payment.
--
-- The customer can upload a receipt in the app, but plenty will simply show it
-- on their phone at the door. Either way the rider needs to record that the
-- money arrived — without that, a paid order looks unpaid forever.

alter table orders
  add column if not exists payment_confirmed_at timestamptz,
  add column if not exists payment_confirmed_by uuid references riders (id),
  add column if not exists payment_confirm_note text;

create or replace function rider_confirm_payment(p_order_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_rider uuid := current_rider_id();
begin
  if v_rider is null then
    raise exception 'not a rider';
  end if;
  update orders set
    payment_status       = 'paid',
    payment_confirmed_at = now(),
    payment_confirmed_by = v_rider,
    payment_confirm_note = nullif(btrim(p_note), '')
  where id = p_order_id and rider_id = v_rider;
  if not found then
    raise exception 'You can only confirm payment on your own delivery.';
  end if;
end;
$$;
revoke all on function rider_confirm_payment(uuid, text) from public;
grant execute on function rider_confirm_payment(uuid, text) to authenticated;
