# Deployment

## Rebrand to ServdGo — what still needs doing outside the repo

The codebase now says **ServdGo** everywhere, including the Android application
IDs (`com.easybuydelivery.*` → `com.servdgo.*`). Several things a rebrand
touches live in other people's consoles, not in git. Delete this section once
they are done.

1. **Firebase / push notifications — required before push works again.**
   The two `google-services.json` files had their `package_name` fields updated
   so Gradle still builds, but the Firebase project `easy-buy-delivery` has the
   apps registered under the *old* IDs, so FCM registration will be rejected.
   Fix: Firebase console → Project settings → Add app → Android, once for
   `com.servdgo.customer` and once for `com.servdgo.rider` → download the new
   `google-services.json` → replace both copies in
   `apps/customer-web/android/app/` and `apps/rider/android/app/`. The project
   ID `easy-buy-delivery` and the storage bucket cannot be renamed; only the
   display name can. They are internal and never shown to a customer.

2. **Google Play — check before you ship.** Changing `applicationId` makes it a
   different app to Play; a published listing cannot be renamed onto a new ID.
   Nothing here suggests the apps went live under the old IDs (`versionCode 1`,
   and `assetlinks.json` still holds a placeholder fingerprint), which is why
   the rename was safe to do now. If either app *is* already published, revert
   the two `applicationId` / `namespace` values in
   `apps/*/android/app/build.gradle` and change only the display names.

3. **Deployment URLs are unchanged.** `ebd-customer`, `ebd-rider` and
   `ebd-admin` on Vercel are live hosts, so they were left alone. To rename the
   Vercel projects to `servdgo-*`, update all of: `CUSTOMER_SITE` in
   `packages/shared/src/legal.ts`, the allowed origin in
   `supabase/functions/_shared/cors.ts`, the Live URLs table above, the
   `bubblewrap init --manifest` URL, and the three policy URLs in the Play
   Console — then re-run the customer build so the legal pages regenerate.

4. **`assetlinks.json`** still carries
   `REPLACE_WITH_YOUR_APP_SIGNING_SHA256_FINGERPRINT`. It needs the Play app
   signing fingerprint for the new package before deep links verify.

5. **Artwork is still the old logo.** No image was changed — every launcher
   icon (`apps/*/android/app/src/main/res/mipmap-*`), splash screen
   (`drawable-*`), PWA icon (`apps/customer-web/public/icons/`) and Play listing
   graphic (`docs/store-assets/`) still shows the Easy Buy scooter mark. These
   need new ServdGo artwork.

6. **Brand colours are still the old palette.** The green/purple/yellow tokens
   in `docs/branding.md` and the three `src/index.css` files were sampled from
   the Easy Buy logo. Re-sample from the ServdGo logo and update both places
   together.

7. **SMS sender ID.** The store-notification sender is now `ServdGo` (7
   characters, within the 11-character limit). If the provider requires sender
   IDs to be pre-registered, register it before relying on it.

8. **Run the rebrand migration.** `supabase/migrations/0076_rebrand_servdgo.sql`
   updates the "we're closed" message the database serves. Migrations 0001-0075
   were deliberately left untouched — they are the record of what already ran.

9. **Supabase project.** `project_id` in `supabase/config.toml` is now
   `servdgo`; that name is local-CLI only. The hosted project ref
   `difvleyqqixettmbkkno` is unchanged.

## Live URLs

| App | URL | Backend |
|---|---|---|
| Customer web | https://ebd-customer.vercel.app | Supabase project `difvleyqqixettmbkkno` |
| Rider app | https://ebd-rider.vercel.app | same |
| Admin dashboard | https://ebd-admin.vercel.app | same |

Both are static Vite SPAs on Vercel, talking to the hosted Supabase project over
its REST/Realtime API with the public **anon** key. Row Level Security governs
access; the anon key is safe to ship in the client bundle.

## Supabase (backend)

The schema lives in [`supabase/migrations/`](supabase/migrations) (`0001`–`0006`).
Apply it to a project with the CLI:

```bash
supabase link --project-ref <ref>
supabase db push
```

`0006_grants.sql` is required — without the table GRANTs, PostgREST returns
"permission denied" even with RLS policies in place.

## Vercel (frontends)

Each app is a static build. Environment (baked in at build time by Vite):

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

Build and deploy one app (from the repo root):

```bash
# hosted env in apps/<app>/.env, then:
npm run build --workspace @servdgo/<app>        # -> apps/<app>/dist
cd apps/<app>/dist && vercel deploy --prod --yes
```

