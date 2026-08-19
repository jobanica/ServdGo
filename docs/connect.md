# Connecting ServdGo to Supabase and Vercel

**This is done.** The ServdGo Supabase project carries all 88 migrations and the
three apps are deployed — see the Live URLs in [DEPLOYMENT.md](../DEPLOYMENT.md).
Kept as the runbook for standing up another environment, or for redoing any of
it from scratch.

The order matters: the database first, then the three frontends that read it.

## 1. The database

The repository carries 88 migrations that build the whole schema — 34 tables, 83
row-level-security policies, the franchise model and the merchant API. They have
been verified end to end against a throwaway PostgreSQL (`npm run test:db`), and
the whole set also applies cleanly as a single transaction.

> **Point this at the new ServdGo project and nothing else.** Running it against
> Easy Buy's project (`difvleyqqixettmbkkno`) would restructure a live database
> real riders are settling money against: `app_settings` is replaced by a view,
> and territory columns and new policies land on every table. There is no undo.

```bash
npx supabase login                       # opens a browser, once
npx supabase link --project-ref <ref>    # <ref> is in your dashboard URL
npx supabase db push
```

`<ref>` is the 20-character string in `https://supabase.com/dashboard/project/<ref>`.

`db push` records what it applied in `supabase_migrations.schema_migrations`, so
later migrations apply on top rather than re-running everything.

### Then seed the first city

In the SQL editor, as yourself:

```sql
-- 1. Make yourself the franchisor. Everything else is gated on this.
update profiles set role = 'franchisor', territory_id = null where id = '<your-auth-uid>';
```

Sign up in the admin app first so you have an auth user; `<your-auth-uid>` is in
Authentication → Users. The rest is in
[DEPLOYMENT.md](../DEPLOYMENT.md#seeding-the-first-city).

## 2. The three frontends

Each app is a separate Vercel project pointing at the same repository. In the
Vercel dashboard, **Add New → Project → import `jobanica/ServdGo`**, three times:

| Vercel project | Root Directory |
|---|---|
| `servdgo-customer` | `apps/customer-web` |
| `servdgo-rider` | `apps/rider` |
| `servdgo-admin` | `apps/admin` |

Leave the build settings alone — each app's `vercel.json` already carries them,
including the root-level install that npm workspaces needs to resolve
`@servdgo/shared` and `@servdgo/supabase`.

Set the same two environment variables on all three (Project → Settings →
Environment Variables), from Supabase → Project Settings → API:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
```

The anon key is designed to ship in a browser bundle — row-level security is
what protects the data, not the key.

## 3. The edge functions

Only needed once a partner platform is booking deliveries.

```bash
npx supabase functions deploy merchant-quote  --no-verify-jwt
npx supabase functions deploy merchant-book   --no-verify-jwt
npx supabase functions deploy merchant-order  --no-verify-jwt
npx supabase functions deploy track           --no-verify-jwt
npx supabase functions deploy merchant-webhooks
npx supabase functions deploy notify-riders
npx supabase functions deploy notify-store
npx supabase functions deploy broadcast-sms
npx supabase functions deploy create-staff
```

See [merchant-api.md](./merchant-api.md#deploying-it) for the cron that drains
the webhook outbox, and [DEPLOYMENT.md](../DEPLOYMENT.md) for the SMS and push
secrets.

## 4. Afterwards

Once the deploys are up, update the URLs the code publishes — the policy pages
Google Play checks point at whatever `CUSTOMER_SITE` says:

- `CUSTOMER_SITE` in `packages/shared/src/legal.ts`
- the allowed origin in `supabase/functions/_shared/cors.ts`
- the Live URLs table in [DEPLOYMENT.md](../DEPLOYMENT.md)

Then rebuild the customer app so the legal pages regenerate.
