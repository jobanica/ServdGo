# Supabase backend

The single source of truth for all four frontends. Migrations define the schema,
RLS, and helper functions described in [`../docs/data-model.md`](../docs/data-model.md).

## Migrations

| File | Contents |
|---|---|
| `0001_init_enums.sql` | Service types, order/payment/rider/settlement enums |
| `0002_core_tables.sql` | Profiles, stores + menus, customers, riders, `app_settings` |
| `0003_orders.sql` | Unified order queue, items, status events, payments, rider locations, 3-store trigger |
| `0004_settlement.sql` | Commission ledger, settlements, owed/overdue balance functions |
| `0005_rls.sql` | Row Level Security policies + `is_admin()` / `current_rider_id()` / `current_customer_id()` helpers |
| `0006_grants.sql` | Table/sequence/routine GRANTs to the Supabase API roles (`anon`, `authenticated`, `service_role`) so PostgREST can reach the tables (RLS still governs which rows) |

## Applying

With the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase start          # local stack (Docker); applies all migrations
supabase db reset       # re-apply all migrations to the local db
```

In a constrained/CI environment you can skip the services you don't need:

```bash
supabase start -x edge-runtime,studio,imgproxy,inbucket,vector,supavisor
```

After `supabase start`, point the apps at the printed `API_URL` and `ANON_KEY`
via each app's `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).

Against a linked remote project:

```bash
supabase link --project-ref <ref>
supabase db push
```

## Local validation without the CLI

The migrations were validated against stock PostgreSQL 16. `auth.users` and
`auth.uid()` are provided by Supabase in a real project; to run the DDL on a
bare Postgres, create stubs first:

```sql
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable
  as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$;
```

then apply `migrations/0001…0005` in order.

## Generating TypeScript types

Once linked, regenerate row types into the shared package:

```bash
supabase gen types typescript --linked > packages/shared/src/database.types.ts
```

The hand-authored domain unions live in `packages/shared/src/types.ts`.