`vercel.json` in each app adds an SPA rewrite so any path serves `index.html`.

## Google Play Store (Android)

The Play Store only accepts signed Android App Bundles (`.aab`) — you wrap each
web app in a native shell. Two shells, matched to each app's needs.

### Prerequisites (one-time, account-bound)

- **Google Play Developer account** — $25 one-time at play.google.com/console.
- **Signing key** — generate a keystore (or use Play App Signing); keep it safe.
- **Privacy policy URL**, Data safety form (location + phone), content rating.

### Customer app → TWA (wraps the installable PWA)

The customer app is a full PWA (manifest + service worker + icons). Wrap it with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap):

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://ebd-customer.vercel.app/manifest.webmanifest
bubblewrap build          # produces app-release-signed.aab
```

Then publish `/.well-known/assetlinks.json` on the domain with the **SHA-256
fingerprint** of your signing key (template committed at
`apps/customer-web/public/.well-known/assetlinks.json` — replace the placeholder,
package `com.servdgo.customer`). This removes the browser URL bar.

Get the fingerprint from **Play Console → your app → Test and release → Setup →
App signing → App signing key certificate → SHA-256**. Use the *app signing*
key, not the upload key — Play re-signs the bundle, so the upload key's
fingerprint will not match and the TWA will keep showing the URL bar.

### Rider app → Capacitor (native, background GPS)

The rider app is wrapped with Capacitor (`apps/rider/android/`), appId
`com.servdgo.rider`. It needs background location, which a TWA can't do.

```bash
cd apps/rider
npm run build && npx cap sync android
npx cap open android      # Android Studio: Build > Generate Signed Bundle / AAB
```

The manifest already declares `ACCESS_FINE_LOCATION`,
`ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, and
`POST_NOTIFICATIONS`. **`useLocationPublisher`** uses the Capacitor Geolocation
plugin on native and the browser API on web.

- ⚠️ **Background location review:** Google reviews `ACCESS_BACKGROUND_LOCATION`
  strictly — justify it with the live delivery-tracking use case and usually
  submit a short screen recording. Budget extra review time.
- **App-closed tracking is wired** via `@capacitor-community/background-geolocation`.
  On native, `useLocationPublisher` starts a foreground-service watcher (persistent
  notification) that keeps streaming location to the order's Realtime channel even
  when the app is backgrounded or closed; the web build polls in the foreground.
  The watcher auto-starts on pickup and stops on delivery, so location is never
  shared while idle.

### Play Console forms

Both apps need these, and the content is already prepared:

| Form | Value |
|---|---|
| Privacy policy URL | `https://ebd-customer.vercel.app/privacy.html` |
| Terms | `https://ebd-customer.vercel.app/terms.html` |
| Account deletion URL | `https://ebd-customer.vercel.app/account-deletion.html` |

Those three pages are generated at build time from
`packages/shared/src/legal.ts` — edit the constants there, never the HTML in
`apps/customer-web/public/`. The build fails if `SUPPORT_EMAIL` is empty, so a
policy can't ship without a working contact address.

**Data safety declarations** (both apps collect it, none of it is shared with
third parties, all of it is deletable):

- *Personal info* — name, email, phone number.
- *Location* — approximate and precise. Rider app only: **collected in the
  background**, while a delivery is in progress.
- *Photos* — order chat images, payment receipts, rider verification documents.
- *App activity* — orders placed.

**Account deletion** is implemented in-app (customer: Account → Delete account;
rider: Settings → Delete account) via the `delete_my_account` RPC. It refuses
while a delivery is in flight or a rider owes commission, and otherwise strips
every identifying column from past orders while keeping the financial record.

### Upload

Play Console → create app → complete the forms → upload the `.aab` to an internal
testing track → promote to production after review.

## Incoming-order notifications (rider)

Two layers:

1. **Live (app open)** — the rider app subscribes to Supabase Realtime
   (`subscribeToNewOrders`, `postgres_changes` on `orders` INSERT). A banner shows
   and the pool refreshes instantly. `orders` is in the `supabase_realtime`
   publication (migration `0007`). Note: Realtime honours RLS, so the rider must
   be signed in for pool visibility.
2. **App closed** — FCM push. The native app registers on launch
   (`usePushRegistration`) and stores its token in `rider_push_tokens`. A server
   Edge Function sends the push:

```bash
# one-time: create a Firebase project, get the FCM server key
supabase secrets set FCM_SERVER_KEY=<key>
supabase functions deploy notify-riders
# Dashboard → Database → Webhooks: on orders INSERT → call notify-riders
```

