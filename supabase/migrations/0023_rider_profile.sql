-- Rider self-service profile: photo, payout number (shown to customers for
-- GCash/Maya), which services they accept, and a push-notification preference.
-- Riders can't update their own row directly (riders_admin_write only), so
-- expose a narrow SECURITY DEFINER function that edits only these fields on the
-- caller's own row.
alter table riders
  add column if not exists photo_url         text,
  add column if not exists payout_number     text,
  add column if not exists services_accepted text[],
  add column if not exists push_enabled      boolean not null default true;

create or replace function update_rider_profile(
  p_name text,
  p_mobile text,
  p_vehicle text,
  p_photo_url text,
  p_payout_number text,
  p_services text[],
  p_push_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update riders set
    name              = coalesce(nullif(btrim(p_name), ''), name),
    mobile_number     = coalesce(nullif(btrim(p_mobile), ''), mobile_number),
    vehicle           = nullif(btrim(p_vehicle), ''),
    photo_url         = nullif(btrim(p_photo_url), ''),
    payout_number     = nullif(btrim(p_payout_number), ''),
    services_accepted = case when p_services is null or array_length(p_services, 1) is null
                             then null else p_services end,
    push_enabled      = coalesce(p_push_enabled, push_enabled)
  where profile_id = auth.uid();
end;
$$;

revoke all on function update_rider_profile(text, text, text, text, text, text[], boolean) from public;
grant execute on function update_rider_profile(text, text, text, text, text, text[], boolean) to authenticated;

-- Let a signed-in rider upload their own avatar into the public store-assets
-- bucket under rider-avatars/. (Public read already exists from 0015.)
create policy rider_avatar_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'rider-avatars');
create policy rider_avatar_update on storage.objects
  for update to authenticated
  using (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'rider-avatars')
  with check (bucket_id = 'store-assets' and (storage.foldername(name))[1] = 'rider-avatars');
