-- ServdGo — the paperwork behind a franchise, and when it runs out.
--
-- Same shape as rider documents (0030): a private bucket read through
-- short-lived signed URLs, never a public one. Files live under {territory_id}/
-- so a policy can scope them by folder without a table lookup.

create table territory_documents (
  id           uuid primary key default gen_random_uuid(),
  territory_id uuid not null references territories (id) on delete cascade,
  kind         text not null,
  label        text,
  file_url     text not null,           -- object path inside the private bucket
  expires_at   date,                    -- null = does not expire
  uploaded_by  uuid references profiles (id),
  verified_by  uuid references profiles (id),
  verified_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index territory_documents_idx on territory_documents (territory_id);
create index territory_documents_expiry_idx on territory_documents (expires_at)
  where expires_at is not null;

comment on table territory_documents is
  'Franchise paperwork. file_url is a path in the private territory-documents bucket, not a public URL.';

insert into storage.buckets (id, name, public)
values ('territory-documents', 'territory-documents', false)
on conflict (id) do nothing;

-- Staff of the city, and the franchisor, read that city's folder. Nobody else,
-- and never publicly.
drop policy if exists territory_docs_staff_read on storage.objects;
create policy territory_docs_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'territory-documents'
         and public.staff_sees(((storage.foldername(name))[1])::uuid));

drop policy if exists territory_docs_franchisor_write on storage.objects;
create policy territory_docs_franchisor_write on storage.objects
  for all to authenticated
  using (bucket_id = 'territory-documents' and public.is_franchisor())
  with check (bucket_id = 'territory-documents' and public.is_franchisor());

/** What is expiring, and what already has. 30 days is the warning window. */
create or replace view territory_document_expiry with (security_invoker = true) as
select d.id, d.territory_id, t.name as territory_name, d.kind, d.label, d.expires_at,
       (d.expires_at - current_date) as days_left,
       case when d.expires_at < current_date then 'expired'
            when d.expires_at <= current_date + 30 then 'expiring'
            else 'ok' end as state
  from territory_documents d
  join territories t on t.id = d.territory_id
 where d.expires_at is not null;

grant select on territory_document_expiry to authenticated;
grant select on territory_documents to authenticated;
grant all on territory_documents to service_role;
alter table territory_documents enable row level security;

create policy territory_documents_read on territory_documents
  for select using (staff_sees(territory_id));
create policy territory_documents_franchisor_write on territory_documents
  for all using (is_franchisor()) with check (is_franchisor());
