-- Resume an existing rider account by mobile number (stop-gap "login" until an
-- SMS OTP provider is connected). Riders can't update their own row directly
-- (riders_admin_write only), so re-link the found rider to the caller's current
-- session via a narrow SECURITY DEFINER function.
--
-- Security note: this matches on phone number alone with no code verification,
-- so anyone who knows a rider's number could claim that account. This is an
-- explicit, temporary trade-off; replace with phone OTP once SMS is available.
create or replace function resume_rider(p_mobile text)
returns table (id uuid, application_status text, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r_id uuid;
  q text := right(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), 10);
begin
  if length(q) < 7 or auth.uid() is null then
    return;
  end if;
  -- Match on the last 10 significant digits so 0917…, 63917…, +63917… all work.
  select riders.id into r_id
    from riders
    where right(regexp_replace(riders.mobile_number, '\D', '', 'g'), 10) = q
    order by created_at desc
    limit 1;
  if r_id is null then
    return;
  end if;
  update riders set profile_id = auth.uid() where riders.id = r_id;
  return query
    select riders.id, riders.application_status::text, riders.name
      from riders where riders.id = r_id;
end;
$$;

revoke all on function resume_rider(text) from public;
grant execute on function resume_rider(text) to authenticated;
