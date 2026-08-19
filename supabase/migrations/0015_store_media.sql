-- Easy Buy Delivery — store logos and menu-item images.
--
-- Images live in a public Storage bucket; the tables keep the public URL.

alter table stores     add column if not exists logo_url  text;
alter table menu_items add column if not exists image_url text;

-- Public bucket for store logos + item photos.
insert into storage.buckets (id, name, public)
values ('store-assets', 'store-assets', true)
on conflict (id) do nothing;

-- Anyone may read (the bucket is public); only staff/admin may write.
drop policy if exists "store-assets public read" on storage.objects;
create policy "store-assets public read" on storage.objects
  for select using (bucket_id = 'store-assets');

drop policy if exists "store-assets staff insert" on storage.objects;
create policy "store-assets staff insert" on storage.objects
  for insert with check (bucket_id = 'store-assets' and public.is_staff());

drop policy if exists "store-assets staff update" on storage.objects;
create policy "store-assets staff update" on storage.objects
  for update using (bucket_id = 'store-assets' and public.is_staff());

drop policy if exists "store-assets staff delete" on storage.objects;
create policy "store-assets staff delete" on storage.objects
  for delete using (bucket_id = 'store-assets' and public.is_staff());
