-- Let a rider (re)submit a settlement for a business day.
--
-- settlements has unique(rider_id, business_day), so a plain INSERT fails if a
-- settlement for that day already exists (e.g. it was confirmed earlier and new
-- commission accrued the same day). Riders also have no UPDATE policy on
-- settlements. Expose a SECURITY DEFINER upsert that (re)opens the caller's own
-- settlement for the day as pending, so "I've paid" always goes through.

create or replace function rider_submit_settlement(
  p_business_day date,
  p_amount numeric,
  p_method text,
  p_reference text,
  p_receipt_url text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rider uuid;
  v_id uuid;
begin
  select id into v_rider from riders where profile_id = auth.uid();
  if v_rider is null then
    raise exception 'not a rider';
  end if;
  if p_amount < 0 then
    raise exception 'amount must be non-negative';
  end if;

  insert into settlements (rider_id, business_day, amount_due, method, reference, receipt_url, status)
    values (v_rider, p_business_day, p_amount, nullif(btrim(p_method), ''),
            nullif(btrim(p_reference), ''), nullif(btrim(p_receipt_url), ''), 'pending')
  on conflict (rider_id, business_day) do update
    set amount_due   = excluded.amount_due,
        method       = excluded.method,
        reference    = excluded.reference,
        receipt_url  = excluded.receipt_url,
        status       = 'pending',
        confirmed_by = null,
        confirmed_at = null,
        created_at   = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function rider_submit_settlement(date, numeric, text, text, text) from public;
grant execute on function rider_submit_settlement(date, numeric, text, text, text) to authenticated;
