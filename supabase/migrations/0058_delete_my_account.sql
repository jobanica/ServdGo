-- Account deletion, on the user's own request.
--
-- Google Play requires any app that creates accounts to let people delete them
-- from inside the app, and to say publicly what survives deletion. This is that
-- mechanism.
--
-- Personal data goes; the order itself stays. A delivery is a transaction
-- between the customer, the rider and the operator — the operator needs the
-- record for tax, commission settlement and dispute handling, and the rider's
-- side of it isn't the customer's to erase. So orders are kept with every
-- identifying column stripped: no name, no number, no address, no pin, no
-- notes. What remains is a fee and a date, tied to nobody.
--
-- The phone-number takeover path is dropped at the bottom of this file: riders
-- sign in with their own email now, and resume_rider let anyone who knew a
-- rider's number claim that account.

create or replace function delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_customer uuid;
  v_rider    uuid;
  v_active   int;
  v_owed     numeric;
  v_tag      text := 'deleted-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  select id into v_customer from customers where profile_id = v_uid;
  select id into v_rider    from riders    where profile_id = v_uid;

  -- A delivery in flight has a counterparty waiting on it; a rider holding the
  -- operator's money can't vanish. Say so plainly instead of failing opaquely.
  if v_customer is not null then
    select count(*) into v_active from orders
      where customer_id = v_customer and status not in ('delivered', 'cancelled');
    if v_active > 0 then
      return jsonb_build_object(
        'deleted', false, 'reason', 'active_orders',
        'message', 'You have a delivery in progress. Please wait until it is completed or cancelled, then try again.');
    end if;
  end if;

  if v_rider is not null then
    select count(*) into v_active from orders
      where rider_id = v_rider and status not in ('delivered', 'cancelled');
    if v_active > 0 then
      return jsonb_build_object(
        'deleted', false, 'reason', 'active_orders',
        'message', 'You are still handling a delivery. Finish or transfer it first, then try again.');
    end if;
    select coalesce(sum(amount), 0) into v_owed
      from commission_ledger where rider_id = v_rider and settled = false;
    if v_owed > 0 then
      return jsonb_build_object(
        'deleted', false, 'reason', 'unsettled_balance',
        'message', 'You still owe ₱' || to_char(v_owed, 'FM999999990.00')
                   || ' in commission. Please settle it before deleting your account.');
    end if;
  end if;

  -- Customer side: saved addresses go entirely; orders keep only their money.
  if v_customer is not null then
    delete from customer_addresses where customer_id = v_customer;
    update orders set
      customer_name     = null,
      customer_contact  = '',
      recipient_name    = null,
      recipient_contact = null,
      delivery_address  = null,
      pickup_address    = null,
      delivery_lat      = null,
      delivery_lng      = null,
      pickup_lat        = null,
      pickup_lng        = null,
      notes             = null
    where customer_id = v_customer;
    update customers set name = null, mobile_number = v_tag, profile_id = null
      where id = v_customer;
  end if;

  -- Rider side: the ledger and settlements are the operator's books and stay,
  -- but they no longer point at a person.
  if v_rider is not null then
    delete from rider_push_tokens where rider_id = v_rider;
    delete from rider_locations   where rider_id = v_rider;
    update orders set
      transferred_from_name    = null,
      transferred_from_contact = null
    where transferred_from_name is not null and rider_id is null;
    update riders set
      name = 'Deleted rider', mobile_number = v_tag, profile_id = null,
      photo_url = null, payout_number = null, is_online = false,
      is_suspended = true, suspend_reason = 'Account deleted by the rider',
      orcr_doc = null, license_doc = null, proof_address_doc = null
      where id = v_rider;
  end if;

  -- Finally the login itself. Wrapped, because losing the sign-in is the last
  -- step and must not roll back the scrubbing above if it fails.
  begin
    delete from auth.users where id = v_uid;
  exception when others then
    delete from profiles where id = v_uid;
  end;

  return jsonb_build_object('deleted', true);
end;
$$;

revoke all on function delete_my_account() from public;
grant execute on function delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Drop the phone-number account-resume path.
--
-- It matched a rider on mobile number alone with no verification, so anyone who
-- knew a rider's number could bind that rider to their own login and take over
-- the account. Riders sign in with their own email, so nothing needs it.
-- ---------------------------------------------------------------------------
drop function if exists resume_rider(text);
