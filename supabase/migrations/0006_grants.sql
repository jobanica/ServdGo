-- Easy Buy Delivery — grant table privileges to the Supabase API roles.
--
-- RLS policies decide WHICH rows anon/authenticated may touch, but PostgREST
-- still needs table-level GRANTs to reach the tables at all. `service_role`
-- bypasses RLS entirely (used server-side). Without these grants the REST API
-- returns "permission denied for table ...".

grant usage on schema public to anon, authenticated, service_role;

grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;

-- Apply the same grants to objects created after this migration.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on routines to anon, authenticated, service_role;
