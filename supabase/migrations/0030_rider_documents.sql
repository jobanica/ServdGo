-- Rider verification documents: OR/CR, driver's license, and proof of address.
--
-- These are sensitive, so they live in a PRIVATE storage bucket (viewed via
-- short-lived signed URLs) rather than the public store-assets bucket. A rider
-- must have all three documents on file before they can go online or claim an
-- order from the pool.

alter table riders
  add column if not exists orcr_doc           text,  -- OR/CR (vehicle registration)
  add column if not exists license_doc        text,  -- driver's license
  add column if not exists proof_address_doc  text,  -- proof of address
  add column if not exists documents_verified boolean not null default false;

-- Private bucket for rider documents.
insert into storage.buckets (id, name, public)
values ('rider-docs', 'rider-docs', false)
on conflict (id) do nothing;

-- A rider manages files only under their own {uid}/ folder; staff may read all
-- (to review applications). No public read.
drop policy if exists rider_docs_own_read on storage.objects;
create policy rider_docs_own_read on storage.objects
  for select to authenticated
  using (bucket_id = 'rider-docs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists rider_docs_own_insert on storage.objects;
create policy rider_docs_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'rider-docs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists rider_docs_own_update on storage.objects;
create policy rider_docs_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'rider-docs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'rider-docs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists rider_docs_staff_read on storage.objects;
create policy rider_docs_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'rider-docs' and public.is_staff());

-- Record the uploaded document paths on the caller's own rider row (riders may
-- not UPDATE their row directly). SECURITY DEFINER; touches only these columns.
create or replace function set_rider_documents(
  p_orcr text, p_license text, p_proof_address text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update riders set
    orcr_doc          = coalesce(nullif(btrim(p_orcr), ''), orcr_doc),
    license_doc       = coalesce(nullif(btrim(p_license), ''), license_doc),
    proof_address_doc = coalesce(nullif(btrim(p_proof_address), ''), proof_address_doc)
  where profile_id = auth.uid();
end;
$$;
revoke all on function set_rider_documents(text, text, text) from public;
grant execute on function set_rider_documents(text, text, text) to authenticated;

-- Gate: require all three documents on file before a rider can go online.
create or replace function set_rider_online(p_online boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_online boolean;
begin
  if p_online then
    perform 1 from riders
      where profile_id = auth.uid()
        and orcr_doc is not null and license_doc is not null and proof_address_doc is not null;
    if not found then
      raise exception 'Upload your OR/CR, driver''s license, and proof of address before going online';
    end if;
  end if;
  update riders set is_online = p_online where profile_id = auth.uid()
    returning is_online into v_online;
  return v_online;
end;
$$;
revoke all on function set_rider_online(boolean) from public;
grant execute on function set_rider_online(boolean) to authenticated;

-- Defense in depth: a rider may only claim from the pool once approved AND with
-- all three documents on file.
drop policy if exists orders_rider_claim on orders;
create policy orders_rider_claim on orders
  for update
  using (
    rider_id is null
    and status = 'pending'
    and current_rider_id() is not null
    and exists (
      select 1 from riders r
      where r.id = current_rider_id()
        and r.application_status = 'approved'
        and r.orcr_doc is not null
        and r.license_doc is not null
        and r.proof_address_doc is not null
    )
  )
  with check (rider_id = current_rider_id());