The function (`supabase/functions/notify-riders`) reads approved/unlocked riders'
tokens and pushes the order summary. Adjust the audience query to your
rider-assignment model (open decision #7).

## Store SMS on a new order (optional)

Text each store its items when a food order comes in — complements the rider
call, off by default (preserves the no-merchant-onboarding model).

```bash
# enable the toggle
update app_settings set sms_notify_stores = true;
# secrets
supabase secrets set SEMAPHORE_API_KEY=<key>       # https://semaphore.co
supabase secrets set SEMAPHORE_SENDER_NAME=ServdGo # optional, must be registered
supabase functions deploy notify-store
# Dashboard → Database → Webhooks: on orders INSERT → call notify-store
```

`supabase/functions/notify-store` groups `order_items` by `store_id`, composes
the message (`composeStoreOrderSms` in `@servdgo/shared`), and sends to each store's
`contact_number` via the configured provider (stores without a number are skipped
— the rider still calls). Only fires for food orders when the toggle is on.

## SMS provider (bulk-capable)

SMS goes through a provider-agnostic sender (`supabase/functions/_shared/sms.ts`)
selected by `SMS_PROVIDER`. Both providers support bulk (many recipients per
request), and numbers are normalized to `639XXXXXXXXX`.

**BulkSMS Philippines (iSMS gateway)** — up to 300 numbers/request:

```bash
supabase secrets set SMS_PROVIDER=bulksms_ph
supabase secrets set BULKSMS_PH_USERNAME=<user> BULKSMS_PH_PASSWORD=<pass>
supabase secrets set BULKSMS_PH_SENDER=ServdGo   # optional, ≤11 chars, must be registered
```

**Semaphore** — comma-separated bulk:

```bash
supabase secrets set SMS_PROVIDER=semaphore SEMAPHORE_API_KEY=<key> SEMAPHORE_SENDER_NAME=ServdGo
```

### Bulk broadcast (announcements / promos)

`supabase/functions/broadcast-sms` sends one message to an audience in bulk,
protected by a shared secret:

```bash
supabase secrets set BROADCAST_SECRET=<random>
supabase functions deploy broadcast-sms
# send:
curl -X POST "$SUPABASE_URL/functions/v1/broadcast-sms" \
  -H "x-broadcast-secret: <secret>" -H "Content-Type: application/json" \
  -d '{"message":"We are open! Order now.","audience":"customers"}'
```

Audience can be `customers`, `riders`, `stores`, or an explicit `numbers` array.
The admin **Broadcast SMS** screen calls this function with the admin's session,
so it also authorizes an authenticated **admin** caller (verifies
`profiles.role = 'admin'`) — the shared secret is only needed for server-to-server
use. Respect consent/opt-out before broadcasting to customers.

## Admin sign-in & provisioning

The admin console writes to RLS-protected tables, so it requires a signed-in user
whose `profiles.role = 'admin'` (email + password — no SMS needed). Provision the
first admin **once**:

1. Supabase Dashboard → **Authentication → Users → Add user** (set a password,
   tick "auto-confirm").
2. SQL editor — grant the role (works with or without the `0008` trigger):

```sql
insert into profiles (id, role)
values ('<the-new-user-uuid>', 'admin')
on conflict (id) do update set role = 'admin';
```

3. Open `ebd-admin.vercel.app` and sign in with that email/password.

Without this, the admin app runs as the anonymous key and every write is blocked
by RLS (`42501`) — e.g. "Add store" silently does nothing.

## Authentication (phone OTP)

Both apps gate real actions behind Supabase Auth phone OTP:

- Customer: `AuthGate` → sign in → `ensureCustomer` → orders use the authenticated
  customer id (RLS-permitted).
- Rider: `RiderGate` → sign in → `ensureRider` (application `pending`) → the app
  unlocks once an admin approves; the pool is RLS-filtered to the signed-in rider.

**Enable it in production:** configure an SMS provider (Dashboard → Authentication
→ Providers → Phone; e.g. Twilio). Without a provider, OTP codes can't be
delivered. Email OTP works with the built-in mailer if you prefer email sign-in.

> The public customer deploy currently runs the **pre-auth build** (browsable
> without sign-in) so it's demoable before an SMS provider is set up. Redeploy the
> auth build once the provider is configured.

## Notes / current limits

- The apps are browsable (public store/menu reads) but **placing orders needs an
  authenticated customer** — the signup/OTP flow (open decision #8) is not built
  yet, so anon order inserts are correctly blocked by RLS.
- Live tracking uses Supabase Realtime; a real rider publishing GPS requires the
  rider app running with location permission.
